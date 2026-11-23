import type { buildSceneCourseDeck } from "./courseware-scene-deck";
import type { stageGeneratedSceneCourse } from "./courseware-scene-staging";
import type { CoursewareSceneImages } from "./courseware-scene-images";
import { sceneImageForCompiler } from "./courseware-scene-image-assets";
import type { ReviewedSceneTeachingPage, SceneTeachingCorrection, teachingForReviewedMasters, VisualMasterPlanner } from "./courseware-visual-master";
import type { MagicLayersFallback } from "./courseware-magic-layers";

export type SceneCourseGenerationServices = {
  reviewMaster?: import("./courseware-scene-master-review").SceneMasterReview;
  planVisualMaster?: VisualMasterPlanner;
  reviewedTeaching?: (input: Parameters<typeof teachingForReviewedMasters>[0]) => ReturnType<typeof teachingForReviewedMasters>;
  layerFallback?: MagicLayersFallback;
  resolveModel?: (sessionId: string) => Promise<{ modelKey: string; thinkingLevel?: string }>;
  build: (input: Parameters<typeof buildSceneCourseDeck>[0]) => ReturnType<typeof buildSceneCourseDeck>;
  stage: (input: Omit<Parameters<typeof stageGeneratedSceneCourse>[0], "host">) => ReturnType<typeof stageGeneratedSceneCourse>;
};

/** Explicit user action over reviewed private assets; no media submission or automatic retry. */
export class CoursewareSceneGeneration {
  private active: { sessionId: string; controller: AbortController } | null = null;
  constructor(private images: CoursewareSceneImages, private services: SceneCourseGenerationServices) {}

  async generate(value: unknown): Promise<{ path: string }> {
    if (this.active) throw new Error("COURSEWARE_SCENE_GENERATION_IN_FLIGHT");
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== "planSha256,sessionId" ||
        typeof Reflect.get(value, "sessionId") !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/u.test(Reflect.get(value, "sessionId")) ||
        typeof Reflect.get(value, "planSha256") !== "string" ||
        !/^[a-f0-9]{64}$/u.test(Reflect.get(value, "planSha256")))
      throw new Error("COURSEWARE_SCENE_IMAGE_INVALID_REQUEST");
    const sessionId: string = Reflect.get(value, "sessionId");
    const controller = new AbortController(), signal = controller.signal;
    this.active = { sessionId, controller };
    let timer: ReturnType<typeof setInterval> | undefined;
    const timeout = setTimeout(() => controller.abort(new Error("COURSEWARE_SCENE_GENERATION_TIMEOUT")), 15 * 60_000);
    try {
      const selected = await this.images.captureSelected(value, this.services.resolveModel);
      const assertCurrent = async () => { signal.throwIfAborted(); await selected.assertCurrent(); signal.throwIfAborted(); };
      timer = setInterval(() => { try { selected.assertScope(); } catch (error) { controller.abort(error); } }, 100);
      await assertCurrent();
      const canvas = { width: 1280, height: 800 };
      const visuals = selected.plan.pages.filter(page => !page.quiz && !page.teaching?.question).map(page => {
        const rows = selected.images.filter(image => image.pageId === page.pageId);
        const base = rows.find(row => row.target.kind === "cleanPlate")!.asset;
        const scale = Math.min(canvas.width / base.width, canvas.height / base.height);
        const fitWidth = Math.max(1, Math.round(base.width * scale)), fitHeight = Math.max(1, Math.round(base.height * scale));
        const offsetX = Math.floor((canvas.width - fitWidth) / 2), offsetY = Math.floor((canvas.height - fitHeight) / 2);
        const images = rows.map(image => {
          const box = image.asset.normalizedBoundingBox;
          return sceneImageForCompiler(image, canvas, box ? {
            width: Math.max(1, Math.ceil((box[2] - box[0]) * fitWidth / 1000)),
            height: Math.max(1, Math.ceil((box[3] - box[1]) * fitHeight / 1000)),
          } : undefined);
        });
        const assetId = (kind: "visualMaster" | "cleanPlate") => images[rows.findIndex(row => row.target.kind === kind)].assetIds[0];
        const foregroundPlacements = rows.flatMap((row, index) => {
          const box = row.asset.normalizedBoundingBox;
          if (row.target.kind !== "layer" || !box) return [];
          return [{ assetId: images[index].assetIds[0], zIndex: row.asset.sourceZIndex, semanticRole: row.target.name,
            ...(row.asset.layerMetadata ? { layerMetadata: row.asset.layerMetadata } : {}),
            bboxPx: [offsetX + box[0] * fitWidth / 1000, offsetY + box[1] * fitHeight / 1000,
              (box[2] - box[0]) * fitWidth / 1000, (box[3] - box[1]) * fitHeight / 1000] as [number, number, number, number] }];
        });
        return { pageId: page.pageId, visualMasterAssetId: assetId("visualMaster"), cleanPlateAssetId: assetId("cleanPlate"), images,
          ...(foregroundPlacements.length ? { foregroundPlacements } : {}) };
      });
      await assertCurrent();
      const pages = [...selected.plan.pages];
      const reviewPages: ReviewedSceneTeachingPage[] = pages.flatMap(page => {
        const image = selected.images.find(row => row.pageId === page.pageId && row.target.kind === "visualMaster");
        const teaching = page.teaching;
        if (!teaching?.requiredObjects.length || !image?.instructions) return [];
        return [{ pageId: page.pageId, intentId: image.intentId, assetSha256: image.asset.sha256,
          instructions: image.instructions, teaching }];
      });
      let teachingCorrections: SceneTeachingCorrection[] = [];
      if (reviewPages.length) {
        if (!this.services.reviewedTeaching) throw new Error("Selected image correction requires teaching review");
        teachingCorrections = await this.services.reviewedTeaching({ sessionId, modelKey: selected.modelKey, signal, pages: reviewPages });
        await assertCurrent();
        for (const correction of teachingCorrections) {
          const pageIndex = pages.findIndex(page => page.pageId === correction.pageId);
          if (pageIndex < 0 || !pages[pageIndex].teaching) throw new Error("Selected image correction page changed");
          if (correction.removals.length) {
            const removed = new Set(correction.removals.map(row => row.object));
            pages[pageIndex] = { ...pages[pageIndex], teaching: { ...pages[pageIndex].teaching!,
              requiredObjects: pages[pageIndex].teaching!.requiredObjects.filter(name => !removed.has(name)) } };
          }
        }
      }
      const deck = await this.services.build({ sessionId, modelKey: selected.modelKey,
        thinkingLevel: selected.thinkingLevel, textMode: selected.plan.textMode, pages, visuals, canvas, signal });
      await assertCurrent();
      const result = await this.services.stage({ workspace: selected.workspace, sessionId,
        title: selected.plan.title, pptx: deck.pptx, teaching: deck.teaching, sceneMapping: deck.mapping, canonicalClassroom: deck.canonicalClassroom, signal,
        sceneProof: { ...selected.proof, ...(teachingCorrections.some(row => row.removals.length) ? {
          teachingCorrections: teachingCorrections.filter(row => row.removals.length),
        } : {}) }, assertCurrent });
      return { path: result.path };
    } finally { if (timer) clearInterval(timer); clearTimeout(timeout); this.active = null; }
  }

  cancel(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).join(",") !== "sessionId" ||
        typeof Reflect.get(value, "sessionId") !== "string") throw new Error("COURSEWARE_SCENE_IMAGE_INVALID_REQUEST");
    const cancelled = this.active?.sessionId === Reflect.get(value, "sessionId");
    if (cancelled && this.active) this.active.controller.abort(new Error("COURSEWARE_SCENE_GENERATION_CANCELLED"));
    return { cancelled };
  }
}
