import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { expect, it } from 'vitest';
import { adaptCanonicalSnapshot } from '../../lib/courseware/adapt-canonical-snapshot';
import {
  checkTeachingWrite,
  isCoursewareBuildRef,
  isCoursewareCandidate,
  isCoursewareProject,
  isCoursewareSnapshot,
  isCoursewareTaskRef,
  isTeachingWrite,
} from '../../lib/courseware/canonical/courseware-contract';
import type { FixedBuildInput } from '../../lib/courseware/fixed-build-input';
const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
function canonicalFixture(input: FixedBuildInput) {
  return {
    project: {
      schemaVersion: 'deckwise-courseware/1',
      projectId: 'fixture-project',
      taskType: 'import',
      title: 'Fixed lesson',
      source: { revision: input.source.revision, sha256: input.source.sha256 },
      teachingRevision: input.teaching.revision,
      pages: input.teaching.pages.map((p) => ({ ...p, locked: true, reviewState: 'ready' })),
    },
    snapshot: {
      snapshotId: 'fixture-r8',
      projectId: 'fixture-project',
      source: { revision: input.source.revision, sha256: input.source.sha256 },
      teachingRevision: input.teaching.revision,
      mappingRevision: input.mapping.revision,
      assetIds: input.assets.map((a) => a.id),
    },
    files: {
      sourcePath: input.source.path,
      mapping: input.mapping,
      assets: input.assets,
      converter: input.converter,
      reviewedWarningCodes: input.reviewedWarningCodes,
    },
  };
}
const fixture = () =>
  canonicalFixture(read(path.resolve('tests/fixtures/fixed-courseware/snapshot.json')));
it('consumes the unmodified A canonical validators and accepted/stale fixtures', () => {
  const root = path.resolve('src/conversion/lib/courseware/canonical');
  const manifest = read(path.join(root, 'SOURCE.json'));
  for (const [file, sha] of Object.entries(manifest.sourceHashes))
    expect(
      createHash('sha256')
        .update(readFileSync(path.join(root, file)))
        .digest('hex'),
    ).toBe(sha);
  const accepted = read(path.join(root, 'courseware-contract.fixtures/accepted.json'));
  const stale = read(path.join(root, 'courseware-contract.fixtures/stale-write.json'));
  const references = read(path.join(root, 'courseware-contract.fixtures/references.json'));
  expect(isCoursewareProject(accepted.project)).toBe(true);
  expect(isTeachingWrite(accepted.write)).toBe(true);
  expect(isCoursewareProject(stale.project)).toBe(true);
  expect(isTeachingWrite(stale.write)).toBe(true);
  expect(checkTeachingWrite(accepted.project, accepted.write)).toBe('accepted');
  expect(checkTeachingWrite(stale.project, stale.write)).toBe('stale');
  expect(isCoursewareCandidate(references.candidate)).toBe(true);
  expect(isCoursewareSnapshot(references.snapshot)).toBe(true);
  expect(isCoursewareBuildRef(references.build)).toBe(true);
  expect(isCoursewareTaskRef(references.task)).toBe(true);
});
it('preserves opaque teaching revisions and accepts education context without mutating it', () => {
  const f = fixture();
  const revision = '6f7b9cb1-28ef-4dc8-bde2-891b0790ab13';
  f.project.teachingRevision = f.snapshot.teachingRevision = revision;
  const project = {
    ...f.project,
    educationContext: {
      schoolStage: 'kindergarten',
      subject: 'english',
      visualStyle: '2D 卡通',
      fullEnglishTeaching: false,
    },
  };
  const before = JSON.stringify(project);
  expect(adaptCanonicalSnapshot(project, f.snapshot, f.files).teaching.revision).toBe(revision);
  expect(JSON.stringify(project)).toBe(before);
});
it('rejects stricter canonical envelopes before the fixed-file adapter', () => {
  const f = fixture();
  const page = f.project.pages[0];
  const badProjects = [
    { ...f.project, apiKey: 'unexpected' },
    { ...f.project, source: { ...f.project.source, path: 'live.pptx' } },
    { ...f.project, pages: [] },
    { ...f.project, pages: Array.from({ length: 101 }, (_, i) => ({ ...page, pageId: `p-${i}` })) },
    { ...f.project, pages: [{ ...page, liveIndex: 0 }] },
    { ...f.project, pages: [{ ...page, actions: [{}] }] },
    { ...f.project, pages: [{ ...page, actions: [page.actions[0], page.actions[0]] }] },
    {
      ...f.project,
      pages: [
        { ...page, actions: [{ id: 'large', type: 'speech', text: 'x'.repeat(2 * 1024 * 1024) }] },
      ],
    },
    { ...f.project, educationContext: { fullEnglishTeaching: 'false' } },
    { ...f.project, educationContext: { apiKey: 'unexpected' } },
    { ...f.project, educationContext: { visualStyle: 123 } },
    { ...f.project, educationContext: { visualStyle: 'x'.repeat(501) } },
  ];
  for (const project of badProjects)
    expect(() => adaptCanonicalSnapshot(project, f.snapshot, f.files)).toThrow(
      'CANONICAL_SNAPSHOT_INVALID',
    );
  expect(() => adaptCanonicalSnapshot(f.project, { ...f.snapshot, live: true }, f.files)).toThrow(
    'CANONICAL_SNAPSHOT_INVALID',
  );
});
it('keeps action-specific validation after accepting a canonical action envelope', () => {
  const f = fixture();
  for (const actions of [
    [{ id: 'unsupported', type: 'wait', durationMs: 1000 }],
    [{ id: 'no-audio', type: 'speech', text: 'Do not synthesize this.' }],
    [
      {
        id: 'long-wait',
        type: 'speech',
        text: 'Pause.',
        audioAssetId: 'voice-1',
        pauseAfterMs: 30001,
      },
    ],
  ]) {
    const project = {
      ...f.project,
      pages: f.project.pages.map((p, i) => (i ? p : { ...p, actions })),
    };
    expect(isCoursewareProject(project)).toBe(true);
    expect(() => adaptCanonicalSnapshot(project, f.snapshot, f.files)).toThrow(
      'SNAPSHOT_SCHEMA_INVALID',
    );
  }
});
it('adapts a ready locked immutable export without changing canonical inputs', () => {
  const f = fixture();
  const before = JSON.stringify(f);
  expect(isCoursewareProject(f.project)).toBe(true);
  expect(isCoursewareSnapshot(f.snapshot)).toBe(true);
  expect(adaptCanonicalSnapshot(f.project, f.snapshot, f.files)).toEqual(
    read(path.resolve('tests/fixtures/fixed-courseware/snapshot.json')),
  );
  expect(JSON.stringify(f)).toBe(before);
});
it('preserves a separate audio clip in the canonical teaching export', () => {
  const f = fixture();
  const action = { id: 'music-1', type: 'audio_clip', audioAssetId: f.files.assets[0].id };
  const project = { ...f.project, pages: f.project.pages.map((page, index) => index ? page : { ...page, actions: [...page.actions, action] }) };
  const before = JSON.stringify(project);
  expect(adaptCanonicalSnapshot(project, f.snapshot, f.files).teaching.pages[0].actions.at(-1)).toEqual(action);
  expect(JSON.stringify(project)).toBe(before);
  expect(() => adaptCanonicalSnapshot({ ...project, pages: [{ ...project.pages[0], actions: [{ ...action, audioAssetId: undefined }] }, ...project.pages.slice(1)] }, f.snapshot, f.files)).toThrow('SNAPSHOT_SCHEMA_INVALID');
});
it('qualifies page-local action IDs only in the fixed export, deterministically', () => {
  const f = fixture();
  for (const page of f.project.pages) page.actions[0].id = 'narration-0';
  const before = JSON.stringify(f);
  const adapted = adaptCanonicalSnapshot(f.project, f.snapshot, f.files);
  const ids = adapted.teaching.pages.flatMap((page) => page.actions.map((action) => action.id));
  expect(new Set(ids).size).toBe(ids.length);
  expect(adaptCanonicalSnapshot(f.project, f.snapshot, f.files)).toEqual(adapted);
  const reversed = { ...f.project, pages: [...f.project.pages].reverse() };
  expect(adaptCanonicalSnapshot(reversed, f.snapshot, f.files).teaching.pages.reverse())
    .toEqual(adapted.teaching.pages);
  adapted.teaching.pages.forEach((page, index) => {
    page.actions.forEach((action, actionIndex) => {
      expect(action.id.length).toBeLessThanOrEqual(200);
      expect({ ...action, id: f.project.pages[index].actions[actionIndex].id })
        .toEqual(f.project.pages[index].actions[actionIndex]);
    });
  });
  expect(JSON.stringify(f)).toBe(before);
});
it.each(['source', 'hash', 'teaching', 'project', 'mapping'] as const)(
  'rejects a stale %s export before build',
  (kind) => {
    const f = fixture();
    if (kind === 'source') f.project.source.revision = 'R9';
    if (kind === 'hash') f.project.source.sha256 = '0'.repeat(64);
    if (kind === 'teaching') f.project.teachingRevision = 'T9';
    if (kind === 'project') f.snapshot.projectId = 'other-project';
    if (kind === 'mapping') f.files.mapping.revision = 'M9';
    expect(() => adaptCanonicalSnapshot(f.project, f.snapshot, f.files)).toThrow(
      'SNAPSHOT_REVISION_MISMATCH',
    );
  },
);
it('rejects invalid schema, unresolved files, review state, assets and pages', () => {
  const f = fixture();
  expect(() =>
    adaptCanonicalSnapshot({ ...f.project, schemaVersion: 'unknown' }, f.snapshot, f.files),
  ).toThrow('CANONICAL_SNAPSHOT_INVALID');
  expect(() => adaptCanonicalSnapshot(f.project, f.snapshot, {})).toThrow('SNAPSHOT_FILES_INVALID');
  f.project.pages[0].reviewState = 'review';
  expect(() => adaptCanonicalSnapshot(f.project, f.snapshot, f.files)).toThrow(
    'TEACHING_REVIEW_REQUIRED',
  );
  f.project.pages[0].reviewState = 'ready';
  f.snapshot.assetIds.push('unresolved-asset');
  expect(() => adaptCanonicalSnapshot(f.project, f.snapshot, f.files)).toThrow(
    'SNAPSHOT_ASSET_MISMATCH',
  );
  f.snapshot.assetIds.pop();
  f.files.mapping.pages[0].pageId = 'unknown-page';
  expect(() => adaptCanonicalSnapshot(f.project, f.snapshot, f.files)).toThrow(
    'PAGE_MAPPING_MISMATCH',
  );
});
