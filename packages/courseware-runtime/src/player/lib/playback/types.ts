/**
 * Playback Types - Types for lecture playback and live discussion engine
 */

import type { PlaybackSnapshot } from "../utils/playback-storage";
import type {
  ElementAnimationAction,
  InteractionCheckpointPayload,
} from "../types/action";

export type { PlaybackSnapshot };

/** Visual effects (for onEffectFire callback) */
export type Effect =
  | {
      kind: "highlight";
      targetIds: string[];
      color?: string;
      opacity?: number;
      style?: "outline" | "fill" | "glow";
    }
  | {
      kind: "spotlight";
      targetId: string;
      dimOpacity?: number;
      elementIds?: string[];
    }
  | { kind: "laser"; targetId: string; color?: string };

/** Native narration position; null ends the audio phase, including post-speech silence. */
export interface SpeechProgress {
  actionId: string;
  timeMs: number;
  durationMs: number;
}

/** Engine mode state machine */
export type EngineMode =
  | "idle"
  | "playing"
  | "paused"
  | "live"
  | "waiting_interaction";

/** Discussion topic state */
export type TopicState = "active" | "pending" | "closed";

/** Trigger event (for proactive discussion card) */
export interface TriggerEvent {
  id: string;
  question: string;
  prompt?: string;
  agentId?: string;
}

/** Playback engine callbacks */
export interface PlaybackEngineCallbacks {
  onModeChange?: (mode: EngineMode) => void;
  onSceneChange?: (sceneId: string) => void;
  onSpeechStart?: (text: string) => void;
  onSpeechEnd?: () => void;
  onSpeechProgress?: (progress: SpeechProgress | null) => void;
  onAudioClipProgress?: (progress: SpeechProgress | null) => void;
  onTextDelta?: (content: string) => void;
  onSpeakerChange?: (role: string) => void;
  onEffectFire?: (effect: Effect) => void;
  onElementAnimation?: (action: ElementAnimationAction) => Promise<void> | void;
  onElementAnimationReconcile?: (
    completed: ElementAnimationAction[],
    scope: ElementAnimationAction[],
  ) => void;
  onElementAnimationsFinish?: () => void;

  // Proactive discussion
  onProactiveShow?: (trigger: TriggerEvent) => void;
  onProactiveHide?: () => void;

  // Discussion lifecycle
  onDiscussionConfirmed?: (
    topic: string,
    prompt?: string,
    agentId?: string,
  ) => void;
  onDiscussionEnd?: () => void;
  onUserInterrupt?: (text: string) => void;
  onInteractionStart?: (payload: InteractionCheckpointPayload) => void;
  onInteractionComplete?: (checkpointId: string) => void;

  // Topic / Transcript
  onTopicStart?: (type: "lecture" | "discussion", title: string) => void;
  onTopicAppend?: (role: string, text: string) => void;
  onTopicEnd?: () => void;

  // Progress tracking (for persistence)
  onProgress?: (snapshot: PlaybackSnapshot) => void;

  /** Check if a given agent is in the user's selected list (for skipping discussion actions) */
  isAgentSelected?: (agentId: string) => boolean;

  /** Whether classroom preview should allow discussion UI/flow. Defaults to enabled. */
  isDiscussionEnabled?: () => boolean;

  /** Whether classroom preview should allow whiteboard actions/UI. Defaults to enabled. */
  isWhiteboardEnabled?: () => boolean;

  /** Get current playback speed multiplier (e.g. 1, 1.5, 2) */
  getPlaybackSpeed?: () => number;

  /** 实时获取最新的 audioUrl（TTS 生成完成后可能后于 engine 创建才写入） */
  getLatestAudioUrl?: (
    sceneId: string,
    actionId: string,
    audioId: string,
  ) => string | undefined;

  onPlaybackError?: (error: Error) => void;
  onComplete?: () => void;
}
