import type { CoursewareProject } from '@pi-desktop/shared';
import type { NativeClassroomSeed } from './courseware-classroom-native';
import type { SavedCourseware } from './courseware-saved-narration';
import { commitSavedPptx } from './courseware-classroom-save';
import { coursewareAuthoringUrl } from './courseware-runtime';

/** Final speech adoption materializes native animations for every generation/import path. */
export async function persistSavedSpeechAnimations(saved: SavedCourseware, sessionId: string, assertCurrent: () => void) {
  const speeches = saved.project.pages.flatMap(page => page.actions.filter(action => action.type === 'speech'));
  if (!speeches.length || speeches.some(action => !action.audioAssetId) || !speeches.some(action =>
    Array.isArray(action.visualCues) && action.visualCues.some(cue => cue.effect.type === 'element_animation'))) return saved.project;
  const { host } = saved;
  await saved.check(); assertCurrent();
  const seed = await host.call<NativeClassroomSeed>('courseware.classroom.source', { sessionId, projectId: saved.project.projectId, jobId: saved.jobId });
  if (seed.project.source?.sha256 !== saved.project.source.sha256 || seed.project.teachingRevision !== saved.project.teachingRevision ||
      seed.ir.pages.length !== saved.project.pages.length || seed.mapping.pages.length !== saved.project.pages.length)
    throw new Error('Speech animation source changed; read the current saved course');
  const authoring = coursewareAuthoringUrl();
  if (!authoring) throw new Error('Installed native animation compiler is unavailable');
  const { syncSpeechAnimations } = await import(/* @vite-ignore */ authoring) as typeof import('@pi-desktop/courseware-runtime/authoring');
  const pages = saved.project.pages.map((page, index) => ({ actions: page.actions, objects: seed.ir.pages[index].elements.map(element => ({
    id: seed.mapping.pages[index].objects?.find(object => object.importElementId === element.id)?.objectId ?? element.id,
    objectName: element.sourceObjectName ?? element.id,
  })) }));
  const result = await syncSpeechAnimations({ source: saved.bytes, pages });
  if (!result.changedPages.some(Boolean)) return saved.project;
  if (saved.project.pages.some((page, index) => page.locked && result.changedPages[index])) throw new Error('Unlock the page before writing its native speech animations');
  const { session } = await host.call<{ session: { projectPath: string } }>('session.get', { id: sessionId, messageLimit: 1 });
  const { task } = await host.call<{ task: { importPath?: string; generatedPath?: string } }>('courseware.task.get', { sessionId });
  const sourcePath = task.importPath ?? task.generatedPath;
  if (!session?.projectPath || !sourcePath) throw new Error('Native speech animation workspace is unavailable');
  await commitSavedPptx({ saved, sessionId, workspace: session.projectPath, sourcePath, bytes: Buffer.from(result.pptx), assertCurrent,
    lineage: { pageTokens: saved.project.pages.map(page => page.pageId), animationUnchanged: result.changedPages.map(changed => !changed),
      objects: pages.map((page, index) => page.objects.map(object => ({ name: object.objectName, sourceName: object.objectName,
        sourcePageToken: saved.project.pages[index].pageId }))) } });
  assertCurrent();
  return (await host.call<{ project: CoursewareProject }>('courseware.project.get', { sessionId, projectId: saved.project.projectId })).project;
}
