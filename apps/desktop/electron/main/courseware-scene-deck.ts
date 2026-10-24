import { createHash } from "node:crypto";
import { createCoursewareSceneGenerator } from "./courseware-scene-generator";
import type { CoursewareSceneImage } from "./courseware-scene-context";
import type { SceneCoursePlanPage } from "./courseware-scene-plan";

type Authoring = Pick<typeof import("@pi-desktop/courseware-runtime/authoring"), "editablePptxSceneSchema" | "compileScenesToPptx">;
type Visuals = { pageId: string; visualMasterAssetId: string; cleanPlateAssetId: string; images: CoursewareSceneImage[] };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Resolve every planned page to native editable objects before handing the deck to Host. */
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
    const result = await generate({ pageId: page.pageId, sourceHash: page.sourceHash,
      pageText: [page.title, ...page.visibleText].join("\n"),
      instruction: `Build this page as independently editable layers. Visual intent: ${page.visualIntent}. Use only the supplied child-facing text; teacher narration is separate and must not appear on the slide.`,
      canvas: input.canvas, schema: authoring.editablePptxSceneSchema }, signal);
    const scene = authoring.editablePptxSceneSchema.parse(result.scene);
    if (!scene.elements.some(element => element.type !== "image_layer"))
      throw new Error(`Scene page needs independently editable native objects: ${page.pageId}`);
    const layers = visual.images.filter(image => !image.assetIds.includes(visual.visualMasterAssetId) &&
      !image.assetIds.includes(visual.cleanPlateAssetId));
    const placed = scene.elements.filter(element => element.type === "image_layer");
    if (layers.some(image => !placed.some(element => image.assetIds.includes(element.assetId))) ||
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
  return { ...compiled, teaching: pages.map(({ pageId, narration }) => ({ pageId, narration })) };
}
