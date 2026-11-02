import { createHash } from "node:crypto";
import { createCoursewareSceneGenerator } from "./courseware-scene-generator";
import type { CoursewareSceneImage } from "./courseware-scene-context";
import type { SceneCoursePlanPage } from "./courseware-scene-plan";

type Authoring = Pick<typeof import("@pi-desktop/courseware-runtime/authoring"), "editablePptxSceneSchema" | "compileScenesToPptx">;
type Visuals = { pageId: string; visualMasterAssetId: string; cleanPlateAssetId: string; images: CoursewareSceneImage[];
  foregroundPlacements?: { assetId: string; bboxPx: [number, number, number, number]; zIndex?: number; semanticRole?: string }[] };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Preserve decomposed images as independently editable PPTX objects, including lettering. */
export async function buildSceneCourseDeck(input: {
  sessionId: string;
  modelKey: string;
  thinkingLevel?: string;
  pages: SceneCoursePlanPage[];
  visuals: Visuals[];
  canvas: { width: number; height: number };
  signal?: AbortSignal;
}, complete: Parameters<typeof createCoursewareSceneGenerator>[1], authoring: Authoring) {
  const { pages, visuals, signal } = input;
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > 30 || !Array.isArray(visuals) || visuals.length !== pages.length ||
      new Set(pages.map((page) => page.pageId)).size !== pages.length ||
      new Set(visuals.map((visual) => visual.pageId)).size !== visuals.length ||
      !Number.isFinite(input.canvas.width) || !Number.isFinite(input.canvas.height) ||
      input.canvas.width < 100 || input.canvas.width > 4096 || input.canvas.height < 100 || input.canvas.height > 4096)
    throw new Error("Invalid scene course pages, visuals or canvas");
  const scenes: unknown[] = [];
  const assets: Record<string, Uint8Array> = {};
  for (const page of pages) {
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
    const result = completeNative ? {
      scene: { version: 1, slideId: page.pageId, sourceHash: page.sourceHash, canvas: input.canvas,
        visualMasterAssetId: visual.visualMasterAssetId, cleanPlateAssetId: visual.cleanPlateAssetId,
        elements: nativePlacements.map((placement, index) => ({ id: placement.assetId, type: "image_layer",
          assetId: placement.assetId, bboxPx: placement.bboxPx, zIndex: placement.zIndex ?? index + 1,
          layerRoute: "A1", semanticRole: placement.semanticRole || placement.assetId })) },
      assets: Object.fromEntries(visual.images.flatMap(image => image.assetIds.map(id => [id, image.bytes]))),
    } : await generate({ pageId: page.pageId, sourceHash: page.sourceHash,
      pageText: page.visibleText.join("\n"),
      instruction: `Build this page from the supplied image layers only. Page context (not extra display text): ${page.title}. Visual intent: ${page.visualIntent}. Treat the visual master as the design authority: preserve its composition and all lettering exactly as rendered in the decomposed image pixels. Use only image_layer elements, one per supplied foreground, including text carriers. Do not create native_text, shapes, connectors or replacement lettering. These approved child-facing strings are already in the images and are semantic context only: ${JSON.stringify(page.visibleText)}. Do not redesign, duplicate, omit or flatten the layers. Teacher narration is separate and must not appear on the slide.`,
      canvas: input.canvas, schema: authoring.editablePptxSceneSchema }, signal);
    const scene = authoring.editablePptxSceneSchema.parse(result.scene);
    if (scene.elements.some(element => element.type !== "image_layer"))
      throw new Error(`Scene pages use decomposed image layers only: ${page.pageId}`);
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
  const compiled = await authoring.compileScenesToPptx(scenes, assets);
  signal?.throwIfAborted();
  if (compiled.pptx.length < 1 || compiled.pptx.length > 50 * 1024 * 1024 || compiled.mapping.pages.length !== pages.length)
    throw new Error("Invalid compiled scene course deck");
  return { ...compiled, mapping: { ...compiled.mapping, pages: compiled.mapping.pages.map((entry, index) => ({ ...entry, ...(pages[index].teaching ? { teaching: pages[index].teaching } : {}) })) }, teaching: pages.map(({ pageId, narration }) => ({ pageId, narration })) };
}
