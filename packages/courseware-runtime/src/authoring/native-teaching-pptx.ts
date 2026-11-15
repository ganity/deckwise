import { createHash } from 'node:crypto';
import path from 'node:path';
import { SaxesParser } from 'saxes';
import { maicQuizSchema } from '../maic-classroom';
import { pptxPackage as pkg } from './page-pptx-candidate';

type Page = { pageId: string; narration?: string; questionText?: string; actions: Array<Record<string, unknown>> };
const namespace = 'urn:deckwise:native-teaching:1';
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** Package a newly generated lesson before publication; existing native documents are never reinitialized. */
export async function packNativeTeachingPptx(input: {
  source: Uint8Array; title: string; pages: Page[]; generation: unknown;
}) {
  const zip = await pkg.load(input.source), { slideParts } = await pkg.presentationSlides(zip);
  if (!input.title.trim() || input.title.length > 500 || !input.pages.length || input.pages.length > 100 ||
      input.pages.length !== slideParts.length || new Set(input.pages.map(p => p.pageId)).size !== input.pages.length ||
      input.pages.some(p => !/^[\w.-]{1,128}$/.test(p.pageId) || !Array.isArray(p.actions)))
    throw new Error('Generated teaching differs from physical PPT pages');
  for (const file of Object.values(zip.files).filter(f => /^customXml\/[^/]+\.xml$/.test(f.name))) {
    if ((await file.async('string')).includes(namespace)) throw new Error('Generated source already contains native teaching');
  }
  const identity: { pages: Array<{ pageId: string; objects: Array<{ logicalId: string; sourceShapeId: string; sourceObjectName: string }> }> } = { pages: [] };
  const pages: Array<{ pageId: string; locked: boolean; reviewState: string; actions: Array<Record<string, unknown>> }> = [];
  const sourceHash = hash(input.source);
  for (const [index, page] of input.pages.entries()) {
    const slidePart = slideParts[index], slide = await pkg.xml(zip, slidePart);
    const objects: typeof identity.pages[number]['objects'] = [], stack: string[] = [];
    const shapeTexts: string[] = [];
    let shapeText: string | undefined, inText = false;
    const parser = new SaxesParser({ xmlns: true });
    pkg.nodes(slide);
    parser.on('opentag', tag => {
      if (tag.uri === pkg.P && tag.local === 'sp') shapeText = '';
      inText = tag.local === 't' && tag.uri === 'http://schemas.openxmlformats.org/drawingml/2006/main';
      if (tag.uri === pkg.P && tag.local === 'cNvPr' && ['sp', 'pic', 'graphicFrame', 'cxnSp', 'grpSp'].includes(stack.at(-2) ?? '')) {
        const id = tag.attributes.id?.value, name = tag.attributes.name?.value ?? '';
        if (!id || !/^\d{1,10}$/.test(id) || objects.some(o => o.sourceShapeId === id)) throw new Error('Invalid generated shape identity');
        objects.push({ logicalId: 'object-' + hash(sourceHash + ':' + slidePart + ':' + id).slice(0, 40), sourceShapeId: id, sourceObjectName: name });
      }
      stack.push(tag.local);
    });
    parser.on('text', text => { if (shapeText !== undefined && inText) shapeText += text; });
    parser.on('closetag', tag => {
      if (shapeText !== undefined && tag.local === 'p') shapeText += '\n';
      if (tag.uri === pkg.P && tag.local === 'sp') { shapeTexts.push(shapeText?.trim() ?? ''); shapeText = undefined; }
      inText = false; stack.pop();
    });
    parser.write(slide).close();
    identity.pages.push({ pageId: page.pageId, objects });
    if (page.questionText !== undefined && shapeTexts.filter(text => text === page.questionText!.trim()).length !== 1)
      throw new Error('Bind the exact interaction question to one exported text box');
    let narration = page.narration;
    if (narration === undefined) {
      const relsFile = zip.file(path.posix.join(path.posix.dirname(slidePart), '_rels', path.posix.basename(slidePart) + '.rels'));
      const rels = relsFile ? pkg.relationships(await relsFile.async('string')) : [];
      const notes = rels.filter(r => r.Type === `${pkg.R}/notesSlide`);
      if (notes.length > 1 || notes.some(r => r.TargetMode)) throw new Error('Invalid generated slide notes');
      narration = '';
      if (notes[0]) {
        const xml = await pkg.xml(zip, pkg.resolvePart(slidePart, notes[0].Target));
        pkg.nodes(xml);
        const notesParser = new SaxesParser({ xmlns: true });
        let shape: { text: string; excluded: boolean } | undefined, text = false;
        const paragraphs: string[] = [];
        notesParser.on('opentag', tag => {
          if (tag.uri === pkg.P && tag.local === 'sp') shape = { text: '', excluded: false };
          if (shape && tag.uri === pkg.P && tag.local === 'ph' && ['sldNum', 'dt', 'hdr', 'ftr', 'sldImg'].includes(tag.attributes.type?.value)) shape.excluded = true;
          text = tag.local === 't' && tag.uri === 'http://schemas.openxmlformats.org/drawingml/2006/main';
        });
        notesParser.on('text', value => { if (shape && text) shape.text += value; });
        notesParser.on('closetag', tag => {
          if (shape && tag.local === 'p') shape.text += '\n';
          if (shape && tag.uri === pkg.P && tag.local === 'sp') { if (!shape.excluded) paragraphs.push(shape.text.trim()); shape = undefined; }
          text = false;
        });
        notesParser.write(xml).close();
        narration = paragraphs.filter(Boolean).join('\n');
      }
    }
    if (typeof narration !== 'string' || narration.length > 32000) throw new Error('Invalid generated narration');
    const actions = structuredClone(page.actions);
    if (narration.trim()) actions.unshift({ id: `${page.pageId}-speech`, type: 'speech', text: narration.trim(), source: 'generated' });
    pages.push({ pageId: page.pageId, locked: false, reviewState: 'review', actions });
  }
  const revision = 'revision-' + hash(JSON.stringify([sourceHash, input.title, pages, input.generation])).slice(0, 40);
  const generated = input.generation as { pages?: Array<{ pageId: string; quiz?: unknown }> } | undefined;
  const assessments = Object.fromEntries((generated?.pages ?? []).filter(p => p.quiz !== undefined && pages.some(page => page.pageId === p.pageId)).map(p => [p.pageId, maicQuizSchema.parse(p.quiz)]));
  const teaching = { ...(Object.keys(assessments).length ? { assessments } : {}), schemaVersion: 'deckwise-native-teaching/1', documentId: 'native-' + hash(revision).slice(0, 40),
    revision, title: input.title, pages, identity, media: [], generation: input.generation };
  const part = 'customXml/deckwise-native.xml';
  if (zip.file(part)) throw new Error('Generated native teaching part is occupied');
  zip.file(part, `<teaching xmlns="${namespace}">${escape(JSON.stringify(teaching))}</teaching>`);
  const relsPart = 'ppt/_rels/presentation.xml.rels', relationships = await pkg.xml(zip, relsPart);
  if (pkg.relationships(relationships).some(r => r.Id === 'rIdDeckwiseNativeTeaching')) throw new Error('Generated native relationship is occupied');
  zip.file(relsPart, pkg.append(relationships, pkg.REL, 'Relationships', prefix =>
    `<${prefix}Relationship Id="rIdDeckwiseNativeTeaching" Type="${pkg.R}/customXml" Target="../${part}"/>`));
  zip.file('[Content_Types].xml', pkg.append(await pkg.xml(zip, '[Content_Types].xml'), pkg.CT, 'Types', prefix =>
    `<${prefix}Override PartName="/${part}" ContentType="application/xml"/>`));
  // Fixed timestamps keep retries byte-identical, including newly inserted ZIP directories.
  for (const entry of Object.values(zip.files)) entry.date = new Date('2000-01-01T00:00:00Z');
  const pptx = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  if (pptx.length > 50 * 1024 * 1024) throw new Error('Generated native PPTX exceeds 50 MiB');
  return pptx;
}
