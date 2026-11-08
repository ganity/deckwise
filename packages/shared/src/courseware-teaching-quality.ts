import type { CoursewareProject } from "./courseware-contract.js";
import type { CoursewareSceneTeaching } from "./courseware-scene-teaching.js";
import { coursewareQuestionMatches } from "./courseware-scene-teaching.js";

/** A verified native save makes its saved text authoritative, including legacy speech IDs. */
export function hasDetailedCoursewareNarration(page: CoursewareProject["pages"][number], nativeSaved = false): boolean {
  const speeches = page.actions.filter(action => action.type === "speech");
  return speeches.length > 0 && speeches.every(action => typeof action.text === "string" && !!action.text.trim() &&
    (nativeSaved || action.source === "generated" || typeof action.id === "string" && !/^narration-\d+$/u.test(action.id)));
}

export type CoursewareTeachingIssue = {
  pageNumber: number; pageId: string; actionId?: string;
  code: "NARRATION_MISSING" | "AUDIO_MISSING" | "FOCUS_MISSING" | "QUESTION_MISSING" | "QUESTION_TYPE_MISMATCH" | "MUSIC_MISSING" | "MUSIC_PENDING" | "VIDEO_MISSING" | "VIDEO_PENDING";
  repair: "narration" | "tts" | "music" | "video";
  repairable: boolean;
};
/** Advisory only: never rewrites a lesson, blocks a saved artifact, or certifies pedagogical quality. */
export function inspectCoursewareTeaching(project: CoursewareProject, teachingByPage?: ReadonlyMap<string, CoursewareSceneTeaching>, assessmentPageIds: ReadonlySet<string> = new Set(), nativeSaved = false) {
  const issues: CoursewareTeachingIssue[] = [];
  for (const [index, page] of project.pages.entries()) {
    if (assessmentPageIds.has(page.pageId)) continue;
    const add = (code: CoursewareTeachingIssue["code"], repair: CoursewareTeachingIssue["repair"], actionId?: string) =>
      issues.push({ pageNumber: index + 1, pageId: page.pageId, ...(actionId ? { actionId } : {}), code, repair, repairable: !page.locked });
    const speeches = page.actions.filter(a => a.type === "speech" && typeof a.text === "string" && a.text.trim());
    const teaching = teachingByPage?.get(page.pageId);
    if (project.taskType === "scene" ? !hasDetailedCoursewareNarration(page, nativeSaved) : !speeches.length) add("NARRATION_MISSING", "narration");
    for (const speech of speeches) {
      if (!speech.audioAssetId) add("AUDIO_MISSING", "tts", String(speech.id));
      if (speech.attention === undefined && (!Array.isArray(speech.visualCues) || !speech.visualCues.some(c => c && typeof c === "object" && !Array.isArray(c) && ["highlight", "spotlight"].includes(String(Reflect.get(Reflect.get(c, "effect") ?? {}, "type"))))) && teaching?.requiredObjects.some(name => name.length >= 2 && String(speech.text).includes(name)))
        add("FOCUS_MISSING", "narration", String(speech.id));
    }
    const questions = page.actions.filter(a => a.type === "interaction_checkpoint" && a.checkpointKind === "chapter_summary");
    if (teaching?.question && !questions.length) add("QUESTION_MISSING", "narration");
    else if (teaching?.question && !questions.some(a => coursewareQuestionMatches(a, teaching.question))) add("QUESTION_TYPE_MISMATCH", "narration");
    const slots = page.actions.filter(a => a.type === "music_slot");
    if (teaching?.music && !slots.length && !page.actions.some(a => a.type === "audio_clip")) add("MUSIC_MISSING", "narration");
    for (const slot of slots) add("MUSIC_PENDING", "music", String(slot.id));
    const videos = page.actions.filter(a => a.type === "video_slot");
    if (teaching?.video && !videos.length && !page.actions.some(a => a.type === "video_clip")) add("VIDEO_MISSING", "narration");
    for (const slot of videos) add("VIDEO_PENDING", "video", String(slot.id));
  }
  const counts: Partial<Record<CoursewareTeachingIssue["code"], number>> = {};
  for (const issue of issues) counts[issue.code] = (counts[issue.code] ?? 0) + 1;
  return { counts, status: issues.length ? "needs-review" as const : "checked" as const, blocking: false as const, issues,
    sourceSha256: project.source.sha256, teachingRevision: project.teachingRevision };
}
