import { DECKWISE_MANAGED_PROVIDER_ID, IPC, ErrorCodes, isGlobalPermissionMode, type AgentEventEnvelope, type AgentPromptRequest, type AgentSteerRequest, type UiMessage, type AgentQueuePushRequest, type AgentStopRequest, type AskToolResolution, type GlobalPermissionMode, type MessageUsage, type PlanExecutionFinishStatus, type PlanResolutionResult, type PlanResolveRequest, type PromptEnhancementRequest, type SessionSummarizeTitleRequest } from "@pi-desktop/shared";
import type { FinishTurn } from "../runtime/plans";
import { expandSlashInvocation, enhancePromptDraft, resolveCoursewareRoute, summarizeSessionTitle, visionFromModelConfig, type ComposerTemplate, type RuntimeProviderConfig } from "@pi-desktop/agent-runtime";
import { OAUTH_AUTH_KIND, type VendorOAuth } from "../oauth";
import { appendPromptFallbackPaths, durableUserMessageId, isStructuredDocumentAttachment, preparePromptAttachments, stripPromptAttachmentReferences, type PreparedPromptAttachment } from "../prompt-attachments";
import { executionFromResponse } from "../plan-execution";
import { resolveSessionMessageInput } from "../session-message-input";
import type { AgentExtensionBridge } from "../agent-extensions";
import type { AgentHostBridge } from "../agent-host-bridge";
import type { AgentSidecar } from "../agent-sidecar";
import type { HostProcess } from "../host-process";
import type { Logger } from "../logger";
import type { PersistenceOutbox } from "../persistence-outbox";
import type { ComposerCommandService } from "./composer-ipc";
import type { IpcRegistrar } from "./types";
import { loadBuiltinSkillBody } from "../builtin-skills";
import { sceneCoursePlanRelativePath, sceneCourseTeachingPolicy } from "../courseware-scene-plan";
import type { CoursewareEducationContext } from "@pi-desktop/shared";
import { resolveCoursewareLlmAuth } from "../courseware-llm-auth";

export type AgentIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  getSidecar: () => AgentSidecar | null;
  getAgentHostBridge: () => AgentHostBridge | null;
  logger: Pick<Logger, "app">;
  vendorOAuth: VendorOAuth;
  resolvePlatformAccessToken: () => Promise<string>;
  parseDocument: (path: string) => Promise<{
    text?: string;
    semanticText?: string;
    cleanupUrls?: string[];
  }>;
  cleanupDocuments: (fileUrls: string[]) => Promise<void>;
  registerDocumentCleanup: (sessionId: string, turnId: string, fileUrls: string[]) => void;
  agentExtensions: AgentExtensionBridge;
  cancelSessionTools: (sessionId: string, reason?: string) => void;
  persistenceOutbox: PersistenceOutbox;
  dataDir: string;
  activeTurns: Map<string, string>;
  /** Whether the named turn can still start or steer host work. */
  isTurnDispatchable: (sessionId: string, turnId: string | null | undefined) => boolean;
  activeTurnUsages: Map<string, MessageUsage>;
  approvedExecutionIdsBySession: Map<string, string>;
  claimedExecutionSessions: Map<string, string>;
  resolveAgentRuntimeLaunch: (...args: any[]) => Promise<any>;
  acquireSessionOperation: (sessionId: string) => Promise<() => void>;
  finishTurn: FinishTurn;
  /**
   * Record a cancellation before the cancel request is issued, so a terminal
   * event arriving while it is in flight cannot restate the abort as a
   * completion. A session without a live turn locks nothing.
   */
  lockAbortReason: (sessionId: string, turnId: string | null | undefined) => void;
  finishApprovedExecution: (executionId: string, status: PlanExecutionFinishStatus, errorCode?: string) => Promise<void>;
  dispatchApprovedPlan: (execution: unknown) => Promise<void>;
  dispatchExecutionForProposal: (proposalId: string) => Promise<void>;
  emitAgentEvent: (envelope: AgentEventEnvelope) => void;
  setNotificationViewingSessionId: (sessionId: string | null) => void;
  optionalWorkspaceRoot: () => Promise<string | null>;
  composerCommandService: Pick<ComposerCommandService, "buildComposerCommands">;
  loadComposerTemplatesCached: (root: string | null) => Promise<ComposerTemplate[]>;
};

function rejectNativeAgentOperation(sessionId: string): void {
  if (sessionId.startsWith("native-pi:")) {
    throw Object.assign(new Error("Operation is unsupported for legacy sessions"), { errorCode: "NATIVE_PI_UNSUPPORTED" });
  }
}

function deckWiseModelPrompt(content: string, nativeEditing = false, taskType: "plain" | "scene" | "import" = "plain", educationContext?: unknown, sessionId?: string): string {
  const scenePlanning = !nativeEditing && taskType === "scene";
  const route = resolveCoursewareRoute(taskType === "plain" ? "presentation" : taskType, nativeEditing ? "edit" : scenePlanning ? "plan" : "generate");
  if (!route.available) throw new Error("场景课件生成服务尚未接通，请保留当前任务，稍后重试");
  // Repairs can skip a requested Skill call; load the Host-selected workflow directly.
  const generationSkill = !nativeEditing && (taskType === "plain" || scenePlanning) ? loadBuiltinSkillBody(route.skill) : null;
  const teaching = educationContext && typeof educationContext === "object" && !Array.isArray(educationContext)
    ? educationContext as CoursewareEducationContext
    : {};
  return [
    "DeckWise turn policy:",
    "- This product only supports creating, revising, inspecting, or exporting PPTX courseware.",
    "- If this request is outside that scope, do not call tools or answer it normally; briefly state the product boundary and ask for a courseware topic or source material.",
    "- In user-facing responses, never mention Pi, PPT Master, skill ids, Python scripts, SVG services, internal tools, or workspace paths. Describe the work using courseware requirements, courseware pages, page preview, and courseware editing.",
    generationSkill
      ? "- The Host has loaded the selected generation skill below. Follow it for generation, repair and export; another Skill call is unnecessary."
    : `- For a supported request, first call the \`Skill\` tool with id ${JSON.stringify(route.skill)} and follow the loaded instructions.`,
    `- Task authority: ${route.authority}. ${route.instruction}`,
    "- Drive the complete requested workflow in this main Chat. Read courseware_workflow_get for saved requirements and real stage state before continuation. Ask essential missing information with asktool, reuse supplied answers, and save confirmed teaching settings through courseware_requirements_update before plan approval/source attachment. Its latest saved settings override the initial prompt snapshot; revise an unapproved plan to match changed settings before requesting review. Never silently guess the audience. Preserve optional requirements and task type.",
    "- Continue authorized non-blocking steps using tools; do not send the user to a right-side control form or stop after saying you will continue. Current Chat review controls handle plan approval, exact paid quotations and image selection. Never approve or pay on behalf of the user. If such a decision is required, explain the specific next action and stop for it.",
    "- For scene continuation, inspect existing requests and selected assets before preparing missing ones. Ask for a model choice only when needed. Prepare page visualMaster references first; then selected-reference cleanPlate backgrounds and explicitly named movable foreground layers with a reference-capable model. Do not prepare duplicates, fabricate assets or retry unknown paid outcomes. Current service requires a distinct cleanPlate and at least one foreground layer per page. Compile with courseware_scene_compile only after approval and no asset blockers. Query pending jobs once per continuation; do not busy-poll.",
    "- If the user asks to revise an existing media draft on the current canvas, use courseware_canvas_get to read it and courseware_canvas_edit to update only the requested draft fields. This saves draft metadata only; it never generates media or edits slides.",
    ...(scenePlanning ? [`- The Host-selected scene planning file is ${JSON.stringify(sceneCoursePlanRelativePath(sessionId ?? ""))}. Read it before revising an existing draft; save only the raw {title,pages} JSON required by the loaded skill. Treat it as a generation draft, not live PPTX teaching. Never rewrite it merely because the user says continue: inspect approval and execute the next available workflow tool. Only report an artifact after its tool succeeds. Plan edits invalidate the whole-plan approval and asset bindings; explain that before revising after paid work.`] : []),
    ...(educationContext ? [`- Teaching settings: ${JSON.stringify(educationContext)}. Treat age/grade/subject as content guidance, not as task routing.`] : []),
    ...(scenePlanning ? [sceneCourseTeachingPolicy(teaching)] : teaching.schoolStage === "kindergarten" ? [
      "- For kindergarten, keep child-facing text short, concrete and playful. Write page narration as direct teacher speech, with participation cues and modest praise. Keep teacher instructions in narration, not child-facing slide text.",
      teaching.subject === "english"
        ? teaching.fullEnglishTeaching === true
          ? "- For full-English kindergarten teaching, use short, speakable English classroom sentences and occasional simple praise such as Good; do not turn narration into long explanations."
          : "- For kindergarten English, use 0–2 short English expressions per ordinary page and no more than one brief praise sentence per page; keep the rest of the teaching explanation appropriate to the lesson language."
        : "- Do not add English praise or commands merely because this is kindergarten; follow the selected subject and teaching language.",
    ] : []),
    "- Attached office documents are pre-parsed by the DeckWise document service and appear below as `### 资料`; never inspect the original binary attachment or run a local document converter.",
    nativeEditing
      ? "- The Host bound this Chat to the active Office PPTX. For PPTX requests, activate PPT tools with ToolSearch, read fresh context and use only operations advertised for that surface. Canvas draft requests remain separate and use courseware_canvas_get/edit. Never modify the live PPTX using file/shell tools or replace it with SVG exports. Native edits remain unsaved until the user saves."
      : taskType === "plain"
        ? "- Before the first export, stop at the editable SVG preview unless this is the Host's explicit PPTX export request. SVG owns generation candidates only. Once Office editing begins, use the latest PPTX and teaching; reopen Office for native edits and never supersede them with an older SVG export."
        : "- Preserve the selected task type. Once Office editing begins, use the latest PPTX and teaching; never replace Office edits with an older candidate.",
    ...(generationSkill ? [`\n# Skill: ${generationSkill.name} (${generationSkill.id})\n\n${generationSkill.body}`] : []),
    "",
    "User request:",
    content,
  ].join("\n");
}

/** Register prompt, agent lifecycle, queue, approval and plan channels. */
export function registerAgentIpc({
  registrar,
  getHost,
  getSidecar,
  getAgentHostBridge,
  logger,
  vendorOAuth,
  resolvePlatformAccessToken,
  parseDocument,
  cleanupDocuments,
  registerDocumentCleanup,
  agentExtensions,
  cancelSessionTools,
  persistenceOutbox,
  dataDir,
  activeTurns,
  isTurnDispatchable,
  activeTurnUsages,
  approvedExecutionIdsBySession,
  claimedExecutionSessions,
  resolveAgentRuntimeLaunch,
  acquireSessionOperation,
  finishTurn,
  lockAbortReason,
  finishApprovedExecution,
  dispatchApprovedPlan,
  dispatchExecutionForProposal,
  emitAgentEvent,
  setNotificationViewingSessionId,
  optionalWorkspaceRoot,
  composerCommandService,
  loadComposerTemplatesCached,
}: AgentIpcDependencies): void {
  let host: HostProcess | null = null;
  let sidecar: AgentSidecar | null = null;
  let agentHostBridge: AgentHostBridge | null = null;
  const handle = (channel: string, fn: (...args: any[]) => Promise<any>) => {
    registrar.handle(channel, async (...args) => {
      host = getHost();
      sidecar = getSidecar();
      agentHostBridge = getAgentHostBridge();
      return fn(...args);
    });
  };
  handle(IPC.invoke.promptEnhance, async (req: PromptEnhancementRequest) => {
    if (!host) throw new Error("backend unavailable");
    const draft = typeof req?.draft === "string" ? req.draft : "";
    if (!draft.trim()) {
      throw Object.assign(new Error("Prompt draft must not be empty"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    if (draft.trim().startsWith("/")) {
      throw Object.assign(new Error("Slash command drafts cannot be enhanced"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }

    const sessionId =
      typeof req.sessionId === "string" ? req.sessionId.trim() : "";
    const session = sessionId
      ? (await host.call<{ session?: any }>("session.get", { id: sessionId })).session
      : {};
    if (sessionId && !session) {
      throw Object.assign(new Error("Session not found"), {
        errorCode: ErrorCodes.NOT_FOUND,
      });
    }
    const settings = await host.call<any>("settings.get");
    const launchSessionId = sessionId || `prompt-enhancement:${crypto.randomUUID()}`;
    const launch = await resolveAgentRuntimeLaunch(
      launchSessionId,
      session ?? {},
      settings,
      {
        mode: "agent",
        providerId:
          typeof req.providerId === "string" ? req.providerId.trim() : undefined,
        modelId: typeof req.modelId === "string" ? req.modelId.trim() : undefined,
        thinkingLevel: req.thinkingLevel,
      },
    );
    const runtimeProvider = {
      ...launch.sidecarParams.provider,
      ...(launch.sidecarParams.provider.authKind === OAUTH_AUTH_KIND
        ? { resolveAuth: () => launch.providerId === DECKWISE_MANAGED_PROVIDER_ID
            ? resolveCoursewareLlmAuth(getHost, sessionId || undefined, resolvePlatformAccessToken)
            : vendorOAuth.resolveAuth(launch.providerId) }
        : {}),
    } as RuntimeProviderConfig;
    const enhancedDraft = await enhancePromptDraft(
      runtimeProvider,
      draft,
      launch.sidecarParams.thinkingLevel,
      { sessionId: launchSessionId },
    );
    logger.app("session", "info", "prompt enhanced", {
      sessionId: sessionId || undefined,
      data: { providerId: launch.providerId, modelId: launch.modelId },
    });
    return { enhancedDraft };
  });

  handle(IPC.invoke.sessionSummarizeTitle, async (req: SessionSummarizeTitleRequest) => {
    if (!host) throw new Error("backend unavailable");
    const sessionId = typeof req?.sessionId === "string" ? req.sessionId.trim() : "";
    const userPrompt = typeof req?.userPrompt === "string" ? req.userPrompt.trim() : "";
    if (!sessionId || !userPrompt) {
      throw Object.assign(new Error("sessionId and userPrompt required"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    const session = (await host.call<{ session?: any }>("session.get", { id: sessionId })).session;
    if (!session) {
      throw Object.assign(new Error("Session not found"), {
        errorCode: ErrorCodes.NOT_FOUND,
      });
    }
    const settings = await host.call<any>("settings.get");
    const launch = await resolveAgentRuntimeLaunch(
      `title-summary:${sessionId}`,
      session,
      settings,
      {
        mode: "agent",
        providerId: typeof req.providerId === "string" ? req.providerId.trim() : undefined,
        modelId: typeof req.modelId === "string" ? req.modelId.trim() : undefined,
        thinkingLevel: "off",
      },
    );
    const runtimeProvider = {
      ...launch.sidecarParams.provider,
      ...(launch.sidecarParams.provider.authKind === OAUTH_AUTH_KIND
        ? { resolveAuth: () => launch.providerId === DECKWISE_MANAGED_PROVIDER_ID
            ? resolveCoursewareLlmAuth(getHost, sessionId, resolvePlatformAccessToken)
            : vendorOAuth.resolveAuth(launch.providerId) }
        : {}),
    } as RuntimeProviderConfig;

    const title = await summarizeSessionTitle(
      runtimeProvider,
      userPrompt,
      req.assistantReply,
      "off",
      { sessionId },
    );
    logger.app("session", "info", "session title summarized", {
      sessionId,
      data: { title, providerId: launch.providerId, modelId: launch.modelId },
    });
    return { title };
  });

  handle(IPC.invoke.agentSteer, async (req: AgentSteerRequest) => {
    if (!host || !sidecar) throw new Error("backend unavailable");
    if (
      !req?.sessionId || typeof req.content !== "string" || !req.expectedTurnId ||
      (!req.content.trim() && !req.attachments?.length)
    ) {
      throw Object.assign(new Error("Steering input and expectedTurnId required"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    // A steering input belongs to the turn it names: it is refused once that
    // turn was cancelled, has started finalizing, or no longer owns the session.
    if (!isTurnDispatchable(req.sessionId, req.expectedTurnId)) {
      throw Object.assign(new Error("The target turn has ended"), {
        errorCode: ErrorCodes.TURN_NOT_FOUND,
      });
    }
    const context = await sidecar.call<{ projectPath?: string; supportsVision: boolean }>(
      "agent.steeringContext", { sessionId: req.sessionId, expectedTurnId: req.expectedTurnId },
    );
    const prepared = await preparePromptAttachments(
      dataDir, req.sessionId, context.projectPath, req.attachments ?? [], context.supportsVision,
    );
    const session = await host.call<{ session?: { messages?: UiMessage[] } }>("session.get", {
      id: req.sessionId, messageLimit: 1,
    });
    const message: UiMessage = {
      id: durableUserMessageId(req.messageId, session.session?.messages ?? []),
      role: "user",
      content: req.content,
      status: "complete",
      createdAt: new Date().toISOString(),
      steering: true,
      ...(prepared.length ? { attachments: prepared.map((attachment) => attachment.message) } : {}),
    };
    // Revalidate inside the runtime after all file/host IO. A stale target must
    // never turn into a normal prompt or alter the next turn's configuration.
    return sidecar.call<{ accepted: boolean; turnId: string }>("agent.steer", {
      sessionId: req.sessionId, expectedTurnId: req.expectedTurnId, message,
      content: appendPromptFallbackPaths(req.content, prepared),
      attachments: prepared.filter((attachment) => attachment.inlineData).map((attachment) => ({
        path: attachment.message.ref, name: attachment.message.name, kind: attachment.message.kind,
        mimeType: attachment.message.mimeType, size: attachment.message.size, data: attachment.inlineData,
      })),
    });
  });

  handle(IPC.invoke.agentPrompt, async (req: AgentPromptRequest) => {
    if (!sidecar) throw new Error("sidecar unavailable");
    if (req.sessionId.startsWith("native-pi:")) {
      if (req.sessionMessageId || req.truncateFromMessageId || req.truncateBefore !== undefined || req.attachments?.length) {
        throw Object.assign(new Error("Legacy session continuation currently supports text prompts only"), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      setNotificationViewingSessionId(req.sessionId);
      return sidecar.call("agent.prompt", {
        sessionId: req.sessionId,
        content: deckWiseModelPrompt(req.content),
        userMessageId: req.messageId,
      });
    }
    if (!host) throw new Error("host unavailable");
    const releaseSessionOperation = await acquireSessionOperation(req.sessionId);
    try {
    const sessionMessage = await resolveSessionMessageInput(host, req);
    // Install the renderer's prompt-time snapshot before any asynchronous
    // setup. This closes the gap where a fast completion could beat the
    // effect that reports the active chat session. Missing or mismatched
    // context is deliberately fail-safe.
    const requestedViewingSessionId =
      typeof req.viewingSessionId === "string" ? req.viewingSessionId.trim() : "";
    setNotificationViewingSessionId(
      requestedViewingSessionId && requestedViewingSessionId === req.sessionId
        ? requestedViewingSessionId
        : null,
    );
    const settings = await host.call<any>("settings.get");
    const sessionResult = await host.call<{ session?: any }>("session.get", {
      id: req.sessionId,
      messageLimit: 1,
    });
    let session = sessionResult.session;
    if (!session) {
      throw Object.assign(new Error("Session not found"), {
        errorCode: ErrorCodes.NOT_FOUND,
      });
    }
    const truncateFromMessageId =
      typeof req.truncateFromMessageId === "string"
        ? req.truncateFromMessageId.trim()
        : "";
    const truncateBefore =
      typeof req.truncateBefore === "number" &&
      Number.isFinite(req.truncateBefore) &&
      req.truncateBefore >= 0
        ? Math.floor(req.truncateBefore)
        : undefined;
    if (truncateFromMessageId || truncateBefore !== undefined) {
      cancelSessionTools(req.sessionId, "Session turn was replaced");
      // Host-owned cut: the kept prefix never crosses the JSON-RPC pipe
      // (issue #211). Abort any leftover running turn first so beginTurn
      // cannot see AGENT_BUSY after a timed-out retry.
      //
      // Capture the target turn and lock the abort reason before the cancel
      // request, as the plain abort path does: a terminal event arriving while
      // the request is in flight must not restate this abort as a completion.
      const regenerateTurnId = activeTurns.get(req.sessionId);
      lockAbortReason(req.sessionId, regenerateTurnId);
      if (sidecar) {
        await sidecar
          .call("agent.abort", { sessionId: req.sessionId })
          .catch(() => undefined);
      }
      if (regenerateTurnId) {
        await finishTurn(req.sessionId, "aborted", "TURN_ABORTED", {
          turnId: regenerateTurnId,
        });
      }

      try {
        await persistenceOutbox.flush(() => host);
        const truncated = await host.call<{
          revision?: {
            rootUserId?: string;
            revisionCount?: number;
            activeRevision?: number;
          } | null;
        }>("session.truncateFrom", {
          sessionId: req.sessionId,
          ...(truncateFromMessageId ? { fromMessageId: truncateFromMessageId } : {}),
          ...(truncateBefore !== undefined ? { truncateBefore } : {}),
        });
        const revision = truncated.revision;
        if (
          revision?.rootUserId &&
          typeof revision.revisionCount === "number" &&
          typeof revision.activeRevision === "number"
        ) {
          (req as any).__revisionMeta = {
            rootUserId: revision.rootUserId,
            revisionCount: revision.revisionCount,
            activeRevision: revision.activeRevision,
          };
        }
      } catch (error) {
        logger.app("persistence", "warn", "truncate regenerate transcript failed", {
          sessionId: req.sessionId,
          data: String(error),
        });
        throw error;
      }
      if (sidecar) {
        sidecar.clearProjectInstructionRoot(req.sessionId);
        sidecar.clearVendorAuthBindings(req.sessionId);
        await sidecar
          .call("agent.disposeSession", { sessionId: req.sessionId })
          .catch(() => undefined);
      }
      const refreshed = await host.call<{ session?: any }>("session.get", {
        id: req.sessionId,
        messageLimit: 1,
      });
      session = refreshed.session ?? session;
    }

    const launch = await resolveAgentRuntimeLaunch(
      req.sessionId,
      session,
      settings,
      { webSearchEnabled: req.webSearchEnabled === true },
    );
    sidecar.setProjectInstructionRoot(req.sessionId, launch.projectPath);
    const taskResult = await host.call<{ task?: { taskType?: unknown; educationContext?: unknown; importPath?: unknown; generatedPath?: unknown } | null }>(
      "courseware.task.get", { sessionId: req.sessionId },
    );
    const taskType = taskResult.task?.taskType ?? "plain";
    if (taskType !== "plain" && taskType !== "scene" && taskType !== "import") {
      throw new Error("Invalid saved courseware task type");
    }
    if (taskType === "scene" && !launch.sidecarParams.pptEditorBinding && taskResult.task?.generatedPath) {
      throw new Error("请先在课件工作台打开已生成的 PPT，再通过 Chat 修改");
    }
    if (taskType === "import" && !launch.sidecarParams.pptEditorBinding) {
      throw new Error(taskResult.task?.importPath
        ? "请先在课件工作台打开已导入的 PPT，再通过 Chat 修改"
        : "请先在课件工作台选择 PPTX 文件导入");
    }

    // Open a durable turn row, then persist the user message under it.
    const turn = await host.call<{ turnId?: string }>("session.beginTurn", {
      sessionId: req.sessionId,
      providerId: launch.providerId,
      modelId: launch.modelId,
      ...(sessionMessage ? { sessionMessageId: sessionMessage.origin.messageId } : {}),
    });
    const durableTurnId = String(turn?.turnId ?? "").trim();
    if (!durableTurnId) {
      throw new Error("session.beginTurn returned no turn");
    }
    activeTurns.set(req.sessionId, durableTurnId);
    activeTurnUsages.delete(req.sessionId);

    // Slash expansion (D123, ADR 0024): templates expand before persistence
    // so reseed replays exactly what the model saw; the typed form rides along
    // as `command` for transcript display. Skill aliases are converted into a
    // short model instruction that makes the existing Skill tool call
    // explicit, while the typed form remains the visible transcript chip.
    // Builtin/plugin slash aliases never reach this channel, and unknown
    // /names stay literal text.
    let promptContent = sessionMessage?.content ?? req.content;
    let slashCommand: string | undefined;
    if (!sessionMessage && req.content.startsWith("/")) {
      try {
        const root = await optionalWorkspaceRoot();
        const commandEnd = req.content.search(/\s/);
        const commandName = req.content.slice(
          1,
          commandEnd === -1 ? undefined : commandEnd,
        );
        const commands = await composerCommandService.buildComposerCommands(
          launch.projectPath ?? root,
        );
        const command = commands.find((item) => item.name === commandName);
        if (command?.kind === "skill" && command.skillId) {
          const body = commandEnd === -1 ? "" : req.content.slice(commandEnd).trim();
          promptContent = [
            `Call the \`Skill\` tool with id ${JSON.stringify(command.skillId)} before answering this request. Follow the loaded skill instructions.`,
            body,
          ]
            .filter(Boolean)
            .join("\n\n");
          slashCommand = req.content;
        } else {
          const templates = await loadComposerTemplatesCached(root);
          const expansion = expandSlashInvocation(req.content, templates);
          if (expansion) {
            promptContent = expansion.expanded;
            slashCommand = expansion.command;
          }
        }
      } catch (error) {
        logger.app("session", "warn", "slash expansion failed; sending literal text", {
          sessionId: req.sessionId,
          data: String(error),
        });
      }
    }

    // The binding's image override already shaped this modelConfig, so the
    // transport gate and the settings switch cannot disagree.
    const supportsVision = visionFromModelConfig(
      launch.sidecarParams.provider.modelConfig,
    );
    let preparedAttachments: PreparedPromptAttachment[];
    try {
      preparedAttachments = await preparePromptAttachments(
        dataDir,
        req.sessionId,
        typeof session.projectPath === "string" && session.projectPath.trim()
          ? session.projectPath.trim()
          : undefined,
        req.attachments ?? [],
        supportsVision,
      );
    } catch (error) {
      await finishTurn(req.sessionId, "error", (error as any)?.errorCode, {
        turnId: durableTurnId,
      });
      throw error;
    }
    const documentCleanupUrls: string[] = [];
    const documentContexts: string[] = [];
    const structuredDocuments = preparedAttachments.filter(isStructuredDocumentAttachment);
    try {
      for (const attachment of preparedAttachments) {
        if (attachment.message.kind !== "file") continue;
        if (!/\.(pdf|docx?|pptx?)$/i.test(attachment.message.name)) continue;
        const parsed = await parseDocument(attachment.absolutePath);
        documentCleanupUrls.push(...(parsed.cleanupUrls ?? []));
        const content = (parsed.semanticText || parsed.text || "").trim();
        if (content) {
          documentContexts.push(`### 资料：${attachment.message.name}\n${content.slice(0, 120000)}`);
        }
      }
    } catch (error) {
      if (documentCleanupUrls.length) void cleanupDocuments(documentCleanupUrls).catch(() => undefined);
      await finishTurn(req.sessionId, "error", "DOCUMENT_PARSE_FAILED", { turnId: durableTurnId });
      throw error;
    }
    const modelAttachments = preparedAttachments.filter(
      (attachment) => !structuredDocuments.includes(attachment),
    );
    const modelContent = deckWiseModelPrompt([
      stripPromptAttachmentReferences(
        appendPromptFallbackPaths(promptContent, modelAttachments),
        structuredDocuments,
      ),
      ...documentContexts,
    ].filter(Boolean).join("\n\n"), Boolean(launch.sidecarParams.pptEditorBinding), taskType, taskResult.task?.educationContext, req.sessionId);
    if (documentCleanupUrls.length) {
      registerDocumentCleanup(req.sessionId, durableTurnId, documentCleanupUrls);
    }

    // Persist user message
    const revisionMeta = (req as any).__revisionMeta as
      | {
          rootUserId?: string;
          revisionCount?: number;
          activeRevision?: number;
        }
      | undefined;
    // The renderer already shows this row under its own id (D288); persisting
    // and echoing under the same id lets the echo replace it in place.
    const userMessage = {
      id: durableUserMessageId(
        req.messageId,
        Array.isArray(session.messages) ? session.messages : [],
      ),

      role: "user" as const,
      // Keep binary lesson-plan paths out of persisted history. The current
      // model request receives the server-parsed text below; retaining the
      // path here would cause history hydration to expose the .doc again.
      content: stripPromptAttachmentReferences(promptContent, structuredDocuments),
      ...(sessionMessage ? { sessionMessage: sessionMessage.origin } : {}),
      createdAt: new Date().toISOString(),
      status: "complete" as const,
      ...(preparedAttachments.length
        ? { attachments: preparedAttachments.map((attachment) => attachment.message) }
        : {}),
      ...(slashCommand ? { command: slashCommand } : {}),
      ...(revisionMeta?.revisionCount
        ? {
            revisionRootId: revisionMeta.rootUserId,
            revisionCount: revisionMeta.revisionCount,
            activeRevision: revisionMeta.activeRevision,
          }
        : {}),
    };
    try {
      await host.call("session.appendMessage", {
        sessionId: req.sessionId,
        message: userMessage,
        turnId: durableTurnId,
      });
    } catch (error) {
      await finishTurn(
        req.sessionId,
        "error",
        (error as { data?: { errorCode?: string }; errorCode?: string })?.data
          ?.errorCode ??
          (error as { errorCode?: string })?.errorCode,
        { turnId: durableTurnId },
      );
      // A turn whose user message could not be appended must not be started:
      // restarting it here would run a prompt the transcript does not contain.
      throw error;
    }
    emitAgentEvent({
      sessionId: req.sessionId,
      ts: Date.now(),
      event: { type: "message_start", message: userMessage },
    } satisfies AgentEventEnvelope);
    emitAgentEvent({
      sessionId: req.sessionId,
      ts: Date.now(),
      event: { type: "message_end", message: userMessage },
    } satisfies AgentEventEnvelope);

    let result: { accepted: boolean; turnId: string };
    try {
      result = await sidecar.call<{ accepted: boolean; turnId: string }>(
        "agent.prompt",
        {
          ...launch.sidecarParams,
          // The host-created durable turn is the approval identity used by
          // Rust. The runtime must not replace it with a provider-local UUID.
          turnId: durableTurnId,
          content: modelContent,
          ...(sessionMessage ? { sessionMessage: sessionMessage.origin } : {}),
          attachments: preparedAttachments
            .filter((attachment) => attachment.inlineData)
            .map((attachment) => ({
              path: attachment.message.ref,
              name: attachment.message.name,
              kind: attachment.message.kind,
              mimeType: attachment.message.mimeType,
              size: attachment.message.size,
              data: attachment.inlineData,
            })),
          userMessageId: userMessage.id,
        },
      );
    } catch (e) {
      await finishTurn(req.sessionId, "error", (e as any)?.errorCode, {
        turnId: durableTurnId,
      });
      throw e;
    }
    logger.app("session", "info", "prompt accepted", {
      sessionId: req.sessionId,
      turnId: result.turnId,
      data: { providerId: launch.providerId, modelId: launch.modelId },
    });
    return result;
    } finally {
      releaseSessionOperation();
    }
  });

  handle(IPC.invoke.agentCompact, async (req: { sessionId: string }) => {
    rejectNativeAgentOperation(req.sessionId);
    if (!host || !sidecar) throw new Error("backend unavailable");
    if (activeTurns.has(req.sessionId)) {
      throw Object.assign(new Error("Session already has an active turn"), {
        errorCode: ErrorCodes.AGENT_BUSY,
      });
    }
    const settings = await host.call<any>("settings.get");
    const detail = await host.call<{ session?: any }>("session.get", {
      id: req.sessionId,
    });
    if (!detail.session) {
      throw Object.assign(new Error("Session not found"), {
        errorCode: ErrorCodes.NOT_FOUND,
      });
    }
    const launch = await resolveAgentRuntimeLaunch(
      req.sessionId,
      detail.session,
      settings,
    );
    sidecar.setProjectInstructionRoot(req.sessionId, launch.projectPath);
    const result = await sidecar.call("agent.compact", launch.sidecarParams);
    logger.app("session", "info", "context compacted manually", {
      sessionId: req.sessionId,
      data: { providerId: launch.providerId, modelId: launch.modelId },
    });
    return result;
  });

  handle(IPC.invoke.agentAbort, async (req: { sessionId: string; turnId?: string }) => {
    if (!sidecar) throw new Error("sidecar unavailable");
    const releaseSessionOperation = req.turnId ? await acquireSessionOperation(req.sessionId) : undefined;
    try {
    const abortedTurnId = activeTurns.get(req.sessionId);
    if (req.turnId && abortedTurnId !== req.turnId) return { ok: false, aborted: false };
    logger.app("session", "info", "prompt aborted", { sessionId: req.sessionId });
    agentHostBridge?.markAborting(req.sessionId);
    // Lock the abort reason before the first await: the cancel RPC can take a
    // while, and a terminal event arriving in that window must not settle the
    // turn as completed.
    lockAbortReason(req.sessionId, abortedTurnId);
    const executionId =
      approvedExecutionIdsBySession.get(req.sessionId) ??
      [...claimedExecutionSessions].find(
        ([, sessionId]) => sessionId === req.sessionId,
      )?.[0];
    let result: unknown;
    try {
      // An open extension prompt resolves with its abort value (spec 16 §9).
      agentExtensions.cancelPrompts(req.sessionId);
      cancelSessionTools(req.sessionId, "Session turn was aborted");
      result = await sidecar.call("agent.abort", req);
    } finally {
      // A turn that already stopped owning the session is refused inside the
      // finalizer, so the identity captured above is the only one used here.
      if (abortedTurnId) {
        await finishTurn(req.sessionId, "aborted", "TURN_ABORTED", {
          turnId: abortedTurnId,
        });
      }
      if (executionId) {
        await finishApprovedExecution(
          executionId,
          "interrupted",
          "PLAN_EXECUTION_INTERRUPTED",
        );
      }
    }
    return result;
    } finally {
      releaseSessionOperation?.();
    }
  });

  handle(IPC.invoke.agentStop, async (req: AgentStopRequest) => {
    if (!sidecar) throw new Error("sidecar unavailable");
    logger.app("session", "info", "prompt graceful stop requested", {
      sessionId: req.sessionId,
    });
    // The runtime owns the boundary decision. Do not close the durable turn
    // here: agent_end must arrive after the current reply/tool batch completes
    // and finish it as a normal completed turn.
    return sidecar.call("agent.stop", req);
  });

  handle(IPC.invoke.agentGetStatus, async (sessionId: string) => {
    if (!sidecar) throw new Error("sidecar unavailable");
    return sidecar.call("agent.getStatus", { sessionId });
  });

  // The Host-owned turn queue (D375 / D386). The renderer mirrors it; the
  // headless module admits, orders, and drains it.
  handle(IPC.invoke.agentQueuePush, async (req: AgentQueuePushRequest) => {
    rejectNativeAgentOperation(req.sessionId);
    if (!agentHostBridge) throw new Error("agent host unavailable");
    return agentHostBridge.queue.push(req);
  });
  handle(IPC.invoke.agentQueueList, async (req: { sessionId: string }) => {
    rejectNativeAgentOperation(req.sessionId);
    if (!agentHostBridge) throw new Error("agent host unavailable");
    return { entries: agentHostBridge.queue.list(req.sessionId) };
  });
  handle(IPC.invoke.agentQueueRemove, async (req: { turnId: string }) => {
    if (!agentHostBridge) throw new Error("agent host unavailable");
    await agentHostBridge.queue.remove(req.turnId);
    return { ok: true };
  });
  handle(IPC.invoke.agentQueuePrioritize, async (req: { turnId: string }) => {
    if (!agentHostBridge) throw new Error("agent host unavailable");
    await agentHostBridge.queue.prioritize(req.turnId);
    return { ok: true };
  });

  handle(
    IPC.invoke.agentQueueReorder,
    async (req: { turnId: string; direction: "up" | "down" }) => {
      if (!agentHostBridge) throw new Error("agent host unavailable");
      if (req.direction !== "up" && req.direction !== "down") {
        throw new Error(`unknown queue reorder direction: ${String(req.direction)}`);
      }
      return agentHostBridge.queue.reorder(req.turnId, req.direction);
    },
  );

  handle(IPC.invoke.toolResolvePermission, async (resolution: {
    requestId: string;
    decision: string;
  }) => {
    if (!host) throw new Error("host unavailable");
    logger.app("permission", "info", "permission resolved", {
      data: { requestId: resolution.requestId, decision: resolution.decision },
    });
    const resolved = await host.call("permissions.resolve", resolution);
    agentHostBridge?.settleApproval(resolution.requestId, {
      ...(resolution.decision === "allow-once" ||
      resolution.decision === "allow-session" ||
      resolution.decision === "deny"
        ? { decision: resolution.decision }
        : {}),
    });
    return resolved;
  });

  handle(IPC.invoke.askToolResolve, async (resolution: AskToolResolution) => {
    if (!sidecar) throw new Error("sidecar unavailable");
    const sessionId = String(resolution?.sessionId ?? "").trim();
    const requestId = String(resolution?.requestId ?? "").trim();
    if (!sessionId || !requestId) throw new Error("asktool resolution identity required");
    return sidecar.call("asktool.resolve", {
      ...resolution,
      sessionId,
      requestId,
    });
  });

  handle(IPC.invoke.plansPending, async (input: { sessionId?: string } = {}) => {
    if (!host) throw new Error("host unavailable");
    return host.call("plans.pending", {
      ...(typeof input.sessionId === "string" && input.sessionId.trim()
        ? { sessionId: input.sessionId.trim() }
        : {}),
    });
  });

  handle(IPC.invoke.plansResolve, async (resolution: PlanResolveRequest) => {
    if (!host) throw new Error("host unavailable");
    const proposalId = String(resolution?.proposalId ?? "").trim();
    if (!proposalId) throw new Error("proposalId required");
    const sessionId = String(resolution?.sessionId ?? "").trim();
    if (!sessionId) throw new Error("sessionId required");
    const turnId = String(resolution?.turnId ?? "").trim();
    if (!turnId) throw new Error("turnId required");
    const toolCallId = String(resolution?.toolCallId ?? "").trim();
    if (!toolCallId) throw new Error("toolCallId required");
    const action = resolution?.action;
    if (action !== "approve" && action !== "reject") {
      throw new Error("invalid plan approval action");
    }
    let targetPermissionMode: GlobalPermissionMode | undefined;
    if (action === "approve") {
      if (!isGlobalPermissionMode(resolution?.targetPermissionMode)) {
        throw Object.assign(new Error("targetPermissionMode is required for approval"), {
          errorCode: ErrorCodes.PLAN_PERMISSION_MODE_REQUIRED,
        });
      }
      targetPermissionMode = resolution.targetPermissionMode;
    }
    const version =
      typeof resolution?.version === "number" &&
      Number.isSafeInteger(resolution.version) &&
      resolution.version > 0
        ? resolution.version
        : undefined;
    const result = await host.call<PlanResolutionResult>("plans.resolve", {
      proposalId,
      sessionId,
      turnId,
      toolCallId,
      action,
      ...(version !== undefined ? { version } : {}),
      ...(targetPermissionMode ? { targetPermissionMode } : {}),
    });
    agentHostBridge?.settleApproval(proposalId, {
      decision: action,
      ...(targetPermissionMode ? { permissionMode: targetPermissionMode } : {}),
    });
    if (action === "approve") {
      const execution = executionFromResponse(result);
      if (execution) {
        void dispatchApprovedPlan(execution);
      } else {
        void dispatchExecutionForProposal(proposalId);
      }
    }
    return result;
  });

}
