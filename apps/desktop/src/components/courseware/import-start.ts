import type { CoursewareTeachingView } from "@pi-desktop/shared";

export function isImportedEditorPath(source: string, editor: string | undefined, workspace: string | undefined) {
  const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/$/u, "");
  if (!editor) return false;
  if (normalize(source) === normalize(editor)) return true;
  if (!workspace || /^(?:[/\\]|[a-z]:)/iu.test(editor) || editor.split(/[/\\]/u).includes("..")) return false;
  return normalize(source) === `${normalize(workspace)}/${normalize(editor).replace(/^\.\//u, "")}`;
}

/** Counts describe saved data, not playback or content-quality acceptance. */
export function importTeachingSummary(view: CoursewareTeachingView) {
  const pages = view.project.pages;
  return {
    total: pages.length,
    narration: pages.filter(p => p.actions.some(a => a.type === "speech" && typeof a.text === "string" && a.text.trim())).length,
    audio: pages.filter(p => p.actions.some(a => a.type === "speech") && p.actions.filter(a => a.type === "speech").every(a =>
      typeof a.text === "string" && a.text.trim() && typeof a.audioAssetId === "string" && a.audioAssetId)).length,
    activities: pages.filter(p => p.actions.some(a => a.type === "interaction_checkpoint" && a.checkpointKind === "chapter_summary")).length,
  };
}
