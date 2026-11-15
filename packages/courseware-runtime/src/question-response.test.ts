import { expect, it } from 'vitest';
import { evaluateQuestionAnswer } from './question-response';
it('scores only saved closed questions, rejects forged selections, and leaves open activity assessment to the teacher', () => {
  const question = { kind: 'multiple' as const, options: ['Monkey', 'Panda', 'Tree'], answerIndices: [0, 1] };
  expect(evaluateQuestionAnswer(question, [1, 0])).toBe(true);
  expect(evaluateQuestionAnswer(question, [0])).toBe(false);
  expect(evaluateQuestionAnswer(question, [0, 2])).toBe(false);
  expect(() => evaluateQuestionAnswer(question, [0, 0])).toThrow();
  expect(() => evaluateQuestionAnswer(question, [3])).toThrow();
  for (const kind of ['short_answer', 'discussion', 'practice', 'pbl'] as const)
    expect(evaluateQuestionAnswer({ kind, options: [], answerIndices: [] }, [])).toBeNull();
});
