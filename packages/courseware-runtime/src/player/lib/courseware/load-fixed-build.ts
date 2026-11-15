import { maicQuizSchema } from "../../../maic-classroom";
import { nativeTimelineSchema } from '../../../native-timeline';
import { speechAnimationTriggerSchema } from '../../../speech-animation-trigger';
import { questionResponseSchema } from '../../../question-response';
import { z } from "zod";
import { validSpeechAnimationSequence } from "../../../speech-animation-sequence";
import type { Slide } from "../types/slides";
import type { Action, ElementAnimationAction } from "../types/action";
import type { Effect } from "../playback/types";
import type { Scene } from "../types/stage";
import { nativeClickAnimationsSchema, type NativeClickAnimations } from "../../../native-click-animations";
import { nativeAnimationNodeSchema, validateNativeAnimationBindings } from "../../../native-animation-node";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1);
const assetSchema = z
  .object({
    id,
    path: id,
    sha256: hash,
    mimeType: z.string().regex(/^(audio|image|video)\/[\w.+-]+$/),
  })
  .strict();
const visualCueSchema = z
  .object({
    id,
    atMs: z.number().int().min(0).max(3_600_000),
    endMs: z.number().int().positive().max(3_600_000),
    trigger: speechAnimationTriggerSchema.optional(),
    nativeAnimation: z.string().min(1).max(200).optional(),
    effect: z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("highlight"),
          elementIds: z.array(id).min(1),
          color: z
            .string()
            .regex(/^#[a-fA-F0-9]{6}$/)
            .optional(),
          style: z.enum(["outline", "fill", "glow"]).optional(),
          opacity: z.number().min(0).max(1).optional(),
        })
        .strict(),
      z
        .object({
          type: z.literal("spotlight"),
          elementId: id,
          elementIds: z.array(id).optional(),
          dimOpacity: z.number().min(0).max(1).optional(),
        })
        .strict(),
      z
        .object({
          type: z.literal("element_animation"),
          elementId: id,
          effect: z.enum(["fadeIn", "fadeOut", "pulse", "zoomIn", "slideInLeft", "slideInRight", "gentleRotate"]),
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
      (cue.effect.type !== "element_animation" || cue.endMs - cue.atMs <= 5000),
  );
const actionSchema = z.union([
  nativeAnimationNodeSchema,
  z.object({ id, type: z.literal("delay"), durationMs: z.number().int().min(0).max(30_000) }).strict(),
  z.object({ id, type: z.literal("video_clip"), videoAssetId: id }).strict(),
  z.object({ id, type: z.literal("audio_clip"), audioAssetId: id }).strict(),
  z
    .object({
      id,
      type: z.literal("speech"),
      text: z.string(),
      audioAssetId: id,
      visualCues: z.array(visualCueSchema).max(200).optional(),
      pauseAfterMs: z.number().int().min(0).max(30_000).optional(),
    })
    .strict(),
  z
    .object({
      id,
      type: z.literal("interaction_checkpoint"),
      checkpointId: id,
      checkpointKind: z.literal("chapter_summary"), response: questionResponseSchema.optional(),
      chapterId: id,
      chapterTitle: z.string(),
      question: z.string(),
      referenceAnswer: z
        .object({ summary: z.string(), keyPoints: z.array(z.string()) })
        .strict(),
      context: z
        .object({ chapterSummary: z.string(), sourceSceneIds: z.array(id) })
        .strict(),
    })
    .strict(),
  z.object({ id, type: z.literal("interaction_checkpoint"), checkpointId: id, checkpointKind: z.literal("teacher_continue") }).strict(),
]);
const rectangularElementSchema = z
  .object({
    id,
    type: z.enum([
      "text",
      "shape",
      "image",
      "chart",
      "table",
      "latex",
      "audio",
      "video",
    ]),
    left: z.number().finite(),
    top: z.number().finite(),
    width: z.number().finite().nonnegative(),
    height: z.number().finite().nonnegative(),
  })
  .passthrough();
// PPTist lines use endpoint geometry; width is stroke thickness, not a box width.
const elementSchema = z.union([rectangularElementSchema, z.object({
  id, type: z.literal("line"), left: z.number().finite(), top: z.number().finite(),
  width: z.number().finite().nonnegative(), height: z.number().finite().nonnegative().optional(),
  start: z.tuple([z.number().finite(), z.number().finite()]),
  end: z.tuple([z.number().finite(), z.number().finite()]),
}).passthrough()]);
const payloadSchema = z
  .object({
    schemaVersion: z.literal("deckwise-playback/1"),
    report: z
      .object({
        ready: z.literal(true),
        visualFidelity: z.literal("NOT_VERIFIED"),
        reviewedWarningCodes: z.array(id),
        diagnostics: z.array(
          z.object({
            code: id,
            message: z.string(),
            severity: z.enum(["info", "warning", "error"]).optional(),
            pageIndex: z.number().optional(),
          }),
        ),
        capabilities: z
          .object({
            staticSlides: z.literal("limited"),
            fixedNarration: z.literal(true),
            teacherWait: z.literal(true),
            teachingAudioClips: z.literal("sequential/1").optional(),
            transitions: z.literal(false),
            objectAnimations: z.literal(false),
            nativeObjectAnimations: z.enum(["click-appear-fade/1", "click-appear-fade/2", "finite-presets/1"]).optional(),
            spotlight: z.boolean(),
            speechVisualCues: z
              .enum(["fixed-audio/1", "fixed-audio/2"])
              .optional(),
            playerObjectAnimations: z.enum(["fade-pulse/1", "speech-motion/2"]).optional(),
          })
          .strict(),
        sourceSha256: hash,
        sourceRevision: id,
        teachingRevision: id,
        mappingRevision: id,
        converter: z
          .object({
            version: z.literal("maic-pptx-import-ir/1"),
            manifestSha256: hash,
          })
          .strict(),
      })
      .strict(),
    pages: z
      .array(
        z
          .object({
            quiz: maicQuizSchema.optional(),
            pageId: id,
            title: z.string(),
            slide: z
              .object({
                id,
                viewportSize: z.number().positive(),
                viewportRatio: z.number().positive(),
                elements: z.array(elementSchema),
                theme: z.object({}).passthrough(),
                background: z.object({}).passthrough(),
              })
              .passthrough(),
            objects: z.array(
              z.object({ objectId: id, importElementId: id }).strict(),
            ),
            actions: z.array(actionSchema),
            nativeAnimations: nativeClickAnimationsSchema.optional(),
            nativeTimeline: nativeTimelineSchema.optional(),
          })
          .strict(),
      )
      .min(1),
    assets: z.array(assetSchema),
  })
  .strict();
/** Shared by generation preflight; the player remains the package validation authority. */
export const fixedSlideSchema = payloadSchema.shape.pages.element.shape.slide;
export type FixedAsset = z.infer<typeof assetSchema>;
export type FixedPayload = z.infer<typeof payloadSchema>;
export interface FixedVisualCue {
  trigger?: import("../../../speech-animation-trigger").SpeechAnimationTrigger;
  id: string;
  atMs: number;
  endMs: number;
  effect:
    | Effect
    | { kind: "element_animation"; action: ElementAnimationAction };
}
export interface LoadedFixedBuild {
  nativeTimeline?: true;
  nativeGroups?: ReadonlyMap<string, NonNullable<import('../../../native-timeline').NativeTimeline['groups']>>;
  classroom?: import("../../../maic-classroom").MaicClassroom;
  buildId: string;
  report: FixedPayload["report"];
  scenes: Scene[];
  speechVisualCues: ReadonlyMap<string, readonly FixedVisualCue[]>;
  nativeAnimations?: ReadonlyMap<string, NativeClickAnimations>;
  dispose(): void;
}
export type FixedAssetResolver = (
  asset: Readonly<FixedAsset>,
  signal?: AbortSignal,
) => Promise<Uint8Array>;
export async function digestBytes(bytes: Uint8Array) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer),
    ),
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
function check(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}
function unique(ids: string[]) {
  return new Set(ids).size === ids.length;
}

/** expectedBuildId must come from the selected immutable snapshot, not from the downloaded package. */
export async function loadFixedBuild(
  bytes: Uint8Array,
  expectedBuildId: string,
  resolveAsset: FixedAssetResolver,
  signal?: AbortSignal,
): Promise<LoadedFixedBuild> {
  check(bytes.length <= 64 * 1024 * 1024, "PACKAGE_HASH_MISMATCH");
  bytes = Uint8Array.from(bytes);
  check(
    (await digestBytes(bytes)) === expectedBuildId,
    "PACKAGE_HASH_MISMATCH",
  );
  signal?.throwIfAborted();
  const parsed = payloadSchema.safeParse(
    JSON.parse(new TextDecoder().decode(bytes)),
  );
  check(parsed.success, "PACKAGE_SCHEMA_INVALID");
  const payload = parsed.data;
  const nativeCapability = payload.pages.some(page => page.nativeTimeline) ? "finite-presets/1" : payload.pages.some(page => page.nativeAnimations?.version === 2) ? "click-appear-fade/2"
    : payload.pages.some(page => page.nativeAnimations) ? "click-appear-fade/1" : undefined;
  check(payload.report.capabilities.nativeObjectAnimations === nativeCapability, "NATIVE_ANIMATION_CAPABILITY_MISMATCH");
  for (const page of payload.pages) {
    check(!(page.nativeTimeline && page.nativeAnimations), "NATIVE_ANIMATION_BINDING_MISMATCH");
    const bound = page.actions.some(action => action.type === "native_animation");
    check(bound === (page.nativeAnimations?.version === 2), "NATIVE_ANIMATION_BINDING_MISMATCH");
    if (bound) check(validateNativeAnimationBindings(page.actions, payload.report.sourceSha256,
      page.nativeAnimations?.steps.length ?? 0), "NATIVE_ANIMATION_BINDING_MISMATCH");
  }
  check(
    !payload.report.diagnostics.some((d) => d.severity === "error"),
    "CONTENT_ERROR",
  );
  check(
    payload.report.diagnostics.every(
      (d) =>
        (d.severity ?? "warning") !== "warning" ||
        payload.report.reviewedWarningCodes.includes(d.code),
    ),
    "CONTENT_REVIEW_REQUIRED",
  );
  check(
    unique(payload.pages.map((p) => p.pageId)) &&
      unique(payload.assets.map((a) => a.id)),
    "DUPLICATE_PACKAGE_ID",
  );
  const visualCues = payload.pages.flatMap((p) =>
    p.actions.flatMap((a) => (a.type === "speech" ? (a.visualCues ?? []) : [])),
  );
  const hasAnimations = visualCues.some(
    (cue) => cue.effect.type === "element_animation",
  );
  check(
    payload.pages.some(page => page.actions.some(action => action.type === "audio_clip")) ===
      (payload.report.capabilities.teachingAudioClips === "sequential/1"),
    "AUDIO_CLIP_CAPABILITY_MISMATCH",
  );
  check(
    !visualCues.length ||
      payload.report.capabilities.speechVisualCues ===
        (hasAnimations ? "fixed-audio/2" : "fixed-audio/1"),
    "EFFECT_CAPABILITY_MISMATCH",
  );
  check(
    payload.report.capabilities.spotlight ===
      visualCues.some((c) => c.effect.type === "spotlight"),
    "EFFECT_CAPABILITY_MISMATCH",
  );
  check(
    unique(payload.pages.flatMap((p) => p.actions.map((a) => a.id))),
    "DUPLICATE_ACTION_ID",
  );
  const checkpoints = payload.pages.flatMap((page) =>
    page.actions.filter((action) => action.type === "interaction_checkpoint"),
  );
  check(
    unique(checkpoints.map((action) => action.checkpointId)),
    "DUPLICATE_CHECKPOINT_ID",
  );
  check(
    checkpoints.every((action) => action.checkpointKind === "teacher_continue" ||
      action.context.sourceSceneIds.every((id) => payload.pages.some((page) => page.pageId === id))),
    "WAIT_BINDING_MISMATCH",
  );
  check(
    unique(payload.pages.flatMap((p) => p.objects.map((o) => o.objectId))),
    "DUPLICATE_OBJECT_ID",
  );
  check(
    hasAnimations ===
      (payload.report.capabilities.playerObjectAnimations !== undefined),
    "ANIMATION_CAPABILITY_MISMATCH",
  );
  check(!payload.pages.some(page => page.actions.some(action => action.type === "speech" && action.visualCues?.some(cue =>
    cue.effect.type === "element_animation" && !["fadeIn", "fadeOut", "pulse"].includes(cue.effect.effect)))) ||
    payload.report.capabilities.playerObjectAnimations === "speech-motion/2", "ANIMATION_CAPABILITY_MISMATCH");
  const speechVisualCues = new Map<string, FixedVisualCue[]>();
  const urls = new Map<string, string>();
  const dispose = () => {
    for (const url of urls.values()) URL.revokeObjectURL(url);
    urls.clear();
  };
  try {
    let assetBytes = 0;
    for (const asset of payload.assets) {
      signal?.throwIfAborted();
      check(
        /^assets\/[a-f0-9]{64}\.[a-z0-9]+$/.test(asset.path),
        "UNSAFE_ASSET_PATH",
      );
      const resolved = await resolveAsset(Object.freeze({ ...asset }), signal);
      signal?.throwIfAborted();
      assetBytes += resolved.length;
      check(assetBytes <= 256 * 1024 * 1024, "ASSET_BUDGET_EXCEEDED");
      const bytes = Uint8Array.from(resolved);
      check((await digestBytes(bytes)) === asset.sha256, "ASSET_HASH_MISMATCH");
      signal?.throwIfAborted();
      urls.set(
        asset.id,
        URL.createObjectURL(
          new Blob([bytes.buffer], { type: asset.mimeType }),
        ),
      );
    }
    function resolveResources<T>(value: T): T {
      if (Array.isArray(value)) return value.map(resolveResources) as T;
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value).map(([key, child]) => {
            if (
              ["src", "poster"].includes(key) &&
              typeof child === "string" &&
              child
            ) {
              const url = urls.get(child);
              check(url, "UNARCHIVED_RESOURCE");
              return [key, url];
            }
            return [key, resolveResources(child)];
          }),
        ) as T;
      return value;
    }
    const nativeAnimations = new Map<string, NativeClickAnimations>();
    const nativeGroups = new Map<string, NonNullable<import('../../../native-timeline').NativeTimeline['groups']>>();
    const actionIds = new Set(payload.pages.flatMap(page => page.actions.map(action => action.id)));
    const checkpointIds = new Set(checkpoints.map(action => action.checkpointId));
    const scenes: Scene[] = payload.pages.map((page, index) => {
      check(
        unique(page.slide.elements.map((e) => e.id)),
        "DUPLICATE_ELEMENT_ID",
      );
      // The mapper prepends a full-slide image for an IR background, which is not a source object.
      const first = page.slide.elements[0];
      const hasGeneratedBackground = first?.id === `page_${index + 1}_background` &&
        first.type === "image" && first.imageType === "background" &&
        first.left === 0 && first.top === 0 && first.rotate === 0 &&
        first.width === page.slide.viewportSize &&
        first.height === page.slide.viewportSize * page.slide.viewportRatio &&
        !page.objects.some(o => o.importElementId === first.id);
      const sourceElements = hasGeneratedBackground ? page.slide.elements.slice(1) : page.slide.elements;
      check(
        page.objects.length === sourceElements.length &&
          unique(page.objects.map((o) => o.importElementId)) &&
          page.objects.every((o) =>
            sourceElements.some((e) => e.id === o.importElementId),
          ),
        "OBJECT_BINDING_MISMATCH",
      );
      check(validSpeechAnimationSequence(page.actions), "ANIMATION_TARGET_CONFLICT");
      const nativeTargets = new Set([...(page.nativeAnimations?.steps.map(step => step.elementId) ?? []),
        ...(page.nativeTimeline?.steps.flatMap(step => step.items.map(item => item.elementId)) ?? [])]);
      for (const step of page.nativeTimeline?.steps ?? []) for (const item of step.items) {
        const target = sourceElements.find(element => element.id === item.elementId);
        check(target && target.type !== 'line' && ['text', 'shape', 'image'].includes(target.type) && target.width > 0 && target.height > 0,
          "NATIVE_ANIMATION_TARGET_UNSUPPORTED");
      }
      const wrappers = page.nativeTimeline?.groups ?? [];
      const children = new Map<string, string>();
      check(unique(wrappers.map(group => group.elementId)), 'GROUP_BINDING_MISMATCH');
      for (const group of wrappers) {
        const anchor = sourceElements.find(element => element.id === group.elementId);
        check(anchor?.type === 'shape' && anchor.opacity === 0 && anchor.fill === 'transparent', 'GROUP_BINDING_MISMATCH');
        for (const child of group.children) {
          check(child !== group.elementId && !children.has(child) && sourceElements.some(element => element.id === child), 'GROUP_BINDING_MISMATCH');
          children.set(child, group.elementId);
        }
      }
      for (const group of wrappers) {
        const seen = new Set<string>(); let id: string | undefined = group.elementId;
        while (id) { check(!seen.has(id), 'GROUP_BINDING_MISMATCH'); seen.add(id); id = children.get(id); }
      }
      if (wrappers.length) nativeGroups.set(page.pageId, wrappers);
      const revealed = new Set<string>();
      const nativeAction = (step: NativeClickAnimations["steps"][number], id: string): ElementAnimationAction => ({
        id, type: "element_animation", elementId: step.elementId,
        effect: step.effect === "fade" ? "fadeIn" : "appear", animationType: "in",
        duration: step.durationMs, startAtMs: 0, pptistTrigger: "click", pptistAnimationId: id,
        pptxTimeline: { version: 1, stepId: id },
      });
      if (page.nativeAnimations) {
        for (const step of page.nativeAnimations.steps) {
          const target = sourceElements.find(element => element.id === step.elementId);
          check(target && target.type !== 'line' && ["text", "shape", "image"].includes(target.type) && target.width > 0 && target.height > 0 &&
            !(Array.isArray(target.sourceGroupShapeIds) && target.sourceGroupShapeIds.length), "NATIVE_ANIMATION_TARGET_UNSUPPORTED");
        }
        nativeAnimations.set(page.pageId, page.nativeAnimations);
      }
      const actions: Action[] = page.actions.map((action) => {
        if (action.type === "native_animation") {
          const step = page.nativeAnimations!.steps[action.stepIndex];
          revealed.add(step.elementId);
          return nativeAction(step, action.id);
        }
        if (action.type === "video_clip") {
          const videoUrl = urls.get(action.videoAssetId);
          check(videoUrl && payload.assets.some(asset => asset.id === action.videoAssetId && asset.mimeType === "video/mp4"), "VIDEO_ASSET_MISSING");
          return { ...action, videoUrl };
        }
        if (action.type === "audio_clip") {
          const audioUrl = urls.get(action.audioAssetId);
          check(audioUrl && payload.assets.some(asset => asset.id === action.audioAssetId && asset.mimeType.startsWith("audio/")), "AUDIO_ASSET_MISSING");
          return { ...action, audioId: action.audioAssetId, audioUrl };
        }
        if (action.type !== "speech") return action;
        check((action.visualCues ?? []).every(cue => !cue.trigger || cue.trigger.kind !== 'text' ||
          (!cue.trigger.stale && cue.trigger.audioAssetId === action.audioAssetId && action.text.slice(cue.trigger.start, cue.trigger.end) === cue.trigger.text)), 'SPEECH_TIMING_RECALIBRATION_REQUIRED');
        check(
          unique((action.visualCues ?? []).map((c) => c.id)),
          "DUPLICATE_VISUAL_CUE_ID",
        );
        const bind = (id: string) => {
          const target = page.objects.find((o) => o.objectId === id);
          check(target, "EFFECT_BINDING_MISMATCH");
          check(page.nativeAnimations?.version !== 2 || !nativeTargets.has(target.importElementId) ||
            revealed.has(target.importElementId), "NATIVE_ANIMATION_TARGET_NOT_REVEALED");
          const element = page.slide.elements.find(
            (e) => e.id === target.importElementId,
          )!;
          check(
            element.type !== "line" && element.width > 0 && element.height > 0,
            "EFFECT_TARGET_UNSUPPORTED",
          );
          return target.importElementId;
        };
        speechVisualCues.set(
          action.id,
          (action.visualCues ?? []).map((cue) => {
            const effect = cue.effect;
            if (effect.type === "element_animation") {
              const elementId = bind(effect.elementId);
              check(!nativeTargets.has(elementId), "NATIVE_ANIMATION_CUE_CONFLICT");
              const element = page.slide.elements.find(
                (e) => e.id === elementId,
              )!;
              check(
                element.type !== "audio" && element.type !== "video",
                "ANIMATION_TARGET_UNSUPPORTED",
              );
              return {
                ...cue,
                effect: {
                  kind: "element_animation" as const,
                  action: {
                    id: cue.id,
                    type: "element_animation" as const,
                    elementId,
                    effect: effect.effect,
                    animationType:
                      ["fadeIn", "zoomIn", "slideInLeft", "slideInRight"].includes(effect.effect)
                        ? ("in" as const)
                        : effect.effect === "fadeOut"
                          ? ("out" as const)
                          : ("attention" as const),
                    duration: cue.endMs - cue.atMs,
                    pptistTrigger: "auto" as const,
                  },
                },
              };
            }
            return {
              ...cue,
              effect:
                effect.type === "highlight"
                  ? {
                      kind: "highlight",
                      targetIds: effect.elementIds.map(bind),
                      color: effect.color,
                      style: effect.style,
                      opacity: effect.opacity,
                    }
                  : {
                      kind: "spotlight",
                      targetId: bind(effect.elementId),
                      elementIds: effect.elementIds?.map(bind),
                      dimOpacity: effect.dimOpacity,
                    },
            };
          }),
        );
        const audioUrl = urls.get(action.audioAssetId);
        check(
          audioUrl &&
            payload.assets.some(
              (a) =>
                a.id === action.audioAssetId && a.mimeType.startsWith("audio/"),
            ),
          "AUDIO_ASSET_MISSING",
        );
        return { ...action, audioId: action.audioAssetId, audioUrl };
      });
      const nativeActions: Action[] = (page.nativeAnimations?.version === 1 ? page.nativeAnimations.steps : []).flatMap((step, stepIndex) => {
        const prefix = `fixed-native-${index + 1}-${stepIndex + 1}`;
        const ids = [`${prefix}-wait`, `${prefix}-animation`];
        check(ids.every(id => !actionIds.has(id)), "DUPLICATE_ACTION_ID");
        check(!checkpointIds.has(ids[0]), "DUPLICATE_CHECKPOINT_ID");
        checkpointIds.add(ids[0]);
        ids.forEach(id => actionIds.add(id));
        return [{ id: ids[0], type: "interaction_checkpoint" as const,
          checkpointId: ids[0], checkpointKind: "teacher_continue" as const },
        nativeAction(step, ids[1])];
      });
      const timelineActions: Action[] = (page.nativeTimeline?.steps ?? []).flatMap((step, stepIndex) => {
        const prefix = `fixed-native-timeline-${index + 1}-${stepIndex + 1}`;
        const generated: Action[] = [];
        if (step.trigger === 'click') generated.push({ id: prefix + '-wait', type: 'interaction_checkpoint',
          checkpointId: prefix + '-wait', checkpointKind: 'teacher_continue' });
        generated.push(...step.items.map((item, itemIndex): ElementAnimationAction => ({
          id: prefix + '-' + itemIndex, type: 'element_animation', elementId: item.elementId,
          effect: item.effect, ...(item.distance ? { motion: { fromX: 0, fromY: item.distance } } : {}), animationType: item.animationType, duration: item.durationMs, startAtMs: item.startAtMs,
          pptistTrigger: itemIndex === 0 ? 'auto' : 'meantime', pptistAnimationId: prefix + '-' + itemIndex,
          pptxTimeline: { version: 1, stepId: prefix },
        })));
        for (const action of generated) {
          check(!actionIds.has(action.id), 'DUPLICATE_ACTION_ID'); actionIds.add(action.id);
          if (action.type === 'interaction_checkpoint') {
            check(!checkpointIds.has(action.checkpointId), 'DUPLICATE_CHECKPOINT_ID'); checkpointIds.add(action.checkpointId);
          }
        }
        return generated;
      });
      if (page.quiz) {
        const quiz = structuredClone(page.quiz);
        for (const q of quiz.questions) for (const image of [q.image, ...(q.options ?? []).map(o => o.image)]) if (image) {
          const url = urls.get(image.src); check(url, "ASSET_MISSING"); image.src = url;
        }
        return { id: page.pageId, stageId: 'fixed-build', title: page.title, type: 'quiz', order: index, content: quiz,
          actions: actions.filter(a => a.type !== 'interaction_checkpoint') } as Scene;
      }
      return {
        id: page.pageId,
        stageId: expectedBuildId,
        type: "slide",
        title: page.title,
        order: index + 1,
        content: {
          type: "slide",
          canvas: resolveResources(page.slide) as unknown as Slide,
        },
        actions: [...nativeActions, ...timelineActions, ...actions],
      };
    });
    return {
      buildId: expectedBuildId,
      report: payload.report,
      scenes,
      speechVisualCues,
      nativeAnimations,
      nativeGroups,
      ...(payload.pages.some(page => page.nativeTimeline) ? { nativeTimeline: true as const } : {}),
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
