import { isCoursewareTeamAssetRef, type CoursewareTeamAssetRef } from "@pi-desktop/shared";
import type { CoursewareMediaClient } from "./courseware-media";
import { captureCoursewareSceneImages, type CoursewareSceneImage } from "./courseware-scene-context";

/** Fresh authorized reads only. The caller binds this batch to the owning account and candidate. */
export async function resolveCoursewareTeamPngs(input: {
  references: readonly CoursewareTeamAssetRef[];
  media: Pick<CoursewareMediaClient, "downloadTeamAsset">;
  principal: { assertCurrent(): void };
  signal?: AbortSignal;
}): Promise<CoursewareSceneImage[]> {
  const media = input.media;
  const assertCurrent = input.principal.assertCurrent.bind(input.principal);
  const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(input.signal ? [input.signal] : [])]);
  const current = () => {
    signal.throwIfAborted();
    assertCurrent();
  };
  current();
  const invalid = () => new Error("COURSEWARE_MEDIA_INVALID_SCENE_ASSETS");
  if (!Array.isArray(input.references) || !input.references.length || input.references.length > 202)
    throw invalid();
  const ids = new Set<string>(),
    sizes = new Map<string, number>();
  const references = input.references.map((reference) => {
    if (
      !isCoursewareTeamAssetRef(reference) ||
      reference.assetRef.mime !== "image/png" ||
      reference.assetRef.byteLength > 8 * 1024 * 1024 ||
      ids.has(reference.assetRef.assetId)
    )
      throw invalid();
    const { assetId, sha256, byteLength, width, height } = reference.assetRef;
    if (
      (width !== undefined && width > 4096) ||
      (height !== undefined && height > 4096) ||
      (sizes.has(sha256) && sizes.get(sha256) !== byteLength)
    )
      throw invalid();
    ids.add(assetId);
    sizes.set(sha256, byteLength);
    return structuredClone(reference);
  });
  if ([...sizes.values()].reduce((sum, size) => sum + size, 0) > 32 * 1024 * 1024) throw invalid();
  const images = new Map<string, CoursewareSceneImage>();
  let pixels = 0;
  for (const reference of references) {
    current();
    const { bytes } = await media.downloadTeamAsset(reference, signal);
    current();
    if (bytes.length < 24) throw invalid();
    const width = bytes.readUInt32BE(16),
      height = bytes.readUInt32BE(20);
    const asset = reference.assetRef;
    if (
      (asset.width !== undefined && asset.width !== width) ||
      (asset.height !== undefined && asset.height !== height)
    )
      throw invalid();
    const same = images.get(asset.sha256);
    if (same) {
      if (same.width !== width || same.height !== height) throw invalid();
      same.assetIds = [...same.assetIds, asset.assetId];
      continue;
    }
    pixels += width * height;
    if (pixels > 32 * 1024 * 1024) throw invalid();
    const [image] = captureCoursewareSceneImages(
      [{ assetIds: [asset.assetId], sha256: asset.sha256, width, height, bytes }],
      signal,
    );
    images.set(asset.sha256, image);
  }
  current();
  return [...images.values()];
}
