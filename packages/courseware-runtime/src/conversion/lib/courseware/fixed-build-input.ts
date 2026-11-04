import { speechAnimationTriggerSchema } from '../../../speech-animation-trigger';
import { questionResponseSchema } from '../../../question-response';
import { z } from 'zod';
import { nativeAnimationNodeSchema } from '../../../native-animation-node';

const id = z.string().min(1).max(200);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const file = z.object({ path: z.string().min(1), sha256: hash }).strict();
const visualCueSchema = z
  .object({
    id,
    atMs: z.number().int().min(0).max(3_600_000),
    endMs: z.number().int().positive().max(3_600_000),
    trigger: speechAnimationTriggerSchema.optional(),
    nativeAnimation: z.string().min(1).max(200).optional(),
    effect: z.discriminatedUnion('type', [
      z
        .object({
          type: z.literal('highlight'),
          elementIds: z.array(id).min(1),
          color: z
            .string()
            .regex(/^#[a-fA-F0-9]{6}$/)
            .optional(),
          style: z.enum(['outline', 'fill', 'glow']).optional(),
          opacity: z.number().min(0).max(1).optional(),
        })
        .strict(),
      z
        .object({
          type: z.literal('spotlight'),
          elementId: id,
          elementIds: z.array(id).optional(),
          dimOpacity: z.number().min(0).max(1).optional(),
        })
        .strict(),
      z
        .object({
          type: z.literal('element_animation'),
          elementId: id,
          effect: z.enum(['fadeIn', 'fadeOut', 'pulse', 'zoomIn', 'slideInLeft', 'slideInRight', 'gentleRotate']),
        })
        .strict(),
    ]),
  })
  .strict()
  .refine(cue => (!cue.trigger || cue.effect.type === 'element_animation') &&
    (!cue.nativeAnimation || cue.effect.type === 'element_animation' && cue.nativeAnimation === cue.effect.elementId))
  .refine(
    (cue) =>
      cue.endMs > cue.atMs &&
      (cue.effect.type !== 'element_animation' || cue.endMs - cue.atMs <= 5000),
  );
const speech = z
  .object({
    id,
    type: z.literal('speech'),
    text: z.string(),
    audioAssetId: id,
    visualCues: z.array(visualCueSchema).max(200).optional(),
    pauseAfterMs: z.number().int().min(0).max(30_000).optional(),
  })
  .strict();
const chapterSummaryWait = z
  .object({
    id,
    type: z.literal('interaction_checkpoint'),
    checkpointId: id,
    checkpointKind: z.literal('chapter_summary'), response: questionResponseSchema.optional(),
    chapterId: id,
    chapterTitle: z.string(),
    question: z.string(),
    referenceAnswer: z.object({ summary: z.string(), keyPoints: z.array(z.string()) }).strict(),
    context: z.object({ chapterSummary: z.string(), sourceSceneIds: z.array(id) }).strict(),
  })
  .strict();
const teacherContinueWait = z.object({ id, type: z.literal('interaction_checkpoint'), checkpointId: id, checkpointKind: z.literal('teacher_continue') }).strict();
const audioClip = z.object({ id, type: z.literal('audio_clip'), audioAssetId: id }).strict();
const videoClip = z.object({ id, type: z.literal('video_clip'), videoAssetId: id }).strict();

// Internal converter input; adaptCanonicalSnapshot consumes A's canonical Host export. Actions are the existing
// Scene actions; pageId/objectId are supplied by the persisted mapping, never inferred here.
export const fixedBuildInputSchema = z
  .object({
    schemaVersion: z.literal('deckwise-fixed-build/1'),
    source: file.extend({ revision: id }).strict(),
    teaching: z
      .object({
        revision: id,
        sourceSha256: hash,
        pages: z
          .array(z.object({ pageId: id, actions: z.array(z.union([nativeAnimationNodeSchema, speech, audioClip, videoClip, chapterSummaryWait, teacherContinueWait, z.object({ id, type: z.literal('delay'), durationMs: z.number().int().min(0).max(30_000) }).strict()])) }).strict())
          .min(1),
      })
      .strict(),
    mapping: z
      .object({
        revision: id,
        sourceSha256: hash,
        pages: z
          .array(
            z
              .object({
                pageId: id,
                importPageId: id,
                objects: z.array(z.object({ objectId: id, importElementId: id }).strict()),
              })
              .strict(),
          )
          .min(1),
      })
      .strict(),
    assets: z.array(
      file
        .extend({ id, mimeType: z.string().regex(/^(audio|video|image)\/[a-zA-Z0-9.+-]+$/) })
        .strict(),
    ),
    converter: z
      .object({ version: z.literal('maic-pptx-import-ir/1'), manifestSha256: hash })
      .strict(),
    reviewedWarningCodes: z.array(id),
  })
  .strict();

export type FixedBuildInput = z.infer<typeof fixedBuildInputSchema>;
