import { expect, it } from 'vitest';
import { sequenceSpeechFocus } from './speech-focus-timeline.js';

it('keeps an intentional group entrance, the calibrated emphasis and the primary spotlight', () => {
  const motion = (id: string, object: string, effect: string, atMs: number, endMs: number) =>
    ({ id, atMs, endMs, effect: { type: 'element_animation', elementId: object, effect } });
  const cues = [
    motion('pulse', 'left', 'pulse', 0, 600), motion('left', 'left', 'fadeIn', 0, 600),
    motion('right', 'right', 'fadeIn', 0, 600), motion('duplicate', 'left', 'fadeIn', 0, 600),
    motion('later', 'left', 'pulse', 1800, 2200),
    { id: 'word', atMs: 600, endMs: 1700, effect: { type: 'highlight' } },
    { id: 'figure', atMs: 600, endMs: 1400, effect: { type: 'spotlight' } },
  ];
  const result = sequenceSpeechFocus(cues);
  expect(result.map(c => [c.id,c.atMs,c.endMs])).toEqual([
    ['left',0,600],['right',0,600],['later',1800,2200],['word',1400,1700],['figure',600,1400],
  ]);
  expect(sequenceSpeechFocus(result)).toEqual(result);
});
