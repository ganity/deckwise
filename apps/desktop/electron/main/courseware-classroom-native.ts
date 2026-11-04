import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveRealPathForCreateWithinRoot } from "./fs-panel";
import { mapMaicSlideIrToScenes, parseMaicClassroom, type MaicClassroom, type MaicSlideIR } from "@pi-desktop/courseware-runtime/node";

type Host = { call<T>(method: string, params: unknown): Promise<T> };
type NativePage = { pageId: string; actions: Array<Record<string, unknown>> };
type Asset = { id: string; path: string; sha256: string; mimeType: string };
export type NativeClassroomSeed = {
  projectId: string; revision: string | null; sourceRevision: string; currentSourceRevision: string;
  classroom: MaicClassroom | null; ir: MaicSlideIR;
  project: { pages: NativePage[] };
  mapping: { pages: Array<{ pageId: string; planPageId?: string; importPageId?: string }> };
  assets: Asset[];
};
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Reconcile only a previously generated canonical course; independent Quiz scenes remain authoritative. */
export function reconcileMaicNativeSource(seed: NativeClassroomSeed, resourceUrls: ReadonlyMap<string, { url: string; mimeType: string }>): MaicClassroom {
  if (!seed.classroom) throw new Error("Generate canonical classroom content before native reconciliation");
  const classroom = parseMaicClassroom(seed.classroom);
  if (!seed.ir || seed.ir.pages.length !== seed.project.pages.length || seed.mapping.pages.length !== seed.project.pages.length)
    throw new Error("Native classroom page mapping differs from saved source");
  const converted = mapMaicSlideIrToScenes(classroom.stage.id, seed.ir);
  const boundScenes = new Set<string>();
  const nativeOrder: string[] = [];
  const replaceSlides = seed.sourceRevision !== seed.currentSourceRevision;
  for (const [index, page] of seed.project.pages.entries()) {
    const binding = seed.mapping.pages.find(item => item.pageId === page.pageId);
    const scene = classroom.scenes.find(item => item.id === binding?.planPageId || item.id === page.pageId || item.metadata?.nativePageId === page.pageId);
    if (!binding || !scene || scene.content.type !== "slide" || boundScenes.has(scene.id))
      throw new Error("Native slide identity requires explicit reassociation");
    boundScenes.add(scene.id); nativeOrder.push(scene.id);
    const mapped = converted[index];
    if (mapped.content.type !== "slide") throw new Error("Native slide conversion did not produce a slide");
    if (replaceSlides) {
      const canvas = structuredClone(mapped.content.canvas);
      canvas.id = scene.content.canvas.id;
      // Imported IDs can change after native saves. Retain the question anchor by saved shape identity.
      for (const element of canvas.elements) {
        const imported = seed.ir.pages[index].elements.find(raw => raw.id === element.id);
        const previous = scene.content.canvas.elements.find(old => old.id === element.id || old.id === imported?.sourceObjectName ||
          old.sourceShapeId && old.sourceShapeId === element.sourceShapeId);
        if (previous) element.id = previous.id;
        const question = scene.actions?.find(action => action.type === "interaction_checkpoint" && action.checkpointKind === "chapter_summary");
        if ((element.id === (typeof scene.metadata?.nativeQuestionElementId === "string" ? scene.metadata.nativeQuestionElementId : `${scene.id}_question`)) &&
            element.type === "text" && question && "question" in question) {
          const plain = (text: string) => text.replace(/<[^>]*>/gu, "").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&").trim();
          const savedText = plain(element.content);
          const baseline = typeof scene.metadata?.nativeQuestionText === "string" ? scene.metadata.nativeQuestionText :
            previous?.type === "text" ? plain(previous.content) : String(question.question);
          if (savedText !== baseline) {
            if (String(question.question) !== baseline && String(question.question) !== savedText)
              throw new Error("Question changed in both native and structured editors; resolve the conflict");
            question.question = savedText;
          } else {
            const escaped = String(question.question).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
            element.content = `<p>${escaped}</p>`;
          }
          scene.metadata = { ...scene.metadata, nativeQuestionText: savedText };
        }
      }
      const validated = parseMaicClassroom({ ...classroom, scenes: [{ ...scene, content: { type: "slide", canvas } }], mediaManifest: [], audioManifest: [] }).scenes[0];
      if (validated.content.type !== "slide") throw new Error("Native canvas validation failed");
      scene.content.canvas = validated.content.canvas;
      scene.metadata = { ...scene.metadata, nativePageId: page.pageId };
      classroom.mediaManifest = (classroom.mediaManifest ?? []).filter(asset => asset.sceneId !== scene.id);
      const visit = (value: unknown, targetId = "__background__"): void => {
        if (!value || typeof value !== "object") return;
        if ("id" in value && typeof value.id === "string") targetId = value.id;
        for (const [key, child] of Object.entries(value).sort(([a], [b]) => Number(a === "poster") - Number(b === "poster"))) {
          if (["src", "poster"].includes(key) && typeof child === "string" && child) {
            const resource = resourceUrls.get(child);
            if (!resource) throw new Error(`Native resource is not archived: ${child}`);
            (value as Record<string, unknown>)[key] = resource.url;
            const existing = classroom.mediaManifest!.find(entry => entry.sceneId === scene.id && entry.elementId === targetId);
            if (key === "poster" && existing) {
              existing.posterAssetId = `native-${digest(Buffer.from(resource.url)).slice(0, 32)}`;
              existing.posterUrl = resource.url; existing.originalPosterUrl = resource.url;
              continue;
            }
            if (existing) {
              if (existing.src !== resource.url) throw new Error("Native element contains ambiguous resource ownership");
              continue;
            }
            classroom.mediaManifest!.push({ sceneId: scene.id, elementId: targetId,
              assetId: `native-${digest(Buffer.from(resource.url)).slice(0, 32)}`, assetType: resource.mimeType.startsWith("video/") ? "video" : resource.mimeType.startsWith("audio/") ? "audio" : "image",
              mimeType: resource.mimeType, src: resource.url, originalSrc: resource.url });
          } else visit(child, targetId);
        }
      };
      visit(scene.content.canvas.background, "__background__");
      for (const element of scene.content.canvas.elements) visit(element, element.id);
    }
    const nativeSpeeches = page.actions.filter(action => action.type === "speech" && typeof action.text === "string");
    const nativeText = nativeSpeeches.map(action => String(action.text)).join("\n");
    const canonicalSpeeches = (scene.actions ?? []).filter(action => action.type === "speech");
    const canonicalText = canonicalSpeeches.map(action => action.type === "speech" ? action.text : "").join("\n");
    const baseline = scene.metadata?.nativeNarrationText;
    if (typeof baseline === "string" && nativeText !== baseline) {
      if (canonicalText !== baseline && canonicalText !== nativeText)
        throw new Error("Narration changed in both native and structured editors; resolve the conflict");
      const unsupported = page.actions.find(action => ["teacher_continue", "delay", "audio_clip", "video_clip", "native_animation", "video_slot", "music_slot"].includes(String(action.type)) ||
        action.type === "speech" && Array.isArray(action.visualCues) && action.visualCues.length > 0);
      if (unsupported) throw new Error(`Native teaching action requires explicit MAIC translation: ${unsupported.type}`);
      const previousIds = new Set(canonicalSpeeches.map(action => action.id));
      const speeches = nativeSpeeches.map((action, speechIndex) => ({ id: canonicalSpeeches[speechIndex]?.id ?? `${scene.id}-native-speech-${String(action.id ?? speechIndex)}`,
        type: "speech", text: String(action.text) }));
      const validated = parseMaicClassroom({ ...classroom, scenes: [{ ...scene, actions: speeches }], mediaManifest: [], audioManifest: [] }).scenes[0].actions ?? [];
      const firstSpeech = (scene.actions ?? []).findIndex(action => action.type === "speech");
      const remaining: NonNullable<typeof scene.actions> = (scene.actions ?? []).filter(action => action.type !== "speech");
      remaining.splice(firstSpeech < 0 ? 0 : Math.min(firstSpeech, remaining.length), 0, ...validated);
      scene.actions = remaining;
      classroom.audioManifest = (classroom.audioManifest ?? []).filter(entry => entry.sceneId !== scene.id || !previousIds.has(entry.actionId));
    }
    scene.metadata = { ...scene.metadata, nativeNarrationText: nativeText };
    // Native TTS is reusable only for the exact spoken text; editor changes cannot inherit obsolete audio.
    for (const speech of scene.actions ?? []) {
      if (speech.type !== "speech") continue;
      const native = page.actions.find(action => action.type === "speech" && action.text === speech.text && typeof action.audioAssetId === "string");
      if (!native) continue;
      const assetId = String(native.audioAssetId), asset = resourceUrls.get(assetId);
      const previousAudio: unknown = scene.metadata?.nativeAudioBindings;
      if (previousAudio && typeof previousAudio === "object" && !Array.isArray(previousAudio) &&
          Reflect.get(previousAudio, String(native.id ?? speech.id)) === assetId && speech.audioId && speech.audioId !== assetId) continue;
      if (!asset) throw new Error(`Native narration asset is not archived: ${assetId}`);
      speech.audioId = assetId; speech.audioUrl = asset.url;
      scene.metadata = { ...scene.metadata, nativeAudioBindings: {
        ...(scene.metadata?.nativeAudioBindings && typeof scene.metadata.nativeAudioBindings === "object" ? scene.metadata.nativeAudioBindings : {}),
        [String(native.id ?? speech.id)]: assetId,
      } };
      classroom.audioManifest = (classroom.audioManifest ?? []).filter(entry => entry.sceneId !== scene.id || entry.actionId !== speech.id);
      classroom.audioManifest.push({ sceneId: scene.id, actionId: speech.id, assetId, audioId: assetId,
        mimeType: asset.mimeType, url: asset.url, originalUrl: asset.url });
    }
  }
  if (classroom.scenes.filter(scene => scene.type === "slide" && typeof scene.metadata?.nativePageId === "string").some(scene => !boundScenes.has(scene.id)))
    throw new Error("Canonical slide no longer exists in saved native source");
  if (replaceSlides) {
    const slides = nativeOrder.map(id => classroom.scenes.find(scene => scene.id === id)!);
    classroom.scenes = classroom.scenes.map(scene => boundScenes.has(scene.id) ? slides.shift()! : scene);
    classroom.scenes.forEach((scene, order) => { scene.order = order; });
  }
  return parseMaicClassroom(classroom);
}

/** Host supplies verified parser output and archived files; no renderer path is accepted. */
export async function refreshNativeMaicClassroom(input: {
  host: Host; sessionId: string; projectId: string; jobId: string; workspace: string; assertCurrent?: () => Promise<void>;
}) {
  await input.assertCurrent?.();
  const seed = await input.host.call<NativeClassroomSeed>("courseware.classroom.source", {
    sessionId: input.sessionId, projectId: input.projectId, jobId: input.jobId,
  });
  if (!seed.classroom || seed.revision === null) return { projectId: seed.projectId, revision: seed.revision,
    sourceRevision: seed.currentSourceRevision, classroom: seed.classroom };
  const resources = new Map<string, { url: string; mimeType: string }>();
  let total = 0;
  for (const asset of seed.assets) {
    const bytes = await readFile(asset.path); total += bytes.length;
    if (!bytes.length || bytes.length > 50 * 1024 * 1024 || total > 256 * 1024 * 1024 || digest(bytes) !== asset.sha256)
      throw new Error("Native classroom archived asset changed");
    const extensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg",
      "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/webm": "webm", "video/mp4": "mp4", "video/webm": "webm" };
    const extension = extensions[asset.mimeType];
    if (!extension) throw new Error("Unsupported native classroom resource MIME");
    const url = `.deckwise-ppt/classroom-assets/${asset.sha256}.${extension}`;
    const destination = await resolveRealPathForCreateWithinRoot(input.workspace, url);
    if (!destination) throw new Error("Native classroom asset directory escaped workspace");
    await mkdir(dirname(destination), { recursive: true });
    if (await resolveRealPathForCreateWithinRoot(input.workspace, url) !== destination)
      throw new Error("Native classroom asset directory changed");
    try { await writeFile(destination, bytes, { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || digest(await readFile(destination)) !== asset.sha256) throw error;
    }
    resources.set(asset.id, { url, mimeType: asset.mimeType });
    resources.set(`import-asset:local:${asset.id}`, { url, mimeType: asset.mimeType });
  }
  const classroom = reconcileMaicNativeSource(seed, resources);
  await input.assertCurrent?.();
  if (seed.sourceRevision === seed.currentSourceRevision && JSON.stringify(classroom) === JSON.stringify(seed.classroom))
    return { projectId: seed.projectId, revision: seed.revision, sourceRevision: seed.sourceRevision, classroom };
  const view = await input.host.call<{ projectId: string; revision: string | null; sourceRevision: string; classroom: MaicClassroom | null }>("courseware.classroom.refresh", {
    sessionId: input.sessionId, projectId: input.projectId, jobId: input.jobId, expectedRevision: seed.revision,
    expectedSourceRevision: seed.currentSourceRevision, classroom,
  });
  await input.assertCurrent?.();
  return view;
}
