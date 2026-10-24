import JSZip from 'jszip';
import { expect, it } from 'vitest';
import { candidateHash } from '../page-candidate-baseline';
import {
  createPageCandidateLineage,
  generatePageFadeCandidate,
  generatePagePptxCandidate,
} from '../page-pptx-candidate';
import { pageFixture } from './page-candidate-fixtures';

async function setup() {
  const f = await pageFixture();
  const common = {
    ...f,
    target: { pageId: f.baseline.pageId, slidePart: 'ppt/slides/slide2.xml' },
    getCurrentBaseline: async () => f.baseline,
  };
  const mapping = {
    revision: 'M7',
    sourceSha256: f.baseline.sourceHash.slice(7),
    pages: [
      { pageId: 'first', importPageId: 'page_1', objects: [] },
      { pageId: f.baseline.pageId, importPageId: 'page_2', objects: [] },
      { pageId: 'last', importPageId: 'page_3', objects: [] },
    ],
  };
  return { ...f, common, mapping };
}

it('emits exact-hash D lineage for redo and fade without inheriting rebuilt object identities', async () => {
  const f = await setup();
  for (const candidate of [
    await generatePageFadeCandidate(f.common),
    await generatePagePptxCandidate({
      ...f.common,
      instruction: 'Redo',
      generate: async () => ({ scene: f.scene, assets: f.assets }),
    }),
  ]) {
    const result = await createPageCandidateLineage({
      sourcePptx: f.sourcePptx,
      candidate,
      mapping: f.mapping,
    });
    expect(result).toEqual({
      previousSourceSha256: f.mapping.sourceSha256,
      currentSourceSha256: candidate.hash.slice(7),
      pages: f.mapping.pages.map((p) => ({ oldLogicalId: p.pageId, importPageId: p.importPageId })),
      copiedImportPageIds: [],
      replacements: [],
    });
  }
});

it('rejects wrong source/output hashes, incomplete/duplicate/forged targets and cancellation', async () => {
  const f = await setup();
  const candidate = await generatePageFadeCandidate(f.common);
  const args = { sourcePptx: f.sourcePptx, candidate, mapping: f.mapping };
  for (const mapping of [
    { ...f.mapping, sourceSha256: 'a'.repeat(64) },
    { ...f.mapping, pages: f.mapping.pages.slice(1) },
    { ...f.mapping, pages: [f.mapping.pages[0], f.mapping.pages[0], f.mapping.pages[2]] },
    {
      ...f.mapping,
      pages: f.mapping.pages.map((p) => ({
        ...p,
        pageId: p.pageId === f.baseline.pageId ? 'forged' : p.pageId,
      })),
    },
  ])
    await expect(createPageCandidateLineage({ ...args, mapping })).rejects.toThrow();
  await expect(
    createPageCandidateLineage({ ...args, sourcePptx: Buffer.from('wrong') }),
  ).rejects.toThrow();
  await expect(
    createPageCandidateLineage({
      ...args,
      candidate: { ...candidate, hash: candidateHash('wrong') },
    }),
  ).rejects.toThrow();
  await expect(
    createPageCandidateLineage({ ...args, signal: AbortSignal.abort() }),
  ).rejects.toThrow();
});

it('validates all optional batch targets and captures them before awaiting package reads', async () => {
  const f = await setup();
  const candidate = await generatePageFadeCandidate(f.common);
  const args = { sourcePptx: f.sourcePptx, candidate, mapping: f.mapping };
  const targets = [f.common.target, { pageId: 'last', slidePart: 'ppt/slides/slide3.xml' }];
  const pending = createPageCandidateLineage({ ...args, targets });
  targets[1].slidePart = 'ppt/slides/slide1.xml';
  await expect(pending).resolves.toMatchObject({ pages: expect.any(Array) });
  for (const target of [
    { pageId: 'last', slidePart: 'ppt/slides/slide1.xml' },
    { pageId: 'last', slidePart: 'ppt/slides/slide99.xml' },
    { pageId: 'other', slidePart: 'ppt/slides/slide3.xml' },
    { pageId: 'last', slidePart: '../slides/slide3.xml' },
  ])
    await expect(createPageCandidateLineage({ ...args, targets: [target] })).rejects.toThrow();
});

it('rejects honestly rehashed non-target edits, reordered slides and unexpected assets despite a forged report', async () => {
  const f = await setup();
  const candidate = await generatePageFadeCandidate(f.common);
  for (const mutation of ['non-target', 'reorder', 'extra']) {
    const zip = await JSZip.loadAsync(candidate.pptx);
    if (mutation === 'non-target')
      zip.file(
        'ppt/slides/slide1.xml',
        (await zip.file('ppt/slides/slide1.xml')!.async('string')).replace(
          'Original first page',
          'Changed first page',
        ),
      );
    if (mutation === 'reorder')
      zip.file(
        'ppt/presentation.xml',
        (await zip.file('ppt/presentation.xml')!.async('string')).replace(
          new RegExp('(<p:sldId[^>]+/>)(<p:sldId[^>]+/>)'),
          '$2$1',
        ),
      );
    if (mutation === 'extra') zip.file('ppt/media/injected.png', 'bad');
    const pptx = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(
      createPageCandidateLineage({
        sourcePptx: f.sourcePptx,
        mapping: f.mapping,
        candidate: {
          ...candidate,
          pptx,
          hash: candidateHash(pptx),
          report: { ...candidate.report, changedParts: ['ppt/slides/slide1.xml'] },
        },
      }),
    ).rejects.toThrow();
  }
});


it('retains the original lineage cancellation after asynchronous package reads begin', async () => {
  const f = await setup();
  const candidate = await generatePageFadeCandidate(f.common);
  const controller = new AbortController();
  const input = { sourcePptx: f.sourcePptx, candidate, mapping: f.mapping, signal: controller.signal };
  const pending = createPageCandidateLineage(input);
  input.signal = new AbortController().signal;
  controller.abort();
  await expect(pending).rejects.toThrow();
});
