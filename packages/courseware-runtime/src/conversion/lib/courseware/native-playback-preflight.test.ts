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
  expect(inspectNativePlayback(source,'a'.repeat(64),pages,identity).ready).toBe(true);
  expect({source,pages}).toEqual(before);
  pages[0].actions[0].visualCues[0].effect.elementId='absent';
  const invalid=inspectNativePlayback(source,'a'.repeat(64),pages,identity);
  expect(invalid.ready).toBe(false);
  expect(invalid.issues).toMatchObject([{code:'EFFECT_BINDING_MISMATCH',pageNumber:1,pageId:'p'}]);
});
