import PptxGen from '../../../vendor/pptxgenjs/index.cjs';
import type pptxgen from '../../../vendor/pptxgenjs/index.cjs';
import JSZip from 'jszip';
import { SaxesParser } from 'saxes';
import sharp from 'sharp';
import tinycolor from 'tinycolor2';
import { z } from 'zod';

import { editablePptxSceneSchema } from './image2-pptist/contracts';

const PIXELS_PER_INCH = 100;
const POINTS_PER_PIXEL = 72 / PIXELS_PER_INCH;
const UNSAFE_XML_ATTRIBUTE = /[<>&"'\u0000-\u001f]/u;

/** Resolved scene export only; no network, model call or source-file mutation. */
export async function compileScenesToPptx(
  input: unknown,
  assets: Readonly<Record<string, Uint8Array>>,
) {
  const scenes = z.array(editablePptxSceneSchema).min(1).max(100).parse(input);
  if (new Set(scenes.map((scene) => scene.slideId)).size !== scenes.length)
    throw new Error('Scene deck requires unique slide IDs');
  if (
    scenes.some(
      (scene) =>
        scene.canvas.width !== scenes[0].canvas.width ||
        scene.canvas.height !== scenes[0].canvas.height,
    )
  )
    throw new Error('Scene deck requires one shared canvas');
  const assetIds = new Set(
    scenes.flatMap((scene) => [
      scene.visualMasterAssetId,
      scene.cleanPlateAssetId,
      ...scene.elements.flatMap((element) =>
        element.type === 'image_layer' ? [element.assetId] : [],
      ),
    ]),
  );
  const images = new Map(
    [...assetIds].map((id) => {
      const bytes = assets[id];
      if (!bytes) throw new Error(`Missing scene asset: ${id}`);
      if (!Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
        throw new Error(`Scene prototype requires PNG bytes: ${id}`);
      }
      return [id, Buffer.from(bytes)] as const;
    }),
  );
  for (const [id, bytes] of images) {
    try {
      if (!bytes.subarray(-12).equals(Buffer.from('0000000049454e44ae426082', 'hex')))
        throw new Error('Missing PNG end chunk');
      const decoded = sharp(bytes, { failOn: 'warning', limitInputPixels: 4096 * 4096 });
      const metadata = await decoded.metadata();
      if (
        metadata.format !== 'png' ||
        !metadata.width ||
        !metadata.height ||
        metadata.width > 4096 ||
        metadata.height > 4096 ||
        (metadata.pages ?? 1) !== 1
      )
        throw new Error('Unsupported PNG dimensions or frames');
      await decoded.raw().toBuffer();
    } catch (cause) {
      throw new Error(`Invalid scene PNG: ${id}`, { cause });
    }
  }
  const deck = new PptxGen();
  deck.defineLayout({
    name: 'SCENE',
    width: scenes[0].canvas.width / PIXELS_PER_INCH,
    height: scenes[0].canvas.height / PIXELS_PER_INCH,
  });
  deck.layout = 'SCENE';
  const pages = scenes.map((scene, index) => appendScene(deck, scene, images, index + 1));
  const pptx = Buffer.from((await deck.write({ outputType: 'nodebuffer' })) as Buffer);
  const zip = await JSZip.loadAsync(pptx);
  const mapping = await Promise.all(pages.map(async ({ mapping }) => {
    const objects = new Map<string, string>();
    const ids = new Set<string>();
    const parser = new SaxesParser({ xmlns: true });
    parser.on('opentag', (tag) => {
      if (tag.uri !== 'http://schemas.openxmlformats.org/presentationml/2006/main' ||
          tag.local !== 'cNvPr') return;
      const id = tag.attributes.id?.value;
      const name = tag.attributes.name?.value;
      if (!id || !/^[1-9]\d*$/u.test(id) || ids.has(id) || (name && objects.has(name)))
        throw new Error(`Invalid exported scene object identity: ${mapping.slideId}`);
      ids.add(id);
      if (name) objects.set(name, id);
    });
    const file = zip.file(mapping.slidePart);
    if (!file) throw new Error(`Missing exported scene slide: ${mapping.slideId}`);
    parser.write(await file.async('string')).close();
    if (objects.size !== mapping.elements.length)
      throw new Error(`Exported scene object count differs: ${mapping.slideId}`);
    return { ...mapping, elements: mapping.elements.map((element) => {
      const sourceShapeId = objects.get(element.objectName);
      if (!sourceShapeId) throw new Error(`Missing exported scene object: ${element.elementId}`);
      return { ...element, sourceShapeId };
    }) };
  }));
  return {
    pptx,
    mapping: { pages: mapping },
    warnings: pages.flatMap((page) =>
      page.warnings.map((warning) => ({ slideId: page.mapping.slideId, ...warning })),
    ),
    units: { pixelsPerInch: PIXELS_PER_INCH, pointsPerPixel: POINTS_PER_PIXEL, fontSize: 'pt' },
  };
}

/** Preserve the single-page candidate compiler's original interface. */
export async function compileSceneToPptx(
  input: unknown,
  assets: Readonly<Record<string, Uint8Array>>,
) {
  const result = await compileScenesToPptx([input], assets);
  return {
    ...result,
    mapping: result.mapping.pages[0],
    warnings: result.warnings.map(({ elementId, feature }) => ({ elementId, feature })),
  };
}

function appendScene(
  deck: pptxgen,
  scene: z.infer<typeof editablePptxSceneSchema>,
  images: ReadonlyMap<string, Buffer>,
  slideNumber: number,
) {
  const warnings: Array<{ elementId: string; feature: string }> = [];
  const image = (id: string) => {
    return `data:image/png;base64,${images.get(id)!.toString('base64')}`;
  };
  const paint = (value: string, opacity = 1) => {
    const parsed = tinycolor(value);
    if (!parsed.isValid()) throw new Error(`Invalid scene color: ${value}`);
    return { color: parsed.toHex(), transparency: (1 - parsed.getAlpha() * opacity) * 100 };
  };

  const slide = deck.addSlide();
  slide.background = { data: image(scene.cleanPlateAssetId) };
  const elements = scene.elements
    .map((element, order) => ({ element, order }))
    .sort((a, b) => a.element.zIndex - b.element.zIndex || a.order - b.order);

  for (const { element } of elements) {
    if (UNSAFE_XML_ATTRIBUTE.test(element.id)) {
      throw new Error(`Scene object ID contains unsafe XML characters: ${element.id}`);
    }
    const [x, y, w, h] = element.bboxPx.map((value) => value / PIXELS_PER_INCH);
    const box = { x, y, w, h, objectName: element.id, rotate: element.rotate };
    const opacity = element.opacity ?? 1;
    switch (element.type) {
      case 'native_text': {
        const style = element.style;
        if (UNSAFE_XML_ATTRIBUTE.test(style.fontFace)) {
          throw new Error(`Scene font contains unsafe XML characters: ${element.id}`);
        }
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(element.content)) {
          throw new Error(`Scene text contains unsafe XML characters: ${element.id}`);
        }
        const strokeWidth = style.strokeWidthPx ?? 0;
        const stroke =
          strokeWidth > 0 ? paint(style.strokeColor ?? style.color, opacity) : undefined;
        if (stroke && stroke.transparency > 0)
          warnings.push({ elementId: element.id, feature: 'text-stroke-not-exported' });
        let shadow: pptxgen.ShadowProps | undefined;
        if (style.shadow) {
          const effect = style.shadow;
          const color = paint(effect.color, opacity);
          const angle = Math.round(
            ((Math.atan2(effect.offsetY, effect.offsetX) * 180) / Math.PI + 360) % 360,
          );
          const offset = Math.hypot(effect.offsetX, effect.offsetY) * POINTS_PER_PIXEL;
          if (color.transparency < 100) {
            // shortcut: pptxgenjs replaces zero values with defaults; expand when its exporter supports them.
            if (effect.blurPx === 0 || offset === 0 || angle === 0 || angle === 360)
              warnings.push({ elementId: element.id, feature: 'text-shadow-not-exported' });
            else
              shadow = {
                type: 'outer',
                color: color.color,
                opacity: 1 - color.transparency / 100,
                blur: effect.blurPx * POINTS_PER_PIXEL,
                offset,
                angle,
              };
          }
        }
        if (style.fontWeight && ![400, 700].includes(style.fontWeight))
          warnings.push({
            elementId: element.id,
            feature: 'font-weight-mapped-to-regular-or-bold',
          });
        slide.addText(element.content, {
          ...box,
          // Keep multiline text as one native textbox through the trusted importer.
          isTextBox: true,
          ...paint(style.color, opacity),
          fontFace: style.fontFace,
          fontSize: style.fontSizePt,
          lineSpacingMultiple: style.lineHeight,
          shadow,
          outline:
            stroke?.transparency === 0
              ? { color: stroke.color, size: strokeWidth * POINTS_PER_PIXEL }
              : undefined,
          bold: (style.fontWeight ?? 400) >= 700,
          align: style.align,
          valign: 'top',
          margin: 0,
          breakLine: false,
        });
        break;
      }
      case 'image_layer': {
        const crop = element.crop?.flat().map((value) => Math.round(value * 1000));
        const [left, top, right, bottom] = crop ?? [0, 0, 100000, 100000];
        if (right <= left || bottom <= top)
          throw new Error(`Scene image crop is below native precision: ${element.id}`);
        // Percentage coordinates avoid the library's inches/EMU numeric heuristic.
        const sourceWidth = (w * 100000) / (right - left);
        const sourceHeight = (h * 100000) / (bottom - top);
        slide.addImage({
          ...box,
          ...(crop
            ? {
                w: `${(sourceWidth / (scene.canvas.width / PIXELS_PER_INCH)) * 100}%`,
                h: `${(sourceHeight / (scene.canvas.height / PIXELS_PER_INCH)) * 100}%`,
                sizing: {
                  type: 'crop',
                  w,
                  h,
                  x: `${((sourceWidth * left) / 100000 / (scene.canvas.width / PIXELS_PER_INCH)) * 100}%`,
                  y: `${((sourceHeight * top) / 100000 / (scene.canvas.height / PIXELS_PER_INCH)) * 100}%`,
                },
              }
            : {}),
          data: image(element.assetId),
          transparency: (1 - opacity) * 100,
        });
        break;
      }
      case 'native_shape': {
        const shapes = {
          rectangle: deck.ShapeType.rect,
          rounded_rectangle: deck.ShapeType.roundRect,
          ellipse: deck.ShapeType.ellipse,
          star_5: deck.ShapeType.star5,
        };
        slide.addShape(shapes[element.shape], {
          ...box,
          fill: paint(element.fill, opacity),
          line: element.line
            ? {
                ...paint(element.line, opacity),
                width: (element.lineWidth ?? 1) * POINTS_PER_PIXEL,
              }
            : { type: 'none' },
        });
        break;
      }
      case 'connector':
        slide.addShape(deck.ShapeType.line, {
          ...box,
          line: {
            ...paint(element.color, opacity),
            width: element.lineWidth * POINTS_PER_PIXEL,
            beginArrowType: element.startArrow ? 'triangle' : 'none',
            endArrowType: element.endArrow ? 'triangle' : 'none',
          },
        });
        break;
    }
  }

  return {
    mapping: {
      slideId: scene.slideId,
      sourceHash: scene.sourceHash,
      slidePart: `ppt/slides/slide${slideNumber}.xml`,
      // Names and shape IDs describe this export; Host reconciles later Office saves.
      elements: elements.map(({ element }) => ({
        elementId: element.id,
        objectName: element.id,
        type: element.type,
        semanticRole: element.semanticRole,
        spokenAliases: element.spokenAliases,
        animationPolicy: element.animationPolicy,
        objectKind: element.objectKind,
        actionDescription: element.actionDescription,
        observedSemanticRole: element.observedSemanticRole,
        identityMismatch: element.identityMismatch,
        ...(element.type === 'image_layer'
          ? { sourceText: element.sourceText, regenerationPrompt: element.regenerationPrompt }
          : {}),
      })),
    },
    warnings,
  };
}
