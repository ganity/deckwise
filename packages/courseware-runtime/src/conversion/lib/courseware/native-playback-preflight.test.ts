import { expect, it } from 'vitest';
import { inspectNativePlayback } from './native-playback-preflight';
import type { SlideIR } from '../import/types';

it('validates actual saved targets before completion and reports the affected page without changing teaching or IR', () => {
  const source: SlideIR = { schemaVersion: 'slide-ir/1', pages: [{id:'ir',width:960,height:540,elements:[
    {id:'circle',sourceShapeId:'2',type:'shape',left:0,top:0,width:40,height:40},
  ]}] };
  const pages = [{pageId:'p',locked:false,actions:[{id:'speech',type:'speech',text:'Circle',durationMs:1500,audioAssetId:'audio',source:'generated',
    visualCues:[{id:'pulse',atMs:0,endMs:600,effect:{type:'element_animation',elementId:'logical',effect:'pulse'}}]}]}];
  const identity = {pages:[{pageId:'p',objects:[{logicalId:'logical',sourceShapeId:'2'}]}]};
  const before=structuredClone({source,pages});
  expect(inspectNativePlayback(source,'a'.repeat(64),pages,identity)).toMatchObject({ ready: false,
    issues: [{ code: 'NATIVE_SPEECH_ANIMATION_MISSING', pageNumber: 1, pageId: 'p' }] });
  source.pages[0].pptxAnimation = { steps: [{ id: 'mirror', trigger: 'click', items: [{ id: 'pulse', target: { shapeId: '2' },
    animationType: 'attention', startAtMs: 0, durationMs: 600, nativePreset: { version: 1, class: 'emph', id: 26, subtype: 0, verifiedSpeechMotion: true } }] }] };
  expect(inspectNativePlayback(source,'a'.repeat(64),pages,identity).ready).toBe(true);
  expect(pages).toEqual(before.pages);
  pages[0].actions[0].visualCues[0].effect.elementId='absent';
  const invalid=inspectNativePlayback(source,'a'.repeat(64),pages,identity);
  expect(invalid.ready).toBe(false);
  expect(invalid.issues).toMatchObject([{code:'EFFECT_BINDING_MISMATCH',pageNumber:1,pageId:'p'}]);
});

it('reports blocking parser diagnostics during generation preflight', () => {
  const source: SlideIR = { schemaVersion: 'slide-ir/1', warnings: [{ code: 'PPTX_NOTES_MASTER_UNVERIFIED', severity: 'error', message: 'Custom master' }],
    pages: [{ id: 'ir', width: 960, height: 540, elements: [] }] };
  const pages = [{ pageId: 'p', actions: [] }];
  const identity = { pages: [{ pageId: 'p', objects: [] }] };
  expect(inspectNativePlayback(source, 'a'.repeat(64), pages, identity)).toMatchObject({ ready: false,
    issues: [{ code: 'PPTX_NOTES_MASTER_UNVERIFIED', pageNumber: 0, pageId: 'source' }] });
});

it('uses the fixed player slide schema before generation can report completion', () => {
  const source: SlideIR = { schemaVersion: 'slide-ir/1', pages: [{ id: 'ir', width: 960, height: 540, elements: [
    { id: 'bad', sourceShapeId: '2', type: 'shape', left: 0, top: 0, width: -40, height: 40 },
  ] }] };
  const pages = [{ pageId: 'p', actions: [{ id: 'speech', type: 'speech', text: 'Hello', durationMs: 1000, audioAssetId: 'audio' }] }];
  const identity = { pages: [{ pageId: 'p', objects: [{ logicalId: 'logical', sourceShapeId: '2' }] }] };
  expect(inspectNativePlayback(source, 'a'.repeat(64), pages, identity)).toMatchObject({ ready: false,
    issues: [{ code: 'PACKAGE_SCHEMA_INVALID', pageNumber: 1, pageId: 'p' }] });
});

it('preserves inherited artwork without treating it as a native teaching target', () => {
  const source: SlideIR = { schemaVersion: 'slide-ir/1', pages: [{ id: 'ir', width: 960, height: 540, elements: [
    { id: 'title', sourceShapeId: '2', type: 'text', content: 'Title', left: 0, top: 0, width: 100, height: 40 },
    { id: 'pptx_fallback_layout_shape_2', type: 'shape', left: 10, top: 50, width: 40, height: 40 },
    { id: 'pptx_fallback_master_shape_3', type: 'shape', left: 50, top: 50, width: 40, height: 40 },
  ] }] };
  const pages = [{ pageId: 'p', actions: [{ id: 'speech', type: 'speech', text: 'Title', durationMs: 1000, audioAssetId: 'audio',
    visualCues: [{ id: 'focus', atMs: 0, endMs: 500, effect: { type: 'spotlight', elementId: 'logical' } }] }] }];
  const identity = { pages: [{ pageId: 'p', objects: [{ logicalId: 'logical', sourceShapeId: '2' }] }] };
  expect(inspectNativePlayback(source, 'a'.repeat(64), pages, identity).ready).toBe(true);
  source.pages[0].elements[1].id = 'unidentified_slide_shape';
  expect(() => inspectNativePlayback(source, 'a'.repeat(64), pages, identity)).toThrow('OBJECT_BINDING_MISMATCH');
});

it('checks saved group mirrors before playback projection consumes them', () => {
  const source: SlideIR = { schemaVersion: 'slide-ir/1', pages: [{ id: 'ir', width: 960, height: 540, elements: [
    { id: 'a', sourceShapeId: '2', sourceGroupShapeIds: ['9'], type: 'shape', left: 0, top: 0, width: 40, height: 40 },
    { id: 'b', sourceShapeId: '3', sourceGroupShapeIds: ['9'], type: 'shape', left: 50, top: 0, width: 40, height: 40 },
  ], pptxAnimation: { steps: [{ id: 'saved', trigger: 'click', items: [{ id: 'fade', target: { shapeId: '9' },
    animationType: 'in', startAtMs: 0, durationMs: 600,
    nativePreset: { version: 1, class: 'entr', id: 10, subtype: 0, verifiedSpeechMotion: true } }] }] } }] };
  const pages = [{ pageId: 'p', actions: [{ id: 'speech', type: 'speech', text: 'Both shapes', durationMs: 1000, audioAssetId: 'audio',
    visualCues: [{ id: 'cue', atMs: 0, endMs: 600, effect: { type: 'element_animation', elementId: 'group', effect: 'fadeIn' } }] }] }];
  const identity = { pages: [{ pageId: 'p', objects: [
    { logicalId: 'one', sourceShapeId: '2' }, { logicalId: 'two', sourceShapeId: '3' }, { logicalId: 'group', sourceShapeId: '9' },
  ] }] };
  const before = structuredClone({ source, pages });
  expect(inspectNativePlayback(source, 'a'.repeat(64), pages, identity)).toMatchObject({ ready: true, issues: [] });
  expect({ source, pages }).toEqual(before);
  Object.assign(pages[0].actions[0].visualCues[0], {atMs: 300, endMs: 900});
  expect(inspectNativePlayback(source, 'a'.repeat(64), pages, identity)).toMatchObject({
    ready: false, issues: [{code: 'NATIVE_SPEECH_ANIMATION_MISSING', pageNumber: 1, message: expect.stringContaining('同类动画在 0 ms 开始')}],
  });
  source.pages[0].pptxAnimation!.steps[0].items[0].startAtMs = 300;
  expect(inspectNativePlayback(source, 'a'.repeat(64), pages, identity).ready).toBe(true);
});
