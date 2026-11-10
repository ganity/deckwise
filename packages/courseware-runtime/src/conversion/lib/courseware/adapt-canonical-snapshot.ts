import { isCoursewareProject, isCoursewareSnapshot } from './canonical/courseware-contract';
import { fixedBuildInputSchema, type FixedBuildInput } from './fixed-build-input';
import { z } from 'zod';
import { FixedBuildError } from './fixed-build';
import { createHash } from 'node:crypto';

const filesSchema = fixedBuildInputSchema
  .pick({ mapping: true, assets: true, converter: true, reviewedWarningCodes: true })
  .extend({ sourcePath: z.string().min(1) })
  .strict();

/** A supplies the immutable project export and resolved files; this adapter never reads live editor state. */
export function adaptCanonicalSnapshot(
  project: unknown,
  snapshot: unknown,
  rawFiles: unknown,
  options: { nativeTeaching?: boolean } = {},
): FixedBuildInput {
  if (!isCoursewareProject(project) || !isCoursewareSnapshot(snapshot))
    throw new FixedBuildError('CANONICAL_SNAPSHOT_INVALID');
  const parsedFiles = filesSchema.safeParse(rawFiles);
  if (!parsedFiles.success) throw new FixedBuildError('SNAPSHOT_FILES_INVALID');
  const files = parsedFiles.data;
  if (
    project.projectId !== snapshot.projectId ||
    project.source.revision !== snapshot.source.revision ||
    project.source.sha256.toLowerCase() !== snapshot.source.sha256.toLowerCase() ||
    project.teachingRevision !== snapshot.teachingRevision ||
    files.mapping.revision !== snapshot.mappingRevision ||
    files.mapping.sourceSha256 !== snapshot.source.sha256.toLowerCase()
  )
    throw new FixedBuildError('SNAPSHOT_REVISION_MISMATCH');
  // Native capture explicitly exports the saved file; legacy review metadata
  // does not gate this authority. All content and asset validation still runs.
  if (!options.nativeTeaching && project.pages.some((page) => page.reviewState !== 'ready'))
    throw new FixedBuildError('TEACHING_REVIEW_REQUIRED');
  const assets = new Set(files.assets.map((asset) => asset.id));
  if (
    assets.size !== files.assets.length ||
    assets.size !== snapshot.assetIds.length ||
    snapshot.assetIds.some((id) => !assets.has(id))
  )
    throw new FixedBuildError('SNAPSHOT_ASSET_MISMATCH');
  const pages = new Set(project.pages.map((page) => page.pageId));
  if (
    files.mapping.pages.length !== pages.size ||
    new Set(files.mapping.pages.map((page) => page.pageId)).size !== pages.size ||
    files.mapping.pages.some((page) => !pages.has(page.pageId))
  )
    throw new FixedBuildError('PAGE_MAPPING_MISMATCH');
  const result = fixedBuildInputSchema.safeParse({
    schemaVersion: 'deckwise-fixed-build/1',
    source: {
      path: files.sourcePath,
      revision: snapshot.source.revision,
      sha256: snapshot.source.sha256.toLowerCase(),
    },
    teaching: {
      revision: snapshot.teachingRevision,
      sourceSha256: snapshot.source.sha256.toLowerCase(),
      pages: project.pages.map(({ pageId, actions }) => ({ pageId, actions: actions.map(action => {
        // Derived authoring duration and provenance do not belong to playback actions.
        if (['speech', 'audio_clip', 'video_clip'].includes(String(action.type))) {
          const { durationMs: _duration, ...playback } = action;
          if (action.type === 'speech' && ['notes', 'external', 'original', 'light_rewrite', 'generated'].includes(String(action.source))) {
            const { source: _source, ...speech } = playback;
            return speech;
          }
          return playback;
        }
        return action;
      }) })),
    },
    mapping: files.mapping,
    assets: files.assets,
    converter: files.converter,
    reviewedWarningCodes: files.reviewedWarningCodes,
  });
  if (!result.success) throw new FixedBuildError('SNAPSHOT_SCHEMA_INVALID');
  const ids = result.data.teaching.pages.flatMap((page) => page.actions.map((action) => action.id));
  if (new Set(ids).size !== ids.length) {
    // Host action IDs are page-local; playback cue lookup requires global IDs.
    for (const page of result.data.teaching.pages)
      for (const action of page.actions)
        action.id = `fixed-${createHash('sha256')
          .update(JSON.stringify([page.pageId, action.id]))
          .digest('hex')}`;
  }
  return result.data;
}
