import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { COURSEWARE_MAX_MEDIA_ASSET_BYTES, isCoursewareTaskRef, type CoursewareTaskRef,
  type CoursewareCanvasMusicAsset, type CoursewareCanvasMusicView, type CoursewareCanvasMusicQuoteView,
  type CoursewareCanvasMusicPreview } from "@pi-desktop/shared";
import type { DesktopAuthSession } from "./auth-session";
import type { CoursewareTeachingCoordinator } from "./courseware-teaching";
import type { MediaQuote, MediaTasks } from "./courseware-media-contracts";
import { assertMusicMp3, musicCandidates, musicCandidateId, musicRequest, musicRequestHash,
  type MusicOperation, type MusicRequest, type MusicExportRequest } from "./courseware-music-request";
import { coursewareMediaSubmissionProject, isCoursewareMediaPermissionRefusal } from "./courseware-media-scope";

type Host = { call<T>(method: string, params: unknown): Promise<T> };
type Journal = { current: boolean; intent: {
  intentId: string; draft: CoursewareCanvasMusicView["draft"]; request: MusicRequest | MusicExportRequest;
  idempotencyKey: string; requestHash: string; phase: CoursewareCanvasMusicView["phase"]; taskRef: CoursewareTaskRef | null;
  target?: CoursewareCanvasMusicView["target"]; submissionScope?: unknown; sourceIntentId?: string; candidates: CoursewareCanvasMusicView["candidates"]; ready: boolean;
  unresolvedProjectId?: string;
  previews: CoursewareCanvasMusicView["previews"]; asset?: CoursewareCanvasMusicAsset | null;
} };
type Task = MediaTasks[MusicOperation];
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9._-]{1,128}$/u.test(v) && v !== "." && v !== "..";
const rpc = (method: string) => `courseware.mediaCanvas.music.${method}`;
const invalid = () => new Error("COURSEWARE_CANVAS_MUSIC_INVALID_JOURNAL");
function input(v: unknown, fields: string[] = []): Record<string, string> {
  const keys = ["sessionId", ...fields];
  if (!object(v) || Object.keys(v).length !== keys.length || keys.some(k => !id(v[k]))) throw new Error("COURSEWARE_CANVAS_MUSIC_INVALID_REQUEST");
  return { ...v } as Record<string, string>;
}
function assetValid(v: unknown, ref: CoursewareTaskRef | null): v is CoursewareCanvasMusicAsset {
  return object(v) && Object.keys(v).sort().join(",") === "byteLength,mimeType,sha256,taskRef" && isCoursewareTaskRef(v.taskRef) &&
    !!ref && v.taskRef.taskId === ref.taskId && v.taskRef.idempotencyKey === ref.idempotencyKey && v.taskRef.requestHash === ref.requestHash &&
    v.mimeType === "audio/mpeg" && typeof v.sha256 === "string" && /^[a-f0-9]{64}$/u.test(v.sha256) &&
    Number.isSafeInteger(v.byteLength) && Number(v.byteLength) > 0 && Number(v.byteLength) <= COURSEWARE_MAX_MEDIA_ASSET_BYTES;
}
function checked(v: Journal, expectedId?: string): Journal {
  const i = v?.intent, d = i?.draft;
  if (typeof v?.current !== "boolean" || !i || !id(i.intentId) || expectedId !== undefined && i.intentId !== expectedId ||
      !d || d.kind !== "music" || typeof d.id !== "string" || !d.id.trim() || d.id.length > 160 ||
      !Number.isSafeInteger(d.revision) || d.revision < 0 || !Array.isArray(d.references) || d.references.length !== 0 ||
      typeof d.title !== "string" || !d.title.trim() || d.title.length > 100 || typeof d.prompt !== "string" || d.prompt.length > 4000 ||
      !/^[a-f0-9-]{36}$/u.test(i.idempotencyKey) || i.requestHash !== musicRequestHash(i.request) ||
      !["prepared", "submission-unknown", "submitted", "rejected"].includes(i.phase) ||
      (i.phase === "submitted") !== (i.taskRef !== null) ||
      i.taskRef !== null && (!isCoursewareTaskRef(i.taskRef) || i.taskRef.idempotencyKey !== i.idempotencyKey || i.taskRef.requestHash !== i.requestHash) ||
      typeof i.ready !== "boolean" || !Array.isArray(i.previews)) throw invalid();
  if (i.unresolvedProjectId !== undefined && !id(i.unresolvedProjectId)) throw invalid();
  const target = i.target;
  if (target && (target.version !== 1 || !id(target.projectId) || !id(target.pageId) || !id(target.actionId) ||
      !id(target.source?.revision) || !/^[a-f0-9]{64}$/u.test(target.source?.sha256) || typeof target.prompt !== "string" || !target.prompt.trim() || target.prompt.length > 4000)) throw invalid();
  musicRequest(i.request);
  if (i.request.kind === "music" ? i.sourceIntentId !== undefined || i.request.input !== d.prompt || i.request.music.title !== d.title
    : !id(i.sourceIntentId) || i.sourceIntentId === i.intentId || i.previews.length > 0 || i.candidates.length > 0 || i.ready) throw invalid();
  musicCandidates(i.candidates, i.ready);
  if (new Set(i.previews.map(p => p.candidateId)).size !== i.previews.length || i.previews.some(p => !musicCandidateId(p.candidateId) ||
      !i.candidates.some(c => c.candidateId === p.candidateId && c.state === "completed") || !assetValid(p.asset, i.taskRef)) ||
      i.asset != null && (i.request.kind !== "music-export" || !assetValid(i.asset, i.taskRef))) throw invalid();
  return v;
}
function view(j: Journal, task: Task | null = null): CoursewareCanvasMusicView {
  const i = j.intent;
  return { intentId: i.intentId, draft: i.draft, model: i.request.model, operation: i.request.kind,
    ...(i.request.kind === "music" ? { music: i.request.music } : { sourceIntentId: i.sourceIntentId, candidateId: i.request.input }),
    ...(i.target ? { target: i.target } : {}), phase: i.phase, current: j.current, candidates: i.candidates, previews: i.previews, asset: i.asset ?? null,
    ...(i.unresolvedProjectId ? { unresolvedProjectId: i.unresolvedProjectId } : {}),
    task: task ? { state: task.state, feeState: task.feeState, reservedPoints: task.reservedPoints,
      actualPoints: task.actualPoints, errorCode: task.errorCode } : null };
}

export class CoursewareCanvasMusic {
  private quotes = new Map<string, { scope: string; hash: string; quote: MediaQuote<MusicOperation> }>();
  private submitting = new Set<string>();
  private archiving = new Set<string>();
  constructor(private getHost: () => Host | null, private getSession: () => string | null,
    private isRunning: (sessionId: string) => boolean, private auth: Pick<DesktopAuthSession, "getCoursewarePrincipal" | "coursewareMedia">,
    private adoption?: { teaching: Pick<CoursewareTeachingCoordinator, "musicAdoptionContext">;
      decodeAudio: (bytes: Buffer, mime: "audio/mpeg") => Promise<number> }) {}

  private async context(params: Record<string, string>, requireAgent = false) {
    const p = { ...params }, host = this.getHost(), principal = this.auth.getCoursewarePrincipal();
    const assertCurrent = () => {
      principal.assertCurrent();
      if (!host || this.getHost() !== host || this.getSession() !== p.sessionId || this.isRunning(p.sessionId))
        throw new Error("COURSEWARE_CANVAS_MUSIC_CONTEXT_CHANGED");
    };
    assertCurrent();
    if (!host) throw new Error("Host unavailable");
    const { session } = await host.call<{ session?: { projectPath?: string; mode?: string } }>("session.get", { id: p.sessionId });
    assertCurrent();
    if (!session?.projectPath || requireAgent && session.mode !== "agent") throw new Error("COURSEWARE_CANVAS_MUSIC_AGENT_REQUIRED");
    return { host, principal, assertCurrent, scope: { sessionId: p.sessionId, principalKey: principal.key, ...(p.intentId ? { intentId: p.intentId } : {}) } };
  }

  async models(value: unknown) {
    const c = await this.context(input(value));
    const generation = await this.auth.coursewareMedia.music.models("music"); c.assertCurrent();
    const exports = await this.auth.coursewareMedia.music.models("music-export"); c.assertCurrent();
    return { generation, export: exports };
  }

  async prepare(value: unknown): Promise<CoursewareCanvasMusicView> {
    if (!object(value) || Object.keys(value).filter(k => k !== "target").sort().join(",") !== "draftId,expectedDraftRevision,expectedRevision,intentId,model,music,sessionId" ||
        typeof value.draftId !== "string" || !value.draftId.trim() || value.draftId.length > 160 ||
        typeof value.expectedRevision !== "string" || !value.expectedRevision || value.expectedRevision.length > 128 ||
        !Number.isSafeInteger(value.expectedDraftRevision) || Number(value.expectedDraftRevision) < 0) throw new Error("COURSEWARE_CANVAS_MUSIC_INVALID_REQUEST");
    const { expectedRevision, expectedDraftRevision, draftId, music, target, ...ids } = structuredClone(value);
    const p = input(ids, ["intentId", "model"]), c = await this.context(p, true);
    musicRequest({ kind: "music", model: p.model, input: "validation", music });
    await this.assertModel(c, "music", p.model);
    const saved = checked(await c.host.call<Journal>(rpc("prepare"), { ...c.scope, expectedRevision, expectedDraftRevision, draftId, model: p.model, music, ...(target ? { target } : {}) }), p.intentId);
    c.assertCurrent();
    if (!saved.current || saved.intent.request.kind !== "music" || saved.intent.request.model !== p.model || saved.intent.draft.id !== draftId ||
        saved.intent.draft.revision !== expectedDraftRevision || musicRequestHash({ kind: "music", model: p.model,
          input: saved.intent.draft.prompt, music: music as MusicRequest["music"] }) !== saved.intent.requestHash) throw invalid();
    return view(saved);
  }

  async exportPrepare(value: unknown): Promise<CoursewareCanvasMusicView> {
    const p = input(value, ["intentId", "exportIntentId", "candidateId", "model"]);
    if (!musicCandidateId(p.candidateId)) throw new Error("COURSEWARE_CANVAS_MUSIC_INVALID_REQUEST");
    const c = await this.context(p, true);
    await this.assertModel(c, "music-export", p.model);
    const saved = checked(await c.host.call<Journal>(rpc("export.prepare"), { ...c.scope, intentId: p.exportIntentId,
      sourceIntentId: p.intentId, candidateId: p.candidateId, model: p.model }), p.exportIntentId); c.assertCurrent();
    if (saved.intent.request.kind !== "music-export" || saved.intent.sourceIntentId !== p.intentId ||
        saved.intent.request.input !== p.candidateId || saved.intent.request.model !== p.model) throw invalid();
    return view(saved);
  }

  private async assertModel(c: Awaited<ReturnType<CoursewareCanvasMusic["context"]>>, kind: MusicOperation, model: string) {
    const models = await this.auth.coursewareMedia.music.models(kind);
    c.assertCurrent();
    if (!models.some(value => value.model === model)) throw new Error("COURSEWARE_CANVAS_MUSIC_MODEL_UNAVAILABLE");
  }

  async list(value: unknown): Promise<CoursewareCanvasMusicView[]> {
    const c = await this.context(input(value));
    const saved = await c.host.call<{ intents: Journal[] }>(rpc("list"), c.scope); c.assertCurrent();
    if (!Array.isArray(saved.intents) || saved.intents.length > 300) throw invalid();
    return saved.intents.map(j => view(checked(j)));
  }

  async quote(value: unknown) { return this.offer(value, "music"); }
  async exportQuote(value: unknown) { return this.offer(value, "music-export"); }
  private async offer(value: unknown, kind: MusicOperation): Promise<CoursewareCanvasMusicQuoteView> {
    const p = input(value, ["intentId"]), c = await this.context(p, true);
    const saved = await this.journal(c, p.intentId, kind);
    if (saved.intent.phase !== "prepared" || kind === "music" && !saved.current) throw new Error("COURSEWARE_CANVAS_MUSIC_DRAFT_CHANGED");
    const quote = { ...await this.auth.coursewareMedia.music.quote(saved.intent.request.model, kind) }; c.assertCurrent();
    if (saved.intent.request.input.length > quote.maxChars) throw new Error("COURSEWARE_CANVAS_MUSIC_PROMPT_TOO_LONG");
    const latest = await this.journal(c, p.intentId, kind);
    if (JSON.stringify(latest) !== JSON.stringify(saved)) throw new Error("COURSEWARE_CANVAS_MUSIC_DRAFT_CHANGED");
    const scope = JSON.stringify(c.scope);
    for (const [key, old] of this.quotes) if (Date.parse(old.quote.expiresAt) <= Date.now() || old.scope === scope) this.quotes.delete(key);
    if (this.quotes.size >= 100) this.quotes.delete(this.quotes.keys().next().value!);
    const quoteId = randomUUID(); this.quotes.set(quoteId, { scope, hash: saved.intent.requestHash, quote });
    return { quoteId, intentId: p.intentId, model: quote.model, maxPoints: quote.maxPoints, maxChars: quote.maxChars, expiresAt: quote.expiresAt };
  }

  async submitConfirmed(value: unknown) { return this.submit(value, "music"); }
  async exportSubmitConfirmed(value: unknown) { return this.submit(value, "music-export"); }
  private async submit(value: unknown, kind: MusicOperation): Promise<CoursewareCanvasMusicView> {
    const p = input(value, ["intentId", "quoteId"]), c = await this.context(p, true), key = JSON.stringify(c.scope);
    if (this.submitting.has(key)) throw new Error("COURSEWARE_CANVAS_MUSIC_IN_FLIGHT");
    this.submitting.add(key);
    try {
      const saved = await this.journal(c, p.intentId, kind);
      if (saved.intent.phase !== "prepared") return this.read(c, saved);
      if (kind === "music" && !saved.current) throw new Error("COURSEWARE_CANVAS_MUSIC_DRAFT_CHANGED");
      const offer = this.quotes.get(p.quoteId);
      if (!offer || offer.scope !== key || offer.hash !== saved.intent.requestHash || Date.parse(offer.quote.expiresAt) <= Date.now())
        throw new Error("COURSEWARE_CANVAS_MUSIC_QUOTE_REQUIRED");
      this.quotes.delete(p.quoteId);
      let begun = saved, projectId: string | undefined;
      const admit = async () => {
        begun = checked(await c.host.call<Journal>(rpc("begin"), c.scope), p.intentId); c.assertCurrent();
      if (begun.intent.phase !== "submission-unknown" || begun.intent.idempotencyKey !== saved.intent.idempotencyKey ||
          begun.intent.requestHash !== saved.intent.requestHash || JSON.stringify(begun.intent.request) !== JSON.stringify(saved.intent.request)) throw invalid();
        projectId = coursewareMediaSubmissionProject(begun.intent.submissionScope, p.sessionId);
      c.assertCurrent();
        return projectId;
      };
      let task: Task;
      try { task = await this.auth.coursewareMedia.music.submitConfirmed(saved.intent.idempotencyKey, saved.intent.request, offer.quote, undefined, undefined, c.assertCurrent, admit); }
      catch (failure) {
        if (begun.intent.phase !== "submission-unknown" || !isCoursewareMediaPermissionRefusal(failure, projectId)) throw failure;
        const rejected = checked(await c.host.call<Journal>(rpc("reject"), { ...c.scope,
          rejectedRequest: { idempotencyKey: begun.intent.idempotencyKey, requestHash: begun.intent.requestHash } }), p.intentId);
        if (rejected.intent.phase !== "rejected" || rejected.intent.idempotencyKey !== begun.intent.idempotencyKey || rejected.intent.requestHash !== begun.intent.requestHash) throw invalid();
        c.assertCurrent(); return view(rejected);
      }
      const bound = await this.bind(c, begun, task); c.assertCurrent();
      return view(bound, task);
    } finally { this.submitting.delete(key); }
  }

  async status(value: unknown) { return this.statusFor(value, "music"); }
  async exportStatus(value: unknown) { return this.statusFor(value, "music-export"); }
  private async statusFor(value: unknown, kind: MusicOperation) {
    const p = input(value, ["intentId"]), c = await this.context(p);
    return this.read(c, await this.journal(c, p.intentId, kind));
  }

  private async journal(c: Awaited<ReturnType<CoursewareCanvasMusic["context"]>>, intentId: string, kind?: MusicOperation) {
    const saved = checked(await c.host.call<Journal>(rpc("get"), c.scope), intentId); c.assertCurrent();
    if (kind && saved.intent.request.kind !== kind) throw invalid();
    return saved;
  }
  private async bind(c: Awaited<ReturnType<CoursewareCanvasMusic["context"]>>, saved: Journal, task: Task) {
    const i = saved.intent;
    if (task.kind !== i.request.kind || task.model !== i.request.model || task.idempotencyKey !== i.idempotencyKey || task.requestHash !== i.requestHash ||
        i.taskRef && task.taskId !== i.taskRef.taskId) throw invalid();
    // Preserve valid late receipts in their original scope before checking UI currency.
    return checked(await c.host.call<Journal>(rpc("bind"), { ...c.scope,
      taskRef: { taskId: task.taskId, idempotencyKey: task.idempotencyKey, requestHash: task.requestHash } }), i.intentId);
  }
  private async read(c: Awaited<ReturnType<CoursewareCanvasMusic["context"]>>, saved: Journal): Promise<CoursewareCanvasMusicView> {
    const i = saved.intent;
    if (i.phase === "prepared" || i.phase === "rejected") { c.assertCurrent(); return view(saved); }
    const task = i.taskRef ? await this.auth.coursewareMedia.music.get(i.taskRef, i.request.kind)
      : await this.auth.coursewareMedia.music.find({ idempotencyKey: i.idempotencyKey, requestHash: i.requestHash }, i.request.kind);
    if (!task) { c.assertCurrent(); return view(saved); }
    let bound = await this.bind(c, saved, task); c.assertCurrent();
    if (task.kind === "music") {
      const collection = await this.auth.coursewareMedia.music.candidates(bound.intent.taskRef!); c.assertCurrent();
      if (collection.task.model !== i.request.model) throw invalid();
      bound = checked(await c.host.call<Journal>(rpc("candidates.record"), { ...c.scope, taskRef: bound.intent.taskRef,
        candidates: collection.candidates, ready: collection.task.state === "ready" }), i.intentId); c.assertCurrent();
      return view(bound, collection.task);
    }
    return view(bound, task);
  }

  async preview(value: unknown) { return this.retrieve(value, false); }
  async exportArchive(value: unknown) { return this.retrieve(value, true); }
  async adopt(value: unknown) {
    const p = input(value, ["intentId", "viewId", "expectedTeachingRevision"]);
    const c = await this.context(p, true);
    if (!this.adoption) throw new Error("COURSEWARE_CANVAS_MUSIC_EDITOR_REQUIRED");
    const target = await this.adoption.teaching.musicAdoptionContext({ viewId: p.viewId, expectedTeachingRevision: p.expectedTeachingRevision });
    if (target.host !== c.host || target.sessionId !== p.sessionId ||
        target.expectedTeachingRevision !== p.expectedTeachingRevision)
      throw new Error("COURSEWARE_CANVAS_MUSIC_CONTEXT_CHANGED");
    c.assertCurrent();
    const saved = await this.journal(c, p.intentId, "music-export");
    const asset = saved.intent.asset, ref = saved.intent.taskRef;
    if (!asset || !ref) throw new Error("COURSEWARE_CANVAS_MUSIC_ARCHIVE_REQUIRED");
    const preview = await this.exportArchive({ sessionId: p.sessionId, intentId: p.intentId });
    if (preview.asset.sha256 !== asset.sha256 || preview.asset.mimeType !== asset.mimeType ||
        preview.asset.byteLength !== asset.byteLength || preview.asset.taskRef.taskId !== ref.taskId ||
        preview.asset.taskRef.idempotencyKey !== ref.idempotencyKey || preview.asset.taskRef.requestHash !== ref.requestHash) throw invalid();
    const durationMs = await this.adoption.decodeAudio(Buffer.from(preview.dataUrl.slice(preview.dataUrl.indexOf(",") + 1), "base64"), "audio/mpeg");
    if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 86_400_000)
      throw new Error("COURSEWARE_AUDIO_INVALID_DURATION");
    await target.assertCurrent(); c.assertCurrent();
    // A new adoption needs current server permission even when the bytes are local.
    const task = await this.auth.coursewareMedia.music.get(ref, "music-export");
    if (task.taskId !== ref.taskId || task.idempotencyKey !== ref.idempotencyKey || task.requestHash !== ref.requestHash ||
        task.kind !== "music-export" || task.model !== saved.intent.request.model || task.state !== "ready" ||
        task.feeState !== "settled" || task.assetRef?.sha256 !== asset.sha256 ||
        task.assetRef.mime !== asset.mimeType || task.assetRef.byteLength !== asset.byteLength) throw invalid();
    await target.assertCurrent(); c.assertCurrent();
    const adopted = await target.adoptMusic({ principalKey: c.principal.key, intentId: p.intentId,
      assetId: `music-${asset.sha256}`, durationMs });
    c.assertCurrent();
    return adopted;
  }
  private async retrieve(value: unknown, exported: boolean): Promise<CoursewareCanvasMusicPreview> {
    const p = input(value, exported ? ["intentId"] : ["intentId", "candidateId"]);
    if (!exported && !musicCandidateId(p.candidateId)) throw new Error("COURSEWARE_CANVAS_MUSIC_INVALID_REQUEST");
    const c = await this.context(p), key = JSON.stringify(c.scope);
    if (this.archiving.has(key)) throw new Error("COURSEWARE_CANVAS_MUSIC_IN_FLIGHT");
    this.archiving.add(key);
    try {
      let saved = await this.journal(c, p.intentId, exported ? "music-export" : "music");
      if (!saved.intent.taskRef) throw new Error("COURSEWARE_CANVAS_MUSIC_TASK_REQUIRED");
      const existing = exported ? saved.intent.asset : saved.intent.previews.find(v => v.candidateId === p.candidateId)?.asset;
      if (!existing) {
        let asset: CoursewareCanvasMusicAsset, bytes: Buffer;
        if (exported) {
          const result = await this.auth.coursewareMedia.music.downloadExport(saved.intent.taskRef); c.assertCurrent();
          if (result.task.model !== saved.intent.request.model || !result.task.assetRef) throw invalid();
          asset = { taskRef: saved.intent.taskRef, sha256: result.task.assetRef.sha256, mimeType: "audio/mpeg", byteLength: result.bytes.length };
          bytes = result.bytes;
        } else {
          const result = await this.auth.coursewareMedia.music.preview(saved.intent.taskRef, p.candidateId); c.assertCurrent();
          if (result.task.model !== saved.intent.request.model) throw invalid();
          saved = checked(await c.host.call<Journal>(rpc("candidates.record"), { ...c.scope, taskRef: saved.intent.taskRef,
            candidates: result.candidates, ready: result.task.state === "ready" }), p.intentId); c.assertCurrent();
          asset = { taskRef: saved.intent.taskRef!, ...result.preview }; bytes = result.bytes;
        }
        checked(await c.host.call<Journal>(rpc("asset.stage"), { ...c.scope, ...(!exported ? { candidateId: p.candidateId } : {}),
          asset, bytesBase64: bytes.toString("base64") }), p.intentId); c.assertCurrent();
      }
      const stored = await c.host.call<Journal & { path: unknown }>(rpc("asset.get"), { ...c.scope, ...(!exported ? { candidateId: p.candidateId } : {}) }); c.assertCurrent();
      saved = checked(stored, p.intentId);
      const asset = exported ? saved.intent.asset : saved.intent.previews.find(v => v.candidateId === p.candidateId)?.asset;
      if (!asset || typeof stored.path !== "string" || !isAbsolute(stored.path) || basename(stored.path) !== `${asset.sha256}.bin`) throw invalid();
      const file = await open(stored.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      let bytes: Buffer;
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size !== asset.byteLength) throw new Error("COURSEWARE_MEDIA_ASSET_INTEGRITY_ERROR");
        bytes = Buffer.alloc(asset.byteLength);
        let offset = 0;
        while (offset < bytes.length) { const result = await file.read(bytes, offset, bytes.length - offset, offset); if (!result.bytesRead) break; offset += result.bytesRead; }
        if (offset !== bytes.length || createHash("sha256").update(bytes).digest("hex") !== asset.sha256) throw new Error("COURSEWARE_MEDIA_ASSET_INTEGRITY_ERROR");
        assertMusicMp3(bytes, asset.mimeType);
      } finally { await file.close(); }
      c.assertCurrent();
      return { intentId: p.intentId, ...(!exported ? { candidateId: p.candidateId } : {}), asset, dataUrl: `data:audio/mpeg;base64,${bytes.toString("base64")}` };
    } finally { this.archiving.delete(key); }
  }
}
