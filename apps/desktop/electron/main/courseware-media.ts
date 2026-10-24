import { mediaQuote, mediaTask as task, taskRef, type MediaQuote, type MediaTasks } from "./courseware-media-contracts";
import { CoursewareMediaTransport, mediaEnvelope as envelope, mediaSubmissionPath as submissionPath, type CoursewareMediaOptions } from "./courseware-media-transport";
import { createHash } from "node:crypto";
import { CoursewareMusicMediaClient } from "./courseware-music-media";
import { COURSEWARE_MAX_MEDIA_ASSET_BYTES, isCoursewareTeamAssetRef, isCoursewareTeamMember, isCoursewareTeamProject, type CoursewareTaskRef, type CoursewareTeamAssetRef, type CoursewareTeamMember, type CoursewareTeamProject } from "@pi-desktop/shared";

export type CoursewareTtsRequest = { kind: "tts"; model: string; input: string; voice?: string | null };
export type CoursewareTtsQuote = MediaQuote<"tts">;
export type CoursewareImageQuote = MediaQuote<"image">;
export type CoursewareImageReference = { sha256: string; mimeType: "image/png" | "image/jpeg"; byteLength: number; bytesBase64: string };
export type CoursewareImageRequest = { kind: "image"; model: string; input: string; referenceImage?: CoursewareImageReference };
export type CoursewareTeamFixedFile = { path: string; sha256: string; mimeType: string; byteLength: number };
export type CoursewareTeamFixedPlayback = {
  pointer: { projectId: string; channel: string; buildId: string; snapshotId: string; packageSha256: string; version: number };
  fixedBuild: { build: { buildId: string; snapshotId: string; packageSha256: string };
    manifestSha256: string; files: Array<{ file: CoursewareTeamFixedFile; downloadUrl: string }>; expiresAt: string };
};
export type CoursewareBuildUpload = { manifestHash: string; manifestBytes: Uint8Array;
  files: Array<{ path: string; sha256: string; bytes: Uint8Array }> };
export type CoursewareFixedShareSelection = { projectId: string; snapshotId: string; buildId: string;
  manifestSha256: string; teamProjectId: string; channel: "shared" | "formal" };
export type CoursewareTtsTask = MediaTasks["tts"];
export type CoursewareImageTask = MediaTasks["image"];
export const MAX_AUDIO_BYTES = COURSEWARE_MAX_MEDIA_ASSET_BYTES;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> =>
  record(v) && required.every((key) => Object.hasOwn(v, key)) && Object.keys(v).every((key) => required.includes(key) || optional.includes(key));
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9._-]{1,128}$/u.test(v) && v !== "." && v !== "..";
const integer = (v: unknown, max: number): v is number => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= max;
const invalid = () => new Error("COURSEWARE_MEDIA_INVALID_RESPONSE");
const teamAssetPath = /^assets\/[a-f0-9]{64}\.[a-z0-9]{1,16}$/u;
const teamProjectId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;

function teamPlayback(value: unknown, projectId: string, channel: string): CoursewareTeamFixedPlayback {
  if (!exact(value, ["pointer", "fixedBuild"]) ||
      !exact(value.pointer, ["projectId", "channel", "buildId", "snapshotId", "packageSha256", "version"]) ||
      value.pointer.projectId !== projectId || value.pointer.channel !== channel || !id(value.pointer.buildId) ||
      !/^[a-f0-9]{64}$/u.test(String(value.pointer.buildId)) || value.pointer.packageSha256 !== value.pointer.buildId ||
      !id(value.pointer.snapshotId) || !integer(value.pointer.version, Number.MAX_SAFE_INTEGER) || value.pointer.version < 1 ||
      !exact(value.fixedBuild, ["build", "manifestSha256", "files", "expiresAt"]) ||
      !exact(value.fixedBuild.build, ["buildId", "snapshotId", "packageSha256"]) ||
      value.fixedBuild.build.buildId !== value.pointer.buildId || value.fixedBuild.build.snapshotId !== value.pointer.snapshotId ||
      value.fixedBuild.build.packageSha256 !== value.pointer.packageSha256 ||
      typeof value.fixedBuild.manifestSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.fixedBuild.manifestSha256) || !Array.isArray(value.fixedBuild.files) ||
      value.fixedBuild.files.length < 4 || value.fixedBuild.files.length > 4097 || typeof value.fixedBuild.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(value.fixedBuild.expiresAt)) || Date.parse(value.fixedBuild.expiresAt) <= Date.now() ||
      Date.parse(value.fixedBuild.expiresAt) > Date.now() + 5 * 60_000) throw invalid();
  const files = value.fixedBuild.files;
  const paths = new Set<string>();
  for (const entry of files) {
    if (!exact(entry, ["file", "downloadUrl"]) || !exact(entry.file, ["path", "sha256", "mimeType", "byteLength"]) ||
        typeof entry.file.path !== "string" || !( ["manifest.json", "package.json", "report.json", "source.pptx"].includes(entry.file.path) || teamAssetPath.test(entry.file.path)) ||
        paths.has(entry.file.path) || typeof entry.file.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(entry.file.sha256) ||
        typeof entry.file.mimeType !== "string" || entry.file.mimeType.length > 128 ||
        !integer(entry.file.byteLength, 256 * 1024 * 1024) ||
        (entry.file.path !== "manifest.json" && entry.file.byteLength < 1) || typeof entry.downloadUrl !== "string") throw invalid();
    const limit = entry.file.path === "manifest.json" ? 1024 * 1024 : entry.file.path === "package.json" ? 64 * 1024 * 1024 :
      entry.file.path === "report.json" ? 2 * 1024 * 1024 : entry.file.path === "source.pptx" ? 20 * 1024 * 1024 : 256 * 1024 * 1024;
    if (entry.file.byteLength > limit) throw invalid();
    const expectedMime = entry.file.path === "source.pptx" ? "application/vnd.openxmlformats-officedocument.presentationml.presentation" :
      ["manifest.json", "package.json", "report.json"].includes(entry.file.path) ? "application/json" : null;
    if ((expectedMime && entry.file.mimeType !== expectedMime) || (!expectedMime && !/^(audio|image|video)\/[\w.+-]+$/u.test(entry.file.mimeType))) throw invalid();
    const url = new URL(entry.downloadUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
        !(url.hostname === "aliyuncs.com" || url.hostname.endsWith(".aliyuncs.com")) || !url.search) throw invalid();
    paths.add(entry.file.path);
  }
  if (!["manifest.json", "package.json", "report.json", "source.pptx"].every((path) => paths.has(path)) ||
      files.find((entry) => entry.file.path === "manifest.json")?.file.sha256 !== value.fixedBuild.manifestSha256 ||
      files.find((entry) => entry.file.path === "package.json")?.file.sha256 !== value.pointer.buildId ||
      files.filter((entry) => teamAssetPath.test(entry.file.path)).reduce((sum, entry) => sum + entry.file.byteLength, 0) > 256 * 1024 * 1024) throw invalid();
  return structuredClone(value) as CoursewareTeamFixedPlayback;
}

function request(input: unknown): CoursewareTtsRequest {
  if (!exact(input, ["kind", "model", "input"], ["voice"]) || input.kind !== "tts" || !id(input.model) ||
      typeof input.input !== "string" || !input.input.trim() || input.input.length > 4000 ||
      Buffer.from(input.input, "utf8").toString("utf8") !== input.input ||
      (input.voice !== undefined && input.voice !== null && (typeof input.voice !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(input.voice)))) {
    throw new Error("COURSEWARE_MEDIA_INVALID_REQUEST");
  }
  return { kind: "tts", model: input.model, input: input.input, ...(input.voice !== undefined ? { voice: input.voice as string | null } : {}) };
}

function imageRequest(input: unknown): CoursewareImageRequest {
  if (!exact(input, ["kind", "model", "input"], ["referenceImage"]) || input.kind !== "image" || !id(input.model) ||
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
  return { kind: "image", model: input.model, input: input.input, ...(ref === undefined ? {} : { referenceImage: { ...ref } as CoursewareImageReference }) };
}

function requestHash(input: CoursewareTtsRequest | CoursewareImageRequest): string {
  const fields = [input.kind, input.model, input.input, input.kind === "tts" ? input.voice ?? null : null];
  if (input.kind === "image" && input.referenceImage) fields.push(input.referenceImage.sha256, input.referenceImage.mimeType, String(input.referenceImage.byteLength));
  const canonical = fields.reduce<string>((text, field) => `${text}:${field === null ? -1 : field.length}:${field ?? ""}`, "courseware-media-v1");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Main-only finite transport. Task persistence and teaching adoption belong to Host. */
export class CoursewareMediaClient extends CoursewareMediaTransport {
  readonly music: CoursewareMusicMediaClient;
  private readonly teamPlaybackOwners = new WeakMap<object, object>();
  private readonly teamPlaybackRefreshes = new WeakMap<object, CoursewareTeamFixedPlayback>();
  constructor(options: CoursewareMediaOptions) { super(options); this.music = new CoursewareMusicMediaClient(options); }

  /** Read-only offer; callers still need server-verified price binding before enabling submission. */
  async getTtsQuote(model: string, signal?: AbortSignal): Promise<CoursewareTtsQuote> {
    if (!id(model)) throw new Error("COURSEWARE_MEDIA_INVALID_REQUEST");
    const value = await this.json(`/courseware/media/models/${model}/quote?kind=tts`, this.principal(), signal);
    return mediaQuote(value, model, "tts");
  }

  async getTtsModels(signal?: AbortSignal): Promise<{ model: string; voices: string[]; providerDefaultVoice: boolean }[]> {
    return this.models("tts", signal);
  }

  async getImageQuote(model: string, signal?: AbortSignal): Promise<CoursewareImageQuote> {
    if (!id(model)) throw new Error("COURSEWARE_MEDIA_INVALID_REQUEST");
    const value = await this.json(`/courseware/media/models/${model}/quote?kind=image`, this.principal(), signal);
    return mediaQuote(value, model, "image");
  }

  async getImageModels(signal?: AbortSignal): Promise<{ model: string; voices: string[]; providerDefaultVoice: boolean; supportsReferenceImage?: boolean }[]> {
    return this.models("image", signal);
  }

  private async models(kind: "tts" | "image", signal?: AbortSignal): Promise<{ model: string; voices: string[]; providerDefaultVoice: boolean; supportsReferenceImage?: boolean }[]> {
    const value = await this.json(`/courseware/media/models?kind=${kind}`, this.principal(), signal);
    if (!Array.isArray(value) || value.length > 100 || value.some((entry) =>
      !exact(entry, ["model", "voices", "providerDefaultVoice"], kind === "image" ? ["supportsReferenceImage"] : []) || !id(entry.model) ||
      (entry.supportsReferenceImage !== undefined && typeof entry.supportsReferenceImage !== "boolean") ||
      typeof entry.providerDefaultVoice !== "boolean" || !Array.isArray(entry.voices) || entry.voices.length > 100 ||
      entry.voices.some((voice: unknown) => typeof voice !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(voice)) ||
      new Set(entry.voices).size !== entry.voices.length ||
      (kind === "image" && (entry.voices.length !== 0 || entry.providerDefaultVoice))) ||
      new Set(value.map((entry) => entry.model)).size !== value.length) throw invalid();
    return value;
  }

  async submitConfirmedTts(key: string, input: CoursewareTtsRequest, quote: CoursewareTtsQuote, signal?: AbortSignal, projectId?: string): Promise<CoursewareTtsTask> {
    if (typeof key !== "string" || !/^[A-Za-z0-9._-]{1,96}$/u.test(key)) throw new Error("COURSEWARE_MEDIA_INVALID_KEY");
    const body = request(input);
    const confirmed = mediaQuote(quote, body.model, "tts");
    if (body.input.length > confirmed.maxChars) throw new Error("COURSEWARE_MEDIA_INVALID_REQUEST");
    const result = await this.json(submissionPath(projectId, true), this.principal(), signal,
      { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify({ request: body,
        confirmation: { priceVersion: confirmed.priceVersion, maxPoints: confirmed.maxPoints, quoteToken: confirmed.quoteToken } }) });
    const saved = task(result, { idempotencyKey: key, requestHash: requestHash(body), model: body.model }, "tts");
    if (saved.reservedPoints > confirmed.maxPoints) throw invalid();
    return saved;
  }

  async submitTts(key: string, input: CoursewareTtsRequest, signal?: AbortSignal, projectId?: string): Promise<CoursewareTtsTask> {
    if (typeof key !== "string" || !/^[A-Za-z0-9._-]{1,96}$/u.test(key)) throw new Error("COURSEWARE_MEDIA_INVALID_KEY");
    const body = request(input);
    // Match Java UTF-16 lengths and UTF-8 bytes, including bilingual text and emoji.
    const hash = requestHash(body);
    const principal = this.principal();
    // A failed submit may already exist remotely; the owner must retain this key, never invent a retry key.
    const result = await this.json(submissionPath(projectId), principal, signal,
      { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify(body) });
    return task(result, { idempotencyKey: key, requestHash: hash, model: body.model }, "tts");
  }

  async submitImage(key: string, input: CoursewareImageRequest, signal?: AbortSignal, projectId?: string): Promise<CoursewareImageTask> {
    if (typeof key !== "string" || !/^[A-Za-z0-9._-]{1,96}$/u.test(key)) throw new Error("COURSEWARE_MEDIA_INVALID_KEY");
    const body = imageRequest(input);
    if (body.referenceImage) throw new Error("COURSEWARE_MEDIA_REFERENCE_CONFIRMATION_REQUIRED");
    const result = await this.json(submissionPath(projectId), this.principal(), signal,
      { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify(body) });
    return task(result, { idempotencyKey: key, requestHash: requestHash(body), model: body.model }, "image");
  }

  async submitConfirmedImage(key: string, input: CoursewareImageRequest, quote: CoursewareImageQuote, signal?: AbortSignal, projectId?: string): Promise<CoursewareImageTask> {
    if (typeof key !== "string" || !/^[A-Za-z0-9._-]{1,96}$/u.test(key)) throw new Error("COURSEWARE_MEDIA_INVALID_KEY");
    const body = imageRequest(input);
    const confirmed = mediaQuote(quote, body.model, "image");
    if (body.input.length > confirmed.maxChars) throw new Error("COURSEWARE_MEDIA_INVALID_REQUEST");
    const principal = this.principal();
    if (body.referenceImage && !(await this.getImageModels(signal)).some(entry => entry.model === body.model && entry.supportsReferenceImage === true))
      throw new Error("COURSEWARE_MEDIA_REFERENCE_UNSUPPORTED");
    const result = await this.json(submissionPath(projectId, true), principal, signal,
      { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify({ request: body,
        confirmation: { priceVersion: confirmed.priceVersion, maxPoints: confirmed.maxPoints, quoteToken: confirmed.quoteToken } }) });
    const saved = task(result, { idempotencyKey: key, requestHash: requestHash(body), model: body.model }, "image");
    if (saved.reservedPoints > confirmed.maxPoints) throw invalid();
    return saved;
  }

  async get(reference: CoursewareTaskRef, signal?: AbortSignal): Promise<CoursewareTtsTask> {
    const ref = taskRef(reference);
    return task(await this.json(`/courseware/media/tasks/${ref.taskId}`, this.principal(), signal), ref, "tts");
  }

  async findTts(reference: Pick<CoursewareTaskRef, "idempotencyKey" | "requestHash">, signal?: AbortSignal): Promise<CoursewareTtsTask | null> {
    return this.findTask(reference, "tts", signal);
  }

  async findImage(reference: Pick<CoursewareTaskRef, "idempotencyKey" | "requestHash">, signal?: AbortSignal): Promise<CoursewareImageTask | null> {
    return this.findTask(reference, "image", signal);
  }

  private findTask(reference: Pick<CoursewareTaskRef, "idempotencyKey" | "requestHash">, kind: "tts", signal?: AbortSignal): Promise<CoursewareTtsTask | null>;
  private findTask(reference: Pick<CoursewareTaskRef, "idempotencyKey" | "requestHash">, kind: "image", signal?: AbortSignal): Promise<CoursewareImageTask | null>;
  private async findTask(reference: Pick<CoursewareTaskRef, "idempotencyKey" | "requestHash">, kind: "tts" | "image", signal?: AbortSignal): Promise<CoursewareTtsTask | CoursewareImageTask | null> {
    if (!exact(reference, ["idempotencyKey", "requestHash"]) || typeof reference.idempotencyKey !== "string" ||
        !/^[A-Za-z0-9._-]{1,96}$/u.test(reference.idempotencyKey) || typeof reference.requestHash !== "string" ||
        !/^[a-f0-9]{64}$/u.test(reference.requestHash)) throw new Error("COURSEWARE_MEDIA_INVALID_TASK_REF");
    const expected = { idempotencyKey: reference.idempotencyKey, requestHash: reference.requestHash };
    const principal = this.principal();
    let result: unknown;
    try {
      result = await this.json("/courseware/media/tasks/by-idempotency?" + new URLSearchParams({ key: expected.idempotencyKey, requestHash: expected.requestHash }), principal, signal);
    } catch (error) {
      this.assertPrincipal(principal);
      if (error instanceof Error && error.message === "COURSEWARE_MEDIA_PLATFORM_46006") return null;
      throw error;
    }
    this.assertPrincipal(principal);
    return kind === "tts" ? task(result, expected, "tts") : task(result, expected, "image");
  }

  async getImage(reference: CoursewareTaskRef, signal?: AbortSignal): Promise<CoursewareImageTask> {
    const ref = taskRef(reference);
    return task(await this.json(`/courseware/media/tasks/${ref.taskId}`, this.principal(), signal), ref, "image");
  }

  async download(reference: CoursewareTaskRef, signal?: AbortSignal): Promise<{ task: CoursewareTtsTask; bytes: Buffer }> {
    const principal = this.principal();
    const current = await this.get(reference, signal);
    this.assertPrincipal(principal);
    if (current.state !== "ready" || !current.assetRef) throw new Error("COURSEWARE_MEDIA_ASSET_NOT_READY");
    const asset = current.assetRef;
    const result = await this.receive(`/courseware/media/tasks/${current.taskId}/asset`, principal, signal, MAX_AUDIO_BYTES);
    if (result.mime === "application/json") { envelope(result.bytes); throw invalid(); }
    if (result.mime !== asset.mime || result.bytes.length !== asset.byteLength ||
        createHash("sha256").update(result.bytes).digest("hex") !== asset.sha256) throw new Error("COURSEWARE_MEDIA_ASSET_INTEGRITY_ERROR");
    return { task: current, bytes: result.bytes };
  }

  async downloadImage(reference: CoursewareTaskRef, signal?: AbortSignal): Promise<{ task: CoursewareImageTask; bytes: Buffer }> {
    const principal = this.principal();
    const current = await this.getImage(reference, signal);
    this.assertPrincipal(principal);
    if (current.state !== "ready" || !current.assetRef) throw new Error("COURSEWARE_MEDIA_ASSET_NOT_READY");
    const asset = current.assetRef;
    const result = await this.receive(`/courseware/media/tasks/${current.taskId}/asset`, principal, signal, MAX_AUDIO_BYTES,
      {}, "application/json, image/png, image/jpeg, image/webp");
    if (result.mime === "application/json") { envelope(result.bytes); throw invalid(); }
    if (result.mime !== asset.mime || result.bytes.length !== asset.byteLength ||
        createHash("sha256").update(result.bytes).digest("hex") !== asset.sha256) throw new Error("COURSEWARE_MEDIA_ASSET_INTEGRITY_ERROR");
    return { task: current, bytes: result.bytes };
  }

  /** Explicitly share an existing owned archived task; never submit or charge a provider. */
  async adoptTeamAsset(projectId: string, reference: CoursewareTaskRef, signal?: AbortSignal): Promise<CoursewareTeamAssetRef> {
    const ref = taskRef(reference);
    if (!teamProjectId.test(projectId) || !teamProjectId.test(ref.taskId)) throw new Error("COURSEWARE_MEDIA_INVALID_TEAM_ASSET_REF");
    const principal = this.principal();
    const value = await this.json(`/courseware/team/projects/${projectId}/assets`, principal, signal,
      { method: "POST", body: JSON.stringify({ taskId: ref.taskId }) });
    this.assertPrincipal(principal);
    if (!isCoursewareTeamAssetRef(value) || value.projectId !== projectId) throw invalid();
    return structuredClone(value);
  }

  /** Read an already adopted immutable team asset; never generate, share or charge. */
  async getTeamAsset(projectId: string, assetId: string, signal?: AbortSignal): Promise<CoursewareTeamAssetRef> {
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
    if (!uuid.test(projectId) || !uuid.test(assetId)) throw new Error("COURSEWARE_MEDIA_INVALID_TEAM_ASSET_REF");
    const value = await this.json(`/courseware/team/projects/${projectId}/assets/${assetId}`, this.principal(), signal);
    if (!isCoursewareTeamAssetRef(value) || value.projectId !== projectId || value.assetRef.assetId !== assetId) throw invalid();
    return structuredClone(value);
  }

  async getTeamProjects(signal?: AbortSignal): Promise<CoursewareTeamProject[]> {
    const value = await this.json("/courseware/team/projects", this.principal(), signal);
    if (!Array.isArray(value) || value.length > 1000 || !value.every(isCoursewareTeamProject)) throw invalid();
    return structuredClone(value);
  }

  async getTeamMembers(projectId: string, signal?: AbortSignal): Promise<CoursewareTeamMember[]> {
    if (!teamProjectId.test(projectId)) throw new Error("COURSEWARE_MEDIA_INVALID_TEAM_PROJECT");
    const principal = this.principal();
    const value = await this.json("/courseware/team/projects/" + projectId + "/members", principal, signal);
    if (!Array.isArray(value) || value.length > 1000 || !value.every(isCoursewareTeamMember)) throw invalid();
    this.assertPrincipal(principal);
    return structuredClone(value);
  }

  async createTeamProject(signal?: AbortSignal): Promise<string> {
    const principal = this.principal();
    const value = await this.json("/courseware/team/projects", principal, signal, { method: "POST", body: "{}" });
    if (!exact(value, ["projectId"]) || !teamProjectId.test(String(value.projectId))) throw invalid();
    this.assertPrincipal(principal);
    return value.projectId as string;
  }

  async grantTeamMember(projectId: string, userId: number, role: "EDITOR" | "VIEWER", signal?: AbortSignal): Promise<void> {
    if (!teamProjectId.test(projectId) || !Number.isSafeInteger(userId) || userId <= 0 || !["EDITOR", "VIEWER"].includes(role)) {
      throw new Error("COURSEWARE_MEDIA_INVALID_TEAM_MEMBER");
    }
    const principal = this.principal();
    const value = await this.json("/courseware/team/projects/" + projectId + "/members", principal, signal,
      { method: "PUT", body: JSON.stringify({ userId, role }) });
    if (value !== null) throw invalid();
    this.assertPrincipal(principal);
  }

  async revokeTeamMember(projectId: string, userId: number, signal?: AbortSignal): Promise<void> {
    if (!teamProjectId.test(projectId) || !Number.isSafeInteger(userId) || userId <= 0) {
      throw new Error("COURSEWARE_MEDIA_INVALID_TEAM_MEMBER");
    }
    const principal = this.principal();
    const value = await this.json("/courseware/team/projects/" + projectId + "/members/" + userId, principal, signal,
      { method: "DELETE" });
    if (value !== null) throw invalid();
    this.assertPrincipal(principal);
  }

  async uploadAndPublishFixedBuild(projectId: string, snapshotId: string, buildId: string,
    upload: CoursewareBuildUpload, channel: "shared" | "formal" = "shared", signal?: AbortSignal, intentId?: string): Promise<void> {
    if (channel !== "shared" && channel !== "formal") throw new Error("COURSEWARE_MEDIA_INVALID_TEAM_CHANNEL");
    if (intentId !== undefined && !teamProjectId.test(intentId)) throw new Error("COURSEWARE_MEDIA_INVALID_TEAM_BUILD");
    if (!teamProjectId.test(projectId) || !id(snapshotId) || !/^[a-f0-9]{64}$/u.test(buildId) ||
        !/^[a-f0-9]{64}$/u.test(upload.manifestHash) || !upload.files.length || upload.files.length > 4096) throw new Error("COURSEWARE_MEDIA_INVALID_TEAM_BUILD");
    const principal = this.principal();
    const form = new FormData();
    form.append("manifest", new Blob([Buffer.from(upload.manifestBytes)], { type: "application/json" }), "manifest.json");
    for (const file of upload.files) form.append("files", new Blob([Buffer.from(file.bytes)], { type: file.path === "source.pptx" ?
      "application/vnd.openxmlformats-officedocument.presentationml.presentation" : "application/octet-stream" }), file.path);
    const query = new URLSearchParams({ buildId, snapshotId, manifestSha256: upload.manifestHash });
    const stored = await this.json(`/courseware/team/projects/${projectId}/fixed-builds?${query}`, principal, signal,
      { method: "POST", body: form }, 10 * 60_000);
    if (!exact(stored, ["buildId", "snapshotId", "packageSha256"]) || stored.buildId !== buildId ||
        stored.snapshotId !== snapshotId || stored.packageSha256 !== buildId) throw invalid();
    const pointer = await this.json(`/courseware/team/projects/${projectId}/publish/${channel}`, principal, signal);
    if (!exact(pointer, ["projectId", "channel", "buildId", "snapshotId", "packageSha256", "version"]) ||
        pointer.projectId !== projectId || pointer.channel !== channel ||
        (pointer.buildId !== null && !/^[a-f0-9]{64}$/u.test(String(pointer.buildId))) ||
        (pointer.snapshotId !== null && !id(pointer.snapshotId)) ||
        (pointer.packageSha256 !== null && pointer.packageSha256 !== pointer.buildId) ||
        ((pointer.buildId === null) !== (pointer.snapshotId === null)) ||
        ((pointer.buildId === null) !== (pointer.packageSha256 === null)) ||
        !integer(pointer.version, Number.MAX_SAFE_INTEGER) ||
        (pointer.buildId === null ? pointer.version !== 0 : pointer.version < 1)) throw invalid();
    if (!intentId && pointer.buildId === buildId && pointer.snapshotId === snapshotId && pointer.packageSha256 === buildId) {
      this.assertPrincipal(principal);
      return;
    }
    const published = await this.json(`/courseware/team/projects/${projectId}/publish`, principal, signal,
      { method: "POST", body: JSON.stringify({ channel, buildId, expectedVersion: pointer.version, ...(intentId ? { intentId } : {}) }) });
    if (!exact(published, ["projectId", "channel", "buildId", "snapshotId", "packageSha256", "version"]) ||
        published.projectId !== projectId || published.channel !== channel || published.buildId !== buildId ||
        published.snapshotId !== snapshotId || published.packageSha256 !== buildId || published.version !== pointer.version + 1) throw invalid();
    this.assertPrincipal(principal);
  }

  async getTeamFixedPlayback(projectId: string, channel: "shared" | "formal" = "shared", signal?: AbortSignal): Promise<CoursewareTeamFixedPlayback> {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(projectId)) throw new Error("COURSEWARE_MEDIA_INVALID_TEAM_PROJECT");
    if (channel !== "shared" && channel !== "formal") throw new Error("COURSEWARE_MEDIA_INVALID_TEAM_CHANNEL");
    const principal = this.principal();
    const value = teamPlayback(await this.json(`/courseware/team/projects/${projectId}/publish/${channel}/fixed-playback`, principal, signal), projectId, channel);
    this.assertPrincipal(principal);
    this.teamPlaybackOwners.set(value, principal);
    return value;
  }

  /** Recovery never publishes: a receipt proves the original publication even after the channel advances. */
  async queryFixedBuildPublication(selection: CoursewareFixedShareSelection, signal?: AbortSignal, intentId?: string): Promise<void> {
    if (!exact(selection, ["projectId", "snapshotId", "buildId", "manifestSha256", "teamProjectId", "channel"]) ||
        !id(selection.projectId) || !id(selection.snapshotId) || !teamProjectId.test(selection.teamProjectId) ||
        !/^[a-f0-9]{64}$/u.test(selection.buildId) || !/^[a-f0-9]{64}$/u.test(selection.manifestSha256) ||
        !["shared", "formal"].includes(selection.channel)) throw new Error("COURSEWARE_MEDIA_INVALID_TEAM_BUILD");
    if (intentId !== undefined && !teamProjectId.test(intentId)) throw new Error("COURSEWARE_MEDIA_INVALID_TEAM_BUILD");
    const expected = { ...selection }, principal = this.principal();
    const fixedBuild = await this.json(`/courseware/team/projects/${expected.teamProjectId}/fixed-builds/${expected.buildId}`, principal, signal);
    const pointer = { projectId: expected.teamProjectId, channel: expected.channel, buildId: expected.buildId,
      snapshotId: expected.snapshotId, packageSha256: expected.buildId, version: 1 };
    const stored = teamPlayback({ pointer, fixedBuild }, expected.teamProjectId, expected.channel);
    if (stored.fixedBuild.manifestSha256 !== expected.manifestSha256) throw new Error("COURSEWARE_MEDIA_TEAM_SHARE_NOT_CONFIRMED");
    if (intentId) {
      const receipt = await this.json(`/courseware/team/projects/${expected.teamProjectId}/publish/receipts/${intentId}`, principal, signal);
      if (!exact(receipt, ["intentId", "expectedVersion", "pointer"]) || receipt.intentId !== intentId ||
          !integer(receipt.expectedVersion, Number.MAX_SAFE_INTEGER - 1) ||
          !exact(receipt.pointer, ["projectId", "channel", "buildId", "snapshotId", "packageSha256", "version"]) ||
          receipt.pointer.projectId !== pointer.projectId || receipt.pointer.channel !== pointer.channel ||
          receipt.pointer.buildId !== pointer.buildId || receipt.pointer.snapshotId !== pointer.snapshotId ||
          receipt.pointer.packageSha256 !== pointer.packageSha256 || receipt.pointer.version !== receipt.expectedVersion + 1)
        throw new Error("COURSEWARE_MEDIA_TEAM_SHARE_NOT_CONFIRMED");
      this.assertPrincipal(principal);
      return;
    }
    const current = await this.json(`/courseware/team/projects/${expected.teamProjectId}/publish/${expected.channel}`, principal, signal);
    if (!exact(current, ["projectId", "channel", "buildId", "snapshotId", "packageSha256", "version"]) ||
        current.projectId !== pointer.projectId || current.channel !== pointer.channel || current.buildId !== pointer.buildId ||
        current.snapshotId !== pointer.snapshotId || current.packageSha256 !== pointer.packageSha256 ||
        !integer(current.version, Number.MAX_SAFE_INTEGER) || current.version < 1)
      throw new Error("COURSEWARE_MEDIA_TEAM_SHARE_NOT_CONFIRMED");
    this.assertPrincipal(principal);
  }

  async downloadTeamFixedFile(playback: CoursewareTeamFixedPlayback, path: string, signal?: AbortSignal): Promise<Buffer> {
    if (!playback || this.teamPlaybackOwners.get(playback) !== this.options.getPrincipal()) throw new Error("COURSEWARE_MEDIA_AUTH_CHANGED");
    if (typeof path !== "string" || !/^(manifest\.json|package\.json|report\.json|source\.pptx|assets\/[a-f0-9]{64}\.[a-z0-9]{1,16})$/u.test(path)) throw new Error("COURSEWARE_MEDIA_INVALID_TEAM_FILE");
    let selected = this.teamPlaybackRefreshes.get(playback) ?? playback;
    let renewed = false;
    const renew = async (renewalSignal?: AbortSignal) => {
      const refreshed = await this.getTeamFixedPlayback(playback.pointer.projectId,
        playback.pointer.channel === "formal" ? "formal" : "shared", renewalSignal);
      if (JSON.stringify(refreshed.pointer) !== JSON.stringify(playback.pointer) ||
          JSON.stringify(refreshed.fixedBuild.files.map(({ file }) => file)) !== JSON.stringify(playback.fixedBuild.files.map(({ file }) => file)))
        throw new Error("COURSEWARE_MEDIA_TEAM_PLAYBACK_CHANGED");
      this.teamPlaybackRefreshes.set(playback, refreshed);
      selected = refreshed;
      renewed = true;
    };
    if (Date.parse(selected.fixedBuild.expiresAt) <= Date.now() + 5_000) await renew(signal);
    let entry = selected.fixedBuild.files.find((item) => item.file.path === path);
    if (!entry || Date.parse(selected.fixedBuild.expiresAt) <= Date.now()) throw new Error("COURSEWARE_MEDIA_TEAM_PLAYBACK_EXPIRED");
    const principal = this.options.getPrincipal();
    if (!principal || this.teamPlaybackOwners.get(playback) !== principal) throw new Error("COURSEWARE_MEDIA_AUTH_CHANGED");
    const cancellation = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
    cancellation.throwIfAborted();
    let response: Response;
    while (true) {
      this.assertPrincipal(principal);
      cancellation.throwIfAborted();
      try {
        response = await this.options.fetch(entry.downloadUrl, { method: "GET", headers: { Accept: entry.file.mimeType },
          cache: "no-store", credentials: "omit", redirect: "error", signal: cancellation });
      } catch {
        throw new Error(cancellation.aborted ? "COURSEWARE_MEDIA_WAIT_CANCELLED" : "COURSEWARE_MEDIA_TRANSPORT_FAILED");
      }
      if (response.ok) break;
      if (!renewed && (response.status === 401 || response.status === 403) &&
          Date.parse(selected.fixedBuild.expiresAt) <= Date.now()) {
        try { await response.body?.cancel(); } catch { /* The renewed request owns the next response. */ }
        this.assertPrincipal(principal);
        cancellation.throwIfAborted();
        await renew(cancellation);
        entry = selected.fixedBuild.files.find((item) => item.file.path === path);
        if (!entry || Date.parse(selected.fixedBuild.expiresAt) <= Date.now()) throw new Error("COURSEWARE_MEDIA_TEAM_PLAYBACK_EXPIRED");
        continue;
      }
      throw new Error(`COURSEWARE_MEDIA_HTTP_${response.status}`);
    }
    const mime = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (mime !== entry.file.mimeType) throw new Error("COURSEWARE_MEDIA_ASSET_INTEGRITY_ERROR");
    const reader = response.body?.getReader();
    if (!reader) throw invalid();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d+$/u.test(length) || Number(length) !== entry.file.byteLength)) throw new Error("COURSEWARE_MEDIA_ASSET_INTEGRITY_ERROR");
      while (true) {
        const next = await reader.read();
        cancellation.throwIfAborted();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > entry.file.byteLength) throw new Error("COURSEWARE_MEDIA_RESPONSE_TOO_LARGE");
        chunks.push(Buffer.from(next.value));
      }
    } finally {
      try { await reader.cancel(); } catch { /* Keep the original read failure. */ }
      reader.releaseLock();
    }
    const bytes = Buffer.concat(chunks, size);
    if (bytes.length !== entry.file.byteLength || createHash("sha256").update(bytes).digest("hex") !== entry.file.sha256) throw new Error("COURSEWARE_MEDIA_ASSET_INTEGRITY_ERROR");
    if (this.options.getPrincipal() !== principal) throw new Error("COURSEWARE_MEDIA_AUTH_CHANGED");
    return bytes;
  }

  async downloadTeamAsset(reference: CoursewareTeamAssetRef, signal?: AbortSignal): Promise<{ reference: CoursewareTeamAssetRef; bytes: Buffer }> {
    if (!isCoursewareTeamAssetRef(reference)) throw new Error("COURSEWARE_MEDIA_INVALID_TEAM_ASSET_REF");
    const pinned = structuredClone(reference);
    const principal = this.principal();
    const path = `/courseware/team/projects/${pinned.projectId}/assets/${pinned.assetRef.assetId}`;
    const current = await this.json(path, principal, signal);
    if (!isCoursewareTeamAssetRef(current) || current.projectId !== pinned.projectId ||
        Object.keys(pinned.assetRef).some(key => current.assetRef[key as keyof typeof current.assetRef] !== pinned.assetRef[key as keyof typeof pinned.assetRef]) ||
        Object.keys(current.assetRef).length !== Object.keys(pinned.assetRef).length) throw new Error("COURSEWARE_MEDIA_ASSET_INTEGRITY_ERROR");
    const result = await this.receive(`${path}/content`, principal, signal, COURSEWARE_MAX_MEDIA_ASSET_BYTES, {}, `application/json, ${pinned.assetRef.mime}`);
    if (result.mime === "application/json") { envelope(result.bytes); throw invalid(); }
    if (result.mime !== pinned.assetRef.mime || result.bytes.length !== pinned.assetRef.byteLength ||
        createHash("sha256").update(result.bytes).digest("hex") !== pinned.assetRef.sha256) throw new Error("COURSEWARE_MEDIA_ASSET_INTEGRITY_ERROR");
    return { reference: pinned, bytes: result.bytes };
  }

}
