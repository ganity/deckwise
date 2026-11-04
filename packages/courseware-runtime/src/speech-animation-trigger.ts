import { z } from 'zod';

export const speechAnimationTriggerSchema = z.union([
  z.object({ version: z.literal(1), kind: z.enum(['start', 'end']) }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('text'), text: z.string().min(1).max(32000).refine(text => text.trim().length > 0),
    start: z.number().int().min(0).max(31999), end: z.number().int().min(1).max(32000), phase: z.enum(['with', 'after']),
    audioAssetId: z.string().regex(/^[\w.-]{1,128}$/), stale: z.literal(true).optional(),
  }).strict().refine(t => t.end - t.start === t.text.length),
]);
export type SpeechAnimationTrigger = z.infer<typeof speechAnimationTriggerSchema>;
export type TimedSpeechCue = { atMs: number; endMs: number; trigger?: SpeechAnimationTrigger };

/** Text timing is recorded against the actual local audio, never estimated from character count. */
export function resolveSpeechAnimationCue<T extends TimedSpeechCue>(cue: T, text: string, audioAssetId: string, durationMs: number): T {
  if (!cue.trigger) return cue;
  const trigger = speechAnimationTriggerSchema.parse(cue.trigger);
  if (!Number.isFinite(durationMs) || durationMs < 1) throw new Error('SPEECH_TIMING_AUDIO_REQUIRED');
  const duration = cue.endMs - cue.atMs;
  if (trigger.kind === 'text' && (trigger.stale || trigger.audioAssetId !== audioAssetId ||
      text.slice(trigger.start, trigger.end) !== trigger.text || cue.atMs > durationMs))
    throw new Error('SPEECH_TIMING_RECALIBRATION_REQUIRED');
  const atMs = trigger.kind === 'start' ? 0 : trigger.kind === 'end' ? Math.round(durationMs) : cue.atMs;
  return { ...cue, atMs, endMs: atMs + duration };
}
