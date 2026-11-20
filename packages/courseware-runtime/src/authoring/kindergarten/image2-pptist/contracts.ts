import { z } from 'zod';

const bboxSchema = z
  .tuple([
    z.number().finite().nonnegative(),
    z.number().finite().nonnegative(),
    z.number().finite().positive(),
    z.number().finite().positive(),
  ])
  .describe('Canvas box as [x, y, width, height] in pixels; never use right/bottom coordinates.');

const cropSchema = z
  .tuple([
    z.tuple([z.number().min(0).max(100), z.number().min(0).max(100)]),
    z.tuple([z.number().min(0).max(100), z.number().min(0).max(100)]),
  ])
  .refine(([[left, top], [right, bottom]]) => right > left && bottom > top, {
    message: 'crop must have a positive area',
  });

const baseFields = {
  id: z.string().trim().min(1),
  bboxPx: bboxSchema,
  zIndex: z.number().int(),
  rotate: z.number().finite().optional(),
  opacity: z.number().min(0).max(1).optional(),
  semanticRole: z.string().trim().min(1).optional(),
  spokenAliases: z.array(z.string().trim().min(1)).default([]),
  animationPolicy: z.enum(['appear_on_first_mention', 'emphasize_on_repeat', 'static']).optional(),
  objectKind: z.enum(['person', 'animal', 'prop', 'unknown']).optional(),
  actionDescription: z.string().trim().min(1).optional(),
  observedSemanticRole: z.string().trim().min(1).optional(),
  identityMismatch: z.boolean().optional(),
};

const nativeTextSchema = z
  .object({
    ...baseFields,
    type: z.literal('native_text'),
    content: z.string().trim().min(1),
    style: z
      .object({
        fontFace: z.string().trim().min(1),
        fontSizePt: z.number().finite().positive().max(200),
        fontWeight: z.number().int().min(100).max(900).optional(),
        color: z.string().trim().min(1),
        strokeColor: z.string().trim().min(1).optional(),
        strokeWidthPx: z.number().finite().nonnegative().max(32).optional(),
        shadow: z
          .object({
            color: z.string().trim().min(1),
            blurPx: z.number().finite().nonnegative().max(64),
            offsetX: z.number().finite().min(-64).max(64),
            offsetY: z.number().finite().min(-64).max(64),
          })
          .strict()
          .optional(),
        align: z.enum(['left', 'center', 'right']).default('left'),
        lineHeight: z.number().finite().positive().max(3).default(1.2),
      })
      .strict(),
  })
  .strict();

const imageLayerSchema = z
  .object({
    ...baseFields,
    type: z.literal('image_layer'),
    assetId: z.string().trim().min(1),
    layerRoute: z.enum(['A1', 'A2', 'B']),
    layerMetadata: z.object({ name: z.string().trim().min(1).max(200), description: z.string().trim().min(1).max(2000) }).strict().optional(),
    crop: cropSchema.optional(),
    sourceText: z.string().trim().min(1).optional(),
    regenerationPrompt: z.string().trim().min(1).optional(),
  })
  .strict()
  .superRefine((layer, context) => {
    if (Boolean(layer.sourceText) !== Boolean(layer.regenerationPrompt)) {
      context.addIssue({
        code: 'custom',
        path: [layer.sourceText ? 'regenerationPrompt' : 'sourceText'],
        message: 'decorative image text requires both sourceText and regenerationPrompt',
      });
    }
  });

const nativeShapeSchema = z
  .object({
    ...baseFields,
    type: z.literal('native_shape'),
    shape: z.enum(['rectangle', 'rounded_rectangle', 'ellipse', 'star_5']),
    fill: z.string().trim().min(1),
    line: z.string().trim().min(1).optional(),
    lineWidth: z.number().finite().positive().optional(),
  })
  .strict();

const connectorSchema = z
  .object({
    ...baseFields,
    type: z.literal('connector'),
    color: z.string().trim().min(1),
    lineWidth: z.number().finite().positive().default(2),
    startArrow: z.boolean().default(false),
    endArrow: z.boolean().default(false),
  })
  .strict();

export const kindergartenEditableElementSchema = z.discriminatedUnion('type', [
  nativeTextSchema,
  imageLayerSchema,
  nativeShapeSchema,
  connectorSchema,
]);

export const editablePptxSceneSchema = z
  .object({
    version: z.literal(1),
    slideId: z.string().trim().min(1),
    canvas: z
      .object({
        width: z.number().finite().min(100).max(4096),
        height: z.number().finite().min(100).max(4096),
      })
      .strict(),
    visualMasterAssetId: z.string().trim().min(1),
    cleanPlateAssetId: z.string().trim().min(1),
    sourceHash: z.string().trim().min(1),
    elements: z.array(kindergartenEditableElementSchema),
  })
  .strict()
  .superRefine((scene, context) => {
    const ids = new Set<string>();
    scene.elements.forEach((element, index) => {
      if (ids.has(element.id)) {
        context.addIssue({
          code: 'custom',
          path: ['elements', index, 'id'],
          message: `duplicate element id: ${element.id}`,
        });
      }
      ids.add(element.id);

      const [x, y, width, height] = element.bboxPx;
      if (x + width > scene.canvas.width || y + height > scene.canvas.height) {
        const suggested = [
          Math.max(0, Math.min(x, scene.canvas.width - width)),
          Math.max(0, Math.min(y, scene.canvas.height - height)),
          width,
          height,
        ];
        context.addIssue({
          code: 'custom',
          path: ['elements', index, 'bboxPx'],
          message: `element ${element.id} exceeds the ${scene.canvas.width}x${scene.canvas.height} canvas; use ${JSON.stringify(suggested)} or another in-canvas [x, y, width, height] box`,
        });
      }
    });
  });

// The legacy Image2/PPTist authoring path keeps its fixed canvas contract.
export const kindergartenEditableSceneSchema = editablePptxSceneSchema.safeExtend({
  canvas: z.object({ width: z.literal(1280), height: z.literal(800) }).strict(),
});

export type KindergartenEditableElementV1 = z.infer<typeof kindergartenEditableElementSchema>;
export type KindergartenEditableSceneV1 = z.infer<typeof kindergartenEditableSceneSchema>;

/**
 * Deterministic page output. It deliberately shares the editable element
 * contract with premium Image2 pages, but does not require a page-specific
 * visual master or clean plate.
 */
export const kindergartenStandardCompositionSceneSchema = z
  .object({
    version: z.literal(1),
    slideId: z.string().trim().min(1),
    canvas: z
      .object({
        width: z.literal(1280),
        height: z.literal(800),
      })
      .strict(),
    authoringMode: z.literal('standard-composition'),
    backgroundAssetId: z.string().trim().min(1),
    sourceHash: z.string().trim().min(1),
    elements: z.array(kindergartenEditableElementSchema),
  })
  .strict()
  .superRefine((scene, context) => {
    const ids = new Set<string>();
    scene.elements.forEach((element, index) => {
      if (ids.has(element.id)) {
        context.addIssue({
          code: 'custom',
          path: ['elements', index, 'id'],
          message: `duplicate element id: ${element.id}`,
        });
      }
      ids.add(element.id);

      const [x, y, width, height] = element.bboxPx;
      if (x + width > scene.canvas.width || y + height > scene.canvas.height) {
        context.addIssue({
          code: 'custom',
          path: ['elements', index, 'bboxPx'],
          message: `element ${element.id} exceeds the 1280x800 canvas`,
        });
      }
    });
  });

export type KindergartenStandardCompositionSceneV1 = z.infer<
  typeof kindergartenStandardCompositionSceneSchema
>;

export type KindergartenSemanticElementIndex = Record<
  string,
  {
    semanticRole?: string;
    spokenAliases: string[];
    animationPolicy?: 'appear_on_first_mention' | 'emphasize_on_repeat' | 'static';
    objectKind?: 'person' | 'animal' | 'prop' | 'unknown';
    actionDescription?: string;
    observedSemanticRole?: string;
    identityMismatch?: boolean;
  }
>;

export interface KindergartenOcrValidationV1 {
  version: 1;
  provider: 'mineru-v4';
  status: 'accepted' | 'rejected';
  screenshotSha256: string;
  expectedText: Array<{ elementId: string; text: string }>;
  recognizedText: string;
  recognizedTextByElement?: Record<string, string>;
  taskId: string;
  taskIds?: string[];
}
