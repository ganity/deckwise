// Adapted from sealed B4 tree 16b92c8446c5ef2eee6348b020a884d00b66c374.
// Fade semantics are retained; scene compilation and redo-only helpers are excluded.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import JSZip from 'jszip';
import { SaxesParser } from 'saxes';
import { z } from 'zod';
import { candidateHash, checkPageCandidateBaseline, pageCandidateBaselineSchema, PageCandidateError } from './page-candidate-baseline.js';

const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
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

async function prepareSource(input: {
  baseline: unknown;
  sourcePptx: Uint8Array;
  pageText: string;
  target: { pageId: string; slidePart: string };
  getCurrentBaseline: () => Promise<unknown>;
  signal?: AbortSignal;
}) {
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
  return { baseline, source, target, pageText, zip, presentation, oldSlide };
}

/** Deterministic fade only; all page objects, timing, notes and relationships stay byte-for-byte. */
export async function generatePageFadeCandidate(input: {
  baseline: unknown;
  sourcePptx: Uint8Array;
  pageText: string;
  target: { pageId: string; slidePart: string };
  getCurrentBaseline: () => Promise<unknown>;
  signal?: AbortSignal;
}) {
  const { baseline, source, target, zip, oldSlide } = await prepareSource(input);
  const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
  const P14 = 'http://schemas.microsoft.com/office/powerpoint/2010/main';
  type TransitionNode = Node & { depth: number };
  const children: Array<TransitionNode & { start: number; end: number; descendants: TransitionNode[] }> = [];
  const parser = new SaxesParser({ xmlns: true });
  let depth = 0;
  let rootEnd = 0;
  parser.on('opentag', (node) => {
    const value = { name: node.name, local: node.local, uri: node.uri, depth,
      attrs: Object.fromEntries(Object.values(node.attributes).filter((attr) => attr.uri !== 'http://www.w3.org/2000/xmlns/').map((attr) => [attr.uri ? `{${attr.uri}}${attr.local}` : attr.local, attr.value])),
    };
    if (depth === 1) children.push({ ...value, start: oldSlide.lastIndexOf('<', parser.position - 1), end: 0, descendants: [] });
    if (depth > 1) children[children.length - 1].descendants.push(value);
    depth++;
  });
  parser.on('closetag', () => {
    depth--;
    if (depth === 1) children[children.length - 1].end = parser.position;
    if (depth === 0) rootEnd = oldSlide.lastIndexOf('<', parser.position - 1);
  });
  parser.write(oldSlide).close();
  if (children.some((child) => !(child.uri === P && ['cSld', 'clrMapOvr', 'transition', 'timing', 'extLst'].includes(child.local)) && !(child.uri === MC && child.local === 'AlternateContent'))) {
    unsafe('Unsupported slide extension');
  }
  const transitions = children.filter((child) => child.local === 'transition' || child.uri === MC);
  if (transitions.length > 1) unsafe('Ambiguous slide transitions');
  const previous = transitions[0];
  if (previous) {
    const all = [previous, ...previous.descendants];
    for (const node of all) {
      const allowed = node.uri === P && node.local === 'transition' ? ['spd', 'advClick', `{${P14}}dur`]
        : node.uri === P && node.local === 'fade' ? ['thruBlk']
        : node.uri === MC && node.local === 'Choice' ? ['Requires'] : [];
      if (Object.keys(node.attrs).some((key) => !allowed.includes(key)) ||
          (node.attrs.spd !== undefined && !['slow', 'med', 'fast'].includes(node.attrs.spd)) ||
          (node.attrs.advClick !== undefined && !['0', '1'].includes(node.attrs.advClick)) ||
          (node.attrs.thruBlk !== undefined && node.attrs.thruBlk !== '0') ||
          (node.attrs[`{${P14}}dur`] !== undefined && !/^\d{1,5}$/.test(node.attrs[`{${P14}}dur`]))) {
        unsafe('Automatic advance, sound and extended fade options require separate review');
      }
    }
    const actual = all.map((node) => `${node.uri}|${node.local}|${node.depth}`).join(';');
    const plain = (fade: boolean) => [`${P}|transition|1`, ...(fade ? [`${P}|fade|2`] : [])].join(';');
    const wrapped = (fade: boolean) => [`${MC}|AlternateContent|1`, `${MC}|Choice|2`, `${P}|transition|3`, ...(fade ? [`${P}|fade|4`] : []), `${MC}|Fallback|2`, `${P}|transition|3`, ...(fade ? [`${P}|fade|4`] : [])].join(';');
    if (![plain(false), plain(true), wrapped(false), wrapped(true)].includes(actual)) unsafe('Only a simple fade or the verified Office empty/fade wrapper is supported');
    if (previous.uri === MC && !['p14', 'p159'].includes(previous.descendants[0].attrs.Requires)) unsafe('Unsupported transition compatibility choice');
  }
  const start =
    previous?.start ??
    children.find((child) => child.local === 'timing' || child.local === 'extLst')?.start ??
    rootEnd;
  if (start < 0 || (previous && previous.end <= start))
    unsafe('Invalid transition insertion point');
  const transition = `<p:transition xmlns:p="${P}" spd="med" advClick="1"><p:fade/></p:transition>`;
  const slide = oldSlide.slice(0, start) + transition + oldSlide.slice(previous?.end ?? start);
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
  await checkPageCandidateBaseline(baseline, input.getCurrentBaseline, input.signal);
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


// Same limits as the sealed B4 ZIP guard; no external media resolution is needed here.
function assertPptxZipWithinLimits(zip: JSZip, limit: number) {
  const entries = Object.values(zip.files);
  if (entries.length > 5000) unsafe('ZIP entry limit exceeded');
  let expanded = 0;
  for (const entry of entries) {
    const name = (entry.unsafeOriginalName ?? entry.name).replace(/\\/g, '/');
    if (name.includes('\0') || name.startsWith('/') || /^[a-z]:\//i.test(name) || name.split('/').includes('..')) unsafe('Unsafe ZIP entry path');
    if (entry.dir) continue;
    const meta = (entry as typeof entry & { _data?: { compressedSize?: number; uncompressedSize?: number } })._data;
    const compressed = meta?.compressedSize;
    const size = meta?.uncompressedSize;
    if (compressed === undefined || size === undefined || !Number.isFinite(compressed) || !Number.isFinite(size) || compressed < 0 || size < 0) unsafe('Invalid ZIP size metadata');
    if (size > 512 * 1024 * 1024 || (size > 0 && (compressed === 0 || size / compressed > 200))) unsafe('ZIP expansion limit exceeded');
    expanded += size;
    if (expanded > limit) unsafe('PPTX expansion limit exceeded');
  }
}

/** Resolve D import IDs against the exact source relationship order, never Office page numbers. */
export async function resolvePageFadeTarget(source: Uint8Array, mapping: unknown, pageId: string) {
  const id = z.string().min(1).max(200);
  const parsed = z.object({
    revision: id, sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    pages: z.array(z.object({ pageId: id, importPageId: id,
      objects: z.array(z.object({ objectId: id, importElementId: id }).strict()).max(10000),
    }).strict()).min(1).max(100),
  }).strict().parse(mapping);
  if (candidateHash(source) !== `sha256:${parsed.sourceSha256}`) unsafe('Mapping source hash differs');
  const { slideParts } = await presentationSlides(await load(source));
  if (slideParts.length !== parsed.pages.length || new Set(slideParts).size !== slideParts.length ||
      new Set(parsed.pages.map(page => page.pageId)).size !== parsed.pages.length ||
      new Set(parsed.pages.map(page => page.importPageId)).size !== parsed.pages.length ||
      !slideParts.every((_, index) => parsed.pages.some(page => page.importPageId === `page_${index + 1}`))) unsafe('Incomplete or ambiguous page mapping');
  const page = parsed.pages.find(page => page.pageId === pageId);
  if (!page) unsafe('Logical target is missing from Host mapping');
  return { pageId, slidePart: slideParts[Number(page.importPageId.slice(5)) - 1] };
}
