import { z } from "zod";
import type { Slide } from "../types/slides";
import type { Action, ElementAnimationAction } from "../types/action";
import type { Effect } from "../playback/types";
import type { Scene } from "../types/stage";
import { nativeClickAnimationsSchema, type NativeClickAnimations } from "../../../native-click-animations";

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
          effect: z.enum(["fadeIn", "fadeOut", "pulse"]),
        })
        .strict(),
    ]),
  })
  .strict()
  .refine(
    (cue) =>
      cue.endMs > cue.atMs &&
      (cue.effect.type !== "element_animation" || cue.endMs - cue.atMs <= 5000),
  );
const actionSchema = z.union([
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
      checkpointKind: z.literal("chapter_summary"),
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
const elementSchema = z
  .object({
    id,
    type: z.enum([
      "text",
      "shape",
      "image",
      "line",
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
            nativeObjectAnimations: z.literal("click-appear-fade/1").optional(),
            spotlight: z.boolean(),
            speechVisualCues: z
              .enum(["fixed-audio/1", "fixed-audio/2"])
              .optional(),
            playerObjectAnimations: z.literal("fade-pulse/1").optional(),
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
          })
          .strict(),
      )
      .min(1),
    assets: z.array(assetSchema),
  })
  .strict();
export type FixedAsset = z.infer<typeof assetSchema>;
export type FixedPayload = z.infer<typeof payloadSchema>;
export interface FixedVisualCue {
  id: string;
  atMs: number;
  endMs: number;
  effect:
    | Effect
    | { kind: "element_animation"; action: ElementAnimationAction };
}
export interface LoadedFixedBuild {
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
  check(payload.pages.some(page => page.nativeAnimations) ===
    (payload.report.capabilities.nativeObjectAnimations === "click-appear-fade/1"), "NATIVE_ANIMATION_CAPABILITY_MISMATCH");
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
      (payload.report.capabilities.playerObjectAnimations === "fade-pulse/1"),
    "ANIMATION_CAPABILITY_MISMATCH",
  );
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
      const animatedObjects = new Set<string>();
      const nativeTargets = new Set(page.nativeAnimations?.steps.map(step => step.elementId));
      if (page.nativeAnimations) {
        for (const step of page.nativeAnimations.steps) {
          const target = sourceElements.find(element => element.id === step.elementId);
          check(target && ["text", "shape", "image"].includes(target.type) && target.width > 0 && target.height > 0 &&
            !(Array.isArray(target.sourceGroupShapeIds) && target.sourceGroupShapeIds.length), "NATIVE_ANIMATION_TARGET_UNSUPPORTED");
        }
        nativeAnimations.set(page.pageId, page.nativeAnimations);
      }
      const actions: Action[] = page.actions.map((action) => {
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
        check(
          unique((action.visualCues ?? []).map((c) => c.id)),
          "DUPLICATE_VISUAL_CUE_ID",
        );
        const bind = (id: string) => {
          const target = page.objects.find((o) => o.objectId === id);
          check(target, "EFFECT_BINDING_MISMATCH");
          check(!nativeTargets.has(target.importElementId), "NATIVE_ANIMATION_CUE_CONFLICT");
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
              const element = page.slide.elements.find(
                (e) => e.id === elementId,
              )!;
              check(
                element.type !== "audio" && element.type !== "video",
                "ANIMATION_TARGET_UNSUPPORTED",
              );
              check(
                !animatedObjects.has(elementId),
                "ANIMATION_TARGET_CONFLICT",
              );
              animatedObjects.add(elementId);
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
                      effect.effect === "fadeIn"
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
      const nativeActions: Action[] = (page.nativeAnimations?.steps ?? []).flatMap((step, stepIndex) => {
        const prefix = `fixed-native-${index + 1}-${stepIndex + 1}`;
        const ids = [`${prefix}-wait`, `${prefix}-animation`];
        check(ids.every(id => !actionIds.has(id)), "DUPLICATE_ACTION_ID");
        check(!checkpointIds.has(ids[0]), "DUPLICATE_CHECKPOINT_ID");
        checkpointIds.add(ids[0]);
        ids.forEach(id => actionIds.add(id));
        return [{ id: ids[0], type: "interaction_checkpoint" as const,
          checkpointId: ids[0], checkpointKind: "teacher_continue" as const },
        { id: ids[1], type: "element_animation" as const, elementId: step.elementId,
          effect: step.effect === "fade" ? "fadeIn" : "appear", animationType: "in" as const,
          duration: step.durationMs, startAtMs: 0, pptistTrigger: "click" as const,
          pptistAnimationId: ids[1], pptxTimeline: { version: 1 as const, stepId: prefix } }];
      });
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
        actions: [...nativeActions, ...actions],
      };
    });
    return {
      buildId: expectedBuildId,
      report: payload.report,
      scenes,
      speechVisualCues,
      nativeAnimations,
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
