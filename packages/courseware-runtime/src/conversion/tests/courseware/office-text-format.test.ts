import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { SaxesParser } from 'saxes';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { adaptCanonicalSnapshot, buildFixedCourseware, sha256 } from '../../../node';

const fixture = path.resolve('tests/fixtures/office-text-format-b15');
const workerDirectory = path.resolve(process.env.DECKWISE_NATIVE_WORKER_DIRECTORY ?? '../../apps/desktop/resources/pptx-worker');
const json = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
let directory: string;
beforeAll(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'office-text-format-')); });
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

// Read inherited inline styles independently of the converter and mapper.
function characters(html: string) {
  const result: Array<{ text: string; color: string; size: number }> = [];
  const stack: Array<Record<string, string>> = [{}];
  const parser = new SaxesParser();
  parser.on('opentag', tag => {
      const style = { ...stack.at(-1) };
      for (const declaration of String(tag.attributes.style ?? '').split(';')) {
        const [name, value] = declaration.split(':');
        if (name && value) style[name.trim()] = value.trim();
      }
      stack.push(style);
    });
  parser.on('closetag', () => { stack.pop(); });
  parser.on('text', text => {
      const style = stack.at(-1)!;
      for (const char of text)
        result.push({ text: char.replace('\u00a0', ' '), color: style.color?.toUpperCase(),
          size: Number.parseFloat(style['font-size']) });
    });
  parser.write(html).close();
  return result;
}

for (const name of ['original', 'partial', 'cross-run']) {
  it(`preserves actual B15 ${name} per-character formatting through fixed conversion and packaging`, async () => {
    const source = await json(path.join(fixture, 'SOURCE.json'));
    const expected = source.variants[name];
    const bytes = await readFile(path.join(fixture, `${name}.pptx`));
    expect(sha256(bytes)).toBe(source.files[`${name}.pptx`].sha256);
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file('ppt/slides/slide2.xml')!.async('string');
    const title = xml.match(/<p:sp>.*?<\/p:sp>/s)![0];
    const runs = [...title.matchAll(/<a:r>(.*?)<\/a:r>/gs)];
    const native = runs.flatMap(run => [...run[1].match(/<a:t>(.*?)<\/a:t>/s)![1]].map(text => ({
      text, size: Number(run[1].match(/\bsz="(\d+)"/)![1]) / 100,
      color: run[1].match(/<a:srgbClr val="([0-9A-F]+)"/)![1],
    })));
    expect(native.map(c => c.text).join('')).toBe(expected.text);
    expect(native.map(c => c.size)).toEqual(expected.fontSizesPt);
    expect(native.map(c => c.color)).toEqual(expected.colors);
    const deck = await zip.file('ppt/presentation.xml')!.async('string');
    const slideWidthEmu = Number(deck.match(/<p:sldSz[^>]*\bcx="(\d+)"/)![1]);
    const bundle = await json(path.join(fixture, `canonical-${name}.json`));
    bundle.files.sourcePath = path.join(fixture, `${name}.pptx`);
    bundle.files.assets[0].path = path.resolve('tests/fixtures/fixed-courseware/page-1.wav');
    bundle.files.converter.manifestSha256 = sha256(await readFile(path.join(workerDirectory, 'manifest.json')));
    const input = adaptCanonicalSnapshot(bundle.project, bundle.snapshot, bundle.files);
    const build = await buildFixedCourseware(input, {
      outputDirectory: directory, workerDirectory,
    });
    // Historical build IDs include the old converter; verify today's bytes and the original formatting independently.
    expect(build.buildId).toBe(sha256(await readFile(path.join(build.directory, 'package.json'))));
    expect(await readFile(path.join(build.directory, 'source.pptx'))).toEqual(bytes);
    const payload = await json(path.join(build.directory, 'package.json'));
    const actual = characters(payload.pages[1].slide.elements[0].text.content);
    expect(actual.map(c => c.text).join('')).toBe(expected.text);
    expect(actual.map(c => c.color)).toEqual(expected.colors.map((c: string) => `#${c}`));
    actual.forEach((char, i) => {
      expect(char.size).toBe(Math.round(expected.fontSizesPt[i] * 12700 * 1_000_000 / slideWidthEmu) / 1000);
    });
    const original = await JSZip.loadAsync(await readFile(path.join(fixture, 'original.pptx')));
    // Office regenerates cNvPr IDs on save, including notes placeholders.
    const withoutNativeIds = (xml: string) => xml.replace(/(<p:cNvPr\b[^>]*\bid=")[^"]+("[^>]*>)/g, '$1$2');
    for (let i = 1; i <= 3; i++) {
      expect(withoutNativeIds(await zip.file(`ppt/notesSlides/notesSlide${i}.xml`)!.async('string')))
        .toBe(withoutNativeIds(await original.file(`ppt/notesSlides/notesSlide${i}.xml`)!.async('string')));
      const currentSlide = await zip.file(`ppt/slides/slide${i}.xml`)!.async('string');
      const originalSlide = await original.file(`ppt/slides/slide${i}.xml`)!.async('string');
      expect(currentSlide.match(/<a:xfrm\b.*?<\/a:xfrm>/gs))
        .toEqual(originalSlide.match(/<a:xfrm\b.*?<\/a:xfrm>/gs));
    }
    expect(build.report.visualFidelity).toBe('NOT_VERIFIED');
    expect(build.report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PPTX_NOTES_MASTER_UNVERIFIED' }),
    ]));
  }, 30_000);
}
