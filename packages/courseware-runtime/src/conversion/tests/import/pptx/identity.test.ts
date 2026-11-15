import { describe, expect, it } from 'vitest';

import {
  contentFingerprint,
  geometryFingerprint,
  reconcileIdentity,
  type IdentityObjectSnapshot,
  type IdentityPageSnapshot,
} from '../../../lib/import/pptx/identity';

const object = (logicalId: string, content: string, left: number): IdentityObjectSnapshot => ({
  logicalId,
  type: 'text',
  contentFingerprint: contentFingerprint(content),
  geometryFingerprint: geometryFingerprint({ left, top: 0, width: 1, height: 1 }),
});

const page = (logicalId: string, objects: IdentityObjectSnapshot[]): IdentityPageSnapshot => ({
  logicalId,
  contentFingerprint: contentFingerprint(objects.map((item) => item.contentFingerprint).sort()),
  objects,
});

describe('PPTX identity reconciliation', () => {
  it('matches moved objects while reporting geometry separately', () => {
    const oldObject = object('old-title', 'same text', 1);
    const nextObject = object('new-shape-id', 'same text', 3);
    const result = reconcileIdentity(
      [page('page-1', [oldObject])],
      [{ ...page('new-slide-id', [nextObject]), logicalIdHint: 'page-1' }],
    );
    expect(result.pages[0]).toMatchObject({
      decision: 'matched',
      reason: 'persisted-page-lineage',
    });
    expect(result.objects[0]).toMatchObject({
      oldLogicalId: 'old-title',
      newLogicalId: 'new-shape-id',
      decision: 'matched',
      geometryChanged: true,
    });
  });

  it('does not guess between duplicate text objects', () => {
    const a = object('a', '重复文本', 1);
    const b = object('b', '重复文本', 4);
    const nextA = object('new-a', '重复文本', 1);
    const nextB = object('new-b', '重复文本', 4);
    const result = reconcileIdentity(
      [page('page-1', [a, b])],
      [{ ...page('new-page', [nextA, nextB]), logicalIdHint: 'page-1' }],
    );
    expect(
      result.objects.filter((entry) => entry.oldLogicalId && entry.decision === 'review'),
    ).toHaveLength(2);
    expect(result.objects.some((entry) => entry.decision === 'created')).toBe(false);
    expect(
      result.objects
        .filter((entry) => entry.decision === 'review')
        .every((entry) => entry.reason === 'ambiguous-object-match'),
    ).toBe(true);
  });

  it('does not choose a surviving duplicate object by iteration order', () => {
    const result = reconcileIdentity(
      [page('page-1', [object('a', 'same', 1), object('b', 'same', 4)])],
      [{ ...page('new-page', [object('survivor', 'same', 4)]), logicalIdHint: 'page-1' }],
    );
    expect(result.objects).toHaveLength(3);
    expect(result.objects.every((entry) => entry.decision === 'review')).toBe(true);
  });

  it('does not choose a surviving duplicate page without persisted lineage', () => {
    const result = reconcileIdentity(
      [page('a', [object('a-text', 'same', 1)]), page('b', [object('b-text', 'same', 1)])],
      [page('survivor', [object('new-text', 'same', 1)])],
    );
    expect(result.pages).toHaveLength(3);
    expect(result.pages.every((entry) => entry.decision === 'review')).toBe(true);
    expect(result.objects).toHaveLength(0);
  });

  it('creates a copied page, marks a replacement for review, and reports deletion', () => {
    const title = object('title', 'Apple', 1);
    const apple = { ...object('apple', 'apple-bytes', 2), type: 'image' };
    const nextTitle = object('copied-title', 'Apple', 1);
    const pear = { ...object('pear', 'pear-bytes', 2), type: 'image' };
    const result = reconcileIdentity(
      [page('page-1', [title, apple]), page('page-2', [object('gone', 'gone', 1)])],
      [
        { ...page('page-1-after-save', [nextTitle, pear]), logicalIdHint: 'page-1' },
        page('page-copy', [
          object('copy-title', 'Apple', 1),
          object('copy-image', 'apple-bytes', 2),
        ]),
      ],
      {
        copiedPageLogicalIds: ['page-copy'],
        replacements: [{ oldLogicalId: 'apple', newContentFingerprint: pear.contentFingerprint }],
      },
    );
    expect(result.pages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ oldLogicalId: 'page-1', decision: 'matched' }),
        expect.objectContaining({ oldLogicalId: 'page-2', decision: 'deleted' }),
        expect.objectContaining({ newLogicalId: 'page-copy', decision: 'created' }),
      ]),
    );
    expect(result.objects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          oldLogicalId: 'apple',
          newLogicalId: 'pear',
          decision: 'review',
          reason: 'content-replaced',
        }),
      ]),
    );
  });
});
