import { candidateHash, resolvePageFadeTarget } from "@pi-desktop/agent-runtime";
import { assertPptEditorCommand, assertPptEditorContext, isCoursewareProject, samePptEditorBinding, type CoursewareProject, type PptEditorContext } from "@pi-desktop/shared";
import type { CoursewareTeachingCoordinator } from "./courseware-teaching";
import type { FadeAuthorization, PptEditorController } from "./ppt-editor";
import { readCandidateSource } from "./courseware-candidate-source";
import { coursewareAuthoringUrl } from "./courseware-runtime";

type Host = { call<T>(method: string, params: unknown): Promise<T> };
type Facts = { sessionId: string; host: Host; snapshot: ReturnType<PptEditorController["teachingSnapshot"]>;
  context: PptEditorContext; canonical: { project: CoursewareProject; mapping: unknown } };
type Grant = Facts & { authorization: FadeAuthorization };
type Editor = Pick<PptEditorController, "getContext" | "reviewFade" | "executeFade" | "invalidateFade">;

/** Main-only retained source inspection. Model and renderer never supply authorization. */
export class CoursewareNativeFadeCoordinator {
  private grant: Grant | null = null;
  private version = 0;
  private abort: AbortController | undefined;

  constructor(private teaching: CoursewareTeachingCoordinator, private editor: Editor,
    private getWorkspace: () => Promise<string | null>) {
    editor.invalidateFade = () => this.invalidate();
  }

  invalidate(): void { this.grant = null; this.version++; }
  clear(): void { this.invalidate(); this.abort?.abort(new Error("Native fade owner changed")); }

  private async bounded<T>(canDispatch: () => boolean, operation: (signal: AbortSignal, check: () => void) => Promise<T>): Promise<T> {
    const controller = new AbortController(), version = this.version;
    this.abort = controller;
    const check = () => {
      controller.signal.throwIfAborted();
      if (version !== this.version || !canDispatch()) throw new Error("Native fade context or Chat changed");
    };
    const timer = setInterval(() => { if (!canDispatch()) controller.abort(new Error("Native fade Chat cancelled")); }, 100);
    const timeout = setTimeout(() => controller.abort(new Error("Native fade inspection timed out")), 180_000);
    try { check(); return await operation(controller.signal, check); }
    finally { clearInterval(timer); clearTimeout(timeout); if (this.abort === controller) this.abort = undefined; }
  }

  private async validate(facts: Facts, check: () => void): Promise<void> {
    check();
    await this.teaching.assertCurrent(facts.snapshot, facts.context, facts.sessionId, facts.host);
    check();
    const { session } = await facts.host.call<{ session?: { mode?: string; projectPath?: string } }>("session.get", { id: facts.sessionId });
    const workspace = await this.getWorkspace();
    check();
    if (!workspace || session?.mode !== "agent" || session.projectPath !== workspace) throw new Error("Native fade Chat mode or persisted workspace changed");
    const latest = await facts.host.call<{ project: unknown; mapping: unknown }>("courseware.project.context", { sessionId: facts.sessionId, projectId: facts.canonical.project.projectId });
    check();
    if (JSON.stringify(latest.project) !== JSON.stringify(facts.canonical.project) || JSON.stringify(latest.mapping) !== JSON.stringify(facts.canonical.mapping)) throw new Error("Canonical source, teaching, mapping or lock changed");
  }

  async context(sessionId: string, context: PptEditorContext, canDispatch: () => boolean): Promise<PptEditorContext> {
    context = structuredClone(context);
    this.clear();
    const version = this.version;
    const withoutFade = (value: PptEditorContext) => ({ ...value, capabilities: value.capabilities.filter(capability => capability.name !== "set_slide_fade") });
    if (!context.page || context.readOnly) return withoutFade(context);
    try {
      return await this.bounded(canDispatch, (signal, check) => this.teaching.withSaved(sessionId, async (host, jobId, snapshot, native) => {
        check();
        if (!samePptEditorBinding(context, native) || native.editGeneration !== context.editGeneration || native.page !== context.page) throw new Error("Native fade page changed during capture");
        const opened = await host.call<{ project: unknown }>("courseware.project.openSaved", { sessionId, jobId });
        check();
        const canonical = structuredClone(await host.call<{ project: unknown; mapping: unknown }>("courseware.project.context", { sessionId, projectId: isCoursewareProject(opened.project) ? opened.project.projectId : "" }));
        if (!isCoursewareProject(canonical.project) || canonical.project.source.sha256 !== snapshot.sha256 || JSON.stringify(opened.project) !== JSON.stringify(canonical.project)) throw new Error("Invalid canonical fade project");
        const project = canonical.project, page = project.pages[native.page! - 1];
        if (!page || page.locked) throw new Error("Current fade page is missing or manually locked");
        const facts: Facts = { sessionId, host, snapshot: structuredClone(snapshot), context: structuredClone(native), canonical: { project, mapping: canonical.mapping } };
        await this.validate(facts, check);
        const { text } = await host.call<{ text: string }>("courseware.pageText", { sessionId, jobId, pageNumber: native.page });
        if (typeof text !== "string" || text.length > 32000) throw new Error("Invalid current fade page text");
        const baseline = { projectId: project.projectId, documentId: native.documentId, pageId: page.pageId,
          sourceRevision: project.source.revision, sourceHash: `sha256:${snapshot.sha256}`, teachingRevision: project.teachingRevision,
          contentHash: candidateHash(text), clean: true, readOnly: false, manualLocked: false };
        const current = async () => { await this.validate(facts, check); return baseline; };
        const authoring = coursewareAuthoringUrl();
        if (!authoring) throw new Error("Native fade source inspector is unavailable");
        const { inspectPageFadeSource } = await import(/* @vite-ignore */ authoring) as typeof import("@pi-desktop/courseware-runtime/authoring");
        const source = await readCandidateSource(snapshot.path, snapshot.sha256, signal);
        const target = await resolvePageFadeTarget(source, canonical.mapping, page.pageId);
        const inspection = await inspectPageFadeSource({ baseline, sourcePptx: source, pageText: text, target, getCurrentBaseline: current, signal });
        await this.validate(facts, check);
        if (inspection.target.pageNumber !== native.page) throw new Error("Canonical and native fade pages differ");
        const authorization: FadeAuthorization = { editGeneration: native.editGeneration, page: inspection.target.pageNumber,
          sourceHash: inspection.baseline.sourceHash, slideHash: inspection.slideHash };
        const reviewed = await this.editor.reviewFade(authorization, await this.getWorkspace(), signal);
        await this.validate(facts, check);
        assertPptEditorContext(reviewed);
        if (!samePptEditorBinding(native, reviewed) || reviewed.editGeneration !== native.editGeneration || reviewed.page !== native.page) throw new Error("Native fade review changed the target");
        if (reviewed.capabilities.some(capability => capability.name === "set_slide_fade")) this.grant = { ...facts, authorization };
        else console.warn("Native fade source inspected; current Office native capability is unavailable");
        return reviewed;
      }, signal));
    } catch (error) {
      if (version !== this.version || !canDispatch()) throw error;
      this.grant = null;
      console.warn("Native fade unavailable:", error instanceof Error ? error.message : String(error));
      const fresh = await this.editor.getContext(await this.getWorkspace());
      assertPptEditorContext(fresh);
      if (version !== this.version || !canDispatch()) throw error;
      return withoutFade(fresh);
    }
  }

  async execute(sessionId: string, command: unknown, canDispatch: () => boolean): Promise<unknown> {
    command = structuredClone(command);
    const grant = this.grant;
    this.grant = null;
    assertPptEditorCommand(command);
    if (!grant || grant.sessionId !== sessionId || command.tool !== "set_slide_fade" || !samePptEditorBinding(command, grant.context) || command.editGeneration !== grant.context.editGeneration) throw new Error("Read fresh native fade context before editing");
    return this.bounded(canDispatch, async (signal, check) => {
      await this.validate(grant, check);
      const workspace = await this.getWorkspace();
      check();
      const result = await this.editor.executeFade(command, grant.authorization, workspace,
        async () => this.validate(grant, check), canDispatch, signal);
      // Native dirty/generation changes are expected after dispatch; ownership still must hold.
      signal.throwIfAborted();
      if (!canDispatch()) throw new Error("Native fade Chat changed after dispatch; do not retry automatically");
      return result;
    });
  }
}
