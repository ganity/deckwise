import { isCoursewareProject, type CoursewareProject, type CoursewareTeachingView } from "@pi-desktop/shared";
import type { SavedCourseware } from "./courseware-saved-narration";

/** Reuse media adoption with a saved logical page instead of a visible Office selection. */
export function savedMediaPage(saved: SavedCourseware, sessionId: string, pageNumber: number) {
  let project = saved.project;
  const pageId = project.pages[pageNumber - 1]?.pageId;
  if (!pageId) throw new Error("Invalid saved media page number");
  const viewId = `saved-${pageId}`;
  const check = async () => {
    await saved.check();
    const current = await saved.host.call<{ project: unknown }>("courseware.project.get", { sessionId, projectId: project.projectId });
    if (JSON.stringify(current.project) !== JSON.stringify(project)) throw new Error("Saved teaching changed during media operation");
    await saved.check();
  };
  const accept = async (next: unknown): Promise<CoursewareTeachingView> => {
    if (!isCoursewareProject(next) || next.projectId !== project.projectId ||
        next.source.sha256 !== project.source.sha256 || next.source.revision !== project.source.revision)
      throw new Error("Invalid saved media adoption");
    project = next;
    await check();
    return { viewId, project, pageId, pageNumber };
  };
  const context = async (input: { viewId: unknown; expectedTeachingRevision: unknown }) => {
    if (input.viewId !== viewId || input.expectedTeachingRevision !== project.teachingRevision)
      throw new Error("Saved media page revision changed");
    await check();
    return { host: saved.host, sessionId, projectId: project.projectId, pageId,
      expectedSourceRevision: project.source.revision, expectedTeachingRevision: project.teachingRevision,
      project, assertCurrent: check,
      adoptAudio: async (input: { principalKey: string; intentId: string; actionId: string; assetId: string }) => {
        await check();
        const page = project.pages.find(p => p.pageId === pageId);
        const action = page?.actions.find(a => a.id === input.actionId && a.type === "speech");
        if (!page || page.locked || !action) throw new Error("Saved speech changed or page locked");
        const result = await saved.host.call<{ project: CoursewareProject }>("courseware.tts.audio.adopt", {
          sessionId, projectId: project.projectId, principalKey: input.principalKey, intentId: input.intentId,
          expectedTeachingRevision: project.teachingRevision, expectedAudioAssetId: action.audioAssetId ?? null,
        });
        if (!isCoursewareProject(result.project) || !result.project.pages.find(p => p.pageId === pageId)?.actions.some(a => a.id === input.actionId && a.audioAssetId === input.assetId))
          throw new Error("Saved speech audio was not adopted");
        return accept(result.project);
      },
      adoptMusic: async (input: { principalKey: string; intentId: string; assetId: string; durationMs: number }) => {
        await check();
        if (project.pages.find(p => p.pageId === pageId)?.locked) throw new Error("Saved music page is locked");
        const result = await saved.host.call<{ project: CoursewareProject; adoption: { pageId: string; actionId: string; assetId: string } }>("courseware.mediaCanvas.music.adopt", {
          sessionId, projectId: project.projectId, pageId, principalKey: input.principalKey, intentId: input.intentId,
          durationMs: input.durationMs, expectedSourceRevision: project.source.revision, expectedTeachingRevision: project.teachingRevision,
        });
        if (!isCoursewareProject(result.project) || result.adoption?.pageId !== pageId || result.adoption.assetId !== input.assetId ||
            !result.project.pages.find(p => p.pageId === pageId)?.actions.some(a => a.type === "audio_clip" && a.id === result.adoption.actionId && a.audioAssetId === input.assetId))
          throw new Error("Saved music was not adopted");
        return accept(result.project);
      },
    };
  };
  return { ttsContext: context, musicAdoptionContext: context,
    input: () => ({ viewId, expectedTeachingRevision: project.teachingRevision }), check };
}
