import { expect, it } from 'vitest';
import type { ImportWarning, SlidePageIR } from '../import/types';
import { fallbackNativeTimeline, resolveSingleChildSpeechAnimations } from './native-animation-fallback';
import type { FixedBuildInput } from './fixed-build-input';

it('keeps supported effects, fades unsupported safe targets and skips ambiguous or speech-owned targets', () => {
  const page: SlidePageIR = { id: 'page', width: 960, height: 540,
    elements: ['safe', 'speech', 'duplicate', 'duplicate'].map((id, i) => ({ id: `${id}-${i}`, sourceShapeId: id,
      type: 'shape', left: 0, top: 0, width: 40, height: 40 })),
    pptxAnimation: { steps: [{ id: 'step', trigger: 'auto', items: [
      { id: 'supported', target: { shapeId: 'safe' }, animationType: 'attention', startAtMs: 0, durationMs: 600,
        nativePreset: { version: 1, class: 'emph', id: 26, verifiedSpeechMotion: true } },
      ...['safe', 'speech', 'duplicate', 'missing'].map(shapeId => ({ id: shapeId, target: { shapeId },
        animationType: 'attention' as const, startAtMs: 600, durationMs: 800,
        nativePreset: { version: 1 as const, class: 'emph', id: 999 } })),
    ] }] } };
  const before = structuredClone(page), diagnostics: ImportWarning[] = [];
  const result = fallbackNativeTimeline(page, [], new Set(['speech-1']), diagnostics, 2);
  expect(result?.steps[0].items).toEqual([
    { elementId: 'safe-0', effect: 'pulse', animationType: 'attention', durationMs: 600, startAtMs: 0 },
    { elementId: 'safe-0', effect: 'fadeIn', animationType: 'in', durationMs: 500, startAtMs: 600 },
  ]);
  expect(diagnostics.map(d => d.code)).toEqual(['PPTX_ANIMATION_FALLBACK_FADE',
    'PPTX_ANIMATION_SKIPPED', 'PPTX_ANIMATION_SKIPPED', 'PPTX_ANIMATION_SKIPPED']);
  expect(diagnostics.every(d => d.pageIndex === 2)).toBe(true);
  expect(page).toEqual(before);
});

it('keeps a static page when no animation target can be resolved', () => {
  const page: SlidePageIR = { id: 'page', width: 960, height: 540, elements: [], pptxAnimation: {
    steps: [{ id: 'click', trigger: 'click', items: [{ id: 'item', animationType: 'in', startAtMs: 0, durationMs: 500 }] }] } };
  const diagnostics: ImportWarning[] = [];
  expect(fallbackNativeTimeline(page, [], new Set(), diagnostics, 0)).toBeUndefined();
  expect(diagnostics[0].code).toBe('PPTX_ANIMATION_SKIPPED');
});

it('resolves only unlinked speech animation on a single-child group', () => {
  const input: FixedBuildInput = { schemaVersion: 'deckwise-fixed-build-input/1',
    mapping: { pages: [{ pageId: 'page', importPageId: 'ir', objects: [{ objectId: 'child', importElementId: 'shape' }],
      groups: [{ objectId: 'group', sourceShapeId: '4' }] }] }, teaching: { pages: [{ pageId: 'page', actions: [
      { id: 'speech', type: 'speech', text: 'Look.', visualCues: [
        { id: 'motion', atMs: 0, endMs: 500, effect: { type: 'element_animation', elementId: 'group', effect: 'fadeIn' } },
        { id: 'linked', atMs: 0, endMs: 500, nativeAnimation: 'group', effect: { type: 'element_animation', elementId: 'group', effect: 'fadeIn' } },
      ] },
    ] }] } } as FixedBuildInput;
  const page: SlidePageIR = { id: 'ir', width: 960, height: 540, elements: [
    { id: 'shape', sourceGroupShapeIds: ['4'], type: 'shape', left: 0, top: 0, width: 20, height: 20 },
  ] };
  const ambiguous = structuredClone(input);
  resolveSingleChildSpeechAnimations(input, [page]);
  const speech = input.teaching.pages[0].actions[0];
  expect(speech.type === 'speech' && speech.visualCues?.map(c => c.effect)).toMatchObject([
    { elementId: 'child' }, { elementId: 'group' },
  ]);
  resolveSingleChildSpeechAnimations(ambiguous, [{ ...page, elements: [...page.elements, { ...page.elements[0], id: 'second' }] }]);
  const unchanged = ambiguous.teaching.pages[0].actions[0];
  expect(unchanged.type === 'speech' && unchanged.visualCues?.[0].effect).toMatchObject({ elementId: 'group' });
});
