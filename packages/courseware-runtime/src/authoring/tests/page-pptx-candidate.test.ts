import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';
import { candidateHash } from '../page-candidate-baseline';
import { generatePageFadeCandidate, generatePagePptxCandidate } from '../page-pptx-candidate';
import { pageFixture } from './page-candidate-fixtures';

async function setup() {
  const fixture = await pageFixture();
  const generate = vi.fn(async () => ({ scene: fixture.scene, assets: fixture.assets }));
  const getCurrentBaseline = vi.fn(async () => fixture.baseline);
  const input = { ...fixture, instruction: 'Redo this page in a blue classroom style', target: { pageId: fixture.baseline.pageId, slidePart: 'ppt/slides/slide2.xml' }, generate, getCurrentBaseline };
  return { input, generate, getCurrentBaseline };
}

describe('single-page clean-copy PPTX candidate', () => {
  it('rebuilds only the target and preserves every other original part, including notes and assets', async () => {
    const { input } = await setup();
    const original = Buffer.from(input.sourcePptx);
    const result = await generatePagePptxCandidate(input);
    expect(result).toMatchObject({ kind: 'page-pptx', applied: false, reviewState: 'needs-review', baseline: input.baseline, scope: { pageIds: [input.baseline.pageId] } });
    expect(input.sourcePptx).toEqual(original);
    expect(result.hash).toBe(candidateHash(result.pptx));
    const before = await JSZip.loadAsync(original);
    const after = await JSZip.loadAsync(result.pptx);
    for (const entry of Object.values(before.files)) {
      if (!entry.dir && !result.report.changedParts.includes(entry.name)) {
        expect(await after.file(entry.name)!.async('uint8array')).toEqual(await entry.async('uint8array'));
        expect(result.report.preservedParts[entry.name]).toBe(candidateHash(await entry.async('uint8array')));
      }
    }
    const slide = await after.file('ppt/slides/slide2.xml')!.async('string');
    const rels = await after.file('ppt/slides/_rels/slide2.xml.rels')!.async('string');
    expect(slide).toContain('B candidate — editable text');
    expect(slide).toContain('showMasterSp="0"');
    expect(slide).not.toContain('Target original');
    expect(rels).toContain('notesSlide2.xml');
    expect(rels).toContain('rIdB');
    expect(result.report.warnings.join(' ')).toContain('animations/transitions are not retained');
  });

  it('rejects stale, dirty, locked or read-only baselines before calling the model', async () => {
    for (const [change, code] of [
      [{ sourceRevision: 8 }, 'STALE_BASELINE'], [{ teachingRevision: 4 }, 'STALE_BASELINE'],
      [{ clean: false }, 'DIRTY_SOURCE'], [{ manualLocked: true }, 'MANUAL_LOCK'], [{ readOnly: true }, 'READ_ONLY'],
    ] as const) {
      const { input, generate, getCurrentBaseline } = await setup();
      getCurrentBaseline.mockResolvedValue({ ...input.baseline, ...change });
      await expect(generatePagePptxCandidate(input)).rejects.toMatchObject({ code });
      expect(generate).not.toHaveBeenCalled();
    }
  });

  it('rejects changed bytes, unmapped pages, missing assets, wrong scene identity and malformed source', async () => {
    const { input } = await setup();
    await expect(generatePagePptxCandidate({ ...input, sourcePptx: Buffer.from('changed') })).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
    await expect(generatePagePptxCandidate({ ...input, target: { ...input.target, slidePart: 'ppt/slides/slide9.xml' } })).rejects.toMatchObject({ code: 'UNSAFE_PACKAGE' });
    await expect(generatePagePptxCandidate({ ...input, generate: async () => ({ scene: input.scene, assets: {} }) })).rejects.toThrow('Missing scene asset');
    await expect(generatePagePptxCandidate({ ...input, generate: async () => ({ scene: { ...input.scene, slideId: 'wrong' }, assets: input.assets }) })).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
    const broken = await JSZip.loadAsync(input.sourcePptx);
    broken.file('ppt/presentation.xml', '<!DOCTYPE a><broken/>');
    const sourcePptx = await broken.generateAsync({ type: 'nodebuffer' });
    const baseline = { ...input.baseline, sourceHash: candidateHash(sourcePptx) };
    await expect(generatePagePptxCandidate({ ...input, sourcePptx, baseline, getCurrentBaseline: async () => baseline })).rejects.toMatchObject({ code: 'UNSAFE_PACKAGE' });
  });

  it.each(['width', 'height', 'missing', 'duplicate'] as const)(
    'rejects an unsupported %s canvas before calling the generator',
    async (change) => {
      const { input, generate } = await setup();
      const zip = await JSZip.loadAsync(input.sourcePptx);
      const presentation = await zip.file('ppt/presentation.xml')!.async('string');
      const size = presentation.match(/<p:sldSz\b[^>]*\/>/)![0];
      const changed = change === 'width' ? size.replace('11704320', '914399')
        : change === 'height' ? size.replace('7315200', '37453825')
        : change === 'missing' ? '' : size + size;
      zip.file('ppt/presentation.xml', presentation.replace(size, changed));
      const sourcePptx = await zip.generateAsync({ type: 'nodebuffer' });
      const original = Buffer.from(sourcePptx);
      const baseline = { ...input.baseline, sourceHash: candidateHash(sourcePptx) };
      generate.mockResolvedValue({
        scene: { ...input.scene, sourceHash: baseline.sourceHash }, assets: input.assets,
      });
      await expect(generatePagePptxCandidate({
        ...input, sourcePptx, baseline, getCurrentBaseline: async () => baseline,
      })).rejects.toMatchObject({ code: 'UNSAFE_PACKAGE', message: expect.stringContaining('canvas') });
      expect(generate).not.toHaveBeenCalled();
      expect(sourcePptx).toEqual(original);
    },
  );

  it('keeps the independent fade candidate available on a non-scene canvas', async () => {
    const { input, generate } = await setup();
    const zip = await JSZip.loadAsync(input.sourcePptx);
    zip.file('ppt/presentation.xml', (await zip.file('ppt/presentation.xml')!.async('string'))
      .replace('cx="11704320" cy="7315200"', 'cx="12192000" cy="6858000"'));
    const sourcePptx = await zip.generateAsync({ type: 'nodebuffer' });
    const baseline = { ...input.baseline, sourceHash: candidateHash(sourcePptx) };
    const result = await generatePageFadeCandidate({
      ...input, sourcePptx, baseline, getCurrentBaseline: async () => baseline,
    });
    expect(result.kind).toBe('page-fade');
    expect(result.report.changedParts).toEqual(['ppt/slides/slide2.xml']);
    const after = await JSZip.loadAsync(result.pptx);
    expect(await after.file('ppt/presentation.xml')!.async('string')).toBe(
      await zip.file('ppt/presentation.xml')!.async('string'),
    );
    expect(generate).not.toHaveBeenCalled();
  });

  it('rejects canvas changes and late source/teaching changes; propagates generation failure and cancellation', async () => {
    const { input } = await setup();
    for (const change of [{ sourceRevision: 8 }, { teachingRevision: 4 }, { manualLocked: true }]) {
      const current = vi.fn().mockResolvedValueOnce(input.baseline).mockResolvedValue({ ...input.baseline, ...change });
      await expect(generatePagePptxCandidate({ ...input, getCurrentBaseline: current })).rejects.toThrow();
      expect(current).toHaveBeenCalledTimes(2);
    }
    const abort = new AbortController();
    await expect(generatePagePptxCandidate({ ...input, signal: abort.signal, generate: async () => { abort.abort(); return { scene: input.scene, assets: input.assets }; } })).rejects.toThrow();
    await expect(generatePagePptxCandidate({ ...input, generate: async () => { throw new Error('model unavailable'); } })).rejects.toThrow('model unavailable');
    const zip = await JSZip.loadAsync(input.sourcePptx);
    zip.file('ppt/presentation.xml', (await zip.file('ppt/presentation.xml')!.async('string')).replace('cx="11704320"', 'cx="12000000"'));
    const sourcePptx = await zip.generateAsync({ type: 'nodebuffer' });
    const baseline = { ...input.baseline, sourceHash: candidateHash(sourcePptx) };
    await expect(generatePagePptxCandidate({ ...input, sourcePptx, baseline, getCurrentBaseline: async () => baseline, generate: async () => ({ scene: { ...input.scene, sourceHash: baseline.sourceHash }, assets: input.assets }) })).rejects.toThrow('canvas');
  });
});


it('pins the scene generator and instruction before awaiting the first baseline read', async () => {
  const { input } = await setup();
  const generate = input.generate;
  const replacement = vi.fn(async (...args: Parameters<typeof generate>) => generate(...args));
  const originalInstruction = input.instruction;
  input.getCurrentBaseline = vi.fn(async () => {
    input.generate = replacement;
    input.instruction = 'unreviewed instruction';
    return input.baseline;
  });
  await generatePagePptxCandidate(input);
  expect(generate).toHaveBeenCalledTimes(1);
  expect(generate).toHaveBeenCalledWith(expect.objectContaining({ instruction: originalInstruction }), undefined);
  expect(replacement).not.toHaveBeenCalled();
});

it('keeps reading the original live baseline when the caller replaces its input reader', async () => {
  const { input } = await setup();
  const current = structuredClone(input.baseline);
  const trusted = vi.fn(async () => current);
  const replacement = vi.fn(async () => input.baseline);
  input.getCurrentBaseline = trusted;
  input.generate.mockImplementation(async () => {
    current.clean = false;
    input.getCurrentBaseline = replacement;
    return { scene: input.scene, assets: input.assets };
  });
  await expect(generatePagePptxCandidate(input)).rejects.toMatchObject({ code: 'DIRTY_SOURCE' });
  expect(trusted).toHaveBeenCalledTimes(2);
  expect(replacement).not.toHaveBeenCalled();
});

it('keeps the original cancellation when the scene callback replaces input.signal', async () => {
  const { input: fixture } = await setup();
  const input = { ...fixture, signal: new AbortController().signal };
  const controller = new AbortController();
  input.signal = controller.signal;
  input.generate.mockImplementation(async () => {
    input.signal = new AbortController().signal;
    controller.abort();
    return { scene: input.scene, assets: input.assets };
  });
  await expect(generatePagePptxCandidate(input)).rejects.toThrow();
});

it.each(['reader', 'cancel'])('pins fade %s through asynchronous ZIP work', async (change) => {
  const { input: fixture } = await setup();
  const input = { ...fixture, signal: new AbortController().signal };
  const controller = new AbortController();
  input.signal = controller.signal;
  let reads = 0;
  const replacement = vi.fn(async () => input.baseline);
  input.getCurrentBaseline = vi.fn(async () => {
    reads++;
    input.signal = new AbortController().signal;
    if (change === 'reader') input.getCurrentBaseline = replacement;
    if (reads === 2 && change === 'cancel') controller.abort();
    return { ...input.baseline, clean: change === 'cancel' || reads === 1 };
  });
  await expect(generatePageFadeCandidate(input)).rejects.toThrow();
  expect(reads).toBe(2);
  expect(replacement).not.toHaveBeenCalled();
});


it.each([
  [12192000, 6858000], // PowerPoint wide: 13 1/3 × 7.5 inches.
  [9144000, 6858000], // 4:3: 10 × 7.5 inches.
])('preserves source canvas %i × %i EMU and every non-target part', async (cx, cy) => {
  const { input } = await setup();
  const source = await JSZip.loadAsync(input.sourcePptx);
  source.file('ppt/presentation.xml', (await source.file('ppt/presentation.xml')!.async('string'))
    .replace('cx="11704320" cy="7315200"', `cx="${cx}" cy="${cy}"`));
  const sourcePptx = await source.generateAsync({ type: 'nodebuffer' });
  const baseline = { ...input.baseline, sourceHash: candidateHash(sourcePptx) };
  const canvas = { width: cx / 9144, height: cy / 9144 };
  const generate = vi.fn(async (request: Parameters<Parameters<typeof generatePagePptxCandidate>[0]['generate']>[0]) => {
    expect(request.canvas).toEqual(canvas);
    const scene = { ...input.scene, sourceHash: baseline.sourceHash, canvas: { ...canvas },
      elements: [{ ...input.scene.elements[0], bboxPx: [50, 80, 900, 160] }] };
    expect(request.schema.parse(scene).canvas).toEqual(canvas);
    expect(request.schema.safeParse({ ...scene, canvas: input.scene.canvas }).success).toBe(false);
    request.canvas.width = 1280;
    return { scene, assets: input.assets };
  });
  const result = await generatePagePptxCandidate({ ...input, sourcePptx, baseline, generate,
    getCurrentBaseline: async () => baseline });
  const candidate = await JSZip.loadAsync(result.pptx);
  expect(await candidate.file('ppt/presentation.xml')!.async('string')).toContain(`cx="${cx}" cy="${cy}"`);
  for (const part of Object.keys(result.report.preservedParts))
    expect(await candidate.file(part)!.async('nodebuffer')).toEqual(await source.file(part)!.async('nodebuffer'));
  expect(await candidate.file('ppt/slides/slide2.xml')!.async('string')).toContain('<a:ext cx="8229600" cy="1463040"/>');
  expect(candidateHash(sourcePptx)).toBe(baseline.sourceHash);
  expect(generate).toHaveBeenCalledTimes(1);
});

it.each(['0', '-1', 'NaN', '1e7', '11704320.5', '011704320', '9999999999'])(
  'rejects noncanonical source canvas %s before invoking generation', async (width) => {
    const { input, generate } = await setup();
    const zip = await JSZip.loadAsync(input.sourcePptx);
    zip.file('ppt/presentation.xml', (await zip.file('ppt/presentation.xml')!.async('string')).replace('cx="11704320"', `cx="${width}"`));
    const sourcePptx = await zip.generateAsync({ type: 'nodebuffer' });
    const baseline = { ...input.baseline, sourceHash: candidateHash(sourcePptx) };
    await expect(generatePagePptxCandidate({ ...input, sourcePptx, baseline, getCurrentBaseline: async () => baseline })).rejects.toMatchObject({ code: 'UNSAFE_PACKAGE' });
    expect(generate).not.toHaveBeenCalled();
  },
);
