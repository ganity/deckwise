import { generateNarrationWrite, candidateHash, pageNarrationOutputSchema, type PptCandidateBaseline, type PptCandidateContext } from "@pi-desktop/agent-runtime";
import { COURSEWARE_STYLE_BATCH_TIMEOUT_MS, isCoursewareProject } from "@pi-desktop/shared";
import type { PluginCompleteInput, PluginCompleteResult } from "@pi-desktop/plugin-sdk";
import { stagePageFadeCandidate } from "./courseware-source-candidate";
import type { CoursewareTeachingCoordinator } from "./courseware-teaching";
import type { CoursewareVisualReview } from "./courseware-visual-review";
import { stagePageRedoCandidate } from "./courseware-redo-candidate";
import { stagePageStyleBatchCandidate } from "./courseware-style-batch-candidate";
import { coursewareAuthoringUrl } from "./courseware-runtime";
import type { CoursewareStyleReviewCoordinator } from "./courseware-style-review";

export type NarrationComplete = (input: PluginCompleteInput & { sessionId?: string; signal?: AbortSignal; maxOutputTokens?: number }) => Promise<PluginCompleteResult>;
export type SceneComplete = Parameters<typeof stagePageRedoCandidate>[0]["complete"];
export type CandidateModelResolver = (sessionId: string) => Promise<{ modelKey: string; thinkingLevel?: string }>;

/** Main pins source/project/policy; model and renderer cannot choose paths or target pages. */
export class CoursewareCandidateCoordinator {
  constructor(private teaching: CoursewareTeachingCoordinator, private complete: NarrationComplete,
    private redo?: { visuals: CoursewareVisualReview; completeScene: SceneComplete; style?: CoursewareStyleReviewCoordinator; render: Parameters<typeof stagePageStyleBatchCandidate>[0]["render"] },
    private resolveModel?: CandidateModelResolver) {}

  async execute(sessionId: string, name: string, args: unknown, canDispatch: () => boolean): Promise<unknown> {
    return this.run(sessionId, name, args, canDispatch);
  }

  async proposeNativeNarration(sessionId: string, pageNumber: number, instruction: string, canDispatch: () => boolean) {
    const context = await this.run(sessionId, "ppt_get_narration_context", {}, canDispatch, undefined, pageNumber) as PptCandidateContext;
    return this.run(sessionId, "ppt_propose_page_narration", { kind: "page-narration", baseline: context.baseline, instruction }, canDispatch, undefined, pageNumber);
  }

  /** Trusted Host entry only; source text must be explicitly bound to this saved logical page. */
  async selectNarrationSource(sessionId: string, selection: unknown, canDispatch: () => boolean): Promise<unknown> {
    if (!selection || typeof selection !== "object" || Array.isArray(selection) ||
      Object.keys(selection).length !== 3 || Object.keys(selection).some((key) => !["kind", "baseline", "text"].includes(key)) ||
      !["original-notes", "external"].includes(Reflect.get(selection, "kind"))) throw new Error("Invalid narration source selection");
    const captured = structuredClone(selection);
    const narration = pageNarrationOutputSchema.parse({ blocks: [{ type: "speech", text: Reflect.get(captured, "text") }] });
    return this.run(sessionId, "ppt_propose_page_narration", { kind: "page-narration", baseline: Reflect.get(captured, "baseline"),
      instruction: "Use the selected narration text without rewriting it." }, canDispatch, narration);
  }

  private async run(sessionId: string, name: string, args: unknown, canDispatch: () => boolean,
    selectedNarration?: ReturnType<typeof pageNarrationOutputSchema.parse>, nativePageNumber?: number): Promise<unknown> {
    args = structuredClone(args);
    const controller = new AbortController();
    const checkTurn = () => { if (!canDispatch()) controller.abort(new Error("Chat turn cancelled or editor owner changed")); controller.signal.throwIfAborted(); };
    checkTurn();
    const timer = setInterval(() => { if (!canDispatch()) controller.abort(new Error("Chat turn cancelled or editor owner changed")); }, 100);
    const timeout = setTimeout(() => controller.abort(new Error("Candidate generation timed out")), name === "ppt_propose_page_style_batch" ? COURSEWARE_STYLE_BATCH_TIMEOUT_MS - 60_000 : 180_000);
    try {
      if (["ppt_get_narration_context", "ppt_propose_page_narration"].includes(name)) {
        const native = await this.teaching.native?.("narration-context", {}, nativePageNumber);
        if (native) {
          const captured = native.value as { view: import("@pi-desktop/shared").CoursewareTeachingView; text: string; editor: import("@pi-desktop/shared").PptEditorContext };
          const { view, text, editor } = captured, project = view.project;
          const page = project.pages.find(p => p.pageId === view.pageId);
          if (!page || page.locked || editor.readOnly) throw new Error("Native teaching page is locked or read-only");
          const baseline: PptCandidateBaseline = { projectId: editor.projectId, documentId: editor.documentId, sessionId: editor.sessionId,
            editGeneration: editor.editGeneration, coursewareProjectId: project.projectId, pageId: page.pageId,
            sourceRevision: project.source.revision, sourceSha256: project.source.sha256, teachingRevision: project.teachingRevision,
            contentSha256: candidateHash(text).slice(7) };
          const current = async () => {
            checkTurn();
            const latest = await this.teaching.native("narration-context", {}, nativePageNumber);
            if (!latest || JSON.stringify(latest.value) !== JSON.stringify(captured)) throw new Error("Native teaching changed during generation");
            return { projectId: project.projectId, documentId: editor.documentId, pageId: page.pageId, sourceRevision: project.source.revision,
              sourceHash: `sha256:${project.source.sha256}`, teachingRevision: project.teachingRevision, contentHash: candidateHash(text),
              clean: true, readOnly: false, manualLocked: false };
          };
          if (name === "ppt_get_narration_context") return { editor, baseline, clean: true, manualLocked: false,
            capabilities: text.trim() ? ["page-narration"] : [] } satisfies PptCandidateContext;
          if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length !== 3 ||
              Reflect.get(args, "kind") !== "page-narration" || JSON.stringify(Reflect.get(args, "baseline")) !== JSON.stringify(baseline)) throw new Error("Native narration baseline changed");
          if (!this.resolveModel && !selectedNarration) throw new Error("Select a narration model first");
          const model = !selectedNarration ? await this.resolveModel!(sessionId) : null;
          const before = await current();
          const generated = await generateNarrationWrite({ project, pageId: page.pageId, baseline: before, pageText: text,
            instruction: Reflect.get(args, "instruction"), getCurrentBaseline: current, signal: controller.signal,
            generate: async ({ system, data }) => {
              if (selectedNarration) return selectedNarration;
              const output = await this.complete({ sessionId, ...model!, system, messages: [{ role: "user", content: data }],
                includeSessionContext: false, signal: controller.signal });
              if (output.text.length > 1024 * 1024) throw new Error("Narration exceeds output budget");
              return pageNarrationOutputSchema.parse(JSON.parse(output.text));
            } });
          await current();
          if (model && JSON.stringify(await this.resolveModel!(sessionId)) !== JSON.stringify(model)) throw new Error("Narration model changed");
          checkTurn();
          const saved = await this.teaching.native("write", { viewId: view.viewId, expectedTeachingRevision: project.teachingRevision,
            actions: generated.write.actions }, nativePageNumber);
          return { kind: "page-narration", baseline, teachingRevision: (saved!.value as typeof view).project.teachingRevision,
            pageNumber: view.pageNumber, applied: true, saved: false, audioReady: false };
        }
      }
      return await this.teaching.withSaved(sessionId, async (host, jobId, snapshot, editor, _sessionId, parseOutput) => {
        checkTurn();
        const { project } = await host.call<{ project: unknown }>("courseware.project.openSaved", { sessionId, jobId });
        if (!isCoursewareProject(project) || project.source.sha256 !== snapshot.sha256) throw new Error("Invalid current teaching project");
        const page = project.pages[(editor.page ?? 0) - 1];
        if (!page || page.locked) throw new Error("Current teaching page is missing or manually locked");
        const { text } = await host.call<{ text: string }>("courseware.pageText", { sessionId, jobId, pageNumber: editor.page });
        if (typeof text !== "string" || text.length > 32000) throw new Error("Invalid current-page text");
        const baseline: PptCandidateBaseline = { projectId: editor.projectId, documentId: editor.documentId, sessionId: editor.sessionId, editGeneration: editor.editGeneration,
          coursewareProjectId: project.projectId, pageId: page.pageId, sourceRevision: project.source.revision, sourceSha256: snapshot.sha256,
          teachingRevision: project.teachingRevision, contentSha256: candidateHash(text).slice(7) };
        const current = async () => {
          checkTurn();
          await this.teaching.assertCurrent(snapshot, editor, sessionId, host);
          const latest = await host.call<{ project: unknown }>("courseware.project.get", { sessionId, projectId: project.projectId });
          await this.teaching.assertCurrent(snapshot, editor, sessionId, host);
          checkTurn();
          if (JSON.stringify(latest.project) !== JSON.stringify(project)) throw new Error("Teaching or policy changed during generation");
          return { projectId: project.projectId, documentId: editor.documentId, pageId: page.pageId, sourceRevision: project.source.revision,
            sourceHash: `sha256:${snapshot.sha256}`, teachingRevision: project.teachingRevision, contentHash: candidateHash(text), clean: true, readOnly: false, manualLocked: false };
        };
        const generationBaseline = await current();
        if (name === "ppt_get_narration_context") {
          const capabilities: PptCandidateContext["capabilities"] = text.trim() ? ["page-narration", "page-fade"] : ["page-fade"];
          const reviewed = this.redo && coursewareAuthoringUrl() ? await this.redo.visuals.approved() : null;
          if (reviewed?.view.projectId === project.projectId && reviewed.view.pageId === page.pageId && reviewed.view.sourceSha256 === snapshot.sha256)
            capabilities.push("page-pptx");
          const scope = this.redo?.style && coursewareAuthoringUrl() ? await this.redo.style.confirmedScope(sessionId) : null;
          if (scope) capabilities.push("page-style-batch");
          await current();
          return { editor, baseline, clean: true, manualLocked: false, capabilities, ...(scope ? { styleBatch: scope } : {}) } satisfies PptCandidateContext;
        }
        const batch = name === "ppt_propose_page_style_batch";
        const fade = name === "ppt_propose_page_fade";
        const redo = name === "ppt_propose_page_redo";
        if ((!fade && !redo && !batch && name !== "ppt_propose_page_narration") || !args || typeof args !== "object" || Array.isArray(args) ||
          Object.keys(args).length !== (fade ? 2 : 3) || Reflect.get(args, "kind") !== (batch ? "page-style-batch" : fade ? "page-fade" : redo ? "page-pptx" : "page-narration") ||
          (!fade && !batch && ((!redo && !selectedNarration && !text.trim()) || typeof Reflect.get(args, "instruction") !== "string" || !Reflect.get(args, "instruction").trim() || Reflect.get(args, "instruction").length > 8000))) throw new Error("Invalid candidate proposal");
        const requested = Reflect.get(args, "baseline");
        if (!requested || typeof requested !== "object" || Array.isArray(requested) || Object.keys(requested).length !== Object.keys(baseline).length ||
          Object.entries(baseline).some(([key, value]) => Reflect.get(requested, key) !== value)) throw new Error("Narration baseline changed; read the current page again");
        if (fade) return stagePageFadeCandidate({ host, sessionId, jobId, sourcePath: snapshot.path, baseline,
          generationBaseline, pageText: text, current, parseOutput, signal: controller.signal });
        const saveNarration = async (generate: Parameters<typeof generateNarrationWrite>[0]["generate"], beforeSave: () => Promise<void>) => {
          const result = await generateNarrationWrite({ project, pageId: page.pageId, baseline: generationBaseline, pageText: text,
            instruction: Reflect.get(args, "instruction"), getCurrentBaseline: current, signal: controller.signal, generate });
          await beforeSave();
          await current();
          checkTurn();
          const { project: saved } = await host.call<{ project: unknown }>("courseware.narration.save", { sessionId, jobId, baseline: project, write: result.write });
          if (!isCoursewareProject(saved) || saved.projectId !== project.projectId || saved.source.sha256 !== snapshot.sha256)
            throw new Error("Invalid narration save result; read saved teaching before retrying");
          return { kind: "page-narration", baseline, teachingRevision: saved.teachingRevision, pageNumber: editor.page,
            applied: true, saved: true, audioReady: false };
        };
        if (selectedNarration) return saveNarration(async () => selectedNarration, async () => { checkTurn(); });
        const detail = await host.call<{ session?: { providerId?: string; modelId?: string; thinkingLevel?: string; mode?: string } }>("session.get", { id: sessionId });
        const session = detail.session;
        if (session?.mode !== "agent") throw new Error("An active Agent model is required");
        const resolveModel = async () => {
          if (this.resolveModel) return this.resolveModel(sessionId);
          if (!session.providerId || !session.modelId) throw new Error("An active Agent model is required");
          return { modelKey: `${session.providerId}/${session.modelId}`, thinkingLevel: session.thinkingLevel };
        };
        const model = await resolveModel();
        checkTurn();
        const assertModel = async () => {
          const latest = await host.call<typeof detail>("session.get", { id: sessionId });
          if (!latest.session || ["providerId", "modelId", "thinkingLevel", "mode"].some((key) => Reflect.get(latest.session!, key) !== Reflect.get(session, key))) throw new Error("Chat model changed during generation");
          const effective = await resolveModel();
          if (effective.modelKey !== model.modelKey || effective.thinkingLevel !== model.thinkingLevel) throw new Error("Chat model changed during generation");
          checkTurn();
        };
        if (batch) {
          if (!this.redo?.style || !coursewareAuthoringUrl()) throw new Error("Confirmed batch generation is unavailable");
          const scope = await this.redo.style.confirmedScope(sessionId);
          const requestedScope = Reflect.get(args, "styleBatch");
          if (!scope || !requestedScope || typeof requestedScope !== "object" || Array.isArray(requestedScope) ||
              Reflect.get(requestedScope, "reviewId") !== scope.reviewId ||
              JSON.stringify(Reflect.get(requestedScope, "pageIds")) !== JSON.stringify(scope.pageIds) || Object.hasOwn(args, "instruction"))
            throw new Error("Confirmed batch scope changed; review the representative and pages again");
          const receipt = await stagePageStyleBatchCandidate({ sessionId, jobId, style: this.redo.style, scope,
            ...model,
            render: this.redo.render, complete: this.redo.completeScene, parseOutput, signal: controller.signal,
            assertCurrent: async () => { await assertModel(); await current(); },
          });
          return { candidateId: receipt.candidateId, kind: receipt.kind, baseline, targetPageIds: receipt.targetPageIds,
            outputSha256: receipt.outputSha256, reviewState: receipt.reviewState, applied: false };
        }
        if (redo) {
          const reviewed = await this.redo?.visuals.approved();
          if (!reviewed || !this.redo) throw new Error("Prepare and explicitly approve current-page visuals before redo");
          const style = this.redo.style;
          const receipt = await stagePageRedoCandidate({ host, sessionId, jobId, sourcePath: snapshot.path, baseline,
            generationBaseline, pageText: text, instruction: Reflect.get(args, "instruction"), reviewed,
            ...model,
            retain: style ? async result => {
              try { await assertModel(); await current(); await style.retain({ ...result, host, sessionId, snapshot, context: editor, project }); await assertModel(); await current(); }
              catch (error) { style.clear(); throw error; }
            } : undefined,
            complete: this.redo.completeScene, current: async () => { await assertModel(); return current(); }, parseOutput, signal: controller.signal });
          return { candidateId: receipt.candidateId, kind: receipt.kind, baseline, outputSha256: receipt.outputSha256,
            reviewState: receipt.reviewState, applied: receipt.applied };
        }
        return saveNarration(async ({ system, data }) => {
            await current();
            await assertModel();
            // Same Main auth resolver as existing plugin/title completions; no keys cross renderer IPC.
            const output = await this.complete({ sessionId, ...model,
              system,
              messages: [{ role: "user", content: data }], includeSessionContext: false, signal: controller.signal });
            checkTurn();
            if (output.text.length > 1024 * 1024) throw new Error("Narration output exceeds limit");
            return pageNarrationOutputSchema.parse(JSON.parse(output.text));
        }, assertModel);
      }, controller.signal);
    } finally { clearInterval(timer); clearTimeout(timeout); }
  }
}
