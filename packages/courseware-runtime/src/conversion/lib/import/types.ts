export interface ImportWarning {
  code: string;
  message: string;
  severity?: 'info' | 'warning' | 'error';
  pageIndex?: number;
}

export interface FidelityReport {
  sourceType: 'pptx' | 'docx' | 'pdf';
  detectedPath?: 'ppt' | 'word';
  level?: 'L1' | 'L2' | 'L3';
  notes?: string[];
}

export type ImportContentLayoutVariant =
  | 'text_focus'
  | 'image_right'
  | 'hero_visual'
  | 'compare_split'
  | 'multi_point_grid';

export interface ImportTextBudget {
  maxCardCount: number;
  maxCardTextLength: number;
}

export interface ImportImagePlan {
  useSourceImage: boolean;
  generatedImageCount: number;
}

export interface ImportPagePlan {
  role: 'cover' | 'chapter' | 'content' | 'summary';
  layoutVariant?: ImportContentLayoutVariant;
  speakingGoal?: string;
  keyMessages?: string[];
  textBudget?: ImportTextBudget;
  imagePlan?: ImportImagePlan;
}

export interface ImportThemeProfile {
  titleArea?: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
  contentArea?: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
  themeColors?: string[];
  fontFamilies?: string[];
}

export interface ImportVisualLintIssue {
  code: string;
  message: string;
  severity?: 'info' | 'warning' | 'error';
  sceneId?: string;
  elementId?: string;
}

export interface DocumentBlock {
  id: string;
  type: 'heading' | 'paragraph' | 'list' | 'table' | 'image' | 'formula';
  text?: string;
  level?: number;
  items?: string[];
  table?: string[][];
  image?: {
    src: string;
    width?: number;
    height?: number;
    caption?: string;
  };
  formula?: {
    latex: string;
  };
}

export interface DocumentSection {
  id: string;
  title: string;
  level: number;
  blocks: DocumentBlock[];
}

export interface DocumentIR {
  kind: 'document';
  sourceType: 'docx' | 'pdf';
  title?: string;
  sections: DocumentSection[];
  narrationMode?: 'original' | 'light_rewrite' | 'generated';
  warnings?: ImportWarning[];
  fidelityReport?: FidelityReport;
}

export interface SlideElementIR {
  id: string;
  sourceShapeId?: string;
  /** Internal marker for editable text promoted from a simple PPT shape. */
  promotedFromShapeText?: boolean;
  sourceGroupShapeIds?: string[];
  sourceOrder?: number;
  type: 'text' | 'image' | 'shape' | 'line' | 'table' | 'formula' | 'video' | 'audio';
  left: number;
  top: number;
  width: number;
  height: number;
  rotate?: number;
  flipH?: boolean;
  flipV?: boolean;
  content?: string;
  hardLineBreaks?: string[];
  src?: string;
  poster?: string;
  autoplay?: boolean;
  trigger?: 'auto' | 'click';
  loop?: boolean;
  /** Milliseconds removed from the beginning/end of the original media. */
  trimStartMs?: number;
  trimEndMs?: number;
  ext?: string;
  opacity?: number;
  sourceEffectApplied?: boolean;
  imageRole?: 'content' | 'background' | 'shape_fill';
  clip?: {
    range: [[number, number], [number, number]];
    shape: string;
  };
  table?: Array<
    Array<
      | string
      | {
          text?: string;
          rowSpan?: number;
          colSpan?: number;
          fillColor?: string;
          fontColor?: string;
          fontBold?: boolean;
          borders?: Record<
            string,
            {
              borderColor?: string;
              borderWidth?: number;
              borderType?: string;
            }
          >;
        }
    >
  >;
  tableColWidths?: number[];
  latex?: string;
  textType?: 'title' | 'subtitle' | 'content' | 'notes';
  fixedBox?: boolean;
  /** The source text is allowed to render beyond its saved transform. */
  overflowVisible?: boolean;
  textInsets?: {
    left?: number;
    right?: number;
    top?: number;
    bottom?: number;
  };
  defaultFontName?: string;
  defaultColor?: string;
  fontSize?: number;
  fontWeight?: string;
  lineHeight?: number;
  wordSpace?: number;
  paragraphSpace?: number;
  textAlign?: 'left' | 'center' | 'right' | 'justify' | 'distributed';
  path?: string;
  viewBox?: [number, number];
  subPaths?: Array<{
    path: string;
    fill?: string;
    borderColor?: string;
    borderWidth?: number;
    borderType?: 'solid' | 'dashed' | 'dotted';
  }>;
  shapeType?: string;
  keypoints?: number[];
  fillColor?: string;
  pattern?: string;
  patternScaleMode?: 'cover' | 'contain' | 'stretch';
  patternCrop?: {
    range?: [[number, number], [number, number]];
    fillRect?: {
      left?: number;
      top?: number;
      right?: number;
      bottom?: number;
    };
  };
  fillGradient?: {
    type: 'linear' | 'radial';
    colors: Array<{
      pos: number;
      color: string;
    }>;
    rotate: number;
  };
  borderGradient?: {
    type: 'linear' | 'radial';
    colors: Array<{
      pos: number;
      color: string;
    }>;
    rotate: number;
  };
  borderColor?: string;
  borderWidth?: number;
  borderType?: 'solid' | 'dashed' | 'dotted';
  /** Authored endpoint for parser line paths, in the normalized page coordinate system. */
  lineEnd?: [number, number];
  shadow?: {
    h: number;
    v: number;
    blur: number;
    color: string;
  };
  points?: ['' | 'arrow' | 'dot', '' | 'arrow' | 'dot'];
  verticalAlign?: 'top' | 'middle' | 'bottom';
  vertical?: boolean;
  autoFit?: {
    type?: string;
    fontScale?: number;
    lnSpcReduction?: number;
  };
  interactionRole?: 'content' | 'focus_anchor';
  focusLabel?: string;
  focusSourceText?: string[];
  invisible?: boolean;
}

export interface PptAnimationTargetIR {
  shapeId: string;
  paragraphIndexes?: number[];
  characterRange?: [number, number];
}

export interface PptAnimationItemIR {
  id: string;
  /** Additive provenance; old worker IR without it cannot authorize fixed native playback. */
  nativePreset?: { version: 1; class: string; id: number };
  target?: PptAnimationTargetIR;
  effect?: string;
  animationType: 'in' | 'out' | 'attention' | 'media';
  startAtMs: number;
  durationMs: number;
  motion?: {
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
    /** WPS uses the slide height as the horizontal layout-motion basis. */
    xScaleBasis?: 'width' | 'height';
    path?: Array<{ x: number; y: number }>;
  };
  rotation?: {
    fromDeg: number;
    toDeg: number;
  };
}

export interface PptAnimationStepIR {
  id: string;
  trigger: 'auto' | 'click';
  items: PptAnimationItemIR[];
}

export interface PptAnimationPageIR {
  steps: PptAnimationStepIR[];
}

export interface SlidePageIR {
  id: string;
  width: number;
  height: number;
  notes?: string | string[]; // 支持字符串或字符串数组
  /** Static full-page rendering used only as visual grounding during import narration. */
  previewImage?: {
    src: string;
    width?: number;
    height?: number;
  };
  background?: {
    type: 'solid' | 'image';
    color?: string;
    src?: string;
    opacity?: number;
  };
  elements: SlideElementIR[];
  pptxAnimation?: PptAnimationPageIR;
}

export interface SlideIR {
  kind: 'slide';
  sourceType: 'pptx' | 'pdf';
  title?: string;
  pages: SlidePageIR[];
  narrationMode?: 'original' | 'light_rewrite' | 'generated';
  warnings?: ImportWarning[];
  fidelityReport?: FidelityReport;
}

export type ImportIR = DocumentIR | SlideIR;
