import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { adaptCanonicalSnapshot } from '../../lib/courseware/adapt-canonical-snapshot';
import { isCoursewareProject } from '../../lib/courseware/canonical/courseware-contract';

const directory = path.resolve('tests/fixtures/a8-narration');
const read = (file: string) => JSON.parse(readFileSync(path.join(directory, file), 'utf8'));

it('pins actual A8 Host output and keeps both speech actions after native save/reassociation', () => {
  const source = read('SOURCE.json');
  for (const [file, record] of Object.entries<{ sha256: string }>(source.files))
    expect(createHash('sha256').update(readFileSync(path.join(directory, file))).digest('hex'))
      .toBe(record.sha256);
  const project = read('source-pause-project.json');
  const review = read('chat-generated-review.json');
  expect(isCoursewareProject(project)).toBe(true);
  expect(project.pages[0].actions).toEqual(review.actions);
  expect(project.pages[0].actions[0].pauseAfterMs).toBe(4000);
  expect(review.audioReady).toBe(false);
  expect(project.pages.every((page: { reviewState: string }) => page.reviewState === 'review'))
    .toBe(true);
});

it('rejects actual unreviewed A8 teaching and missing audio even after explicit review', () => {
  const project = read('source-pause-project.json');
  const before = JSON.stringify(project);
  const { snapshot, files } = read('canonical-fixed-audio.json');
  // Only align an adapter test envelope; A8 has not exported immutable source bytes.
  Object.assign(snapshot, { projectId: project.projectId, source: project.source,
    teachingRevision: project.teachingRevision });
  files.mapping.sourceSha256 = project.source.sha256;
  expect(() => adaptCanonicalSnapshot(project, snapshot, files)).toThrow('TEACHING_REVIEW_REQUIRED');
  const reviewed = structuredClone(project);
  reviewed.pages.forEach((page: { reviewState: string }) => { page.reviewState = 'ready'; });
  expect(() => adaptCanonicalSnapshot(reviewed, snapshot, files)).toThrow('SNAPSHOT_SCHEMA_INVALID');
  expect(JSON.stringify(project)).toBe(before);
});

it('preserves actual A8 speech fields in the explicitly authored fixed-audio composition', () => {
  const bundle = read('canonical-fixed-audio.json');
  const before = JSON.stringify(bundle);
  const input = adaptCanonicalSnapshot(bundle.project, bundle.snapshot, bundle.files);
  const original = read('source-pause-project.json');
  expect(input.teaching.pages.map(page => page.pageId)).toEqual(
    original.pages.map((page: { pageId: string }) => page.pageId),
  );
  const speeches = input.teaching.pages[0].actions.filter(action => action.type === 'speech');
  expect(speeches.map(({ audioAssetId, ...speech }) => speech))
    .toEqual(original.pages[0].actions);
  expect(speeches.map(action => action.audioAssetId))
    .toEqual(['voice-1', 'voice-2']);
  expect(JSON.stringify(bundle)).toBe(before);
});
