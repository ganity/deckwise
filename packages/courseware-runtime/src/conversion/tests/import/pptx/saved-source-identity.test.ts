import { describe, expect, it, vi } from 'vitest';
import type { SlideIR } from '../../../lib/import/types';
import {
  bindSavedSourceIdentity,
  exportSavedSourceIdentity,
  reconcileSavedSources,
  validateSavedSourceIdentity,
  type SavedSourceIdentity,
} from '../../../lib/import/pptx/saved-source-identity';

const oldHash = 'a'.repeat(64);
const newHash = 'b'.repeat(64);
const ir = (): SlideIR => ({
  kind: 'slide',
  sourceType: 'pptx',
  pages: [
    {
      id: 'page_1',
      width: 1000,
      height: 562.5,
      elements: [
        {
          id: 'text-1',
          sourceShapeId: '123',
          type: 'text',
          content: 'same',
          left: 10,
          top: 20,
          width: 100,
          height: 30,
        },
        {
          id: 'picture',
          type: 'image',
          src: 'import-asset:local:image_abc',
          left: 0,
          top: 0,
          width: 100,
          height: 100,
        },
      ],
    },
  ],
});
const read = async () => new Uint8Array([1, 2, 3]);
const mapping = (source: SavedSourceIdentity) => ({
  revision: 'host-mapping-uuid',
  sourceSha256: source.sourceSha256,
  pages: source.pages.map((p, i) => ({
    pageId: `host-page-${i}`,
    importPageId: p.importPageId,
    objects: p.objects.map((o, j) => ({
      objectId: `host-object-${i}-${j}`,
      importElementId: o.importElementId,
    })),
  })),
});
const bound = async () => {
  const source = await exportSavedSourceIdentity(oldHash, ir(), read);
  return bindSavedSourceIdentity(source, mapping(source));
};
const lineage = () => ({
  previousSourceSha256: oldHash,
  currentSourceSha256: newHash,
  pages: [{ oldLogicalId: 'host-page-0', importPageId: 'page_1' }],
  copiedImportPageIds: [] as string[],
  replacements: [] as Array<{
    oldLogicalId: string;
    importPageId: string;
    importElementId: string;
  }>,
});

describe('saved-source identity boundary', () => {
  it('preserves native object names as save proof without making them content identity', async () => {
    const input = ir();
    input.pages[0].elements[0].sourceObjectName = 'Title & narration';
    const original = await exportSavedSourceIdentity(oldHash, input, read);
    expect(original.pages[0].objects[0].sourceObjectName).toBe('Title & narration');
    input.pages[0].elements[0].sourceObjectName = 'Renamed title';
    const renamed = await exportSavedSourceIdentity(oldHash, input, read);
    expect(renamed.pages[0].objects[0].contentFingerprint).toBe(original.pages[0].objects[0].contentFingerprint);
  });
  it('requires review for ambiguous objects even within identical bytes', async () => {
    const input = ir();
    input.pages[0].elements.push({ ...input.pages[0].elements[0], id: 'duplicate' });
    const source = await exportSavedSourceIdentity(oldHash, input, read);
    const previous = bindSavedSourceIdentity(source, mapping(source));
    expect(reconcileSavedSources(previous, source).requiresHostReview).toBe(true);
  });
  it('separates geometry and native/import IDs from content, binds Host IDs without mutation', async () => {
    const previous = await bound();
    const next = ir();
    next.pages[0].id = 'renumbered';
    next.pages[0].elements[0] = {
      ...next.pages[0].elements[0],
      id: 'new-native',
      sourceShapeId: '999',
      left: 70,
    };
    const current = await exportSavedSourceIdentity(newHash, next, read);
    const result = reconcileSavedSources(previous, current, {
      ...lineage(),
      pages: [{ oldLogicalId: 'host-page-0', importPageId: 'renumbered' }],
    });
    expect(result.report.objects[0]).toMatchObject({
      oldLogicalId: 'host-object-0-0',
      decision: 'matched',
      geometryChanged: true,
    });
    expect(result.requiresHostReview).toBe(true);
    expect(current.mappingRevision).toBeUndefined();
    expect(previous.pages[0].logicalId).toBe('host-page-0');
  });

  it('hashes actual asset bytes and not placeholder IDs; missing bytes fail', async () => {
    const first = await exportSavedSourceIdentity(oldHash, ir(), read);
    const next = ir();
    next.pages[0].elements[1].src = 'import-asset:other:renamed';
    const same = await exportSavedSourceIdentity(newHash, next, read);
    const changed = await exportSavedSourceIdentity(newHash, next, async () => new Uint8Array([9]));
    expect(first.pages[0].objects[1].contentFingerprint).toBe(
      same.pages[0].objects[1].contentFingerprint,
    );
    expect(first.pages[0].objects[1].contentFingerprint).not.toBe(
      changed.pages[0].objects[1].contentFingerprint,
    );
    await expect(
      exportSavedSourceIdentity(newHash, next, async () => {
        throw new Error('missing');
      }),
    ).rejects.toThrow('missing');
  });

  it('keeps converter errors and marks unverifiable URLs, with no fetching', async () => {
    const input = ir();
    input.warnings = [
      {
        code: 'PPTX_LINKED_TEXT_UNSUPPORTED',
        severity: 'error',
        message: 'unsupported',
        pageIndex: 0,
      },
    ];
    input.pages[0].elements[1].src = 'https://invalid.test/image.png';
    const assetRead = vi.fn(read);
    const result = await exportSavedSourceIdentity(oldHash, input, assetRead);
    expect(result.diagnostics.map((d) => d.code)).toEqual([
      'PPTX_LINKED_TEXT_UNSUPPORTED',
      'IDENTITY_RESOURCE_UNRESOLVED',
    ]);
    expect(assetRead).not.toHaveBeenCalled();
    const previous = bindSavedSourceIdentity(result, mapping(result));
    expect(reconcileSavedSources(previous, result).requiresHostReview).toBe(true);
  });

  it('uses unique content across reorder and never page ordinal for changed content', async () => {
    const input = ir();
    input.pages.push({
      ...ir().pages[0],
      id: 'page_2',
      elements: [{ ...ir().pages[0].elements[0], content: 'different' }],
    });
    const source = await exportSavedSourceIdentity(oldHash, input, read);
    const previous = bindSavedSourceIdentity(source, mapping(source));
    input.pages.reverse();
    input.pages.forEach((p, i) => {
      p.id = `page_${i + 1}`;
    });
    const next = await exportSavedSourceIdentity(newHash, input, read);
    const result = reconcileSavedSources(previous, next);
    expect(result.report.pages.every((p) => p.decision === 'matched')).toBe(true);
    expect(result.report.pages[0].newLogicalId).toBe(next.pages[1].logicalId);
    input.pages[1].elements[0].content = 'changed';
    const changed = reconcileSavedSources(
      previous,
      await exportSavedSourceIdentity(newHash, input, read),
    );
    expect(changed.report.pages.find((p) => p.oldLogicalId === 'host-page-0')?.decision).not.toBe(
      'matched',
    );
  });

  it('keeps duplicate text ambiguous, copied pages new, deleted objects and replacements under review', async () => {
    const input = ir();
    input.pages[0].elements.push(
      { ...input.pages[0].elements[0], id: 'duplicate', left: 300 },
      { ...input.pages[0].elements[0], id: 'badge', content: 'badge' },
    );
    const source = await exportSavedSourceIdentity(oldHash, input, read);
    const previous = bindSavedSourceIdentity(source, mapping(source));
    input.pages[0].elements.pop();
    input.pages[0].elements[1].src = 'import-asset:local:pear';
    input.pages.push({ ...structuredClone(input.pages[0]), id: 'copy' });
    const current = await exportSavedSourceIdentity(
      newHash,
      input,
      async () => new Uint8Array([9]),
    );
    const hints = lineage();
    hints.copiedImportPageIds = ['copy'];
    hints.replacements.push({
      oldLogicalId: 'host-object-0-1',
      importPageId: 'page_1',
      importElementId: 'picture',
    });
    const result = reconcileSavedSources(previous, current, hints);
    expect(
      result.report.pages.find((p) => p.newLogicalId === current.pages[1].logicalId)?.decision,
    ).toBe('created');
    expect(result.report.objects.find((o) => o.oldLogicalId === 'host-object-0-1')).toMatchObject({
      decision: 'review',
      reason: 'content-replaced',
    });
    expect(result.report.objects.find((o) => o.oldLogicalId === 'host-object-0-3')?.decision).toBe(
      'deleted',
    );
    expect(result.report.objects.filter((o) => o.reason === 'ambiguous-object-match')).toHaveLength(
      4,
    );
  });

  it('rejects stale, partial, duplicate and cross-page mappings', async () => {
    const source = await exportSavedSourceIdentity(oldHash, ir(), read);
    expect(() =>
      bindSavedSourceIdentity(source, { ...mapping(source), sourceSha256: newHash }),
    ).toThrow('IDENTITY_SOURCE_MISMATCH');
    const partial = mapping(source);
    partial.pages[0].objects.pop();
    expect(() => bindSavedSourceIdentity(source, partial)).toThrow('IDENTITY_BINDING_MISMATCH');
    const forged = mapping(source);
    forged.pages[0].objects[0].importElementId = 'unknown';
    expect(() => bindSavedSourceIdentity(source, forged)).toThrow('IDENTITY_BINDING_MISMATCH');
    const duplicate = mapping(source);
    duplicate.pages[0].objects[1].objectId = duplicate.pages[0].objects[0].objectId;
    expect(() => bindSavedSourceIdentity(source, duplicate)).toThrow('IDENTITY_DUPLICATE_BINDING');
  });

  it('rejects unknown versions/fields, duplicate imports, excessive pages and malformed hashes', async () => {
    const source = await exportSavedSourceIdentity(oldHash, ir(), read);
    for (const invalid of [
      { ...source, schemaVersion: 'next' },
      { ...source, sourceSha256: 'fake' },
      { ...source, unexpected: true },
      { ...source, pages: [] },
      { ...source, pages: Array(101).fill(source.pages[0]) },
    ]) {
      expect(() => validateSavedSourceIdentity(invalid)).toThrow('IDENTITY_SCHEMA_INVALID');
    }
    const duplicate = structuredClone(source);
    duplicate.pages[0].objects.push(duplicate.pages[0].objects[0]);
    expect(() => validateSavedSourceIdentity(duplicate)).toThrow('IDENTITY_DUPLICATE_BINDING');
  });

  it('rejects stale, forged, duplicate, copy-conflicting and cross-page lineage', async () => {
    const previous = await bound();
    const current = await exportSavedSourceIdentity(newHash, ir(), read);
    const invalid = [
      { ...lineage(), previousSourceSha256: newHash },
      { ...lineage(), currentSourceSha256: oldHash },
      { ...lineage(), pages: [{ oldLogicalId: 'forged', importPageId: 'page_1' }] },
      { ...lineage(), pages: [...lineage().pages, ...lineage().pages] },
      { ...lineage(), copiedImportPageIds: ['page_1'] },
      { ...lineage(), copiedImportPageIds: ['missing'] },
      {
        ...lineage(),
        pages: [],
        replacements: [
          { oldLogicalId: 'host-object-0-1', importPageId: 'page_1', importElementId: 'picture' },
        ],
      },
      {
        ...lineage(),
        replacements: [
          { oldLogicalId: 'host-object-0-0', importPageId: 'page_1', importElementId: 'picture' },
        ],
      },
    ];
    for (const hints of invalid)
      expect(() => reconcileSavedSources(previous, current, hints)).toThrow(/IDENTITY_/);
    expect(() => reconcileSavedSources(current, current)).toThrow(
      'IDENTITY_PREVIOUS_BINDING_REQUIRED',
    );
  });
});
