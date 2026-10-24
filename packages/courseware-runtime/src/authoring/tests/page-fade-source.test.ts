import JSZip from 'jszip';
import { expect, it, vi } from 'vitest';
import { candidateHash } from '../page-candidate-baseline';
import {
  generatePageFadeCandidate,
  inspectPageFadeSource,
} from '../page-pptx-candidate';
import { pageFixture } from './page-candidate-fixtures';

const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const P14 = 'http://schemas.microsoft.com/office/powerpoint/2010/main';
const part = 'ppt/slides/slide2.xml';
async function setup(addition = '') {
  const fixture = await pageFixture();
  const zip = await JSZip.loadAsync(fixture.sourcePptx);
  const slide = (await zip.file(part)!.async('string')).replace('</p:sld>', `${addition}</p:sld>`);
  zip.file(part, slide);
  const sourcePptx = await zip.generateAsync({ type: 'nodebuffer' });
  const baseline = { ...fixture.baseline, sourceHash: candidateHash(sourcePptx) };
  return {
    baseline,
    sourcePptx,
    pageText: fixture.pageText,
    target: { pageId: baseline.pageId, slidePart: part },
    getCurrentBaseline: vi.fn(async () => ({ ...baseline })),
    slide,
  };
}

it.each(['', '<p:transition/>', '<p:transition advClick="1"><p:fade thruBlk="0"/></p:transition>'])(
  'returns frozen source-bound facts without generating or mutating bytes: %s',
  async (transition) => {
    const input = await setup(transition),
      original = Buffer.from(input.sourcePptx);
    const generate = vi.spyOn(JSZip.prototype, 'generateAsync');
    try {
      const result = await inspectPageFadeSource(input);
      expect(result).toEqual({
        version: 1,
        kind: 'page-fade-source',
        baseline: input.baseline,
        target: { ...input.target, pageNumber: 2 },
        slideHash: candidateHash(input.slide),
        existingTransition: transition.includes('p:fade') ? 'fade' : 'none',
        sourceBytes: original.length,
      });
      expect(input.sourcePptx).toEqual(original);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.baseline)).toBe(true);
      expect(Object.isFrozen(result.target)).toBe(true);
      expect(input.getCurrentBaseline).toHaveBeenCalledTimes(2);
      expect(generate).not.toHaveBeenCalled();
      expect(result).not.toHaveProperty('pptx');
    } finally {
      generate.mockRestore();
    }
  },
);

it.each(['p14', 'p159'])(
  'accepts the verified Office %s wrapper with plain click fade',
  async (requires) => {
    const transition = `<p:transition xmlns:p14="${P14}" p14:dur="750" spd="med" advClick="1"><p:fade thruBlk="0"/></p:transition>`;
    const wrapper = `<mc:AlternateContent xmlns:mc="${MC}"><mc:Choice Requires="${requires}">${transition}</mc:Choice><mc:Fallback><p:transition spd="med" advClick="1"><p:fade/></p:transition></mc:Fallback></mc:AlternateContent>`;
    expect((await inspectPageFadeSource(await setup(wrapper))).existingTransition).toBe('fade');
  },
);

it.each([
  '<p:transition advTm="1000"><p:fade/></p:transition>',
  '<p:transition><p:fade thruBlk="1"/></p:transition>',
  '<p:transition><p:wipe/></p:transition>',
  '<p:transition><p:fade/><p:sndAc><p:endSnd/></p:sndAc></p:transition>',
  '<p:transition><p:fade/><p:extLst/></p:transition>',
  '<p:transition bogus="1"><p:fade/></p:transition>',
  '<p:transition xmlns:q="urn:unknown" q:sound="1"><p:fade/></p:transition>',
  `<p:transition xmlns:p14="${P14}" p14:dur="NaN"><p:fade/></p:transition>`,
  '<p:transition/><p:transition/>',
  '<p:transition/> <q:transition xmlns:q="urn:unknown"/>',
  `<mc:AlternateContent xmlns:mc="${MC}"/>`,
  `<mc:AlternateContent xmlns:mc="${MC}"><mc:Choice Requires="unverified"><p:transition/></mc:Choice><mc:Fallback><p:transition/></mc:Fallback></mc:AlternateContent>`,
  `<mc:AlternateContent xmlns:mc="${MC}"><mc:Choice Requires="p159"><p:transition><p:fade/></p:transition></mc:Choice><mc:Fallback><p:transition/></mc:Fallback></mc:AlternateContent>`,
  '<p:cSld><p:spTree/></p:cSld>',
])('refuses unsupported or ambiguous target transition data: %s', async (addition) => {
  await expect(inspectPageFadeSource(await setup(addition))).rejects.toMatchObject({
    code: 'UNSAFE_PACKAGE',
  });
});

it.each(['<p:transition advClick="0"><p:fade/></p:transition>', '<p:extLst/>'])(
  'withholds native use while preserving the existing independent copy behavior: %s',
  async (addition) => {
    const input = await setup(addition);
    await expect(inspectPageFadeSource(input)).rejects.toMatchObject({ code: 'UNSAFE_PACKAGE' });
    const candidate = await generatePageFadeCandidate(input);
    expect(candidate.kind).toBe('page-fade');
    const slide = await (await JSZip.loadAsync(candidate.pptx)).file(part)!.async('string');
    expect(slide).toContain('advClick="1"');
    if (addition.startsWith('<p:extLst')) expect(slide).toContain(addition);
  },
);

it('resolves actual presentation order instead of using the slide filename as a page number', async () => {
  const input = await setup(),
    zip = await JSZip.loadAsync(input.sourcePptx);
  const xml = await zip.file('ppt/presentation.xml')!.async('string');
  const list = xml.match(/<p:sldId\b[^>]*\/>/g)!;
  expect(list).toHaveLength(3);
  zip.file(
    'ppt/presentation.xml',
    xml.replace(list.join(''), [list[0], list[2], list[1]].join('')),
  );
  const sourcePptx = await zip.generateAsync({ type: 'nodebuffer' });
  const baseline = { ...input.baseline, sourceHash: candidateHash(sourcePptx) };
  expect(
    (
      await inspectPageFadeSource({
        ...input,
        sourcePptx,
        baseline,
        getCurrentBaseline: async () => baseline,
      })
    ).target,
  ).toEqual({ ...input.target, pageNumber: 3 });
});

it.each(['source-bytes', 'page-text', 'logical-page', 'missing-part', 'duplicate-page', 'doctype'])(
  'refuses invalid source or mapping: %s',
  async (change) => {
    const input = await setup();
    if (change === 'source-bytes') input.sourcePptx = Buffer.from('untrusted');
    if (change === 'page-text') input.pageText = 'wrong';
    if (change === 'logical-page') input.target.pageId = 'wrong';
    if (change === 'missing-part') input.target.slidePart = 'ppt/slides/slide9.xml';
    if (change === 'duplicate-page' || change === 'doctype') {
      const zip = await JSZip.loadAsync(input.sourcePptx);
      const name = change === 'doctype' ? part : 'ppt/presentation.xml';
      const xml = await zip.file(name)!.async('string');
      zip.file(
        name,
        change === 'doctype'
          ? '<!DOCTYPE a>' + xml
          : xml.replace(/<p:sldId\b[^>]*\/>/, (match) => match + match),
      );
      input.sourcePptx = await zip.generateAsync({ type: 'nodebuffer' });
      input.baseline.sourceHash = candidateHash(input.sourcePptx);
    }
    await expect(inspectPageFadeSource(input)).rejects.toThrow();
  },
);

it.each([
  ['start', 'clean', false, 'DIRTY_SOURCE'],
  ['end', 'clean', false, 'DIRTY_SOURCE'],
  ['start', 'readOnly', true, 'READ_ONLY'],
  ['end', 'readOnly', true, 'READ_ONLY'],
  ['start', 'manualLocked', true, 'MANUAL_LOCK'],
  ['end', 'manualLocked', true, 'MANUAL_LOCK'],
  ['end', 'sourceRevision', 99, 'STALE_BASELINE'],
  ['end', 'teachingRevision', 99, 'STALE_BASELINE'],
] as const)('checks %s baseline %s after asynchronous reads', async (phase, field, value, code) => {
  const input = await setup();
  let calls = 0;
  input.getCurrentBaseline.mockImplementation(async () => {
    calls++;
    return { ...input.baseline, ...(phase === 'start' || calls === 2 ? { [field]: value } : {}) };
  });
  await expect(inspectPageFadeSource(input)).rejects.toMatchObject({ code });
});

it('pins the source, target and baseline reader before the first asynchronous callback', async () => {
  const input = await setup(),
    original = { ...input.baseline },
    target = { ...input.target };
  const replacement = vi.fn(async () => original);
  let calls = 0;
  const trusted = vi.fn(async () => {
    calls++;
    input.sourcePptx.fill(0);
    input.target.slidePart = 'ppt/slides/slide3.xml';
    input.pageText = 'replaced';
    input.getCurrentBaseline = replacement;
    return { ...original, clean: calls === 1 };
  });
  input.getCurrentBaseline = trusted;
  await expect(inspectPageFadeSource(input)).rejects.toMatchObject({ code: 'DIRTY_SOURCE' });
  expect(trusted).toHaveBeenCalledTimes(2);
  expect(replacement).not.toHaveBeenCalled();
  const fresh = await setup();
  fresh.getCurrentBaseline.mockImplementation(async () => {
    fresh.target.slidePart = 'ppt/slides/slide3.xml';
    return fresh.baseline;
  });
  expect((await inspectPageFadeSource(fresh)).target).toEqual({ ...target, pageNumber: 2 });
});

it.each(['before', 'during'])(
  'keeps cancellation %s inspection, even if the caller replaces input.signal',
  async (phase) => {
    const fixture = await setup(),
      controller = new AbortController();
    const input = { ...fixture, signal: controller.signal };
    if (phase === 'before') controller.abort();
    else
      input.getCurrentBaseline.mockImplementation(async () => {
        controller.abort();
        input.signal = new AbortController().signal;
        return input.baseline;
      });
    await expect(inspectPageFadeSource(input)).rejects.toThrow();
  },
);

it('allows object timing outside the transition without claiming to edit or validate arbitrary animation', async () => {
  const input = await setup('<p:timing><p:tnLst/></p:timing>');
  expect((await inspectPageFadeSource(input)).existingTransition).toBe('none');
  expect(input.slide).toContain('<p:timing>');
});

it.each([
  'layout-transition',
  'master-transition',
  'master-wrapper',
  'missing-layout',
  'external-layout',
  'duplicate-master',
])('refuses unverified parent transition or mapping: %s', async (change) => {
  const input = await setup(),
    zip = await JSZip.loadAsync(input.sourcePptx);
  const parent =
    change === 'layout-transition'
      ? 'ppt/slideLayouts/slideLayout1.xml'
      : 'ppt/slideMasters/slideMaster1.xml';
  if (change.endsWith('transition') || change === 'master-wrapper') {
    const xml = await zip.file(parent)!.async('string');
    const addition =
      change === 'master-wrapper' ? `<mc:AlternateContent xmlns:mc="${MC}"/>` : '<p:transition/>';
    zip.file(
      parent,
      xml.replace(/<\/p:(sldLayout|sldMaster)>/, (match) => addition + match),
    );
  } else {
    const name =
      change === 'duplicate-master'
        ? 'ppt/slideLayouts/_rels/slideLayout1.xml.rels'
        : 'ppt/slides/_rels/slide2.xml.rels';
    const xml = await zip.file(name)!.async('string');
    const rel = xml.match(
      new RegExp(
        `<Relationship\\b[^>]*Type="[^"]*/${change === 'duplicate-master' ? 'slideMaster' : 'slideLayout'}"[^>]*/>`,
      ),
    )![0];
    zip.file(
      name,
      xml.replace(
        rel,
        change === 'missing-layout'
          ? ''
          : change === 'external-layout'
            ? rel.replace('/>', ' TargetMode="External"/>')
            : rel + rel.replace(/Id="[^"]*"/, 'Id="duplicate"'),
      ),
    );
  }
  const sourcePptx = await zip.generateAsync({ type: 'nodebuffer' });
  const baseline = { ...input.baseline, sourceHash: candidateHash(sourcePptx) };
  await expect(
    inspectPageFadeSource({
      ...input,
      sourcePptx,
      baseline,
      getCurrentBaseline: async () => baseline,
    }),
  ).rejects.toMatchObject({ code: 'UNSAFE_PACKAGE' });
});
