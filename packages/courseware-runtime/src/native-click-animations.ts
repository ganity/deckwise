import { z } from "zod";

/** Finite fixed-package projection of saved Office entrance clicks, independent of speech cues. */
export const nativeClickAnimationsSchema = z.object({
  version: z.literal(1),
  sequence: z.literal("before-narration"),
  steps: z.array(z.object({
    id: z.string().min(1).max(128).regex(/^[\w.-]+$/),
    trigger: z.literal("click"),
    elementId: z.string().min(1).max(200),
    effect: z.enum(["appear", "fade"]),
    durationMs: z.number().int().min(1).max(5000),
  }).strict()).min(1).max(200),
}).strict().refine(value => new Set(value.steps.map(step => step.id)).size === value.steps.length);

export type NativeClickAnimations = z.infer<typeof nativeClickAnimationsSchema>;
