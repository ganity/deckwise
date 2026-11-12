import { dirname } from 'node:path';
import { coursewareRuntimeEnvironment } from './courseware-runtime';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { preflightNativePlayback } from '@pi-desktop/courseware-runtime/node';
import type { CoursewareTeachingView } from '@pi-desktop/shared';
import { readNativeTeachingPackage } from './courseware-native-package';
import type { PptEditorController } from './ppt-editor';

/** Cache only verified saved bytes; never reuse acceptance across a source or teaching change. */
export class NativePlaybackPreflight {
  private cached?: Awaited<ReturnType<typeof preflightNativePlayback>>;
  async inspect(editor: PptEditorController, workspace: string, view: CoursewareTeachingView, check: () => void) {
    check(); await editor.ensureSaved(workspace); check();
    const source = editor.teachingSnapshot(workspace), bytes = await readFile(source.path);
    check();
    if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) throw new Error('Native preflight source changed');
    const carrier = await readNativeTeachingPackage(bytes);
    if (!carrier || carrier.documentId !== view.project.projectId || carrier.revision !== view.project.teachingRevision)
      throw new Error('Native preflight teaching changed; read current context');
    const worker = coursewareRuntimeEnvironment().DECKWISE_PPTX_WORKER;
    if (!worker) throw new Error('Native playback parser unavailable');
    const result = this.cached?.sourceSha256 === source.sha256 ? this.cached : await preflightNativePlayback(bytes, carrier.pages, carrier.identity, { workerDirectory: dirname(worker) });
    check(); await editor.verifyTeachingSource(workspace); check();
    const current = editor.teachingSnapshot(workspace);
    if (current.sha256 !== source.sha256 || current.sourcePath !== source.sourcePath) throw new Error('Native preflight source changed');
    this.cached = result;
    return result;
  }
}
