// Stage and Scene data types
import type { Slide } from './slides';
import type { Action } from './action';
import type { PBLProjectConfig } from '../pbl/types';
import type { InteractionSceneMetadata } from '../interaction/types';

export type SceneType = 'slide' | 'quiz' | 'interactive' | 'pbl';

export type StageMode = 'autonomous' | 'playback';

export interface StageCanvas {
  preset: 'WIDE_16_9' | 'KINDERGARTEN_16_10';
  viewportSize: number;
  viewportRatio: number;
}

export type Whiteboard = Omit<Slide, 'theme' | 'turningMode' | 'sectionTag' | 'type'>;

export type QuizInteractionMode = 'assessment_review' | 'classroom_instant_feedback';

export type QuizQuestionType = 'single' | 'multiple' | 'short_answer' | 'judge';

export interface ClassroomQuizPlaybackConfig {
  introSpeechMode: 'page_enter_only';
  attemptPolicy: 'until_correct';
  successSpeechText: string;
  failureSpeechText: string;
  cueUserOnEnter: boolean;
  cueUserOnRetry: boolean;
}

export const DEFAULT_CLASSROOM_QUIZ_PLAYBACK_CONFIG: ClassroomQuizPlaybackConfig = {
  introSpeechMode: 'page_enter_only',
  attemptPolicy: 'until_correct',
  successSpeechText: '回答正确！非常棒！',
  failureSpeechText: '很遗憾，你选错了，再试一次吧！',
  cueUserOnEnter: true,
  cueUserOnRetry: false,
};

/**
 * Stage - Represents the entire classroom/course
 */
export interface Stage {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  // Stage metadata
  language?: string;
  style?: string;
  canvas?: StageCanvas;
  // Whiteboard data
  whiteboard?: Whiteboard[];
  // Agent IDs selected when this classroom was created
  agentIds?: string[];
}

/**
 * Scene - Represents a single page/scene in the course
 */
export interface Scene {
  id: string;
  stageId: string; // ID of the parent stage (for data integrity checks)
  type: SceneType;
  title: string;
  order: number; // Display order

  // Type-specific content
  content: SceneContent;

  // Actions to execute during playback
  actions?: Action[];

  // Whiteboards to explain deeply
  whiteboards?: Slide[];

  // Multi-agent discussion configuration
  multiAgent?: {
    enabled: boolean; // Enable multi-agent for this scene
    agentIds: string[]; // Which agents to include (from registry)
    directorPrompt?: string; // Optional custom director instructions
  };

  metadata?: {
    interaction?: InteractionSceneMetadata;
  } & Record<string, unknown>;

  // Metadata
  createdAt?: number;
  updatedAt?: number;
}

/**
 * Scene content based on type
 */
export type SceneContent = SlideContent | QuizContent | InteractiveContent | PBLContent;

/**
 * Slide content - PPTist Canvas data
 */
export interface SlideContent {
  type: 'slide';
  // PPTist slide data structure
  canvas: Slide;
}

/**
 * Quiz content - React component props/data
 */
export interface QuizContent {
  type: 'quiz';
  questions: QuizQuestion[];
  interactionMode?: QuizInteractionMode;
  playbackConfig?: ClassroomQuizPlaybackConfig;
  /**
   * Compatibility shim for tests/utilities that inspect scene.content.canvas
   * without narrowing the discriminated union first.
   */
  canvas?: never;
}

export interface QuizImageAsset {
  src: string;
  assetId?: string;
  mimeType?: string;
}

export interface QuizOption {
  label: string; // Display text
  value: string; // Selection key: "A", "B", "C", "D"
  image?: QuizImageAsset;
}

export interface QuizQuestion {
  id: string;
  type: QuizQuestionType;
  question: string;
  image?: QuizImageAsset;
  options?: QuizOption[];
  answer?: string[]; // Correct answer values: ["A"], ["A","C"], or undefined for text
  analysis?: string; // Explanation shown after grading
  commentPrompt?: string; // Grading guidance for text questions
  referenceAnswer?: string; // Standard answer summary for stable short-answer grading
  keyPoints?: string[]; // Required knowledge points for stable short-answer grading
  hasAnswer?: boolean; // Whether auto-grading is possible
  points?: number; // Points per question (default 1)
}

/**
 * Interactive content - Interactive web page (iframe)
 */
export interface InteractiveContent {
  type: 'interactive';
  url: string; // URL of the interactive page
  // Optional: embedded HTML content
  html?: string;
  canvas?: never;
}

/**
 * PBL content - Project-based learning
 */
export interface PBLContent {
  type: 'pbl';
  projectConfig: PBLProjectConfig;
  canvas?: never;
}

