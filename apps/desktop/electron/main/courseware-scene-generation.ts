import type { buildSceneCourseDeck } from "./courseware-scene-deck";
import type { stageGeneratedSceneCourse } from "./courseware-scene-staging";
import type { CoursewareSceneImages } from "./courseware-scene-images";
import { sceneImageForCompiler } from "./courseware-scene-image-assets";

export type SceneCourseGenerationServices = {
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
      const visuals = selected.plan.pages.map(page => {
        const rows = selected.images.filter(image => image.pageId === page.pageId);
        const images = rows.map(image => sceneImageForCompiler(image, canvas));
        const assetId = (kind: "visualMaster" | "cleanPlate") => images[rows.findIndex(row => row.target.kind === kind)].assetIds[0];
        return { pageId: page.pageId, visualMasterAssetId: assetId("visualMaster"), cleanPlateAssetId: assetId("cleanPlate"), images };
      });
      if (visuals.flatMap(visual => visual.images).reduce((sum, image) => sum + image.bytes.length, 0) > 32 * 1024 * 1024)
        throw new Error("COURSEWARE_SCENE_GENERATION_ASSET_BUDGET");
      await assertCurrent();
      const deck = await this.services.build({ sessionId, modelKey: selected.modelKey,
        thinkingLevel: selected.thinkingLevel, pages: selected.plan.pages, visuals, canvas, signal });
      await assertCurrent();
      const result = await this.services.stage({ workspace: selected.workspace, sessionId,
        title: selected.plan.title, pptx: deck.pptx, teaching: deck.teaching, sceneMapping: deck.mapping, signal,
        sceneProof: selected.proof, assertCurrent });
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
