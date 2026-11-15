import JSZip from 'jszip';
import { crc32 } from 'node:zlib';
import { SaxesParser } from 'saxes';
import { describe, expect, it } from 'vitest';
import { kindergartenEditableSceneSchema } from '../../kindergarten/image2-pptist/contracts';

import {
  compileSceneToPptx,
  compileScenesToPptx,
} from '../../kindergarten/scene-to-pptx';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64',
);
const assets = { master: png, clean: png, picture: png };
const scenes = ['first', 'second', 'third'].map((slideId, index) => ({
  version: 1,
  slideId,
  sourceHash: `sha256:${slideId}`,
  canvas: { width: 1280, height: 800 },
  visualMasterAssetId: 'master',
  cleanPlateAssetId: 'clean',
  elements: [
    {
      id: 'title', // Object identity is local to a slide.
      type: 'native_text',
      bboxPx: [80, 80, 1000, 160],
      zIndex: 1,
      content: `Scene ${index + 1} < ${slideId}`,
      style: { fontFace: 'Arial', fontSizePt: 32, color: '#173B65', fontWeight: 500 },
    },
    {
      id: 'picture',
      type: 'image_layer',
      assetId: 'picture',
      layerRoute: 'A1',
      bboxPx: [80, 300, 200, 200],
      zIndex: 0,
    },
  ],
}));

async function slideXml(pptx: Uint8Array, page: number) {
  return (await JSZip.loadAsync(pptx)).file(`ppt/slides/slide${page}.xml`)!.async('string');
}

describe('resolved scene deck compiler', () => {
  it('binds each semantic object to the actual exported shape ID on its own page', async () => {
    const input = structuredClone(scenes);
    for (const scene of input) {
      Object.assign(scene.elements[1], {
        semanticRole: 'apple',
        spokenAliases: ['apple', '苹果'],
        animationPolicy: 'emphasize_on_repeat',
        objectKind: 'prop',
      });
    }
    const result = await compileScenesToPptx(input, assets);
    for (let index = 0; index < input.length; index++) {
      const actualObjects = new Map<string, string>();
      const parser = new SaxesParser({ xmlns: true });
      parser.on('opentag', (tag) => {
        if (tag.uri === 'http://schemas.openxmlformats.org/presentationml/2006/main' &&
            tag.local === 'cNvPr' && tag.attributes.name?.value)
          actualObjects.set(tag.attributes.name.value, tag.attributes.id.value);
      });
      parser.write(await slideXml(result.pptx, index + 1)).close();
      const page = result.mapping.pages[index];
      expect(actualObjects.size).toBe(input[index].elements.length);
      expect(new Set(page.elements.map((element) => element.sourceShapeId)).size)
        .toBe(actualObjects.size);
      for (const element of page.elements) {
        expect(element.sourceShapeId).toBe(actualObjects.get(element.objectName));
        expect(element.sourceShapeId).toMatch(/^[1-9]\d*$/u);
      }
      expect(page.elements.find((element) => element.elementId === 'picture'))
        .toMatchObject({ semanticRole: 'apple', spokenAliases: ['apple', '苹果'],
          animationPolicy: 'emphasize_on_repeat', objectKind: 'prop' });
    }
  });

  it('exports ordered editable pages, local identities and warnings without teaching notes', async () => {
    const result = await compileScenesToPptx(scenes, assets);
    const zip = await JSZip.loadAsync(result.pptx);
    expect(
      Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)),
    ).toHaveLength(3);
    for (let index = 0; index < scenes.length; index++) {
      const xml = await slideXml(result.pptx, index + 1);
      expect(xml).toContain(`Scene ${index + 1} &lt; ${scenes[index].slideId}`);
      expect(xml.match(/<p:sp>/g)).toHaveLength(1);
      expect(xml.match(/<p:pic>/g)).toHaveLength(1);
      expect(xml).toContain('sz="3200"');
      expect(xml).toContain('<a:off x="731520" y="731520"/>');
      expect(xml).not.toContain('<p:timing');
      expect(result.mapping.pages[index]).toMatchObject({
        slideId: scenes[index].slideId,
        sourceHash: scenes[index].sourceHash,
        slidePart: `ppt/slides/slide${index + 1}.xml`,
        elements: [{ elementId: 'picture' }, { elementId: 'title' }],
      });
      expect(xml).not.toContain(scenes[(index + 1) % 3].slideId);
    }
    expect(result.warnings).toEqual(
      scenes.map((scene) => ({
        slideId: scene.slideId,
        elementId: 'title',
        feature: 'font-weight-mapped-to-regular-or-bold',
      })),
    );
    for (const file of Object.values(zip.files).filter(
      (file) => /^ppt\/media\//.test(file.name) && !file.dir,
    ))
      expect(await file.async('nodebuffer')).toEqual(png);
    for (const file of Object.values(zip.files).filter((file) =>
      /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(file.name),
    ))
      expect(await file.async('string')).not.toContain('Scene ');
  });

  it('keeps the single-page mapping, warning shape, units and slide content compatible', async () => {
    const deck = await compileScenesToPptx([scenes[0]], assets);
    const single = await compileSceneToPptx(scenes[0], assets);
    expect(single.mapping).toEqual(deck.mapping.pages[0]);
    expect(single.warnings).toEqual([
      { elementId: 'title', feature: 'font-weight-mapped-to-regular-or-bold' },
    ]);
    expect(single.units).toEqual(deck.units);
    expect(await slideXml(single.pptx, 1)).toEqual(await slideXml(deck.pptx, 1));
  });

  it.each([[], Array.from({ length: 101 }, (_, index) => ({ ...scenes[0], slideId: `${index}` }))])(
    'rejects empty or excessive decks before export',
    async (input) => {
      await expect(compileScenesToPptx(input, assets)).rejects.toThrow();
    },
  );

  it('rejects duplicate page identities while allowing the same local object names', async () => {
    await expect(compileScenesToPptx([scenes[0], scenes[0]], assets)).rejects.toThrow(
      'unique slide IDs',
    );
  });

  it('rejects invalid later-page geometry and missing or corrupt later-page assets', async () => {
    const invalid = structuredClone(scenes);
    invalid[2].elements[0].bboxPx = [1200, 0, 200, 100];
    await expect(compileScenesToPptx(invalid, assets)).rejects.toThrow('exceeds');
    const missing = structuredClone(scenes);
    Object.assign(missing[2].elements[1], { assetId: 'later' });
    await expect(compileScenesToPptx(missing, assets)).rejects.toThrow(
      'Missing scene asset: later',
    );
    await expect(
      compileScenesToPptx(missing, { ...assets, later: png.subarray(0, 40) }),
    ).rejects.toThrow('Invalid scene PNG: later');
  });

  it('compiles a deck whose referenced assets exceed the former 32 MiB ceiling', async () => {
    const input = structuredClone(scenes);
    Object.assign(input[1].elements[1], { assetId: 'later' });
    const data = Buffer.alloc(17 * 1024 * 1024, 65);
    const type = Buffer.from('tEXt');
    const chunk = Buffer.alloc(data.length + 12);
    chunk.writeUInt32BE(data.length);
    type.copy(chunk, 4);
    data.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(Buffer.concat([type, data])), 8 + data.length);
    const large = Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
    await expect(
      compileScenesToPptx(input, { ...assets, picture: large, later: large }),
    ).resolves.toHaveProperty('pptx');
  });

  it('owns later-page descriptions and all image bytes before the first await', async () => {
    const input = structuredClone(scenes);
    const supplied = Object.fromEntries(
      Object.entries(assets).map(([id, value]) => [id, Buffer.from(value)]),
    );
    const pending = compileScenesToPptx(input, supplied);
    Object.assign(input[2], { slideId: 'substituted', sourceHash: 'substituted' });
    Object.assign(input[2].elements[0], { content: 'substituted' });
    input.reverse();
    for (const bytes of Object.values(supplied)) bytes.fill(0);
    supplied.clean = Buffer.from('substituted');
    const result = await pending;
    expect(result.mapping.pages.map((page) => page.slideId)).toEqual(['first', 'second', 'third']);
    expect(await slideXml(result.pptx, 3)).toContain('Scene 3 &lt; third');
    const zip = await JSZip.loadAsync(result.pptx);
    for (const file of Object.values(zip.files).filter(
      (file) => /^ppt\/media\//.test(file.name) && !file.dir,
    ))
      expect(await file.async('nodebuffer')).toEqual(png);
  });

  it('accepts the 100-page boundary with reused assets and distinct page mappings', async () => {
    const input = Array.from({ length: 100 }, (_, index) => ({
      ...scenes[0],
      slideId: `page-${index + 1}`,
    }));
    const result = await compileScenesToPptx(input, assets);
    expect(result.mapping.pages).toHaveLength(100);
    expect(result.mapping.pages[99].slidePart).toBe('ppt/slides/slide100.xml');
    expect(await slideXml(result.pptx, 100)).toContain('Scene 1 &lt; first');
  });
});

it.each([
  [12192000, 6858000],
  [9144000, 6858000],
])('exports native geometry and cropped images at canvas %i × %i EMU', async (cx, cy) => {
  const canvas = { width: cx / 9144, height: cy / 9144 };
  const input = structuredClone(scenes);
  for (const scene of input) {
    scene.canvas = canvas;
    scene.elements[0].bboxPx = [50, 80, 900, 160];
    Object.assign(scene.elements[1], {
      crop: [
        [10, 20],
        [90, 80],
      ],
    });
  }
  // Wider PPTX support must not widen legacy Image2/PPTist authoring.
  expect(kindergartenEditableSceneSchema.safeParse(input[0]).success).toBe(false);
  const result = await compileScenesToPptx(input, assets);
  const zip = await JSZip.loadAsync(result.pptx);
  expect(await zip.file('ppt/presentation.xml')!.async('string')).toContain(
    `cx="${cx}" cy="${cy}"`,
  );
  for (let page = 1; page <= 3; page++) {
    const xml = await slideXml(result.pptx, page);
    expect(xml).toContain('<a:off x="457200" y="731520"/>');
    expect(xml).toContain('<a:ext cx="8229600" cy="1463040"/>');
    expect(xml).toContain('<a:srcRect l="10000" r="10000" t="20000" b="20000"/>');
    expect(xml).toContain('sz="3200"');
  }
});

it('rejects mixed page canvases instead of rescaling one page into another', async () => {
  const input = structuredClone(scenes);
  input[1].canvas = { width: 1333.3333333333333, height: 750 };
  await expect(compileScenesToPptx(input, {})).rejects.toThrow('one shared canvas');
});

it.each([0, 99, 4097, Infinity, NaN])('rejects out-of-budget scene canvas %s', async (width) => {
  await expect(
    compileSceneToPptx({ ...scenes[0], canvas: { width, height: 800 } }, assets),
  ).rejects.toThrow();
});
