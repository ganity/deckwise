import type { CoursewareEducationContext, CoursewareTaskType, CoursewareProject } from "./courseware-contract.js";
import type { CoursewareSceneImageView, CoursewareScenePlanSnapshot } from "./courseware-scene-plan.js";

export const COURSEWARE_WORKFLOW_TOOLS = [
  "courseware_story_begin", "courseware_story_save", "courseware_workflow_get", "courseware_scene_plan_submit", "courseware_requirements_update", "courseware_scene_image_prepare",
  "courseware_scene_image_refresh", "courseware_scene_compile",
  "courseware_narration_context", "courseware_narration_plan", "courseware_narration_import", "courseware_activity_insert", "courseware_narration_propose",
  "courseware_media_context", "courseware_media_prepare", "courseware_media_refresh",
  "courseware_media_assessments",
  "courseware_presentation_prepare", "courseware_presentation_adopt",
] as const;

export type CoursewareWorkflowView = {
  story?: import("./courseware-story.js").CoursewareStoryState | null;
  task: { taskType: CoursewareTaskType; storyFirst?: boolean; educationContext?: CoursewareEducationContext;
    imported: boolean; generated: boolean; sourcePath?: string; canonicalProjectId?: string } | null;
  plan: CoursewareScenePlanSnapshot | null;
  compilation?: { planSha256: string; state: "running" | "failed" | "stopped"; message?: string };
};

export type CoursewareSceneAssetBlocker = {
  pageId: string;
  kind: "visualMaster" | "cleanPlate" | "layer" | "duplicate" | "distinctBackground" | "incomplete";
};

/** Presentation readiness only; compilation still revalidates the actual private bytes. */
export function sceneAssetBlockers(plan: CoursewareScenePlanSnapshot, images: readonly CoursewareSceneImageView[]): CoursewareSceneAssetBlocker[] {
  const selected = images.filter(row => row.current && row.selected && row.planSha256 === plan.sha256);
  const blockers: CoursewareSceneAssetBlocker[] = [];
  for (const page of plan.pages.filter(page => !page.quiz && !page.teaching?.question)) {
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
  if (selected.some(row => !row.asset || !plan.pages.some(page => page.pageId === row.pageId && !page.quiz && !page.teaching?.question)))
    blockers.push({ pageId: "", kind: "incomplete" });
  return blockers;
}

/** Rendering only: never infer a compiler job from Chat activity or submit media here. */
export function sceneWorkspaceProgress(plan: CoursewareScenePlanSnapshot, images: readonly CoursewareSceneImageView[],
  running: boolean, compilation?: CoursewareWorkflowView["compilation"]) {
  const rows = images.filter(row => row.current && row.planSha256 === plan.sha256);
  const slidePages = plan.pages.filter(page => !page.quiz && !page.teaching?.question);
  const masters = rows.filter(row => row.target.kind === "visualMaster" && row.asset);
  const imageCount = new Set(masters.map(row => row.pageId).filter(id => slidePages.some(page => page.pageId === id))).size;
  const blockers = sceneAssetBlockers(plan, rows);
  const assetPages = slidePages.filter(page => !blockers.some(blocker => !blocker.pageId || blocker.pageId === page.pageId)).length;
  const firstSlide = slidePages[0];
  const cover = masters.find(row => row.pageId === firstSlide?.pageId && row.selected);
  const compiling = compilation?.planSha256 === plan.sha256 ? compilation : undefined;
  const phase = !slidePages.length ? compiling?.state === "running" ? "converting" : "queued" : !cover ? masters.some(row => row.pageId === firstSlide.pageId) ? "style" : "cover" :
    compiling?.state === "running" ? "converting" : imageCount < slidePages.length ? "images" : blockers.length ? "layers" : "queued";
  const unresolved = rows.filter(row => !row.asset && !rows.some(peer => peer.selected && peer.asset && peer.pageId === row.pageId &&
    peer.target.kind === row.target.kind && (row.target.kind !== "layer" || peer.target.kind === "layer" && peer.target.name === row.target.name)));
  const unknown = unresolved.some(row => row.phase === "submission-unknown" || row.task?.state === "submission_unknown");
  const failed = unresolved.some(row => row.phase === "rejected" || ["failed", "cancelled", "archive_failed"].includes(row.task?.state ?? ""));
  const waiting = unresolved.some(row => row.phase === "submitted" && !["failed", "cancelled", "archive_failed", "ready"].includes(row.task?.state ?? ""));
  const activity = compiling?.state === "failed" ? "failed" : compiling?.state === "stopped" ? "paused" : unknown ? "unknown" :
    failed ? "failed" : phase === "style" ? "review" : waiting ? "waiting" : running || compiling?.state === "running" ? "running" : "paused";
  return { phase, activity, imageCount, assetPages, total: slidePages.length };
}

export type CoursewareTeachingProgress = { total: number; audio: number; ready: number };

/** Summarize an already validated saved project without opening another teaching view. */
export function coursewareTeachingProgress(project: CoursewareProject): CoursewareTeachingProgress {
  return { total: project.pages.length,
    audio: project.pages.filter(page => page.actions.some(action => action.type === "speech") &&
      page.actions.filter(action => action.type === "speech").every(action => typeof action.audioAssetId === "string")).length,
    ready: project.pages.filter(page => page.actions.length > 0 && !page.actions.some(action =>
      action.attention !== undefined || ["video_slot", "music_slot"].includes(String(action.type)) ||
      action.type === "speech" && (typeof action.text !== "string" || !action.text.trim() || !action.audioAssetId) ||
      action.type === "audio_clip" && !action.audioAssetId || action.type === "video_clip" && !action.videoAssetId)).length };
}

/** Host-owned recovery progress; resuming execution still requires a current authorized turn. */
export type CoursewareWorkflowCheckpoint = {
  revision: number; projectId: string; sourceSha256: string;
  status: "running" | "blocked" | "completed";
  repairAttempts: Record<string, number>; lastResume: string | null;
};

export type CoursewareMediaRecovery = "prepared" | "pending" | "unknown" | "failed" | "archived" | "adopted" | "needs-human";

/** Normalize actual tool envelopes; provider readiness does not imply saved adoption. */
export function coursewareMediaRecovery(value: unknown): CoursewareMediaRecovery {
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (!record(value)) return "failed";
  const media = record(value.image) ? value.image : record(value.media) ? value.media : value;
  const task = record(media.task) ? media.task : undefined;
  if (value.requiresHumanSelection === true) return "needs-human";
  if (value.saved === true || media.selected === true || media.phase === "adopted") return "adopted";
  if (media.asset) return "archived";
  if (media.phase === "rejected" || ["failed", "cancelled", "archive_failed"].includes(String(task?.state ?? value.state))) return "failed";
  if ((!task && media.phase === "submission-unknown") || (task?.state ?? value.state) === "submission_unknown") return "unknown";
  if (task?.errorCode || media.errorCode) return "failed";
  if (media.phase === "prepared") return "prepared";
  return value.waitingFor === "service" || media.phase === "submitted" || task ? "pending" : "failed";
}
