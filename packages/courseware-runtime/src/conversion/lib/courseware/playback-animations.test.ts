import { expect, it } from 'vitest';
import { projectPlaybackAnimations } from './playback-animations';
import { nativeTimelineSchema } from '../../../native-timeline';
import type { ImportWarning, SlidePageIR } from '../import/types';
import type { FixedBuildInput } from './fixed-build-input';

type Actions = FixedBuildInput['teaching']['pages'][number]['actions'];
const hash = 'a'.repeat(64);
const mapping = { pageId: 'page', importPageId: 'ir', objects: [{ objectId: 'title', importElementId: 'title-ir' }] };
const actions: Actions = [{ id: 'speech', type: 'speech', text: 'Title.', audioAssetId: 'audio', visualCues: [
  { id: 'fade', atMs: 0, endMs: 600, effect: { type: 'element_animation', elementId: 'title', effect: 'fadeIn' } },
] }];
const page: SlidePageIR = { id: 'ir', width: 960, height: 540, elements: [
  { id: 'title-ir', sourceShapeId: '2', type: 'shape', left: 10, top: 20, width: 100, height: 40 },
  { id: 'other-ir', sourceShapeId: '3', type: 'shape', left: 10, top: 100, width: 100, height: 40 },
], pptxAnimation: { steps: [
  { id: 'fade', trigger: 'click', items: [{ id: 'fade', target: { shapeId: '2' }, animationType: 'in', startAtMs: 0, durationMs: 600,
    nativePreset: { version: 1, class: 'entr', id: 10, verifiedSpeechMotion: true } }] },
  { id: 'old-pulse', trigger: 'click', items: [{ id: 'pulse', target: { shapeId: '2' }, animationType: 'attention', startAtMs: 0, durationMs: 600,
    nativePreset: { version: 1, class: 'emph', id: 26, verifiedSpeechMotion: true } }] },
  { id: 'other', trigger: 'click', items: [{ id: 'other', target: { shapeId: '3' }, animationType: 'in', startAtMs: 0, durationMs: 600,
    nativePreset: { version: 1, class: 'entr', id: 10, verifiedSpeechMotion: true } }] },
] } };

it('keeps the saved speech clock after an old editor left a withdrawn title pulse, retaining other native effects', () => {
  const before = structuredClone(page), diagnostics: ImportWarning[] = [];
  const result = projectPlaybackAnimations(page, actions, mapping, hash, diagnostics, 1);
  expect(result.nativeTimeline?.steps.flatMap(step => step.items.map(item => item.elementId))).toEqual(['other-ir']);
  expect(diagnostics).toMatchObject([{ code: 'PPTX_ANIMATION_SPEECH_OWNED', pageIndex: 1 }]);
  expect(page).toEqual(before);
});

it('does not silently replace an explicitly bound native sequence', () => {
  expect(() => projectPlaybackAnimations(page, [{ id: 'bound', type: 'native_animation', version: 1, sourceSha256: hash, stepIndex: 0 }, ...actions], mapping, hash, [], 0)).toThrow();
});

it('uses one shared wrapper for a multi-part circle pulse without requiring a native click', () => {
  const source: SlidePageIR = { ...page, pptxAnimation: undefined, elements: page.elements.map(element => ({ ...element, sourceGroupShapeIds: ['42'] })) };
  const result = projectPlaybackAnimations(source, [{ id: 'speech', type: 'speech', audioAssetId: 'audio', text: 'Circle.', visualCues: [
    { id: 'pulse', atMs: 0, endMs: 600, effect: { type: 'element_animation', elementId: 'circle', effect: 'pulse' } },
  ] }], { ...mapping, groups: [{ objectId: 'circle', sourceShapeId: '42' }] }, hash, [], 0);
  expect(result.nativeTimeline).toEqual({ version: 1, steps: [], groups: [{ elementId: 'native_group_circle', children: ['title-ir', 'other-ir'] }] });
  expect(nativeTimelineSchema.safeParse(result.nativeTimeline).success).toBe(true);
  expect(nativeTimelineSchema.safeParse({ version: 1, steps: [] }).success).toBe(false);
});

it('preflight rejects missing actual targets before creating a playback build', () => {
  expect(() => projectPlaybackAnimations({ ...page, elements: [] }, actions, mapping, hash, [], 0)).toThrow('EFFECT_BINDING_MISMATCH');
});

it('uses a single native timeline when speech group motion coexists with an unrelated native click', () => {
  const source: SlidePageIR = { ...page, elements: page.elements.map((element, index) => ({ ...element, ...(index ? {} : {sourceGroupShapeIds:['42']}) })),
    pptxAnimation: { steps: [{ ...page.pptxAnimation!.steps[2], items: [{ ...page.pptxAnimation!.steps[2].items[0], effect: 'fade' }] }] } };
  const result = projectPlaybackAnimations(source, [{ id: 's', type: 'speech', audioAssetId: 'audio', text: 'Group', visualCues: [
    {id:'pulse', atMs:0,endMs:600,effect:{type:'element_animation',elementId:'group',effect:'pulse'}},
  ] }], {...mapping,groups:[{objectId:'group',sourceShapeId:'42'}]},hash,[],0);
  expect(result.nativeAnimations).toBeUndefined();
  expect(result.nativeTimeline?.steps[0].items[0].elementId).toBe('other-ir');
  expect(result.nativeTimeline?.groups?.[0].children).toEqual(['title-ir']);
});
