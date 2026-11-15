import { z } from 'zod';

/** A step ordinal is valid only in its exact saved source and logical page. */
export const nativeAnimationNodeSchema = z.object({
  id: z.string().regex(/^[\w.-]{1,128}$/),
  type: z.literal('native_animation'),
  version: z.literal(1),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  stepIndex: z.number().int().min(0).max(199),
}).strict();

export function validateNativeAnimationBindings(
  actions: readonly { type: string }[], sourceSha256: string, stepCount: number,
): boolean {
  const nodes = actions.filter(action => action.type === 'native_animation');
  return nodes.length === stepCount && stepCount > 0 && nodes.every((node, index) => {
    const parsed = nativeAnimationNodeSchema.safeParse(node);
    return parsed.success && parsed.data.sourceSha256 === sourceSha256 && parsed.data.stepIndex === index;
  });
}
