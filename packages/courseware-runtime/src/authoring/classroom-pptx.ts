import { randomUUID } from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import { quizPptxScene } from './quiz-pptx';
import { decodeHtmlEntities } from '../conversion/lib/import/narration/text-normalizer';
import { SaxesParser } from 'saxes';
import type JSZip from 'jszip';
import type { MaicClassroom } from '../maic-classroom';
import { editablePptxSceneSchema } from './kindergarten/image2-pptist/contracts';
import { compileSceneToPptx } from './kindergarten/scene-to-pptx';
import { pptxPackage as pkg } from './page-pptx-candidate';

type Scene = MaicClassroom['scenes'][number];
const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const plain = (html: string) => decodeHtmlEntities(html.replace(/<[^>]*>/gu, '')).replaceAll('\u00a0', ' ');
export const assessmentBackground = { id: 'deckwise-assessment-white', bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==', 'base64') };

/** Physical assessment pages project canonical content without adding a canvas to Quiz. */
export function assessmentPptxScene(scene: Scene, sourceHash: string, canvas: { width: number; height: number }) {
  if (scene.content.type === 'quiz') return quizPptxScene(scene, sourceHash, canvas, assessmentBackground.id);
  const interaction = scene.actions?.find(action => action.type === 'interaction_checkpoint' && action.checkpointKind === 'chapter_summary');
  if (scene.content.type !== 'slide') throw new Error('Unsupported assessment content');
  const slide = scene.content.canvas;
  const elements = slide.elements.map((element, index) => {
    if (element.type !== 'shape' && element.type !== 'text') throw new Error('Assessment page contains unsupported native content');
    const base = { id: element.id, bboxPx: [element.left, element.top, element.width, element.height], zIndex: index + 1 };
    if (element.type === 'shape') return { ...base, type: 'native_shape' as const, shape: 'rounded_rectangle', fill: element.fill || '#F6F8FC' };
    if (element.type !== 'text') throw new Error('Assessment page contains unsupported native content');
    const size = /font-size:\s*([\d.]+)px/u.exec(element.content);
    return { ...base, type: 'native_text' as const, content: plain(element.content) || '（请填写问题）',
      style: { fontFace: element.defaultFontName || 'Noto Sans SC', fontSizePt: Number(size?.[1] ?? 24) * .72,
        fontWeight: Number(/font-weight:\s*(\d+)/u.exec(element.content)?.[1] ?? 400),
        color: element.defaultColor || '#111827', align: 'left', lineHeight: element.lineHeight ?? 1.3 } };
  });
  if (!interaction) throw new Error('An independent checkpoint requires a chapter_summary action');
  return editablePptxSceneSchema.parse({ version: 1, slideId: scene.id, sourceHash, canvas,
    visualMasterAssetId: assessmentBackground.id, cleanPlateAssetId: assessmentBackground.id, elements });
}

/** Shared image normalization for file compilation and live native Quiz edits. */
export async function prepareAssessmentPage(scene: Scene, sourceHash: string, canvas: { width: number; height: number },
  readImage?: (src: string) => Promise<Uint8Array>) {
  const projected = assessmentPptxScene(scene, sourceHash, canvas);
  const assets: Record<string, Uint8Array> = { [assessmentBackground.id]: assessmentBackground.bytes };
  for (const element of projected.elements) {
    if (element.type !== 'image_layer') continue;
    if (!readImage) throw new Error('Quiz image resolver is unavailable');
    const bytes = await readImage(element.assetId);
    if (!bytes.length || bytes.length > 5 * 1024 * 1024) throw new Error('Quiz image exceeds 5 MiB');
    const png = sharp(bytes, { failOn: 'warning', limitInputPixels: 4096 * 4096 });
    const metadata = await png.metadata();
    if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) !== 1) throw new Error('Unsupported Quiz image');
    element.assetId = element.id;
    assets[element.assetId] = await png.resize({ width: Math.max(1, Math.min(2048, Math.round(element.bboxPx[2] * 2))),
      height: Math.max(1, Math.min(2048, Math.round(element.bboxPx[3] * 2))), fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } }).png().toBuffer();
  }
  return { projected, assets };
}

type Span = { local: string; uri: string; start: number; end: number; openEnd: number; closeStart: number; attrs: Record<string, string> };
function spans(xml: string): Span[] {
  // Validate limits and namespaces before considering positional replacements.
  pkg.nodes(xml);
  const parser = new SaxesParser({ xmlns: true }), stack: Span[] = [], result: Span[] = [];
  parser.on('opentag', tag => {
    const item = { local: tag.local, uri: tag.uri, start: xml.lastIndexOf('<', parser.position - 1), end: 0,
      openEnd: parser.position, closeStart: 0, attrs: Object.fromEntries(Object.values(tag.attributes).map(a => [a.local, a.value])) };
    stack.push(item); result.push(item);
  });
  parser.on('closetag', tag => {
    const item = stack.pop()!;
    item.end = parser.position;
    item.closeStart = tag.isSelfClosing ? item.openEnd : xml.lastIndexOf('</', parser.position - 1);
  });
  parser.write(xml).close(); return result;
}

/** Preserve text runs, geometry and all unrelated objects when writing a bound question. */
function updateQuestion(xml: string, names: string[], question: string): string {
  const all = spans(xml);
  const shapes = all.filter(node => node.uri === pkg.P && node.local === 'sp' &&
    all.some(child => child.start > node.start && child.end < node.end && child.local === 'cNvPr' && names.includes(child.attrs.name)));
  if (shapes.length !== 1) throw new Error('Checkpoint question text box changed; select its binding again');
  const texts = all.filter(node => node.uri === 'http://schemas.openxmlformats.org/drawingml/2006/main' && node.local === 't' &&
    node.start > shapes[0].start && node.end < shapes[0].end);
  if (!texts.length) throw new Error('Checkpoint question text box is empty');
  for (let i = texts.length - 1; i >= 0; i--) xml = xml.slice(0, texts[i].openEnd) + (i === 0 ? escape(question) : '') + xml.slice(texts[i].closeStart);
  return xml;
}

/** Reorder/copy existing slide parts verbatim; compile only new assessment pages. */
export async function syncClassroomPptx(input: {
  source: Uint8Array; sourceHash: string; previous: MaicClassroom; classroom: MaicClassroom;
  pages: Array<{ pageId: string; slidePart?: string; objects?: Array<{ id: string; objectName: string }> }>;
  readImage?(src: string): Promise<Uint8Array>;
  restoredPages?: Array<{ pageId: string; source: Uint8Array; index: number; scene: Scene; objects?: Array<{ id: string; objectName: string }> }>;
}) {
  const zip = await pkg.load(input.source), { slideParts, presentation } = await pkg.presentationSlides(zip);
  if (input.pages.length !== slideParts.length || input.pages.some((page, index) => page.slidePart !== undefined && page.slidePart !== slideParts[index]))
    throw new Error('Classroom PPT page mapping differs from the saved source');
  const size = presentation.find(node => node.uri === pkg.P && node.local === 'sldSz');
  const canvas = { width: Number(size?.attrs.cx) / 9144, height: Number(size?.attrs.cy) / 9144 };
  editablePptxSceneSchema.shape.canvas.parse(canvas);
  if (!input.classroom.scenes.length || input.classroom.scenes.length > 100) throw new Error('A PPT course requires 1–100 pages');
  let contentTypes = await pkg.xml(zip, '[Content_Types].xml');
  const originalRels = await pkg.xml(zip, 'ppt/_rels/presentation.xml.rels');
  const removeSpans = (xml: string, entries: Span[]) => entries.sort((a, b) => b.start - a.start).reduce((value, node) => value.slice(0, node.start) + value.slice(node.end), xml);
  let presentationRels = removeSpans(originalRels, spans(originalRels).filter(node => node.local === 'Relationship' && node.attrs.Type === `${pkg.R}/slide`)), sequence = 0;
  const newSlideIds: string[] = [], used = new Set<string>();
  const selectedParts: string[] = [];
  const outputPages: Array<{ sceneId: string; sourcePageId?: string; objectNames: string[]; animationUnchanged: boolean }> = [];
  const prefix = `dw-${randomUUID()}`;
  const relPath = (part: string) => path.posix.join(path.posix.dirname(part), '_rels', `${path.posix.basename(part)}.rels`);
  async function importSlide(from: JSZip, source: string): Promise<string> {
    const copied = new Map<string, string>();
    const copy = async (part: string): Promise<string> => {
      if (copied.has(part)) return copied.get(part)!;
      const target = `${path.posix.dirname(part)}/${prefix}-${++sequence}${path.posix.extname(part)}`;
      copied.set(part, target);
      const file = from.file(part); if (!file) throw new Error(`Missing slide dependency: ${part}`);
      zip.file(target, await file.async('uint8array'));
      const types = pkg.nodes(await pkg.xml(from, '[Content_Types].xml'));
      const override = types.find(node => node.local === 'Override' && node.attrs.PartName === `/${part}`);
      if (override) contentTypes = pkg.append(contentTypes, pkg.CT, 'Types', p => `<${p}Override PartName="/${target}" ContentType="${escape(override.attrs.ContentType)}"/>`);
      else {
        const ext = path.posix.extname(part).slice(1);
        const type = types.find(node => node.local === 'Default' && node.attrs.Extension === ext);
        if (!type) throw new Error('Missing dependency content type');
        if (!pkg.nodes(contentTypes).some(node => node.local === 'Default' && node.attrs.Extension === ext))
          contentTypes = pkg.append(contentTypes, pkg.CT, 'Types', p => `<${p}Default Extension="${ext}" ContentType="${escape(type.attrs.ContentType)}"/>`);
      }
      const relationships = from.file(relPath(part));
      if (relationships) {
        const rels = pkg.relationships(await relationships.async('string'));
        const entries = [];
        for (const rel of rels) {
          const dest = rel.TargetMode === 'External' ? rel.Target : path.posix.relative(path.posix.dirname(target), await copy(pkg.resolvePart(part, rel.Target)));
          entries.push(`<Relationship Id="${escape(rel.Id)}" Type="${escape(rel.Type)}" Target="${escape(dest)}"${rel.TargetMode ? ` TargetMode="${escape(rel.TargetMode)}"` : ''}/>`);
        }
        zip.file(relPath(target), `<Relationships xmlns="${pkg.REL}">${entries.join('')}</Relationships>`);
      }
      return target;
    };
    return copy(source);
  }
  async function compileAssessment(scene: Scene) {
    const { projected, assets } = await prepareAssessmentPage(scene, input.sourceHash, canvas, input.readImage);
    return compileSceneToPptx(projected, assets);
  }
  for (const scene of input.classroom.scenes) {
    const sourcePageId = typeof scene.metadata?.nativePageId === 'string' ? scene.metadata.nativePageId :
      typeof scene.metadata?.copiedFromNativePageId === 'string' ? scene.metadata.copiedFromNativePageId : undefined;
    const page = input.pages.find(item => item.pageId === sourcePageId);
    const restored = page ? undefined : input.restoredPages?.find(item => item.pageId === sourcePageId);
    let part: string, animationUnchanged = true;
    if (page || restored) {
      if (page) {
        part = page.slidePart ?? slideParts[input.pages.indexOf(page)];
        if (used.has(part) || scene.metadata?.copiedFromNativePageId) part = await importSlide(zip, part);
      } else {
        const archive = await pkg.load(restored!.source);
        part = await importSlide(archive, (await pkg.presentationSlides(archive)).slideParts[restored!.index]);
        animationUnchanged = false;
      }
      used.add(part);
      const checkpoint = scene.actions?.find(action => action.type === 'interaction_checkpoint' && action.checkpointKind === 'chapter_summary');
      const oldScene = restored?.scene ?? input.previous.scenes.find(item => item.id === scene.id || item.metadata?.nativePageId === sourcePageId);
      const old = oldScene?.actions?.find(action => action.type === 'interaction_checkpoint' && action.checkpointKind === 'chapter_summary');
      if (checkpoint?.type === 'interaction_checkpoint' && checkpoint.checkpointKind === 'chapter_summary' &&
          old?.type === 'interaction_checkpoint' && old.checkpointKind === 'chapter_summary' && checkpoint.question !== old.question) {
        const elementId = typeof scene.metadata?.nativeQuestionElementId === 'string' ? scene.metadata.nativeQuestionElementId : `${oldScene!.id}_question`;
        const name = (page ?? restored)!.objects?.find(object => object.id === elementId)?.objectName;
        zip.file(part, updateQuestion(await pkg.xml(zip, part), [elementId, ...(name ? [name] : [])], checkpoint.question));
      }
      // Regenerate the fixed Quiz layout from canonical content, including option/image-only changes.
      if (scene.content.type === 'quiz' && (scene.title !== oldScene?.title || JSON.stringify(scene.content) !== JSON.stringify(oldScene?.content))) {
        const compiled = await compileAssessment(scene);
        part = await importSlide(await pkg.load(compiled.pptx), 'ppt/slides/slide1.xml'); animationUnchanged = false;
      }
    } else {
      const compiled = await compileAssessment(scene);
      part = await importSlide(await pkg.load(compiled.pptx), 'ppt/slides/slide1.xml'); animationUnchanged = false;
    }
    const relId = `${prefix}-${outputPages.length}`;
    selectedParts.push(part);
    presentationRels = pkg.append(presentationRels, pkg.REL, 'Relationships', p => `<${p}Relationship Id="${relId}" Type="${pkg.R}/slide" Target="slides/slide${outputPages.length + 1}.xml"/>`);
    newSlideIds.push(`<p:sldId id="${256 + outputPages.length}" r:id="${relId}"/>`);
    outputPages.push({ sceneId: scene.id, ...(page ? { sourcePageId: page.pageId } : {}),
      objectNames: pkg.nodes(await pkg.xml(zip, part)).filter(node => node.local === 'cNvPr').map(node => node.attrs.name).filter(Boolean), animationUnchanged });
  }
  const sourcePresentation = await pkg.xml(zip, 'ppt/presentation.xml');
  const list = spans(sourcePresentation).find(node => node.uri === pkg.P && node.local === 'sldIdLst');
  if (!list) throw new Error('Presentation slide order is missing');
  zip.file('ppt/presentation.xml', sourcePresentation.slice(0, list.start) + `<p:sldIdLst xmlns:p="${pkg.P}" xmlns:r="${pkg.R}">${newSlideIds.join('')}</p:sldIdLst>` + sourcePresentation.slice(list.end));
  zip.file('ppt/_rels/presentation.xml.rels', presentationRels);
  // Office and the MAIC importer both expect conventional slide parts. Snapshot before
  // renaming so reorder cannot overwrite another page; update notes' backlinks as well.
  const renamed = new Map(selectedParts.map((part, index) => [part, `ppt/slides/slide${index + 1}.xml`]));
  const contents = await Promise.all(selectedParts.map(async part => ({ part, xml: await pkg.xml(zip, part), rels: zip.file(relPath(part)) ? await pkg.xml(zip, relPath(part)) : undefined })));
  for (const file of Object.keys(zip.files).filter(file => /^ppt\/slides\/[^/]+\.xml$/u.test(file))) { zip.remove(file); zip.remove(relPath(file)); }
  for (const item of contents) { const dest = renamed.get(item.part)!; zip.file(dest, item.xml); if (item.rels) zip.file(relPath(dest), item.rels); }
  for (const file of Object.keys(zip.files).filter(file => file.endsWith('.rels') && file !== 'ppt/_rels/presentation.xml.rels')) {
    const owner = file.replace(/\/_rels\//u, '/').replace(/\.rels$/u, '');
    let rels = await pkg.xml(zip, file);
    for (const node of spans(rels).filter(node => node.local === 'Relationship' && node.attrs.TargetMode !== 'External').sort((a, b) => b.start - a.start)) {
      const destination = renamed.get(pkg.resolvePart(owner, node.attrs.Target));
      if (destination) rels = rels.slice(0, node.start) + rels.slice(node.start, node.end).replace(/Target="[^"]*"/u, `Target="${escape(path.posix.relative(path.posix.dirname(owner), destination))}"`) + rels.slice(node.end);
    }
    zip.file(file, rels);
  }
  contentTypes = removeSpans(contentTypes, spans(contentTypes).filter(node => node.local === 'Override' && node.attrs.ContentType === 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml'));
  for (const part of renamed.values()) contentTypes = pkg.append(contentTypes, pkg.CT, 'Types', p => `<${p}Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`);
  zip.file('[Content_Types].xml', contentTypes);
  return { pptx: await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }), pages: outputPages };
}
