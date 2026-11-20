import { createHash } from "node:crypto";
import { createCoursewareSceneGenerator } from "./courseware-scene-generator";
import type { CoursewareSceneImage } from "./courseware-scene-context";
import type { SceneCoursePlanPage } from "./courseware-scene-plan";

type Authoring = Pick<typeof import("@pi-desktop/courseware-runtime/authoring"), "editablePptxSceneSchema" | "compileScenesToPptx" | "assessmentPptxScene" | "assessmentBackground" | "createMaicInteractionCanvas">;
type Visuals = { pageId: string; visualMasterAssetId: string; cleanPlateAssetId: string; images: CoursewareSceneImage[];
  foregroundPlacements?: { assetId: string; bboxPx: [number, number, number, number]; zIndex?: number; semanticRole?: string; layerMetadata?: { name: string; description: string } }[] };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Scene lettering stays in image layers; approved native-text plans retain their mode during recovery. */
export async function buildSceneCourseDeck(input: {
  sessionId: string;
  modelKey: string;
  thinkingLevel?: string;
  pages: SceneCoursePlanPage[];
  textMode?: "native";
  visuals: Visuals[];
  canvas: { width: number; height: number };
  signal?: AbortSignal;
}, complete: Parameters<typeof createCoursewareSceneGenerator>[1], authoring: Authoring) {
  const { pages, visuals, signal } = input;
  const slidePages = pages.filter(page => !page.quiz && !page.teaching?.question);
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > 100 || !Array.isArray(visuals) || visuals.length !== slidePages.length ||
      new Set(pages.map((page) => page.pageId)).size !== pages.length ||
      new Set(visuals.map((visual) => visual.pageId)).size !== visuals.length ||
      !Number.isFinite(input.canvas.width) || !Number.isFinite(input.canvas.height) ||
      input.canvas.width < 100 || input.canvas.width > 4096 || input.canvas.height < 100 || input.canvas.height > 4096)
    throw new Error("Invalid scene course pages, visuals or canvas");
  const scenes: ReturnType<Authoring["editablePptxSceneSchema"]["parse"]>[] = [];
  const assets: Record<string, Uint8Array> = {};
  for (const page of pages) {
    if (page.quiz || page.teaching?.question) {
      if (page.narration !== "" || page.visibleText.length || page.teaching?.requiredObjects.length || page.teaching?.music || page.teaching?.video)
        throw new Error(`Assessment ${page.pageId} must preserve a separate body activity slide; refusing to discard body content`);
      const question = page.teaching?.question;
      const canonical: Parameters<Authoring["assessmentPptxScene"]>[0] = { id: page.pageId, stageId: "generated", type: page.quiz ? "quiz" : "slide", title: page.title, order: scenes.length,
        content: page.quiz ?? { type: "slide", canvas: authoring.createMaicInteractionCanvas(page.pageId, page.title, question!.text, input.canvas.width, input.canvas.height / input.canvas.width) },
        actions: question ? [{ id: `${page.pageId}-interaction`, type: "interaction_checkpoint", checkpointKind: "chapter_summary",
          checkpointId: `${page.pageId}-checkpoint`, chapterId: page.pageId, chapterTitle: page.title, question: question.text,
          referenceAnswer: question.referenceAnswer ?? { summary: "", keyPoints: [] }, context: { chapterSummary: page.title, sourceSceneIds: [] } }] : [] };
      scenes.push(authoring.assessmentPptxScene(canonical, page.sourceHash, input.canvas));
      assets[authoring.assessmentBackground.id] = authoring.assessmentBackground.bytes;
      continue;
    }
    signal?.throwIfAborted();
    const visual = visuals.find((item) => item.pageId === page.pageId);
    if (!visual || !/^sha256:[a-f0-9]{64}$/u.test(page.sourceHash) || !Array.isArray(page.visibleText) ||
        typeof page.visualIntent !== "string" || typeof page.narration !== "string")
      throw new Error(`Missing or invalid planned page visuals: ${page.pageId}`);
    const generate = createCoursewareSceneGenerator({ sessionId: input.sessionId, modelKey: input.modelKey,
      thinkingLevel: input.thinkingLevel, visualMasterAssetId: visual.visualMasterAssetId,
      cleanPlateAssetId: visual.cleanPlateAssetId, images: visual.images }, complete);
    const foregrounds = visual.images.filter(image => !image.assetIds.includes(visual.visualMasterAssetId) &&
      !image.assetIds.includes(visual.cleanPlateAssetId));
    const nativePlacements = visual.foregroundPlacements;
    const completeNative = nativePlacements?.length === foregrounds.length && foregrounds.length > 0 &&
      foregrounds.every(image => nativePlacements.some(placement => image.assetIds.includes(placement.assetId)));
    const nativeText = input.textMode === "native";
    const result = completeNative && (!nativeText || !page.visibleText.length) ? {
      scene: { version: 1, slideId: page.pageId, sourceHash: page.sourceHash, canvas: input.canvas,
        visualMasterAssetId: visual.visualMasterAssetId, cleanPlateAssetId: visual.cleanPlateAssetId,
        elements: nativePlacements.map((placement, index) => ({ id: placement.assetId, type: "image_layer",
          assetId: placement.assetId, bboxPx: placement.bboxPx, zIndex: placement.zIndex ?? index + 1,
          layerRoute: "A1", semanticRole: placement.semanticRole || placement.assetId })) },
      assets: Object.fromEntries(visual.images.flatMap(image => image.assetIds.map(id => [id, image.bytes]))),
    } : await generate({ pageId: page.pageId, sourceHash: page.sourceHash,
      pageText: page.visibleText.join("\n"),
      instruction: nativeText
        ? `Build this page from the supplied textless image layers and native_text. Page context: ${page.title}. Visual intent: ${page.visualIntent}. Keep every supplied foreground as one image_layer at its original position. Add exactly one native_text for each approved display string, preserving exact characters and punctuation: ${JSON.stringify(page.visibleText)}. Place readable text in clear space without covering subjects or other text. Use hierarchy, contrast and an appropriate font size. Do not create shapes, connectors, raster lettering, extra text or teacher narration. Teacher narration is separate and must not appear on the slide.`
        : `Build this page from the supplied image layers only. Page context (not extra display text): ${page.title}. Visual intent: ${page.visualIntent}. Treat the visual master as the design authority: preserve its composition and all lettering exactly as rendered in the decomposed image pixels. Use only image_layer elements, one per supplied foreground, including text carriers. Do not create native_text, shapes, connectors or replacement lettering. These approved child-facing strings are already in the images and are semantic context only: ${JSON.stringify(page.visibleText)}. Do not redesign, duplicate, omit or flatten the layers. Teacher narration is separate and must not appear on the slide.`,
      canvas: input.canvas, schema: authoring.editablePptxSceneSchema }, signal);
    const scene = authoring.editablePptxSceneSchema.parse(result.scene);
    if (scene.elements.some(element => element.type !== "image_layer" && !(nativeText && element.type === "native_text")))
      throw new Error(`Scene pages use decomposed image layers only: ${page.pageId}`);
    if (nativeText && JSON.stringify(scene.elements.filter(element => element.type === "native_text").map(element => element.content).sort()) !== JSON.stringify([...page.visibleText].sort()))
      throw new Error(`Scene native text must match every approved display string exactly once: ${page.pageId}`);
    const layers = visual.images.filter(image => !image.assetIds.includes(visual.visualMasterAssetId) &&
      !image.assetIds.includes(visual.cleanPlateAssetId));
    const placed = scene.elements.filter(element => element.type === "image_layer");
    for (const placement of visual.foregroundPlacements ?? []) {
      if (placement.bboxPx.length !== 4 || placement.bboxPx.some(n => !Number.isFinite(n)) || placement.bboxPx[0] < 0 || placement.bboxPx[1] < 0 ||
          placement.bboxPx[2] <= 0 || placement.bboxPx[3] <= 0 || placement.bboxPx[0] + placement.bboxPx[2] > input.canvas.width + 0.001 ||
          placement.bboxPx[1] + placement.bboxPx[3] > input.canvas.height + 0.001) throw new Error("Invalid decomposition placement");
      const element = placed.find(element => element.assetId === placement.assetId);
      if (!element) throw new Error("Missing decomposed foreground");
      // The supplier's crop bounds preserve the master composition; model guesses must not move its subjects.
      element.bboxPx = [...placement.bboxPx];
      element.rotate = 0;
      if (placement.layerMetadata) element.layerMetadata = placement.layerMetadata;
      if (placement.zIndex !== undefined) {
        if (!Number.isSafeInteger(placement.zIndex) || placement.zIndex < 1 || placement.zIndex > 1_000_000) throw new Error("Invalid decomposition z-index");
        element.zIndex = placement.zIndex;
      }
      delete element.crop;
    }
    if (!layers.length || placed.length !== layers.length || layers.some(image => !placed.some(element => image.assetIds.includes(element.assetId))) ||
        placed.some(element => !layers.some(image => image.assetIds.includes(element.assetId))))
      throw new Error(`Scene page must retain every reviewed foreground as a separate object: ${page.pageId}`);
    if (placed.some(element => !element.semanticRole))
      throw new Error(`Scene foreground needs a reviewable semantic role: ${page.pageId}`);
    for (const [id, bytes] of Object.entries(result.assets)) {
      if (assets[id] && hash(assets[id]) !== hash(bytes)) throw new Error(`Scene asset ID has conflicting bytes: ${id}`);
      assets[id] = bytes;
    }
    scenes.push(scene);
  }
  signal?.throwIfAborted();
  const compiled = scenes.length ? await authoring.compileScenesToPptx(scenes, assets) : { pptx: new Uint8Array(), mapping: undefined };
  signal?.throwIfAborted();
  if (scenes.length && (compiled.pptx.length < 1 || compiled.pptx.length > 50 * 1024 * 1024 || compiled.mapping?.pages.length !== pages.length))
    throw new Error("Invalid compiled scene course deck");
  // These are the same image objects, geometry and pixels compiled above, expressed in MAIC's PPTist canvas.
  // Quiz navigation cards are local PPT pages; canonical Quiz remains independent content.
  const stageId = `course-${hash(Buffer.from(input.sessionId + pages.map(page => page.sourceHash).join("|"))).slice(0, 32)}`, now = Date.now();
  const mediaManifest: Array<{ sceneId: string; elementId: string; assetId: string; assetType: "image"; mimeType: string; src: string; originalSrc: string }> = [];
  const canonicalScenes = pages.map((page, order) => {
    const actions: Record<string, unknown>[] = page.narration.trim() ? [{ id: `${page.pageId}-speech`, type: "speech", text: page.narration }] : [];
    if (page.quiz) return { id: page.pageId, stageId, type: "quiz", title: page.title, order, content: structuredClone(page.quiz), actions };
    const question = page.teaching?.question;
    if (question) actions.push({ id: `${page.pageId}-interaction`, type: "interaction_checkpoint", checkpointKind: "chapter_summary",
      checkpointId: `${page.pageId}-checkpoint`, chapterId: page.pageId, chapterTitle: page.title, question: question.text,
      referenceAnswer: question.referenceAnswer ?? { summary: question.response.answerIndices.map(index => question.response.options[index]).join("；"), keyPoints: [] },
      ...(question.constraintPrompt ? { constraintPrompt: question.constraintPrompt } : {}),
      context: { chapterSummary: page.teaching?.objective ?? page.title, sourceSceneIds: [page.pageId] } });
    if (question) return { id: page.pageId, stageId, type: "slide", title: page.title, order,
      content: { type: "slide", canvas: authoring.createMaicInteractionCanvas(page.pageId, page.title, question.text, input.canvas.width, input.canvas.height / input.canvas.width) }, actions,
      metadata: { interaction: { kind: "chapter_summary", chapterId: page.pageId, chapterTitle: page.title, sourceSceneIds: [page.pageId] } } };
    const scene = scenes[order];
    const background = assets[scene.cleanPlateAssetId];
    if (!background) throw new Error("Missing generated clean background pixels");
    const backgroundMime = background[0] === 0xff && background[1] === 0xd8 ? "image/jpeg" : "image/png";
    const backgroundSrc = `data:${backgroundMime};base64,${Buffer.from(background).toString("base64")}`;
    const backgroundAssetId = `image-${hash(background)}`;
    const backgroundElementId = `${page.pageId}_background`;
    mediaManifest.push({ sceneId: page.pageId, elementId: backgroundElementId, assetId: backgroundAssetId, assetType: "image", mimeType: backgroundMime, src: backgroundSrc, originalSrc: backgroundSrc });
    const elements = [...scene.elements].filter(element => element.type !== "native_shape").sort((a, b) => a.zIndex - b.zIndex).map(element => {
      if (element.type === "native_text") {
        const [left, top, width, height] = element.bboxPx;
        const escaped = element.content.replace(/[&<>"']/g, value => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[value]!));
        return { id: element.id, type: "text", left, top, width, height, rotate: 0,
          content: `<p style="text-align:${element.style.align};"><span style="font-size:${element.style.fontSizePt / 0.72}px;color:${element.style.color};font-weight:${element.style.fontWeight ?? 400};">${escaped}</span></p>`, defaultFontName: element.style.fontFace, defaultColor: element.style.color };
      }
      if (element.type !== "image_layer") throw new Error("Generated PPTist requires image layers or bound question text");
      const bytes = assets[element.assetId];
      if (!bytes) throw new Error("Missing generated image pixels");
      const mimeType = bytes[0] === 0xff && bytes[1] === 0xd8 ? "image/jpeg" : "image/png";
      const src = `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
      mediaManifest.push({ sceneId: page.pageId, elementId: element.id, assetId: `image-${hash(bytes)}`, assetType: "image", mimeType, src, originalSrc: src });
      const [left, top, width, height] = element.bboxPx;
      return { id: element.id, type: "image", left, top, width, height, rotate: element.rotate ?? 0,
        fixedRatio: true, assetId: `image-${hash(bytes)}`, src,
        ...(element.opacity !== undefined ? { filters: { opacity: `${Math.round(element.opacity * 100)}%` } } : {}),
        ...(element.crop ? { clip: { shape: "rect", range: element.crop } } : {}) };
    });
    return { id: page.pageId, stageId, type: "slide", title: page.title, order,
      content: { type: "slide", canvas: { id: page.pageId, viewportSize: input.canvas.width, viewportRatio: input.canvas.height / input.canvas.width,
        theme: { backgroundColor: "#FFFFFF", themeColors: ["#3B82F6"], fontColor: "#111827", fontName: "Arial" }, elements: [
          { id: backgroundElementId, type: "image", left: 0, top: 0, width: input.canvas.width, height: input.canvas.height, rotate: 0, fixedRatio: false, imageType: "background", assetId: backgroundAssetId, src: backgroundSrc }, ...elements] } }, actions };
  });
  const canonicalClassroom = { id: stageId, stage: { id: stageId, name: pages[0].title, createdAt: now, updatedAt: now,
    canvas: { preset: "WIDE_16_9", viewportSize: input.canvas.width, viewportRatio: input.canvas.height / input.canvas.width } },
    scenes: canonicalScenes, mediaManifest, audioManifest: [], createdAt: new Date(now).toISOString() };
  return { ...compiled, ...(compiled.mapping ? { mapping: { ...compiled.mapping,
    pages: compiled.mapping.pages.map((entry, index) => ({ ...entry, ...(pages[index].teaching ? { teaching: pages[index].teaching } : {}) })) } } : {}),
    teaching: pages.map(({ pageId, title, narration, teaching, quiz }) => ({ pageId, title, narration, teaching, quiz })), canonicalClassroom };
}
