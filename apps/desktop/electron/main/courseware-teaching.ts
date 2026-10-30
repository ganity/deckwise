import { randomUUID } from "node:crypto";
import type { LocalSnapshotAsset } from "./courseware-portable-media";
import { objectsForTeaching } from "./courseware-scene-object-view";
import { isCoursewareTeachingDraft, isCoursewareTeachingHistory, isCoursewareAttentionCue, isCoursewareAttentionIntent, isCoursewareInteractionCheckpoint, sourceChangeForTeaching, chatChangesForTeaching, type CoursewareTeachingHistory } from "@pi-desktop/shared";
import { setTimeout as delay } from "node:timers/promises";
import { isCoursewareProject, isCoursewareSnapshot, isTeachingWrite, samePptEditorBinding, type CoursewareTeachingDraft, type CoursewareSnapshot, type CoursewareTeachingView, type CoursewareNarrationReview, type CoursewarePptxCandidateReview, type CoursewareSourceReview, type PptEditorBinding, type PptEditorContext } from "@pi-desktop/shared";

type Host = { call<T>(method: string, params: unknown): Promise<T> };
type Snapshot = PptEditorBinding & { path: string; sourcePath: string; revision: number; sha256: string };
type Editor = {
  getContext(workspace: string | null): Promise<PptEditorContext>;
  teachingSnapshot(workspace: string | null): Snapshot;
  verifyTeachingSource(workspace: string | null): Promise<void>;
};
type Pin = { view: CoursewareTeachingView; snapshot: Snapshot; context: PptEditorContext; sessionId: string; host: Host };
type SnapshotAsset = LocalSnapshotAsset | ({ asset: { id: string; sha256: string; mimeType: string } } &
  ({ path: string; tts?: never; music?: never } | { tts: { principalKey: string; intentId: string }; path?: never; music?: never } |
    { music: { principalKey: string; intentId: string }; path?: never; tts?: never } |
    { video: { principalKey: string; intentId: string }; path?: never; tts?: never; music?: never }));

function sourceEffectTargets(review: Pick<CoursewareSourceReview, "project" | "pageCount" | "effectTargets" | "targetPages">, pageIds?: string[]): Set<string> {
  const expected = new Set<string>();
  for (const page of review.project.pages.filter(page => !pageIds || pageIds.includes(page.pageId))) for (const action of page.actions) {
    if (action.attention !== undefined) {
      if (action.type !== "speech" || !isCoursewareAttentionIntent(action.attention)) throw new Error("Unsupported speech attention");
      for (const objectId of action.attention.objectIds) expected.add(JSON.stringify([page.pageId, objectId]));
    }
    if (action.visualCues === undefined) continue;
    if (action.type !== "speech" || !Array.isArray(action.visualCues) || action.visualCues.length > 200)
      throw new Error("Unsupported source-review effect cues");
    for (const cue of action.visualCues) {
      if (!isCoursewareAttentionCue(cue)) throw new Error("Unsupported source-review effect cue");
      const targets = cue.effect.type === "highlight" ? cue.effect.elementIds : [cue.effect.elementId, ...(cue.effect.elementIds ?? [])];
      for (const objectId of targets) expected.add(JSON.stringify([page.pageId, objectId]));
    }
  }
  if (!expected.size && review.effectTargets === undefined && review.targetPages === undefined) return expected;
  if (!Array.isArray(review.targetPages) || review.targetPages.length !== review.pageCount ||
      !review.targetPages.every(page => page && Array.isArray(page.objects) && page.objects.length <= 10000 &&
        page.objects.every((object, index) => object && object.index === index + 1 && typeof object.kind === "string" && object.kind.length > 0 && object.kind.length <= 200)) ||
      !Array.isArray(review.effectTargets) || review.effectTargets.length !== expected.size)
    throw new Error("Invalid source-review saved objects");
  const seen = new Set<string>();
  for (const target of review.effectTargets) {
    const key = JSON.stringify([target?.pageId, target?.objectId]);
    if (!target || !expected.has(key) || seen.has(key) || !["text", "shape", "image"].includes(target.kind) ||
        !Number.isInteger(target.index) || target.index < 1 || target.index > 10000)
      throw new Error("Invalid previous source-review effect target");
    seen.add(key);
  }
  return expected;
}

function validateEffectBindings(expected: Set<string>, pages: CoursewareSourceReview["targetPages"], pageIds: Array<string | null>, input: unknown) {
  if (!Array.isArray(input) || input.length !== expected.size) throw new Error("Every effect target requires explicit association");
  const used = new Set<string>(), seen = new Set<string>();
  for (const value of input) {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 3 ||
        !["pageIndex", "objectId", "targetIndex"].every(key => Object.hasOwn(value, key))) throw new Error("Invalid effect associations");
    const { pageIndex, objectId, targetIndex } = value;
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pageIds.length || pageIds[pageIndex] === null ||
        !Number.isInteger(targetIndex) || targetIndex < 1 || typeof objectId !== "string") throw new Error("Invalid effect association indexes");
    const key = JSON.stringify([pageIds[pageIndex], objectId]), current = JSON.stringify([pageIndex, targetIndex]);
    const destination = pages?.[pageIndex]?.objects[targetIndex - 1];
    if (!expected.has(key) || seen.has(key) || used.has(current) || !destination || !["text", "shape", "image"].includes(destination.kind))
      throw new Error("Stale, unsupported, duplicate or cross-page effect association");
    seen.add(key); used.add(current);
  }
  return structuredClone(input);
}

function candidateEffects(project: CoursewareTeachingView["project"], candidate: Record<string, unknown>): Pick<CoursewarePptxCandidateReview, "effectTargets" | "effectPages" | "effectCues"> {
  const scope = candidate.kind === "page-fade" ? [] : candidate.targetPageIds as string[];
  const review = { project, pageCount: project.pages.length, effectTargets: candidate.effectTargets as CoursewareSourceReview["effectTargets"],
    targetPages: candidate.effectPages as CoursewareSourceReview["targetPages"] };
  const expected = sourceEffectTargets(review, scope);
  if (!expected.size) return {};
  const effectCues: NonNullable<CoursewarePptxCandidateReview["effectCues"]> = [];
  for (const [index, page] of project.pages.entries()) if (scope.includes(page.pageId)) for (const action of page.actions)
    if (Array.isArray(action.visualCues)) for (const cue of action.visualCues) if (isCoursewareAttentionCue(cue))
      effectCues.push({ pageNumber: index + 1, effect: cue.effect.type === "element_animation" ? cue.effect.effect : cue.effect.type, atMs: cue.atMs, endMs: cue.endMs });
  return { effectTargets: review.effectTargets!.map(target => ({ ...target, pageIndex: project.pages.findIndex(page => page.pageId === target.pageId) })),
    effectPages: structuredClone(review.targetPages), effectCues };
}

/** Page numbers are usable only within the exact saved bytes pinned by this view. */
export class CoursewareTeachingCoordinator {
  private pin: Pin | null = null;
  private draftPins = new Map<string, Pin>();
  private opening = false;
  private savedRead: { snapshot: Snapshot; sessionId: string; host: Host; workspace: string; projectId: string } | null = null;
  private narrationReview: { view: CoursewareNarrationReview; pin: Pin } | null = null;
  private review: { publicView: CoursewareSourceReview; hostReviewId: string; snapshot: Snapshot; context: PptEditorContext; sessionId: string; host: Host } | null = null;
  private pptxCandidateReview: { view: CoursewarePptxCandidateReview; snapshot: Snapshot; context: PptEditorContext; sessionId: string; host: Host } | null = null;

  constructor(private editor: Editor, private getHost: () => Host | null, private getWorkspace: () => Promise<string | null>, private getViewingSessionId: () => string | null, private assertCandidateOwner: (sessionId: string) => void,
    private assertMediaOwner: (sessionId: string) => void = assertCandidateOwner) {}

  async duringNativeSave<T>(operation: () => Promise<T>): Promise<T> {
    while (this.opening) await delay(25);
    this.opening = true;
    this.pin = null; this.savedRead = null; this.review = null; this.narrationReview = null;
    try { return await operation(); }
    finally { this.opening = false; }
  }

  async open(sessionId: unknown): Promise<CoursewareTeachingView> {
    if (typeof sessionId !== "string" || this.getViewingSessionId() !== sessionId) throw new Error("Invalid or inactive project session");
    if (this.opening) throw new Error("Teaching is already opening");
    const saved = this.savedRead;
    if (saved) {
      this.opening = true;
      this.pin = null;
      this.review = null;
      this.narrationReview = null;
      try {
        const workspace = await this.getWorkspace(), host = this.getHost();
        const snapshot = this.editor.teachingSnapshot(workspace);
        if (workspace === saved.workspace && host === saved.host && sessionId === saved.sessionId &&
            samePptEditorBinding(snapshot, saved.snapshot) && snapshot.path === saved.snapshot.path &&
            snapshot.sourcePath === saved.snapshot.sourcePath && snapshot.revision === saved.snapshot.revision && snapshot.sha256 === saved.snapshot.sha256) {
          await this.editor.verifyTeachingSource(workspace);
          const context = await this.editor.getContext(workspace);
          await this.assertCurrent(snapshot, context, sessionId, host);
          const result = await host.call<{ project: unknown }>("courseware.project.get", { sessionId, projectId: saved.projectId });
          if (!isCoursewareProject(result.project) || result.project.projectId !== saved.projectId) throw new Error("Saved teaching project is unavailable");
          return await this.setView(result.project, snapshot, context, sessionId, host);
        }
      } catch (error) {
        this.savedRead = null;
        throw error;
      } finally { this.opening = false; }
      this.savedRead = null;
    }
    const opened = await this.withSaved(sessionId, async (host, jobId, snapshot, context, sessionId) => {
      const result = await host.call<{ project: unknown }>("courseware.project.openSaved", { sessionId, jobId });
      if (isCoursewareProject(result.project) && result.project.taskType === "plain" && result.project.pages.length <= 30 &&
          result.project.pages.every((page) => page.actions.length === 0 && !page.locked && page.reviewState === "review")) {
        const narrations: string[] = [];
        let missing = 0;
        for (let pageNumber = 1; pageNumber <= result.project.pages.length; pageNumber++) {
          try {
            const { text } = await host.call<{ text: string }>("courseware.pageNotes", { sessionId, jobId, pageNumber });
            narrations.push(text);
          } catch (error) {
            if (!String(error).includes("COURSEWARE_NOTES_EMPTY")) throw error;
            missing++;
          }
        }
        if (missing === result.project.pages.length) return this.setView(result.project, snapshot, context, sessionId, host);
        if (missing) throw new Error("部分 PPT 页面没有讲解备注，请补齐后再初始化逐页讲解");
        const detail = await host.call<{ session?: { title?: string } }>("session.get", { id: sessionId });
        await this.assertCurrent(snapshot, context, sessionId, host);
        const initialized = await host.call<{ project: unknown }>("courseware.project.initializeGenerated", {
          sessionId, jobId, sourceSha256: snapshot.sha256,
          title: detail.session?.title?.trim() || result.project.title, narrations,
        });
        return this.setView(initialized.project, snapshot, context, sessionId, host);
      }
      return this.setView(result.project, snapshot, context, sessionId, host);
    });
    const pin = this.pin!;
    const workspace = await this.getWorkspace();
    if (workspace && pin?.view === opened && this.getHost() === pin.host && this.getViewingSessionId() === pin.sessionId)
      this.savedRead = { snapshot: pin.snapshot, sessionId: pin.sessionId, host: pin.host, workspace, projectId: opened.project.projectId };
    return opened;
  }

  async importCurrentPageNotes(sessionId: unknown): Promise<{ view: CoursewareTeachingView; text: string }> {
    const saved = await this.withSaved(sessionId, async (host, jobId, snapshot, context, sessionId) => {
      const { project } = await host.call<{ project: unknown }>("courseware.project.openSaved", { sessionId, jobId });
      if (!isCoursewareProject(project) || project.taskType !== "import" || !context.page ||
          project.pages[context.page - 1]?.actions.length || project.pages[context.page - 1]?.locked)
        throw new Error("当前页不能从原 PPT 备注导入讲解");
      const { text } = await host.call<{ text: string }>("courseware.pageNotes", { sessionId, jobId, pageNumber: context.page });
      if (typeof text !== "string" || !text.trim() || text.length > 2500) throw new Error("原 PPT 当前页没有可用备注");
      await this.assertCurrent(snapshot, context, sessionId, host);
      return { text, pageId: project.pages[context.page - 1]!.pageId, sourceSha256: snapshot.sha256 };
    });
    const view = await this.open(sessionId);
    if (view.pageId !== saved.pageId || view.project.source.sha256 !== saved.sourceSha256 ||
        view.project.pages[view.pageNumber - 1]?.actions.length || view.project.pages[view.pageNumber - 1]?.locked)
      throw new Error("当前页已变化，请重新读取备注");
    return { view, text: saved.text };
  }

  async copyProject(sessionId: unknown): Promise<{ path: string; mediaCount: number }> {
    const previous = this.pin, review = this.review, narrationReview = this.narrationReview;
    const baseline = previous ?? narrationReview?.pin ?? (review && { ...review, view: review.publicView });
    let cleanupFailed = false;
    try {
      return await this.withSaved(sessionId, async (host, jobId, snapshot, context, currentSessionId) => {
        this.assertCandidateOwner(currentSessionId);
        const { project } = await host.call<{ project: unknown }>("courseware.project.openSaved", { sessionId: currentSessionId, jobId });
        if (!isCoursewareProject(project) || project.source.sha256 !== snapshot.sha256) throw new Error("Invalid project copy baseline");
        await this.assertCurrent(snapshot, context, currentSessionId, host);
        this.assertCandidateOwner(currentSessionId);
        const result = await host.call<{ path: string; mediaCount: number; sourceSha256: string; teachingRevision: string }>("courseware.project.copy", {
          sessionId: currentSessionId, jobId, expectedSourceRevision: project.source.revision,
          expectedTeachingRevision: project.teachingRevision,
        });
        await this.assertCurrent(snapshot, context, currentSessionId, host);
        this.assertCandidateOwner(currentSessionId);
        if (!result || typeof result.path !== "string" || !result.path || result.path.length > 4096 ||
            !Number.isSafeInteger(result.mediaCount) || result.mediaCount < 0 || result.mediaCount > 1000 ||
            result.sourceSha256 !== snapshot.sha256 || result.teachingRevision !== project.teachingRevision)
          throw new Error("Invalid project copy result");
        return { path: result.path, mediaCount: result.mediaCount };
      });
    } catch (error) {
      cleanupFailed = error instanceof Error && error.message.startsWith("Teaching parser cleanup failed:");
      throw error;
    } finally {
      // A read-only copy must not invalidate the sidebar's unchanged view, including on export failure.
      if (!cleanupFailed && baseline && !this.pin && !this.review && !this.narrationReview && !this.opening) {
        try {
          await this.assertCurrent(baseline.snapshot, baseline.context, baseline.sessionId, baseline.host);
          const { project } = await baseline.host.call<{ project: unknown }>("courseware.project.get", {
            sessionId: baseline.sessionId, projectId: baseline.view.project.projectId,
          });
          await this.assertCurrent(baseline.snapshot, baseline.context, baseline.sessionId, baseline.host);
          if (!this.pin && !this.review && !this.narrationReview && !this.opening && JSON.stringify(project) === JSON.stringify(baseline.view.project)) {
            this.pin = previous;
            this.review = review;
            this.narrationReview = narrationReview;
          }
        } catch { /* A changed baseline stays invalid until the sidebar refreshes. */ }
      }
    }
  }

  async captureSnapshot(payload: unknown, assets: SnapshotAsset[] = [], assertAccount?: () => void): Promise<CoursewareSnapshot> {
    const pin = this.pin;
    if (!pin || !payload || typeof payload !== "object" || Array.isArray(payload) ||
        Object.keys(payload).length !== 2 || Reflect.get(payload, "viewId") !== pin.view.viewId ||
        Reflect.get(payload, "expectedTeachingRevision") !== pin.view.project.teachingRevision)
      throw new Error("Teaching view changed; reload current page");
    this.assertCandidateOwner(pin.sessionId);
    await this.assertCurrent(pin.snapshot, pin.context, pin.sessionId, pin.host);
    if (this.pin !== pin || this.opening) throw new Error("Teaching view changed; reload current page");
    if (pin.view.project.pages.some((page) => page.reviewState !== "ready"))
      throw new Error("COURSEWARE_REVIEW_REQUIRED: confirm every page before building a preview");
    const mediaAssetIds = pin.view.project.pages.flatMap((page) => page.actions)
      .filter((action) => action.type === "speech" || action.type === "audio_clip" || action.type === "video_clip")
      .map((action) => action.type === "video_clip" ? action.videoAssetId : action.audioAssetId);
    const suppliedAssetIds = assets.map(({ asset }) => asset.id);
    if (mediaAssetIds.some((assetId) => typeof assetId !== "string") ||
        JSON.stringify([...new Set(mediaAssetIds)].sort()) !== JSON.stringify([...new Set(suppliedAssetIds)].sort()) ||
        suppliedAssetIds.length !== new Set(suppliedAssetIds).size)
      throw new Error("COURSEWARE_AUDIO_REQUIRED: each current media action needs one verified snapshot asset");
    return this.withSaved(pin.sessionId, async (host, jobId, snapshot, context, sessionId) => {
      if (host !== pin.host || !samePptEditorBinding(snapshot, pin.snapshot) || snapshot.sha256 !== pin.snapshot.sha256 ||
          snapshot.revision !== pin.snapshot.revision || context.page !== pin.context.page || context.editGeneration !== pin.context.editGeneration)
        throw new Error("Teaching view changed; reload current page");
      const result = await host.call<{ project: unknown }>("courseware.project.openSaved", { sessionId, jobId });
      if (!isCoursewareProject(result.project) || JSON.stringify(result.project) !== JSON.stringify(pin.view.project))
        throw new Error("Teaching changed; reload current page");
      this.assertCandidateOwner(sessionId);
      await this.assertCurrent(snapshot, context, sessionId, host);
      assertAccount?.();
      const snapshotId = randomUUID();
      const captured = await host.call<{ snapshot: unknown }>("courseware.snapshot.capture", {
        sessionId, jobId, snapshotId, expectedSourceRevision: result.project.source.revision,
        expectedTeachingRevision: result.project.teachingRevision, assets,
      });
      assertAccount?.();
      this.assertCandidateOwner(sessionId);
      await this.assertCurrent(snapshot, context, sessionId, host);
      if (!isCoursewareSnapshot(captured.snapshot) || captured.snapshot.snapshotId !== snapshotId ||
          captured.snapshot.projectId !== result.project.projectId ||
          JSON.stringify(captured.snapshot.source) !== JSON.stringify(result.project.source) ||
          captured.snapshot.teachingRevision !== result.project.teachingRevision ||
          captured.snapshot.assetIds.length !== assets.length ||
          JSON.stringify(captured.snapshot.assetIds) !== JSON.stringify(assets.map((asset) => asset.asset.id).sort()))
        throw new Error("Invalid Host snapshot capture");
      this.pin = pin;
      return structuredClone(captured.snapshot);
    });
  }

  async reviewPptxCandidate(payload: unknown): Promise<CoursewarePptxCandidateReview> {
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).length !== 2 ||
        typeof Reflect.get(payload, "sessionId") !== "string" || typeof Reflect.get(payload, "candidateId") !== "string" ||
        !/^[\w.-]{1,128}$/u.test(Reflect.get(payload, "candidateId"))) throw new Error("Invalid PPTX candidate review request");
    const sessionId = Reflect.get(payload, "sessionId");
    this.assertCandidateOwner(sessionId);
    return this.withSaved(sessionId, async (host, jobId, snapshot, context, sessionId) => {
      const { project } = await host.call<{ project: unknown }>("courseware.project.openSaved", { sessionId, jobId });
      const teaching = await this.setView(project, snapshot, context, sessionId, host);
      const candidate = await host.call<Record<string, unknown>>("courseware.sourceCandidate.get", {
        sessionId, projectId: teaching.project.projectId, candidateId: Reflect.get(payload, "candidateId"),
      });
      const source = candidate.source as { sha256?: unknown } | undefined;
      if (candidate.candidateId !== Reflect.get(payload, "candidateId") || candidate.projectId !== teaching.project.projectId ||
          !["page-pptx", "page-fade", "page-style-batch"].includes(String(candidate.kind)) || candidate.status !== "needs-review" ||
          typeof source?.sha256 !== "string" || source.sha256 !== snapshot.sha256 || typeof candidate.teachingRevision !== "string" ||
          !Array.isArray(candidate.targetPageIds) ||
          (candidate.kind === "page-style-batch" ? candidate.targetPageIds.length < 2 || candidate.targetPageIds.length > 20 : candidate.targetPageIds.length !== 1) ||
          new Set(candidate.targetPageIds).size !== candidate.targetPageIds.length || candidate.targetPageIds.some(id => typeof id !== "string" || !teaching.project.pages.some(page => page.pageId === id)) || typeof candidate.outputSha256 !== "string" ||
          !/^[a-f0-9]{64}$/u.test(candidate.outputSha256) || !Number.isInteger(candidate.pageCount) ||
          candidate.pageCount !== teaching.project.pages.length || typeof candidate.stale !== "boolean" ||
          typeof candidate.lineageVerified !== "boolean" || candidate.applied !== false) throw new Error("Invalid or outdated PPTX candidate");
      await this.assertCurrent(snapshot, context, sessionId, host);
      this.assertCandidateOwner(sessionId);
      const view: CoursewarePptxCandidateReview = {
        reviewId: randomUUID(), candidateId: candidate.candidateId as string, projectId: candidate.projectId as string,
        kind: candidate.kind as CoursewarePptxCandidateReview["kind"], status: "needs-review", sourceSha256: snapshot.sha256,
        teachingRevision: candidate.teachingRevision, targetPageIds: [...candidate.targetPageIds] as string[],
        targetPages: candidate.targetPageIds.map(id => ({ pageId: id as string, pageNumber: teaching.project.pages.findIndex(page => page.pageId === id) + 1 })),
        outputSha256: candidate.outputSha256, pageCount: candidate.pageCount as number, stale: candidate.stale,
        lineageVerified: candidate.lineageVerified, applied: false, ...candidateEffects(teaching.project, candidate),
      };
      this.pptxCandidateReview = { view, snapshot, context, sessionId, host };
      return view;
    });
  }

  async previewPptxCandidate(reviewId: unknown): Promise<{ path: string; candidateId: string; sha256: string }> {
    const review = this.pptxCandidateReview;
    if (!review || typeof reviewId !== "string" || review.view.reviewId !== reviewId) throw new Error("PPTX candidate review expired");
    return this.withSaved(review.sessionId, async (host, _jobId, snapshot, context, sessionId) => {
      if (host !== review.host || snapshot.sha256 !== review.snapshot.sha256) throw new Error("PPTX candidate review changed");
      const result = await host.call<{ candidate: Record<string, unknown>; path: string }>("courseware.sourceCandidate.preview", {
        sessionId, projectId: review.view.projectId, candidateId: review.view.candidateId,
      });
      if (!result || typeof result.path !== "string" || result.candidate.outputSha256 !== review.view.outputSha256 ||
          result.candidate.status !== "needs-review" || result.candidate.stale !== false) throw new Error("PPTX candidate changed; review it again");
      await this.assertCurrent(snapshot, context, sessionId, host);
      this.assertCandidateOwner(sessionId);
      return { path: result.path, candidateId: review.view.candidateId, sha256: review.view.outputSha256 };
    });
  }

  async rejectPptxCandidate(reviewId: unknown): Promise<void> {
    const review = this.pptxCandidateReview;
    if (!review || typeof reviewId !== "string" || review.view.reviewId !== reviewId) throw new Error("PPTX candidate review expired");
    await this.withSaved(review.sessionId, async (host, _jobId, snapshot, context, sessionId) => {
      if (host !== review.host || snapshot.sha256 !== review.snapshot.sha256) throw new Error("PPTX candidate review changed");
      await this.assertCurrent(snapshot, context, sessionId, host);
      await host.call("courseware.sourceCandidate.reject", {
        sessionId, projectId: review.view.projectId, candidateId: review.view.candidateId,
      });
      this.assertCandidateOwner(sessionId);
    });
    if (this.pptxCandidateReview === review) this.pptxCandidateReview = null;
  }

  async preparePptxAdoption(reviewId: unknown, sourcePath: string, effectChoices: unknown = []) {
    const review = this.pptxCandidateReview;
    if (!review || review.view.reviewId !== reviewId || review.view.stale || !review.view.lineageVerified ||
        !["page-fade", "page-pptx", "page-style-batch"].includes(review.view.kind)) throw new Error("Review a current verified PPTX candidate before adoption");
    const effects = { effectTargets: review.view.effectTargets, effectPages: review.view.effectPages, effectCues: review.view.effectCues };
    const expected = new Set((review.view.effectTargets ?? []).map(target => JSON.stringify([target.pageId, target.objectId])));
    const pageIds = Array.from({ length: review.view.pageCount }, (_, index) => review.view.targetPages.find(page => page.pageNumber === index + 1)?.pageId ?? null);
    const effectBindings = validateEffectBindings(expected, review.view.effectPages, pageIds, effectChoices);
    this.assertCandidateOwner(review.sessionId);
    return this.withSaved(review.sessionId, async (host, jobId, snapshot, context, sessionId) => {
      if (host !== review.host || snapshot.sha256 !== review.snapshot.sha256 ||
          !samePptEditorBinding(snapshot, review.snapshot)) throw new Error("PPTX candidate review changed");
      await this.assertCurrent(snapshot, context, sessionId, host);
      this.assertCandidateOwner(sessionId);
      const candidate = await host.call<Record<string, unknown>>("courseware.sourceCandidate.get", {
        sessionId, projectId: review.view.projectId, candidateId: review.view.candidateId,
      });
      if (candidate.candidateId !== review.view.candidateId || candidate.kind !== review.view.kind || candidate.status !== "needs-review" ||
          candidate.stale !== false || candidate.lineageVerified !== true || candidate.applied !== false ||
          candidate.outputSha256 !== review.view.outputSha256 || candidate.teachingRevision !== review.view.teachingRevision ||
          JSON.stringify(candidate.targetPageIds) !== JSON.stringify(review.view.targetPageIds)) throw new Error("Reviewed PPTX scope or output changed");
      const { project } = await host.call<{ project: unknown }>("courseware.project.get", { sessionId, projectId: review.view.projectId });
      if (!isCoursewareProject(project) || project.teachingRevision !== review.view.teachingRevision ||
          JSON.stringify(candidateEffects(project, candidate)) !== JSON.stringify(effects)) throw new Error("Reviewed effect targets changed");
      await this.assertCurrent(snapshot, context, sessionId, host);
      this.assertCandidateOwner(sessionId);
      const result = await host.call<{ adoption: { adoptionId: string; projectId: string; candidateId: string;
        sourceSha256: string; outputSha256: string; sourcePath: string; status: string }; path: string }>("courseware.sourceAdoption.prepare", {
        sessionId, jobId, candidateId: review.view.candidateId, sourcePath, ...(effectBindings.length ? { effectBindings } : {}),
      });
      if (!result?.adoption || result.adoption.status !== "pending" || typeof result.path !== "string" ||
          !/^[\w.-]{1,128}$/u.test(result.adoption.adoptionId) || result.adoption.projectId !== review.view.projectId ||
          result.adoption.candidateId !== review.view.candidateId || result.adoption.sourceSha256 !== snapshot.sha256 ||
          result.adoption.outputSha256 !== review.view.outputSha256 || result.adoption.sourcePath !== sourcePath) throw new Error("Invalid source adoption intent");
      await this.assertCurrent(snapshot, context, sessionId, host);
      this.assertCandidateOwner(sessionId);
      return { ...result, snapshot, context, sessionId, host };
    });
  }

  async prepareReview(sessionId: unknown): Promise<CoursewareSourceReview> {
    return this.withSaved(sessionId, async (host, jobId, snapshot, context, sessionId) => {
      const result = await host.call<CoursewareSourceReview>("courseware.review.prepare", { sessionId, jobId });
      if (!isCoursewareProject(result.project) || result.targetSha256 !== snapshot.sha256 || !Number.isInteger(result.pageCount) || result.pageCount < 1 || result.pageCount > 100 || typeof result.reviewId !== "string" || !result.reviewId) throw new Error("Invalid source review");
      sourceEffectTargets(result);
      await this.assertCurrent(snapshot, context, sessionId, host);
      const publicView = { ...result, reviewId: randomUUID() };
      this.review = { publicView, hostReviewId: result.reviewId, snapshot, context, sessionId, host };
      return publicView;
    });
  }

  async adoptReview(payload: unknown): Promise<CoursewareTeachingView> {
    const review = this.review;
    if (!review || !payload || typeof payload !== "object" || Array.isArray(payload) ||
        Object.keys(payload).some(key => !["reviewId", "bindings", "effectBindings"].includes(key)) ||
        Reflect.get(payload, "reviewId") !== review.publicView.reviewId || !Object.hasOwn(payload, "bindings")) throw new Error("Review changed; review the saved source again");
    const bindings: unknown = Reflect.get(payload, "bindings");
    if (!Array.isArray(bindings) || bindings.length !== review.publicView.pageCount || !bindings.every((index) => index === null || (Number.isInteger(index) && index >= 0 && index < review.publicView.project.pages.length))) throw new Error("Invalid page associations");
    const ids = bindings.map((index) => index === null ? null : review.publicView.project.pages[index].pageId);
    const effectBindings = validateEffectBindings(sourceEffectTargets(review.publicView), review.publicView.targetPages, ids, Reflect.get(payload, "effectBindings") ?? []);
    await this.assertCurrent(review.snapshot, review.context, review.sessionId, review.host, false);
    if (this.review !== review) throw new Error("Review changed; review the saved source again");
    return this.withSaved(review.sessionId, async (host, jobId, snapshot, context, sessionId) => {
      await this.assertCurrent(review.snapshot, review.context, sessionId, host, false);
      const result = await host.call<{ project: unknown }>("courseware.review.adopt", { sessionId, jobId, reviewId: review.hostReviewId, bindings: ids,
        ...(effectBindings.length ? { effectBindings } : {}) });
      return this.setView(result.project, snapshot, context, sessionId, host);
    });
  }


  async reviewNarration(payload: unknown): Promise<CoursewareNarrationReview> {
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).length !== 2 ||
        !Object.hasOwn(payload, "sessionId") || !Object.hasOwn(payload, "candidateId") ||
        typeof Reflect.get(payload, "candidateId") !== "string" || !/^[\w.-]{1,128}$/u.test(Reflect.get(payload, "candidateId"))) throw new Error("Invalid narration review request");
    const sessionId = Reflect.get(payload, "sessionId");
    if (typeof sessionId !== "string") throw new Error("Invalid project session");
    this.assertCandidateOwner(sessionId);
    return this.withSaved(sessionId, async (host, jobId, snapshot, context, sessionId) => {
      const { project } = await host.call<{ project: unknown }>("courseware.project.openSaved", { sessionId, jobId });
      const teaching = await this.setView(project, snapshot, context, sessionId, host);
      const candidate = await host.call<unknown>("courseware.narrationCandidate.get", { sessionId, projectId: teaching.project.projectId, candidateId: Reflect.get(payload, "candidateId") });
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) ||
          Reflect.get(candidate, "candidateId") !== Reflect.get(payload, "candidateId") || Reflect.get(candidate, "kind") !== "page-narration" || Reflect.get(candidate, "audioReady") !== false) throw new Error("Invalid narration candidate");
      const write = Reflect.get(candidate, "write");
      const status = Reflect.get(candidate, "status");
      if (!isTeachingWrite(write) || write.actions.some((action) => !isCoursewareInteractionCheckpoint(action) &&
          !(action.type === "speech" && typeof action.text === "string" && Object.keys(action).every((key) => ["id", "type", "text", "pauseAfterMs"].includes(key)) &&
            (!Object.hasOwn(action, "pauseAfterMs") || (Number.isInteger(action.pauseAfterMs) && Number(action.pauseAfterMs) >= 0 && Number(action.pauseAfterMs) <= 30000)))) || write.projectId !== teaching.project.projectId || write.pageId !== teaching.pageId ||
          !["needs-review", "adopted", "rejected"].includes(status)) throw new Error("Candidate belongs to another page or has invalid data");
      await this.assertCurrent(snapshot, context, sessionId, host);
      this.assertCandidateOwner(sessionId);
      const view: CoursewareNarrationReview = { reviewId: randomUUID(), candidateId: Reflect.get(candidate, "candidateId"), status,
        teaching, actions: write.actions, stale: write.expectedSourceRevision !== teaching.project.source.revision ||
          write.expectedTeachingRevision !== teaching.project.teachingRevision || teaching.project.pages.some((page) => page.pageId === teaching.pageId && page.locked), audioReady: false };
      this.narrationReview = { view, pin: this.pin! };
      return view;
    });
  }

  async decideNarration(payload: unknown): Promise<CoursewareTeachingView> {
    const review = this.narrationReview;
    if (!review || !payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).length !== 2 ||
        Reflect.get(payload, "reviewId") !== review.view.reviewId || !["adopt", "reject"].includes(Reflect.get(payload, "decision"))) throw new Error("Narration review changed; open it again");
    const adopt = Reflect.get(payload, "decision") === "adopt";
    if (review.view.status !== "needs-review" || (adopt && review.view.stale)) throw new Error("Candidate is stale or already resolved; open it again");
    const { pin } = review;
    this.assertCandidateOwner(pin.sessionId);
    await this.assertCurrent(pin.snapshot, pin.context, pin.sessionId, pin.host);
    if (this.narrationReview !== review) throw new Error("Narration review changed; open it again");
    // Consume before dispatch: a lost reply must be resolved by reading persisted status.
    this.narrationReview = null;
    return this.withSaved(pin.sessionId, async (host, jobId, snapshot, context, sessionId) => {
      await this.assertCurrent(pin.snapshot, pin.context, sessionId, host);
      this.assertCandidateOwner(sessionId);
      if (adopt) {
        const { project } = await host.call<{ project: unknown }>("courseware.narrationCandidate.adopt", { sessionId, jobId, candidateId: review.view.candidateId });
        return this.setView(project, snapshot, context, sessionId, host);
      }
      await host.call("courseware.narrationCandidate.reject", { sessionId, projectId: pin.view.project.projectId, candidateId: review.view.candidateId });
      const { project } = await host.call<{ project: unknown }>("courseware.project.openSaved", { sessionId, jobId });
      return this.setView(project, snapshot, context, sessionId, host);
    });
  }

  private async setView(project: unknown, snapshot: Snapshot, context: PptEditorContext, sessionId: string, host: Host, viewId: string = randomUUID(), expectedPin?: Pin): Promise<CoursewareTeachingView> {
    if (!isCoursewareProject(project) || project.source.sha256 !== snapshot.sha256) throw new Error("Invalid teaching project");
    const page = project.pages[(context.page ?? 0) - 1];
    if (!page) throw new Error("Current page is missing from saved PPTX");
    const raw = await host.call("courseware.project.context", { sessionId, projectId: project.projectId });
    const warnings = raw && typeof raw === "object" ? Reflect.get(raw, "saveWarnings") : undefined;
    if (warnings !== undefined && (!Array.isArray(warnings) || warnings.length > 200 || !warnings.every(value => typeof value === "string" && value.length <= 1000)))
      throw new Error("Invalid saved teaching warnings");
    const teachingObjects = objectsForTeaching(raw, project, page.pageId);
    const sourceChange = sourceChangeForTeaching(raw, project);
    const chatChanges = chatChangesForTeaching(raw);
    await this.assertCurrent(snapshot, context, sessionId, host);
    if (expectedPin && (this.pin !== expectedPin || this.opening)) throw new Error("Teaching view changed; reload current page");
    const view = { viewId, project, pageId: page.pageId, pageNumber: context.page!,
      ...(warnings?.length ? { saveWarnings: warnings as string[] } : {}),
      ...(teachingObjects ? { teachingObjects } : {}), ...(sourceChange ? { sourceChange } : {}), ...(chatChanges ? { chatChanges } : {}) };
    this.pin = { view, snapshot, context, sessionId, host };
    this.draftPins.set(view.viewId, this.pin);
    if (this.draftPins.size > 100) this.draftPins.delete(this.draftPins.keys().next().value!);
    return view;
  }

  async withSaved<T>(sessionId: unknown, operation: (host: Host, jobId: string, snapshot: Snapshot, context: PptEditorContext, sessionId: string, parseOutput: (path: string, sha256: string) => Promise<string>) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (typeof sessionId !== "string" || !sessionId || sessionId.length > 128 || this.getViewingSessionId() !== sessionId) throw new Error("Invalid or inactive project session");
    if (this.opening) throw new Error("Teaching is already opening");
    this.opening = true;
    this.savedRead = null;
    this.pin = null;
    this.review = null;
    this.narrationReview = null;
    let jobId: string | undefined;
    let terminal = false;
    const host = this.getHost();
    const release = async () => {
      if (!host || !jobId) return;
      if (!terminal) {
        await host.call("courseware.parseCancel", { jobId });
        while ((await host.call<{ status: string }>("courseware.parseStatus", { jobId })).status === "RUNNING") await delay(100);
      }
      await host.call("courseware.parseRelease", { jobId });
      jobId = undefined;
      terminal = false;
    };
    try {
      signal?.throwIfAborted();
      if (!host) throw new Error("Host is unavailable");
      const workspace = await this.getWorkspace();
      await this.editor.verifyTeachingSource(workspace);
      const snapshot = this.editor.teachingSnapshot(workspace);
      const context = await this.editor.getContext(workspace);
      if (!samePptEditorBinding(snapshot, context) || !context.page || context.readOnly) throw new Error("No editable current slide");
      // Keep one ownership lock across original release and candidate parsing.
      const parse = async (path: string, sha256: string): Promise<string> => {
        await release();
        signal?.throwIfAborted();
        await this.assertCurrent(snapshot, context, sessionId, host);
        const job = await host.call<{ jobId: string }>("courseware.parseStart", { sessionId, path });
        jobId = job.jobId;
        while (true) {
          signal?.throwIfAborted();
          const status = await host.call<{ status: string; message?: string; summary?: { sourceSha256: string } }>("courseware.parseStatus", { jobId });
          if (status.status === "RUNNING") { await delay(100, undefined, { signal }); continue; }
          terminal = true;
          if (status.status !== "SUCCEEDED") throw new Error(status.message || "PPTX parsing failed");
          if (status.summary?.sourceSha256 !== sha256) throw new Error("Parsed source differs from expected PPTX");
          break;
        }
        await this.assertCurrent(snapshot, context, sessionId, host);
        return jobId;
      };
      const originalJob = await parse(snapshot.path, snapshot.sha256);
      const attached = await host.call<{ attached: boolean }>("courseware.project.attach", {
        sessionId, jobId: originalJob, sourcePath: snapshot.sourcePath,
      });
      signal?.throwIfAborted();
      if (!attached || typeof attached.attached !== "boolean" || Object.keys(attached).length !== 1)
        throw new Error("Invalid saved project attachment");
      await this.assertCurrent(snapshot, context, sessionId, host);
      return await operation(host, originalJob, snapshot, context, sessionId, parse);
    } finally {
      try {
        await release();
      } catch (error) {
        this.pin = null;
        this.review = null;
        this.narrationReview = null;
        throw new Error(`Teaching parser cleanup failed: ${String(error)}`);
      } finally { this.opening = false; }
    }
  }

  async assetLockContext(payload: { viewId: unknown; expectedTeachingRevision: unknown }) {
    const context = await this.ttsContext(payload);
    const pin = this.pin;
    if (!pin || pin.view.viewId !== payload.viewId) throw new Error("Teaching view changed; reload current page");
    return { ...context, sourcePath: pin.snapshot.path };
  }

  async musicAdoptionContext(payload: { viewId: unknown; expectedTeachingRevision: unknown }) {
    return this.mediaContext(payload, this.assertMediaOwner);
  }

  async reuseVideo(input: { viewId: string; expectedTeachingRevision: string; principalKey: string; intentId: string; actionId: string; assetId: string }) {
    const context = await this.ttsContext(input), pin = this.pin;
    if (!pin || pin.view.viewId !== input.viewId) throw new Error("Teaching view changed; reload current page");
    const result = await pin.host.call<{ project: unknown }>("courseware.video.reuse", {
      sessionId: pin.sessionId, projectId: pin.view.project.projectId, principalKey: input.principalKey,
      intentId: input.intentId, pageId: pin.view.pageId, actionId: input.actionId,
      expectedSourceRevision: pin.view.project.source.revision, expectedTeachingRevision: pin.view.project.teachingRevision,
    });
    await context.assertCurrent();
    if (!isCoursewareProject(result.project) || result.project.projectId !== pin.view.project.projectId ||
        result.project.source.sha256 !== pin.snapshot.sha256 || !result.project.pages.find(p => p.pageId === pin.view.pageId)?.actions.some(a =>
          a.type === "video_clip" && a.id === input.actionId && a.videoAssetId === input.assetId))
      throw new Error("COURSEWARE_VIDEO_INVALID_ADOPTION");
    return this.setView(result.project, pin.snapshot, pin.context, pin.sessionId, pin.host, pin.view.viewId, pin);
  }

  async ttsContext(payload: { viewId: unknown; expectedTeachingRevision: unknown }) {
    return this.mediaContext(payload, this.assertCandidateOwner);
  }

  private async mediaContext(payload: { viewId: unknown; expectedTeachingRevision: unknown }, assertOwner: (sessionId: string) => void) {
    const pin = this.pin;
    if (!pin || this.opening || payload.viewId !== pin.view.viewId || payload.expectedTeachingRevision !== pin.view.project.teachingRevision) throw new Error("Teaching view changed; reload current page");
    const assertCurrent = async () => {
      assertOwner(pin.sessionId);
      await this.assertCurrent(pin.snapshot, pin.context, pin.sessionId, pin.host);
      assertOwner(pin.sessionId);
      if (this.pin !== pin || this.opening) throw new Error("Teaching view changed; reload current page");
    };
    await assertCurrent();
    return { host: pin.host, sessionId: pin.sessionId, projectId: pin.view.project.projectId,
      pageId: pin.view.pageId, expectedSourceRevision: pin.view.project.source.revision,
      expectedTeachingRevision: pin.view.project.teachingRevision, assertCurrent,
      project: pin.view.project,
      adoptMusic: async (input: { principalKey: string; intentId: string; assetId: string; durationMs: number }) => {
        await assertCurrent();
        const page = pin.view.project.pages.find((entry) => entry.pageId === pin.view.pageId);
        if (!page || page.locked) throw new Error("COURSEWARE_CANVAS_MUSIC_PAGE_LOCKED");
        const result = await pin.host.call<{ project: unknown; adoption: { pageId: string; actionId: string; assetId: string } }>(
          "courseware.mediaCanvas.music.adopt", {
            sessionId: pin.sessionId, projectId: pin.view.project.projectId, pageId: pin.view.pageId,
            principalKey: input.principalKey, intentId: input.intentId, durationMs: input.durationMs,
            expectedSourceRevision: pin.view.project.source.revision, expectedTeachingRevision: pin.view.project.teachingRevision,
          });
        await assertCurrent();
        if (!isCoursewareProject(result.project) || result.project.projectId !== pin.view.project.projectId ||
            result.project.source.sha256 !== pin.snapshot.sha256 || result.adoption?.pageId !== pin.view.pageId ||
            result.adoption?.assetId !== input.assetId ||
            !result.project.pages.find((entry) => entry.pageId === pin.view.pageId)?.actions.some((entry) =>
              entry.id === result.adoption.actionId && entry.type === "audio_clip" && entry.audioAssetId === input.assetId))
          throw new Error("COURSEWARE_CANVAS_MUSIC_INVALID_ADOPTION");
        return this.setView(result.project, pin.snapshot, pin.context, pin.sessionId, pin.host, pin.view.viewId, pin);
      },
      adoptAudio: async (input: { principalKey: string; intentId: string; actionId: string; assetId: string }) => {
        await assertCurrent();
        const page = pin.view.project.pages.find((entry) => entry.pageId === pin.view.pageId);
        const action = page?.actions.find((entry) => entry.id === input.actionId);
        if (!page || page.locked || !action || action.type !== "speech" ||
            (action.audioAssetId !== undefined && typeof action.audioAssetId !== "string") ||
            ["audioId", "audioUrl", "audioData"].some((field) => Object.hasOwn(action, field)))
          throw new Error("COURSEWARE_TTS_SPEECH_CHANGED");
        const result = await pin.host.call<{ project: unknown }>("courseware.tts.audio.adopt", {
          sessionId: pin.sessionId, projectId: pin.view.project.projectId, principalKey: input.principalKey,
          intentId: input.intentId, expectedTeachingRevision: pin.view.project.teachingRevision,
          expectedAudioAssetId: action.audioAssetId ?? null,
        });
        await assertCurrent();
        if (!isCoursewareProject(result.project) || result.project.projectId !== pin.view.project.projectId ||
            result.project.source.sha256 !== pin.snapshot.sha256 ||
            !result.project.pages.find((entry) => entry.pageId === pin.view.pageId)?.actions.some((entry) =>
              entry.id === input.actionId && entry.type === "speech" && entry.audioAssetId === input.assetId))
          throw new Error("COURSEWARE_TTS_INVALID_ADOPTION");
        if (this.pin !== pin) throw new Error("Teaching view changed; reload current page");
        return this.setView(result.project, pin.snapshot, pin.context, pin.sessionId, pin.host, pin.view.viewId, pin);
      },
    };
  }

  async history(payload: unknown): Promise<CoursewareTeachingHistory> {
    const pin = this.pin;
    if (!pin || !payload || typeof payload !== "object" || Array.isArray(payload) ||
        Object.keys(payload).length !== 1 || Reflect.get(payload, "viewId") !== pin.view.viewId)
      throw new Error("Open current-page teaching first");
    this.assertCandidateOwner(pin.sessionId);
    await this.assertCurrent(pin.snapshot, pin.context, pin.sessionId, pin.host);
    if (this.pin !== pin || this.opening) throw new Error("Teaching view changed; reload current page");
    return this.withSaved(pin.sessionId, async (host, jobId, snapshot, context, sessionId) => {
      if (host !== pin.host || snapshot.sha256 !== pin.snapshot.sha256 || snapshot.revision !== pin.snapshot.revision ||
          !samePptEditorBinding(snapshot, pin.snapshot) || context.page !== pin.context.page || context.editGeneration !== pin.context.editGeneration)
        throw new Error("Teaching view changed; reload current page");
      const current = await host.call<{ project: unknown }>("courseware.project.get", { sessionId, projectId: pin.view.project.projectId });
      if (!isCoursewareProject(current.project) || JSON.stringify(current.project) !== JSON.stringify(pin.view.project))
        throw new Error("Teaching changed; reload current page");
      const result: unknown = await host.call("courseware.teachingHistory.list", { sessionId, jobId });
      await this.assertCurrent(snapshot, context, sessionId, host);
      this.assertCandidateOwner(sessionId);
      if (!isCoursewareTeachingHistory(result) || result.entries.some(entry => pin.view.project.pages.some(page => page.pageId === entry.pageId)))
        throw new Error("Invalid deleted-page teaching history");
      const after = await host.call<{ project: unknown }>("courseware.project.get", { sessionId, projectId: pin.view.project.projectId });
      await this.assertCurrent(snapshot, context, sessionId, host);
      this.assertCandidateOwner(sessionId);
      if (JSON.stringify(after.project) !== JSON.stringify(pin.view.project)) throw new Error("Teaching changed during history read");
      this.pin = pin;
      return structuredClone(result);
    });
  }

  async draft(payload: unknown, changing: boolean): Promise<{ draft: CoursewareTeachingDraft | null }> {
    const pin = payload && typeof payload === "object" ? this.draftPins.get(Reflect.get(payload, "viewId")) : undefined;
    if (!pin || !payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Open current-page teaching first");
    const keys = changing ? ["viewId", "expectedRevision", "draft"] : ["viewId"];
    if (Object.keys(payload).length !== keys.length || keys.some(key => !Object.hasOwn(payload, key)) ||
        Reflect.get(payload, "viewId") !== pin.view.viewId || this.getHost() !== pin.host ||
        this.getViewingSessionId() !== pin.sessionId) throw new Error("Teaching draft owner changed; reload current page");
    this.assertCandidateOwner(pin.sessionId);
    const identity = { sessionId: pin.sessionId, projectId: pin.view.project.projectId, pageId: pin.view.pageId };
    const read = async (method: string, params: unknown) => {
      const result = await pin.host.call<{ draft: unknown }>(method, params);
      if (this.getViewingSessionId() !== pin.sessionId || this.getHost() !== pin.host) throw new Error("Teaching draft owner changed during storage");
      this.assertCandidateOwner(pin.sessionId);
      if (result.draft !== null && (!isCoursewareTeachingDraft(result.draft) || result.draft.pageId !== identity.pageId ||
          result.draft.baseline.projectId !== identity.projectId)) throw new Error("Invalid stored teaching draft");
      return { draft: result.draft };
    };
    if (!changing) return read("courseware.teachingDraft.get", identity);
    const expectedRevision = Reflect.get(payload, "expectedRevision");
    const draft = Reflect.get(payload, "draft");
    if (expectedRevision !== null && (typeof expectedRevision !== "string" || expectedRevision.length > 128)) throw new Error("Invalid draft revision");
    if (draft !== null && (!draft || typeof draft !== "object" || Array.isArray(draft) ||
        Object.keys(draft).length !== 2 || !Object.hasOwn(draft, "actions") || typeof draft.instruction !== "string" ||
        draft.instruction.length > 4000 || !isTeachingWrite({ projectId: identity.projectId, pageId: identity.pageId,
          expectedSourceRevision: pin.view.project.source.revision, expectedTeachingRevision: pin.view.project.teachingRevision, actions: draft.actions }) ||
        Buffer.byteLength(JSON.stringify(draft), "utf8") > 2 * 1024 * 1024)) throw new Error("Invalid teaching draft");
    return read("courseware.teachingDraft.set", { ...identity, expectedRevision,
      draft: draft === null ? null : { baseline: pin.view.project, actions: draft.actions, instruction: draft.instruction } });
  }

  private async validateEffectChanges(pin: Pin, actions: Array<Record<string, unknown>>): Promise<void> {
    const page = pin.view.project.pages.find(entry => entry.pageId === pin.view.pageId)!;
    const changed = actions.filter(action => {
      const old = page.actions.find(entry => entry.id === action.id);
      return action.type === "speech" && JSON.stringify(action.visualCues) !== JSON.stringify(old?.visualCues) &&
        !(action.visualCues === undefined && (action.text !== old?.text || action.audioAssetId !== old?.audioAssetId));
    });
    if (!changed.length) return;
    if (page.locked || page.reviewState !== "ready")
      throw new Error("Effect authoring requires an unlocked, explicitly confirmed saved page");
    const raw = await pin.host.call("courseware.project.context", { sessionId: pin.sessionId, projectId: pin.view.project.projectId });
    const objects = objectsForTeaching(raw, pin.view.project, pin.view.pageId) ?? [];
    for (const action of changed) {
      const old = page.actions.find(entry => entry.id === action.id && entry.type === "speech");
      if (!old || typeof old.audioAssetId !== "string" || !old.audioAssetId || action.audioAssetId !== old.audioAssetId ||
          action.text !== old.text || typeof action.text !== "string" || !action.text.trim())
        throw new Error("Effect authoring requires unchanged narration and its existing fixed audio");
      const cues = action.visualCues === undefined ? [] : action.visualCues;
      const previous = old.visualCues === undefined ? [] : old.visualCues;
      if (!Array.isArray(cues) || cues.length > 200 || !Array.isArray(previous) ||
          new Set(cues.map(cue => cue?.id)).size !== cues.length)
        throw new Error("Invalid effect cue list");
      for (const cue of previous) {
        if (!isCoursewareAttentionCue(cue) && !cues.some(next => JSON.stringify(next) === JSON.stringify(cue)))
          throw new Error("Unsupported existing effect must be preserved");
      }
      for (const cue of cues) {
        if (previous.some(saved => JSON.stringify(saved) === JSON.stringify(cue))) continue;
        if (!isCoursewareAttentionCue(cue)) throw new Error("Invalid or unsupported effect cue");
        const targets = cue.effect.type === "highlight" ? cue.effect.elementIds : [cue.effect.elementId, ...(cue.effect.elementIds ?? [])];
        if (targets.some(id => !objects.some(object => object.objectId === id && object.status === "mapped" && object.effectTargetEligible === true)))
          throw new Error("Effect target is stale, unsupported or not mapped to this saved page");
      }
    }
    await this.assertCurrent(pin.snapshot, pin.context, pin.sessionId, pin.host);
    if (this.pin !== pin) throw new Error("Teaching view changed; reload current page");
  }

  async update(payload: unknown, lock: boolean | "confirm"): Promise<CoursewareTeachingView> {
    const pin = this.pin;
    if (!pin || !payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Open current-page teaching first");
    const resolution = structuredClone(Reflect.get(payload, "resolution"));
    const keys = lock === "confirm" ? ["viewId", "expectedTeachingRevision", ...(resolution === undefined ? [] : ["resolution"])] : lock ? ["viewId", "expectedTeachingRevision", "locked"] : ["viewId", "expectedTeachingRevision", "actions"];
    if (Object.keys(payload).length !== keys.length || keys.some((key) => !Object.hasOwn(payload, key)) ||
        Reflect.get(payload, "viewId") !== pin.view.viewId || this.getHost() !== pin.host) throw new Error("Teaching view changed; reload current page");
    if (resolution !== undefined) {
      if (!resolution || typeof resolution !== "object" || Array.isArray(resolution) || Object.keys(resolution).length !== 3 ||
          typeof resolution.changeGroupId !== "string" || typeof resolution.receiptSha256 !== "string" ||
          typeof resolution.note !== "string" || !resolution.note.trim() || resolution.note.length > 500)
        throw new Error("Invalid reviewed Chat resolution");
      const change = pin.view.chatChanges?.find(change => change.changeGroupId === resolution.changeGroupId);
      if (!change?.plan || !change.receiptSha256 || change.receiptSha256 !== resolution.receiptSha256 || change.resolution ||
          (change.plan.pageId !== pin.view.pageId && pin.view.project.pages.some(page => page.pageId === change.plan!.pageId)))
        throw new Error("Chat request or target changed; reload before reviewing");
    }
    const write = {
      projectId: pin.view.project.projectId, pageId: pin.view.pageId,
      expectedSourceRevision: pin.view.project.source.revision,
      expectedTeachingRevision: Reflect.get(payload, "expectedTeachingRevision"),
      actions: lock ? [] : Reflect.get(payload, "actions"),
    };
    if (!isTeachingWrite(write) || (lock === true && typeof Reflect.get(payload, "locked") !== "boolean")) throw new Error("Invalid teaching update");
    await this.assertCurrent(pin.snapshot, pin.context, pin.sessionId, pin.host);
    if (this.pin !== pin) throw new Error("Teaching view changed; reload current page");
    if (lock === false) await this.validateEffectChanges(pin, write.actions);
    const { actions: _actions, ...identity } = write;
    const result = await pin.host.call<{ project: unknown }>(lock === "confirm" ? "courseware.teaching.confirm" : lock ? "courseware.teaching.setLock" : "courseware.teaching.write", lock === "confirm" ?
      { sessionId: pin.sessionId, ...identity, ...(resolution === undefined ? {} : { resolution: structuredClone(resolution) }) } : lock ?
      { sessionId: pin.sessionId, ...identity, locked: Reflect.get(payload, "locked") } : { sessionId: pin.sessionId, write });
    if (!isCoursewareProject(result.project) || result.project.projectId !== write.projectId ||
        result.project.source.sha256 !== pin.snapshot.sha256) throw new Error("Invalid teaching write result");
    if (this.pin !== pin) throw new Error("Teaching view changed; reload current page");
    return this.setView(result.project, pin.snapshot, pin.context, pin.sessionId, pin.host, pin.view.viewId, pin);
  }

  async assertCurrent(snapshot: Snapshot, context: PptEditorContext, sessionId: string, host: Host, checkPage: boolean | "saved-page" = true): Promise<void> {
    const workspace = await this.getWorkspace();
    const current = this.editor.teachingSnapshot(workspace);
    await this.editor.verifyTeachingSource(await this.getWorkspace());
    const next = await this.editor.getContext(workspace);
    const final = this.editor.teachingSnapshot(await this.getWorkspace());
    if (this.getViewingSessionId() !== sessionId || this.getHost() !== host || !samePptEditorBinding(snapshot, current) || !samePptEditorBinding(snapshot, next) || !samePptEditorBinding(snapshot, final) ||
        current.sha256 !== snapshot.sha256 || final.sha256 !== snapshot.sha256 || current.sourcePath !== snapshot.sourcePath || final.sourcePath !== snapshot.sourcePath || current.revision !== snapshot.revision ||
        final.revision !== snapshot.revision || next.readOnly || (checkPage && next.page !== context.page) ||
        (checkPage === true && next.editGeneration !== context.editGeneration)) {
      throw new Error("PPTX or current page changed; reload teaching");
    }
  }
}
