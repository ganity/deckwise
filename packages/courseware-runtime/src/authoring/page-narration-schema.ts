import { z } from 'zod';

const spokenText = z
  .string()
  .trim()
  .min(1)
  .max(8000)
  .refine(
    (text) =>
      !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]|\[(?:wait|pause|praise|等待|停顿|表扬)[^\]]*\]|<(?:wait|pause|praise)\b/iu.test(
        text,
      ),
    'Control markers belong in structured blocks, never in speech',
  );
export const pageNarrationOutputSchema = z
  .object({
    blocks: z
      .array(
        z.union([
          z.object({ type: z.literal('speech'), text: spokenText }).strict(),
          z.object({ type: z.literal('english_phrase'), text: z.string().trim().min(1).max(80) }).strict(),
          z.object({ type: z.literal('wait'), mode: z.literal('fixed').optional(), durationMs: z.number().int().min(500).max(60000) }).strict(),
          z.object({ type: z.literal('wait'), mode: z.literal('teacher_continue') }).strict(),
          z
            .object({
              type: z.literal('praise'),
              text: z.enum([
                '谢谢你的尝试。',
                '谢谢大家的参与。',
                'Thank you for trying.',
                'Thank you for joining in.',
              ]),
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .refine(
    (value) => value.blocks.some((block) => block.type === 'speech'),
    'Narration requires speech',
  )
  .refine(
    (value) => value.blocks.filter((block) => block.type === 'praise').length <= 1,
    'Narration allows at most one praise block per page',
  )
  .refine(
    (value) => value.blocks.filter((block) => block.type === 'english_phrase').length <= 2,
    'Narration allows at most two English phrases per page',
  );
