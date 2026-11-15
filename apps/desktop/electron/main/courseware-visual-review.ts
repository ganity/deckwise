import { randomUUID } from "node:crypto";
import { isCoursewareProject, samePptEditorBinding, type CoursewareSourceVisualReview } from "@pi-desktop/shared";
import type { CoursewareTeachingCoordinator } from "./courseware-teaching";
import type { PptEditorController } from "./ppt-editor";
import type { renderCoursewareSourceVisuals } from "./courseware-source-visuals";

type Render = (input: Omit<Parameters<typeof renderCoursewareSourceVisuals>[0], "ipcMain">) => ReturnType<typeof renderCoursewareSourceVisuals>;
type Review = { view: CoursewareSourceVisualReview; approved: boolean; assertCurrent(): Promise<void>; visuals: Awaited<ReturnType<Render>> };

/** One current-page review only; PNGs and approval remain private to Main memory. */
export class CoursewareVisualReview {
  private review: Review | null = null;
  private pending: AbortController | null = null;
  private sequence = 0;

  constructor(private teaching: CoursewareTeachingCoordinator, private editor: Pick<PptEditorController, "sourceAdoptionSnapshot">,
    private getWorkspace: () => Promise<string | null>, private assertOwner: (sessionId: string) => void, private render: Render) {}

  clear(): void { this.sequence++; this.pending?.abort(new Error("Source visual review cleared")); this.pending = null; this.review = null; }

  async prepare(payload: unknown): Promise<CoursewareSourceVisualReview> {
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).length !== 1 ||
        typeof Reflect.get(payload, "sessionId") !== "string") throw new Error("Invalid source visual review request");
    const sessionId: string = Reflect.get(payload, "sessionId");
    this.clear();
    const sequence = this.sequence, controller = new AbortController();
    this.pending = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]);
    const check = () => { signal.throwIfAborted(); this.assertOwner(sessionId); if (this.sequence !== sequence) throw new Error("Source visual review expired"); };
    try {
      const result = await this.teaching.withSaved(sessionId, async (host, jobId, snapshot, context) => {
        check();
        const workspace = await this.getWorkspace();
        if (!workspace) throw new Error("No active courseware workspace");
        const source = this.editor.sourceAdoptionSnapshot(workspace);
        if (!samePptEditorBinding(source, snapshot) || source.sha256 !== snapshot.sha256 || source.revision !== snapshot.revision)
          throw new Error("Source visual editor changed");
        const { project } = await host.call<{ project: unknown }>("courseware.project.openSaved", { sessionId, jobId });
        if (!isCoursewareProject(project) || project.source.sha256 !== snapshot.sha256) throw new Error("Invalid source visual project");
        const page = project.pages[(context.page ?? 0) - 1];
        if (!page || page.locked) throw new Error("Current source page is missing or manually locked");
        const current = async () => {
          this.assertOwner(sessionId);
          if (this.sequence !== sequence || await this.getWorkspace() !== workspace) throw new Error("Source visual review expired");
          // Saved-page visuals do not depend on the native text selection generation.
          await this.teaching.assertCurrent(snapshot, context, sessionId, host, "saved-page");
          const latest = await host.call<{ project: unknown }>("courseware.project.get", { sessionId, projectId: project.projectId });
          await this.teaching.assertCurrent(snapshot, context, sessionId, host, "saved-page");
          const now = this.editor.sourceAdoptionSnapshot(workspace);
          this.assertOwner(sessionId);
          if (this.sequence !== sequence || await this.getWorkspace() !== workspace || now.sourcePath !== source.sourcePath ||
              !samePptEditorBinding(now, source) || now.sha256 !== source.sha256 || now.revision !== source.revision ||
              JSON.stringify(latest.project) !== JSON.stringify(project)) throw new Error("Source page or teaching changed; prepare visuals again");
        };
        await current(); check();
        const visuals = await this.render({ workspace, snapshot: source, page: context.page!, signal, assertCurrent: async () => { check(); await current(); check(); } });
        check(); await current();
        if (visuals.pageCount !== project.pages.length || visuals.normal.sourceSha256 !== snapshot.sha256 || visuals.textless.sourceSha256 !== snapshot.sha256 ||
            visuals.normal.page !== context.page || visuals.textless.page !== context.page || visuals.normal.pageToken !== visuals.textless.pageToken ||
            visuals.normal.nativeTextOmitted || !visuals.textless.nativeTextOmitted) throw new Error("Rendered source page mapping differs from Host");
        const image = (value: typeof visuals.normal) => ({ width: value.image.width, height: value.image.height,
          preview: `data:image/png;base64,${Buffer.from(value.image.bytes).toString("base64")}` });
        const view = { reviewId: randomUUID(), projectId: project.projectId, pageId: page.pageId, pageNumber: context.page!, sourceSha256: snapshot.sha256,
          original: image(visuals.normal), nativeTextless: image(visuals.textless) };
        return { view, visuals, assertCurrent: current, approved: false };
      }, signal);
      check(); await result.assertCurrent(); check();
      this.review = result;
      return structuredClone(result.view);
    } finally { if (this.pending === controller) this.pending = null; }
  }

  async approve(payload: unknown): Promise<{ approved: true }> {
    const review = this.review;
    if (!review || !payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).length !== 1 ||
        Reflect.get(payload, "reviewId") !== review.view.reviewId) throw new Error("Source visual review expired");
    await review.assertCurrent();
    if (this.review !== review) throw new Error("Source visual review expired");
    review.approved = true;
    return { approved: true };
  }

  async load(reviewId: string) {
    const review = this.review;
    if (!review?.approved || review.view.reviewId !== reviewId) throw new Error("Source visuals have not been approved");
    await review.assertCurrent();
    if (this.review !== review || !review.approved) throw new Error("Source visual review expired");
    return { view: structuredClone(review.view), visuals: structuredClone(review.visuals), assertCurrent: review.assertCurrent };
  }

  async approved() {
    const review = this.review;
    if (!review?.approved) return null;
    try { return await this.load(review.view.reviewId); }
    catch { if (this.review === review) this.clear(); return null; }
  }
}
