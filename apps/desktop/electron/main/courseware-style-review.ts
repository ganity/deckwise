import { randomUUID } from "node:crypto";
import { candidateHash } from "@pi-desktop/agent-runtime";
import { isCoursewareProject, type CoursewareProject, type CoursewareStyleReview, type PptEditorContext } from "@pi-desktop/shared";
import type { RetainedPageRedo } from "./courseware-redo-candidate";
import type { CoursewareTeachingCoordinator } from "./courseware-teaching";
import type { renderCoursewareSourceVisuals } from "./courseware-source-visuals";

type Host = { call<T>(method: string, params: unknown): Promise<T> };
type Retained = RetainedPageRedo & {
  host: Host; sessionId: string; project: CoursewareProject;
  snapshot: Parameters<CoursewareTeachingCoordinator["assertCurrent"]>[0]; context: PptEditorContext;
  workspace: string;
};
type Render = (input: Omit<Parameters<typeof renderCoursewareSourceVisuals>[0], "ipcMain">) => ReturnType<typeof renderCoursewareSourceVisuals>;
type Review = { retained: Retained; view: CoursewareStyleReview; confirmedPageIds: string[] | null;
  previewImage: Awaited<ReturnType<Render>>["normal"]["image"] };

/** One Main-owned compiler result; Host remains the only durable candidate authority. */
export class CoursewareStyleReviewCoordinator {
  private retained: Retained | null = null;
  private review: Review | null = null;
  private pending: AbortController | null = null;
  private sequence = 0;

  constructor(private teaching: CoursewareTeachingCoordinator, private getWorkspace: () => Promise<string | null>,
    private assertOwner: (sessionId: string) => void, private render: Render) {}

  clearReview(): void {
    this.sequence++; this.pending?.abort(new Error("Style review cleared")); this.pending = null; this.review = null;
  }

  clear(): void { this.clearReview(); this.retained = null; }

  async retain(input: Omit<Retained, "workspace">): Promise<void> {
    this.clear();
    const sequence = this.sequence;
    const workspace = await this.getWorkspace();
    if (!workspace || sequence !== this.sequence) throw new Error("Style representative expired");
    const { host, ...metadata } = input;
    const retained = { ...structuredClone(metadata), host, workspace };
    if (!isCoursewareProject(retained.project) || retained.generated.kind !== "page-pptx" ||
        candidateHash(retained.generated.pptx) !== retained.generated.hash || retained.generated.pptx.length > 50 * 1024 * 1024 ||
        retained.generated.baseline.projectId !== retained.project.projectId ||
        retained.generated.baseline.documentId !== retained.context.documentId ||
        retained.generated.baseline.sourceHash !== `sha256:${retained.snapshot.sha256}` ||
        retained.generated.reference.outputSha256 !== retained.generated.hash.slice(7) ||
        retained.generated.reference.candidateId !== retained.generated.candidateId ||
        !retained.instruction || retained.instruction.length > 8000) throw new Error("Invalid retained style representative");
    await this.assertCurrent(retained);
    if (sequence !== this.sequence) throw new Error("Style representative expired");
    this.retained = retained;
  }

  private async assertCurrent(retained: Retained): Promise<void> {
    const { host, sessionId, project, snapshot, context } = retained;
    this.assertOwner(sessionId);
    if (await this.getWorkspace() !== retained.workspace) throw new Error("Style workspace changed");
    await this.teaching.assertCurrent(snapshot, context, sessionId, host, "saved-page");
    const latest = await host.call<{ project: unknown }>("courseware.project.get", { sessionId, projectId: project.projectId });
    const candidate = await host.call<Record<string, unknown>>("courseware.sourceCandidate.get", {
      sessionId, projectId: project.projectId, candidateId: retained.candidateId,
    });
    await this.teaching.assertCurrent(snapshot, context, sessionId, host, "saved-page");
    this.assertOwner(sessionId);
    const pageId = retained.generated.baseline.pageId;
    if (await this.getWorkspace() !== retained.workspace || JSON.stringify(latest.project) !== JSON.stringify(project) ||
        project.pages[(context.page ?? 0) - 1]?.pageId !== pageId ||
        candidate.candidateId !== retained.candidateId || candidate.projectId !== project.projectId ||
        candidate.kind !== "page-pptx" || candidate.status !== "needs-review" || candidate.stale !== false ||
        candidate.lineageVerified !== true || candidate.applied !== false ||
        candidate.outputSha256 !== retained.generated.hash.slice(7) ||
        JSON.stringify(candidate.targetPageIds) !== JSON.stringify([pageId])) throw new Error("Style representative or teaching changed");
  }

  async prepare(payload: unknown): Promise<CoursewareStyleReview> {
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).length !== 2 ||
        typeof Reflect.get(payload, "sessionId") !== "string" || typeof Reflect.get(payload, "candidateId") !== "string")
      throw new Error("Invalid style review request");
    this.clearReview();
    const retained = this.retained;
    if (!retained || retained.sessionId !== Reflect.get(payload, "sessionId") || retained.candidateId !== Reflect.get(payload, "candidateId"))
      throw new Error("Generate the representative in this Chat again before style review");
    const sequence = this.sequence, controller = new AbortController();
    this.pending = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]);
    const current = async () => {
      signal.throwIfAborted();
      if (sequence !== this.sequence || this.retained !== retained) throw new Error("Style review expired");
      await this.assertCurrent(retained);
      signal.throwIfAborted();
      if (sequence !== this.sequence || this.retained !== retained) throw new Error("Style review expired");
    };
    try {
      await current();
      const preview = await retained.host.call<{ path: string; candidate: Record<string, unknown> }>("courseware.sourceCandidate.preview", {
        sessionId: retained.sessionId, projectId: retained.project.projectId, candidateId: retained.candidateId,
      });
      await current();
      if (typeof preview.path !== "string" || preview.candidate.outputSha256 !== retained.generated.hash.slice(7) ||
          preview.candidate.candidateId !== retained.candidateId) throw new Error("Style candidate preview changed");
      const visuals = await this.render({ workspace: retained.workspace, snapshot: { sourcePath: preview.path, sha256: retained.generated.hash.slice(7) },
        page: retained.context.page!, signal, assertCurrent: current });
      await current();
      if (visuals.pageCount !== retained.project.pages.length || visuals.normal.page !== retained.context.page ||
          visuals.normal.sourceSha256 !== retained.generated.hash.slice(7) || visuals.normal.nativeTextOmitted)
        throw new Error("Style render differs from the retained candidate");
      const image = visuals.normal.image;
      const view: CoursewareStyleReview = { reviewId: randomUUID(), candidateId: retained.candidateId,
        pageId: retained.generated.baseline.pageId, pageNumber: retained.context.page!, outputSha256: retained.generated.hash.slice(7),
        instruction: retained.instruction, pages: retained.project.pages.map((page, index) => ({ pageId: page.pageId, pageNumber: index + 1, locked: page.locked })),
        preview: { width: image.width, height: image.height, preview: `data:image/png;base64,${Buffer.from(image.bytes).toString("base64")}` } };
      this.review = { retained, view, confirmedPageIds: null, previewImage: structuredClone(image) };
      return structuredClone(view);
    } finally { if (this.pending === controller) this.pending = null; }
  }

  async approve(payload: unknown): Promise<{ confirmed: true; pageIds: string[] }> {
    const review = this.review;
    if (!review || !payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).length !== 2 ||
        Reflect.get(payload, "reviewId") !== review.view.reviewId) throw new Error("Style review expired");
    const ids: unknown = Reflect.get(payload, "pageIds");
    if (!Array.isArray(ids) || ids.length < 2 || ids.length > 20 || new Set(ids).size !== ids.length || !ids.includes(review.view.pageId) ||
        ids.some(id => typeof id !== "string" || !review.view.pages.some(page => page.pageId === id && !page.locked)))
      throw new Error("Confirm 2-20 unlocked pages including the representative");
    await this.assertCurrent(review.retained);
    if (this.review !== review || this.retained !== review.retained) throw new Error("Style review expired");
    const pageIds = review.view.pages.filter(page => ids.includes(page.pageId)).map(page => page.pageId);
    review.confirmedPageIds = pageIds;
    return { confirmed: true, pageIds: [...pageIds] };
  }

  async assertConfirmed(sessionId: string, reviewId: string, pageIds: readonly string[]): Promise<void> {
    const review = this.review;
    const ids = [...pageIds];
    if (!review?.confirmedPageIds || review.view.reviewId !== reviewId || review.retained.sessionId !== sessionId)
      throw new Error("Style confirmation changed; review the representative and target pages again");
    await this.assertCurrent(review.retained);
    if (this.review !== review || this.retained !== review.retained || JSON.stringify(review.confirmedPageIds) !== JSON.stringify(ids))
      throw new Error("Style review expired");
  }

  async confirmedScope(sessionId: string): Promise<{ reviewId: string; pageIds: string[] } | null> {
    const review = this.review;
    if (!review?.confirmedPageIds || review.retained.sessionId !== sessionId) return null;
    const scope = { reviewId: review.view.reviewId, pageIds: [...review.confirmedPageIds] };
    try { await this.assertConfirmed(sessionId, scope.reviewId, scope.pageIds); return scope; }
    catch { return null; }
  }

  async loadConfirmed(sessionId: string) {
    const review = this.review;
    if (!review?.confirmedPageIds || review.retained.sessionId !== sessionId) throw new Error("Review a representative and confirm the target pages first");
    await this.assertConfirmed(sessionId, review.view.reviewId, review.confirmedPageIds);
    const { host, ...retained } = review.retained;
    return { ...structuredClone(retained), host, reviewId: review.view.reviewId, pageIds: [...review.confirmedPageIds],
      representativeImage: structuredClone(review.previewImage),
      confirmation: { representativeCandidateId: retained.generated.candidateId, representativeOutputSha256: retained.generated.hash.slice(7),
        instructionHash: candidateHash(retained.instruction), pageIds: [...review.confirmedPageIds] } };
  }
}
