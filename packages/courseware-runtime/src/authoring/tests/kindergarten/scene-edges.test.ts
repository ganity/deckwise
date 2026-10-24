import JSZip from 'jszip';
import { SaxesParser } from 'saxes';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { compileSceneToPptx } from '../../kindergarten/scene-to-pptx';

const namespaces = {
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
};
type XmlNode = {
  local: string;
  uri: string;
  attributes: Record<string, string>;
  children: XmlNode[];
  text: string;
};

function readXml(xml: string) {
  const root: XmlNode = { local: '', uri: '', attributes: {}, children: [], text: '' };
  const stack = [root];
  const parser = new SaxesParser({ xmlns: true });
  parser.on('opentag', (tag) => {
    const node: XmlNode = {
      local: tag.local,
      uri: tag.uri,
      attributes: Object.fromEntries(
        Object.entries(tag.attributes).map(([name, attribute]) => [name, attribute.value]),
      ),
      children: [],
      text: '',
    };
    stack.at(-1)!.children.push(node);
    stack.push(node);
  });
  parser.on('text', (text) => { stack.at(-1)!.text += text; });
  parser.on('closetag', () => { stack.pop(); });
  parser.write(xml).close();
  return root.children[0];
}

function at(node: XmlNode, ...path: string[]): XmlNode {
  for (const part of path) {
    const [prefix, local] = part.split(':');
    const next = node.children.find(
      (child) => child.local === local && child.uri === namespaces[prefix as keyof typeof namespaces],
    );
    if (!next) throw new Error(`Missing exported XML child: ${part}`);
    node = next;
  }
  return node;
}

function descendants(node: XmlNode, name: string): XmlNode[] {
  const [prefix, local] = name.split(':');
  return node.children.flatMap((child) => [
    ...(child.local === local && child.uri === namespaces[prefix as keyof typeof namespaces]
      ? [child] : []),
    ...descendants(child, name),
  ]);
}

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64',
);
const assets = { master: png, clean: png, foreground: png };
const scene = {
  version: 1,
  slideId: 'edges',
  sourceHash: 'sha256:compiler-edges',
  canvas: { width: 1280, height: 800 },
  visualMasterAssetId: 'master',
  cleanPlateAssetId: 'clean',
  elements: [
    { id: 'image', type: 'image_layer', assetId: 'foreground', layerRoute: 'A1',
      bboxPx: [100, 200, 320, 320], zIndex: 9 },
    { id: 'text', type: 'native_text', bboxPx: [80, 40, 1000, 100], zIndex: -3,
      content: '苹果 < apple & pear\n第二行',
      style: { fontFace: 'Noto Sans SC', fontSizePt: 30, color: '#123456' } },
    { id: 'shape', type: 'native_shape', bboxPx: [960, 80, 160, 80], zIndex: -3,
      shape: 'ellipse', fill: '#123456', line: '#123456', lineWidth: 2.5 },
    { id: 'connector', type: 'connector', bboxPx: [420, 300, 200, 80], zIndex: 0,
      color: '#123456', lineWidth: 2.5, startArrow: true, endArrow: true },
  ],
};

async function exported(input: unknown, supplied = assets) {
  const result = await compileSceneToPptx(input, supplied);
  const zip = await JSZip.loadAsync(result.pptx);
  const slide = readXml(await zip.file('ppt/slides/slide1.xml')!.async('string'));
  const objects = at(slide, 'p:cSld', 'p:spTree').children.filter(
    (node) => node.uri === namespaces.p && ['sp', 'pic'].includes(node.local),
  );
  return {
    result, zip, objects,
    byName: new Map(objects.map((node) => [descendants(node, 'p:cNvPr')[0].attributes.name, node])),
  };
}

describe('native scene compiler OOXML edges', () => {
  it('preserves fractional 16:10 geometry at both corners and stable mixed-object z order', async () => {
    const boxes = [
      [1279.5, 799.75, 0.5, 0.25], [0, 0, 0.5, 0.25],
      [100.25, 200.5, 160.75, 80.25], [420, 300, 200, 80],
    ];
    const { result, zip, objects, byName } = await exported({
      ...scene,
      elements: scene.elements.map((element, index) => ({
        ...element, bboxPx: boxes[index], rotate: [15, 0, 90, 270][index],
      })),
    });
    expect(at(readXml(await zip.file('ppt/presentation.xml')!.async('string')), 'p:sldSz')
      .attributes).toMatchObject({ cx: '11704320', cy: '7315200' });
    expect(objects.map((node) => descendants(node, 'p:cNvPr')[0].attributes.name))
      .toEqual(['text', 'shape', 'connector', 'image']);
    expect(result.mapping.elements.map((element) => element.elementId))
      .toEqual(['text', 'shape', 'connector', 'image']);
    const expected = [
      ['11699748', '7312914', '4572', '2286', '900000'],
      ['0', '0', '4572', '2286', undefined],
      ['916686', '1833372', '1469898', '733806', '5400000'],
      ['3840480', '2743200', '1828800', '731520', '16200000'],
    ];
    for (let index = 0; index < scene.elements.length; index++) {
      const node = byName.get(scene.elements[index].id)!;
      const transform = at(node, 'p:spPr', 'a:xfrm');
      const [x, y, cx, cy, rotation] = expected[index];
      expect(at(transform, 'a:off').attributes).toEqual({ x, y });
      expect(at(transform, 'a:ext').attributes).toEqual({ cx, cy });
      expect(transform.attributes.rot).toBe(rotation);
    }
    expect(result.warnings).toEqual([]);
  });

  it.each([0, 0.4, 1])('combines color alpha and object opacity %s for every editable kind', async (opacity) => {
    const { result, byName } = await exported({
      ...scene,
      elements: scene.elements.map((element) => ({
        ...element, opacity,
        ...(element.type === 'native_text'
          ? { style: { ...element.style, color: 'rgba(18, 52, 86, 0.5)' } } : {}),
        ...(element.type === 'native_shape'
          ? { fill: 'rgba(18, 52, 86, 0.5)', line: 'rgba(18, 52, 86, 0.75)' } : {}),
        ...(element.type === 'connector' ? { color: 'rgba(18, 52, 86, 0.5)' } : {}),
      })),
    });
    const fills = [
      descendants(byName.get('text')!, 'a:rPr').map((run) => at(run, 'a:solidFill', 'a:srgbClr')),
      [at(byName.get('shape')!, 'p:spPr', 'a:solidFill', 'a:srgbClr')],
      [at(byName.get('connector')!, 'p:spPr', 'a:ln', 'a:solidFill', 'a:srgbClr')],
    ].flat();
    expect(fills.length).toBeGreaterThanOrEqual(4);
    for (const fill of fills) {
      expect(fill.attributes.val.toLowerCase()).toBe('123456');
      expect(at(fill, 'a:alpha').attributes.val).toBe(String(opacity * 50000));
    }
    const line = at(byName.get('shape')!, 'p:spPr', 'a:ln');
    expect(line.attributes.w).toBe('22860');
    expect(at(line, 'a:solidFill', 'a:srgbClr', 'a:alpha').attributes.val)
      .toBe(String(opacity * 75000));
    const imageAlpha = descendants(byName.get('image')!, 'a:alphaModFix');
    expect(imageAlpha.map((node) => node.attributes.amt))
      .toEqual(opacity === 1 ? [] : [String(opacity * 100000)]);
    expect(result.warnings).toEqual([]);
  });

  it('keeps intrinsic PNG alpha and native crop without resampling the foreground', async () => {
    const pixels = Buffer.from([255, 0, 0, 0, 0, 255, 0, 64, 0, 0, 255, 128, 255, 255, 0, 255]);
    const foreground = await sharp(pixels, { raw: { width: 2, height: 2, channels: 4 } })
      .png().toBuffer();
    const { zip, byName } = await exported({
      ...scene,
      elements: [{ ...scene.elements[0], crop: [[12.5, 25], [75, 87.5]], opacity: 0.4 }],
    }, { ...assets, foreground });
    const image = byName.get('image')!;
    expect(at(image, 'p:blipFill', 'a:srcRect').attributes)
      .toEqual({ l: '12500', r: '25000', t: '25000', b: '12500' });
    const relationshipId = at(image, 'p:blipFill', 'a:blip').attributes['r:embed'];
    const relationships = readXml(await zip.file('ppt/slides/_rels/slide1.xml.rels')!.async('string'));
    const relationship = relationships.children.find((node) => node.attributes.Id === relationshipId)!;
    expect(relationship.attributes.Type).toBe(
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
    );
    const bytes = await zip.file(`ppt/${relationship.attributes.Target.replace('../', '')}`)!
      .async('nodebuffer');
    expect(bytes).toEqual(foreground);
    expect(await sharp(bytes).ensureAlpha().raw().toBuffer()).toEqual(pixels);
  });

  it.each([7.25, 30, 200])('retains %s pt and the requested Latin/East Asian/complex-script face', async (fontSizePt) => {
    const { result, byName } = await exported({
      ...scene,
      elements: [{ ...scene.elements[1],
        style: { ...scene.elements[1].style, fontSizePt, fontWeight: 700 } }],
    });
    const text = byName.get('text')!;
    const runs = descendants(text, 'a:rPr');
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      expect(run.attributes).toMatchObject({ sz: String(fontSizePt * 100), b: '1' });
      for (const name of ['a:latin', 'a:ea', 'a:cs'])
        expect(at(run, name).attributes.typeface).toBe('Noto Sans SC');
    }
    expect(descendants(text, 'a:t').map((node) => node.text))
      .toEqual(['苹果 < apple & pear', '第二行']);
    expect(result.warnings).toEqual([]);
  });
});
