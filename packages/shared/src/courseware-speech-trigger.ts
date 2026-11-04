/** Semantic position plus the audio against which a text boundary was calibrated. */
export type CoursewareSpeechTrigger =
  | { version: 1; kind: 'start' | 'end' }
  | { version: 1; kind: 'text'; text: string; start: number; end: number; phase: 'with' | 'after'; audioAssetId: string; stale?: true };

export function isCoursewareSpeechTrigger(value: unknown): value is CoursewareSpeechTrigger {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return false;
  if (v.kind === 'start' || v.kind === 'end') return Object.keys(v).length === 2;
  return v.kind === 'text' && Object.keys(v).every(k => ['version', 'kind', 'text', 'start', 'end', 'phase', 'audioAssetId', 'stale'].includes(k)) &&
    typeof v.text === 'string' && !!v.text.trim() && v.text.length <= 32000 &&
    Number.isInteger(v.start) && Number(v.start) >= 0 && Number.isInteger(v.end) && Number(v.end) > Number(v.start) && Number(v.end) <= 32000 &&
    v.text.length === Number(v.end) - Number(v.start) && ['with', 'after'].includes(String(v.phase)) &&
    typeof v.audioAssetId === 'string' && /^[\w.-]{1,128}$/u.test(v.audioAssetId) && (v.stale === undefined || v.stale === true);
}

/** Keep intentions, never old audio timing, when narration is edited. */
export function rebaseSpeechTrigger(trigger: CoursewareSpeechTrigger, text: string): CoursewareSpeechTrigger {
  if (trigger.kind !== 'text') return trigger;
  const start = text.indexOf(trigger.text);
  const unique = start >= 0 && text.indexOf(trigger.text, start + 1) < 0;
  return unique ? { ...trigger, start, end: start + trigger.text.length, stale: true } : { ...trigger, stale: true };
}
