import { z } from 'zod';
import type { Scene, Stage } from './maic-types/stage';
import { collectMaicResources } from './maic-resources';

/** MAIC classroom content; local source bindings and task receipts are stored separately. */
export interface MaicMediaManifestEntry {
  sceneId?: string; elementId: string; assetId: string; assetType: 'image' | 'video' | 'audio';
  mimeType: string; src: string; originalSrc: string; zipPath?: string;
  posterAssetId?: string; posterUrl?: string; originalPosterUrl?: string; posterZipPath?: string;
}
export interface MaicAudioManifestEntry {
  sceneId: string; actionId: string; assetId: string; audioId: string; mimeType: string;
  url: string; originalUrl: string; zipPath?: string; timingTrack?: unknown;
}
export interface MaicClassroom {
  id: string; tenantId?: number; stage: Stage; scenes: Scene[]; createdAt: string; updatedAt?: string;
  revisionId?: string; version?: number; status?: string; metadata?: Record<string, unknown>;
  agents?: unknown[]; mediaManifest?: MaicMediaManifestEntry[]; audioManifest?: MaicAudioManifestEntry[];
}
const id = z.string().min(1);
const image = z.object({ src: id, assetId: id.optional(), mimeType: id.optional() }).passthrough();
const question = z.object({
  id, type: z.enum(['single', 'multiple', 'judge', 'short_answer']), question: z.string(), image: image.optional(),
  options: z.array(z.object({ value: id, label: z.string(), image: image.optional() }).passthrough()).max(4).optional(),
  answer: z.array(id).optional(), analysis: z.string().optional(), commentPrompt: z.string().optional(),
  referenceAnswer: z.string().optional(), keyPoints: z.array(z.string()).optional(),
  hasAnswer: z.boolean().optional(), points: z.number().finite().optional(),
}).passthrough().superRefine((q, ctx) => {
  const values: string[] = q.options?.map(o => o.value) ?? [];
  if (new Set(values).size !== values.length) ctx.addIssue({ code: 'custom', message: 'Duplicate option value' });
  if (q.answer?.some(v => !values.includes(v)) && q.type !== 'short_answer')
    ctx.addIssue({ code: 'custom', message: 'Answer references missing option' });
  if (q.answer && new Set(q.answer).size !== q.answer.length)
    ctx.addIssue({ code: 'custom', message: 'Duplicate answer value' });
  if (q.type === 'judge' && values.length !== 2) ctx.addIssue({ code: 'custom', message: 'Judge requires two options' });
  if (q.type === 'judge' && values.some(v => !['T', 'F'].includes(v))) ctx.addIssue({ code: 'custom', message: 'Judge option values must be T/F' });
  if (['single', 'multiple'].includes(q.type) && values.some(v => !['A', 'B', 'C', 'D'].includes(v)))
    ctx.addIssue({ code: 'custom', message: 'Choice option values must be A-D' });
  if (['single', 'judge'].includes(q.type) && (q.answer?.length ?? 0) > 1)
    ctx.addIssue({ code: 'custom', message: 'Single answer required' });
});
const maicActions = new Set(['spotlight', 'laser', 'play_video', 'play_audio', 'element_animation', 'speech',
  'wb_open', 'wb_draw_text', 'wb_draw_shape', 'wb_draw_chart', 'wb_draw_latex', 'wb_draw_table', 'wb_draw_line',
  'wb_clear', 'wb_delete', 'wb_close', 'discussion', 'interaction_checkpoint']);
const number = z.number().finite();
const xy = { x: number, y: number };
const box = { ...xy, width: number, height: number };
const actionRequirements: Record<string, z.ZodType> = {
  spotlight: z.object({ elementId: id }), laser: z.object({ elementId: id }),
  play_video: z.object({ elementId: id }), play_audio: z.object({ elementId: id }),
  element_animation: z.object({ elementId: id, effect: id, animationType: z.enum(['in', 'out', 'attention']), duration: number.nonnegative(), pptistTrigger: z.enum(['click', 'meantime', 'auto']) }),
  speech: z.object({ text: z.string() }),
  wb_draw_text: z.object({ content: z.string(), ...xy }),
  wb_draw_shape: z.object({ shape: z.enum(['rectangle', 'circle', 'triangle']), ...box }),
  wb_draw_chart: z.object({ chartType: z.enum(['bar', 'column', 'line', 'pie', 'ring', 'area', 'radar', 'scatter']), ...box,
    data: z.object({ labels: z.array(z.string()), legends: z.array(z.string()), series: z.array(z.array(number)) }) }),
  wb_draw_latex: z.object({ latex: z.string(), ...xy }),
  wb_draw_table: z.object({ ...box, data: z.array(z.array(z.string())) }),
  wb_draw_line: z.object({ startX: number, startY: number, endX: number, endY: number }),
  wb_delete: z.object({ elementId: id }), discussion: z.object({ topic: z.string() }),
};
const action = z.object({ id, type: id }).passthrough().superRefine((a, ctx) => {
  if (!maicActions.has(a.type)) ctx.addIssue({ code: 'custom', message: `Non-MAIC action: ${a.type}` });
  if (['audioAssetId', 'visualCues', 'response', 'durationMs', 'videoAssetId'].some(key => key in a))
    ctx.addIssue({ code: 'custom', message: 'Local teaching fields cannot enter MAIC actions' });
  const required = actionRequirements[a.type]?.safeParse(a);
  if (required && !required.success) ctx.addIssue({ code: 'custom', message: `Invalid MAIC ${a.type}: ${required.error.message}` });
  if (a.type === 'interaction_checkpoint') {
    if (a.checkpointKind === 'chapter_summary') {
      const result = z.object({ checkpointId: id, chapterId: id, chapterTitle: z.string(), question: z.string(),
        constraintPrompt: z.string().optional(), referenceAnswer: z.object({ summary: z.string(), keyPoints: z.array(z.string()), label: z.string().optional() }).passthrough(),
        context: z.object({ chapterSummary: z.string(), sourceSceneIds: z.array(id), sourceOutlineIds: z.array(id).optional(), keyTerms: z.array(z.string()).optional() }).passthrough(),
      }).passthrough().safeParse(a);
      if (!result.success) ctx.addIssue({ code: 'custom', message: 'Invalid chapter interaction' });
    } else if (a.checkpointKind === 'media_playback') {
      const result = z.object({ checkpointId: id, elementId: id, mediaType: z.enum(['video', 'audio']),
        startMode: z.literal('teacher_triggered'), waitForCompletion: z.boolean() }).passthrough().safeParse(a);
      if (!result.success) ctx.addIssue({ code: 'custom', message: 'Invalid media checkpoint' });
    } else ctx.addIssue({ code: 'custom', message: 'Unsupported checkpoint kind' });
  }
});
const content = z.discriminatedUnion('type', [
  z.object({ type: z.literal('slide'), canvas: z.object({ id, viewportSize: number.positive(), viewportRatio: number.positive(),
    theme: z.object({ backgroundColor: z.string(), themeColors: z.array(z.string()), fontColor: z.string(), fontName: z.string() }).passthrough(),
    elements: z.array(z.object({ id, type: z.enum(['text', 'image', 'shape', 'line', 'chart', 'table', 'latex', 'video', 'audio']), left: number, top: number, width: number }).passthrough()) }).passthrough() }).passthrough(),
  z.object({ type: z.literal('quiz'), questions: z.array(question), interactionMode: z.enum(['assessment_review', 'classroom_instant_feedback']).optional(),
    playbackConfig: z.object({ introSpeechMode: z.literal('page_enter_only'), attemptPolicy: z.literal('until_correct'), successSpeechText: z.string(),
      failureSpeechText: z.string(), cueUserOnEnter: z.boolean(), cueUserOnRetry: z.boolean() }).passthrough().optional() }).passthrough(),
  z.object({ type: z.literal('interactive'), url: z.string() }).passthrough(),
  z.object({ type: z.literal('pbl'), projectConfig: z.object({}).passthrough() }).passthrough(),
]);
export const maicClassroomSchema = z.object({
  id, tenantId: number.optional(), updatedAt: z.string().optional(), revisionId: id.optional(), version: number.optional(), status: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(), agents: z.array(z.unknown()).optional(),
  stage: z.object({ id, name: z.string(), createdAt: number, updatedAt: number,
    canvas: z.object({ preset: z.enum(['WIDE_16_9', 'KINDERGARTEN_16_10']), viewportSize: number.positive(), viewportRatio: number.positive() }).passthrough().optional() }).passthrough(),
  scenes: z.array(z.object({ id, stageId: id, type: z.enum(['slide', 'quiz', 'interactive', 'pbl']), title: z.string(), order: z.number(),
    content, actions: z.array(action).optional() }).passthrough()), createdAt: z.string(),
  mediaManifest: z.array(z.object({ sceneId: id.optional(), elementId: id, assetId: id, assetType: z.enum(['image', 'video', 'audio']),
    mimeType: id, src: id, originalSrc: z.string(), zipPath: id.optional() }).passthrough()).optional(),
  audioManifest: z.array(z.object({ sceneId: id, actionId: id, assetId: id, audioId: id, mimeType: id, url: id, originalUrl: z.string(), zipPath: id.optional() }).passthrough()).optional(),
}).passthrough().superRefine((c, ctx) => {
  if (new Set(c.scenes.map(s => s.id)).size !== c.scenes.length) ctx.addIssue({ code: 'custom', message: 'Duplicate scene ID' });
  for (const scene of c.scenes) {
    if (scene.stageId !== c.stage.id || scene.type !== scene.content.type) ctx.addIssue({ code: 'custom', message: `Scene/content mismatch: ${scene.id}` });
    if (new Set((scene.actions ?? []).map(a => a.id)).size !== (scene.actions ?? []).length) ctx.addIssue({ code: 'custom', message: `Duplicate action ID: ${scene.id}` });
    if (scene.content.type === 'quiz' && new Set(scene.content.questions.map(q => q.id)).size !== scene.content.questions.length)
      ctx.addIssue({ code: 'custom', message: `Duplicate question ID: ${scene.id}` });
    if (scene.content.type === 'quiz' && scene.content.interactionMode === 'classroom_instant_feedback' && scene.content.questions.length > 1)
      ctx.addIssue({ code: 'custom', message: `Instant Quiz accepts one question: ${scene.id}` });
  }
  const targets = new Set<string>();
  for (const entry of c.audioManifest ?? []) {
    const target = `${entry.sceneId}:${entry.actionId}`;
    const speech = c.scenes.find(s => s.id === entry.sceneId)?.actions?.find(a => a.id === entry.actionId && a.type === 'speech');
    if (!speech) ctx.addIssue({ code: 'custom', message: `Missing MAIC speech target: ${target}` });
    if (speech?.audioId && speech.audioId !== entry.audioId) ctx.addIssue({ code: 'custom', message: `Mismatched MAIC audio ID: ${target}` });
    if (targets.has(target)) ctx.addIssue({ code: 'custom', message: `Duplicate MAIC audio target: ${target}` });
    targets.add(target);
  }
  const sceneResources = new Map(c.scenes.map(scene => [scene.id, collectMaicResources(scene.content)]));
  for (const entry of c.mediaManifest ?? []) {
    const scenes = entry.sceneId ? c.scenes.filter(s => s.id === entry.sceneId) : c.scenes;
    // MAIC has synthetic targets for Quiz images and backgrounds. Require an actual
    // resource occurrence as well as its optional scene binding, not a renderer ID.
    if (!scenes.some(s => sceneResources.get(s.id)?.has(entry.src)))
      ctx.addIssue({ code: 'custom', message: `Missing MAIC media target: ${entry.elementId}` });
  }
});
export function parseMaicClassroom(value: unknown): MaicClassroom {
  // Keep optional MAIC fields verbatim; schema parsing must never strip future fields.
  maicClassroomSchema.parse(value);
  return structuredClone(value) as MaicClassroom;
}
