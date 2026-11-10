import { expect, it } from 'vitest';
import JSZip from 'jszip';
import { compileSceneToPptx } from '../kindergarten/scene-to-pptx';
import { assessmentBackground } from '../classroom-pptx';
import { syncSpeechAnimations } from '../speech-animations';
import { importPptxFromBuffer } from '../../conversion/lib/import/pptx/import-pptx-from-buffer';

async function fixture() {
  const source = await compileSceneToPptx({ version: 1, slideId: 'page', sourceHash: 'sha256:test', canvas: { width: 1000, height: 562.5 },
    visualMasterAssetId: assessmentBackground.id, cleanPlateAssetId: assessmentBackground.id,
    elements: [{ id: 'title', type: 'native_text', bboxPx: [100, 100, 400, 80], zIndex: 1, content: 'Hello',
      style: { fontFace: 'Arial', fontSizePt: 30, fontWeight: 400, color: '#111111', align: 'left', lineHeight: 1.2 } }] },
  { [assessmentBackground.id]: assessmentBackground.bytes });
  const effects = ['fadeIn', 'zoomIn', 'slideInLeft', 'slideInRight', 'pulse', 'gentleRotate', 'fadeOut'];
  const pages = [{ objects: [{ id: 'logical-title', objectName: 'title' }], actions: effects.map((effect, i) => ({
    id: `speech-${i}`, type: 'speech', visualCues: [{ id: `motion-${i}`, atMs: 0, endMs: 600,
      trigger: { version: 1, kind: 'start' }, effect: { type: 'element_animation', elementId: 'logical-title', effect } }],
  })) }];
  return { source: source.pptx, pages };
}

it('persists every speech animation as verified native PPTX behavior and is idempotent', async () => {
  const input = await fixture(), result = await syncSpeechAnimations(input);
  expect(result.changedPages).toEqual([true]);
  const zip = await JSZip.loadAsync(result.pptx), xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
  expect(xml).toContain('<p:timing');
  const ir = await importPptxFromBuffer({ arrayBuffer: Uint8Array.from(result.pptx).buffer, fileName: 'motions.pptx' });
  const items = ir.pages[0].pptxAnimation?.steps.flatMap(step => step.items);
  expect(items).toHaveLength(7);
  expect(items!.every(item => item.nativePreset?.verifiedSpeechMotion && item.durationMs === 600)).toBe(true);
  expect(new Set(items!.map(item => item.target?.shapeId)).size).toBe(1);
  const again = await syncSpeechAnimations({ ...input, source: result.pptx });
  expect(again.changedPages).toEqual([false]);
  expect(again.pptx).toEqual(result.pptx);
});

it('preserves unbound animations and rejects missing or ambiguous targets without changing source', async () => {
  const input = await fixture(), first = await syncSpeechAnimations({ ...input, pages: [{ ...input.pages[0], actions: input.pages[0].actions.slice(0, 1) }] });
  const remaining = await syncSpeechAnimations({ ...input, source: first.pptx });
  const ir = await importPptxFromBuffer({ arrayBuffer: Uint8Array.from(remaining.pptx).buffer, fileName: 'motions.pptx' });
  expect(ir.pages[0].pptxAnimation?.steps.flatMap(step => step.items)).toHaveLength(7);
  input.pages[0].objects[0].objectName = 'absent';
  await expect(syncSpeechAnimations(input)).rejects.toThrow(/target/);
  input.pages[0].objects[0].objectName = 'title';
  input.pages[0].objects.push({ ...input.pages[0].objects[0] });
  await expect(syncSpeechAnimations(input)).rejects.toThrow(/ambiguous/);
});

it('extends an empty saved main sequence and retains the speech cue offset in native timing', async () => {
  const input = await fixture(), zip = await JSZip.loadAsync(input.source);
  const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
  zip.file('ppt/slides/slide1.xml', xml.replace('</p:sld>', '<p:timing><p:tnLst><p:par><p:cTn id="1" nodeType="tmRoot" dur="indefinite"><p:childTnLst><p:seq><p:cTn id="2" nodeType="mainSeq" dur="indefinite"><p:childTnLst/></p:cTn></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing></p:sld>'));
  input.pages[0].actions = input.pages[0].actions.slice(0, 1);
  input.pages[0].actions[0].visualCues[0].atMs = 300;
  input.pages[0].actions[0].visualCues[0].endMs = 900;
  const result = await syncSpeechAnimations({ ...input, source: await zip.generateAsync({ type: 'uint8array' }) });
  const ir = await importPptxFromBuffer({ arrayBuffer: Uint8Array.from(result.pptx).buffer, fileName: 'motions.pptx' });
  expect(ir.pages[0].pptxAnimation?.steps[0].items[0]).toMatchObject({ startAtMs: 300, durationMs: 600 });
});
