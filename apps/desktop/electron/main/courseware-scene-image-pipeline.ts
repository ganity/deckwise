import { coursewareMediaRecovery, sceneAssetBlockers, type CoursewareSceneImageView, type CoursewareScenePlanSnapshot,
  type CoursewareUpstreamResponse } from "@pi-desktop/shared";
import { COURSEWARE_GENERATION_LIMITS } from "./courseware-generation-queue";

type ImageResult = { image: CoursewareSceneImageView; requiresHumanSelection?: boolean };

/** Coordinate page dependencies; paid requests still use the existing per-kind queues. */
export async function runSceneImagePipeline(plan: CoursewareScenePlanSnapshot, services: {
  images(): Promise<CoursewareSceneImageView[]>;
  execute(name: string, args: Record<string, unknown>): Promise<ImageResult>;
  check(): void;
}) {
  const deadline = Date.now() + 15 * 60_000;
  const pages = plan.pages.filter(page => !page.quiz && !page.teaching?.question);
  const failures: { pageId: string; kind: string; intentId?: string; error: string; upstreamResponse?: CoursewareUpstreamResponse }[] = [];
  const splits: Promise<PromiseSettledResult<unknown>>[] = [];
  const check = () => {
    services.check();
    if (Date.now() >= deadline) throw new Error("Scene image pipeline timed out; resume the original saved jobs");
  };
  const resolve = async (pageId: string, kind: "visualMaster" | "cleanPlate", master?: CoursewareSceneImageView) => {
    check();
    const rows = (await services.images()).filter(row => row.current && row.planSha256 === plan.sha256 && row.pageId === pageId);
    check();
    if (master && !rows.some(row => row.intentId === master.intentId && row.selected && row.asset?.sha256 === master.asset?.sha256))
      throw new Error("Page master selection changed; read the saved workflow");
    const candidates = rows.filter(row => row.target.kind === kind);
    if (master && candidates.some(row => row.selected && (row.referenceImage?.intentId !== master.intentId || row.referenceImage?.sha256 !== master.asset?.sha256)))
      throw new Error("Selected decomposition belongs to another master; review this page before replacing it");
    const matching = candidates.filter(row => !master || row.referenceImage?.intentId === master.intentId && row.referenceImage?.sha256 === master.asset?.sha256);
    let image = kind === "visualMaster" && pageId === pages[0]?.pageId
      ? matching.find(row => row.selected && row.asset) : matching.at(-1);
    if (kind === "visualMaster" && image?.selected && image.asset) return image;
    let result: ImageResult;
    if (image) result = await services.execute("courseware_scene_image_refresh", { intentId: image.intentId, generatePrepared: true });
    else result = await services.execute("courseware_scene_image_prepare", {
      planSha256: plan.sha256, pageId, target: { kind }, ...(master ? { referenceIntentId: master.intentId } : {}),
    });
    for (;;) {
      check();
      image = result.image;
      if (!image.current || image.planSha256 !== plan.sha256 || image.pageId !== pageId || image.target.kind !== kind ||
          master && (image.referenceImage?.intentId !== master.intentId || image.referenceImage?.sha256 !== master.asset?.sha256))
        throw new Error("Scene image source changed; read the saved workflow");
      const recovery = coursewareMediaRecovery(result);
      if (image.selected && image.asset && !result.requiresHumanSelection) return image;
      if (recovery !== "pending") {
        failures.push({ pageId, kind, intentId: image.intentId, error: image.task?.errorCode ?? `Scene image ${recovery}`,
          ...(image.task?.upstreamResponse ? { upstreamResponse: image.task.upstreamResponse } : {}) });
        return undefined;
      }
      result = await services.execute("courseware_scene_image_refresh", { intentId: image.intentId, waitForUpdate: true });
    }
  };
  const attempt = async (pageId: string, kind: "visualMaster" | "cleanPlate", master?: CoursewareSceneImageView) => {
    try { return await resolve(pageId, kind, master); }
    catch (error) {
      check();
      failures.push({ pageId, kind, error: String(error) });
      return undefined;
    }
  };
  let next = 0;
  const workers = Array.from({ length: Math.min(COURSEWARE_GENERATION_LIMITS.image, pages.length) }, async () => {
    while (next < pages.length) {
      check();
      const { pageId } = pages[next++];
      const master = await attempt(pageId, "visualMaster");
      check();
      // Do not hold a master worker while the independent decomposition queue runs.
      if (master) splits.push(attempt(pageId, "cleanPlate", master).then(
        value => ({ status: "fulfilled", value }), reason => ({ status: "rejected", reason })));
    }
  });
  // Join every started operation on stop/error; nothing continues in a detached turn.
  const masters = await Promise.allSettled(workers);
  const layers = await Promise.all(splits);
  check();
  const rejected = [...masters, ...layers].find(result => result.status === "rejected");
  if (rejected?.status === "rejected") throw rejected.reason;
  const rows = await services.images();
  check();
  const blockers = sceneAssetBlockers(plan, rows);
  return { ready: blockers.length === 0, failures, blockers };
}
