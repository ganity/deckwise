import { createHash } from 'node:crypto';
import path from 'node:path';
import JSZip from 'jszip';
import { SaxesParser } from 'saxes';
import { assertPptxZipWithinLimits } from '../conversion/lib/import/pptx/pptx-zip-package';

const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export type PreservedPageImage = { objectId: string; sourceShapeId: string; assetSha256: string; pictureSha256: string; zIndex: number };
type Element = { xml: string; local: string; id: string; nodes: Array<{ uri: string; local: string; attrs: Record<string,string> }> };
function elements(xml: string) {
  if (Buffer.byteLength(xml) > 4 * 1024 * 1024 || /<!DOCTYPE/iu.test(xml)) throw new Error('Unsupported image-lock XML');
  const parser = new SaxesParser({ xmlns: true });
  let depth = 0, treeDepth = -1, foundTree = false, start = 0, active: Element | undefined;
  const found: Element[] = [];
  parser.on('error', error => { throw error; });
  parser.on('opentag', tag => {
    const attrs = Object.fromEntries(Object.values(tag.attributes).map(attr => [attr.uri ? `{${attr.uri}}${attr.local}` : attr.local, attr.value]));
    if (tag.uri === P && tag.local === 'spTree') { treeDepth = depth; foundTree = true; }
    if (treeDepth >= 0 && depth === treeDepth + 1 && tag.uri === P && !['nvGrpSpPr','grpSpPr'].includes(tag.local)) {
      start = xml.lastIndexOf('<', parser.position - 1); active = { xml: '', local: tag.local, id: '', nodes: [] };
    }
    if (active) { active.nodes.push({ uri: tag.uri, local: tag.local, attrs }); if (tag.uri === P && tag.local === 'cNvPr') active.id = attrs.id; }
    depth++;
  });
  parser.on('closetag', () => { depth--; if (active && depth === treeDepth + 1) {
    active.xml = xml.slice(start, parser.position); found.push(active); active = undefined;
  }
    // Slide-level transition/compatibility nodes are not shape-tree objects.
    if (depth === treeDepth) treeDepth = -1;
  });
  parser.write(xml).close();
  if (!foundTree || found.length > 10000) throw new Error('Missing or oversized image-lock shape tree');
  return found;
}
function pictureHash(xml: string) { return digest(xml.replace(/(<p:cNvPr\b[^>]*\bid=")[^"]+("[^>]*>)/u, (_match, before, after) => `${before}__HOST_OBJECT__${after}`)); }
async function inspect(zip: JSZip, slidePart: string) {
  const file = zip.file(slidePart), relFile = zip.file(`ppt/slides/_rels/${path.posix.basename(slidePart)}.rels`);
  if (!file || !relFile || !/^ppt\/slides\/slide[1-9]\d*\.xml$/u.test(slidePart)) throw new Error('Missing image-lock slide');
  const raw = await file.async('string'), all = elements(raw), rels = new Map<string,{target:string;type:string;mode?:string}>();
  const parser = new SaxesParser({ xmlns: true });
  parser.on('opentag', tag => { if (tag.uri === REL && tag.local === 'Relationship') {
    const attrs = Object.fromEntries(Object.values(tag.attributes).map(attr => [attr.local,attr.value]));
    if (rels.has(attrs.Id)) throw new Error('Duplicate image relationship');
    rels.set(attrs.Id,{target:attrs.Target,type:attrs.Type,mode:attrs.TargetMode});
  } }); parser.write(await relFile.async('string')).close();
  const pictures = [];
  for (const [zIndex, element] of all.entries()) {
    if (element.local !== 'pic') continue;
    let reason: string | undefined, assetSha256: string | undefined;
    const blips = element.nodes.filter(node => node.local === 'blip');
    const embed = blips[0]?.attrs[`{${R}}embed`], rel = rels.get(embed);
    if (all.some(item => !['sp','pic','cxnSp'].includes(item.local)) || all.filter(item => item.id === element.id).length !== 1 ||
      !/^<p:pic[\s>]/u.test(element.xml) || !element.id || !/^\d+$/u.test(element.id) ||
      blips.length !== 1 || !rel || rel.mode || rel.type !== `${R}/image` || !rel.target || /[\\?#%]|^[a-z]+:/iu.test(rel.target) ||
      element.nodes.some(node => ['srcRect','grpSp','graphicFrame','extLst','effectLst','effectDag','hlinkClick','hlinkHover','AlternateContent'].includes(node.local) ||
        Object.keys(node.attrs).some(key => key.startsWith(`{${R}}`) && !(node.local === 'blip' && key === `{${R}}embed`))) ||
      element.nodes.some(node => node.local === 'xfrm' && Object.entries(node.attrs).some(([key,value]) => ['rot','flipH','flipV'].includes(key) && value !== '0')))
      reason = 'Only plain top-level embedded PNG/JPEG pictures without crop, transforms, groups or effects can be locked';
    if (!reason) {
      const part = path.posix.resolve('/', path.posix.dirname(slidePart), rel!.target).slice(1);
      const media = zip.file(part), bytes = media && await media.async('nodebuffer');
      if (!part.startsWith('ppt/media/') || !bytes || bytes.length > 32 * 1024 * 1024 ||
        !(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)) reason = 'Unsupported or missing embedded PNG/JPEG bytes';
      else assetSha256 = digest(bytes);
    }
    pictures.push({ sourceShapeId: element.id, zIndex, pictureSha256: pictureHash(element.xml), ...(assetSha256 ? {assetSha256} : {}), eligible: !reason, ...(reason ? {reason} : {}), xml: element.xml });
  }
  return { raw, all, pictures };
}
export async function inspectPageImageAssets(sourcePptx: Uint8Array, slidePart: string) {
  const zip = await JSZip.loadAsync(sourcePptx); assertPptxZipWithinLimits(zip,128*1024*1024);
  return (await inspect(zip,slidePart)).pictures.map(({xml: _xml,...picture}) => picture);
}
/** Original local picture nodes and image relationships stay in the source package. */
export async function preservePageImages(zip: JSZip, slidePart: string, generatedSlide: string, locks: readonly PreservedPageImage[]) {
  const source = await inspect(zip,slidePart), generated = elements(generatedSlide);
  if (new Set(locks.map(lock => lock.objectId)).size !== locks.length || new Set(locks.map(lock => lock.zIndex)).size !== locks.length) throw new Error('Duplicate locked images');
  const used = new Set([...generatedSlide.matchAll(/<p:cNvPr\b[^>]*\bid="([^"]+)"/gu)].map(match => match[1]));
  const result = generated.map(element => element.xml), preserved = [];
  for (const lock of [...locks].sort((a,b) => a.zIndex-b.zIndex)) {
    const original = source.pictures.find(image => image.sourceShapeId === lock.sourceShapeId);
    if (!original?.eligible || original.assetSha256 !== lock.assetSha256 || original.pictureSha256 !== lock.pictureSha256 || original.zIndex !== lock.zIndex || lock.zIndex > result.length) throw new Error('Locked picture bytes, geometry or layer changed');
    let id = original.sourceShapeId, number = 1;
    while (used.has(id)) id = String(number++);
    used.add(id);
    const picture = original.xml.replace(/(<p:cNvPr\b[^>]*\bid=")[^"]+("[^>]*>)/u, (_match, before, after) => `${before}${id}${after}`);
    if (pictureHash(picture) !== lock.pictureSha256) throw new Error('Locked picture changed');
    result.splice(lock.zIndex,0,picture); preserved.push({...lock,outputShapeId:id});
  }
  const first = generated[0]?.xml, last = generated.at(-1)?.xml;
  if (!first || !last) throw new Error('Generated page has no editable objects');
  const begin = generatedSlide.indexOf(first), end = generatedSlide.lastIndexOf(last)+last.length;
  return { slide: generatedSlide.slice(0,begin)+result.join('')+generatedSlide.slice(end), preserved };
}
