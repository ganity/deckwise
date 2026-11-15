import { it as test, expect } from 'vitest';
import { isCoursewareSpeechTrigger, rebaseSpeechTrigger } from './courseware-speech-trigger.js';
import { isCoursewareAttentionCue, replaceNarrationText } from './courseware-editor.js';
test('semantic speech anchors survive text editing while recorded audio is invalidated', () => {
  const trigger = { version: 1 as const, kind: 'text' as const, text: 'dog', start: 0, end: 3, phase: 'after' as const, audioAssetId: 'audio' };
  expect(isCoursewareSpeechTrigger(trigger)).toBe(true);
  expect(isCoursewareSpeechTrigger({ ...trigger, end: 2 })).toBe(false);
  const cue = { id: 'cue', atMs: 500, endMs: 1100, trigger, nativeAnimation: 'dog', effect: { type: 'element_animation', elementId: 'dog', effect: 'fadeIn' } };
  expect(isCoursewareAttentionCue(cue)).toBe(true);
  const changed = replaceNarrationText({ id: 'speech', type: 'speech', text: 'dog', audioAssetId: 'audio', visualCues: [cue] }, 'a dog');
  expect(changed.audioAssetId).toBeUndefined();
  expect((changed.visualCues as Array<{ trigger: unknown }>)[0].trigger).toEqual({ ...trigger, start: 2, end: 5, stale: true });
  expect(rebaseSpeechTrigger({ version: 1, kind: 'end' }, 'new')).toEqual({ version: 1, kind: 'end' });
});
