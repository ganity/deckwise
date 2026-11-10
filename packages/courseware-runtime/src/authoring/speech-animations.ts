import { SaxesParser } from 'saxes';
import { z } from 'zod';
import { nativeMotionPreset } from '../generated-native-motion';
import { parsePptxTiming } from '../conversion/lib/import/pptx/animation/parse-pptx-timing';
import { nativeSpeechAnimationPattern, type SpeechAnimationPattern } from '../conversion/lib/import/pptx/animation/native-speech-composite';
import { pptxPackage as pkg } from './page-pptx-candidate';

export type SpeechMotionPage = {
  objects: Array<{ id: string; objectName: string }>;
  actions: ReadonlyArray<Record<string, unknown>>;
};
const cuesSchema = z.array(z.looseObject({ atMs: z.number().int().nonnegative(), endMs: z.number().int().positive(),
  nativeAnimation: z.string().min(1).optional(), effect: z.looseObject({ type: z.string(), elementId: z.string().optional(), effect: z.string().optional() }) })).max(200);
const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

/** Add real native effects without replacing existing timing, object geometry, or identities. */
export async function syncSpeechAnimations(input: { source: Uint8Array; pages: SpeechMotionPage[] }) {
  const zip = await pkg.load(input.source), { slideParts } = await pkg.presentationSlides(zip);
  if (slideParts.length !== input.pages.length) throw new Error('Speech animation page mapping changed');
  const changedPages: boolean[] = [];
  for (const [index, page] of input.pages.entries()) {
    let xml = await pkg.xml(zip, slideParts[index]);
    const nodes = pkg.nodes(xml), parsed = parsePptxTiming(xml);
    const groups = page.actions.filter(action => action.type === 'speech').map(action =>
      cuesSchema.parse(action.visualCues ?? []).filter(cue => cue.effect.type === 'element_animation')).filter(group => group.length);
    if (!groups.length) { changedPages.push(false); continue; }
    if (!parsed.accepted) throw new Error(`Cannot preserve native speech animations: ${parsed.warning}`);
    const existing = parsed.animation.steps.flatMap(step => step.items), claimed = new Set<object>();
    if (groups.flat().length > 200 || existing.length > 200) throw new Error('Native speech animation limit exceeded');
    let nextId = Math.max(2, ...nodes.filter(node => node.uri === pkg.P && node.local === 'cTn').map(node => Number(node.attrs.id) || 0));
    const id = () => ++nextId;
    const serialize = (node: SpeechAnimationPattern): string => `<p:${node.local}${Object.entries({ ...(node.local === 'cTn' ? { id: String(id()) } : {}), ...node.attrs })
      .map(([key, value]) => ` ${key}="${escape(value)}"`).join('')}>${node.text ? escape(node.text) : ''}${node.children.map(serialize).join('')}</p:${node.local}>`;
    const added: string[] = [];
    for (const cues of groups) {
      const effects: string[] = [];
      for (const cue of cues) {
        const preset = nativeMotionPreset(cue.effect.effect ?? ''), duration = cue.endMs - cue.atMs;
        if (!preset || !Number.isInteger(cue.atMs) || cue.atMs < 0 || !Number.isInteger(duration) || duration < 1 || duration > 5000)
          throw new Error('Invalid native speech animation preset or duration');
        const bindings = page.objects.filter(object => object.id === cue.effect.elementId);
        const targets = nodes.filter(node => node.uri === pkg.P && node.local === 'cNvPr' && node.attrs.name === bindings[0]?.objectName);
        if (bindings.length !== 1 || targets.length !== 1 || !/^\d+$/u.test(targets[0].attrs.id)) throw new Error('Native speech animation target is missing or ambiguous');
        const shapeId = targets[0].attrs.id;
        const matches = existing.filter(item => !claimed.has(item) && item.target?.shapeId === shapeId &&
          !item.target.paragraphIndexes && !item.target.characterRange && item.nativePreset?.class === preset.ooxmlClass &&
          item.nativePreset.id === preset.presetId && (item.nativePreset.subtype ?? 0) === preset.subtype &&
          (cue.nativeAnimation || item.durationMs === duration));
        if (matches.length) { claimed.add(matches[0]); continue; }
        if (cue.nativeAnimation) throw new Error('Linked native speech animation is missing; rebind it before saving');
        const pattern = nativeSpeechAnimationPattern(`${preset.ooxmlClass}/${preset.presetId}/${preset.subtype}`, duration, shapeId);
        if (!pattern) throw new Error('Native speech animation behavior is unavailable');
        effects.push(`<p:par><p:cTn id="${id()}" presetID="${preset.presetId}" presetClass="${preset.ooxmlClass}" presetSubtype="${preset.subtype}" fill="hold" grpId="0" nodeType="${effects.length ? 'withEffect' : 'clickEffect'}"><p:stCondLst><p:cond delay="${cue.atMs}"/></p:stCondLst><p:childTnLst>${pattern.expected.map(serialize).join('')}</p:childTnLst></p:cTn></p:par>`);
      }
      if (effects.length) added.push(`<p:par xmlns:p="${pkg.P}"><p:cTn id="${id()}" fill="hold"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst><p:childTnLst>${effects.join('')}</p:childTnLst></p:cTn></p:par>`);
    }
    changedPages.push(added.length > 0);
    if (!added.length) continue;
    if (page.actions.some(action => action.type === 'native_animation')) throw new Error('Rebind legacy native animation steps before adding speech animations');
    // Insert inside the existing main sequence; unrelated native effects remain byte-for-byte intact.
    const parser = new SaxesParser({ xmlns: true });
    const stack: Array<{ local: string; main: boolean; start: number }> = [];
    let mainListEnd = -1, extensionStart = -1, slideEnd = -1;
    let emptyMainList: { start: number; end: number; name: string } | undefined;
    parser.on('opentag', tag => {
      if (tag.uri === pkg.P && tag.local === 'extLst' && stack.length === 1) extensionStart = xml.lastIndexOf('<', parser.position - 1);
      stack.push({ local: tag.local, main: Object.values(tag.attributes).some(attr => attr.local === 'nodeType' && attr.value === 'mainSeq'),
        start: xml.lastIndexOf('<', parser.position - 1) });
    });
    parser.on('closetag', tag => {
      const node = stack.pop()!;
      if (tag.uri === pkg.P && node.local === 'childTnLst' && stack.at(-1)?.main) {
        if (tag.isSelfClosing) emptyMainList = { start: node.start, end: parser.position, name: tag.name };
        else mainListEnd = xml.lastIndexOf('</', parser.position - 1);
      }
      if (tag.uri === pkg.P && tag.local === 'sld' && !stack.length) slideEnd = xml.lastIndexOf('</', parser.position - 1);
    });
    parser.write(xml).close();
    if (nodes.some(node => node.uri === pkg.P && node.local === 'timing')) {
      if (emptyMainList) xml = xml.slice(0, emptyMainList.start) + `<${emptyMainList.name}>${added.join('')}</${emptyMainList.name}>` + xml.slice(emptyMainList.end);
      else {
        if (mainListEnd < 0) throw new Error('Native timing has no editable main sequence');
        xml = xml.slice(0, mainListEnd) + added.join('') + xml.slice(mainListEnd);
      }
    } else {
      const timing = `<p:timing xmlns:p="${pkg.P}"><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>${added.join('')}</p:childTnLst></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>`;
      const at = extensionStart >= 0 ? extensionStart : slideEnd;
      if (at < 0) throw new Error('Native slide root is missing');
      xml = xml.slice(0, at) + timing + xml.slice(at);
    }
    const verified = parsePptxTiming(xml);
    if (!verified.accepted || verified.animation.steps.flatMap(step => step.items).length !== existing.length + groups.flat().length - claimed.size)
      throw new Error(`Native speech animation export failed verification${verified.accepted ? '' : `: ${verified.warning}`}`);
    zip.file(slideParts[index], xml);
  }
  return { changedPages, pptx: changedPages.some(Boolean) ? await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }) : input.source };
}
