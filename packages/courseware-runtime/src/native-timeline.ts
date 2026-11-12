import { z } from 'zod';

/** Finite, verified Office main-sequence presets; no script or arbitrary keyframes. */
export const nativeTimelineSchema = z.object({
  version: z.literal(1),
  groups: z.array(z.object({ elementId: z.string().min(1).max(200), children: z.array(z.string().min(1).max(200)).min(1).max(10000) }).strict()).max(200).optional(),
  steps: z.array(z.object({
    id: z.string().min(1).max(128).regex(/^[\w.-]+$/),
    trigger: z.enum(['auto', 'click']),
    items: z.array(z.object({
      elementId: z.string().min(1).max(200),
      effect: z.enum(['appear', 'fadeIn', 'fadeOut', 'grow150', 'bounceInBottom', 'wipeDown', 'scaleIn', 'pulse', 'zoomIn', 'slideInLeft', 'slideInRight', 'gentleRotate']),
      animationType: z.enum(['in', 'out', 'attention']),
      distance: z.number().positive().max(10000).optional(),
      durationMs: z.number().int().min(1).max(5000),
      startAtMs: z.number().int().min(0).max(30000),
    }).strict().refine(item => item.startAtMs + item.durationMs <= 60000 &&
      (item.effect === 'bounceInBottom' ? item.distance !== undefined : item.distance === undefined) &&
      item.animationType === (['appear', 'fadeIn', 'bounceInBottom', 'wipeDown', 'scaleIn', 'zoomIn', 'slideInLeft', 'slideInRight'].includes(item.effect) ? 'in' : item.effect === 'fadeOut' ? 'out' : 'attention'))).min(1).max(200),
  }).strict()).max(200),
}).strict().refine(value => (value.steps.length > 0 || !!value.groups?.length) && new Set(value.steps.map(step => step.id)).size === value.steps.length &&
  value.steps.reduce((count, step) => count + step.items.length, 0) <= 200);
export type NativeTimeline = z.infer<typeof nativeTimelineSchema>;
