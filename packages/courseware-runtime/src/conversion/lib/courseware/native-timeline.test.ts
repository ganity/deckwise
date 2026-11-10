import { expect, it } from 'vitest';
import { projectNativeTimeline } from './native-timeline';
import { nativeSpeechComposite } from '../import/pptx/animation/native-speech-composite';
import { parsePptxTiming, type TimingNode } from '../import/pptx/animation/parse-pptx-timing';
import type { SlidePageIR } from '../import/types';

it('projects verified automatic, delayed and parallel presets with exact native targets', () => {
  const page: SlidePageIR = { id: 'page', width: 960, height: 540, elements: [{ id: 'shape', type: 'shape', sourceShapeId: '4', left: 0, top: 0, width: 20, height: 30 }],
    pptxAnimation: { steps: [{ id: 'auto', trigger: 'auto', items: [{ id: 'grow', target: { shapeId: '4' }, effect: 'grow150', animationType: 'attention', startAtMs: 500, durationMs: 600,
      nativePreset: { version: 1, class: 'emph', id: 6, verifiedSpeechMotion: true } }] }] } };
  expect(projectNativeTimeline(page)?.steps[0]).toMatchObject({ trigger: 'auto', items: [{ elementId: 'shape', effect: 'grow150', startAtMs: 500, durationMs: 600 }] });
  delete page.pptxAnimation!.steps[0].items[0].nativePreset!.verifiedSpeechMotion;
  expect(() => projectNativeTimeline(page)).toThrow('NATIVE_ANIMATION_UNSUPPORTED');
});

it('recognizes exact SDK grow behavior and rejects changed scale or duration', () => {
  const uri = 'http://schemas.openxmlformats.org/presentationml/2006/main';
  const node = (local: string, attrs: Record<string,string> = {}, children: TimingNode[] = []): TimingNode => ({ local, uri, attrs, children });
  const grow = node('cTn', { id: '1', presetID: '6', presetClass: 'emph', presetSubtype: '0', fill: 'hold', grpId: '0', nodeType: 'afterEffect' }, [
    node('stCondLst', {}, [node('cond', { delay: '0' })]), node('childTnLst', {}, [node('animScale', {}, [
      node('cBhvr', {}, [node('cTn', { id: '2', dur: '600', fill: 'hold' }), node('tgtEl', {}, [node('spTgt', { spid: '4' })])]), node('by', { x: '150000', y: '150000' }),
    ])]),
  ]);
  expect(nativeSpeechComposite(grow)).toMatchObject({ effect: 'grow150', durationMs: 600, nativeVerified: true });
  grow.children[1].children[0].children[1].attrs.x = '160000';
  expect(nativeSpeechComposite(grow)).toBeUndefined();
});

it('namespace declarations do not count as animation behavior attributes', () => {
  const uri = 'http://schemas.openxmlformats.org/presentationml/2006/main';
  const xml = `<p:sld xmlns:p="${uri}"><p:timing><p:tnLst><p:par><p:cTn id="1" nodeType="tmRoot"><p:childTnLst><p:seq><p:cTn id="2" nodeType="mainSeq"><p:childTnLst><p:par><p:cTn id="3"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst><p:childTnLst><p:par><p:cTn xmlns:p="${uri}" id="4" presetID="6" presetClass="emph" presetSubtype="0" fill="hold" grpId="0" nodeType="clickEffect"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:animScale><p:cBhvr><p:cTn id="5" dur="600" fill="hold"/><p:tgtEl><p:spTgt spid="4"/></p:tgtEl></p:cBhvr><p:by x="150000" y="150000"/></p:animScale></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing></p:sld>`;
  const result = parsePptxTiming(xml);
  expect(result.accepted).toBe(true);
  if (result.accepted) { expect(result.warnings ?? []).toEqual([]); expect(result.animation.steps[0].items[0].nativePreset?.verifiedSpeechMotion).toBe(true); }
});

it('keeps a native group effect on one wrapper around its exact descendants', () => {
  const page: SlidePageIR = { id: 'page', width: 960, height: 540, elements: [
    { id: 'text', type: 'text', sourceShapeId: '4', sourceGroupShapeIds: ['2'], left: 10, top: 20, width: 50, height: 30 },
    { id: 'image', type: 'image', sourceShapeId: '5', sourceGroupShapeIds: ['2'], left: 80, top: 20, width: 40, height: 30 },
  ], pptxAnimation: { steps: [{ id: 'auto', trigger: 'auto', items: [{ id: 'grow', target: { shapeId: '2' }, effect: 'grow150', animationType: 'attention', startAtMs: 500, durationMs: 600,
    nativePreset: { version: 1, class: 'emph', id: 6, verifiedSpeechMotion: true } }] }] } };
  const result = projectNativeTimeline(page, [{ objectId: 'uuid', sourceShapeId: '2' }]);
  expect(result?.groups).toEqual([{ elementId: 'native_group_uuid', children: ['text', 'image'] }]);
  expect(result?.steps[0].items[0]).toMatchObject({ elementId: 'native_group_uuid', effect: 'grow150', startAtMs: 500, durationMs: 600 });
});
