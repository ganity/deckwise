import JSZip from 'jszip';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { compileSceneToPptx } from '../../kindergarten/scene-to-pptx';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64',
);
const assets = { master: png, clean: png, apple: png };
const scene = {
  version: 1,
  slideId: 'slide_apple',
  canvas: { width: 1280, height: 800 },
  visualMasterAssetId: 'master',
  cleanPlateAssetId: 'clean',
  sourceHash: 'sha256:fixture',
  elements: [
    {
      id: 'apple',
      type: 'image_layer',
      assetId: 'apple',
      layerRoute: 'A1',
      bboxPx: [100, 160, 320, 320],
      zIndex: 2,
      semanticRole: 'apple',
      spokenAliases: ['apple', '苹果'],
      animationPolicy: 'appear_on_first_mention',
    },
    {
      id: 'title',
      type: 'native_text',
      bboxPx: [100, 40, 800, 100],
      zIndex: 1,
      content: 'Apple < 苹果',
      style: {
        fontFace: 'Arial',
        fontSizePt: 30,
        fontWeight: 700,
        color: '#1F2937',
        align: 'center',
        strokeColor: '#FFFFFF',
        strokeWidthPx: 6,
        shadow: { color: '#00000066', blurPx: 8, offsetX: 0, offsetY: 4 },
      },
    },
    {
      id: 'badge',
      type: 'native_shape',
      bboxPx: [960, 80, 160, 80],
      zIndex: 1,
      shape: 'rounded_rectangle',
      fill: '#FFD166',
    },
    {
      id: 'connector',
      type: 'connector',
      bboxPx: [420, 300, 200, 80],
      zIndex: 3,
      color: '#1F2937',
      lineWidth: 4,
      endArrow: true,
    },
  ],
};

describe('scene to native PPTX prototype', () => {
  it('exports four independently editable objects, correct units and the clean background', async () => {
    const result = await compileSceneToPptx(scene, assets);
    const zip = await JSZip.loadAsync(result.pptx);
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    const presentation = await zip.file('ppt/presentation.xml')!.async('string');
    expect(presentation).toContain('cx="11704320" cy="7315200"');
    expect(xml.match(/<p:sp>/g)).toHaveLength(3);
    expect(xml.match(/<p:pic>/g)).toHaveLength(1);
    expect(xml).toContain('<p:bg>');
    expect(xml).toContain('Apple &lt; 苹果');
    expect(xml).toContain('sz="3000"');
    expect(xml).toContain('<a:off x="914400" y="365760"/>');
    expect(xml).toContain('<a:prstGeom prst="roundRect">');
    expect(xml).toContain('<a:prstGeom prst="line">');
    expect(xml).toContain('<a:ln w="36576">');
    expect(xml).toContain('<a:tailEnd type="triangle"');
    expect(xml).not.toContain('<p:timing');
    expect(result.mapping.elements.map((entry) => entry.elementId)).toEqual([
      'title',
      'badge',
      'apple',
      'connector',
    ]);
    expect(result.mapping.elements[2]).toMatchObject({
      semanticRole: 'apple',
      spokenAliases: ['apple', '苹果'],
      animationPolicy: 'appear_on_first_mention',
    });
    expect(xml).toMatch(
      /<a:rPr\b[^>]*><a:ln w="54864"><a:solidFill><a:srgbClr val="FFFFFF"\/><\/a:solidFill><\/a:ln>/,
    );
    expect(xml).toMatch(
      /<a:outerShdw\b[^>]*blurRad="73152"[^>]*dist="36576"[^>]*dir="5400000">\s*<a:srgbClr val="000000">\s*<a:alpha val="40000"/,
    );
    expect(result.warnings).toEqual([]);
  });

  it.each([
    {
      x: 0,
      y: 4,
      blur: 8,
      color: '#00000066',
      opacity: 1,
      dir: 5400000,
      dist: 36576,
      alpha: 40000,
    },
    {
      x: -3,
      y: 4,
      blur: 2.5,
      color: 'rgba(255, 209, 102, 0.8)',
      opacity: 0.5,
      dir: 7620000,
      dist: 45720,
      alpha: 40000,
    },
    {
      x: -4,
      y: 0,
      blur: 1,
      color: '#123456',
      opacity: 1,
      dir: 10800000,
      dist: 36576,
      alpha: 100000,
    },
    {
      x: 0,
      y: -4,
      blur: 64,
      color: '#123456',
      opacity: 1,
      dir: 16200000,
      dist: 36576,
      alpha: 100000,
    },
    {
      x: 3,
      y: -3,
      blur: 8,
      color: '#123456',
      opacity: 1,
      dir: 18900000,
      dist: 38795,
      alpha: 100000,
    },
  ])(
    'exports native text outer shadow with point units and combined opacity: %j',
    async ({ x, y, blur, color, opacity, dir, dist, alpha }) => {
      const result = await compileSceneToPptx(
        {
          ...scene,
          elements: [
            {
              ...scene.elements[1],
              opacity,
              style: {
                ...scene.elements[1].style,
                strokeWidthPx: 0,
                shadow: { color, blurPx: blur, offsetX: x, offsetY: y },
              },
            },
          ],
        },
        assets,
      );
      const xml = await (await JSZip.loadAsync(result.pptx))
        .file('ppt/slides/slide1.xml')!
        .async('string');
      const shadow = xml.match(/<a:outerShdw\b[^>]*>[\s\S]*?<\/a:outerShdw>/g);
      expect(shadow).toHaveLength(1);
      expect(shadow![0]).toContain(`blurRad="${Math.round(blur * 0.72 * 12700)}"`);
      expect(shadow![0]).toContain(`dist="${dist}"`);
      expect(shadow![0]).toContain(`dir="${dir}"`);
      expect(shadow![0]).toContain(`val="${alpha}"`);
      expect(shadow![0]).toContain(
        `val="${color.includes('255') ? 'ffd166' : color === '#00000066' ? '000000' : '123456'}"`,
      );
      expect(result.warnings).toEqual([]);
    },
  );

  it.each([
    { blurPx: 0, offsetX: 0, offsetY: 4 },
    { blurPx: 8, offsetX: 0, offsetY: 0 },
    { blurPx: 8, offsetX: 4, offsetY: 0 },
    { blurPx: 8, offsetX: 4, offsetY: -0.001 },
  ])(
    'reports shadow values the native exporter would replace with defaults: %j',
    async (shadow) => {
      const result = await compileSceneToPptx(
        {
          ...scene,
          elements: [
            {
              ...scene.elements[1],
              style: { ...scene.elements[1].style, shadow: { ...shadow, color: '#000000' } },
            },
          ],
        },
        assets,
      );
      const xml = await (await JSZip.loadAsync(result.pptx))
        .file('ppt/slides/slide1.xml')!
        .async('string');
      expect(xml).not.toContain('<a:outerShdw');
      expect(result.warnings).toEqual([
        { elementId: 'title', feature: 'text-shadow-not-exported' },
      ]);
    },
  );

  it.each([
    { color: '#00000000', opacity: 1 },
    { color: '#000000', opacity: 0 },
  ])(
    'omits invisible shadows without substituting a visible default: %j',
    async ({ color, opacity }) => {
      const result = await compileSceneToPptx(
        {
          ...scene,
          elements: [
            {
              ...scene.elements[1],
              opacity,
              style: {
                ...scene.elements[1].style,
                strokeWidthPx: 0,
                shadow: { color, blurPx: 8, offsetX: 0, offsetY: 4 },
              },
            },
          ],
        },
        assets,
      );
      const xml = await (await JSZip.loadAsync(result.pptx))
        .file('ppt/slides/slide1.xml')!
        .async('string');
      expect(xml).not.toContain('<a:outerShdw');
      expect(result.warnings).toEqual([]);
    },
  );

  it('rejects invalid shadow colors before exporting', async () => {
    await expect(
      compileSceneToPptx(
        {
          ...scene,
          elements: [
            {
              ...scene.elements[1],
              style: {
                ...scene.elements[1].style,
                shadow: { color: 'not-a-color', blurPx: 8, offsetX: 0, offsetY: 4 },
              },
            },
          ],
        },
        assets,
      ),
    ).rejects.toThrow('Invalid scene color');
  });

  it.each([
    { color: 'rgb(255, 209, 102)', width: 2.5, opacity: 1, exported: 'FFD166', emu: 22860 },
    { color: undefined, width: 0.25, opacity: 1, exported: '1F2937', emu: 2286 },
    { color: '#ffffff', width: 32, opacity: 1, exported: 'FFFFFF', emu: 292608 },
    { color: '#ffffff', width: 0, opacity: 1, exported: undefined, emu: undefined },
    { color: '#ffffff80', width: 6, opacity: 1, exported: undefined, emu: undefined },
    { color: '#ffffff', width: 6, opacity: 0.5, exported: undefined, emu: undefined },
  ])(
    'exports only opaque positive text outlines: %j',
    async ({ color, width, opacity, exported, emu }) => {
      const result = await compileSceneToPptx(
        {
          ...scene,
          elements: [
            {
              ...scene.elements[1],
              opacity,
              style: {
                ...scene.elements[1].style,
                strokeColor: color,
                strokeWidthPx: width,
                shadow: undefined,
              },
            },
          ],
        },
        assets,
      );
      const xml = await (await JSZip.loadAsync(result.pptx))
        .file('ppt/slides/slide1.xml')!
        .async('string');
      const run = xml.match(/<a:rPr\b[^>]*>([\s\S]*?)<\/a:rPr>/)![1];
      if (exported) {
        expect(run).toContain(
          `<a:ln w="${emu}"><a:solidFill><a:srgbClr val="${exported}"/></a:solidFill></a:ln>`,
        );
        expect(run).toContain('<a:solidFill><a:srgbClr val="1F2937"/></a:solidFill>');
      } else expect(run).not.toContain('<a:ln');
      expect(result.warnings).toEqual(
        width > 0 && !exported ? [{ elementId: 'title', feature: 'text-stroke-not-exported' }] : [],
      );
    },
  );

  it('rejects an invalid requested outline color', async () => {
    await expect(
      compileSceneToPptx(
        {
          ...scene,
          elements: [
            {
              ...scene.elements[1],
              style: {
                ...scene.elements[1].style,
                strokeColor: 'not-a-color',
              },
            },
          ],
        },
        assets,
      ),
    ).rejects.toThrow('Invalid scene color');
  });

  it.each([undefined, 0.75, 1, 1.5, 3])(
    'exports multiline text with native relative line height %s',
    async (lineHeight) => {
      const result = await compileSceneToPptx(
        {
          ...scene,
          elements: [
            {
              ...scene.elements[1],
              content: 'First line\n第二行',
              style: { ...scene.elements[1].style, lineHeight },
            },
          ],
        },
        assets,
      );
      const zip = await JSZip.loadAsync(result.pptx);
      const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
      expect(xml.match(/<a:spcPct val="\d+"\/>/g)).toEqual(
        Array(2).fill(`<a:spcPct val="${Math.round((lineHeight ?? 1.2) * 100000)}"/>`),
      );
      expect(xml).not.toContain('<a:spcPts');
      expect(xml).toContain('First line');
      expect(xml).toContain('第二行');
      expect(
        result.warnings.some((warning) => warning.feature === 'text-line-height-not-exported'),
      ).toBe(false);
    },
  );

  it('rejects missing and non-PNG assets instead of flattening the page', async () => {
    await expect(compileSceneToPptx(scene, { master: png, clean: png })).rejects.toThrow(
      'Missing scene asset: apple',
    );
    await expect(
      compileSceneToPptx(scene, { ...assets, apple: Buffer.from('https://asset.test/image.png') }),
    ).rejects.toThrow('requires PNG bytes');
  });

  it.each(['master', 'clean', 'apple'])('rejects corrupt PNG %s before export', async (id) => {
    for (const bad of [
      png.subarray(0, 40),
      png.subarray(0, -12),
      Buffer.concat([png, Buffer.from('trailing payload')]),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==',
        'base64',
      ),
    ]) {
      await expect(compileSceneToPptx(scene, { ...assets, [id]: bad })).rejects.toThrow(
        `Invalid scene PNG: ${id}`,
      );
    }
  });

  it('rejects PNG dimensions beyond the existing 4096px image limit', async () => {
    const wide = await sharp({
      create: { width: 4097, height: 1, channels: 4, background: '#FF0000' },
    })
      .png()
      .toBuffer();
    await expect(compileSceneToPptx(scene, { ...assets, apple: wide })).rejects.toThrow(
      'Invalid scene PNG: apple',
    );
  });

  it('compiles a valid image above the former aggregate byte ceiling', async () => {
    const data = Buffer.alloc(32 * 1024 * 1024 + 1, 65);
    const type = Buffer.from('tEXt');
    const chunk = Buffer.alloc(data.length + 12);
    chunk.writeUInt32BE(data.length);
    type.copy(chunk, 4);
    data.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(Buffer.concat([type, data])), 8 + data.length);
    const largePng = Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);

    await expect(compileSceneToPptx(scene, { ...assets, apple: largePng })).resolves.toHaveProperty('pptx');
  });

  it('owns all referenced image bytes before asynchronous validation', async () => {
    const supplied = Object.fromEntries(
      Object.entries(assets).map(([id, bytes]) => [id, Buffer.from(bytes)]),
    );
    const pending = compileSceneToPptx(scene, supplied);
    for (const bytes of Object.values(supplied)) bytes.fill(0);
    supplied.clean = Buffer.from('replacement');
    const zip = await JSZip.loadAsync((await pending).pptx);
    const images = Object.values(zip.files).filter((file) =>
      /^ppt\/media\/.*\.png$/.test(file.name),
    );
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) expect(await image.async('nodebuffer')).toEqual(png);
  });

  it.each([
    [
      [10, 20],
      [70, 90],
    ],
    [
      [0, 0],
      [50, 100],
    ],
    [
      [0, 0],
      [100, 100],
    ],
    [
      [49, 49],
      [50, 50],
    ],
    [
      [99.999, 99.999],
      [100, 100],
    ],
    [
      [0.0004, 0.0004],
      [99.9996, 99.9996],
    ],
  ])('exports native source crop %j without changing the image box or bytes', async (a, b) => {
    const result = await compileSceneToPptx(
      {
        ...scene,
        elements: [
          {
            ...scene.elements[0],
            crop: [a, b],
            rotate: 15,
            opacity: 0.5,
          },
        ],
      },
      assets,
    );
    const zip = await JSZip.loadAsync(result.pptx);
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    expect(xml).toContain(
      `<a:srcRect l="${Math.round(a[0] * 1000)}" r="${100000 - Math.round(b[0] * 1000)}" t="${Math.round(a[1] * 1000)}" b="${100000 - Math.round(b[1] * 1000)}"/>`,
    );
    expect(xml).toContain('<a:off x="914400" y="1463040"/>');
    expect(xml).toContain('<a:ext cx="2926080" cy="2926080"/>');
    expect(xml).toContain('rot="900000"');
    expect(xml).toContain('<a:alphaModFix amt="50000"/>');
    const payloads = await Promise.all(
      Object.values(zip.files)
        .filter((f) => f.name.startsWith('ppt/media/') && !f.dir)
        .map((f) => f.async('nodebuffer')),
    );
    expect(payloads.length).toBeGreaterThan(0);
    expect(payloads.every((bytes) => bytes.equals(png))).toBe(true);
    expect(result.mapping.elements[0].objectName).toBe('apple');
    expect(result.warnings).toEqual([]);
  });

  it.each([
    [
      [20, 0],
      [20, 100],
    ],
    [
      [60, 0],
      [20, 100],
    ],
    [
      [-1, 0],
      [50, 100],
    ],
    [
      [0, 0],
      [101, 100],
    ],
    [
      [0, 0],
      [0.00000001, 100],
    ],
  ])('rejects invalid or natively unrepresentable crop %j', async (a, b) => {
    await expect(
      compileSceneToPptx({ ...scene, elements: [{ ...scene.elements[0], crop: [a, b] }] }, assets),
    ).rejects.toThrow();
  });

  it('rejects duplicated IDs, unsupported elements, invalid geometry and colors', async () => {
    const badFont = structuredClone(scene);
    Object.assign(badFont.elements[1].style!, { fontFace: 'bad"font' });
    await expect(compileSceneToPptx(badFont, assets)).rejects.toThrow(
      'Scene font contains unsafe XML',
    );
    const badText = structuredClone(scene);
    Object.assign(badText.elements[1], { content: 'bad\u0000text' });
    await expect(compileSceneToPptx(badText, assets)).rejects.toThrow(
      'Scene text contains unsafe XML',
    );
    await expect(
      compileSceneToPptx(
        { ...scene, elements: [{ ...scene.elements[0], id: 'bad"name' }] },
        assets,
      ),
    ).rejects.toThrow('unsafe XML characters');
    await expect(
      compileSceneToPptx({ ...scene, elements: [scene.elements[0], scene.elements[0]] }, assets),
    ).rejects.toThrow('duplicate element id');
    await expect(
      compileSceneToPptx({ ...scene, elements: [{ ...scene.elements[0], type: 'video' }] }, assets),
    ).rejects.toThrow();
    await expect(
      compileSceneToPptx(
        { ...scene, elements: [{ ...scene.elements[0], bboxPx: [1200, 0, 320, 320] }] },
        assets,
      ),
    ).rejects.toThrow('exceeds');
    await expect(
      compileSceneToPptx(
        { ...scene, elements: [{ ...scene.elements[2], fill: 'not-a-color' }] },
        assets,
      ),
    ).rejects.toThrow('Invalid scene color');
  });
});
