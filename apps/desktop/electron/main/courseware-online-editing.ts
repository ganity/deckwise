import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { COURSEWARE_MAX_BYTES, isCoursewareProject, isTeachingWrite, isCoursewareOnlineSourceMapping, isCoursewareAttentionCue,
  type CoursewareOnlineNativeBarrier, type CoursewareOnlineLaunch, type CoursewareOnlineSession, type CoursewareProject, type TeachingWrite,
  type CoursewareOnlineSourceMapping, type CoursewareOnlineTeachingMapping } from "@pi-desktop/shared";
import { validateOfficeBytes } from "./office-file";

export const COURSEWARE_ONLINE_MAX_SOURCE_BYTES = 20 * 1024 * 1024;
export type CoursewareOnlineSourceVersion = {
  projectId: string;
  source: { revision: string; sha256: string };
  byteLength: number;
  requestId: string;
  sessionEpoch: number | null;
  callbackId: string | null;
};
export type CoursewareOnlineUploadInput = {
  requestId: string;
  expectedSourceRevision?: string;
  sourceSha256: string;
  bytes: Buffer;
  filename: string;
};
export type CoursewareOnlineTeachingVersion = { project: CoursewareProject; mappingRevision: string };
export type CoursewareOnlineTeachingInitializeInput = {
  requestId: string; mappingRevision: string; project: CoursewareProject; mapping?: CoursewareOnlineSourceMapping;
};
export type CoursewareOnlineLeaseProof = { sessionEpoch: number; leaseEpoch: number; leaseToken: string };
/** Main-only lease authority. Never expose the raw token to an application renderer. */
export type CoursewareOnlinePageLease = CoursewareOnlineLeaseProof & { projectId: string; pageId: string; expiresAtEpochMillis: number };
export type CoursewareOnlineTeachingWriteInput = { requestId: string; lease: CoursewareOnlineLeaseProof; write: TeachingWrite };
export type CoursewareOnlineWritePause = {
  projectId: string; sessionEpoch: number; pauseId: string; state: "held" | "released";
  teaching: CoursewareOnlineTeachingVersion;
};
export type CoursewareOnlineForceSave = {
  requestId: string; key: string; sessionEpoch: number;
  state: "submitting" | "command_unknown" | "pending" | "no_changes" | "rejected" | "archived" | "failed" | "session_closed";
  commandError: number | null; callbackId: string | null;
};
/** Main-only authorized archive location. Never forward downloadUrl to an application renderer. */
export type CoursewareOnlineCallbackArchive = {
  receipt: { callbackId: string; key: string; sessionEpoch: number; documentStatus: 2 | 6;
    state: "archived"; sha256: string; byteLength: number };
  downloadUrl: string;
};
export type CoursewareOnlineSourceReviewInput = {
  requestId: string; sessionEpoch: number; pauseId: string; forceSaveRequestId: string;
  expectedSourceRevision: string; expectedTeachingRevision: string;
  project: CoursewareProject; mapping: CoursewareOnlineSourceMapping;
};
export type CoursewareOnlineVerifiedSourceReviewInput = CoursewareOnlineSourceReviewInput & { barrierId: string };
export type CoursewareOnlineSourceReview = {
  snapshotId: string; sessionEpoch: number; forceSaveRequestId: string; callbackId: string; sourceByteLength: number;
  baselineSourceRevision: string; baselineTeachingRevision: string;
  teaching: CoursewareOnlineTeachingVersion; mapping: CoursewareOnlineSourceMapping;
};
/** Main-only point-in-time observation. Never forward documentKey to an application renderer. */
export type CoursewareOnlineDocsCoverage = {
  projectId: string; sessionEpoch: number; barrierId: string; pauseId: string; documentKey: string;
  verifiedAtEpochMillis: number; docsUsers: string[]; coverage: "supported-deckwise-mounts";
  authoritativeCoverage: boolean; consistentPublicationReady: false; reasons: string[];
};

type Principal = { tenantId: number; userId: number };
type Options = {
  baseUrl: string;
  fetch: typeof fetch;
  resolveAccessToken(): Promise<string>;
  getPrincipal(): Principal | null;
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const id = (value: unknown): value is string => typeof value === "string" && /^[\w.-]{1,128}$/u.test(value);
const sha256 = /^[a-f0-9]{64}$/u;
const key = /^[A-Za-z0-9_.=-]{1,128}$/u;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: unknown, names: string[]): value is Record<string, unknown> => record(value) &&
  Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const epoch = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const invalid = () => new Error("COURSEWARE_ONLINE_INVALID_RESPONSE");
const invalidRequest = () => new Error("COURSEWARE_ONLINE_INVALID_REQUEST");
const teachingResponseBytes = COURSEWARE_MAX_BYTES + 4096;
const positiveEpoch = (value: unknown): value is number => epoch(value) && value > 0;
const proof = (value: unknown): value is CoursewareOnlineLeaseProof => exact(value, ["sessionEpoch", "leaseEpoch", "leaseToken"]) &&
  positiveEpoch(value.sessionEpoch) && positiveEpoch(value.leaseEpoch) && typeof value.leaseToken === "string" && uuid.test(value.leaseToken);

function teachingInput<T>(value: T): T {
  try {
    const snapshot = structuredClone(value), json = JSON.stringify(snapshot);
    if (typeof json !== "string" || Buffer.byteLength(json, "utf8") > COURSEWARE_MAX_BYTES ||
        !isDeepStrictEqual(snapshot, JSON.parse(json))) throw invalidRequest();
    return snapshot;
  } catch { throw invalidRequest(); }
}

function teachingVersion(value: unknown, projectId: string): CoursewareOnlineTeachingVersion {
  if (!exact(value, ["project", "mappingRevision"]) || !id(value.mappingRevision) || !isCoursewareProject(value.project) ||
      value.project.projectId !== projectId || !uuid.test(value.project.source.revision) || !sha256.test(value.project.source.sha256)) throw invalid();
  return structuredClone(value) as CoursewareOnlineTeachingVersion;
}

function pageLease(value: unknown, projectId: string, pageId: string, sessionEpoch: number): CoursewareOnlinePageLease {
  if (!exact(value, ["projectId", "pageId", "sessionEpoch", "leaseEpoch", "leaseToken", "expiresAtEpochMillis"]) ||
      value.projectId !== projectId || value.pageId !== pageId || value.sessionEpoch !== sessionEpoch ||
      !positiveEpoch(value.leaseEpoch) || typeof value.leaseToken !== "string" || !uuid.test(value.leaseToken) ||
      !epoch(value.expiresAtEpochMillis) || value.expiresAtEpochMillis <= Date.now() || value.expiresAtEpochMillis > Date.now() + 120_000) throw invalid();
  return structuredClone(value) as CoursewareOnlinePageLease;
}

function writePause(value: unknown, projectId: string, sessionEpoch: number, pauseId?: string): CoursewareOnlineWritePause {
  if (!exact(value, ["projectId", "sessionEpoch", "pauseId", "state", "teaching"]) || value.projectId !== projectId ||
      value.sessionEpoch !== sessionEpoch || typeof value.pauseId !== "string" || !uuid.test(value.pauseId) ||
      pauseId !== undefined && value.pauseId !== pauseId || value.state !== "held" && value.state !== "released") throw invalid();
  teachingVersion(value.teaching, projectId);
  return structuredClone(value) as CoursewareOnlineWritePause;
}

function forceSave(value: unknown, sessionEpoch: number, requestId: string, documentKey: string): CoursewareOnlineForceSave {
  if (!exact(value, ["requestId", "key", "sessionEpoch", "state", "commandError", "callbackId"]) || value.requestId !== requestId ||
      value.key !== documentKey || value.sessionEpoch !== sessionEpoch || typeof value.state !== "string" ||
      !["submitting", "command_unknown", "pending", "no_changes", "rejected", "archived", "failed", "session_closed"].includes(value.state) ||
      !(value.commandError === null || Number.isInteger(value.commandError) && Number(value.commandError) >= 0 && Number(value.commandError) <= 6) ||
      (value.state === "archived" || value.state === "failed" ? typeof value.callbackId !== "string" || !sha256.test(value.callbackId) : value.callbackId !== null) ||
      ["submitting", "command_unknown"].includes(value.state) && value.commandError !== null ||
      value.state === "pending" && value.commandError !== 0 || value.state === "no_changes" && value.commandError !== 4 ||
      value.state === "rejected" && ![1, 2, 3, 5, 6].includes(Number(value.commandError))) throw invalid();
  return structuredClone(value) as CoursewareOnlineForceSave;
}

function callbackArchive(value: unknown, sessionEpoch: number, callbackId: string, documentKey: string): CoursewareOnlineCallbackArchive {
  if (!exact(value, ["receipt", "downloadUrl"]) || !exact(value.receipt,
    ["callbackId", "key", "sessionEpoch", "documentStatus", "state", "sha256", "byteLength"])) throw invalid();
  const receipt = value.receipt;
  if (receipt.callbackId !== callbackId || receipt.key !== documentKey || receipt.sessionEpoch !== sessionEpoch ||
      ![2, 6].includes(Number(receipt.documentStatus)) || typeof receipt.documentStatus !== "number" || receipt.state !== "archived" ||
      typeof receipt.sha256 !== "string" || !sha256.test(receipt.sha256) || !positiveEpoch(receipt.byteLength) ||
      receipt.byteLength > COURSEWARE_ONLINE_MAX_SOURCE_BYTES) throw invalid();
  officeArchiveUrl(value.downloadUrl);
  return structuredClone(value) as CoursewareOnlineCallbackArchive;
}

function officeArchiveUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 8192 || /[\u0000-\u0020\u007f]/u.test(value)) throw invalid();
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash || !(url.protocol === "https:" || url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) throw invalid();
  } catch { throw invalid(); }
  return value;
}

function reviewedMapping(project: CoursewareProject, mapping: unknown): mapping is CoursewareOnlineSourceMapping {
  return isCoursewareOnlineSourceMapping(mapping) && mapping.sourceSha256 === project.source.sha256 &&
    mapping.pages.length === project.pages.length && mapping.pages.every((page, index) => {
      const teaching = project.pages[index]!;
      const objects = new Set(page.objects.map(object => object.objectId));
      return page.pageId === teaching.pageId && teaching.actions.every(action => {
        if (Object.hasOwn(action, "audioId") || Object.hasOwn(action, "audioUrl") ||
            ["highlight", "spotlight"].includes(String(action.type)) ||
            action.type === "audio_clip" && !Object.hasOwn(action, "audioAssetId") ||
            Object.hasOwn(action, "audioAssetId") && (typeof action.audioAssetId !== "string" || !uuid.test(action.audioAssetId))) return false;
        if (!Object.hasOwn(action, "visualCues")) return true;
        if (action.type !== "speech" || !Array.isArray(action.visualCues) || action.visualCues.length > 200) return false;
        const cueIds = new Set<string>();
        return action.visualCues.every(cue => {
          if (!isCoursewareAttentionCue(cue) || cueIds.has(cue.id) ||
              cue.effect.type === "highlight" && Object.hasOwn(cue.effect, "style") && typeof cue.effect.style !== "string") return false;
          cueIds.add(cue.id);
          const targets = cue.effect.type === "highlight" ? cue.effect.elementIds : [cue.effect.elementId, ...(cue.effect.elementIds ?? [])];
          return targets.every(target => objects.has(target));
        });
      });
    });
}

function sourceReview(value: unknown, projectId: string, snapshotId: string): CoursewareOnlineSourceReview {
  if (!exact(value, ["snapshotId", "sessionEpoch", "forceSaveRequestId", "callbackId", "sourceByteLength",
    "baselineSourceRevision", "baselineTeachingRevision", "teaching", "mapping"]) || value.snapshotId !== snapshotId ||
      !positiveEpoch(value.sessionEpoch) || typeof value.forceSaveRequestId !== "string" || !uuid.test(value.forceSaveRequestId) ||
      typeof value.callbackId !== "string" || !sha256.test(value.callbackId) || !positiveEpoch(value.sourceByteLength) ||
      value.sourceByteLength > COURSEWARE_ONLINE_MAX_SOURCE_BYTES || typeof value.baselineSourceRevision !== "string" ||
      !uuid.test(value.baselineSourceRevision) || value.baselineSourceRevision === snapshotId ||
      typeof value.baselineTeachingRevision !== "string" || !uuid.test(value.baselineTeachingRevision)) throw invalid();
  const teaching = teachingVersion(value.teaching, projectId);
  if (teaching.project.source.revision !== snapshotId || !uuid.test(teaching.project.teachingRevision) ||
      teaching.project.teachingRevision === value.baselineTeachingRevision || !reviewedMapping(teaching.project, value.mapping) ||
      teaching.mappingRevision !== value.mapping.revision) throw invalid();
  return structuredClone(value) as CoursewareOnlineSourceReview;
}

function sourceVersion(value: unknown, projectId: string): CoursewareOnlineSourceVersion {
  if (!exact(value, ["projectId", "source", "byteLength", "requestId", "sessionEpoch", "callbackId"]) ||
      value.projectId !== projectId || !exact(value.source, ["revision", "sha256"]) ||
      typeof value.source.revision !== "string" || !uuid.test(value.source.revision) ||
      typeof value.source.sha256 !== "string" || !sha256.test(value.source.sha256) ||
      typeof value.requestId !== "string" || !uuid.test(value.requestId) || !epoch(value.byteLength) ||
      value.byteLength < 1 || value.byteLength > COURSEWARE_ONLINE_MAX_SOURCE_BYTES ||
      !(value.sessionEpoch === null && value.callbackId === null ||
        epoch(value.sessionEpoch) && value.sessionEpoch > 0 && typeof value.callbackId === "string" && sha256.test(value.callbackId))) throw invalid();
  return structuredClone(value) as unknown as CoursewareOnlineSourceVersion;
}

function session(value: unknown, projectId: string): CoursewareOnlineSession {
  if (!exact(value, ["projectId", "epoch", "sessionId", "active"]) || value.projectId !== projectId || !epoch(value.epoch) ||
      typeof value.active !== "boolean" || !(value.sessionId === null || (typeof value.sessionId === "string" && key.test(value.sessionId))) ||
      (value.active && (value.epoch < 1 || value.sessionId === null))) throw invalid();
  return structuredClone(value) as unknown as CoursewareOnlineSession;
}

function launch(value: unknown, expected: CoursewareOnlineSession, principal: Principal, clientId?: string): CoursewareOnlineLaunch {
  if (!record(value) || !exact(value, ["projectId", "sessionEpoch", "source", "documentKey", "docsUserId", "configJson", "expiresAtEpochMillis",
        ...(Object.hasOwn(value, "clientId") ? ["clientId"] : [])]) ||
      value.clientId !== undefined && value.clientId !== clientId ||
      value.projectId !== expected.projectId || value.sessionEpoch !== expected.epoch || value.documentKey !== expected.sessionId ||
      value.docsUserId !== `tenant-${principal.tenantId}-user-${principal.userId}${value.clientId === undefined ? "" : `-client-${clientId}`}` ||
      !exact(value.source, ["revision", "sha256"]) || typeof value.source.revision !== "string" || !uuid.test(value.source.revision) ||
      typeof value.source.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.source.sha256) ||
      typeof value.configJson !== "string" || value.configJson.length > 65_536 ||
      !epoch(value.expiresAtEpochMillis) || value.expiresAtEpochMillis <= Date.now() || value.expiresAtEpochMillis > Date.now() + 120_000) throw invalid();
  let config: unknown, claims: unknown;
  try {
    config = JSON.parse(value.configJson);
    if (!record(config) || typeof config.token !== "string" ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(config.token)) throw invalid();
    claims = JSON.parse(Buffer.from(config.token.split(".")[1], "base64url").toString("utf8"));
  } catch { throw invalid(); }
  if (!record(config) || !record(claims) || config.documentType !== "slide" || !record(config.document) ||
      config.document.key !== expected.sessionId || config.document.fileType !== "pptx" || !record(config.editorConfig) ||
      !record(config.editorConfig.user) || config.editorConfig.user.id !== value.docsUserId ||
      claims.documentType !== config.documentType || !isDeepStrictEqual(claims.document, config.document) ||
      !isDeepStrictEqual(claims.editorConfig, config.editorConfig) || claims.exp !== value.expiresAtEpochMillis / 1000) throw invalid();
  // This is binding/payload consistency only. Docs must verify the native browser JWT.
  if (!record(config.document.permissions) || config.document.permissions.edit !== true || config.editorConfig.mode !== "edit")
    throw new Error("COURSEWARE_ONLINE_READ_ONLY");
  return structuredClone(value) as unknown as CoursewareOnlineLaunch;
}

const nativeClientStates = new Set(["awaiting", "draining", "held", "uncertain", "resumed", "stale", "revoked", "unavailable", "disconnected"]);
function nativeBarrier(value: unknown, projectId: string, sessionEpoch: number, barrierId?: string): CoursewareOnlineNativeBarrier {
  if (!exact(value, ["projectId", "sessionEpoch", "barrierId", "pauseId", "state", "coverage", "allRegisteredClientsHeld", "authoritativeCoverage",
      "consistentPublicationReady", "proof", "clients", "reasons"]) || value.projectId !== projectId || value.sessionEpoch !== sessionEpoch ||
      typeof value.barrierId !== "string" || !uuid.test(value.barrierId) || barrierId !== undefined && value.barrierId !== barrierId ||
      typeof value.pauseId !== "string" || !uuid.test(value.pauseId) || !["draining", "held", "released"].includes(String(value.state)) ||
      !["managed", "unmanaged"].includes(String(value.coverage)) || typeof value.allRegisteredClientsHeld !== "boolean" ||
      value.authoritativeCoverage !== false || value.consistentPublicationReady !== false || value.proof !== "client-reported" ||
      !Array.isArray(value.clients) || value.clients.length > 1000 || !Array.isArray(value.reasons) || value.reasons.length > 1000 ||
      !value.reasons.every(reason => typeof reason === "string" && /^[A-Z0-9_]{1,128}$/u.test(reason))) throw invalid();
  const seen = new Set<string>();
  for (const client of value.clients) {
    if (!exact(client, ["clientId", "docsUserId", "state", "nativeReady", "lastSeenEpochMillis"]) ||
        typeof client.clientId !== "string" || !uuid.test(client.clientId) || seen.has(client.clientId) ||
        typeof client.docsUserId !== "string" || !new RegExp(`^tenant-[1-9]\\d*-user-[1-9]\\d*-client-${client.clientId}$`, "u").test(client.docsUserId) ||
        !nativeClientStates.has(String(client.state)) || typeof client.nativeReady !== "boolean" || client.lastSeenEpochMillis !== null && !epoch(client.lastSeenEpochMillis)) throw invalid();
    seen.add(client.clientId);
  }
  return structuredClone(value) as unknown as CoursewareOnlineNativeBarrier;
}

function docsCoverage(value: unknown, projectId: string, sessionEpoch: number, barrierId: string): CoursewareOnlineDocsCoverage {
  if (!exact(value, ["projectId", "sessionEpoch", "barrierId", "pauseId", "documentKey", "verifiedAtEpochMillis", "docsUsers", "coverage",
      "authoritativeCoverage", "consistentPublicationReady", "reasons"]) || value.projectId !== projectId || value.sessionEpoch !== sessionEpoch ||
      value.barrierId !== barrierId || typeof value.pauseId !== "string" || !uuid.test(value.pauseId) ||
      typeof value.documentKey !== "string" || !key.test(value.documentKey) || !positiveEpoch(value.verifiedAtEpochMillis) ||
      value.coverage !== "supported-deckwise-mounts" || typeof value.authoritativeCoverage !== "boolean" || value.consistentPublicationReady !== false ||
      !Array.isArray(value.docsUsers) || value.docsUsers.length > 1000 ||
      !value.docsUsers.every(user => typeof user === "string" && /^[A-Za-z0-9_.-]{1,128}$/u.test(user)) ||
      new Set(value.docsUsers).size !== value.docsUsers.length || !Array.isArray(value.reasons) || value.reasons.length > 1000 ||
      !value.reasons.every(reason => typeof reason === "string" && /^[A-Z0-9_]{1,128}$/u.test(reason)) ||
      new Set(value.reasons).size !== value.reasons.length || value.authoritativeCoverage !== (value.reasons.length === 0) ||
      value.authoritativeCoverage && (value.docsUsers.length === 0 || !value.docsUsers.every(user =>
        /^tenant-[1-9]\d*-user-[1-9]\d*-client-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(user)))) throw invalid();
  return structuredClone(value) as unknown as CoursewareOnlineDocsCoverage;
}

/** Main-only authenticated transport; never retries session creation or invents a local key. */
export class CoursewareOnlineEditingClient {
  private readonly baseUrl: string;
  constructor(private readonly options: Options) {
    const url = new URL(options.baseUrl);
    if (!(url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) ||
        url.username || url.password || url.search || url.hash) throw new Error("COURSEWARE_ONLINE_INVALID_BASE_URL");
    this.baseUrl = url.href.replace(/\/+$/u, "");
  }

  async current(projectId: string, signal?: AbortSignal): Promise<CoursewareOnlineSession> {
    return session(await this.request(this.path(projectId), this.principal(), signal), projectId);
  }

  async currentSource(projectId: string, signal?: AbortSignal): Promise<CoursewareOnlineSourceVersion | null> {
    try {
      return sourceVersion(await this.request(`${this.projectPath(projectId)}/sources/current`, this.principal(), signal), projectId);
    } catch (error) {
      if (error instanceof Error && error.message === "COURSEWARE_ONLINE_PLATFORM_46402") return null;
      throw error;
    }
  }

  async currentWritePause(projectId: string, sessionEpoch: number, signal?: AbortSignal): Promise<CoursewareOnlineWritePause | null> {
    const path = `${this.publicationPath(projectId, sessionEpoch)}/write-pauses/current`;
    const value = await this.request(path, this.principal(), signal, undefined, { maxResponseBytes: teachingResponseBytes, allowNull: true });
    if (value === null) return null;
    const result = writePause(value, projectId, sessionEpoch);
    if (result.state !== "held") throw invalid();
    return result;
  }

  async pauseWrites(projectId: string, sessionEpoch: number, pauseId: string, signal?: AbortSignal): Promise<CoursewareOnlineWritePause> {
    const path = `${this.publicationRequestPath(projectId, sessionEpoch, pauseId)}/write-pauses`;
    return writePause(await this.request(path, this.principal(), signal, { pauseId }, { maxResponseBytes: teachingResponseBytes }), projectId, sessionEpoch, pauseId);
  }

  async getWritePause(projectId: string, sessionEpoch: number, pauseId: string, signal?: AbortSignal): Promise<CoursewareOnlineWritePause> {
    const path = `${this.publicationRequestPath(projectId, sessionEpoch, pauseId)}/write-pauses/${pauseId}`;
    return writePause(await this.request(path, this.principal(), signal, undefined, { maxResponseBytes: teachingResponseBytes }), projectId, sessionEpoch, pauseId);
  }

  async resumeWrites(projectId: string, sessionEpoch: number, pauseId: string, signal?: AbortSignal): Promise<CoursewareOnlineWritePause> {
    const path = `${this.publicationRequestPath(projectId, sessionEpoch, pauseId)}/write-pauses/${pauseId}`;
    const result = writePause(await this.request(path, this.principal(), signal, undefined,
      { method: "DELETE", maxResponseBytes: teachingResponseBytes }), projectId, sessionEpoch, pauseId);
    if (result.state !== "released") throw invalid();
    return result;
  }

  async requestForceSave(projectId: string, sessionEpoch: number, requestId: string, documentKey: string, signal?: AbortSignal): Promise<CoursewareOnlineForceSave> {
    const path = `${this.forceSavePath(projectId, sessionEpoch, requestId, documentKey)}/force-saves`;
    return forceSave(await this.request(path, this.principal(), signal, { requestId }), sessionEpoch, requestId, documentKey);
  }

  async getForceSave(projectId: string, sessionEpoch: number, requestId: string, documentKey: string, signal?: AbortSignal): Promise<CoursewareOnlineForceSave> {
    const path = `${this.forceSavePath(projectId, sessionEpoch, requestId, documentKey)}/force-saves/${requestId}`;
    return forceSave(await this.request(path, this.principal(), signal), sessionEpoch, requestId, documentKey);
  }

  async getCallbackArchive(projectId: string, sessionEpoch: number, callbackId: string, documentKey: string, signal?: AbortSignal): Promise<CoursewareOnlineCallbackArchive> {
    const path = this.publicationPath(projectId, sessionEpoch);
    if (typeof callbackId !== "string" || !sha256.test(callbackId) || typeof documentKey !== "string" || !key.test(documentKey)) throw invalidRequest();
    return callbackArchive(await this.request(`${path}/callbacks/${callbackId}/archive`, this.principal(), signal), sessionEpoch, callbackId, documentKey);
  }

  /** Main-only immutable bytes. Storage receives no Platform credentials and cannot choose a caller-supplied URL. */
  async downloadCallbackArchive(projectId: string, sessionEpoch: number, callbackId: string, documentKey: string, signal?: AbortSignal):
    Promise<{ receipt: CoursewareOnlineCallbackArchive["receipt"]; bytes: Buffer }> {
    const principal = this.principal();
    const archive = await this.getCallbackArchive(projectId, sessionEpoch, callbackId, documentKey, signal);
    return { receipt: archive.receipt, bytes: await this.downloadOfficeBytes(archive.downloadUrl, archive.receipt, principal, signal) };
  }

  /** Main-only original revision. Resolves its archive URL on Platform, never from a renderer. */
  async downloadSource(projectId: string, sourceRevision: string, signal?: AbortSignal): Promise<{ version: CoursewareOnlineSourceVersion; bytes: Buffer }> {
    const path = this.projectPath(projectId);
    if (typeof sourceRevision !== "string" || !uuid.test(sourceRevision)) throw invalidRequest();
    const principal = this.principal();
    const value = await this.request(`${path}/sources/${sourceRevision}/download`, principal, signal);
    if (!exact(value, ["version", "downloadUrl"])) throw invalid();
    const version = sourceVersion(value.version, projectId);
    if (version.source.revision !== sourceRevision) throw invalid();
    const downloadUrl = officeArchiveUrl(value.downloadUrl);
    return { version, bytes: await this.downloadOfficeBytes(downloadUrl, { byteLength: version.byteLength, sha256: version.source.sha256 }, principal, signal) };
  }

  private async downloadOfficeBytes(downloadUrl: string, expected: { byteLength: number; sha256: string }, principal: Principal, signal?: AbortSignal): Promise<Buffer> {
    this.assertCurrent(principal);
    const cancellation = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
    cancellation.throwIfAborted();
    const response = await this.options.fetch(downloadUrl, { method: "GET", cache: "no-store", credentials: "omit",
      redirect: "error", signal: cancellation });
    const reader = response.body?.getReader();
    try {
      this.assertCurrent(principal);
      cancellation.throwIfAborted();
      if (!response.ok) throw new Error(`COURSEWARE_ONLINE_HTTP_${response.status}`);
      if (!reader) throw invalid();
      const declared = response.headers.get("content-length");
      if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) !== expected.byteLength)) throw invalid();
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const next = await reader.read();
        this.assertCurrent(principal);
        cancellation.throwIfAborted();
        if (next.done) break;
        length += next.value.byteLength;
        if (length > expected.byteLength || length > COURSEWARE_ONLINE_MAX_SOURCE_BYTES) throw invalid();
        chunks.push(next.value);
      }
      const bytes = Buffer.concat(chunks);
      if (length !== expected.byteLength || createHash("sha256").update(bytes).digest("hex") !== expected.sha256) throw invalid();
      try { validateOfficeBytes(bytes, "pptx"); } catch { throw invalid(); }
      return bytes;
    } finally {
      await reader?.cancel().catch(() => {});
      this.assertCurrent(principal);
      cancellation.throwIfAborted();
    }
  }

  async captureSourceReview(projectId: string, input: CoursewareOnlineSourceReviewInput, signal?: AbortSignal): Promise<CoursewareOnlineSourceReview> {
    return this.captureReview(projectId, input, `${this.projectPath(projectId)}/teaching/source-reviews`, signal);
  }

  async captureVerifiedSourceReview(projectId: string, input: CoursewareOnlineVerifiedSourceReviewInput, signal?: AbortSignal): Promise<CoursewareOnlineSourceReview> {
    if (!record(input) || typeof input.barrierId !== "string" || !uuid.test(input.barrierId)) throw invalidRequest();
    const { barrierId, ...review } = input;
    return this.captureReview(projectId, review, `${this.projectPath(projectId)}/teaching/verified-source-reviews`, signal, barrierId);
  }

  private async captureReview(projectId: string, input: CoursewareOnlineSourceReviewInput, path: string, signal?: AbortSignal,
    barrierId?: string): Promise<CoursewareOnlineSourceReview> {
    if (!exact(input, ["requestId", "sessionEpoch", "pauseId", "forceSaveRequestId", "expectedSourceRevision", "expectedTeachingRevision", "project", "mapping"]) ||
        typeof input.requestId !== "string" || !uuid.test(input.requestId) || !positiveEpoch(input.sessionEpoch) ||
        typeof input.pauseId !== "string" || !uuid.test(input.pauseId) || typeof input.forceSaveRequestId !== "string" || !uuid.test(input.forceSaveRequestId) ||
        typeof input.expectedSourceRevision !== "string" || !uuid.test(input.expectedSourceRevision) || input.expectedSourceRevision === input.requestId ||
        typeof input.expectedTeachingRevision !== "string" || !uuid.test(input.expectedTeachingRevision) ||
        !isCoursewareProject(input.project) || input.project.projectId !== projectId || input.project.source.revision !== input.requestId ||
        input.project.teachingRevision !== input.expectedTeachingRevision || !sha256.test(input.project.source.sha256) ||
        !reviewedMapping(input.project, input.mapping)) throw invalidRequest();
    const snapshot = teachingInput(input);
    const result = sourceReview(await this.request(path, this.principal(), signal, barrierId === undefined ? snapshot : { ...snapshot, barrierId },
      { maxResponseBytes: teachingResponseBytes }), projectId, snapshot.requestId);
    if (result.sessionEpoch !== snapshot.sessionEpoch || result.forceSaveRequestId !== snapshot.forceSaveRequestId ||
        result.baselineSourceRevision !== snapshot.expectedSourceRevision || result.baselineTeachingRevision !== snapshot.expectedTeachingRevision ||
        !isDeepStrictEqual(result.mapping, snapshot.mapping) ||
        !isDeepStrictEqual(result.teaching.project, { ...snapshot.project, teachingRevision: result.teaching.project.teachingRevision })) throw invalid();
    return result;
  }

  async getSourceReview(projectId: string, snapshotId: string, signal?: AbortSignal): Promise<CoursewareOnlineSourceReview> {
    const path = this.projectPath(projectId);
    if (typeof snapshotId !== "string" || !uuid.test(snapshotId)) throw invalidRequest();
    return sourceReview(await this.request(`${path}/teaching/source-reviews/${snapshotId}`, this.principal(), signal, undefined,
      { maxResponseBytes: teachingResponseBytes }), projectId, snapshotId);
  }

  async getVerifiedSourceReview(projectId: string, snapshotId: string, signal?: AbortSignal): Promise<CoursewareOnlineSourceReview> {
    const path = this.projectPath(projectId);
    if (typeof snapshotId !== "string" || !uuid.test(snapshotId)) throw invalidRequest();
    return sourceReview(await this.request(`${path}/teaching/verified-source-reviews/${snapshotId}`, this.principal(), signal, undefined,
      { maxResponseBytes: teachingResponseBytes }), projectId, snapshotId);
  }

  async currentTeaching(projectId: string, signal?: AbortSignal): Promise<CoursewareOnlineTeachingVersion | null> {
    try {
      return teachingVersion(await this.request(`${this.projectPath(projectId)}/teaching`, this.principal(), signal, undefined,
        { maxResponseBytes: teachingResponseBytes }), projectId);
    } catch (error) {
      if (error instanceof Error && error.message === "COURSEWARE_ONLINE_PLATFORM_46606") return null;
      throw error;
    }
  }

  async initializeTeaching(projectId: string, input: CoursewareOnlineTeachingInitializeInput, signal?: AbortSignal): Promise<CoursewareOnlineTeachingVersion> {
    const path = `${this.projectPath(projectId)}/teaching`;
    if (!exact(input, ["requestId", "mappingRevision", "project", ...(record(input) && Object.hasOwn(input, "mapping") ? ["mapping"] : [])]) || typeof input.requestId !== "string" || !uuid.test(input.requestId) ||
        !id(input.mappingRevision) || !isCoursewareProject(input.project) || input.project.projectId !== projectId ||
        !uuid.test(input.project.source.revision) || !sha256.test(input.project.source.sha256) ||
        Object.hasOwn(input, "mapping") && (!isCoursewareOnlineSourceMapping(input.mapping) || input.mapping.revision !== input.mappingRevision ||
          input.mapping.sourceSha256 !== input.project.source.sha256 || input.mapping.pages.length !== input.project.pages.length ||
          !input.mapping.pages.every((page, index) => page.pageId === input.project.pages[index]!.pageId))) throw invalidRequest();
    const snapshot = teachingInput(input);
    const value = teachingVersion(await this.request(path, this.principal(), signal, snapshot,
      { maxResponseBytes: teachingResponseBytes }), projectId);
    if (value.mappingRevision !== snapshot.mappingRevision ||
        !isDeepStrictEqual(value.project, { ...snapshot.project, teachingRevision: value.project.teachingRevision })) throw invalid();
    return value;
  }

  async getTeachingMapping(projectId: string, sourceRevision: string, mappingRevision: string, signal?: AbortSignal): Promise<CoursewareOnlineTeachingMapping> {
    const path = this.projectPath(projectId);
    if (typeof sourceRevision !== "string" || !uuid.test(sourceRevision) || !id(mappingRevision) || [".", ".."].includes(mappingRevision)) throw invalidRequest();
    const value = await this.request(`${path}/teaching/mappings/${mappingRevision}?sourceRevision=${sourceRevision}`, this.principal(), signal,
      undefined, { maxResponseBytes: teachingResponseBytes });
    if (!exact(value, ["projectId", "source", "mapping"]) || value.projectId !== projectId ||
        !exact(value.source, ["revision", "sha256"]) || value.source.revision !== sourceRevision ||
        !isCoursewareOnlineSourceMapping(value.mapping) || value.mapping.revision !== mappingRevision ||
        value.source.sha256 !== value.mapping.sourceSha256) throw invalid();
    return structuredClone(value) as CoursewareOnlineTeachingMapping;
  }

  async acquirePageLease(projectId: string, pageId: string, sessionEpoch: number, signal?: AbortSignal): Promise<CoursewareOnlinePageLease> {
    const path = this.leasePath(projectId, pageId);
    if (!positiveEpoch(sessionEpoch)) throw invalidRequest();
    return pageLease(await this.request(path, this.principal(), signal, { sessionEpoch }), projectId, pageId, sessionEpoch);
  }

  async renewPageLease(projectId: string, pageId: string, input: CoursewareOnlineLeaseProof, signal?: AbortSignal): Promise<CoursewareOnlinePageLease> {
    const path = this.leasePath(projectId, pageId);
    if (!proof(input)) throw invalidRequest();
    const snapshot = { ...input };
    const value = pageLease(await this.request(path, this.principal(), signal, snapshot, { method: "PUT" }), projectId, pageId, snapshot.sessionEpoch);
    if (value.leaseEpoch !== snapshot.leaseEpoch || value.leaseToken !== snapshot.leaseToken) throw invalid();
    return value;
  }

  async releasePageLease(projectId: string, pageId: string, input: CoursewareOnlineLeaseProof, signal?: AbortSignal): Promise<void> {
    const path = this.leasePath(projectId, pageId);
    if (!proof(input)) throw invalidRequest();
    if (await this.request(path, this.principal(), signal, { ...input }, { method: "DELETE", allowNull: true }) !== null) throw invalid();
  }

  async writeTeaching(projectId: string, input: CoursewareOnlineTeachingWriteInput, signal?: AbortSignal): Promise<CoursewareOnlineTeachingVersion> {
    const path = `${this.projectPath(projectId)}/teaching/writes`;
    if (!exact(input, ["requestId", "lease", "write"]) || typeof input.requestId !== "string" || !uuid.test(input.requestId) ||
        !proof(input.lease) || !isTeachingWrite(input.write) || input.write.projectId !== projectId ||
        !uuid.test(input.write.expectedSourceRevision)) throw invalidRequest();
    const snapshot = teachingInput(input);
    const value = teachingVersion(await this.request(path, this.principal(), signal, snapshot,
      { maxResponseBytes: teachingResponseBytes }), projectId);
    const page = value.project.pages.find(candidate => candidate.pageId === snapshot.write.pageId);
    if (value.project.source.revision !== snapshot.write.expectedSourceRevision ||
        value.project.teachingRevision === snapshot.write.expectedTeachingRevision || !page || page.locked ||
        !isDeepStrictEqual(page.actions, snapshot.write.actions)) throw invalid();
    return value;
  }

  /** Explicit confirmed upload. Snapshot mutable input before resolving credentials; never retry a POST. */
  async uploadSource(projectId: string, input: CoursewareOnlineUploadInput, signal?: AbortSignal): Promise<CoursewareOnlineSourceVersion> {
    const path = `${this.projectPath(projectId)}/sources`;
    if (!record(input) || !exact(input, ["requestId", "sourceSha256", "bytes", "filename",
      ...(Object.hasOwn(input, "expectedSourceRevision") ? ["expectedSourceRevision"] : [])]) ||
        typeof input.requestId !== "string" || !uuid.test(input.requestId) ||
        (input.expectedSourceRevision !== undefined && (typeof input.expectedSourceRevision !== "string" || !uuid.test(input.expectedSourceRevision))) ||
        typeof input.sourceSha256 !== "string" || !sha256.test(input.sourceSha256) || !Buffer.isBuffer(input.bytes) ||
        input.bytes.length < 1 || input.bytes.length > COURSEWARE_ONLINE_MAX_SOURCE_BYTES ||
        typeof input.filename !== "string" || input.filename.length > 255 || !/^[^/\\\u0000-\u001f\u007f]+\.pptx$/iu.test(input.filename))
      throw new Error("COURSEWARE_ONLINE_INVALID_REQUEST");
    const { requestId, expectedSourceRevision, sourceSha256, filename } = input;
    const bytes = Buffer.from(input.bytes);
    try { validateOfficeBytes(bytes, "pptx"); }
    catch { throw new Error("COURSEWARE_ONLINE_INVALID_REQUEST"); }
    if (createHash("sha256").update(bytes).digest("hex") !== sourceSha256) throw new Error("COURSEWARE_ONLINE_INVALID_REQUEST");
    const body = new FormData();
    body.set("requestId", requestId);
    if (expectedSourceRevision !== undefined) body.set("expectedSourceRevision", expectedSourceRevision);
    body.set("sourceSha256", sourceSha256);
    body.set("source", new Blob([new Uint8Array(bytes)], { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }), filename);
    const value = sourceVersion(await this.request(path, this.principal(), signal, body), projectId);
    if (value.requestId !== requestId || value.source.sha256 !== sourceSha256 || value.byteLength !== bytes.length ||
        value.sessionEpoch !== null || value.callbackId !== null) throw invalid();
    return value;
  }

  /** Explicit owner action. A lost response requires reading current(), never automatic POST replay. */
  async start(projectId: string, expectedEpoch: number, signal?: AbortSignal, expectedSourceRevision?: string): Promise<CoursewareOnlineSession> {
    if (!epoch(expectedEpoch) || expectedEpoch >= Number.MAX_SAFE_INTEGER ||
        (expectedSourceRevision !== undefined && (typeof expectedSourceRevision !== "string" || !uuid.test(expectedSourceRevision))))
      throw new Error("COURSEWARE_ONLINE_INVALID_REQUEST");
    const value = session(await this.request(this.path(projectId), this.principal(), signal,
      { expectedEpoch, ...(expectedSourceRevision === undefined ? {} : { expectedSourceRevision }) }), projectId);
    if (!value.active || value.epoch !== expectedEpoch + 1) throw invalid();
    return value;
  }

  /** Explicit owner preparation, separate from joining an already bound session. */
  async bind(projectId: string, sessionEpoch: number, signal?: AbortSignal): Promise<{ key: string; sessionEpoch: number; callbackUrl: string }> {
    if (!epoch(sessionEpoch) || sessionEpoch < 1) throw new Error("COURSEWARE_ONLINE_INVALID_REQUEST");
    const value = await this.request(`${this.path(projectId)}/document-binding`, this.principal(), signal, { expectedEpoch: sessionEpoch });
    if (!exact(value, ["key", "sessionEpoch", "callbackUrl"]) || typeof value.key !== "string" || !key.test(value.key) ||
        value.sessionEpoch !== sessionEpoch || typeof value.callbackUrl !== "string") throw invalid();
    try {
      const url = new URL(value.callbackUrl);
      if (!(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
          url.username || url.password || url.hash) throw invalid();
    } catch { throw invalid(); }
    return { key: value.key, sessionEpoch, callbackUrl: value.callbackUrl };
  }

  /** Joining never creates/replaces/ends the team's session, source or callback binding. */
  async join(projectId: string, signal?: AbortSignal, clientId?: string): Promise<CoursewareOnlineLaunch> {
    if (clientId !== undefined && !uuid.test(clientId)) throw invalidRequest();
    const principal = this.principal();
    const current = session(await this.request(this.path(projectId), principal, signal), projectId);
    if (!current.active) throw new Error("COURSEWARE_ONLINE_SESSION_INACTIVE");
    const value = await this.request(`${this.path(projectId)}/${current.epoch}/editor-config`, principal, signal, clientId === undefined ? {} : { clientId });
    return launch(value, current, principal, clientId);
  }

  async currentNativeBarrier(projectId: string, sessionEpoch: number, signal?: AbortSignal): Promise<CoursewareOnlineNativeBarrier | null> {
    const value = await this.request(`${this.publicationPath(projectId, sessionEpoch)}/native-barriers/current`, this.principal(), signal,
      undefined, { allowNull: true });
    return value === null ? null : nativeBarrier(value, projectId, sessionEpoch);
  }

  async getNativeBarrier(projectId: string, sessionEpoch: number, barrierId: string, signal?: AbortSignal): Promise<CoursewareOnlineNativeBarrier> {
    return nativeBarrier(await this.request(this.nativeBarrierPath(projectId, sessionEpoch, barrierId), this.principal(), signal), projectId, sessionEpoch, barrierId);
  }

  async verifyNativeBarrierCoverage(projectId: string, sessionEpoch: number, barrierId: string, signal?: AbortSignal): Promise<CoursewareOnlineDocsCoverage> {
    return docsCoverage(await this.request(`${this.nativeBarrierPath(projectId, sessionEpoch, barrierId)}/verify-docs`, this.principal(), signal,
      undefined, { method: "POST", maxResponseBytes: 262_144 }), projectId, sessionEpoch, barrierId);
  }

  async requestBarrierForceSave(projectId: string, sessionEpoch: number, barrierId: string, requestId: string, documentKey: string,
    signal?: AbortSignal): Promise<CoursewareOnlineForceSave> {
    const path = this.forceSavePath(projectId, sessionEpoch, requestId, documentKey);
    if (!uuid.test(barrierId)) throw invalidRequest();
    return forceSave(await this.request(`${path}/native-barriers/${barrierId}/force-saves`, this.principal(), signal, { requestId }),
      sessionEpoch, requestId, documentKey);
  }

  async startNativeBarrier(projectId: string, sessionEpoch: number, barrierId: string, pauseId: string, signal?: AbortSignal): Promise<CoursewareOnlineNativeBarrier> {
    if (!uuid.test(barrierId) || !uuid.test(pauseId)) throw invalidRequest();
    return nativeBarrier(await this.request(`${this.publicationPath(projectId, sessionEpoch)}/native-barriers`, this.principal(), signal,
      { barrierId, pauseId }), projectId, sessionEpoch, barrierId);
  }

  async releaseNativeBarrier(projectId: string, sessionEpoch: number, barrierId: string, signal?: AbortSignal): Promise<CoursewareOnlineNativeBarrier> {
    return nativeBarrier(await this.request(this.nativeBarrierPath(projectId, sessionEpoch, barrierId), this.principal(), signal,
      undefined, { method: "DELETE" }), projectId, sessionEpoch, barrierId);
  }

  async reportNativeBarrier(projectId: string, sessionEpoch: number, barrierId: string, clientId: string,
    state: "draining" | "held" | "uncertain" | "resumed", signal?: AbortSignal): Promise<CoursewareOnlineNativeBarrier> {
    if (!uuid.test(clientId) || !["draining", "held", "uncertain", "resumed"].includes(state)) throw invalidRequest();
    return nativeBarrier(await this.request(`${this.nativeBarrierPath(projectId, sessionEpoch, barrierId)}/clients/${clientId}`,
      this.principal(), signal, { state }, { method: "PUT" }), projectId, sessionEpoch, barrierId);
  }

  async heartbeatNativeClient(projectId: string, sessionEpoch: number, clientId: string, nativeReady: boolean,
    signal?: AbortSignal): Promise<CoursewareOnlineNativeBarrier | null> {
    if (typeof nativeReady !== "boolean") throw invalidRequest();
    const value = await this.request(this.nativeClientPath(projectId, sessionEpoch, clientId), this.principal(), signal,
      { nativeReady }, { method: "PUT", allowNull: true });
    return value === null ? null : nativeBarrier(value, projectId, sessionEpoch);
  }

  async leaveNativeClient(projectId: string, sessionEpoch: number, clientId: string, signal?: AbortSignal): Promise<CoursewareOnlineNativeBarrier | null> {
    const value = await this.request(this.nativeClientPath(projectId, sessionEpoch, clientId), this.principal(), signal,
      undefined, { method: "DELETE", allowNull: true });
    return value === null ? null : nativeBarrier(value, projectId, sessionEpoch);
  }

  private nativeBarrierPath(projectId: string, sessionEpoch: number, barrierId: string): string {
    if (!uuid.test(barrierId)) throw invalidRequest();
    return `${this.publicationPath(projectId, sessionEpoch)}/native-barriers/${barrierId}`;
  }
  private nativeClientPath(projectId: string, sessionEpoch: number, clientId: string): string {
    if (!uuid.test(clientId)) throw invalidRequest();
    return `${this.publicationPath(projectId, sessionEpoch)}/native-clients/${clientId}`;
  }

  private path(projectId: string): string {
    return `${this.projectPath(projectId)}/editing-session`;
  }
  private publicationPath(projectId: string, sessionEpoch: number): string {
    if (!positiveEpoch(sessionEpoch)) throw invalidRequest();
    return `${this.path(projectId)}/${sessionEpoch}`;
  }
  private publicationRequestPath(projectId: string, sessionEpoch: number, requestId: string): string {
    if (typeof requestId !== "string" || !uuid.test(requestId)) throw invalidRequest();
    return this.publicationPath(projectId, sessionEpoch);
  }
  private forceSavePath(projectId: string, sessionEpoch: number, requestId: string, documentKey: string): string {
    if (typeof documentKey !== "string" || !key.test(documentKey)) throw invalidRequest();
    return this.publicationRequestPath(projectId, sessionEpoch, requestId);
  }
  private leasePath(projectId: string, pageId: string): string {
    if (!id(pageId)) throw invalidRequest();
    return `${this.projectPath(projectId)}/pages/${pageId}/lease`;
  }
  private projectPath(projectId: string): string {
    if (typeof projectId !== "string" || !uuid.test(projectId)) throw new Error("COURSEWARE_ONLINE_INVALID_REQUEST");
    return `/courseware/team/projects/${projectId}`;
  }
  private principal(): Principal {
    const value = this.options.getPrincipal();
    if (!value || !Number.isSafeInteger(value.tenantId) || value.tenantId <= 0 || !Number.isSafeInteger(value.userId) || value.userId <= 0)
      throw new Error("COURSEWARE_ONLINE_AUTH_REQUIRED");
    return value;
  }
  private assertCurrent(principal: Principal): void {
    if (this.options.getPrincipal() !== principal) throw new Error("COURSEWARE_ONLINE_AUTH_CHANGED");
  }
  private async request(path: string, principal: Principal, signal?: AbortSignal, body?: object,
    options: { method?: "POST" | "PUT" | "DELETE"; maxResponseBytes?: number; allowNull?: boolean } = {}): Promise<unknown> {
    const cancellation = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
    cancellation.throwIfAborted();
    const token = await this.options.resolveAccessToken();
    this.assertCurrent(principal);
    cancellation.throwIfAborted();
    if (!token || /[\r\n]/u.test(token)) throw new Error("COURSEWARE_ONLINE_AUTH_REQUIRED");
    const multipart = body instanceof FormData;
    const response = await this.options.fetch(`${this.baseUrl}${path}`, { method: options.method ?? (body === undefined ? "GET" : "POST"),
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body === undefined || multipart ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }), cache: "no-store", credentials: "omit", redirect: "error", signal: cancellation });
    this.assertCurrent(principal);
    cancellation.throwIfAborted();
    const reader = response.body?.getReader();
    const maxResponseBytes = options.maxResponseBytes ?? 131_072;
    try {
      if (!response.ok) throw new Error(`COURSEWARE_ONLINE_HTTP_${response.status}`);
      if (!reader || response.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw invalid();
      const declared = response.headers.get("content-length");
      if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maxResponseBytes)) throw invalid();
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const next = await reader.read();
        this.assertCurrent(principal);
        cancellation.throwIfAborted();
        if (next.done) break;
        length += next.value.length;
        if (length > maxResponseBytes) throw invalid();
        chunks.push(next.value);
      }
      let envelope: unknown;
      try { envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { throw invalid(); }
      if (!record(envelope) || envelope.code !== 200 || !Object.hasOwn(envelope, "data")) {
        if (record(envelope) && Number.isSafeInteger(envelope.code)) throw new Error(`COURSEWARE_ONLINE_PLATFORM_${envelope.code}`);
        throw invalid();
      }
      if (envelope.data === null && !options.allowNull) throw invalid();
      return envelope.data;
    } finally {
      await reader?.cancel().catch(() => {});
      this.assertCurrent(principal);
      cancellation.throwIfAborted();
    }
  }
}
