import { COURSEWARE_MAX_MEDIA_ASSET_BYTES, isCoursewareOnlineSourceMapping, isCoursewareProject, isCoursewareTaskRef, type CoursewareOnlineSourceMapping, type CoursewareProject } from "@pi-desktop/shared";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { CoursewareOnlineAudioProjection } from "./courseware-online-audio";

export type CoursewareOnlineTeachingPins = {
  projectId: string; teachingRevision: string; mappingRevision: string; payloadSha256: string;
};
export type CoursewareOnlineTeachingSeed = {
  project: CoursewareProject; mapping: CoursewareOnlineSourceMapping; mappingRevision: string; pins: CoursewareOnlineTeachingPins;
  audio?: CoursewareOnlineAudioProjection;
};
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  return record(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
}

/** Host already attests this mapping; this read never initializes a local project. */
export function onlineTeachingSeed(raw: unknown, projectId: string, sha256: string, audio?: CoursewareOnlineAudioProjection): CoursewareOnlineTeachingSeed {
  if (!record(raw) || !isCoursewareProject(raw.project) || raw.project.projectId !== projectId || raw.project.source.sha256 !== sha256 ||
      !isCoursewareOnlineSourceMapping(raw.mapping) || raw.mapping.sourceSha256 !== sha256)
    throw new Error("COURSEWARE_ONLINE_TEACHING_NOT_READY");
  const currentProject = raw.project;
  if (raw.mapping.pages.length !== currentProject.pages.length ||
      !raw.mapping.pages.every((page, index) => record(page) && page.pageId === currentProject.pages[index]!.pageId))
    throw new Error("COURSEWARE_ONLINE_TEACHING_NOT_READY");
  const hasAudio = raw.project.pages.some(page => page.actions.some(action => action.type === "audio_clip" ||
    ["audioAssetId", "audioId", "audioUrl"].some(key => Object.hasOwn(action, key))));
  if (hasAudio) {
    if (!audio || !isCoursewareProject(audio.project) || !Array.isArray(audio.assets) || !audio.assets.length || audio.assets.length > 1000)
      throw new Error("COURSEWARE_ONLINE_TEACHING_MEDIA_UNAVAILABLE");
    const ids = new Map<string, string>(), uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
    for (const asset of audio.assets) {
      if (!record(asset) || !["tts", "music-export"].includes(asset.kind) || typeof asset.localAssetId !== "string" ||
          !new RegExp(`^${asset.kind === "tts" ? "tts" : "music"}-[a-f0-9]{64}$`, "u").test(asset.localAssetId) ||
          ids.has(asset.localAssetId) || typeof asset.assetId !== "string" || !uuid.test(asset.assetId) ||
          !isCoursewareTaskRef(asset.taskRef) || !uuid.test(asset.taskRef.taskId) || !/^[a-f0-9]{64}$/u.test(asset.sha256) ||
          asset.localAssetId !== `${asset.kind === "tts" ? "tts" : "music"}-${asset.sha256}` ||
          !["audio/wav", "audio/mpeg"].includes(asset.mimeType) || !Number.isSafeInteger(asset.byteLength) ||
          asset.byteLength < 1 || asset.byteLength > COURSEWARE_MAX_MEDIA_ASSET_BYTES) throw new Error("COURSEWARE_ONLINE_TEACHING_MEDIA_UNAVAILABLE");
      ids.set(asset.localAssetId, asset.assetId);
    }
    const projected = structuredClone(raw.project), used = new Set<string>();
    for (const page of projected.pages) for (const action of page.actions) {
      if (Object.hasOwn(action, "audioId") || Object.hasOwn(action, "audioUrl") ||
          action.type === "audio_clip" && !Object.hasOwn(action, "audioAssetId")) throw new Error("COURSEWARE_ONLINE_TEACHING_MEDIA_UNAVAILABLE");
      if (!Object.hasOwn(action, "audioAssetId")) continue;
      const replacement = ids.get(String(action.audioAssetId));
      if (!["speech", "audio_clip"].includes(String(action.type)) || !replacement ||
          !String(action.audioAssetId).startsWith(action.type === "speech" ? "tts-" : "music-")) throw new Error("COURSEWARE_ONLINE_TEACHING_MEDIA_UNAVAILABLE");
      used.add(String(action.audioAssetId)); action.audioAssetId = replacement;
    }
    if (used.size !== ids.size || !isDeepStrictEqual(audio.project, projected)) throw new Error("COURSEWARE_ONLINE_TEACHING_MEDIA_UNAVAILABLE");
  } else if (audio !== undefined) throw new Error("COURSEWARE_ONLINE_TEACHING_MEDIA_UNAVAILABLE");
  const project = structuredClone(raw.project), mapping = structuredClone(raw.mapping), mappingRevision = mapping.revision;
  const audioProjection = audio === undefined ? undefined : structuredClone(audio);
  const payloadSha256 = createHash("sha256").update(JSON.stringify(sorted({ project, mapping, ...(audioProjection ? { audio: audioProjection } : {}) }))).digest("hex");
  return { project, mapping, mappingRevision, pins: { projectId, teachingRevision: project.teachingRevision, mappingRevision, payloadSha256 },
    ...(audioProjection ? { audio: audioProjection } : {}) };
}

export function projectOnlineTeaching(seed: CoursewareOnlineTeachingSeed, projectId: string, source: CoursewareProject["source"]): CoursewareProject {
  if (source.sha256 !== seed.project.source.sha256) throw new Error("COURSEWARE_ONLINE_TEACHING_CONFLICT");
  return { ...structuredClone(seed.audio?.project ?? seed.project), projectId, source: { ...source } };
}

export function projectOnlineMapping(seed: CoursewareOnlineTeachingSeed): CoursewareOnlineSourceMapping {
  return structuredClone(seed.mapping);
}
