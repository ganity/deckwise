/**
 * Unified Action System
 *
 * Actions are the sole mechanism for agents to interact with the presentation.
 * Two categories:
 * - Fire-and-forget: visual effects on slides (spotlight, laser)
 * - Synchronous: must wait for completion before next action (speech, whiteboard, discussion)
 *
 * Both online (streaming) and offline (playback) paths consume the same Action types.
 */

import type { InteractionCheckpointPayload } from '../interaction/types';

export type PptxNarrationPhase = 'before' | 'with' | 'after';

export interface PptxNarrationCue {
  stepId: string;
  phase?: PptxNarrationPhase;
  targetElementIds: string[];
}

export interface SpeechTTSDirection {
  profile?:
    | 'steady_explain'
    | 'warm_open'
    | 'climax_emphasis'
    | 'closing_reflective'
    | 'brief_transition'
    | 'question_probe';
  voiceStyle?: 'neutral_training' | 'confident_business' | 'warm_visitor' | 'calm_explainer';
  // Sentence-level delivery style tag.
  // In classroom batch generation, narrator identity is stabilized separately and
  // this field should not be treated as permission to switch to a different narrator.
  model?: 'seed-tts-2.0-standard' | 'seed-tts-2.0-expressive';
  contextText?: string;
  sectionId?: string;
  silenceDuration?: number;
  loudnessRate?: number;
  pitch?: number;
  speed?: number;
}

export type SpeechMotionIntent =
  | 'fade_in'
  | 'scale_in'
  | 'slide_in_left'
  | 'slide_in_right'
  | 'pulse'
  | 'path_move'
  | 'gentle_rotate'
  | 'feedback_success'
  | 'feedback_retry';

export interface SpeechCuePlan {
  anchorText: string;
  occurrence: number;
  targetElementId: string;
  motionIntent: SpeechMotionIntent;
  offsetMs?: number;
}

export interface SpeechCue extends SpeechCuePlan {
  version: 1;
  speechActionId: string;
  timingTrackId: string;
  atMs: number;
  disabled?: boolean;
}

// ==================== Base ====================

export interface ActionBase {
  id: string;
  title?: string;
  description?: string;
  pptxTimeline?: {
    version: 1;
    stepId: string;
    phase?: PptxNarrationPhase;
    /** Speech-only contiguous range of pptistAnimationId values. */
    animationIds?: string[];
  };
}

// ==================== Fire-and-forget actions ====================

/** Spotlight — focus on a single element, dim everything else */
export interface SpotlightAction extends ActionBase {
  type: 'spotlight';
  elementId: string;
  elementIds?: string[];
  dimOpacity?: number; // default 0.5
}

/** Laser — point at an element with a laser effect */
export interface LaserAction extends ActionBase {
  type: 'laser';
  elementId: string;
  color?: string; // default '#ff0000'
}

// ==================== Synchronous actions ====================

/** Speech — lead narration (wait for TTS to finish) */
export interface SpeechAction extends ActionBase {
  type: 'speech';
  text: string;
  /** Stable semantic role for dialogue planning; independent from the TTS voice id. */
  speakerId?: string;
  source?: 'notes' | 'external' | 'original' | 'light_rewrite' | 'generated';
  audioId?: string;
  audioUrl?: string; // Server-generated TTS audio URL
  voice?: string;
  speed?: number; // default 1.0
  pauseAfterMs?: number; // wait after narration finishes before continuing
  ttsDirection?: SpeechTTSDirection;
  pptxCue?: PptxNarrationCue;
  speechCuePlans?: SpeechCuePlan[];
}

/** Open whiteboard (wait for animation) */
export interface WbOpenAction extends ActionBase {
  type: 'wb_open';
}

/** Draw text on whiteboard (wait for render) */
export interface WbDrawTextAction extends ActionBase {
  type: 'wb_draw_text';
  elementId?: string; // Custom element ID for later reference (e.g. wb_delete)
  content: string; // HTML string or plain text
  x: number;
  y: number;
  width?: number; // default 400
  height?: number; // default 100
  fontSize?: number; // default 18
  color?: string; // default '#333333'
}

/** Draw shape on whiteboard (wait for render) */
export interface WbDrawShapeAction extends ActionBase {
  type: 'wb_draw_shape';
  elementId?: string; // Custom element ID for later reference (e.g. wb_delete)
  shape: 'rectangle' | 'circle' | 'triangle';
  x: number;
  y: number;
  width: number;
  height: number;
  fillColor?: string; // default '#5b9bd5'
}

/** Draw chart on whiteboard (wait for render) */
export interface WbDrawChartAction extends ActionBase {
  type: 'wb_draw_chart';
  elementId?: string; // Custom element ID for later reference (e.g. wb_delete)
  chartType: 'bar' | 'column' | 'line' | 'pie' | 'ring' | 'area' | 'radar' | 'scatter';
  x: number;
  y: number;
  width: number;
  height: number;
  data: {
    labels: string[];
    legends: string[];
    series: number[][];
  };
  themeColors?: string[];
}

/** Draw LaTeX formula on whiteboard (wait for render) */
export interface WbDrawLatexAction extends ActionBase {
  type: 'wb_draw_latex';
  elementId?: string; // Custom element ID for later reference (e.g. wb_delete)
  latex: string;
  x: number;
  y: number;
  width?: number; // default 400
  height?: number; // auto-calculated based on formula aspect ratio
  color?: string; // default '#000000'
}

/** Draw table on whiteboard (wait for render) */
export interface WbDrawTableAction extends ActionBase {
  type: 'wb_draw_table';
  elementId?: string; // Custom element ID for later reference (e.g. wb_delete)
  x: number;
  y: number;
  width: number;
  height: number;
  data: string[][]; // Simplified 2D string array, first row is header
  outline?: { width: number; style: string; color: string };
  theme?: { color: string };
}

/** Draw line/arrow on whiteboard (wait for render) */
export interface WbDrawLineAction extends ActionBase {
  type: 'wb_draw_line';
  elementId?: string; // Custom element ID for later reference (e.g. wb_delete)
  startX: number; // Start X position (0-1000)
  startY: number; // Start Y position (0-562)
  endX: number; // End X position (0-1000)
  endY: number; // End Y position (0-562)
  color?: string; // Default '#333333'
  width?: number; // Line width, default 2
  style?: 'solid' | 'dashed'; // Default 'solid'
  points?: ['', 'arrow'] | ['arrow', ''] | ['arrow', 'arrow'] | ['', '']; // Endpoint markers, default ['', '']
}

/** Clear all whiteboard elements */
export interface WbClearAction extends ActionBase {
  type: 'wb_clear';
}

/** Delete a specific whiteboard element by ID */
export interface WbDeleteAction extends ActionBase {
  type: 'wb_delete';
  elementId: string;
}

/** Close whiteboard (wait for animation) */
export interface WbCloseAction extends ActionBase {
  type: 'wb_close';
}

/** Play video — start playback of a video element on the slide */
export interface PlayVideoAction extends ActionBase {
  type: 'play_video';
  elementId: string;
}

/** Play audio — start playback of an audio element on the slide */
export interface PlayAudioAction extends ActionBase {
  type: 'play_audio';
  elementId: string;
}

/** Deterministic importer-only animation. LLM action parsing must not emit this type. */
export interface ElementAnimationAction extends ActionBase {
  type: 'element_animation';
  elementId: string;
  effect: string;
  animationType: 'in' | 'out' | 'attention';
  duration: number;
  pptistTrigger: 'click' | 'meantime' | 'auto';
  pptistAnimationId?: string;
  startAtMs?: number;
  speechCue?: SpeechCue;
  paragraphIndexes?: number[];
  motion?: {
    fromX: number;
    fromY: number;
    path?: Array<{ x: number; y: number }>;
  };
  rotation?: {
    fromDeg: number;
    toDeg: number;
  };
}

/** Discussion — trigger a roundtable discussion */
export interface DiscussionAction extends ActionBase {
  type: 'discussion';
  topic: string;
  prompt?: string;
  agentId?: string;
}

/** Interaction checkpoint — hand control to the playback terminal */
export type InteractionCheckpointAction = ActionBase &
  InteractionCheckpointPayload & {
    type: 'interaction_checkpoint';
  };

// ==================== Union type ====================

export type Action =
  | SpotlightAction
  | LaserAction
  | PlayVideoAction
  | PlayAudioAction
  | ElementAnimationAction
  | SpeechAction
  | WbOpenAction
  | WbDrawTextAction
  | WbDrawShapeAction
  | WbDrawChartAction
  | WbDrawLatexAction
  | WbDrawTableAction
  | WbDrawLineAction
  | WbClearAction
  | WbDeleteAction
  | WbCloseAction
  | DiscussionAction
  | InteractionCheckpointAction;

export type ActionType = Action['type'];

/** Action types that fire immediately without blocking */
export const FIRE_AND_FORGET_ACTIONS: ActionType[] = ['spotlight', 'laser'];

/** Action types that only work on slide scenes (require slide canvas elements) */
export const SLIDE_ONLY_ACTIONS: ActionType[] = [
  'spotlight',
  'laser',
  'play_video',
  'play_audio',
  'element_animation',
];

/** Action types that must complete before the next action runs */
export const SYNC_ACTIONS: ActionType[] = [
  'speech',
  'play_video',
  'play_audio',
  'element_animation',
  'wb_open',
  'wb_draw_text',
  'wb_draw_shape',
  'wb_draw_chart',
  'wb_draw_latex',
  'wb_draw_table',
  'wb_draw_line',
  'wb_clear',
  'wb_delete',
  'wb_close',
  'discussion',
  'interaction_checkpoint',
];

// ==================== Canvas utility types (non-action) ====================

/**
 * Percentage-based geometry (0-100 coordinate system)
 * Used by spotlight/laser overlays for responsive positioning.
 */
export interface PercentageGeometry {
  x: number; // 0-100
  y: number; // 0-100
  w: number; // 0-100
  h: number; // 0-100
  centerX: number; // 0-100
  centerY: number; // 0-100
}
