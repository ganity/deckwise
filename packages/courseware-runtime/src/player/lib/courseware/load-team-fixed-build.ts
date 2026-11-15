import { z } from "zod";
import type { CoursewareBuildRef } from "../../../conversion/lib/courseware/canonical/courseware-contract";
import { isCoursewareBuildRef } from "../../../conversion/lib/courseware/canonical/courseware-contract";
import { digestBytes, loadFixedBuild, type LoadedFixedBuild } from "./load-fixed-build";
import { loadMaicClassroom } from './load-maic-classroom';

const MIB = 1024 * 1024;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const assetPath = /^assets\/[a-f0-9]{64}\.[a-z0-9]{1,16}$/;
const pathSchema = z.string().refine(p => ["manifest.json", "package.json", "report.json", "source.pptx"].includes(p) || assetPath.test(p));
const selectionSchema = z.object({
  build: z.object({ buildId: hash, snapshotId: z.string().regex(/^[\w.-]{1,128}$/), packageSha256: hash }).strict(),
  manifestSha256: hash,
  files: z.array(z.object({
    file: z.object({ path: pathSchema, sha256: hash, mimeType: z.string().max(128), byteLength: z.number().int().nonnegative() }).strict(),
    downloadUrl: z.string(),
  }).strict()).min(4).max(4097),
  expiresAt: z.string(),
}).strict();
const manifestSchema = z.object({
  schemaVersion: z.literal("deckwise-build-manifest/1"), buildId: hash, packageHash: hash,
  files: z.array(z.object({ path: pathSchema, sha256: hash }).strict()).min(3).max(4096),
}).strict();
const payloadProjection = z.object({
  report: z.object({ sourceSha256: hash }).passthrough(),
  assets: z.array(z.object({ id: z.string(), path: z.string().regex(assetPath), sha256: hash, mimeType: z.string().regex(/^(audio|image|video)\/[\w.+-]+$/) }).strict()).max(4093),
});
function check(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Error(code);
}
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.entries(a), right = Object.entries(b);
  return left.length === right.length && left.every(([key, value]) => Object.hasOwn(b, key) && sameJson(value, (b as Record<string, unknown>)[key]));
}

/** Host owns authorization/URL retrieval. Only selected finite paths reach download, never package URLs. */
export async function loadTeamFixedBuild(
  rawSelection: unknown,
  expected: Readonly<CoursewareBuildRef>,
  download: (path: string, signal?: AbortSignal) => Promise<Uint8Array>,
  signal?: AbortSignal,
): Promise<LoadedFixedBuild> {
  signal?.throwIfAborted();
  const parsed = selectionSchema.safeParse(rawSelection);
  check(parsed.success && isCoursewareBuildRef(expected), "TEAM_SELECTION_INVALID");
  const selection = parsed.data;
  check(selection.build.buildId === expected.buildId && selection.build.snapshotId === expected.snapshotId &&
    selection.build.packageSha256 === expected.packageSha256 && expected.buildId === expected.packageSha256, "TEAM_SELECTION_MISMATCH");
  const buildId = expected.buildId;
  const files = new Map(selection.files.map(item => [item.file.path, item.file]));
  check(files.size === selection.files.length && ["manifest.json", "package.json", "report.json", "source.pptx"].every(p => files.has(p)), "TEAM_FILE_SET_INVALID");
  let assetsTotal = 0;
  for (const file of files.values()) {
    const limit = file.path === "manifest.json" ? MIB : file.path === "package.json" ? 64 * MIB : file.path === "report.json" ? 2 * MIB : file.path === "source.pptx" ? 20 * MIB : 256 * MIB;
    check(file.byteLength <= limit && (assetPath.test(file.path) || file.byteLength > 0), "TEAM_FILE_BUDGET_EXCEEDED");
    if (assetPath.test(file.path)) assetsTotal += file.byteLength;
    else check(file.mimeType === (file.path === "source.pptx" ? "application/vnd.openxmlformats-officedocument.presentationml.presentation" : "application/json"), "TEAM_FILE_METADATA_MISMATCH");
  }
  check(assetsTotal <= 256 * MIB, "TEAM_FILE_BUDGET_EXCEEDED");
  check(files.get("manifest.json")!.sha256 === selection.manifestSha256 && files.get("package.json")!.sha256 === buildId, "TEAM_FILE_METADATA_MISMATCH");
  const read = async (path: string) => {
    signal?.throwIfAborted();
    const ref = files.get(path)!;
    const resolved = await download(path, signal);
    signal?.throwIfAborted();
    check(resolved.length === ref.byteLength, "TEAM_FILE_LENGTH_MISMATCH");
    const bytes = Uint8Array.from(resolved);
    check(await digestBytes(bytes) === ref.sha256, "TEAM_FILE_HASH_MISMATCH");
    signal?.throwIfAborted();
    return bytes;
  };
  const manifestResult = manifestSchema.safeParse(JSON.parse(new TextDecoder().decode(await read("manifest.json"))));
  check(manifestResult.success, "TEAM_MANIFEST_INVALID");
  const manifest = manifestResult.data;
  check(manifest.buildId === buildId && manifest.packageHash === buildId, "TEAM_SELECTION_MISMATCH");
  check(new Set(manifest.files.map(f => f.path)).size === manifest.files.length && manifest.files.length === files.size - 1 &&
    manifest.files.every(f => f.path !== "manifest.json" && files.get(f.path)?.sha256 === f.sha256), "TEAM_MANIFEST_MISMATCH");
  const packageBytes = await read("package.json");
  const payload: unknown = JSON.parse(new TextDecoder().decode(packageBytes));
  const projection = payloadProjection.safeParse(payload);
  check(projection.success, "PACKAGE_SCHEMA_INVALID");
  const { report, assets } = projection.data;
  check(files.get("source.pptx")!.sha256 === report.sourceSha256, "TEAM_SOURCE_MISMATCH");
  const paths = new Set(["manifest.json", "package.json", "report.json", "source.pptx"]);
  for (const asset of assets) {
    const ref = files.get(asset.path);
    check(ref && ref.sha256 === asset.sha256 && ref.mimeType === asset.mimeType && asset.path.startsWith(`assets/${asset.sha256}.`), "TEAM_ASSET_MISMATCH");
    paths.add(asset.path);
  }
  check(paths.size === files.size, "TEAM_FILE_SET_INVALID");
  check(sameJson(report, JSON.parse(new TextDecoder().decode(await read("report.json")))), "TEAM_REPORT_MISMATCH");
  await read("source.pptx");
  const resources = new Map<string, Uint8Array>();
  for (const path of paths) if (assetPath.test(path)) resources.set(path, await read(path));
  if (payload && typeof payload === 'object' && 'schemaVersion' in payload && payload.schemaVersion === 'deckwise-maic/1' && 'classroom' in payload) {
    const urls: string[] = [];
    try {
      const loaded = await loadMaicClassroom(payload.classroom, buildId, async asset => {
        const ref = assets.find(candidate => candidate.id === asset.assetId && candidate.path === asset.url);
        check(ref && (asset.mimeType === 'image/*' ? ref.mimeType.startsWith('image/') : ref.mimeType === asset.mimeType), 'TEAM_ASSET_MISMATCH');
        const bytes = resources.get(ref.path);
        check(bytes, 'TEAM_ASSET_MISMATCH');
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: ref.mimeType }));
        urls.push(url); return url;
      }, signal);
      return { ...loaded, dispose() { urls.forEach(url => URL.revokeObjectURL(url)); } };
    } catch (error) { urls.forEach(url => URL.revokeObjectURL(url)); throw error; }
  }
  return loadFixedBuild(packageBytes, buildId, async asset => {
    const bytes = resources.get(asset.path);
    check(bytes, "TEAM_ASSET_MISMATCH");
    return bytes;
  }, signal);
}
