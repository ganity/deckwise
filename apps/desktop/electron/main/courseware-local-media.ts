import { createHash, randomUUID } from "node:crypto";
import { COURSEWARE_MAX_MEDIA_ASSET_BYTES, type CoursewareTaskRef } from "@pi-desktop/shared";
import { mediaTask, type MediaKind, type MediaQuote, type MediaTasks } from "./courseware-media-contracts";
import { CoursewareMediaTransport, mediaEnvelope } from "./courseware-media-transport";
import { assertMusicMp3, musicCandidates, type MusicCandidate } from "./courseware-music-request";

type Kind = "tts" | "music" | "music-export";
type LocalTask = MediaTasks[Kind];
type Candidate = { candidate: MusicCandidate; receipt: string };
type RecordValue = { task: LocalTask; receipts: string[]; candidates: Candidate[]; bytesBase64?: string; billingReceipt?: string; projectId?: string };
type Saved = { revision: number; value: RecordValue };
const invalid = () => new Error("COURSEWARE_MEDIA_INVALID_RESPONSE");
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const receipt = (v: unknown): v is string => typeof v === "string" && v.length <= 2048 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(v);
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

const refreshes = new WeakMap<object, Map<string, Promise<LocalTask>>>();

/** Host owns the journal and audio; every upstream request is finite and never schedules work on Platform. */
export class CoursewareLocalMedia extends CoursewareMediaTransport {
  private async read(key: string, principal: object): Promise<Saved | null> {
    if (!this.options.relayJournal) throw new Error("COURSEWARE_MEDIA_JOURNAL_UNAVAILABLE");
    this.assertPrincipal(principal);
    const value = await this.options.relayJournal("read", key);
    this.assertPrincipal(principal);
    if (value === null) return null;
    if (!object(value) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || !object(value.value)) throw invalid();
    return value as Saved;
  }
  private async write(key: string, value: unknown, revision: number, principal: object): Promise<void> {
    this.assertPrincipal(principal);
    if (!this.options.relayJournal) throw new Error("COURSEWARE_MEDIA_JOURNAL_UNAVAILABLE");
    await this.options.relayJournal("write", key, value, revision);
    this.assertPrincipal(principal);
  }
  private checked<K extends Kind>(saved: Saved, ref: Pick<CoursewareTaskRef, "idempotencyKey" | "requestHash"> & { taskId?: string }, kind: K): MediaTasks[K] {
    return mediaTask(saved.value.task, ref, kind);
  }

  async submit<K extends Kind>(key: string, body: { kind: K; model: string; input: string }, hash: string,
    quote: MediaQuote<MediaKind>, signal?: AbortSignal, projectId?: string): Promise<MediaTasks[K]> {
    const principal = this.principal(), journalKey = `task:${key}`;
    if (!/^[A-Za-z0-9._-]{1,96}$/u.test(key) || !/^[a-f0-9]{64}$/u.test(hash) ||
        (projectId !== undefined && !/^[a-f0-9-]{36}$/u.test(projectId))) throw invalid();
    signal?.throwIfAborted();
    const previous = await this.read(journalKey, principal);
    if (previous) {
      if (previous.value.projectId !== projectId) throw new Error("COURSEWARE_MEDIA_IDEMPOTENCY_CONFLICT");
      // An unknown response is not permission for a second paid POST, including after a restart.
      return this.checked(previous, { idempotencyKey: key, requestHash: hash }, body.kind);
    }
    let sourceReceipt: string | undefined;
    if (body.kind === "music-export") {
      const source = await this.read(`candidate:${body.input}`, principal);
      const value = source?.value as unknown;
      if (!object(value) || !receipt(value.receipt) || value.projectId !== projectId) throw new Error("COURSEWARE_MEDIA_INVALID_CANDIDATE");
      sourceReceipt = value.receipt;
    }
    const taskId = `local-${randomUUID()}`;
    const task: LocalTask = { version: "courseware-media-v1", taskId, idempotencyKey: key, requestHash: hash,
      kind: body.kind, model: body.model, state: "submission_unknown", feeState: "reserved", reservedPoints: quote.maxPoints,
      actualPoints: null, receiptId: null, errorCode: "SUBMISSION_UNKNOWN", assetRef: null };
    const saved: RecordValue = { task, receipts: [], candidates: [], ...(projectId ? { projectId } : {}) };
    await this.write(journalKey, saved, 0, principal);
    let result: unknown;
    try {
    const response = await this.receive("/courseware/media/relay", principal, signal, 24 * 1024 * 1024, {
      method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify({ request: body,
        confirmation: { priceVersion: quote.priceVersion, maxPoints: quote.maxPoints, quoteToken: quote.quoteToken },
        ...(sourceReceipt ? { sourceReceipt } : {}), ...(projectId ? { projectId } : {}) }),
    }, "application/json", 200_000);
    if (response.mime !== "application/json") throw invalid();
    result = mediaEnvelope(response.bytes);
    } catch (error) {
      const code = error instanceof Error ? /^COURSEWARE_MEDIA_PLATFORM_([0-9]+)$/u.exec(error.message)?.[1] : undefined;
      if (code && ["46001", "46002", "46003", "46004", "46010", "46011", "46012", "46013", "46014", "46015", "46019", "46100", "46102"].includes(code)) {
        task.state = "failed"; task.feeState = "released"; task.actualPoints = 0; task.errorCode = `PLATFORM_${code}`;
        await this.write(journalKey, saved, 1, principal);
      }
      throw error;
    }
    this.accept(saved, result);
    await this.write(journalKey, saved, 1, principal);
    return this.checked({ revision: 2, value: saved }, { idempotencyKey: key, requestHash: hash }, body.kind);
  }

  private accept(saved: RecordValue, result: unknown) {
    const task = saved.task;
    if (!object(result) || result.kind !== task.kind || !Number.isSafeInteger(result.actualPoints) ||
        Number(result.actualPoints) < 0 || Number(result.actualPoints) > task.reservedPoints ||
        typeof result.billingReceipt !== "string" || !/^[a-f0-9-]{36}$/u.test(result.billingReceipt) || !Array.isArray(result.receipts) ||
        result.receipts.length > 16 || result.receipts.some(v => !receipt(v)) || new Set(result.receipts).size !== result.receipts.length) throw invalid();
    task.actualPoints = Number(result.actualPoints); task.feeState = "settled"; task.receiptId = `courseware-media:${task.taskId}`;
    task.errorCode = null; saved.billingReceipt = result.billingReceipt;
    saved.receipts = result.receipts as string[];
    if (task.kind === "tts") {
      if (saved.receipts.length !== 0 || typeof result.bytesBase64 !== "string" || result.mime !== "audio/mpeg") throw invalid();
      this.audio(saved, Buffer.from(result.bytesBase64, "base64"));
      if (saved.bytesBase64 !== result.bytesBase64) throw invalid();
    } else {
      if (saved.receipts.length < 1 || task.kind === "music-export" && saved.receipts.length !== 1 || result.bytesBase64 !== null || result.mime !== null) throw invalid();
      task.state = "submitted";
      if (task.kind === "music") saved.candidates = saved.receipts.map((token, order) => ({ receipt: token,
        candidate: { candidateId: randomUUID(), order, state: "pending", exportable: false } }));
    }
  }

  async find<K extends Kind>(ref: Pick<CoursewareTaskRef, "idempotencyKey" | "requestHash">, kind: K,
    scope?: { projectId?: string }): Promise<MediaTasks[K] | null> {
    if (!/^[A-Za-z0-9._-]{1,96}$/u.test(ref.idempotencyKey) || !/^[a-f0-9]{64}$/u.test(ref.requestHash)) throw invalid();
    const saved = await this.read(`task:${ref.idempotencyKey}`, this.principal());
    if (saved && scope && saved.value.projectId !== scope.projectId) throw new Error("COURSEWARE_MEDIA_IDEMPOTENCY_CONFLICT");
    if (!saved) return null;
    const task = this.checked(saved, ref, kind);
    return task.state === "submission_unknown" && kind === "tts" ? this.get({ ...ref, taskId: task.taskId }, kind) : task;
  }

  async get<K extends Kind>(ref: CoursewareTaskRef, kind: K, signal?: AbortSignal): Promise<MediaTasks[K]> {
    signal?.throwIfAborted();
    const principal = this.principal();
    let jobs = refreshes.get(principal);
    if (!jobs) { jobs = new Map(); refreshes.set(principal, jobs); }
    const key = `${kind}:${ref.idempotencyKey}`;
    let job = jobs.get(key);
    if (!job) {
      job = this.refresh(ref, kind);
      jobs.set(key, job);
      const owned = job;
      void job.finally(() => { if (jobs.get(key) === owned) jobs.delete(key); }).catch(() => {});
    }
    const task = await job;
    this.assertPrincipal(principal); signal?.throwIfAborted();
    return mediaTask(task, ref, kind);
  }

  private async refresh<K extends Kind>(ref: CoursewareTaskRef, kind: K): Promise<MediaTasks[K]> {
    const signal = undefined;

    const principal = this.principal(), key = `task:${ref.idempotencyKey}`;
    const saved = await this.read(key, principal);
    if (!saved) throw new Error("COURSEWARE_MEDIA_LOCAL_RECEIPT_UNAVAILABLE");
    const task = this.checked(saved, ref, kind);
    if (kind === "tts" && task.state === "submission_unknown") {
      let result: unknown;
      try {
        const response = await this.receive(`/courseware/media/relay/recover?${new URLSearchParams({ key: ref.idempotencyKey })}`,
          principal, signal, 24 * 1024 * 1024, {}, "application/json", 30_000);
        if (response.mime !== "application/json") throw invalid();
        result = mediaEnvelope(response.bytes);
      } catch (error) {
        // Old services and originals without a saved result remain unknown, never repurchased.
        if (error instanceof Error && ["COURSEWARE_MEDIA_PLATFORM_46016", "COURSEWARE_MEDIA_HTTP_404"].includes(error.message)) return task;
        throw error;
      }
      this.accept(saved.value, result);
      return this.commitRefresh(key, saved, ref, kind, principal);
    }
    if (task.state !== "submitted") return task;
    if (kind === "music") {
      for (const item of saved.value.candidates) {
        if (["completed", "failed"].includes(item.candidate.state)) continue;
        const progress = await this.progress(item.receipt, principal, signal);
        item.candidate.state = progress.status;
        if (typeof progress.durationSeconds === "number") item.candidate.durationMs = Math.round(progress.durationSeconds * 1000);
      }
      const candidates = saved.value.candidates;
      if (candidates.length && candidates.every(v => ["completed", "failed"].includes(v.candidate.state))) {
        task.state = candidates.some(v => v.candidate.state === "completed") ? "ready" : "failed";
        if (task.state === "failed") task.errorCode = "SUPPLIER_GENERATION_FAILED";
      }
      for (const item of candidates) item.candidate.exportable = task.state === "ready" && item.candidate.state === "completed";
      musicCandidates(candidates.map(v => v.candidate), task.state === "ready");
    } else if (kind === "music-export") {
      const progress = await this.progress(saved.value.receipts[0], principal, signal);
      if (progress.status === "completed") this.audio(saved.value, await this.asset(saved.value.receipts[0], principal, signal));
      if (progress.status === "failed") { task.state = "failed"; task.errorCode = "SUPPLIER_EXPORT_FAILED"; }
    }
    return this.commitRefresh(key, saved, ref, kind, principal);
  }

  private async commitRefresh<K extends Kind>(key: string, saved: Saved, ref: CoursewareTaskRef, kind: K, principal: object): Promise<MediaTasks[K]> {
    try { await this.write(key, saved.value, saved.revision, principal); }
    catch (error) {
      if (!(error instanceof Error) || !(error.message.includes("COURSEWARE_MEDIA_JOURNAL_CONFLICT") || ("errorCode" in error && error.errorCode === "COURSEWARE_MEDIA_JOURNAL_CONFLICT"))) throw error;
      const committed = await this.read(key, principal);
      if (!committed || committed.value.projectId !== saved.value.projectId) throw error;
      return this.checked(committed, ref, kind);
    }
    return this.checked(saved, ref, kind);
  }

  async candidates(ref: CoursewareTaskRef, signal?: AbortSignal) {
    const principal = this.principal(), task = await this.get(ref, "music", signal);
    const saved = await this.read(`task:${ref.idempotencyKey}`, principal);
    if (!saved) throw invalid();
    const candidates = musicCandidates(saved.value.candidates.map(v => v.candidate), task.state === "ready");
    for (const item of saved.value.candidates) {
      if (!item.candidate.exportable) continue;
      const key = `candidate:${item.candidate.candidateId}`;
      const previous = await this.read(key, principal);
      if (!previous) {
        const value = { receipt: item.receipt, ...(saved.value.projectId ? { projectId: saved.value.projectId } : {}) };
        try { await this.write(key, value, 0, principal); }
        catch (error) {
          if (!(error instanceof Error) || !(error.message.includes("COURSEWARE_MEDIA_JOURNAL_CONFLICT") || ("errorCode" in error && error.errorCode === "COURSEWARE_MEDIA_JOURNAL_CONFLICT"))) throw error;
          const committed = await this.read(key, principal);
          if (JSON.stringify(committed?.value) !== JSON.stringify(value)) throw error;
        }
      }
    }
    return { task, candidates };
  }
  async preview(ref: CoursewareTaskRef, candidateId: string, signal?: AbortSignal) {
    const principal = this.principal(), collection = await this.candidates(ref, signal);
    const candidate = collection.candidates.find(v => v.candidateId === candidateId && v.exportable);
    if (!candidate) throw new Error("COURSEWARE_MEDIA_ASSET_NOT_READY");
    const saved = await this.read(`task:${ref.idempotencyKey}`, principal);
    const item = saved?.value.candidates.find(v => v.candidate.candidateId === candidateId);
    if (!item) throw invalid();
    const bytes = await this.asset(item.receipt, principal, signal);
    return { ...collection, candidate, bytes, preview: { mimeType: "audio/mpeg" as const, sha256: digest(bytes), byteLength: bytes.length } };
  }
  async download<K extends "tts" | "music-export">(ref: CoursewareTaskRef, kind: K, signal?: AbortSignal) {
    const principal = this.principal(), task = await this.get(ref, kind, signal);
    const saved = await this.read(`task:${ref.idempotencyKey}`, principal);
    if (task.state !== "ready" || !task.assetRef || !saved?.value.bytesBase64) throw new Error("COURSEWARE_MEDIA_ASSET_NOT_READY");
    const bytes = Buffer.from(saved.value.bytesBase64, "base64"); assertMusicMp3(bytes, task.assetRef.mime);
    if (bytes.length !== task.assetRef.byteLength || digest(bytes) !== task.assetRef.sha256) throw new Error("COURSEWARE_MEDIA_ASSET_INTEGRITY_ERROR");
    return { task, bytes };
  }
  private audio(saved: RecordValue, bytes: Buffer) {
    assertMusicMp3(bytes, "audio/mpeg");
    if (bytes.length > COURSEWARE_MAX_MEDIA_ASSET_BYTES || saved.task.kind === "music") throw invalid();
    saved.bytesBase64 = bytes.toString("base64");
    saved.task.assetRef = { assetId: `local-${randomUUID()}`, sha256: digest(bytes), mime: "audio/mpeg", byteLength: bytes.length,
      downloadPath: `/courseware/media/tasks/${saved.task.taskId}/asset` };
    saved.task.state = "ready";
  }
  private async progress(token: string, principal: object, signal?: AbortSignal) {
    if (!receipt(token)) throw invalid();
    const progress = await this.json(`/courseware/media/relay/query?${new URLSearchParams({ receipt: token })}`, principal, signal);
    if (!object(progress) || progress.success !== true || typeof progress.taskId !== "string" ||
        !["pending", "processing", "completed", "failed"].includes(String(progress.status)) ||
        (progress.durationSeconds !== undefined && (typeof progress.durationSeconds !== "number" || !Number.isFinite(progress.durationSeconds) ||
          progress.durationSeconds < 0 || progress.durationSeconds > Number.MAX_SAFE_INTEGER / 1000))) throw invalid();
    return progress as { status: MusicCandidate["state"]; durationSeconds?: number };
  }
  private async asset(token: string, principal: object, signal?: AbortSignal) {
    if (!receipt(token)) throw invalid();
    const response = await this.receive(`/courseware/media/relay/asset?${new URLSearchParams({ receipt: token })}`,
      principal, signal, COURSEWARE_MAX_MEDIA_ASSET_BYTES, {}, "audio/mpeg, application/json", 150_000);
    if (response.mime === "application/json") { mediaEnvelope(response.bytes); throw invalid(); }
    assertMusicMp3(response.bytes, response.mime);
    return response.bytes;
  }
}
