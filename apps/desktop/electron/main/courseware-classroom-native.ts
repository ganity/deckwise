import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveRealPathForCreateWithinRoot } from "./fs-panel";
import { canonicalJson, decodeHtmlEntities, mapMaicSlideIrToScenes, parseMaicClassroom, prepareMaicAssessmentSpeech, type MaicClassroom, type MaicSlideIR } from "@pi-desktop/courseware-runtime/node";

import { convertNativeTeaching, type NativeResource } from "./courseware-classroom-timeline";

type Host = { call<T>(method: string, params: unknown): Promise<T> };
type NativePage = { pageId: string; actions: Array<Record<string, unknown>> };
type Asset = { id: string; path: string; sha256: string; mimeType: string; durationMs?: number };
type ConvertedSlide = {
  slide: Extract<ReturnType<typeof mapMaicSlideIrToScenes>[number]["content"], { type: "slide" }>["canvas"];
  objects: Array<{ objectId: string; importElementId: string }>;
};
export type NativeClassroomSeed = {
  projectId: string; revision: string | null; sourceRevision: string; currentSourceRevision: string;
  classroom: MaicClassroom | null; ir: MaicSlideIR;
  project: { pages: NativePage[]; source?: { sha256: string }; teachingRevision?: string };
  mapping: { pages: Array<{ pageId: string; planPageId?: string; importPageId?: string; objects?: Array<{ objectId: string; importElementId: string }> }> };
  convertedSlides?: ReadonlyMap<string, ConvertedSlide>;
  assets: Asset[];
};
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const plainQuestion = (html: string) => decodeHtmlEntities(html.replace(/<[^>]*>/gu, "")).replaceAll("\u00a0", " ").trim();

/** Reconcile saved native teaching while independent Quiz scenes remain authoritative. */
export function reconcileMaicNativeSource(seed: NativeClassroomSeed, resourceUrls: ReadonlyMap<string, NativeResource>, platformDelivery = false): MaicClassroom {
  if (!seed.classroom) throw new Error("Generate canonical classroom content before native reconciliation");
  const classroom = parseMaicClassroom(seed.classroom);
  if (!seed.ir || seed.ir.pages.length !== seed.project.pages.length || seed.mapping.pages.length !== seed.project.pages.length)
    throw new Error("Native classroom page mapping differs from saved source");
  const converted = mapMaicSlideIrToScenes(classroom.stage.id, seed.ir);
  const boundScenes = new Set<string>();
  const nativeOrder: string[] = [];
  const replaceSlides = seed.revision === null || seed.sourceRevision !== seed.currentSourceRevision;
  for (const [index, page] of seed.project.pages.entries()) {
    const binding = seed.mapping.pages.find(item => item.pageId === page.pageId);
    let scene = classroom.scenes.find(item => item.id === binding?.planPageId || item.id === page.pageId || item.metadata?.nativePageId === page.pageId);
    if (binding && !binding.planPageId && !scene && replaceSlides) {
      // Native duplication preserves object names. Only an unambiguous assessment anchor may copy its semantics.
      const names = new Set(seed.ir.pages[index].elements.map(element => element.sourceObjectName));
      const originals = classroom.scenes.filter(item => {
        const questionId = typeof item.metadata?.nativeQuestionElementId === "string" ? item.metadata.nativeQuestionElementId : `${item.id}_question`;
        return names.has(questionId) && names.has(questionId.replace(/_question$/u, "_section_label"));
      });
      if (originals.length > 1) throw new Error("Native slide identity requires explicit reassociation");
      const original = originals.length === 1 ? originals[0] : undefined;
      scene = original ? structuredClone(original) : parseMaicClassroom({ ...classroom, scenes: [{ ...converted[index], actions: [] }], mediaManifest: [], audioManifest: [] }).scenes[0];
      const oldId = scene.id;
      scene.id = `native-${page.pageId}`; scene.order = index;
      scene.metadata = { ...scene.metadata, nativePageId: page.pageId, nativeNarrationText: "" };
      delete scene.metadata.nativeAudioBindings;
      for (const key of ["nativeTeachingSignature", "nativeTeachingActionIds", "nativeTeachingActionsHash"]) delete scene.metadata[key];
      if (original) {
        scene.metadata.nativeQuestionElementId = original.metadata?.nativeQuestionElementId ?? `${oldId}_question`;
        const ids = new Map((scene.actions ?? []).map(action => [action.id, randomUUID()]));
        scene.actions = scene.actions?.map(action => {
          const next = { ...action, id: ids.get(action.id)! };
          if (next.type === "speech") { delete next.audioId; delete next.audioUrl; }
          if (next.type === "interaction_checkpoint") next.checkpointId = randomUUID();
          return next;
        });
        if (scene.metadata.assessmentSpeechIds) scene.metadata.assessmentSpeechIds = Object.fromEntries(
          Object.entries(scene.metadata.assessmentSpeechIds).flatMap(([key, id]) => ids.has(key) && ids.has(String(id)) ? [[ids.get(key)!, ids.get(String(id))!]] : []));
        classroom.mediaManifest = [...(classroom.mediaManifest ?? []), ...(classroom.mediaManifest ?? []).filter(asset => asset.sceneId === oldId).map(asset => ({ ...asset, sceneId: scene!.id }))];
      }
      classroom.scenes.push(scene);
    }
    if (!binding || !scene || boundScenes.has(scene.id))
      throw new Error("Native slide identity requires explicit reassociation");
    const convertedSlide = seed.convertedSlides?.get(page.pageId);
    const objects = convertedSlide?.objects ?? binding.objects;
    boundScenes.add(scene.id); nativeOrder.push(scene.id);
    if (seed.project.teachingRevision) scene.metadata = { ...scene.metadata, nativeTeachingRevision: seed.project.teachingRevision, nativePageId: page.pageId };
    // Repair text produced by the old partial decoder only while its saved baseline still matches.
    if (scene.content.type === "slide") {
      const anchor = scene.metadata?.nativeQuestionElementId ?? `${scene.id}_question`;
      const element = scene.content.canvas.elements.find(element => element.id === anchor && element.type === "text");
      const baseline = scene.metadata?.nativeQuestionText;
      if (element?.type === "text" && typeof baseline === "string") {
        const legacy = element.content.replace(/<[^>]*>/gu, "").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&").trim();
        const decoded = plainQuestion(element.content);
        if (baseline === legacy && baseline !== decoded) {
          for (const action of scene.actions ?? [])
            if (action.type === "interaction_checkpoint" && action.checkpointKind === "chapter_summary" && action.question === baseline) action.question = decoded;
          scene.metadata = { ...scene.metadata, nativeQuestionText: decoded };
        }
      }
    }
    const mapped = converted[index];
    if (mapped.content.type !== "slide") throw new Error("Native slide conversion did not produce a slide");
    if (replaceSlides && scene.content.type === "slide") {
      const canvas = structuredClone(convertedSlide?.slide ?? mapped.content.canvas);
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
          const savedText = plainQuestion(element.content);
          const baseline = typeof scene.metadata?.nativeQuestionText === "string" ? scene.metadata.nativeQuestionText :
            previous?.type === "text" ? plainQuestion(previous.content) : String(question.question);
          if (savedText !== baseline) {
            if (String(question.question) !== baseline && String(question.question) !== savedText)
              throw new Error("Question changed in both native and structured editors; resolve the conflict");
            question.question = savedText;
          } else if (String(question.question) !== savedText) {
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
    const assessmentIds = Object.values(scene.metadata?.assessmentSpeechIds ?? {});
    const canonicalSpeeches = (scene.actions ?? []).filter(action => action.type === "speech" && !assessmentIds.includes(action.id));
    const canonicalText = canonicalSpeeches.map(action => action.type === "speech" ? action.text : "").join("\n");
    const baseline = scene.metadata?.nativeNarrationText;
    scene.metadata = { ...scene.metadata };
    const extended = page.actions.some(action => action.type !== "speech" || Array.isArray(action.visualCues) && action.visualCues.length > 0) ||
      typeof scene.metadata.nativeTeachingSignature === "string";
    const signature = digest(Buffer.from(canonicalJson({ actions: page.actions, sourceSha256: seed.project.source?.sha256, objects })));
    const managedIds = Array.isArray(scene.metadata.nativeTeachingActionIds) ? scene.metadata.nativeTeachingActionIds.filter((id): id is string => typeof id === "string") : [];
    const fingerprint = (actions: NonNullable<typeof scene.actions>) => digest(Buffer.from(canonicalJson(actions.map(action => {
      const value = { ...action }; if (value.type === "speech") { delete value.audioId; delete value.audioUrl; } return value;
    }))));
    const nativeChanged = scene.metadata.nativeTeachingSignature !== signature;
    let structuredChanged = managedIds.length > 0 && scene.metadata.nativeTeachingActionsHash !== fingerprint((scene.actions ?? []).filter(action => managedIds.includes(action.id)));
    if (nativeChanged && structuredChanged) {
      try {
        const converted = convertNativeTeaching({ scene, actions: page.actions, page: seed.ir.pages[index], objects: objects ?? [], resources: resourceUrls, sourceSha256: seed.project.source?.sha256, platformDelivery });
        const restored = (scene.actions ?? []).filter(action => managedIds.includes(action.id)).map(action => {
          const original = converted.actions.find(next => next.id === action.id);
          return action.type === "element_animation" && !action.speechCue && original?.type === "element_animation" && original.speechCue
            ? { ...action, speechCue: original.speechCue } : action;
        });
        // Older Hosts removed timing after native narration saves; require the exact original baseline.
        structuredChanged = scene.metadata.nativeTeachingActionsHash !== fingerprint(restored);
      } catch { /* Conversion failures retain the conflict. */ }
    }
    let unsupported = false;
    if (extended || typeof baseline === "string" && nativeText !== baseline) {
      if (nativeChanged && (structuredChanged || typeof baseline === "string" && canonicalText !== baseline && canonicalText !== nativeText))
        throw new Error("Narration changed in both native and structured editors; resolve the conflict");
      if (!structuredChanged) {
        let converted: ReturnType<typeof convertNativeTeaching> | undefined;
        try {
          converted = convertNativeTeaching({ scene, actions: page.actions, page: seed.ir.pages[index], objects: objects ?? [], resources: resourceUrls, sourceSha256: seed.project.source?.sha256, platformDelivery });
        } catch (error) {
          unsupported = true;
          scene.metadata.nativeTeachingSyncPending = true;
          scene.metadata.nativeTeachingSyncReason = error instanceof Error ? error.message : String(error);
        }
        if (converted) {
          const previousIds = new Set([...managedIds, ...canonicalSpeeches.map(action => action.id)]);
          const remaining = (scene.actions ?? []).filter(action => !previousIds.has(action.id) && !converted!.actions.some(next => next.id === action.id));
          scene.actions = [...converted.actions, ...remaining];
          classroom.audioManifest = (classroom.audioManifest ?? []).filter(entry => entry.sceneId !== scene.id || scene.actions!.some(action => action.type === "speech" && action.id === entry.actionId && action.audioId === entry.audioId));
          const oldElements = Array.isArray(scene.metadata.nativeTeachingElementIds) ? scene.metadata.nativeTeachingElementIds : [];
          if (scene.content.type === "slide") scene.content.canvas.elements = [...scene.content.canvas.elements.filter(element => !oldElements.includes(element.id)), ...converted.elements];
          classroom.mediaManifest = [...(classroom.mediaManifest ?? []).filter(entry => entry.sceneId !== scene.id || !oldElements.includes(entry.elementId)), ...converted.media];
          scene.metadata.nativeTeachingSignature = signature;
          scene.metadata.nativeTeachingActionIds = converted.actions.map(action => action.id);
          scene.metadata.nativeTeachingElementIds = converted.elements.map(element => element.id);
          scene.metadata.nativeTeachingActionsHash = fingerprint(converted.actions);
        }
      }
    }
    if (!unsupported) {
      delete scene.metadata.nativeTeachingSyncPending;
      delete scene.metadata.nativeTeachingSyncReason;
      scene.metadata.nativeNarrationText = nativeText;
    }
    if (unsupported) continue;
    // Native TTS is reusable only for the exact spoken text; editor changes cannot inherit obsolete audio.
    const savedSpeeches = (scene.actions ?? []).filter(action => action.type === "speech" && !assessmentIds.includes(action.id));
    for (const [speechIndex, speech] of savedSpeeches.entries()) {
      if (speech.type !== "speech") continue;
      const byId = nativeSpeeches.find(action => action.id === speech.id);
      const indexed = nativeSpeeches[speechIndex];
      const native = byId ?? (indexed?.text === speech.text ? indexed : undefined);
      if (native?.text !== speech.text || typeof native.audioAssetId !== "string") continue;
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
  const removed = new Set(classroom.scenes.filter(scene => typeof scene.metadata?.nativePageId === "string" && !boundScenes.has(scene.id)).map(scene => scene.id));
  if (removed.size && !replaceSlides) throw new Error("Canonical slide no longer exists in saved native source");
  if (removed.size) {
    classroom.scenes = classroom.scenes.filter(scene => !removed.has(scene.id));
    classroom.mediaManifest = classroom.mediaManifest?.filter(asset => !asset.sceneId || !removed.has(asset.sceneId));
    classroom.audioManifest = classroom.audioManifest?.filter(asset => !asset.sceneId || !removed.has(asset.sceneId));
    for (const scene of classroom.scenes) {
      for (const action of scene.actions ?? []) if (action.type === "interaction_checkpoint" && action.checkpointKind === "chapter_summary")
        action.context.sourceSceneIds = action.context.sourceSceneIds.filter(id => !removed.has(id));
      const interaction = scene.metadata?.interaction;
      if (interaction && typeof interaction === "object" && "sourceSceneIds" in interaction && Array.isArray(interaction.sourceSceneIds))
        interaction.sourceSceneIds = interaction.sourceSceneIds.filter(id => !removed.has(id));
    }
  }
  if (replaceSlides) {
    const slides = nativeOrder.map(id => classroom.scenes.find(scene => scene.id === id)!);
    classroom.scenes = classroom.scenes.map(scene => boundScenes.has(scene.id) ? slides.shift()! : scene);
    classroom.scenes.forEach((scene, order) => { scene.order = order; });
  }
  return prepareMaicAssessmentSpeech(parseMaicClassroom(classroom), false);
}

/** Host supplies verified parser output and archived files; no renderer path is accepted. */
export async function refreshNativeMaicClassroom(input: {
  host: Host; sessionId: string; projectId: string; jobId: string; workspace: string; assertCurrent?: () => Promise<void>;
}) {
  await input.assertCurrent?.();
  const seed = await input.host.call<NativeClassroomSeed>("courseware.classroom.source", {
    sessionId: input.sessionId, projectId: input.projectId, jobId: input.jobId,
  });
  if (!seed.classroom && seed.project.pages.some(page => page.actions.some(action => action.type === "interaction_checkpoint" && action.checkpointKind === "chapter_summary"))) {
    const now = Date.now(), stageId = `${seed.projectId}-stage`;
    seed.classroom = parseMaicClassroom({ id: seed.projectId, createdAt: new Date(now).toISOString(),
      stage: { id: stageId, name: seed.ir.title || "Course", createdAt: now, updatedAt: now },
      scenes: mapMaicSlideIrToScenes(stageId, seed.ir).map((scene, index) => ({ ...scene, id: seed.project.pages[index].pageId,
        actions: [], metadata: { ...scene.metadata, nativePageId: seed.project.pages[index].pageId,
          nativeEmbeddedAssessments: true } })),
    });
  }
  if (!seed.classroom) return { projectId: seed.projectId, revision: seed.revision,
    sourceRevision: seed.currentSourceRevision, classroom: null };
  const resources = new Map<string, NativeResource>();
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
    resources.set(asset.id, { url, mimeType: asset.mimeType, durationMs: asset.durationMs });
    resources.set(`import-asset:local:${asset.id}`, { url, mimeType: asset.mimeType, durationMs: asset.durationMs });
  }
  const classroom = reconcileMaicNativeSource(seed, resources);
  await input.assertCurrent?.();
  if (seed.revision !== null && seed.sourceRevision === seed.currentSourceRevision && canonicalJson(classroom) === canonicalJson(seed.classroom))
    return { projectId: seed.projectId, revision: seed.revision, sourceRevision: seed.sourceRevision, classroom };
  const view = await input.host.call<{ projectId: string; revision: string | null; sourceRevision: string; classroom: MaicClassroom | null }>("courseware.classroom.refresh", {
    sessionId: input.sessionId, projectId: input.projectId, jobId: input.jobId, expectedRevision: seed.revision,
    expectedSourceRevision: seed.currentSourceRevision, classroom,
  });
  await input.assertCurrent?.();
  return view;
}
