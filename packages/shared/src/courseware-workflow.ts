import type { CoursewareEducationContext, CoursewareTaskType, CoursewareProject } from "./courseware-contract.js";
import type { CoursewareSceneImageView, CoursewareScenePlanSnapshot } from "./courseware-scene-plan.js";

export const COURSEWARE_WORKFLOW_TOOLS = [
  "courseware_workflow_get", "courseware_requirements_update", "courseware_scene_image_prepare",
  "courseware_scene_image_refresh", "courseware_scene_compile",
  "courseware_narration_context", "courseware_narration_propose",
  "courseware_media_context", "courseware_media_prepare", "courseware_media_refresh",
] as const;

export type CoursewareWorkflowView = {
  task: { taskType: CoursewareTaskType; educationContext?: CoursewareEducationContext;
    imported: boolean; generated: boolean } | null;
  plan: CoursewareScenePlanSnapshot | null;
};

export type CoursewareSceneAssetBlocker = {
  pageId: string;
  kind: "visualMaster" | "cleanPlate" | "layer" | "duplicate" | "distinctBackground" | "budget";
};

/** Presentation readiness only; compilation still revalidates the actual private bytes. */
export function sceneAssetBlockers(plan: CoursewareScenePlanSnapshot, images: readonly CoursewareSceneImageView[]): CoursewareSceneAssetBlocker[] {
  const selected = images.filter(row => row.current && row.selected && row.planSha256 === plan.sha256);
  const blockers: CoursewareSceneAssetBlocker[] = [];
  for (const page of plan.pages) {
    const rows = selected.filter(row => row.pageId === page.pageId && row.asset);
    const masters = rows.filter(row => row.target.kind === "visualMaster");
    const backgrounds = rows.filter(row => row.target.kind === "cleanPlate");
    const layers = rows.filter(row => row.target.kind === "layer");
    if (!masters.length) blockers.push({ pageId: page.pageId, kind: "visualMaster" });
    if (!backgrounds.length) blockers.push({ pageId: page.pageId, kind: "cleanPlate" });
    if (!layers.length) blockers.push({ pageId: page.pageId, kind: "layer" });
    const base = backgrounds[0];
    if (base?.decomposition) {
      const group = images.filter(row => row.intentId.startsWith(`${base.intentId}-layer-`));
      if (group.some(row => !row.selected) || layers.some(row => !row.intentId.startsWith(`${base.intentId}-layer-`)))
        blockers.push({ pageId: page.pageId, kind: "layer" });
      if (!masters.some(row => row.intentId === base.referenceImage?.intentId && row.asset?.sha256 === base.referenceImage?.sha256))
        blockers.push({ pageId: page.pageId, kind: "cleanPlate" });
    } else if (layers.some(row => row.decomposition)) blockers.push({ pageId: page.pageId, kind: "cleanPlate" });
    if (masters.length > 1 || backgrounds.length > 1 || new Set(layers.map(row => row.target.kind === "layer" && row.target.name)).size !== layers.length)
      blockers.push({ pageId: page.pageId, kind: "duplicate" });
    if (masters.length === 1 && backgrounds.length === 1 && masters[0].asset!.sha256 === backgrounds[0].asset!.sha256)
      blockers.push({ pageId: page.pageId, kind: "distinctBackground" });
  }
  if (selected.some(row => !row.asset || !plan.pages.some(page => page.pageId === row.pageId)) ||
      selected.reduce((sum, row) => sum + (row.asset?.byteLength ?? 0), 0) > 256 * 1024 * 1024)
    blockers.push({ pageId: "", kind: "budget" });
  return blockers;
}

export type CoursewareTeachingProgress = { total: number; audio: number; ready: number };

/** Summarize an already validated saved project without opening another teaching view. */
export function coursewareTeachingProgress(project: CoursewareProject): CoursewareTeachingProgress {
  return { total: project.pages.length,
    audio: project.pages.filter(page => page.actions.some(action => action.type === "speech") &&
      page.actions.filter(action => action.type === "speech").every(action => typeof action.audioAssetId === "string")).length,
    ready: project.pages.filter(page => page.reviewState === "ready" &&
      !page.actions.some(action => action.attention !== undefined || action.type === "video_slot")).length };
}
