import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { COURSEWARE_MAX_MEDIA_ASSET_BYTES, isCoursewareProject, isCoursewareTaskRef, isCoursewareTeamAssetRef,
  type CoursewareProject, type CoursewareTaskRef, type CoursewareTeamAssetRef } from "@pi-desktop/shared";
import type { CoursewareMediaClient } from "./courseware-media";

export type CoursewareOnlineAudioAsset = {
  localAssetId: string; reference: CoursewareTeamAssetRef; bytes: Buffer;
};
type Host = { call<T>(method: string, params: unknown): Promise<T> };
type Audio = { taskRef: CoursewareTaskRef; sha256: string; mimeType: "audio/wav" | "audio/mpeg"; byteLength: number };
type Proof = { localAssetId: string; kind: "tts" | "music-export"; audio: Audio };
type Media = Pick<CoursewareMediaClient, "get" | "getTeamAsset" | "adoptTeamAsset" | "downloadTeamAsset" | "music">;
export type CoursewareOnlineAudioProjection = {
  project: CoursewareProject;
  assets: Array<{ localAssetId: string; kind: "tts" | "music-export"; taskRef: CoursewareTaskRef;
    assetId: string; sha256: string; mimeType: "audio/wav" | "audio/mpeg"; byteLength: number }>;
};
type Input = {
  sessionId: string; project: CoursewareProject; teamProjectId: string; host: Host; media: Media;
  principal: { key: string; assertCurrent(): void | Promise<void> }; signal?: AbortSignal;
};
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/u.test(value) && value !== "." && value !== "..";
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value);
const invalid = () => new Error("COURSEWARE_ONLINE_AUDIO_UNAVAILABLE");
function audio(value: unknown, reference: unknown): Audio {
  if (!record(value) || !isCoursewareTaskRef(value.taskRef) || !isCoursewareTaskRef(reference) ||
      !uuid(value.taskRef.taskId) || !isDeepStrictEqual(value.taskRef, reference) || !hash(value.sha256) ||
      !["audio/wav", "audio/mpeg"].includes(String(value.mimeType)) || !Number.isSafeInteger(value.byteLength) ||
      Number(value.byteLength) < 1 || Number(value.byteLength) > COURSEWARE_MAX_MEDIA_ASSET_BYTES) throw invalid();
  return { taskRef: { ...value.taskRef }, sha256: value.sha256, mimeType: value.mimeType as Audio["mimeType"], byteLength: Number(value.byteLength) };
}

/** Resolve only existing adopted journals and authenticated archived tasks. This stage performs no writes. */
async function prepare(input: Input) {
  if (!id(input.sessionId) || !uuid(input.teamProjectId) || !isCoursewareProject(input.project) ||
      !hash(input.principal.key) || Buffer.byteLength(JSON.stringify(input.project)) > 2 * 1024 * 1024) throw invalid();
  const project = structuredClone(input.project), sessionId = input.sessionId, teamProjectId = input.teamProjectId;
  const host = input.host, media = input.media, principalKey = input.principal.key;
  const assertCurrent = input.principal.assertCurrent.bind(input.principal), signal = input.signal;
  const check = async () => { signal?.throwIfAborted(); await assertCurrent(); signal?.throwIfAborted(); };
  const call = async (method: string, params: unknown): Promise<unknown> => {
    await check(); const value = await host.call<unknown>(method, params); await check(); return value;
  };
  const scope = { sessionId, projectId: project.projectId, principalKey };
  const fresh = async () => {
    const value = await call("courseware.project.get", { sessionId, projectId: project.projectId });
    if (!record(value) || !isCoursewareProject(value.project) || !isDeepStrictEqual(value.project, project))
      throw new Error("COURSEWARE_ONLINE_AUDIO_CONFLICT");
  };
  await fresh();
  const proofs = new Map<string, Proof>();
  const add = (proof: Proof) => {
    const saved = proofs.get(proof.localAssetId);
    if (saved && (saved.kind !== proof.kind || saved.audio.sha256 !== proof.audio.sha256 ||
        saved.audio.mimeType !== proof.audio.mimeType || saved.audio.byteLength !== proof.audio.byteLength)) throw invalid();
    if (!saved) proofs.set(proof.localAssetId, proof);
    if (proofs.size > 1000 || [...proofs.values()].reduce((sum, entry) => sum + entry.audio.byteLength, 0) > 256 * 1024 * 1024) throw invalid();
  };
  const speeches = project.pages.flatMap(page => page.actions.filter(action => action.type === "speech" && Object.hasOwn(action, "audioAssetId"))
    .map(action => ({ pageId: page.pageId, action })));
  const clips = project.pages.flatMap(page => page.actions.filter(action => action.type === "audio_clip"));
  // Unknown URL/id conventions must not become remote media proofs.
  if (project.pages.some(page => page.actions.some(action => Object.hasOwn(action, "audioId") || Object.hasOwn(action, "audioUrl") ||
      Object.hasOwn(action, "audioAssetId") && action.type !== "speech" && action.type !== "audio_clip"))) throw invalid();
  if (speeches.some(({ action }) => typeof action.audioAssetId !== "string" || !/^tts-[a-f0-9]{64}$/u.test(action.audioAssetId))) throw invalid();
  if (speeches.length) {
    const list = await call("courseware.tts.list", scope);
    if (!record(list) || !Array.isArray(list.intents) || list.intents.length > 1000) throw invalid();
    for (const { pageId, action } of speeches) {
      if (typeof action.text !== "string" || !action.text.trim() || typeof action.audioAssetId !== "string" ||
          !/^tts-[a-f0-9]{64}$/u.test(action.audioAssetId)) throw invalid();
      let found: Proof | undefined;
      for (const summary of list.intents) {
        if (!record(summary) || !record(summary.selection)) throw invalid();
        const selected = summary.selection;
        if (summary.phase !== "submitted" || selected.pageId !== pageId || selected.actionId !== action.id) continue;
        if (selected.projectId !== project.projectId || selected.principalKey !== principalKey || !id(selected.intentId)) throw invalid();
        const selectedScope = { ...scope, intentId: selected.intentId };
        const journal = await call("courseware.tts.get", selectedScope);
        if (!record(journal) || !record(journal.intent)) throw invalid();
        const intent = journal.intent;
        if (!record(intent.selection) || !record(intent.request)) throw invalid();
        const selection = intent.selection, request = intent.request;
        if (intent.phase !== "submitted" || selection.projectId !== project.projectId || selection.principalKey !== principalKey ||
            selection.pageId !== pageId || selection.actionId !== action.id || selection.intentId !== selected.intentId ||
            request.kind !== "tts" || request.input !== action.text) continue;
        let saved: unknown;
        try { saved = await call("courseware.tts.audio.get", selectedScope); }
        catch (error) {
          await check();
          if (record(error) && error.errorCode === "COURSEWARE_NOT_FOUND") continue;
          throw error;
        }
        if (!record(saved) || !record(saved.asset)) throw invalid();
        const bound = saved.boundSource ?? { revision: selection.expectedSourceRevision, sha256: intent.sourceSha256 };
        if (!record(bound) || bound.revision !== project.source.revision || bound.sha256 !== project.source.sha256 ||
            !id(saved.adoptedTeachingRevision) || saved.asset.id !== action.audioAssetId) continue;
        const archived = audio(saved.audio, intent.taskRef);
        if (saved.asset.id !== `tts-${archived.sha256}` || saved.asset.sha256 !== archived.sha256 || saved.asset.mimeType !== archived.mimeType) throw invalid();
        found = { localAssetId: saved.asset.id, kind: "tts", audio: archived }; break;
      }
      if (!found) throw invalid();
      add(found);
    }
  }
  if (clips.length) {
    if (clips.some(action => typeof action.audioAssetId !== "string" || !/^music-[a-f0-9]{64}$/u.test(action.audioAssetId))) throw invalid();
    const result = await call("courseware.mediaCanvas.music.snapshotAssets", { ...scope,
      expectedSourceRevision: project.source.revision, expectedTeachingRevision: project.teachingRevision });
    if (!record(result) || !Array.isArray(result.assets) || result.assets.length > 1000) throw invalid();
    const used = new Set(clips.map(action => action.audioAssetId)), returned = new Set<string>();
    for (const entry of result.assets) {
      if (!record(entry) || !record(entry.asset) || !record(entry.music) || !id(entry.asset.id) ||
          !used.has(entry.asset.id) || returned.has(entry.asset.id) || entry.music.principalKey !== principalKey || !id(entry.music.intentId)) throw invalid();
      returned.add(entry.asset.id);
      const journal = await call("courseware.mediaCanvas.music.get", { sessionId, principalKey, intentId: entry.music.intentId });
      if (!record(journal) || !record(journal.intent) || !record(journal.intent.request) ||
          journal.intent.intentId !== entry.music.intentId || journal.intent.phase !== "submitted" ||
          journal.intent.request.kind !== "music-export") throw invalid();
      const archived = audio(journal.intent.asset, journal.intent.taskRef);
      if (archived.mimeType !== "audio/mpeg" || entry.asset.id !== `music-${archived.sha256}` ||
          entry.asset.sha256 !== archived.sha256 || entry.asset.mimeType !== archived.mimeType) throw invalid();
      add({ localAssetId: entry.asset.id, kind: "music-export", audio: archived });
    }
    if (returned.size !== used.size) throw invalid();
  }
  // Read every private task before any adoption, so known stale/corrupt input creates no team reference.
  const ready = [];
  for (const proof of proofs.values()) {
    await check();
    const task = proof.kind === "tts" ? await media.get(proof.audio.taskRef, signal) : await media.music.get(proof.audio.taskRef, "music-export", signal);
    await check();
    const asset = task.assetRef;
    if (task.kind !== proof.kind || !isDeepStrictEqual({ taskId: task.taskId, idempotencyKey: task.idempotencyKey, requestHash: task.requestHash }, proof.audio.taskRef) ||
        task.state !== "ready" || task.feeState !== "settled" || !asset || !uuid(asset.assetId) || asset.sha256 !== proof.audio.sha256 ||
        asset.mime !== proof.audio.mimeType || asset.byteLength !== proof.audio.byteLength) throw invalid();
    ready.push({ proof, asset });
  }
  await fresh();
  return { project, ready, check, fresh, media, teamProjectId, signal };
}

function projectAudio(project: CoursewareProject, ready: Awaited<ReturnType<typeof prepare>>["ready"]): CoursewareOnlineAudioProjection {
  const projected = structuredClone(project);
  const assets = ready.map(({ proof, asset }) => ({ localAssetId: proof.localAssetId, kind: proof.kind,
    taskRef: { ...proof.audio.taskRef }, assetId: asset.assetId, sha256: asset.sha256,
    mimeType: proof.audio.mimeType, byteLength: asset.byteLength })).sort((a, b) => a.localAssetId.localeCompare(b.localAssetId, "en"));
  const transferred = new Map(assets.map(asset => [asset.localAssetId, asset.assetId]));
  for (const page of projected.pages) for (const action of page.actions) if (Object.hasOwn(action, "audioAssetId")) {
    const replacement = transferred.get(String(action.audioAssetId));
    if (!replacement) throw invalid();
    action.audioAssetId = replacement;
  }
  return { project: projected, assets };
}

/** Main-only read-only review projection. Asset UUIDs come from authenticated tasks, never local naming. */
export async function preflightCoursewareOnlineAudio(input: Input): Promise<CoursewareOnlineAudioProjection> {
  const prepared = await prepare(input);
  return projectAudio(prepared.project, prepared.ready);
}

/** Explicitly adopt existing bytes; a restart first resolves already adopted UUIDs without another POST. */
export async function adoptCoursewareOnlineAudio(input: Input & {
  expectedProjection?: CoursewareOnlineAudioProjection; beforeAdopt?(): void | Promise<void>;
}): Promise<{ project: CoursewareProject; assets: CoursewareOnlineAudioAsset[] }> {
  const expected = input.expectedProjection === undefined ? undefined : structuredClone(input.expectedProjection);
  const { project, ready, check, fresh, media, teamProjectId, signal } = await prepare(input);
  const projected = projectAudio(project, ready);
  if (expected !== undefined && !isDeepStrictEqual(expected, projected)) throw new Error("COURSEWARE_ONLINE_AUDIO_CONFLICT");
  const assets: CoursewareOnlineAudioAsset[] = [];
  for (const { proof, asset } of ready) {
    await fresh();
    let reference: CoursewareTeamAssetRef;
    try { reference = await media.getTeamAsset(teamProjectId, asset.assetId, signal); await check(); }
    catch (error) {
      await check();
      if (!(error instanceof Error) || error.message !== "COURSEWARE_MEDIA_PLATFORM_46901") throw error;
      await input.beforeAdopt?.();
      await check();
      await fresh();
      reference = await media.adoptTeamAsset(teamProjectId, proof.audio.taskRef, signal);
      await check();
    }
    if (!isCoursewareTeamAssetRef(reference) || reference.projectId !== teamProjectId || reference.assetRef.assetId !== asset.assetId ||
        reference.assetRef.sha256 !== asset.sha256 || reference.assetRef.mime !== asset.mime || reference.assetRef.byteLength !== asset.byteLength) throw invalid();
    const downloaded = await media.downloadTeamAsset(reference, signal);
    await check();
    if (!isDeepStrictEqual(downloaded.reference, reference) || !Buffer.isBuffer(downloaded.bytes) || downloaded.bytes.length !== asset.byteLength ||
        createHash("sha256").update(downloaded.bytes).digest("hex") !== asset.sha256) throw invalid();
    assets.push({ localAssetId: proof.localAssetId, reference: structuredClone(reference), bytes: Buffer.from(downloaded.bytes) });
  }
  await fresh();
  return { project: projected.project, assets };
}
