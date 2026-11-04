import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import JSZip from "jszip";
import { exportMaicClassroom, canonicalJson, type MaicClassroom } from "@pi-desktop/courseware-runtime/node";
import { readClassroomAsset } from "./courseware-classroom-assets";

/** Hash-pinned delivery envelope. The classroom itself remains the MAIC contract. */
export async function buildMaicCourseware(input: { classroom: MaicClassroom; workspace: string; sourcePath?: string;
  outputDirectory: string; report: Record<string, unknown>; assertCurrent: () => Promise<void> }) {
  const zip = await JSZip.loadAsync(await exportMaicClassroom(input.classroom, asset => readClassroomAsset(input.workspace, asset)));
  const meta = JSON.parse(await zip.file("meta.json")!.async("string"));
  const assets: { id: string; path: string; sha256: string; mimeType: string }[] = [];
  const resources = [...meta.classroom.mediaManifest ?? [], ...meta.classroom.audioManifest ?? []];
  for (const asset of resources) {
    const path = asset.zipPath;
    if (!path || !zip.file(path)) throw new Error("Canonical build resource is missing");
    const bytes = await zip.file(path)!.async("uint8array");
    assets.push({ id: asset.assetId, path, sha256: createHash("sha256").update(bytes).digest("hex"), mimeType: asset.mimeType });
    if (asset.posterZipPath && zip.file(asset.posterZipPath)) {
      const poster = await zip.file(asset.posterZipPath)!.async("uint8array");
      const suffix = asset.posterZipPath.split(".").at(-1);
      const mimeType = suffix === "jpg" ? "image/jpeg" : suffix === "webp" ? "image/webp" : suffix === "svg" ? "image/svg+xml" : "image/png";
      assets.push({ id: asset.posterAssetId ?? `${asset.assetId}-poster`, path: asset.posterZipPath, sha256: createHash("sha256").update(poster).digest("hex"), mimeType });
    }
  }
  const unique = [...new Map(assets.map(asset => [asset.id, asset])).values()];
  const packageJson = canonicalJson({ schemaVersion: "deckwise-maic/1", success: true, classroom: meta.classroom, assets: unique, report: input.report });
  const buildId = createHash("sha256").update(packageJson).digest("hex"), directory = join(input.outputDirectory, buildId);
  const staging = join(input.outputDirectory, `.building-maic-${randomUUID()}`);
  await mkdir(staging, { recursive: true });
  try {
    await writeFile(join(staging, "package.json"), packageJson);
    await writeFile(join(staging, "report.json"), canonicalJson(input.report));
    const files = ["package.json", "report.json"];
    if (input.sourcePath) { await writeFile(join(staging, "source.pptx"), await readFile(input.sourcePath)); files.push("source.pptx"); }
    for (const path of new Set(unique.map(asset => asset.path))) {
      await mkdir(join(staging, "assets"), { recursive: true });
      await writeFile(join(staging, path), await zip.file(path)!.async("uint8array"));
      files.push(path);
    }
    const manifest = { schemaVersion: "deckwise-build-manifest/1", buildId, packageHash: buildId,
      files: await Promise.all(files.map(async path => ({ path, sha256: createHash("sha256").update(await readFile(join(staging, path))).digest("hex") }))) };
    await writeFile(join(staging, "manifest.json"), canonicalJson(manifest));
    await input.assertCurrent();
    try { await rename(staging, directory); }
    catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      if (await readFile(join(directory, "manifest.json"), "utf8") !== canonicalJson(manifest)) throw new Error("Canonical build identity collision");
    }
    return { buildId, packageHash: buildId, directory };
  } finally { await rm(staging, { recursive: true, force: true }); }
}
