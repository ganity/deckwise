import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import { parseMaicClassroom } from '../../../maic-classroom';
import { assertPortableMaicUrl, sniffMaicMime, visitMaicResources } from '../../../maic-resources';
import { ensureInteractionCheckpoint } from './ensure-maic-interaction-checkpoint';

type Asset = { assetId: string; url: string; mimeType: string };
/** Local MAIC content archive. Trusted publication/signing remains the server publisher's job. */
export async function exportMaicClassroom(raw: unknown, resolve: (asset: Asset) => Promise<Uint8Array>): Promise<Uint8Array> {
  const classroom = parseMaicClassroom(raw);
  classroom.scenes = classroom.scenes.map(scene => ensureInteractionCheckpoint(scene, classroom.scenes));
  // Native reconciliation baselines are local authoring state, never MAIC content.
  for (const scene of classroom.scenes) if (scene.metadata) {
    for (const key of ['nativePageId', 'nativeNarrationText', 'nativeQuestionText', 'nativeQuestionElementId']) delete scene.metadata[key];
    if (!Object.keys(scene.metadata).length) delete scene.metadata;
  }
  const zip = new JSZip();
  const replacements = new Map<string, string>();
  const bytesByPath = new Map<string, string>();
  const archive = async (asset: Asset, detectImage = false): Promise<string> => {
    assertPortableMaicUrl(asset.url);
    const bytes = await resolve(asset);
    if (!bytes.length) throw new Error(`Empty MAIC asset: ${asset.assetId}`);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const extension: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg',
      'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/mp4': 'm4a', 'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/ogg': 'ogg' };
    const detected = sniffMaicMime(bytes);
    if (!detected || (detectImage ? !detected.startsWith('image/') : detected !== asset.mimeType && !(asset.mimeType === 'audio/mp4' && detected === 'video/mp4')))
      throw new Error(`MAIC asset MIME mismatch: ${asset.assetId} (${asset.mimeType})`);
    const suffix = extension[detectImage ? detected : asset.mimeType];
    if (!suffix) throw new Error(`Unsupported MAIC asset MIME: ${asset.mimeType}`);
    const path = `assets/${digest}.${suffix}`;
    if (replacements.has(asset.url) && replacements.get(asset.url) !== path) throw new Error(`Conflicting MAIC asset URL: ${asset.url}`);
    if (!bytesByPath.has(path)) { zip.file(path, bytes); bytesByPath.set(path, digest); }
    replacements.set(asset.url, path);
    return path;
  };
  for (const asset of classroom.mediaManifest ?? []) {
    assertPortableMaicUrl(asset.originalSrc);
    if (asset.originalPosterUrl) assertPortableMaicUrl(asset.originalPosterUrl);
    const original = asset.src;
    const path = await archive({ assetId: asset.assetId, url: original, mimeType: asset.mimeType });
    asset.src = path; asset.zipPath = path;
    if (asset.posterUrl) {
      const poster = await archive({ assetId: asset.posterAssetId ?? `${asset.assetId}-poster`, url: asset.posterUrl, mimeType: 'image/*' }, true);
      asset.posterUrl = poster; asset.posterZipPath = poster;
    }
  }
  for (const asset of classroom.audioManifest ?? []) {
    assertPortableMaicUrl(asset.originalUrl);
    const path = await archive({ assetId: asset.assetId, url: asset.url, mimeType: asset.mimeType });
    asset.url = path; asset.zipPath = path;
  }
  visitMaicResources(classroom.scenes, url => {
    const replacement = replacements.get(url);
    if (!replacement) throw new Error(`Unarchived MAIC resource: ${url}`);
    return replacement;
  });
  if (classroom.stage.canvas?.preset === 'KINDERGARTEN_16_10') {
    const kindergarten = classroom.metadata?.kindergarten as { courseSpec?: unknown; visualBible?: unknown; scenePlans?: unknown; songIntegration?: unknown } | undefined;
    if (!kindergarten?.courseSpec || !kindergarten.visualBible) throw new Error('Kindergarten publish bundle requires courseSpec and visualBible');
    zip.file('playback/kindergarten-v1.json', JSON.stringify({ schemaVersion: 1, classroomId: classroom.id, revisionId: classroom.revisionId,
      canvas: { logicalWidth: 1000, logicalHeight: 625, renderWidth: 1920, renderHeight: 1200, scale: 1.92 },
      courseSpec: kindergarten.courseSpec, scenePlans: kindergarten.scenePlans ?? [], visualBible: kindergarten.visualBible,
      songIntegration: kindergarten.songIntegration ?? { status: 'planned_only', slots: [] },
      scenes: classroom.scenes.map(({ id, order, type, content, actions }) => ({ id, order, type, content, actions: actions ?? [] })),
      mediaManifest: classroom.mediaManifest ?? [], audioManifest: classroom.audioManifest ?? [] }, null, 2));
  }
  zip.file('meta.json', JSON.stringify({ success: true, classroom, revisionId: classroom.revisionId, version: classroom.version, status: classroom.status }, null, 2));
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
