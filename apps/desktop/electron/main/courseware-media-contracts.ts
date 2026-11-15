import { createHash } from "node:crypto";
import type { CoursewareImageRequest, CoursewareImageReference } from "./courseware-media";
import { COURSEWARE_MAX_MEDIA_ASSET_BYTES, isCoursewareTaskRef, type CoursewareTaskRef, type CoursewareUpstreamResponse } from "@pi-desktop/shared";

export type MediaKind = "tts" | "image" | "image-layers" | "video" | "music" | "music-export";
export type MediaQuote<K extends MediaKind> = { version: "courseware-media-quote-v1"; kind: K; model: string;
  priceVersion: string; maxPoints: number; maxChars: number; expiresAt: string; quoteToken: string };
type AudioAsset = { assetId: string; sha256: string; mime: "audio/wav" | "audio/mpeg"; byteLength: number;
  downloadPath: string; durationMs?: number };
type ImageAsset = { assetId: string; sha256: string; mime: "image/png" | "image/jpeg" | "image/webp"; byteLength: number;
  downloadPath: string; width: number; height: number };
type TaskBase = CoursewareTaskRef & { version: "courseware-media-v1"; model: string;
  state: "queued" | "submitting" | "submission_unknown" | "submitted" | "archiving" | "archive_failed" | "ready" | "failed" | "cancelled";
  feeState: "reserved" | "settled" | "released"; reservedPoints: number; actualPoints: number | null;
  receiptId: string | null; errorCode: string | null; upstreamResponse?: CoursewareUpstreamResponse };
export type MediaTasks = {
  video: TaskBase & { kind: "video"; assetRef: { assetId: string; sha256: string; mime: "video/mp4"; byteLength: number; downloadPath: string; durationMs?: number } | null };
  tts: TaskBase & { kind: "tts"; assetRef: AudioAsset | null };
  image: TaskBase & { kind: "image"; assetRef: ImageAsset | null };
  "image-layers": TaskBase & { kind: "image-layers"; assetRef: {
    assetId: string; sha256: string; mime: "application/vnd.trainwise.image-layers+json"; byteLength: number; downloadPath: string;
  } | null };
  music: TaskBase & { kind: "music"; assetRef: null };
  "music-export": TaskBase & { kind: "music-export"; assetRef: (AudioAsset & { mime: "audio/mpeg" }) | null };
};
export type MediaTaskExpectation = Pick<CoursewareTaskRef, "idempotencyKey" | "requestHash"> & { taskId?: string; model?: string };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> =>
  record(v) && required.every(key => Object.hasOwn(v, key)) && Object.keys(v).every(key => required.includes(key) || optional.includes(key));
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9._-]{1,128}$/u.test(v) && v !== "." && v !== "..";
const integer = (v: unknown, max: number): v is number => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= max;
const invalid = () => new Error("COURSEWARE_MEDIA_INVALID_RESPONSE");

export function mediaQuote<K extends MediaKind>(value: unknown, model: string, kind: K): MediaQuote<K> {
  if (!exact(value, ["version", "kind", "model", "priceVersion", "maxPoints", "maxChars", "expiresAt", "quoteToken"]) ||
      value.version !== "courseware-media-quote-v1" || value.kind !== kind || value.model !== model ||
      !id(value.priceVersion) || !integer(value.maxPoints, 1_000_000) || (value.maxPoints < 1 && kind !== "music-export") ||
      !integer(value.maxChars, 4000) || value.maxChars < 1 || typeof value.expiresAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value.expiresAt) ||
      !Number.isFinite(Date.parse(value.expiresAt)) || typeof value.quoteToken !== "string" ||
      !/^[0-9]{1,12}\.[A-Za-z0-9_-]{43}$/u.test(value.quoteToken) ||
      Number(value.quoteToken.split(".")[0]) * 1000 !== Date.parse(value.expiresAt)) throw invalid();
  if (Date.parse(value.expiresAt) <= Date.now()) throw new Error("COURSEWARE_MEDIA_QUOTE_EXPIRED");
  return { ...value } as MediaQuote<K>;
}

export function taskRef(value: unknown): CoursewareTaskRef {
  if (!isCoursewareTaskRef(value) || !id(value.taskId) || !/^[A-Za-z0-9._-]{1,96}$/u.test(value.idempotencyKey))
    throw new Error("COURSEWARE_MEDIA_INVALID_TASK_REF");
  return { taskId: value.taskId, idempotencyKey: value.idempotencyKey, requestHash: value.requestHash };
}

export function mediaTask<K extends MediaKind>(value: unknown, expected: MediaTaskExpectation, kind: K): MediaTasks[K] {
  if (!exact(value, ["version", "taskId", "idempotencyKey", "requestHash", "kind", "model", "state", "feeState", "reservedPoints", "actualPoints", "receiptId", "errorCode", "assetRef"], ["upstreamResponse"]) ||
      value.version !== "courseware-media-v1" || value.kind !== kind || !id(value.model) ||
      !id(value.taskId) || !isCoursewareTaskRef({ taskId: value.taskId, idempotencyKey: value.idempotencyKey, requestHash: value.requestHash }) ||
      value.idempotencyKey !== expected.idempotencyKey || value.requestHash !== expected.requestHash ||
      (expected.taskId !== undefined && value.taskId !== expected.taskId) || (expected.model !== undefined && value.model !== expected.model) ||
      !["queued", "submitting", "submission_unknown", "submitted", "archiving", "archive_failed", "ready", "failed", "cancelled"].includes(String(value.state)) ||
      !["reserved", "settled", "released"].includes(String(value.feeState)) || !integer(value.reservedPoints, 1_000_000) || (value.reservedPoints < 1 && kind !== "music-export") ||
      (value.actualPoints !== null && !integer(value.actualPoints, value.reservedPoints)) ||
      (value.receiptId !== null && value.receiptId !== `courseware-media:${value.taskId}`) ||
      (value.errorCode !== null && (typeof value.errorCode !== "string" || !/^[A-Z0-9_]{1,128}$/u.test(value.errorCode)))) throw invalid();
  if (value.upstreamResponse !== undefined) {
    const original = value.upstreamResponse;
    if (!["image", "image-layers"].includes(kind) || !exact(original, ["status", "contentType", "requestId", "body", "bodyEncoding", "truncated"]) ||
        !integer(original.status, 599) || original.status < 100 ||
        (original.contentType !== null && (typeof original.contentType !== "string" || original.contentType.length > 1024)) ||
        (original.requestId !== null && (typeof original.requestId !== "string" || original.requestId.length > 1024)) ||
        typeof original.body !== "string" || Buffer.byteLength(original.body, "utf8") > 24 * 1024 ||
        !["utf-8", "base64"].includes(String(original.bodyEncoding)) || typeof original.truncated !== "boolean") throw invalid();
  }
  if (value.feeState === "settled" && (value.actualPoints === null || value.receiptId === null)) throw invalid();
  if (value.state === "ready") {
    const asset = value.assetRef;
    if (value.feeState !== "settled" || value.errorCode !== null || value.upstreamResponse !== undefined) throw invalid();
    if (kind === "music") {
      if (asset !== null) throw invalid();
    } else {
      const layers = kind === "image-layers";
      const video = kind === "video";
      const audio = kind !== "image" && !layers && !video;
      if (!exact(asset, ["assetId", "sha256", "mime", "byteLength", "downloadPath"], audio || video ? ["durationMs"] : ["width", "height"]) ||
          !id(asset.assetId) || typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(asset.sha256) ||
          !(video ? ["video/mp4"] : layers ? ["application/vnd.trainwise.image-layers+json"] : kind === "music-export" ? ["audio/mpeg"] : audio ? ["audio/wav", "audio/mpeg"] : ["image/png", "image/jpeg", "image/webp"]).includes(String(asset.mime)) ||
          !integer(asset.byteLength, COURSEWARE_MAX_MEDIA_ASSET_BYTES) || asset.byteLength < 1 ||
          asset.downloadPath !== `/courseware/media/tasks/${value.taskId}/asset` ||
          ((audio || video) && asset.durationMs !== undefined && !integer(asset.durationMs, Number.MAX_SAFE_INTEGER)) ||
          (!audio && !layers && !video && (!integer(asset.width, 4096) || asset.width < 1 || !integer(asset.height, 4096) || asset.height < 1)) ||
          (layers && (asset.width !== undefined || asset.height !== undefined))) throw invalid();
    }
  } else if (value.assetRef !== null) throw invalid();
  return value as MediaTasks[K];
}

export function imageRequest(input: unknown): CoursewareImageRequest {
  if (!exact(input, ["kind", "model", "input"], ["referenceImage", "parameters"]) || !["image", "image-layers"].includes(String(input.kind)) || !id(input.model) ||
      typeof input.input !== "string" || !input.input.trim() || input.input.length > 4000 ||
      Buffer.from(input.input, "utf8").toString("utf8") !== input.input) throw new Error("COURSEWARE_MEDIA_INVALID_REQUEST");
  const ref = input.referenceImage;
  if (ref !== undefined) {
    if (!exact(ref, ["sha256", "mimeType", "byteLength", "bytesBase64"]) || typeof ref.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(ref.sha256) || !["image/png", "image/jpeg"].includes(String(ref.mimeType)) ||
        !integer(ref.byteLength, 8 * 1024 * 1024) || ref.byteLength < 1 || typeof ref.bytesBase64 !== "string" ||
        ref.bytesBase64.length > Math.ceil(8 * 1024 * 1024 / 3) * 4) throw new Error("COURSEWARE_MEDIA_INVALID_REQUEST");
    const bytes = Buffer.from(ref.bytesBase64, "base64");
    if (bytes.toString("base64") !== ref.bytesBase64 || bytes.length !== ref.byteLength ||
        createHash("sha256").update(bytes).digest("hex") !== ref.sha256 ||
        (ref.mimeType === "image/png" ? !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) :
          !(bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) && bytes.subarray(-2).equals(Buffer.from([255, 217])))))
      throw new Error("COURSEWARE_MEDIA_INVALID_REQUEST");
  }
  if (input.kind === "image-layers" && ref === undefined) throw new Error("COURSEWARE_MEDIA_REFERENCE_REQUIRED");
  const parameters = input.parameters;
  if (parameters !== undefined && (!record(parameters) || Object.keys(parameters).length < 1 ||
      Object.entries(parameters).some(([key, value]) => key === "watermark" ? typeof value !== "boolean" :
        !["quality", "image_size", "aspect_ratio", "resolution", "size", "output_format", "response_format"].includes(key) ||
        typeof value !== "string" || !value.length || value.length > 128 || /\p{Cc}/u.test(value))))
    throw new Error("COURSEWARE_MEDIA_INVALID_REQUEST");
  return { kind: input.kind as CoursewareImageRequest["kind"], model: input.model, input: input.input,
    ...(ref === undefined ? {} : { referenceImage: { ...ref } as CoursewareImageReference }),
    ...(parameters === undefined ? {} : { parameters: { ...parameters } }) };
}
