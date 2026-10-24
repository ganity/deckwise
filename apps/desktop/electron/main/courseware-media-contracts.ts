import { COURSEWARE_MAX_MEDIA_ASSET_BYTES, isCoursewareTaskRef, type CoursewareTaskRef } from "@pi-desktop/shared";

export type MediaKind = "tts" | "image" | "music" | "music-export";
export type MediaQuote<K extends MediaKind> = { version: "courseware-media-quote-v1"; kind: K; model: string;
  priceVersion: string; maxPoints: number; maxChars: number; expiresAt: string; quoteToken: string };
type AudioAsset = { assetId: string; sha256: string; mime: "audio/wav" | "audio/mpeg"; byteLength: number;
  downloadPath: string; durationMs?: number };
type ImageAsset = { assetId: string; sha256: string; mime: "image/png" | "image/jpeg" | "image/webp"; byteLength: number;
  downloadPath: string; width: number; height: number };
type TaskBase = CoursewareTaskRef & { version: "courseware-media-v1"; model: string;
  state: "queued" | "submitting" | "submission_unknown" | "submitted" | "archiving" | "archive_failed" | "ready" | "failed" | "cancelled";
  feeState: "reserved" | "settled" | "released"; reservedPoints: number; actualPoints: number | null;
  receiptId: string | null; errorCode: string | null };
export type MediaTasks = {
  tts: TaskBase & { kind: "tts"; assetRef: AudioAsset | null };
  image: TaskBase & { kind: "image"; assetRef: ImageAsset | null };
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
      !id(value.priceVersion) || !integer(value.maxPoints, 1_000_000) || value.maxPoints < 1 ||
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
  if (!exact(value, ["version", "taskId", "idempotencyKey", "requestHash", "kind", "model", "state", "feeState", "reservedPoints", "actualPoints", "receiptId", "errorCode", "assetRef"]) ||
      value.version !== "courseware-media-v1" || value.kind !== kind || !id(value.model) ||
      !id(value.taskId) || !isCoursewareTaskRef({ taskId: value.taskId, idempotencyKey: value.idempotencyKey, requestHash: value.requestHash }) ||
      value.idempotencyKey !== expected.idempotencyKey || value.requestHash !== expected.requestHash ||
      (expected.taskId !== undefined && value.taskId !== expected.taskId) || (expected.model !== undefined && value.model !== expected.model) ||
      !["queued", "submitting", "submission_unknown", "submitted", "archiving", "archive_failed", "ready", "failed", "cancelled"].includes(String(value.state)) ||
      !["reserved", "settled", "released"].includes(String(value.feeState)) || !integer(value.reservedPoints, 1_000_000) || value.reservedPoints < 1 ||
      (value.actualPoints !== null && !integer(value.actualPoints, value.reservedPoints)) ||
      (value.receiptId !== null && value.receiptId !== `courseware-media:${value.taskId}`) ||
      (value.errorCode !== null && (typeof value.errorCode !== "string" || !/^[A-Z0-9_]{1,128}$/u.test(value.errorCode)))) throw invalid();
  if (value.feeState === "settled" && (value.actualPoints === null || value.receiptId === null)) throw invalid();
  if (value.state === "ready") {
    const asset = value.assetRef;
    if (value.feeState !== "settled" || value.errorCode !== null) throw invalid();
    if (kind === "music") {
      if (asset !== null) throw invalid();
    } else {
      const audio = kind !== "image";
      if (!exact(asset, ["assetId", "sha256", "mime", "byteLength", "downloadPath"], audio ? ["durationMs"] : ["width", "height"]) ||
          !id(asset.assetId) || typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(asset.sha256) ||
          !(kind === "music-export" ? ["audio/mpeg"] : audio ? ["audio/wav", "audio/mpeg"] : ["image/png", "image/jpeg", "image/webp"]).includes(String(asset.mime)) ||
          !integer(asset.byteLength, COURSEWARE_MAX_MEDIA_ASSET_BYTES) || asset.byteLength < 1 ||
          asset.downloadPath !== `/courseware/media/tasks/${value.taskId}/asset` ||
          (audio && asset.durationMs !== undefined && !integer(asset.durationMs, Number.MAX_SAFE_INTEGER)) ||
          (!audio && (!integer(asset.width, 4096) || asset.width < 1 || !integer(asset.height, 4096) || asset.height < 1))) throw invalid();
    }
  } else if (value.assetRef !== null) throw invalid();
  return value as MediaTasks[K];
}
