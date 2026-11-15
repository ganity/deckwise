import { createHash } from "node:crypto";
import type { CoursewareTaskRef } from "@pi-desktop/shared";
import type { CoursewareImageReference } from "./courseware-media";
import { mediaQuote, taskRef, type MediaQuote } from "./courseware-media-contracts";
import { CoursewareMediaTransport } from "./courseware-media-transport";

export type VideoRequest = { kind: "video"; model: string; input: string; referenceImage?: CoursewareImageReference; parameters?: Record<string, unknown> };
type VideoAsset = { assetId: string; sha256: string; mime: "video/mp4"; byteLength: number };
type VideoTask = CoursewareTaskRef & { version: "courseware-media-v1"; kind: "video"; model: string;
  state: "queued" | "submitting" | "submission_unknown" | "submitted" | "archiving" | "archive_failed" | "ready" | "failed" | "cancelled";
  feeState: "reserved" | "settled" | "released"; reservedPoints: number; actualPoints: number | null;
  receiptId: string | null; errorCode: string | null; assetRef: VideoAsset | null; videoUrl?: string; assetOrigin?: string };
const invalid = () => new Error("COURSEWARE_MEDIA_INVALID_RESPONSE");
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` :
  record(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
export function videoRequest(input: VideoRequest): VideoRequest {
  if (input.kind !== "video" || !/^[\w.-]{1,128}$/u.test(input.model) || typeof input.input !== "string" ||
      !input.input.trim() || input.input.length > 4000 || Buffer.from(input.input, "utf8").toString("utf8") !== input.input)
    throw new Error("COURSEWARE_MEDIA_INVALID_REQUEST");
  if (input.referenceImage) {
    const ref = input.referenceImage, bytes = Buffer.from(ref.bytesBase64, "base64");
    if (!/^[a-f0-9]{64}$/u.test(ref.sha256) || !["image/png", "image/jpeg"].includes(ref.mimeType) ||
        bytes.length !== ref.byteLength || bytes.length > 8 * 1024 * 1024 || bytes.toString("base64") !== ref.bytesBase64 ||
        createHash("sha256").update(bytes).digest("hex") !== ref.sha256) throw new Error("COURSEWARE_MEDIA_INVALID_REQUEST");
  }
  if (input.parameters !== undefined && (!record(input.parameters) || Object.keys(input.parameters).length > 64 ||
      Object.keys(input.parameters).some(key => ["model", "content", "kind", "input", "referenceImage"].includes(key)) ||
      Buffer.byteLength(JSON.stringify(input.parameters) ?? "") > 64 * 1024)) throw new Error("COURSEWARE_MEDIA_INVALID_REQUEST");
  return structuredClone(input);
}
export function videoRequestHash(input: VideoRequest): string {
  const body = videoRequest(input), fields: Array<string | null> = [body.kind, body.model, body.input, null];
  if (body.referenceImage) fields.push(body.referenceImage.sha256, body.referenceImage.mimeType, String(body.referenceImage.byteLength));
  if (body.parameters) fields.push(canonical(body.parameters));
  const preimage = "courseware-media-v1" + fields.map(field => field === null ? ":-1:" : `:${field.length}:${field}`).join("");
  return createHash("sha256").update(preimage).digest("hex");
}
function videoTask(value: unknown, expected: Pick<CoursewareTaskRef, "idempotencyKey" | "requestHash"> & { taskId?: string; model?: string }): VideoTask {
  if (!record(value) || Object.keys(value).some(key => !["version","taskId","idempotencyKey","requestHash","kind","model","state","feeState","reservedPoints","actualPoints","receiptId","errorCode","assetRef","videoUrl","assetOrigin"].includes(key)) ||
      value.version !== "courseware-media-v1" || value.kind !== "video" || typeof value.taskId !== "string" || !/^[\w.-]{1,128}$/u.test(value.taskId) ||
      value.idempotencyKey !== expected.idempotencyKey || value.requestHash !== expected.requestHash ||
      (expected.taskId !== undefined && value.taskId !== expected.taskId) || (expected.model !== undefined && value.model !== expected.model) ||
      typeof value.model !== "string" || !/^[\w.-]{1,128}$/u.test(value.model) ||
      !["queued","submitting","submission_unknown","submitted","archiving","archive_failed","ready","failed","cancelled"].includes(String(value.state)) ||
      !["reserved","settled","released"].includes(String(value.feeState)) || !Number.isSafeInteger(value.reservedPoints) || Number(value.reservedPoints) < 1 ||
      (value.actualPoints !== null && (!Number.isSafeInteger(value.actualPoints) || Number(value.actualPoints) < 0 || Number(value.actualPoints) > Number(value.reservedPoints))) ||
      (value.receiptId !== null && value.receiptId !== `courseware-media:${value.taskId}`) ||
      (value.errorCode !== null && (typeof value.errorCode !== "string" || !/^[A-Z0-9_]{1,128}$/u.test(value.errorCode))) || value.assetRef !== null ||
      (value.state === "ready" && (value.feeState !== "settled" || typeof value.videoUrl !== "string" || typeof value.assetOrigin !== "string")) ||
      (value.state !== "ready" && (value.videoUrl !== undefined || value.assetOrigin !== undefined))) throw invalid();
  if (typeof value.videoUrl === "string") {
    let url: URL;
    try { url = new URL(value.videoUrl); } catch { throw invalid(); }
    if (url.protocol !== "https:" || url.username || url.password || url.origin !== value.assetOrigin) throw invalid();
  }
  return { ...value, assetRef: null } as VideoTask;
}

/** User-authenticated llm-ha video tasks; only the Host downloads the supplier URL. */
export class CoursewareVideoMediaClient extends CoursewareMediaTransport {
  async models() {
    const value = await this.gatewayJson("/courseware/media/models?kind=video", this.principal());
    if (!Array.isArray(value) || value.length > 100 || value.some(row => !record(row) ||
      !/^[\w.-]{1,128}$/u.test(String(row.model)) || !Array.isArray(row.voices) || row.voices.length || row.providerDefaultVoice !== false ||
      typeof row.supportsReferenceImage !== "boolean" || Object.keys(row).sort().join(",") !== "model,providerDefaultVoice,supportsReferenceImage,voices") ||
      new Set(value.map(row => row.model)).size !== value.length) throw invalid();
    return value as Array<{ model: string; voices: string[]; providerDefaultVoice: false; supportsReferenceImage: boolean }>;
  }
  async quote(model: string, durationSeconds = 5) {
    if (!/^[\w.-]{1,128}$/u.test(model)) throw new Error("COURSEWARE_MEDIA_INVALID_REQUEST");
    if (!Number.isInteger(durationSeconds) || durationSeconds < 4 || durationSeconds > 30) throw new Error("COURSEWARE_MEDIA_INVALID_REQUEST");
    return mediaQuote(await this.gatewayJson(`/courseware/media/models/${model}/quote?kind=video&durationSeconds=${durationSeconds}`, this.principal()), model, "video");
  }
  async submit(key: string, input: VideoRequest, quote: MediaQuote<"video">, projectId?: string, check?: () => void | Promise<void>, admit?: () => Promise<string | undefined>, durationSeconds = 5) {
    const body = videoRequest(input), confirmed = mediaQuote(quote, body.model, "video"), principal = this.principal();
    if (!Number.isInteger(durationSeconds) || durationSeconds < 4 || durationSeconds > 30) throw new Error("COURSEWARE_MEDIA_INVALID_REQUEST");
    if (!/^[\w.-]{1,96}$/u.test(key) || body.input.length > confirmed.maxChars ||
        (projectId !== undefined && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(projectId))) throw new Error("COURSEWARE_MEDIA_INVALID_REQUEST");
    if (body.referenceImage && !(await this.models()).some(model => model.model === body.model && model.supportsReferenceImage))
      throw new Error("COURSEWARE_MEDIA_REFERENCE_UNSUPPORTED");
    this.assertPrincipal(principal);
    const ref = { idempotencyKey: key, requestHash: videoRequestHash(body) };
    return this.generate("video", principal, async () => {
      if (admit) projectId = await admit();
      this.assertPrincipal(principal);
      const base = projectId === undefined ? "/courseware/media/video/tasks/confirmed" :
        `/courseware/team/projects/${projectId}/video/tasks/confirmed`;
      const task = videoTask(await this.gatewayJson(base, principal, undefined, { method: "POST", headers: { "Idempotency-Key": key },
        body: JSON.stringify({ request: body, confirmation: { priceVersion: confirmed.priceVersion, maxPoints: confirmed.maxPoints, quoteToken: confirmed.quoteToken, durationSeconds } }) }),
        { ...ref, model: body.model });
      if (task.reservedPoints > confirmed.maxPoints) throw new Error("COURSEWARE_MEDIA_INVALID_RESPONSE");
      return task;
    }, () => this.find(ref), undefined, async () => { await check?.(); mediaQuote(confirmed, body.model, "video"); });
  }
  async get(reference: CoursewareTaskRef) {
    const ref = taskRef(reference);
    return videoTask(await this.gatewayJson(`/courseware/media/tasks/${ref.taskId}`, this.principal()), ref);
  }
  async find(reference: Pick<CoursewareTaskRef, "idempotencyKey" | "requestHash">) {
    if (!/^[\w.-]{1,96}$/u.test(reference.idempotencyKey) || !/^[a-f0-9]{64}$/u.test(reference.requestHash)) throw new Error("COURSEWARE_MEDIA_INVALID_TASK_REF");
    try { return videoTask(await this.gatewayJson("/courseware/media/tasks/by-idempotency?" + new URLSearchParams({ key: reference.idempotencyKey,
      requestHash: reference.requestHash }), this.principal()), reference); }
    catch (error) { if (error instanceof Error && error.message === "COURSEWARE_MEDIA_PLATFORM_46006") return null; throw error; }
  }
  async download(reference: CoursewareTaskRef) {
    const principal = this.principal(), task = await this.get(reference);
    this.assertPrincipal(principal);
    if (task.state !== "ready" || !task.videoUrl || !task.assetOrigin) throw new Error("COURSEWARE_MEDIA_ASSET_NOT_READY");
    const url = new URL(task.videoUrl);
    if (url.protocol !== "https:" || url.origin !== task.assetOrigin || url.username || url.password) throw new Error("COURSEWARE_MEDIA_INVALID_RESPONSE");
    const cancellation = AbortSignal.timeout(300_000);
    let response: Response;
    try { response = await this.options.fetch(url.toString(), { method: "GET", headers: { Accept: "video/mp4" }, cache: "no-store", credentials: "omit", redirect: "error", signal: cancellation }); }
    catch { this.assertPrincipal(principal); throw new Error("COURSEWARE_MEDIA_VIDEO_DOWNLOAD_FAILED"); }
    this.assertPrincipal(principal);
    if (!response.ok) throw new Error(`COURSEWARE_MEDIA_HTTP_${response.status}`);
    const mime = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (mime !== "video/mp4") throw new Error("COURSEWARE_MEDIA_ASSET_INTEGRITY_ERROR");
    const limit = 40 * 1024 * 1024, length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/u.test(length) || Number(length) > limit)) throw new Error("COURSEWARE_MEDIA_RESPONSE_TOO_LARGE");
    const reader = response.body?.getReader(); if (!reader) throw invalid();
    const chunks: Buffer[] = []; let size = 0;
    try {
      while (true) {
        const part = await reader.read(); this.assertPrincipal(principal); cancellation.throwIfAborted();
        if (part.done) break;
        size += part.value.byteLength; if (size > limit) throw new Error("COURSEWARE_MEDIA_RESPONSE_TOO_LARGE");
        chunks.push(Buffer.from(part.value));
      }
    } finally { try { await reader.cancel(); } catch {} reader.releaseLock(); }
    const bytes = Buffer.concat(chunks, size);
    if (bytes.length < 12 || bytes.toString("ascii", 4, 8) !== "ftyp") throw new Error("COURSEWARE_MEDIA_ASSET_INTEGRITY_ERROR");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return { task: { ...task, assetRef: { assetId: `video-${sha256}`, sha256, mime: "video/mp4" as const, byteLength: bytes.length } }, bytes };
  }
}
