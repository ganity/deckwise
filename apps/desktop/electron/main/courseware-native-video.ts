import { createHash, randomUUID } from "node:crypto";
import { videoRequestHash, type VideoRequest } from "./courseware-video-media";
import type { CoursewareTaskRef, CoursewareTeachingView } from "@pi-desktop/shared";
import type { DesktopAuthSession } from "./auth-session";
type Host = { call<T>(method: string, params: unknown): Promise<T> };
type Intent = { id: string; actionId: string; pageId: string; request: VideoRequest; durationSeconds?: number; key: string; hash: string;
  phase: "prepared" | "submission-unknown" | "submitted"; ref: CoursewareTaskRef | null };
type Journal = { revision: number; value: { intents: Intent[] } };
type Route = (operation: string, args: Record<string, unknown>, page: number) => Promise<{ value: unknown } | undefined>;

/** Private task receipts never become editable teaching data or leave the authenticated Host. */
export class CoursewareNativeVideo {
  private running = new Set<string>();
  constructor(private auth: Pick<DesktopAuthSession, "getCoursewarePrincipal" | "coursewareMedia">, private host: () => Host | null,
    private session: () => string | null, private route: Route,
    private decode: (bytes: Buffer) => Promise<{ durationMs: number; width: number; height: number }>) {}

  async models() {
    const principal = this.auth.getCoursewarePrincipal(), sessionId = this.session(), host = this.host();
    const models = await this.auth.coursewareMedia.video.models();
    principal.assertCurrent();
    if (host !== this.host() || sessionId !== this.session()) throw new Error("Native video owner changed");
    return models;
  }
  async jobs(pageNumber: number, view: CoursewareTeachingView) {
    const host = this.host(), sessionId = this.session(), principal = this.auth.getCoursewarePrincipal();
    if (!host || !sessionId) throw new Error("Native video owner unavailable");
    const key = "task:native-video-" + createHash("sha256").update(sessionId + ":" + view.project.projectId).digest("hex");
    const journal = await host.call<Journal | null>("courseware.mediaRelay.read", { principalKey: principal.key, key });
    principal.assertCurrent();
    if (this.host() !== host || this.session() !== sessionId) throw new Error("Native video owner changed");
    const page = view.project.pages[pageNumber - 1];
    return (journal?.value.intents ?? []).filter(i => i.phase !== "prepared" && i.pageId === page.pageId && page.actions.some(a => a.id === i.actionId && a.type === "video_slot" && a.prompt === i.request.input))
      .map(i => ({ kind: "video", intentId: i.id, actionId: i.actionId, pageNumber, sourceSha256: view.project.source.sha256 }));
  }

  async execute(input: Record<string, unknown>, prepare: boolean, pageNumber: number, view: CoursewareTeachingView, canDispatch: () => boolean) {
    const host = this.host(), sessionId = this.session(), principal = this.auth.getCoursewarePrincipal(), client = this.auth.coursewareMedia.video;
    if (!host || !sessionId) throw new Error("Native video owner unavailable");
    const check = async () => {
      principal.assertCurrent();
      if (!canDispatch() || this.host() !== host || this.session() !== sessionId) throw new Error("Native video owner changed");
      const current = await this.route("open", {}, pageNumber);
      if (JSON.stringify(current?.value) !== JSON.stringify(view)) throw new Error("Native video page changed");
    };
    await check();
    const key = "task:native-video-" + createHash("sha256").update(sessionId + ":" + view.project.projectId).digest("hex");
    let journal = await host.call<Journal | null>("courseware.mediaRelay.read", { principalKey: principal.key, key });
    const intents = journal?.value.intents ?? [];
    if (!Array.isArray(intents) || intents.length > 1000) throw new Error("Invalid native video journal");
    const save = async () => { principal.assertCurrent(); journal = await host.call<Journal>("courseware.mediaRelay.write", {
      principalKey: principal.key, key, expectedRevision: journal?.revision ?? 0, value: { intents } }); };
    const page = view.project.pages[pageNumber - 1];
    if (view.readOnly || !page || page.locked) throw new Error("Native video page locked");
    let intent: Intent | undefined;
    if (prepare) {
      const slot = page.actions.find(a => a.id === input.actionId && ["video_slot", "video_clip"].includes(String(a.type)));
      if (!slot || typeof slot.prompt !== "string" || !slot.prompt.trim() || slot.prompt.length > 4000 ||
          typeof input.model !== "string" || !/^[\w.-]{1,128}$/.test(input.model)) throw new Error("Native video slot/model unavailable");
      const durationSeconds = Number(slot.durationSeconds ?? 5);
      if (!Number.isInteger(durationSeconds) || durationSeconds < 4 || durationSeconds > 30) throw new Error("Invalid native video duration");
      intent = intents.find(i => i.pageId === page.pageId && i.actionId === slot.id && i.request.input === slot.prompt &&
        (i.durationSeconds ?? 5) === durationSeconds && i.phase !== "prepared");
      if (!intent) {
        if (intents.length >= 1000) throw new Error("Native video journal full");
        const request: VideoRequest = { kind: "video", model: input.model, input: slot.prompt };
        intent = { id: randomUUID(), actionId: String(slot.id), pageId: page.pageId, request, durationSeconds, key: randomUUID(), hash: videoRequestHash(request), phase: "prepared", ref: null };
        intents.push(intent); await save();
      }
    } else intent = intents.find(i => i.id === input.intentId && i.pageId === page.pageId);
    if (!prepare && intent?.phase === "prepared") throw new Error("Video task has not been submitted");
    if (!intent || !page.actions.some(a => a.id === intent!.actionId && a.prompt === intent!.request.input &&
      Number(a.durationSeconds ?? 5) === (intent!.durationSeconds ?? 5))) throw new Error("Native video task is stale");
    const job = { kind: "video", intentId: intent.id, pageNumber, sourceSha256: view.project.source.sha256 };
    if (this.running.has(intent.id)) throw new Error("Native video operation already in progress");
    this.running.add(intent.id);
    try {
      let task;
      if (intent.phase === "prepared") {
        const durationSeconds = intent.durationSeconds ?? 5;
        const quote = await client.quote(intent.request.model, durationSeconds); await check();
        task = await client.submit(intent.key, intent.request, quote, undefined, check, async () => {
          await check(); const scope = await host.call<{ teamProjectId: string | null }>("courseware.mediaRelay.scope", { sessionId });
          intent!.phase = "submission-unknown"; await save(); return scope.teamProjectId ?? undefined;
        }, durationSeconds);
      } else task = intent.ref ? await client.get(intent.ref) : await client.find({ idempotencyKey: intent.key, requestHash: intent.hash });
      if (!task) return { job, saved: false, recovery: "unknown", state: "submission_unknown" };
      if (task.requestHash !== intent.hash || task.idempotencyKey !== intent.key || task.model !== intent.request.model) throw new Error("Invalid native video receipt");
      principal.assertCurrent(); intent.ref = { taskId: task.taskId, requestHash: task.requestHash, idempotencyKey: task.idempotencyKey };
      intent.phase = "submitted"; await save(); await check();
      if (task.state !== "ready") return { job, saved: false, state: task.state, waitingFor: ["failed", "cancelled", "archive_failed"].includes(task.state) ? null : "service" };
      const { task: ready, bytes } = await client.download(intent.ref); await check();
      if (!ready.assetRef || ready.feeState !== "settled") throw new Error("Native video not settled");
      const metadata = await this.decode(bytes); await check();
      await this.route("adopt-audio", { viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision, command: {
        kind: "video", actionId: intent.actionId, assetId: "video-" + ready.assetRef.sha256, mimeType: "video/mp4", sha256: ready.assetRef.sha256,
        durationMs: metadata.durationMs, bytes: Uint8Array.from(bytes).buffer } }, pageNumber);
      return { job, applied: true, saved: false, videoReady: true };
    } finally { this.running.delete(intent.id); }
  }
}
