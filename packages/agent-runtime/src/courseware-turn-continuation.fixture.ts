import type { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import type { AgentEventEnvelope } from "@pi-desktop/shared";
import { DesktopAgentRuntime } from "./runtime.js";

export const sha256 = "a".repeat(64);

export function fixture(target: "visualMaster" | "cleanPlate" = "cleanPlate", startTool = "courseware_scene_image_prepare", mediaKind: "tts" | "video" = "tts") {
  let requests = 0;
  const contexts: Message[][] = [];
  const toolCounts: number[] = [];
  const saved = { completed: false, generated: false, failed: false, styleConfirmed: true,
    planSha256: sha256, phase: "submitted", queryError: false, ignoreReady: false, mediaUnknown: false, recoveryFailure: false, retryAfterBlock: false,
    repeatReadyReads: false, readyCompletion: false, omitContinuation: false,
    checkpointError: "", assessmentMissing: false, assessmentStarted: false, assessmentCompleted: false, assessmentTts: false,
    checkpointAbort: false, explicitRetry: false, imagePipeline: false,
    qualityIssues: [] as Array<{ pageId: string; pageNumber?: number; code: string; repair: string; repairable: boolean }>, teachingMissing: false, fullMedia: false, narrationMissing: false, audioMissing: false, mediaStarted: false, audioCompleted: false };
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const assessmentTarget = (): Record<string, string> => saved.assessmentTts ? { kind: "tts", sceneId: "quiz", actionId: "question-speech" } :
    { kind: "image", sceneId: "quiz", questionId: "q", optionValue: "A" };
  const assessmentModel = (): Record<string, string | null> => saved.assessmentTts ? { model: "tts-model", voice: null } : { model: "image-model" };
  const events: AgentEventEnvelope[] = [];
  const image = () => ({ intentId: "decomposition", planSha256: sha256, pageId: "scene-001",
    target: { kind: target }, current: true, phase: saved.phase, selected: saved.completed && saved.styleConfirmed,
    task: { state: saved.failed ? "failed" : saved.completed ? "ready" : "queued" },
    asset: saved.completed ? { sha256: "b".repeat(64) } : null });
  const snapshot = () => ({ task: { taskType: startTool === "courseware_presentation_adopt" ? "plain" : "scene", generated: saved.generated },
    plan: { sha256: saved.planSha256, approvedSha256: saved.planSha256, pages: [{ pageId: "scene-001" }] },
    images: [image(), ...(saved.explicitRetry ? [{ ...image(), intentId: "unrelated-failure", phase: "submitted", selected: false, asset: null, task: { state: "failed" } }] : [])], styleConfirmed: saved.styleConfirmed, requiresHumanSelection: !saved.styleConfirmed && saved.completed,
    blockers: saved.completed ? [] : [{ pageId: "scene-001", kind: target }] });
  let checkpoint: unknown = null;
  const runtime = new DesktopAgentRuntime({
    sessionId: "chat", mode: "agent", thinkingLevel: "off",
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    provider: { id: "local", name: "Fixture", baseUrl: "http://127.0.0.1:1/v1", modelId: "fixture",
      apiKey: "", authKind: "none", supportsReasoning: false, supportedThinkingLevels: ["off"],
      modelConfig: { source: "generic", name: "Fixture", baseUrl: "http://127.0.0.1:1/v1", reasoning: false,
        input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 256_000, maxTokens: 4096 } },
    host: { async call<T>(method: string, params: unknown): Promise<T> {
      if (method === saved.checkpointError) throw Object.assign(new Error(`host method not allowed from sidecar: ${method}`), {
        code: -32601, name: saved.checkpointAbort ? "AbortError" : "Error",
      });
      if (method === "courseware.workflow.get") return { checkpoint, completion: { ready: !saved.narrationMissing && !saved.audioMissing && !saved.teachingMissing,
        sourceSha256: sha256, teachingRevision: "t1", issues: saved.teachingMissing ? [{ pageId: "page", code: "QUESTION_MISSING", repair: "narration", repairable: true }] :
          saved.narrationMissing ? [{ pageId: "page", code: "NARRATION_MISSING", repair: "narration", repairable: true }] :
          saved.audioMissing ? [{ pageId: "page", pageNumber: 1, code: "AUDIO_MISSING", repair: "tts", repairable: true }] : [] } } as T;
      if (method === "courseware.workflow.checkpoint") { checkpoint = (params as { checkpoint: unknown }).checkpoint; return { checkpoint } as T; }
      if (method !== "tools.execute") return {} as T;
      const { toolName, args } = params as { toolName: string; args: Record<string, unknown> };
      calls.push({ name: toolName, args });
      if (saved.queryError) return { ok: false, errorCode: "TASK_STATUS_UNAVAILABLE" } as T;
      let content: unknown = snapshot();
      if (["courseware_scene_image_prepare", "courseware_scene_image_refresh"].includes(toolName)) content = {
        image: image(), styleConfirmed: saved.styleConfirmed, requiresHumanSelection: !saved.styleConfirmed && saved.completed,
        waitingFor: saved.completed || saved.failed ? null : "service",
      };
      if (["courseware_scene_compile", "courseware_presentation_adopt"].includes(toolName)) { saved.generated = true; content = { generated: true }; }
      if (toolName === "courseware_narration_propose") { saved.narrationMissing = false; content = { saved: true, failures: [] }; }
      if (toolName === "courseware_media_prepare") { saved.mediaStarted = true; content = { waitingFor: "service", job: { kind: mediaKind, intentId: "original-tts", pageNumber: 1, sourceSha256: sha256 } }; }
      if (toolName === "courseware_media_refresh") {
        if (args.retryFailed === true) saved.mediaStarted = true;
        if (saved.audioCompleted) saved.audioMissing = false;
        content = saved.recoveryFailure ? { saved: false, results: [], failures: [{ intentId: "original-tts", error: "HTTP 500 original recovery unavailable" }] } : { saved: !saved.audioMissing, waitingFor: saved.audioMissing ? "service" : null,
          ...(saved.mediaUnknown ? { media: { task: { state: "submission_unknown" } } } : {}),
          ...(saved.explicitRetry ? { job: { kind: mediaKind, intentId: "original-tts", pageNumber: 1, sourceSha256: sha256 } } : {}) };
      }
      if (toolName === "courseware_media_assessments") {
        saved.assessmentStarted = true;
        if (saved.assessmentCompleted) saved.assessmentMissing = false;
        content = { state: saved.assessmentCompleted ? 'adopted' : 'queued', ...(saved.assessmentTts ? { key: "maic-" + sha256 } : {}) };
      }
      if (toolName === "courseware_media_context") content = { projectId: "project", teachingRevision: "t1", sourceSha256: sha256, narrationReady: !saved.narrationMissing,
        audioReady: !saved.audioMissing, teachingReady: !saved.audioMissing && !saved.teachingMissing, pages: [{ pageNumber: 1, narrationReady: !saved.narrationMissing, audioReady: !saved.audioMissing, speeches: [{ actionId: "speech", audioReady: !saved.audioMissing }] }],
        videoReady: mediaKind !== "video" || !saved.audioMissing,
        assessmentMedia: { ready: !saved.assessmentMissing, projectId: 'project', expectedRevision: 'r1', expectedSourceRevision: 'source',
          targets: saved.assessmentMissing ? [assessmentTarget()] : [] },
        ...(saved.repeatReadyReads || saved.readyCompletion ? { completion: { ready: true, sourceSha256: sha256, teachingRevision: "t1" },
          approvedPlan: { narration: "x".repeat(338000) } } : {}),
        quality: { blocking: false, issues: saved.qualityIssues },
        jobs: saved.mediaStarted && saved.audioMissing ? [{ kind: mediaKind, intentId: "original-tts", pageNumber: 1, actionId: "speech", sourceSha256: sha256 }] : [] };
      return { ok: true, content } as T;
    } },
    onEvent: event => { events.push(event); },
  });
  const { agent } = runtime as unknown as { agent: Agent };
  agent.streamFunction = (_model, context) => {
    contexts.push(context.messages);
    toolCounts.push(getCurrentTools(context.messages).length);
    requests++;
    const content: AssistantMessage["content"] = requests === 1
      ? [{ type: "toolCall", id: "search", name: "ToolSearch", arguments: { query: startTool + " courseware_scene_compile courseware_narration_propose courseware_media_prepare" } }]
      : requests === 2
      ? [{ type: "toolCall", id: "start", name: startTool, arguments: startTool === "courseware_presentation_adopt"
        ? { path: "/workspace/.deckwise-ppt/projects/lesson/exports/lesson.pptx", sourceSha256: sha256,
          pages: [{ pageNumber: 1, teaching: { pageType: "slide", phase: "explore", objective: "Teach family", durationSeconds: 30, requiredObjects: [] } }],
          ...(saved.omitContinuation ? {} : { continueTeaching: saved.fullMedia }) }
        : startTool === "courseware_media_context" ? (saved.fullMedia ? { continueTeaching: true } : {}) : startTool === "courseware_scene_image_prepare"
        ? { planSha256: sha256, pageId: "scene-001", target: { kind: target } }
        : startTool === "courseware_scene_image_refresh" ? { intentId: "decomposition", ...(saved.imagePipeline ? { generateRemaining: true } : { waitForUpdate: true }), ...(saved.explicitRetry ? { retryFailed: true } : {}) }
        : startTool === "courseware_media_refresh" ? { kind: mediaKind, sourceSha256: sha256, pageNumber: 1, intentId: "original-tts", retryFailed: true } : {} }]
      : saved.repeatReadyReads
        ? [{ type: "toolCall", id: `repeat-${requests}`, name: "courseware_media_context", arguments: {} }]
      : requests === 4 && saved.retryAfterBlock
        ? [{ type: "toolCall", id: "replacement", name: "courseware_media_prepare", arguments: { kind: "tts", sourceSha256: sha256, pageNumber: 1, actionId: "speech", model: "different-model" } }]
      : requests === 4 && !saved.generated && saved.styleConfirmed && !saved.failed && !saved.ignoreReady
        ? [{ type: "toolCall", id: "compile", name: "courseware_scene_compile", arguments: { planSha256: sha256, ...(saved.fullMedia ? { continueTeaching: true } : {}) } }]
        : saved.assessmentMissing && !saved.assessmentStarted
          ? [{type:'toolCall',id:'assessment',name:'courseware_media_assessments',arguments:{mode:'prepare',projectId:'project',expectedRevision:'r1',expectedSourceRevision:'source',
            ...assessmentTarget(), ...assessmentModel()}}]
        : saved.fullMedia && requests === (["courseware_media_context", "courseware_presentation_adopt"].includes(startTool) ? 4 : 6)
          ? [{ type: "toolCall", id: "narration", name: "courseware_narration_propose", arguments: { sourceSha256: sha256, pageNumbers: [1], instruction: "Explain the whole lesson" } }]
        : saved.fullMedia && requests === (["courseware_media_context", "courseware_presentation_adopt"].includes(startTool) ? 6 : 8)
          ? [{ type: "toolCall", id: "tts", name: "courseware_media_prepare", arguments: { kind: "tts", sourceSha256: sha256, pageNumber: 1, actionId: "speech", model: "tts" } }]
        : [{ type: "text", text: saved.failed ? "The generation job failed." : saved.generated ? "Editable PPTX completed." :
          saved.completed && !saved.styleConfirmed ? "Please confirm the cover style." : "Tasks are processing; click Continue later." }];
    const toolUse = content[0]?.type === "toolCall";
    const message: AssistantMessage = { role: "assistant", content, api: "openai-completions",
      provider: "local", model: "fixture", timestamp: Date.now(), stopReason: toolUse ? "toolUse" : "stop",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: toolUse ? "toolUse" : "stop", message });
      stream.end(message);
    });
    return stream;
  };
  return { runtime, agent, calls, events, saved, contexts, toolCounts, requests: () => requests, checkpoint: () => checkpoint };
}

