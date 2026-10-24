import { randomUUID } from 'node:crypto';
import path from 'node:path';
import JSZip from 'jszip';
import { SaxesParser } from 'saxes';
import { z } from 'zod';
import { assertPptxZipWithinLimits } from '../conversion/lib/import/pptx/pptx-zip-package';
import { compileSceneToPptx } from './kindergarten/scene-to-pptx';
import { editablePptxSceneSchema } from './kindergarten/image2-pptist/contracts';
import { candidateHash, checkPageCandidateBaseline, pageCandidateBaselineSchema, PageCandidateError } from './page-candidate-baseline';
import { preservePageImages, inspectPageImageAssets, type PreservedPageImage } from './page-asset-locks';

const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
type Node = { name: string; local: string; uri: string; attrs: Record<string, string> };
function unsafe(message: string): never { throw new PageCandidateError('UNSAFE_PACKAGE', message); }
function nodes(xml: string): Node[] {
  if (Buffer.byteLength(xml) > 4 * 1024 * 1024 || /<!DOCTYPE/i.test(xml)) unsafe('Unsupported XML size or DOCTYPE');
  const result: Node[] = [];
  const parser = new SaxesParser({ xmlns: true });
  parser.on('error', (error) => unsafe(`Malformed package XML: ${error.message}`));
  parser.on('opentag', (node) => {
    if (result.length >= 50000) unsafe('Too many XML nodes');
    result.push({ name: node.name, local: node.local, uri: node.uri, attrs: Object.fromEntries(Object.values(node.attributes).map((attr) => [attr.uri ? `{${attr.uri}}${attr.local}` : attr.local, attr.value])) });
  });
  parser.write(xml).close();
  return result;
}
async function xml(zip: JSZip, part: string) {
  const file = zip.file(part);
  if (!file) unsafe(`Missing package part: ${part}`);
  return file.async('string');
}
function append(xml: string, uri: string, local: string, child: (prefix: string) => string) {
  const root = nodes(xml)[0];
  if (!root || root.uri !== uri || root.local !== local) unsafe(`Unexpected XML root: ${local}`);
  const close = `</${root.name}>`;
  const index = xml.lastIndexOf(close);
  if (index < 0) unsafe(`Empty or unclosed XML root: ${local}`);
  const prefix = root.name.includes(':') ? root.name.split(':')[0] + ':' : '';
  return xml.slice(0, index) + child(prefix) + xml.slice(index);
}
function relationships(xml: string) {
  const parsed = nodes(xml);
  if (parsed[0]?.uri !== REL || parsed[0].local !== 'Relationships') unsafe('Invalid relationships root');
  const found = parsed.slice(1).map((node) => {
    if (node.uri !== REL || node.local !== 'Relationship') unsafe('Unsupported relationship XML');
    const { Id, Target, Type, TargetMode } = node.attrs;
    if (!Id || !Target || !Type) unsafe('Incomplete relationship');
    return { Id, Target, Type, TargetMode };
  });
  if (new Set(found.map((rel) => rel.Id)).size !== found.length) unsafe('Duplicate relationship IDs');
  return found;
}
function resolvePart(from: string, target: string) {
  if (/[\\?#]/.test(target) || /%|^[a-z]+:/i.test(target)) unsafe('Unsupported package relationship target');
  return path.posix.resolve('/', path.posix.dirname(from), target).slice(1);
}
async function load(bytes: Uint8Array) {
  if (bytes.length > 64 * 1024 * 1024) unsafe('Candidate source exceeds 64 MiB');
  const zip = await JSZip.loadAsync(bytes);
  assertPptxZipWithinLimits(zip, 128 * 1024 * 1024);
  if (Object.keys(zip.files).some((name) => /(^_xmlsignatures\/|vbaProject\.bin$)/i.test(name))) unsafe('Signed or macro-enabled packages require separate handling');
  return zip;
}

async function presentationSlides(zip: JSZip) {
  const presentation = nodes(await xml(zip, 'ppt/presentation.xml'));
  if (presentation[0]?.uri !== P || presentation[0].local !== 'presentation')
    unsafe('Unsupported presentation namespace');
  const rels = relationships(await xml(zip, 'ppt/_rels/presentation.xml.rels'));
  const slideParts = presentation
    .filter((node) => node.uri === P && node.local === 'sldId')
    .map((node) => {
      const rel = rels.find((rel) => rel.Id === node.attrs[`{${R}}id`]);
      if (!rel || rel.TargetMode || rel.Type !== `${R}/slide`)
        unsafe('Invalid presentation slide relationship');
      return resolvePart('ppt/presentation.xml', rel.Target);
    });
  return { presentation, slideParts };
}

export interface PageFadeSourceInput {
  baseline: unknown;
  sourcePptx: Uint8Array;
  pageText: string;
  target: { pageId: string; slidePart: string };
  getCurrentBaseline: () => Promise<unknown>;
  signal?: AbortSignal;
}

async function prepareSource(input: PageFadeSourceInput) {
  const baseline = pageCandidateBaselineSchema.parse(input.baseline);
  const source = Buffer.from(input.sourcePptx);
  const target = { ...input.target };
  const pageText = z.string().max(32000).parse(input.pageText);
  if (
    candidateHash(source) !== baseline.sourceHash ||
    candidateHash(pageText) !== baseline.contentHash ||
    target.pageId !== baseline.pageId ||
    !/^ppt\/slides\/slide[1-9]\d*\.xml$/.test(target.slidePart)
  ) {
    throw new PageCandidateError(
      'INVALID_SOURCE',
      'Source hash or trusted logical page mapping does not match',
    );
  }
  await checkPageCandidateBaseline(baseline, input.getCurrentBaseline, input.signal);
  const zip = await load(source);
  const { presentation, slideParts } = await presentationSlides(zip);
  if (
    slideParts.filter((part) => part === target.slidePart).length !== 1 ||
    new Set(slideParts).size !== slideParts.length
  )
    unsafe('Target page is missing or ambiguous');
  const oldSlide = await xml(zip, target.slidePart);
  const root = nodes(oldSlide)[0];
  if (root?.uri !== P || root.local !== 'sld') unsafe('Unsupported target slide namespace');
  return { baseline, source, target, pageText, zip, presentation, slideParts, oldSlide };
}

/** Creates new bytes only. Never accepts an editable path or writes the source PPTX. */
export async function generatePagePptxCandidate(input: {
  preservedImages?: readonly PreservedPageImage[];
  baseline: unknown;
  sourcePptx: Uint8Array;
  pageText: string;
  instruction: string;
  target: { pageId: string; slidePart: string };
  getCurrentBaseline: () => Promise<unknown>;
  generate: (request: { pageId: string; sourceHash: string; pageText: string; instruction: string; canvas: { width: number; height: number }; schema: z.ZodType<z.infer<typeof editablePptxSceneSchema>> }, signal?: AbortSignal) => Promise<{ scene: unknown; assets: Readonly<Record<string, Uint8Array>> }>;
  signal?: AbortSignal;
}) {
  const { getCurrentBaseline, generate, signal } = input;
  const locks = structuredClone(input.preservedImages ?? []);
  const instruction = z.string().trim().min(1).max(8000).parse(input.instruction);
  const { baseline, source, target, pageText, zip, presentation } = await prepareSource(input);
  if (locks.length) {
    const pictures = await inspectPageImageAssets(source, target.slidePart);
    if (new Set(locks.map(lock => lock.objectId)).size !== locks.length || new Set(locks.map(lock => lock.zIndex)).size !== locks.length ||
        locks.some(lock => !pictures.some(image => image.eligible && image.sourceShapeId === lock.sourceShapeId &&
          image.assetSha256 === lock.assetSha256 && image.pictureSha256 === lock.pictureSha256 && image.zIndex === lock.zIndex)))
      unsafe('Locked image baseline changed');
  }
  const sizes = presentation.filter((node) => node.uri === P && node.local === 'sldSz');
  const size = sizes[0];
  if (sizes.length !== 1 || !/^[1-9]\d{0,8}$/.test(size.attrs.cx) || !/^[1-9]\d{0,8}$/.test(size.attrs.cy))
    unsafe('Candidate canvas requires one bounded positive integer EMU size');
  // Scene coordinates remain 100 px/in; never stretch a replacement to fit the source.
  const parsedCanvas = editablePptxSceneSchema.shape.canvas.safeParse({
    width: Number(size.attrs.cx) / 9144, height: Number(size.attrs.cy) / 9144,
  });
  if (!parsedCanvas.success) unsafe('Candidate canvas must be between 100 and 4096 pixels per side');
  const canvas = parsedCanvas.data;
  const schema = editablePptxSceneSchema.safeExtend({
    canvas: z.object({ width: z.literal(canvas.width), height: z.literal(canvas.height) }).strict(),
  });
  const relPart = `ppt/slides/_rels/${path.posix.basename(target.slidePart)}.rels`;
  let slideRelsXml = await xml(zip, relPart);
  const oldRels = relationships(slideRelsXml);
  signal?.throwIfAborted();
  const generated = await generate({ pageId: baseline.pageId, sourceHash: baseline.sourceHash, pageText, instruction, canvas: { ...canvas }, schema }, signal);
  signal?.throwIfAborted();
  const scene = schema.parse(generated.scene);
  if (scene.slideId !== baseline.pageId || scene.sourceHash !== baseline.sourceHash || scene.elements.length > 200 || Object.values(generated.assets).reduce((sum, bytes) => sum + bytes.length, 0) > 32 * 1024 * 1024) {
    throw new PageCandidateError('INVALID_OUTPUT', 'Scene identity or asset budget is invalid');
  }
  const compiled = await compileSceneToPptx(scene, generated.assets);
  signal?.throwIfAborted();
  const replacement = await load(compiled.pptx);
  const replacementSize = nodes(await xml(replacement, 'ppt/presentation.xml')).find((node) => node.uri === P && node.local === 'sldSz');
  if (!size || size.attrs.cx !== replacementSize?.attrs.cx || size.attrs.cy !== replacementSize.attrs.cy) unsafe('Candidate canvas must match the current presentation');
  let slide = await xml(replacement, 'ppt/slides/slide1.xml');
  const candidateId = randomUUID();
  const addedParts: string[] = [];
  const assetHashes: Record<string, string> = {};
  const generatedRels = relationships(await xml(replacement, 'ppt/slides/_rels/slide1.xml.rels'));
  const referencedIds = new Set(nodes(slide).flatMap((node) => Object.entries(node.attrs).filter(([key]) => key.startsWith(`{${R}}`)).map(([, value]) => value)));
  let index = 0;
  for (const id of referencedIds) {
    const rel = generatedRels.find((rel) => rel.Id === id);
    if (!rel || rel.Type !== `${R}/image` || rel.TargetMode) unsafe('Only locally compiled PNG relationships are supported');
    const imagePart = resolvePart('ppt/slides/slide1.xml', rel.Target);
    const image = replacement.file(imagePart);
    if (!image || !imagePart.endsWith('.png')) unsafe('Missing compiled PNG');
    const bytes = await image.async('nodebuffer');
    const name = `b-${candidateId}-${index++}.png`;
    const newPart = `ppt/media/${name}`;
    const newId = `rIdB${candidateId.replaceAll('-', '')}${index}`;
    if (zip.file(newPart) || oldRels.some((old) => old.Id === newId)) unsafe('Candidate relationship collision');
    zip.file(newPart, bytes);
    addedParts.push(newPart);
    assetHashes[newPart] = candidateHash(bytes);
    // The XML is compiler-owned; source XML is never modified by model text substitution.
    slide = slide.replaceAll(`r:embed="${id}"`, `r:embed="${newId}"`);
    slideRelsXml = append(slideRelsXml, REL, 'Relationships', (prefix) => `<${prefix}Relationship Id="${newId}" Type="${R}/image" Target="../media/${name}"/>`);
  }
  // Keep the original layout/notes relationships; hide inherited decorative master shapes.
  slide = slide.replace('<p:sld ', '<p:sld showMasterSp="0" ');
  const finalIds = new Set(relationships(slideRelsXml).map((rel) => rel.Id));
  for (const node of nodes(slide)) {
    for (const [key, value] of Object.entries(node.attrs)) {
      if (key.startsWith(`{${R}}`) && !finalIds.has(value)) unsafe('Unresolved compiled slide relationship');
    }
  }
  const retained = locks.length ? await preservePageImages(zip, target.slidePart, slide, locks) : undefined;
  if (retained) slide = retained.slide;
  zip.file(target.slidePart, slide);
  zip.file(relPart, slideRelsXml);
  const changedParts = [target.slidePart, relPart];
  let contentTypes = await xml(zip, '[Content_Types].xml');
  const pngType = nodes(contentTypes).find((node) => node.uri === CT && node.local === 'Default' && node.attrs.Extension?.toLowerCase() === 'png');
  if (pngType && pngType.attrs.ContentType !== 'image/png') unsafe('Unexpected PNG content type');
  if (!pngType) {
    contentTypes = append(contentTypes, CT, 'Types', (prefix) => `<${prefix}Default Extension="png" ContentType="image/png"/>`);
    zip.file('[Content_Types].xml', contentTypes);
    changedParts.push('[Content_Types].xml');
  }
  const pptx = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const resultZip = await load(pptx);
  const originalZip = await load(source);
  const preservedParts: Record<string, string> = {};
  for (const file of Object.values(originalZip.files)) {
    if (file.dir || changedParts.includes(file.name)) continue;
    const original = await file.async('nodebuffer');
    const kept = resultZip.file(file.name);
    if (!kept || candidateHash(await kept.async('nodebuffer')) !== candidateHash(original)) unsafe(`Non-target part changed: ${file.name}`);
    preservedParts[file.name] = candidateHash(original);
  }
  await checkPageCandidateBaseline(baseline, getCurrentBaseline, signal);
  return {
    version: 1 as const, candidateId, kind: 'page-pptx' as const, baseline, pptx, hash: candidateHash(pptx),
    scope: { pageIds: [baseline.pageId], slidePart: target.slidePart },
    report: { changedParts, addedParts, preservedParts, assetHashes, ...(retained ? { preservedImages: retained.preserved } : {}), warnings: [
      'Target page objects are rebuilt; original target animations/transitions are not retained. Advanced charts, masters and animation editing are unsupported.',
      'Original notes remain unchanged and are not authoritative teaching data. Review narration and object mapping before adoption.',
      ...compiled.warnings.map((warning) => `${warning.elementId}: ${warning.feature}`),
    ] },
    mapping: { ...compiled.mapping, slidePart: target.slidePart }, reviewState: 'needs-review' as const, applied: false as const,
  };
}

function fadeTransitionWindow(oldSlide: string) {
  const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
  const P14 = 'http://schemas.microsoft.com/office/powerpoint/2010/main';
  type TransitionNode = Node & { depth: number };
  const children: Array<
    TransitionNode & { start: number; end: number; descendants: TransitionNode[] }
  > = [];
  const parser = new SaxesParser({ xmlns: true });
  let depth = 0;
  let rootEnd = 0;
  parser.on('opentag', (node) => {
    const value = {
      name: node.name,
      local: node.local,
      uri: node.uri,
      depth,
      attrs: Object.fromEntries(
        Object.values(node.attributes)
          .filter((attr) => attr.uri !== 'http://www.w3.org/2000/xmlns/')
          .map((attr) => [attr.uri ? `{${attr.uri}}${attr.local}` : attr.local, attr.value]),
      ),
    };
    if (depth === 1)
      children.push({
        ...value,
        start: oldSlide.lastIndexOf('<', parser.position - 1),
        end: 0,
        descendants: [],
      });
    if (depth > 1) children[children.length - 1].descendants.push(value);
    depth++;
  });
  parser.on('closetag', () => {
    depth--;
    if (depth === 1) children[children.length - 1].end = parser.position;
    if (depth === 0) rootEnd = oldSlide.lastIndexOf('<', parser.position - 1);
  });
  parser.write(oldSlide).close();
  if (
    children.some(
      (child) =>
        !(
          child.uri === P &&
          ['cSld', 'clrMapOvr', 'transition', 'timing', 'extLst'].includes(child.local)
        ) && !(child.uri === MC && child.local === 'AlternateContent'),
    )
  ) {
    unsafe('Unsupported slide extension');
  }
  const transitions = children.filter((child) => child.local === 'transition' || child.uri === MC);
  if (transitions.length > 1) unsafe('Ambiguous slide transitions');
  const previous = transitions[0];
  if (previous) {
    const all = [previous, ...previous.descendants];
    for (const node of all) {
      const allowed =
        node.uri === P && node.local === 'transition'
          ? ['spd', 'advClick', `{${P14}}dur`]
          : node.uri === P && node.local === 'fade'
            ? ['thruBlk']
            : node.uri === MC && node.local === 'Choice'
              ? ['Requires']
              : [];
      if (
        Object.keys(node.attrs).some((key) => !allowed.includes(key)) ||
        (node.attrs.spd !== undefined && !['slow', 'med', 'fast'].includes(node.attrs.spd)) ||
        (node.attrs.advClick !== undefined && !['0', '1'].includes(node.attrs.advClick)) ||
        (node.attrs.thruBlk !== undefined && node.attrs.thruBlk !== '0') ||
        (node.attrs[`{${P14}}dur`] !== undefined && !/^\d{1,5}$/.test(node.attrs[`{${P14}}dur`]))
      ) {
        unsafe('Automatic advance, sound and extended fade options require separate review');
      }
    }
    const actual = all.map((node) => `${node.uri}|${node.local}|${node.depth}`).join(';');
    const plain = (fade: boolean) =>
      [`${P}|transition|1`, ...(fade ? [`${P}|fade|2`] : [])].join(';');
    const wrapped = (fade: boolean) =>
      [
        `${MC}|AlternateContent|1`,
        `${MC}|Choice|2`,
        `${P}|transition|3`,
        ...(fade ? [`${P}|fade|4`] : []),
        `${MC}|Fallback|2`,
        `${P}|transition|3`,
        ...(fade ? [`${P}|fade|4`] : []),
      ].join(';');
    if (![plain(false), plain(true), wrapped(false), wrapped(true)].includes(actual))
      unsafe('Only a simple fade or the verified Office empty/fade wrapper is supported');
    if (previous.uri === MC && !['p14', 'p159'].includes(previous.descendants[0].attrs.Requires))
      unsafe('Unsupported transition compatibility choice');
  }
  const start =
    previous?.start ??
    children.find((child) => child.local === 'timing' || child.local === 'extLst')?.start ??
    rootEnd;
  if (start < 0 || (previous && previous.end <= start))
    unsafe('Invalid transition insertion point');
  return {
    start,
    end: previous?.end ?? start,
    existingTransition: previous?.descendants.some(
      (node) => node.uri === P && node.local === 'fade',
    )
      ? ('fade' as const)
      : ('none' as const),
    nativeCompatible:
      children.filter((node) => node.uri === P && node.local === 'cSld').length === 1 &&
      !children.some((node) => node.uri === P && node.local === 'extLst') &&
      ![previous, ...(previous?.descendants ?? [])].some((node) => node?.attrs.advClick === '0'),
  };
}

async function checkFadeParents(zip: JSZip, slidePart: string) {
  let part = slidePart;
  for (const [type, root] of [
    ['slideLayout', 'sldLayout'],
    ['slideMaster', 'sldMaster'],
  ]) {
    const relPart = `${path.posix.dirname(part)}/_rels/${path.posix.basename(part)}.rels`;
    const matches = relationships(await xml(zip, relPart)).filter(
      (rel) => rel.Type === `${R}/${type}`,
    );
    if (matches.length !== 1 || matches[0].TargetMode)
      unsafe('Missing or ambiguous fade source parent');
    part = resolvePart(part, matches[0].Target);
    const parent = nodes(await xml(zip, part));
    if (
      parent[0]?.uri !== P ||
      parent[0]?.local !== root ||
      parent.some(
        (node) =>
          (node.uri === P && node.local === 'transition') ||
          (node.uri === 'http://schemas.openxmlformats.org/markup-compatibility/2006' &&
            node.local === 'AlternateContent'),
      )
    )
      unsafe('Inherited or compatibility-wrapped parent transitions require separate review');
  }
}

/** Read-only compatibility facts for trusted Host code; this is not a permission or an edit lease. */
export async function inspectPageFadeSource(input: PageFadeSourceInput) {
  const { getCurrentBaseline, signal } = input;
  const { baseline, source, target, zip, slideParts, oldSlide } = await prepareSource(input);
  const transition = fadeTransitionWindow(oldSlide);
  if (!transition.nativeCompatible)
    unsafe(
      'Native fade requires a single slide body, click advance and no target slide extensions',
    );
  await checkFadeParents(zip, target.slidePart);
  await checkPageCandidateBaseline(baseline, getCurrentBaseline, signal);
  return Object.freeze({
    version: 1 as const,
    kind: 'page-fade-source' as const,
    baseline: Object.freeze(baseline),
    target: Object.freeze({ ...target, pageNumber: slideParts.indexOf(target.slidePart) + 1 }),
    slideHash: candidateHash(oldSlide),
    existingTransition: transition.existingTransition,
    sourceBytes: source.length,
  });
}

/** Deterministic fade only; all page objects, timing, notes and relationships stay byte-for-byte. */
export async function generatePageFadeCandidate(input: PageFadeSourceInput) {
  const { getCurrentBaseline, signal } = input;
  const { baseline, source, target, zip, oldSlide } = await prepareSource(input);
  const { start, end } = fadeTransitionWindow(oldSlide);
  const transition = `<p:transition xmlns:p="${P}" spd="med" advClick="1"><p:fade/></p:transition>`;
  const slide = oldSlide.slice(0, start) + transition + oldSlide.slice(end);
  nodes(slide);
  zip.file(target.slidePart, slide);
  const pptx = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const checked = await load(pptx);
  const original = await load(source);
  const preservedParts: Record<string, string> = {};
  for (const file of Object.values(original.files)) {
    if (file.dir || file.name === target.slidePart) continue;
    const hash = candidateHash(await file.async('nodebuffer'));
    const kept = checked.file(file.name);
    if (!kept || candidateHash(await kept.async('nodebuffer')) !== hash)
      unsafe(`Non-target part changed: ${file.name}`);
    preservedParts[file.name] = hash;
  }
  await checkPageCandidateBaseline(baseline, getCurrentBaseline, signal);
  return {
    version: 1 as const,
    candidateId: randomUUID(),
    kind: 'page-fade' as const,
    baseline,
    pptx,
    hash: candidateHash(pptx),
    scope: { pageIds: [baseline.pageId], slidePart: target.slidePart },
    report: {
      changedParts: [target.slidePart],
      addedParts: [],
      preservedParts,
      warnings: [
        'Simple medium fade only; object animations and advanced transitions are not edited.',
      ],
    },
    reviewState: 'needs-review' as const,
    applied: false as const,
  };
}

/** Only consume a retained B generator result in trusted Host code, never renderer evidence. */
export async function createPageCandidateLineage(input: {
  sourcePptx: Uint8Array;
  candidate:
    | Awaited<ReturnType<typeof generatePagePptxCandidate>>
    | Awaited<ReturnType<typeof generatePageFadeCandidate>>;
  mapping: unknown;
  /** Validate every confirmed batch target before requesting further page generation. */
  targets?: ReadonlyArray<{ pageId: string; slidePart: string }>;
  signal?: AbortSignal;
}) {
  const { signal } = input;
  signal?.throwIfAborted();
  const { pptx, ...metadata } = input.candidate;
  const candidate = { ...structuredClone(metadata), pptx: Buffer.from(pptx) };
  const baseline = pageCandidateBaselineSchema.parse(candidate.baseline);
  const targets = z.array(z.object({
    pageId: z.string().min(1).max(200),
    slidePart: z.string().regex(/^ppt\/slides\/slide[1-9]\d*\.xml$/),
  }).strict()).min(1).max(100).optional().parse(input.targets);
  const mapping = z
    .object({
      revision: z.string().min(1).max(200),
      sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
      pages: z.array(z.object({
        pageId: z.string().min(1).max(200),
        importPageId: z.string().min(1).max(200),
        objects: z.array(z.object({
          objectId: z.string().min(1).max(200),
          importElementId: z.string().min(1).max(200),
        }).strict()).max(10000),
      }).strict()).min(1).max(100),
    }).strict().parse(input.mapping);
  const source = Buffer.from(input.sourcePptx);
  const output = Buffer.from(candidate.pptx);
  if (candidateHash(source) !== baseline.sourceHash ||
      candidateHash(output) !== candidate.hash ||
      mapping.sourceSha256 !== baseline.sourceHash.slice(7) ||
      !['page-pptx', 'page-fade'].includes(candidate.kind) ||
      candidate.applied !== false || candidate.reviewState !== 'needs-review' ||
      candidate.scope.pageIds.length !== 1 || candidate.scope.pageIds[0] !== baseline.pageId)
    throw new PageCandidateError('INVALID_SOURCE', 'Candidate lineage source/output binding is invalid');
  const before = await load(source);
  const after = await load(output);
  if (candidate.kind === 'page-pptx' && candidate.report.preservedImages?.length) {
    const old = await inspectPageImageAssets(source,candidate.scope.slidePart);
    const current = await inspectPageImageAssets(output,candidate.scope.slidePart);
    for (const lock of candidate.report.preservedImages) {
      if (!old.some(image => image.eligible && image.sourceShapeId === lock.sourceShapeId && image.assetSha256 === lock.assetSha256 && image.pictureSha256 === lock.pictureSha256 && image.zIndex === lock.zIndex) ||
          !current.some(image => image.eligible && image.sourceShapeId === lock.outputShapeId && image.assetSha256 === lock.assetSha256 && image.pictureSha256 === lock.pictureSha256 && image.zIndex === lock.zIndex))
        unsafe('Locked image lineage changed');
    }
  }
  const { slideParts } = await presentationSlides(before);
  const current = (await presentationSlides(after)).slideParts;
  if (slideParts.length !== mapping.pages.length ||
      new Set(slideParts).size !== slideParts.length ||
      new Set(mapping.pages.map((page) => page.pageId)).size !== mapping.pages.length ||
      new Set(mapping.pages.map((page) => page.importPageId)).size !== mapping.pages.length ||
      JSON.stringify(slideParts) !== JSON.stringify(current))
    unsafe('Candidate lineage requires the unchanged complete page structure');
  const pages = slideParts.map((part, index) => {
    // D emits page_N from relationship order; use it only inside these exact verified bytes.
    const importPageId = `page_${index + 1}`;
    const page = mapping.pages.find((page) => page.importPageId === importPageId);
    if (!page || (part === candidate.scope.slidePart && page.pageId !== baseline.pageId))
      unsafe('Candidate target does not match the trusted source mapping');
    return { oldLogicalId: page.pageId, importPageId };
  });
  if (!slideParts.includes(candidate.scope.slidePart)) unsafe('Candidate target is missing');
  for (const target of targets ?? []) {
    if (pages[slideParts.indexOf(target.slidePart)]?.oldLogicalId !== target.pageId)
      unsafe('Confirmed target does not match the trusted source mapping');
  }
  const targetRels = `ppt/slides/_rels/${path.posix.basename(candidate.scope.slidePart)}.rels`;
  const allowed = candidate.kind === 'page-fade' ? [candidate.scope.slidePart]
    : [candidate.scope.slidePart, targetRels, '[Content_Types].xml'];
  for (const file of Object.values(before.files)) {
    if (file.dir || allowed.includes(file.name)) continue;
    const kept = after.file(file.name);
    if (!kept || candidateHash(await kept.async('nodebuffer')) !== candidateHash(await file.async('nodebuffer')))
      unsafe(`Candidate lineage found a changed non-target part: ${file.name}`);
  }
  for (const file of Object.values(after.files)) {
    if (!file.dir && !before.file(file.name) &&
        (candidate.kind !== 'page-pptx' || !candidate.report.addedParts.includes(file.name) ||
         !file.name.startsWith(`ppt/media/b-${candidate.candidateId}-`) || !file.name.endsWith('.png')))
      unsafe('Candidate lineage found an unexpected added part');
  }
  signal?.throwIfAborted();
  return {
    previousSourceSha256: baseline.sourceHash.slice(7),
    currentSourceSha256: candidate.hash.slice(7),
    pages, copiedImportPageIds: [], replacements: [],
  };
}
