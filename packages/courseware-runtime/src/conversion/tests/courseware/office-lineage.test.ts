import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  bindSavedSourceIdentity, reconcileSavedSources, sha256,
  validateSavedSourceIdentity, type SavedSourceIdentity,
} from '../../../node';
import { createPptEditorPageLineage } from '../../../../tests/fixtures/office-lineage-b7/b7-ppt-editor-bridge';

const fixture = path.resolve('tests/fixtures/office-lineage-b7');
const worker = path.resolve('.worker-desktop-02');
const names = ['source', 'native-edited', 'reordered', 'copied-page'] as const;
const identities = new Map<string, SavedSourceIdentity>();
const json = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
let directory: string;
let sourceMapping: Awaited<ReturnType<typeof json>>;
beforeAll(async () => {
  const sources = await json(path.join(fixture, 'SOURCE.json'));
  for (const [file, record] of Object.entries(sources.files)) {
    expect(sha256(await readFile(path.join(fixture, file)))).toBe((record as { sha256: string }).sha256);
  }
  expect(sha256(await readFile(path.join(worker, 'manifest.json')))).toBe(
    '1eb6dd1479dffca96620281d74243bfab738d8115884dcdc633956c78247339a',
  );
  directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-office-lineage-'));
  sourceMapping = await json(path.join(fixture, 'source-mapping.json'));
  for (const name of names) {
    const file = path.join(fixture, `${name}.pptx`);
    const output = path.join(directory, name);
    await promisify(execFile)(process.execPath, [path.join(worker, 'pptx-worker.mjs'), file, output], {
      timeout: 30_000, maxBuffer: 1024 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    const bytes = await readFile(path.join(output, 'identity.json'));
    const result = await json(path.join(output, 'result.json'));
    expect(sha256(bytes)).toBe(result.identitySha256);
    const identity = validateSavedSourceIdentity(JSON.parse(bytes.toString()));
    expect(identity.sourceSha256).toBe(sha256(await readFile(file)));
    identities.set(name, identity);
  }
}, 30_000);
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
const identity = (name: string) => identities.get(name)!;
async function argumentsFor(name: 'native-edited' | 'reordered' | 'copied-page') {
  const receipt = await json(path.join(fixture, `${name}.pptx.receipt.json`));
  const previous = identity(name === 'native-edited' ? 'source' : name === 'reordered' ? 'native-edited' : 'reordered');
  // This mapping is test data, never an automatic Host adoption or review decision.
  const mapping = {
    ...sourceMapping, sourceSha256: previous.sourceSha256,
    pages: previous.pages.map((page, index) => ({
      pageId: `B7-logical-${index + 1}`, importPageId: page.importPageId,
      objects: page.objects.map((object, j) => ({ objectId: `fixture-object-${index}-${j}`, importElementId: object.importElementId })),
    })),
  };
  return {
    receipt, binding: { projectId: receipt.projectId, documentId: receipt.documentId, sessionId: receipt.sessionId },
    saveRequestId: receipt.saveRequestId, sourceSha256: previous.sourceSha256,
    outputSha256: identity(name).sourceSha256, sourcePages: mapping.pages,
    mapping, previous,
  };
}

for (const [name, expectedFile] of [['native-edited', 'native-lineage'], ['reordered', 'reordered-lineage']] as const) {
  it(`reconciles actual B7 ${name} bytes through Desktop's public API with review retained`, async () => {
    const args = await argumentsFor(name);
    const before = JSON.stringify(args);
    const lineage = createPptEditorPageLineage(args);
    expect(lineage).toEqual(await json(path.join(fixture, `${expectedFile}.json`)));
    const previous = name === 'native-edited'
      ? bindSavedSourceIdentity(args.previous, sourceMapping)
      : bindSavedSourceIdentity(args.previous, args.mapping);
    const result = reconcileSavedSources(previous, identity(name), lineage);
    expect(result.requiresHostReview).toBe(true);
    expect(result.report.pages).toHaveLength(3);
    for (const page of lineage.pages) {
      expect(result.report.pages).toContainEqual({
        oldLogicalId: page.oldLogicalId,
        newLogicalId: identity(name).pages.find(p => p.importPageId === page.importPageId)!.logicalId,
        decision: 'matched', reason: 'persisted-page-lineage',
      });
    }
    expect(lineage.replacements).toEqual([]);
    expect(JSON.stringify(args)).toBe(before);
    expect(identity(name).mappingRevision).toBeUndefined();
  });
}

it('does not inherit a changed native text object identity from page tokens', async () => {
  const args = await argumentsFor('native-edited');
  const result = reconcileSavedSources(bindSavedSourceIdentity(args.previous, sourceMapping), identity('native-edited'), createPptEditorPageLineage(args));
  expect(result.report.objects.some(o => o.decision === 'created')).toBe(true);
  expect(result.requiresHostReview).toBe(true);
});
for (const field of ['session', 'saveRequest', 'sourceHash', 'outputHash'] as const) {
  it(`rejects B7 receipt with stale ${field} before reconciliation`, async () => {
    const args = await argumentsFor('reordered');
    if (field === 'session') args.binding.sessionId = 'other-session';
    if (field === 'saveRequest') args.saveRequestId = 'other-save';
    if (field === 'sourceHash') args.sourceSha256 = '0'.repeat(64);
    if (field === 'outputHash') args.outputSha256 = '0'.repeat(64);
    expect(() => createPptEditorPageLineage(args)).toThrow(/saved bytes\/session/);
  });
}
it('rejects an incomplete original source mapping instead of following ordinals', async () => {
  const args = await argumentsFor('reordered');
  expect(() => createPptEditorPageLineage({ ...args, sourcePages: args.sourcePages.slice(1) })).toThrow(/explicit identity review/);
});
it('rejects actual copied-page automatic association and retains four parsed pages', async () => {
  const args = await argumentsFor('copied-page');
  expect(identity('copied-page').pages).toHaveLength(4);
  expect(() => createPptEditorPageLineage(args)).toThrow(/explicit identity review/);
  const result = reconcileSavedSources(bindSavedSourceIdentity(args.previous, args.mapping), identity('copied-page'));
  expect(result.requiresHostReview).toBe(true);
  expect(result.report.pages.some(p => p.decision !== 'matched')).toBe(true);
});
it('rejects a valid receipt-derived lineage replayed against different output bytes', async () => {
  const args = await argumentsFor('native-edited');
  expect(() => reconcileSavedSources(bindSavedSourceIdentity(args.previous, sourceMapping), identity('reordered'), createPptEditorPageLineage(args))).toThrow('IDENTITY_STALE_LINEAGE');
});
it('does not associate the changed native page by matching its old ordinal without lineage', () => {
  const result = reconcileSavedSources(bindSavedSourceIdentity(identity('source'), sourceMapping), identity('native-edited'));
  expect(result.report.pages.find(p => p.oldLogicalId === 'B7-logical-1')?.decision).not.toBe('matched');
  expect(result.requiresHostReview).toBe(true);
});
