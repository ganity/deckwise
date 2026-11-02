import { z } from 'zod';

export const questionResponseSchema = z.object({
  kind: z.enum(['single', 'multiple', 'judge', 'short_answer', 'discussion', 'practice', 'pbl']),
  options: z.array(z.string().trim().min(1).max(500)).max(8),
  answerIndices: z.array(z.number().int().min(0).max(7)).max(8),
}).strict().refine(v => new Set(v.options).size === v.options.length &&
  new Set(v.answerIndices).size === v.answerIndices.length && v.answerIndices.every(i => i < v.options.length) &&
  (['single', 'multiple', 'judge'].includes(v.kind)
    ? v.options.length >= 2 && (v.kind !== 'judge' || v.options.length === 2) &&
      (v.kind === 'multiple' ? v.answerIndices.length >= 1 : v.answerIndices.length === 1)
    : v.options.length === 0 && v.answerIndices.length === 0), 'Invalid question options or answer key');
export type QuestionResponse = z.infer<typeof questionResponseSchema>;

/** Closed questions use their saved key. Open activities require teacher assessment. */
export function evaluateQuestionAnswer(response: QuestionResponse, selected: number[]): boolean | null {
  questionResponseSchema.parse(response);
  if (!Array.isArray(selected) || new Set(selected).size !== selected.length || selected.some(i => !Number.isInteger(i) || i < 0 || i >= response.options.length))
    throw new Error('Invalid selected answers');
  if (!['single', 'multiple', 'judge'].includes(response.kind)) return null;
  if (response.kind !== 'multiple' && selected.length > 1) throw new Error('Choose one answer');
  return selected.length === response.answerIndices.length && selected.every(i => response.answerIndices.includes(i));
}
