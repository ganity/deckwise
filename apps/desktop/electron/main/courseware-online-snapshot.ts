import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { COURSEWARE_MAX_MEDIA_ASSET_BYTES, isCoursewareOnlineSourceMapping, isCoursewareProject,
  isCoursewareSnapshot, isCoursewareTeamAssetRef, type CoursewareSnapshot } from "@pi-desktop/shared";
import type { CoursewareMediaClient } from "./courseware-media";
import type { CoursewareOnlineSourceReview } from "./courseware-online-editing";
import type { stageOnlineSourceFiles } from "./courseware-online-source-files";

type Host = { call<T>(method: string, params: unknown): Promise<T> };
type Files = Pick<Awaited<ReturnType<typeof stageOnlineSourceFiles>>, "withParsed">;
export type CoursewareOnlineSnapshotInput = {
  workspace: string;
  sessionId: string;
  review: CoursewareOnlineSourceReview;
  expected: {
    projectId: string; sessionEpoch: number; forceSaveRequestId: string; callbackId: string;
    source: { revision: string; sha256: string }; sourceByteLength: number;
  };
  files: Files;
  media: Pick<CoursewareMediaClient, "getTeamAsset" | "downloadTeamAsset">;
  getHost(): Host | null;
  assertCurrent(): void | Promise<void>;
  signal?: AbortSignal;
};
const active = new WeakSet<Files>();
const uuid = (value: unknown): value is string => typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value);
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const invalid = () => new Error("COURSEWARE_ONLINE_SOURCE_INVALID");
const changed = () => new Error("COURSEWARE_ONLINE_SOURCE_CONTEXT_CHANGED");

/** Import already captured online teaching/audio into an independent Host snapshot. Never writes live teaching. */
export async function importOnlineCoursewareSnapshot(input: CoursewareOnlineSnapshotInput): Promise<CoursewareSnapshot> {
  if (active.has(input.files)) throw new Error("COURSEWARE_ONLINE_SOURCE_BUSY");
  const review = structuredClone(input.review), expected = structuredClone(input.expected);
  const project = review?.teaching?.project, mapping = review?.mapping;
  if (!isAbsolute(input.workspace) || !/^[\w.-]{1,128}$/u.test(input.sessionId) ||
      !isCoursewareProject(project) || !isCoursewareOnlineSourceMapping(mapping) || !expected ||
      !uuid(expected.projectId) || project.projectId !== expected.projectId ||
      !Number.isSafeInteger(expected.sessionEpoch) || expected.sessionEpoch < 1 || review.sessionEpoch !== expected.sessionEpoch ||
      !uuid(expected.forceSaveRequestId) || review.forceSaveRequestId !== expected.forceSaveRequestId ||
      !hash(expected.callbackId) || review.callbackId !== expected.callbackId ||
      !uuid(review.snapshotId) || review.snapshotId !== expected.source?.revision ||
      !hash(expected.source?.sha256) || !isDeepStrictEqual(project.source, expected.source) ||
      !Number.isSafeInteger(expected.sourceByteLength) || expected.sourceByteLength < 1 || expected.sourceByteLength > 20 * 1024 * 1024 ||
      review.sourceByteLength !== expected.sourceByteLength || review.teaching.mappingRevision !== mapping.revision ||
      mapping.sourceSha256 !== project.source.sha256 || mapping.pages.length !== project.pages.length ||
      mapping.pages.some((page, index) => page.pageId !== project.pages[index]?.pageId)) throw invalid();
  const ids = new Set<string>();
  for (const page of project.pages) for (const action of page.actions) {
    if (Object.hasOwn(action, "audioUrl") || Object.hasOwn(action, "audioId") ||
        Object.hasOwn(action, "audioAssetId") && action.type !== "speech" && action.type !== "audio_clip") throw invalid();
    if (action.type !== "speech" && action.type !== "audio_clip") continue;
    if (!uuid(action.audioAssetId) || action.type === "speech" && (typeof action.text !== "string" || !action.text.trim())) throw invalid();
    ids.add(action.audioAssetId);
  }
  if (ids.size > 1000) throw invalid();
  const host = input.getHost(), files = input.files, media = input.media;
  if (!host) throw changed();
  const signal = input.signal, sessionId = input.sessionId;
  const check = async () => {
    signal?.throwIfAborted();
    if (input.getHost() !== host) throw changed();
    await input.assertCurrent();
    signal?.throwIfAborted();
    if (input.getHost() !== host) throw changed();
  };
  const step = async <T>(operation: Promise<T>): Promise<T> => { const value = await operation; await check(); return value; };
  let directory: string | undefined, identity: { dev: number; ino: number } | undefined;
  let importUnknown = false;
  const verifyDirectory = async () => {
    if (!directory || !identity) throw changed();
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== identity.dev || info.ino !== identity.ino ||
        await fs.realpath(directory) !== directory) throw changed();
  };
  active.add(files);
  try {
    await check();
    const workspace = await step(fs.realpath(input.workspace));
    if (!(await step(fs.stat(workspace))).isDirectory()) throw invalid();
    const assets: Array<{ asset: { id: string; sha256: string; mimeType: string }; path: string }> = [];
    let total = 0;
    for (const id of ids) {
      await check();
      const reference = await step(media.getTeamAsset(project.projectId, id, signal));
      if (!isCoursewareTeamAssetRef(reference) || reference.projectId !== project.projectId || reference.assetRef.assetId !== id ||
          !["audio/wav", "audio/mpeg"].includes(reference.assetRef.mime)) throw invalid();
      total += reference.assetRef.byteLength;
      if (reference.assetRef.byteLength > COURSEWARE_MAX_MEDIA_ASSET_BYTES || total > 128 * 1024 * 1024) throw invalid();
      const pinned = structuredClone(reference);
      const downloaded = await step(media.downloadTeamAsset(reference, signal));
      if (!downloaded || !isDeepStrictEqual(downloaded.reference, pinned) || !Buffer.isBuffer(downloaded.bytes)) throw invalid();
      if (downloaded.bytes.length > COURSEWARE_MAX_MEDIA_ASSET_BYTES) throw invalid();
      const bytes = Buffer.from(downloaded.bytes), asset = pinned.assetRef;
      const matchesMime = asset.mime === "audio/wav"
        ? bytes.length >= 44 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE"
        : bytes.length >= 4 && (bytes.toString("ascii", 0, 3) === "ID3" || bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0);
      if (!matchesMime || bytes.length !== asset.byteLength || createHash("sha256").update(bytes).digest("hex") !== asset.sha256) throw invalid();
      if (!directory) {
        directory = await fs.mkdtemp(join(workspace, ".deckwise-online-audio-"));
        const info = await fs.lstat(directory); identity = { dev: info.dev, ino: info.ino };
        await check(); await step(fs.chmod(directory, 0o700));
      }
      await step(verifyDirectory());
      const path = join(directory, `${id}.bin`);
      await step(fs.writeFile(path, bytes, { flag: "wx", mode: 0o600 }));
      assets.push({ asset: { id, sha256: asset.sha256, mimeType: asset.mime }, path });
    }
    await check();
    const result = await files.withParsed("target", async (parsedHost, jobId) => {
      await check();
      if (parsedHost !== host || !uuid(jobId)) throw changed();
      if (directory) await step(verifyDirectory());
      let value: unknown;
      try {
        importUnknown = true;
        value = await host.call<unknown>("courseware.snapshot.importOnline", { sessionId, jobId,
          snapshotId: review.snapshotId, sourceByteLength: review.sourceByteLength, project,
          mapping: { ...mapping, sourceRevision: project.source.revision }, assets });
        importUnknown = false;
      } catch { throw new Error("COURSEWARE_ONLINE_SOURCE_IMPORT_UNCERTAIN"); }
      await check();
      const snapshot = value && typeof value === "object" && "snapshot" in value ? value.snapshot : undefined;
      if (!isCoursewareSnapshot(snapshot) || snapshot.snapshotId !== review.snapshotId || snapshot.projectId !== project.projectId ||
          !isDeepStrictEqual(snapshot.source, project.source) || snapshot.teachingRevision !== project.teachingRevision ||
          snapshot.mappingRevision !== review.teaching.mappingRevision ||
          !isDeepStrictEqual([...snapshot.assetIds].sort(), [...ids].sort())) throw invalid();
      return structuredClone(snapshot);
    });
    await check();
    return result;
  } finally {
    try {
      // A lost Host reply may leave an in-flight reader; retain only our private directory in that case.
      if (directory && !importUnknown) {
        try { await verifyDirectory(); await fs.rm(directory, { recursive: true, force: false }); }
        catch { throw new Error("COURSEWARE_ONLINE_SOURCE_CLEANUP_FAILED"); }
      }
    } finally { active.delete(files); }
  }
}
