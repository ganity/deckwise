import { expect, it } from 'vitest';
import { validSpeechAnimationSequence } from './speech-animation-sequence';

it('allows serial emphasis but refuses duplicate owners within speech, repeated entrances and emphasis after an exit', () => {
  const speech = (...effects: string[]) => ({ type: 'speech', visualCues: effects.map(effect => ({ effect: { type: 'element_animation', elementId: 'monkey', effect } })) });
  expect(validSpeechAnimationSequence([speech('fadeIn'), speech('pulse'), speech('pulse')])).toBe(true);
  expect(validSpeechAnimationSequence([speech('pulse'), speech('pulse')])).toBe(true);
  for (const actions of [[speech('pulse', 'pulse')], [speech('fadeIn'), speech('fadeIn')], [speech('fadeOut'), speech('pulse')]])
    expect(validSpeechAnimationSequence(actions)).toBe(false);
});
