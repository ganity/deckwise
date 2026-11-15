import { expect, it } from 'vitest';
import { resolveCoursewareOriginalNotes } from './original-notes.js';
import { candidateHash } from './page-candidate-baseline.js';

function setup() {
  const sourcePptx = Buffer.from('saved source');
  const sourceSha256 = candidateHash(sourcePptx).slice(7);
  const baseline = { projectId: 'native', documentId: 'doc', sessionId: 'office', editGeneration: 4,
    coursewareProjectId: 'course', pageId: 'logical-target', sourceRevision: 'R1', sourceSha256,
    teachingRevision: 'T1', contentSha256: candidateHash('page').slice(7) };
  const project = { schemaVersion: 'deckwise-courseware/1', projectId: 'course', taskType: 'import', title: 'Notes',
    source: { revision: 'R1', sha256: sourceSha256 }, teachingRevision: 'T1',
    pages: [{ pageId: 'logical-target', actions: [], locked: false, reviewState: 'ready' }] };
  const snapshot = { baseline, project, clean: true, readOnly: false,
    savedIdentity: { schemaVersion: 'maic-saved-source-identity/1', mappingRevision: 'M1', sourceSha256,
      pages: [{ logicalId: 'logical-target', importPageId: 'page_8' }] } };
  const parsed = { result: { status: 'PARSED', sourceSha256 }, ir: { kind: 'slide', sourceType: 'pptx',
    pages: [{ id: 'page_8', notes: '<p>A &amp; B</p><p>Next<br/>line.</p>' }] } };
  return { baseline, sourcePptx, snapshot, getCurrent: async () => structuredClone(snapshot), parseSavedSource: async () => parsed };
}

it('resolves the saved logical mapping and plain notes without adopting teaching', async () => {
  const input = setup();
  const original = structuredClone(input.snapshot);
  const result = await resolveCoursewareOriginalNotes(input);
  expect(result.selection.text).toBe('A & B\nNext\nline.');
  expect(result.source.importPageId).toBe('page_8');
  expect(result.selection.baseline).toEqual(input.baseline);
  expect(input.snapshot).toEqual(original);
});

it.each(['project', 'source-revision', 'source-hash', 'teaching'])('refuses %s changes even with an unchanged supplied baseline', async (change) => {
  const input = setup();
  if (change === 'project') input.snapshot.project.projectId = 'other';
  if (change === 'source-revision') input.snapshot.project.source.revision = 'R2';
  if (change === 'source-hash') input.snapshot.project.source.sha256 = '0'.repeat(64);
  if (change === 'teaching') input.snapshot.project.teachingRevision = 'T2';
  await expect(resolveCoursewareOriginalNotes(input)).rejects.toMatchObject({ code: 'STALE_BASELINE' });
});
