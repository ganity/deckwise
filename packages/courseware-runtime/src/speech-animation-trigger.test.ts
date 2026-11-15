import { expect, it } from 'vitest';
import { resolveSpeechAnimationCue, speechAnimationTriggerSchema } from './speech-animation-trigger';
it('uses actual decoded duration for sentence boundaries and calibrated audio time for words', () => {
  const cue = { atMs: 1200, endMs: 1800 };
  expect(resolveSpeechAnimationCue({ ...cue, trigger: { version: 1, kind: 'start' } }, '小狗', 'a', 9000)).toMatchObject({ atMs: 0, endMs: 600 });
  expect(resolveSpeechAnimationCue({ ...cue, trigger: { version: 1, kind: 'end' } }, '小狗', 'a', 9000)).toMatchObject({ atMs: 9000, endMs: 9600 });
  for (const phase of ['with', 'after'] as const) {
    const trigger = { version: 1 as const, kind: 'text' as const, start: 2, end: 4, text: '小狗', phase, audioAssetId: 'a' };
    expect(resolveSpeechAnimationCue({ ...cue, trigger }, '看见小狗', 'a', 9000)).toMatchObject(cue);
    expect(() => resolveSpeechAnimationCue({ ...cue, trigger }, '看见小狗', 'b', 9000)).toThrow('RECALIBRATION');
    expect(() => resolveSpeechAnimationCue({ ...cue, trigger: { ...trigger, stale: true } }, '看见小狗', 'a', 9000)).toThrow('RECALIBRATION');
  }
  expect(speechAnimationTriggerSchema.safeParse({ version: 1, kind: 'text', start: 0, end: 1, text: 'dog', phase: 'before', audioAssetId: 'a' }).success).toBe(false);
});

it('retains whitespace and UTF-16 ranges of the exact selected text', () => {
  const cue = { atMs: 400, endMs: 1000, trigger: { version: 1 as const, kind: 'text' as const,
    text: ' Hello 👋 ', start: 1, end: 11, phase: 'with' as const, audioAssetId: 'audio' } };
  expect(resolveSpeechAnimationCue(cue, 'x Hello 👋 y', 'audio', 2000)).toEqual(cue);
});
