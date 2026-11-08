import { parseMaicClassroom, type MaicClassroom } from '../../../maic-classroom';
import type { LoadedFixedBuild } from './load-fixed-build';
import { visitMaicResources } from '../../../maic-resources';

/** The host resolves and authorizes archived URLs; the renderer never reads local files. */
export type MaicResourceResolver = (resource: { assetId: string; url: string; mimeType: string }, signal?: AbortSignal) => Promise<string>;
export async function loadMaicClassroom(raw: unknown, buildId: string, resolve: MaicResourceResolver, signal?: AbortSignal): Promise<LoadedFixedBuild> {
  const classroom = parseMaicClassroom(raw);
  const pending = classroom.scenes.find(scene => scene.metadata?.nativeTeachingSyncPending === true);
  if (pending) throw new Error(`Native teaching is not fully synchronized: ${pending.title}: ${pending.metadata?.nativeTeachingSyncReason ?? "unsupported native teaching action"}`);
  const scenes = structuredClone(classroom.scenes);
  const resources = new Map<string, string>();
  const resourceIds = new Map<string, string>();
  for (const asset of [...(classroom.mediaManifest ?? []).map(a => ({ assetId: a.assetId, url: a.src, mimeType: a.mimeType })),
    ...(classroom.mediaManifest ?? []).filter(a => a.posterUrl).map(a => ({ assetId: a.posterAssetId ?? `${a.assetId}-poster`, url: a.posterUrl!, mimeType: 'image/*' })),
    ...(classroom.audioManifest ?? []).map(a => ({ assetId: a.assetId, url: a.url, mimeType: a.mimeType }))]) {
    if (resources.has(asset.url)) {
      // The package exporter deduplicates equal bytes across distinct semantic IDs.
      if (resourceIds.get(asset.url) !== asset.assetId && !/^assets\/[a-f0-9]{64}\.[a-z0-9]+$/.test(asset.url))
        throw new Error(`Conflicting MAIC resource URL: ${asset.url}`);
      continue;
    }
    signal?.throwIfAborted();
    const url = await resolve(asset, signal);
    signal?.throwIfAborted();
    if (!url) throw new Error(`Unresolved MAIC asset: ${asset.assetId}`);
    resources.set(asset.url, url);
    resourceIds.set(asset.url, asset.assetId);
  }
  visitMaicResources(scenes, source => {
    const url = resources.get(source);
    if (!url) throw new Error(`Unarchived MAIC resource: ${source}`);
    return url;
  });
  for (const asset of classroom.audioManifest ?? []) {
    const scene = scenes.find(s => s.id === asset.sceneId);
    const action = scene?.actions?.find(a => a.id === asset.actionId && a.type === 'speech');
    if (!action || action.type !== 'speech') throw new Error(`Missing MAIC speech target: ${asset.actionId}`);
    action.audioUrl = resources.get(asset.url);
    action.audioId = asset.audioId;
  }
  for (const scene of scenes) for (const action of scene.actions ?? []) {
    if (action.type !== 'interaction_checkpoint' || action.checkpointKind !== 'media_playback') continue;
    const element = scene.content.type === 'slide' ? scene.content.canvas.elements.find(e => e.id === action.elementId) : undefined;
    if (!element || (element.type !== 'video' && element.type !== 'audio')) throw new Error(`Missing MAIC checkpoint media: ${action.elementId}`);
    Object.assign(action, { videoUrl: element.src });
  }
  return {
    buildId, classroom, scenes, speechVisualCues: new Map(), nativeAnimations: new Map(), dispose() {},
    report: { ready: true, visualFidelity: 'NOT_VERIFIED', reviewedWarningCodes: [], diagnostics: [],
      capabilities: { staticSlides: 'limited', fixedNarration: true, teacherWait: true, transitions: false, objectAnimations: false, spotlight: false },
      sourceSha256: buildId, sourceRevision: classroom.revisionId ?? buildId, teachingRevision: classroom.revisionId ?? buildId,
      mappingRevision: classroom.revisionId ?? buildId, converter: { version: 'maic-pptx-import-ir/1', manifestSha256: buildId } },
  };
}
