import { sceneTeachingForPage } from "./courseware-scene-object-view";
import { parseSceneCoursePlan } from "./courseware-scene-plan";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { generateSavedNarrationBatch, type NarrationPageCache } from "./courseware-narration-batch";
import type { CoursewareSceneCompleteInput } from "./courseware-scene-context";
import { objectsForTeaching } from "./courseware-scene-object-view";
import type { NarrationEvidence } from "./courseware-narration-visuals";
import { inspectCoursewareTeaching, isCoursewareProject, isTeachingWrite, type CoursewareProject, type CoursewareNarrationReview } from "@pi-desktop/shared";
import { adoptionRevision, readLiveSource, sourceHash } from "./courseware-source-files";
import { jobIdFor } from "./ppt-editor-files";
import type { NarrationComplete, CandidateModelResolver } from "./courseware-candidates";

type Host = { call<T>(method: string, params: unknown): Promise<T> };
type Task = { task?: { importPath?: string; generatedPath?: string } };
export type SavedCourseware = { host: Host; jobId: string; project: CoursewareProject; bytes: Uint8Array; check(): Promise<void> };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const savedId = (v: unknown): v is string => typeof v === "string" && /^saved-[\w.-]{1,120}$/u.test(v);

export const hasDetailedNarration = (page: CoursewareProject["pages"][number]) => {
  const speeches = page.actions.filter(a => a.type === "speech");
  return speeches.length > 0 && speeches.every(a => typeof a.text === "string" && !!a.text.trim() &&
    (a.source === "generated" || typeof a.id === "string" && !/^narration-\d+$/u.test(a.id)));
};

/** Saved file and logical page identity own narration; Office visibility and selection do not. */
export class CoursewareSavedNarration {
  private opening = false;
  private pageEvidenceCache: NarrationPageCache = new Map();
  private reviews = new Map<string, { sessionId: string; view: CoursewareNarrationReview }>();
  constructor(private getHost: () => Host | null, private getSession: () => string | null,
    private complete: NarrationComplete, private resolveModel?: CandidateModelResolver,
    private completeVision?: (input: CoursewareSceneCompleteInput) => Promise<{ text: string }>) {}

  // Agent work pins its own turn; UI reviews without a turn guard require the visible Chat.
  async withSaved<T>(sessionId: string, canDispatch: (() => boolean) | undefined, operation: (saved: SavedCourseware) => Promise<T>): Promise<T> {
    const host = this.getHost();
    const assert = () => {
      if (!host || this.getHost() !== host) throw new Error("Courseware runtime changed; read saved workflow before continuing");
      if (!canDispatch && this.getSession() !== sessionId)
        throw new Error("Courseware conversation changed; return to this Chat and read saved workflow");
      if (canDispatch && !canDispatch()) throw new Error("Courseware Chat turn ended or was cancelled; read saved workflow in a new turn");
    };
    assert();
    if (!host || !/^[\w-]{1,128}$/u.test(sessionId)) throw new Error("Invalid courseware session");
    if (this.opening) throw new Error("Saved courseware is already being read");
    this.opening = true;
    let jobId: string | undefined, terminal = false;
    try {
      const { session } = await host.call<{ session?: { projectPath?: string; mode?: string } }>("session.get", { id: sessionId, messageLimit: 1 });
      const { task } = await host.call<Task>("courseware.task.get", { sessionId });
      assert();
      const workspace = session?.projectPath, path = task?.importPath ?? task?.generatedPath;
      if (!workspace || session?.mode !== "agent" || !path) throw new Error("Import or generate a PPTX in this Chat first");
      const bytes = await readLiveSource(workspace, path);
      const sha256 = sourceHash(bytes);
      const revision = await adoptionRevision(workspace, path, bytes);
      if (revision.sha256 !== sha256) throw new Error("Saved PPTX changed while reading");
      const check = async () => {
        assert();
        const current = await host.call<{ session?: { projectPath?: string; mode?: string } }>("session.get", { id: sessionId, messageLimit: 1 });
        const latest = await host.call<Task>("courseware.task.get", { sessionId });
        if (current.session?.projectPath !== workspace || current.session.mode !== "agent" ||
            (latest.task?.importPath ?? latest.task?.generatedPath) !== path || sourceHash(await readLiveSource(workspace, path)) !== sha256)
          throw new Error("Saved courseware source changed; read the deck again");
        assert();
      };
      await check();
      jobId = (await host.call<{ jobId: string }>("courseware.parseStart", { sessionId, path: revision.documentPath })).jobId;
      const deadline = Date.now() + 90_000;
      while (true) {
        assert();
        const status = await host.call<{ status: string; message?: string; summary?: { sourceSha256: string } }>("courseware.parseStatus", { jobId });
        if (status.status === "RUNNING") {
          if (Date.now() > deadline) throw new Error("Saved courseware parsing timed out");
          await delay(100); continue;
        }
        terminal = true;
        if (status.status !== "SUCCEEDED" || status.summary?.sourceSha256 !== sha256)
          throw new Error(status.message || "Saved PPTX parsing failed or source changed");
        break;
      }
      const { project } = await host.call<{ project: unknown }>("courseware.project.openSaved", { sessionId, jobId });
      if (!isCoursewareProject(project) || project.source.sha256 !== sha256 || project.projectId !== `office-${jobIdFor(workspace, path)}`)
        throw new Error("Invalid saved courseware project");
      await check();
      return await operation({ host, jobId, project, bytes, check });
    } finally {
      try {
        if (jobId) {
          if (!terminal) {
            await host.call("courseware.parseCancel", { jobId });
            while ((await host.call<{ status: string }>("courseware.parseStatus", { jobId })).status === "RUNNING") await delay(100);
          }
          await host.call("courseware.parseRelease", { jobId });
        }
      } finally { this.opening = false; }
    }
  }

  async execute(sessionId: string, name: string, args: unknown, canDispatch: () => boolean): Promise<unknown> {
    if (!record(args) || !["courseware_narration_context", "courseware_narration_propose"].includes(name)) throw new Error("Invalid saved narration request");
    const input = structuredClone(args), propose = name === "courseware_narration_propose";
    if (Object.keys(input).some(k => !(propose ? ["pageNumbers", "sourceSha256", "instruction", "repairRequiredTeaching"] : ["pageNumbers"]).includes(k)) ||
        (propose && (typeof input.instruction !== "string" || !input.instruction.trim() || input.instruction.length > 8000 || typeof input.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(input.sourceSha256))))
      throw new Error("Invalid saved narration arguments");
    if (input.repairRequiredTeaching !== undefined && typeof input.repairRequiredTeaching !== "boolean") throw new Error("Invalid teaching repair mode");
    return this.withSaved(sessionId, canDispatch, async ({ host, jobId, project, bytes, check }) => {
      const numbers = input.pageNumbers;
      if ((propose || numbers !== undefined) && (!Array.isArray(numbers) || !numbers.length || numbers.length > 100 ||
          new Set(numbers).size !== numbers.length || numbers.some(n => !Number.isInteger(n) || n < 1 || n > project.pages.length)))
        throw new Error("Invalid saved page numbers");
      if (propose && project.source.sha256 !== input.sourceSha256) throw new Error("Saved source changed; read narration context again");
      const selected: number[] = Array.isArray(numbers) ? numbers : project.pages.map((_, i) => i + 1);
      const approval = project.taskType === "scene" ? await host.call<{ approval: { plan: unknown } | null }>("courseware.scenePlan.get", { sessionId }) : null;
      const approvedPlan = approval?.approval ? parseSceneCoursePlan(JSON.stringify(approval.approval.plan)) : undefined;
      await check();
      if (!propose) {
        const raw = project.taskType === "scene" ? await host.call("courseware.project.context", { sessionId, projectId: project.projectId }) : undefined;
        const teachingByPage = new Map(project.pages.flatMap(page => {
          const teaching = sceneTeachingForPage(raw, project, page.pageId);
          return teaching ? [[page.pageId, teaching] as const] : [];
        }));
        const pages = [];
        for (const pageNumber of selected) {
          const page = project.pages[pageNumber - 1];
          let text: string | undefined, notes: string | undefined, hasImages: boolean | undefined, diagnostic: string | undefined;
          if (numbers) try {
            const evidence = await host.call<NarrationEvidence>("courseware.pageEvidence", { sessionId, jobId, pageNumber });
            text = evidence.text; notes = evidence.notes; hasImages = evidence.elements.some(element => element.kind === "image");
          }
          catch (error) { diagnostic = String(error); }
          const speeches = page.actions.filter(a => a.type === "speech").map(a => ({ actionId: a.id, text: a.text,
            audioReady: typeof a.audioAssetId === "string", ...(a.audioAssetId ? { audioAssetId: a.audioAssetId } : {}) }));
          const narrationReady = hasDetailedNarration(page);
          pages.push({ pageNumber, pageId: page.pageId, locked: page.locked, hasNarration: speeches.length > 0,
            narrationReady, audioReady: speeches.length > 0 && speeches.every(a => a.audioReady),
            teachingReady: speeches.length > 0 && speeches.every(a => a.audioReady) &&
              !page.actions.some(a => a.attention !== undefined || ["video_slot", "music_slot"].includes(String(a.type))),
            actions: page.actions, speeches,
            ...(text === undefined ? {} : { text, notes, hasImages }), ...(diagnostic ? { diagnostic } : {}) });
        }
        await check();
        return { projectId: project.projectId, sourceRevision: project.source.revision,
          teachingRevision: project.teachingRevision, sourceSha256: project.source.sha256,
          educationContext: project.educationContext, pageCount: project.pages.length, pages,
          quality: inspectCoursewareTeaching(project, teachingByPage),
          ...(record(raw) && record(raw.completion) ? { completion: raw.completion } : {}),
          ...(approvedPlan ? { approvedPlan } : {}),
          narrationReady: pages.every(page => page.narrationReady), audioReady: pages.every(page => page.audioReady), teachingReady: pages.every(page => page.teachingReady) };
      }
      const detail = await host.call<{ session?: { providerId?: string; modelId?: string; thinkingLevel?: string; mode?: string } }>("session.get", { id: sessionId, messageLimit: 1 });
      const session = detail.session;
      if (!session || session.mode !== "agent" || !this.resolveModel && (!session.providerId || !session.modelId))
        throw new Error("Select an Agent model first");
      const model = this.resolveModel ? await this.resolveModel(sessionId) : { modelKey: `${session.providerId}/${session.modelId}`, thinkingLevel: session.thinkingLevel };
      const current = async (expected = project) => {
        await check();
        const latest = await host.call<{ project: unknown }>("courseware.project.get", { sessionId, projectId: project.projectId });
        const next = await host.call<typeof detail>("session.get", { id: sessionId, messageLimit: 1 });
        const effective = this.resolveModel ? await this.resolveModel(sessionId) : model;
        if (JSON.stringify(latest.project) !== JSON.stringify(expected) || !next.session ||
            ["providerId", "modelId", "thinkingLevel", "mode"].some(k => Reflect.get(next.session!, k) !== Reflect.get(session, k)) ||
            effective.modelKey !== model.modelKey || effective.thinkingLevel !== model.thinkingLevel) throw new Error("Teaching or Chat model changed during generation");
        await check();
      };
      return generateSavedNarrationBatch({ host, sessionId, jobId, project, bytes, selected, approvedPlan,
        instruction: input.instruction as string, repairRequiredTeaching: input.repairRequiredTeaching === true, model, complete: this.complete, completeVision: this.completeVision,
        current, cache: this.pageEvidenceCache, canDispatch });
    });
  }

  ownsReview(payload: unknown, decide: boolean): boolean {
    return record(payload) && savedId(payload[decide ? "reviewId" : "candidateId"]);
  }
  ownsView(payload: unknown): boolean { return record(payload) && savedId(payload.viewId); }

  async review(payload: unknown): Promise<CoursewareNarrationReview> {
    if (!record(payload) || Object.keys(payload).sort().join(",") !== "candidateId,sessionId" || typeof payload.sessionId !== "string" || !savedId(payload.candidateId)) throw new Error("Invalid saved narration review");
    const { sessionId, candidateId } = payload;
    return this.withSaved(sessionId, undefined, async ({ host, project, check }) => {
      const candidate = await host.call<unknown>("courseware.narrationCandidate.get", { sessionId, projectId: project.projectId, candidateId });
      if (!record(candidate) || candidate.candidateId !== candidateId || !isTeachingWrite(candidate.write) || candidate.write.projectId !== project.projectId ||
          !["needs-review", "adopted", "rejected"].includes(String(candidate.status)) || candidate.audioReady !== false) throw new Error("Invalid saved narration candidate");
      const write = candidate.write;
      const pageNumber = project.pages.findIndex(p => p.pageId === write.pageId) + 1;
      if (!pageNumber) throw new Error("Candidate page is missing");
      const context = await host.call("courseware.project.context", { sessionId, projectId: project.projectId });
      const teaching = { viewId: `saved-${randomUUID()}`, project, pageId: candidate.write.pageId, pageNumber,
        teachingObjects: objectsForTeaching(context, project, candidate.write.pageId) };
      const view: CoursewareNarrationReview = { reviewId: `saved-${randomUUID()}`, candidateId, teaching, actions: candidate.write.actions,
        status: candidate.status as CoursewareNarrationReview["status"], stale: candidate.stale !== false, audioReady: false };
      await check();
      this.reviews.set(view.reviewId, { sessionId, view });
      if (this.reviews.size > 100) this.reviews.delete(this.reviews.keys().next().value!);
      return structuredClone(view);
    });
  }

  async draft(payload: unknown) {
    if (!record(payload) || Object.keys(payload).join(",") !== "viewId" || !savedId(payload.viewId)) throw new Error("Invalid saved narration view");
    const review = [...this.reviews.values()].find(r => r.view.teaching.viewId === payload.viewId);
    if (!review || this.getSession() !== review.sessionId) throw new Error("Narration review changed");
    const host = this.getHost();
    if (!host) throw new Error("Host is unavailable");
    return host.call("courseware.teachingDraft.get", { sessionId: review.sessionId, projectId: review.view.teaching.project.projectId, pageId: review.view.teaching.pageId });
  }

  async decide(payload: unknown) {
    if (!record(payload) || Object.keys(payload).sort().join(",") !== "decision,reviewId" || typeof payload.reviewId !== "string" || !["adopt", "reject"].includes(String(payload.decision))) throw new Error("Invalid saved narration decision");
    const review = this.reviews.get(payload.reviewId);
    if (!review || review.view.status !== "needs-review") throw new Error("Open the narration review again");
    return this.withSaved(review.sessionId, undefined, async ({ host, jobId, project, check }) => {
      if (JSON.stringify(project) !== JSON.stringify(review.view.teaching.project)) throw new Error("Teaching changed; review the candidate again");
      if ((await this.draft({ viewId: review.view.teaching.viewId }) as { draft: unknown }).draft) throw new Error("Resolve the saved narration draft before adopting");
      await check();
      this.reviews.delete(payload.reviewId as string);
      const identity = { sessionId: review.sessionId, candidateId: review.view.candidateId };
      const result = payload.decision === "adopt" ? await host.call<{ project: CoursewareProject }>("courseware.narrationCandidate.adopt", { ...identity, jobId })
        : (await host.call("courseware.narrationCandidate.reject", { ...identity, projectId: project.projectId }), { project });
      return { ...review.view.teaching, project: result.project };
    });
  }
}
