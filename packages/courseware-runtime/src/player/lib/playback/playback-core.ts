/**
 * Playback Engine - Unified state machine for lecture playback and live discussion
 *
 * Consumes Scene.actions[] directly via ActionEngine.
 * No intermediate compile step — actions are executed as-is.
 *
 * State machine:
 *
 *                  start()                  pause()
 *   idle ──────────────────→ playing ──────────────→ paused
 *     ▲                         ▲                       │
 *     │                         │  resume()             │
 *     │                         └───────────────────────┘
 *     │
 *     │  handleEndDiscussion()
 *     │                         confirmDiscussion()
 *     │                         / handleUserInterrupt()
 *     │                              │
 *     │                              ▼         pause()
 *     └──────────────────────── live ──────────────→ paused
 *                                 ▲                    │
 *                                 │ resume / user msg  │
 *                                 └────────────────────┘
 */

import type { Scene } from "../types/stage";
import type {
  Action,
  ElementAnimationAction,
  SpeechAction,
  AudioClipAction,
  DiscussionAction,
  InteractionCheckpointAction,
} from "../types/action";
import type {
  EngineMode,
  TopicState,
  PlaybackEngineCallbacks,
  PlaybackSnapshot,
  TriggerEvent,
  Effect,
} from "./types";
import type { AudioPlayer } from "../utils/audio-player";

import { createLogger } from "../logger";
import { buildActionExecutionGroups } from "./action-groups";
import { validatePptxTimeline } from "./pptx-timeline";
import { isManualPptxRotation } from "./element-animation";
import { SpeechCueScheduler } from "./speech-cue-scheduler";

const log = createLogger("PlaybackEngine");

/**
 * If more than 30% of characters are CJK, treat the text as Chinese.
 * Intentionally low: mixed Chinese text often contains punctuation,
 * numbers, and short Latin fragments (e.g. "AI课堂").
 */
const CJK_LANG_THRESHOLD = 0.3;
const MAX_SPEECH_PAUSE_MS = 30_000;

function normalizeSpeechPauseMs(value: number | undefined): number {
  if (!Number.isFinite(value) || !value || value <= 0) return 0;
  return Math.min(Math.round(value), MAX_SPEECH_PAUSE_MS);
}

export interface PlaybackRuntime {
  closeWhiteboard?: () => void;
  getSpeechSettings?: () => {
    ttsEnabled?: boolean;
    ttsProviderId?: string;
    ttsSpeed?: number;
    ttsMuted?: boolean;
    ttsVolume?: number;
    ttsVoice?: string;
  };
  speechFallback?: "reading" | "pause" | "browser";
  getSpeechTailDuration?(actionId: string, audioDurationMs: number): number;
  waitForSpeechEffects?(actionId: string): Promise<void>;
  /** Canonical Quiz is a scene lifecycle, never an interaction checkpoint action. */
  onQuizReady?(sceneId: string): void;
  waitForMediaCheckpoint?: boolean;

}
export interface PlaybackActions {
execute(action: Action): Promise<void>;
clearEffects(): void;
pauseActiveVideo(): boolean;
resumeActiveVideo(): boolean;
stopActiveVideo(): boolean;
}

export class PlaybackCore {
  private scenes: Scene[] = [];
  private sceneIndex: number = 0;
  private actionIndex: number = 0;
  private mode: EngineMode = "idle";
  private consumedDiscussions: Set<string> = new Set();
  private completedQuizzes = new Set<string>();

  // Discussion state save
  private savedSceneIndex: number | null = null;
  private savedActionIndex: number | null = null;

  // Discussion topic state
  private currentTopicState: TopicState | null = null;

  // Dependencies
  private audioPlayer: AudioPlayer;
  private actionEngine: PlaybackActions;
  private callbacks: PlaybackEngineCallbacks;

  // Internal state
  private currentTrigger: TriggerEvent | null = null;
  private currentInteractionCheckpointId: string | null = null;
  private triggerDelayTimer: ReturnType<typeof setTimeout> | null = null;
  private animationTimer: {
    id: ReturnType<typeof setTimeout>;
    resolve: () => void;
    startedAt: number;
    remainingMs: number;
  } | null = null;
  private pausedAnimationTimer: {
    resolve: () => void;
    remainingMs: number;
  } | null = null;
  private executionEpoch = 0;
  private activeExecutionStartIndex: number | null = null;
  // Reading-time timer for speech actions without pre-generated audio (TTS disabled)
  private speechTimer: ReturnType<typeof setTimeout> | null = null;
  private speechTimerStart: number = 0; // Date.now() when timer was scheduled
  private speechTimerCompletion: (() => void) | null = null;
  private currentSpeechPauseAfterMs: number = 0;
  private currentSpeechResolve: (() => void) | null = null;
  private currentAudioIsClip = false;
  private speechTail: { actionId: string; audioDurationMs: number; durationMs: number } | null = null;
  private currentSpeechId = '';
  private waitingSpeechEffects = false;

  private speechExecutionId = 0;
  private retrySpeech: (() => void) | null = null;
  private speechCueScheduler: SpeechCueScheduler | null = null;
  // Browser-native TTS state (Web Speech API)
  private browserTTSActive: boolean = false;
  private browserTTSAttempt = 0;
  private browserTTSChunks: string[] = []; // sentence-level chunks for sequential playback
  private browserTTSChunkIndex: number = 0; // current chunk being spoken
  private browserTTSPausedChunks: string[] = []; // remaining chunks saved on pause (for cancel+re-speak)
  private speechTimerRemaining: number = 0; // remaining ms (set on pause)

  constructor(
    scenes: Scene[],
    actionEngine: PlaybackActions,
    audioPlayer: AudioPlayer,
    callbacks: PlaybackEngineCallbacks = {},
    private readonly runtime: PlaybackRuntime = {},
  ) {
    this.scenes = scenes;
    this.actionEngine = actionEngine;
    this.audioPlayer = audioPlayer;
    this.callbacks = callbacks;
  }

  // ==================== Public API ====================

  /** Get the current engine mode */
  getMode(): EngineMode {
    return this.mode;
  }

  /** Resume the Quiz review narration and scene sequence after submitted work. */
  completeQuiz(): void {
    const scene = this.scenes[this.sceneIndex];
    if (!scene || scene.content.type !== 'quiz' || this.mode !== 'idle') return;
    this.completedQuizzes.add(scene.id);
    this.continuePlayback();
  }

  /** Terminal feedback uses configured speech; the serialized scene stays untouched. */
  async answerInstantQuiz(correct: boolean): Promise<void> {
    const scene = this.scenes[this.sceneIndex];
    if (scene?.content.type !== 'quiz' || scene.content.interactionMode !== 'classroom_instant_feedback' || this.mode !== 'idle') return;
    const config = scene.content.playbackConfig;
    const text = correct ? config?.successSpeechText ?? '回答正确！非常棒！' : config?.failureSpeechText ?? '很遗憾，你选错了，再试一次吧！';
    const epoch = this.executionEpoch;
    this.setMode('playing');
    if (text) await this.executeSpeechAction({ id: `${scene.id}:feedback`, type: 'speech', text });
    if (this.executionEpoch !== epoch || this.getMode() !== 'playing') return;
    if (correct) {
      this.completedQuizzes.add(scene.id); void this.processNext();
    } else {
      this.setMode('idle'); this.runtime.onQuizReady?.(scene.id);
    }
  }

  /** Export a serializable playback snapshot */
  getSnapshot(): PlaybackSnapshot {
    return {
      sceneIndex: this.sceneIndex,
      actionIndex: this.actionIndex,
      consumedDiscussions: [...this.consumedDiscussions],
      sceneId: this.scenes[this.sceneIndex]?.id,
    };
  }

  /** Restore playback position from a snapshot */
  restoreFromSnapshot(snapshot: PlaybackSnapshot): void {
    this.sceneIndex = snapshot.sceneIndex;
    this.actionIndex = snapshot.actionIndex;
    this.consumedDiscussions = new Set(snapshot.consumedDiscussions);
  }

  /** idle → playing (from beginning) */
  start(): void {
    if (this.mode !== "idle") {
      log.warn("Cannot start: not idle, current mode:", this.mode);
      return;
    }

    this.sceneIndex = 0;
    this.completedQuizzes.clear();
    this.actionIndex = 0;
    this.executionEpoch += 1;
    this.setMode("playing");
    this.processNext();
  }

  /** idle → playing (continue from current position, e.g. after discussion end) */
  continuePlayback(): void {
    if (this.mode !== "idle") {
      log.warn("Cannot continue: not idle, current mode:", this.mode);
      return;
    }
    this.setMode("playing");
    this.processNext();
  }

  /** playing → paused | live → paused (abort SSE, truncate, topic pending) */
  pause(): void {
    if (this.mode === "playing") {
      // Cancel pending timers
      if (this.triggerDelayTimer) {
        clearTimeout(this.triggerDelayTimer);
        this.triggerDelayTimer = null;
      }
      this.pauseAnimationTimer();
      this.speechCueScheduler?.pause();
      if (this.speechTimer) {
        // Save remaining time so resume() can reschedule
        this.speechTimerRemaining = Math.max(
          0,
          this.speechTimerRemaining - (Date.now() - this.speechTimerStart),
        );
        clearTimeout(this.speechTimer);
        this.speechTimer = null;
      }
      this.actionEngine.pauseActiveVideo?.();
      this.setMode("paused");
      // Freeze TTS — but skip if waiting on ProactiveCard (no active speech)
      if (!this.currentTrigger) {
        if (this.browserTTSActive) {
          this.browserTTSAttempt += 1;
          // Cancel+re-speak pattern: save remaining chunks for resume.
          // speechSynthesis.pause()/resume() is broken on Firefox, so we
          // cancel now and re-speak from current chunk onward on resume.
          this.browserTTSPausedChunks = this.browserTTSChunks.slice(
            this.browserTTSChunkIndex,
          );
          window.speechSynthesis?.cancel();
          // Note: cancel fires onerror('canceled'), which we ignore (see playBrowserTTSChunk)
        } else if (this.audioPlayer.isPlaying()) {
          this.audioPlayer.pause();
        }
      }
    } else if (this.mode === "live") {
      this.setMode("paused");
      this.currentTopicState = "pending";
      // Caller is responsible for aborting SSE
    } else {
      log.warn("Cannot pause: mode is", this.mode);
    }
  }

  /** paused → playing (TTS resume) | paused (in discussion) → live */
  resume(): void {
    if (this.mode !== "paused") {
      log.warn("Cannot resume: not paused, mode is", this.mode);
      return;
    }

    if (this.retrySpeech) {
      this.setMode("playing");
      const retry = this.retrySpeech;
      this.retrySpeech = null;
      retry();
      return;
    }
    if (this.currentTopicState === "pending") {
      // Resume discussion → live
      this.currentTopicState = "active";
      this.setMode("live");
    } else if (this.currentTrigger) {
      // Waiting on ProactiveCard — just resume mode, don't touch audio
      this.setMode("playing");
    } else {
      // Resume lecture
      this.setMode("playing");
      const resumedAnimation = this.resumeAnimationTimer();
      const resumedVideo = this.actionEngine.resumeActiveVideo?.() ?? false;
      let resumedSpeech = false;
      if (this.browserTTSPausedChunks.length > 0) {
        // Browser TTS was paused via cancel — re-speak remaining chunks
        this.browserTTSActive = true;
        this.browserTTSChunks = this.browserTTSPausedChunks;
        this.browserTTSChunkIndex = 0;
        this.browserTTSPausedChunks = [];
        this.playBrowserTTSChunk();
        resumedSpeech = true;
      } else if (this.waitingSpeechEffects) {
        resumedSpeech = true;
      } else if (this.speechTimerCompletion) {
        // Reading time or post-speech pause was frozen by pause().
        if (this.speechTimerRemaining > 0) {
          const completion = this.speechTimerCompletion;
          this.scheduleSpeechTimer(this.speechTimerRemaining, completion);
          if (this.speechTail) this.speechCueScheduler?.resume();
        } else {
          this.completeSpeechTimer();
        }
        resumedSpeech = true;
      } else if (this.audioPlayer.hasActiveAudio()) {
        // Audio is paused — resume it; TTS onend will call processNext
        this.audioPlayer.resume();
        this.speechCueScheduler?.resume();
        resumedSpeech = true;
      }
      if (!resumedAnimation && !resumedVideo && !resumedSpeech) {
        // TTS finished while paused, continue to next event
        this.processNext();
      }
    }
  }

  seekCurrentSpeech(timeMs: number): void {
    if (
      !Number.isFinite(timeMs) ||
      !this.currentSpeechResolve ||
      !this.audioPlayer.hasActiveAudio()
    )
      return;
    this.audioPlayer.seek(timeMs);
    this.speechCueScheduler?.seek(this.audioPlayer.getCurrentTime());
  }

  /** A paused failure is distinct from an ordinary user pause or teacher wait. */
  canSkipFailedSpeech(): boolean {
    return this.mode === "paused" && this.retrySpeech !== null && this.currentSpeechResolve !== null;
  }

  /** End the current blocking media only after an explicit caller action. */
  skipCurrentPlaybackPoint(): boolean {
    if (this.mode !== "playing") {
      if (!this.canSkipFailedSpeech()) return false;
      this.setMode("playing");
    }

    const hasSpeech = this.currentSpeechResolve !== null;
    const hasAudio = this.audioPlayer.hasActiveAudio();
    const stoppedVideo = this.actionEngine.stopActiveVideo?.() ?? false;
    if (!hasSpeech && !hasAudio && !stoppedVideo) return false;

    this.callbacks.onElementAnimationsFinish?.();
    this.clearAnimationTimer();
    if (hasSpeech) {
      this.callbacks.onSpeechEnd?.();
      this.cancelCurrentSpeech(true);
    }
    if (hasAudio) this.audioPlayer.stop();
    this.cancelBrowserTTS();
    return true;
  }

  /** → idle */
  stop(): void {
    this.completedQuizzes.clear();
    // Set mode BEFORE stopping audio to prevent spurious processNext from
    // synchronous onend callbacks (see handleUserInterrupt for details).
    this.setMode("idle");
    this.executionEpoch += 1;
    this.cancelCurrentSpeech();
    this.audioPlayer.stop();
    this.actionEngine.stopActiveVideo?.();
    this.cancelBrowserTTS();
    this.actionEngine.clearEffects();
    if (this.triggerDelayTimer) {
      clearTimeout(this.triggerDelayTimer);
      this.triggerDelayTimer = null;
    }
    this.clearAnimationTimer();
    this.sceneIndex = 0;
    this.actionIndex = 0;
    this.activeExecutionStartIndex = null;
    this.savedSceneIndex = null;
    this.savedActionIndex = null;
    this.currentTopicState = null;
    this.currentTrigger = null;
    this.currentInteractionCheckpointId = null;
  }

  /** User clicks "Join" on ProactiveCard → save cursor → live */
  confirmDiscussion(): void {
    if (!this.currentTrigger) {
      log.warn("confirmDiscussion called but no trigger");
      return;
    }

    // Mark consumed so it won't re-trigger on replay
    this.consumedDiscussions.add(this.currentTrigger.id);

    // Save lecture state — keep actionIndex as-is (past the discussion).
    // Discussions are placed after all speech actions, so the preceding
    // speech was already fully played; no need to replay it.
    this.savedSceneIndex = this.sceneIndex;
    this.savedActionIndex = this.actionIndex;

    // Enter live mode
    this.currentTopicState = "active";
    this.setMode("live");

    // Notify callbacks
    this.callbacks.onProactiveHide?.();
    this.callbacks.onDiscussionConfirmed?.(
      this.currentTrigger.question,
      this.currentTrigger.prompt,
      this.currentTrigger.agentId,
    );
    this.currentTrigger = null;
  }

  /** User clicks "Skip" on ProactiveCard → consumed → processNext */
  skipDiscussion(): void {
    if (this.currentTrigger) {
      this.consumedDiscussions.add(this.currentTrigger.id);
      this.currentTrigger = null;
    }
    this.callbacks.onProactiveHide?.();

    if (this.mode === "playing") {
      this.processNext();
    }
  }

  /** End discussion → restore lecture → idle (user clicks "start" to continue) */
  handleEndDiscussion(): void {
    this.actionEngine.clearEffects();
    this.currentTopicState = "closed";

    // Close whiteboard if it was open during the discussion
    this.runtime.closeWhiteboard?.();

    this.callbacks.onDiscussionEnd?.();

    // Restore lecture state
    this.restoreSavedLectureState();

    this.setMode("idle");
  }

  /** 用户结束互动检查点后恢复正常播放 */
  resumeInteraction(checkpointId?: string): void {
    if (
      this.mode !== "waiting_interaction" ||
      !this.currentInteractionCheckpointId
    ) {
      log.warn("resumeInteraction called but no interaction is waiting");
      return;
    }

    if (checkpointId && checkpointId !== this.currentInteractionCheckpointId) {
      log.warn(
        "resumeInteraction checkpoint mismatch:",
        checkpointId,
        "expected:",
        this.currentInteractionCheckpointId,
      );
      return;
    }

    const completedCheckpointId = this.currentInteractionCheckpointId;
    this.currentInteractionCheckpointId = null;
    this.callbacks.onInteractionComplete?.(completedCheckpointId);
    this.setMode("playing");
    this.processNext();
  }

  /**
   * Exit live discussion mode after a request failure without treating it as a
   * normal discussion end. The chat session stays retryable; this only restores
   * the playback engine to a coherent non-live state.
   */
  handleDiscussionError(): void {
    const hasSavedLectureState =
      this.savedSceneIndex !== null && this.savedActionIndex !== null;
    const isLiveTopic =
      this.mode === "live" ||
      (this.mode === "paused" && this.currentTopicState === "pending");

    if (!isLiveTopic && !hasSavedLectureState) {
      return;
    }

    this.actionEngine.clearEffects();
    this.runtime.closeWhiteboard?.();
    this.currentTopicState = "closed";
    this.currentTrigger = null;
    this.restoreSavedLectureState();
    this.setMode("idle");
  }

  /** User sends a message during playback → interrupt → live mode */
  handleUserInterrupt(text: string): void {
    if (this.mode === "playing" || this.mode === "paused") {
      // Save lecture state BEFORE stopping audio — actionIndex was already
      // incremented by processNext, so subtract 1 to replay the interrupted
      // sentence when resuming.  Guard against overwriting a previously saved
      // position (e.g. live → paused → new message).
      if (this.savedSceneIndex === null) {
        this.savedSceneIndex = this.sceneIndex;
        this.savedActionIndex =
          this.activeExecutionStartIndex ?? Math.max(0, this.actionIndex - 1);
      }

      // Cancel pending trigger delay
      if (this.triggerDelayTimer) {
        clearTimeout(this.triggerDelayTimer);
        this.triggerDelayTimer = null;
      }
    }

    // Set mode BEFORE stopping audio — speechSynthesis.cancel() may fire the
    // onend callback synchronously, and the processNext guard checks
    // `this.mode === 'playing'`.  Setting mode first prevents a spurious
    // processNext that would advance actionIndex past the interrupted speech.
    this.currentTopicState = "active";
    this.setMode("live");
    this.executionEpoch += 1;
    this.cancelCurrentSpeech();
    this.audioPlayer.stop();
    this.cancelBrowserTTS();
    this.actionEngine.stopActiveVideo?.();
    this.clearAnimationTimer();
    this.callbacks.onUserInterrupt?.(text);
  }

  /** Whether all remaining actions have been consumed (no speech left to play) */
  isExhausted(): boolean {
    let si = this.sceneIndex;
    let ai = this.actionIndex;
    while (si < this.scenes.length) {
      if (this.runtime.onQuizReady && this.scenes[si].content.type === 'quiz' && !this.completedQuizzes.has(this.scenes[si].id)) return false;
      const actions = this.scenes[si].actions || [];
      while (ai < actions.length) {
        const action = actions[ai];
        // Consumed discussions don't count as remaining work
        if (
          action.type === "discussion" &&
          this.consumedDiscussions.has(action.id)
        ) {
          ai++;
          continue;
        }
        return false;
      }
      si++;
      ai = 0;
    }
    return true;
  }

  // ==================== Private ====================

  private setMode(mode: EngineMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.callbacks.onModeChange?.(mode);
  }

  private restoreSavedLectureState(): void {
    if (this.savedSceneIndex !== null && this.savedActionIndex !== null) {
      this.sceneIndex = this.savedSceneIndex;
      this.actionIndex = this.savedActionIndex;
    }
    this.savedSceneIndex = null;
    this.savedActionIndex = null;
  }

  /**
   * Get the current action, or null if playback is complete.
   * Advances sceneIndex automatically when a scene's actions are exhausted.
   */
  private getCurrentAction(): { action: Action; sceneId: string } | null {
    while (this.sceneIndex < this.scenes.length) {
      const scene = this.scenes[this.sceneIndex];
      const actions = scene.actions || [];

      if (scene.content.type === 'quiz' && this.runtime.onQuizReady && !this.completedQuizzes.has(scene.id)) {
        // Same phase projection as cloud-web getQuizPlaybackActionsForPhase:
        // first two speech actions introduce the page, remaining speech reviews it.
        const speeches = actions.flatMap((a, index) => a.type === 'speech' ? [index] : []);
        const boundary = speeches.length > 2 ? speeches[2] : actions.length;
        if (this.actionIndex >= boundary) return null;
      }

      if (this.actionIndex < actions.length) {
        return { action: actions[this.actionIndex], sceneId: scene.id };
      }

      // Move to next scene
      this.sceneIndex++;
      this.actionIndex = 0;
    }
    return null;
  }

  /**
   * Core processing loop: consume the next action.
   */
  private async processNext(): Promise<void> {
    if (this.mode !== "playing") return;

    // Resolve the cursor before announcing a new scene (getCurrentAction may cross a boundary).
    const current = this.getCurrentAction();
    // Check for scene boundary (fire scene change callback at start of each new scene)
    if (this.actionIndex === 0 && this.sceneIndex < this.scenes.length) {
      const scene = this.scenes[this.sceneIndex];
      this.actionEngine.clearEffects();
      this.callbacks.onSceneChange?.(scene.id);
      this.callbacks.onSpeakerChange?.("teacher");
    }

    if (!current) {
      const scene = this.scenes[this.sceneIndex];
      if (scene?.content.type === 'quiz' && this.runtime.onQuizReady) {
        this.setMode('idle');
        this.runtime.onQuizReady(scene.id);
        return;
      }
      // All scenes complete
      this.actionEngine.clearEffects();
      this.setMode("idle");
      this.callbacks.onComplete?.();
      return;
    }

    const { action } = current;
    const sceneActions = this.scenes[this.sceneIndex]?.actions ?? [];
    const timeline = validatePptxTimeline(sceneActions);
    const executionGroup = buildActionExecutionGroups(
      sceneActions.slice(this.actionIndex),
    )[0];
    const executionStartIndex = this.actionIndex;
    this.activeExecutionStartIndex = executionStartIndex;

    // Notify progress BEFORE advancing the cursor so the snapshot points at
    // the current action.  On restore the same action will be replayed — this
    // is the desired behaviour for speech (user may have only heard half).
    this.callbacks.onProgress?.(this.getSnapshot());

    this.actionIndex += executionGroup?.actions.length ?? 1;

    if (
      action.type === "element_animation" &&
      action.speechCue &&
      !action.pptxTimeline
    ) {
      this.processNext();
      return;
    }

    if (action.pptxTimeline && timeline.status !== "valid") {
      this.processNext();
      return;
    }

    if (isManualPptxRotation(action)) {
      this.processNext();
      return;
    }

    if (action.pptxTimeline && executionGroup) {
      const executionEpoch = this.executionEpoch;
      await this.executePptxTimelineStep(executionGroup.actions);
      if (this.mode === "playing" && this.executionEpoch === executionEpoch) {
        this.processNext();
      }
      return;
    }

    switch (action.type) {
      case "delay": {
        if (!Number.isInteger(action.durationMs) || action.durationMs < 0 || action.durationMs > 30000) {
          this.pause();
          this.callbacks.onPlaybackError?.(new Error("Invalid teaching delay"));
          break;
        }
        this.scheduleSpeechTimer(action.durationMs, () => this.processNext());
        break;
      }
      case "video_clip": {
        this.currentInteractionCheckpointId = action.id;
        this.callbacks.onInteractionStart?.({ checkpointId: action.id, checkpointKind: "media_playback", elementId: action.id,
          mediaType: "video", startMode: "teacher_triggered", waitForCompletion: true, videoUrl: action.videoUrl });
        this.setMode("waiting_interaction");
        break;
      }
      case "speech":
      case "audio_clip": {
        const executionEpoch = this.executionEpoch;
        await this.executeSpeechAction(action);
        if (this.mode === "playing" && this.executionEpoch === executionEpoch) {
          this.processNext();
        }
        break;
      }

      case "highlight":
      case "spotlight":
      case "laser": {
        // Fire-and-forget visual effects via ActionEngine
        this.actionEngine.execute(action);
        this.callbacks.onEffectFire?.({
          ...(action.type === "highlight"
            ? {
                kind: "highlight" as const,
                targetIds: action.elementIds,
                color: action.color,
                opacity: action.opacity,
                style: action.style,
              }
            : {
                kind: action.type,
                targetId: action.elementId,
              }),
          ...(action.type === "spotlight"
            ? { dimOpacity: action.dimOpacity, elementIds: action.elementIds }
            : action.type === "laser"
              ? { color: action.color }
              : {}),
        } as Effect);
        // Don't block — continue immediately
        this.processNext();
        break;
      }

      case "element_animation": {
        const animations = executionGroup?.actions.filter(
          (item): item is ElementAnimationAction =>
            item.type === "element_animation",
        ) ?? [action];
        const executionEpoch = this.executionEpoch;
        await this.executeAnimationActions(animations);
        if (this.mode === "playing" && this.executionEpoch === executionEpoch) {
          this.processNext();
        }
        break;
      }

      case "discussion": {
        const discussionAction = action as DiscussionAction;
        // Check if already consumed
        if (this.consumedDiscussions.has(discussionAction.id)) {
          this.processNext();
          return;
        }
        // Skip if the discussion's agent isn't in the user's selected list
        if (
          discussionAction.agentId &&
          this.callbacks.isAgentSelected &&
          !this.callbacks.isAgentSelected(discussionAction.agentId)
        ) {
          this.consumedDiscussions.add(discussionAction.id);
          this.processNext();
          return;
        }
        if (this.callbacks.isDiscussionEnabled?.() === false) {
          this.consumedDiscussions.add(discussionAction.id);
          this.processNext();
          return;
        }

        // 3s delay before showing ProactiveCard (allows previous speech to finish naturally)
        const trigger: TriggerEvent = {
          id: discussionAction.id,
          question: discussionAction.topic,
          prompt: discussionAction.prompt,
          agentId: discussionAction.agentId,
        };

        this.triggerDelayTimer = setTimeout(() => {
          this.triggerDelayTimer = null;
          if (this.mode !== "playing") return; // Cancelled if user paused/stopped
          this.currentTrigger = trigger;
          this.callbacks.onProactiveShow?.(trigger);
          // Engine pauses here — user calls confirmDiscussion() or skipDiscussion()
        }, 3000);
        break;
      }

      case "interaction_checkpoint": {
        const interactionAction = action as InteractionCheckpointAction;
        if (interactionAction.checkpointKind === "media_playback") {
          if (this.runtime.waitForMediaCheckpoint) {
            this.currentInteractionCheckpointId = interactionAction.checkpointId;
            const { id: _id, type: _type, ...payload } = interactionAction;
            this.callbacks.onInteractionStart?.(payload);
            this.setMode('waiting_interaction');
          } else this.processNext();
          break;
        }
        this.currentInteractionCheckpointId = interactionAction.checkpointId;
        if (interactionAction.checkpointKind === "teacher_continue") {
          this.callbacks.onInteractionStart?.({ checkpointId: interactionAction.checkpointId, checkpointKind: "teacher_continue" });
          this.setMode("waiting_interaction");
          break;
        }
        this.callbacks.onInteractionStart?.({
          checkpointId: interactionAction.checkpointId,
          checkpointKind: interactionAction.checkpointKind,
          chapterId: interactionAction.chapterId,
          chapterTitle: interactionAction.chapterTitle,
          question: interactionAction.question,
          constraintPrompt: interactionAction.constraintPrompt,
          referenceAnswer: interactionAction.referenceAnswer,
          context: interactionAction.context,
        });
        this.setMode("waiting_interaction");
        break;
      }

      case "play_video":
      case "play_audio":
      case "wb_open":
      case "wb_draw_text":
      case "wb_draw_shape":
      case "wb_draw_chart":
      case "wb_draw_latex":
      case "wb_draw_table":
      case "wb_draw_line":
      case "wb_clear":
      case "wb_delete":
      case "wb_close": {
        if (
          action.type.startsWith("wb_") &&
          this.callbacks.isWhiteboardEnabled?.() === false
        ) {
          this.processNext();
          return;
        }
        // Synchronous whiteboard actions — await completion, then continue
        try { await this.actionEngine.execute(action); }
        catch (error) {
          this.pause();
          this.callbacks.onPlaybackError?.(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        if (this.mode === "playing") {
          this.processNext();
        }
        break;
      }

      default:
        // Unknown action, skip
        this.processNext();
        break;
    }
  }

  private async executePptxTimelineStep(actions: Action[]): Promise<void> {
    const animations = actions.filter(
      (action): action is ElementAnimationAction =>
        action.type === "element_animation",
    );
    const media = actions.filter(
      (action) => action.type === "play_audio" || action.type === "play_video",
    );
    const speeches = actions.filter(
      (action): action is SpeechAction => action.type === "speech",
    );
    const unboundSpeeches = speeches.filter(
      (speech) => !speech.pptxTimeline?.animationIds?.length,
    );
    const speak = async (phase: "before" | "with" | "after") => {
      for (const speech of unboundSpeeches) {
        if (speech.pptxTimeline?.phase === phase) {
          await this.executeSpeechAction(speech);
        }
      }
    };

    await speak("before");

    if (media.length > 0) {
      const playMedia = async () => {
        for (const action of media) {
          await this.actionEngine.execute(action).catch((error) => {
            log.warn("PPTX step media playback failed:", error);
          });
        }
      };
      await Promise.all([
        this.executeAnimationActions(animations),
        playMedia(),
      ]);
    } else if (
      speeches.some((speech) => speech.pptxTimeline?.animationIds?.length)
    ) {
      await this.executeBoundPptxNarration(animations, speeches);
    } else {
      await Promise.all([
        this.executeAnimationActions(animations),
        speak("with"),
      ]);
    }

    await speak("after");
    if (speeches.length === 0 && animations.length > 0) {
      await this.waitForAnimationDuration(200);
    }
  }

  private async executeBoundPptxNarration(
    animations: ElementAnimationAction[],
    speeches: SpeechAction[],
  ): Promise<void> {
    const animationIndex = new Map(
      animations.flatMap((animation, index) =>
        animation.pptistAnimationId
          ? [[animation.pptistAnimationId, index] as const]
          : [],
      ),
    );
    const indexedSpeeches = speeches.map((speech, speechIndex) => ({
      speech,
      speechIndex,
    }));
    const bindings = speeches.flatMap((speech, speechIndex) => {
      const ids = speech.pptxTimeline?.animationIds;
      if (!ids?.length) return [];
      return [
        {
          speech,
          speechIndex,
          start: animationIndex.get(ids[0])!,
          end: animationIndex.get(ids.at(-1)!)!,
        },
      ];
    });
    const unboundWithSpeeches = indexedSpeeches.filter(
      ({ speech }) =>
        speech.pptxTimeline?.phase === "with" &&
        !speech.pptxTimeline.animationIds?.length,
    );
    let animationCursor = 0;
    let unboundWithCursor = 0;
    let previousAnimationEnd = 0;
    const playNarration = async (segmentSpeeches: SpeechAction[]) => {
      for (const speech of segmentSpeeches) {
        await this.executeSpeechAction(speech);
      }
    };
    const playAnimations = async (
      segmentAnimations: ElementAnimationAction[],
    ) => {
      const normalizedAnimations = segmentAnimations.map((animation) => ({
        ...animation,
        startAtMs: Math.max(
          0,
          (animation.startAtMs ?? 0) - previousAnimationEnd,
        ),
      }));
      await this.executeAnimationActions(normalizedAnimations);
      if (segmentAnimations.length > 0) {
        previousAnimationEnd = Math.max(
          previousAnimationEnd,
          ...segmentAnimations.map(
            (animation) => (animation.startAtMs ?? 0) + animation.duration,
          ),
        );
      }
    };
    const runConcurrent = (
      segmentAnimations: ElementAnimationAction[],
      segmentSpeeches: SpeechAction[],
    ) =>
      Promise.all([
        playAnimations(segmentAnimations),
        playNarration(segmentSpeeches),
      ]).then(() => undefined);

    for (const binding of bindings) {
      const precedingWithSpeeches: SpeechAction[] = [];
      while (
        unboundWithSpeeches[unboundWithCursor]?.speechIndex <
        binding.speechIndex
      ) {
        precedingWithSpeeches.push(
          unboundWithSpeeches[unboundWithCursor++].speech,
        );
      }
      await runConcurrent(
        animations.slice(animationCursor, binding.start),
        precedingWithSpeeches,
      );
      const boundAnimations = animations.slice(binding.start, binding.end + 1);
      if (binding.speech.pptxTimeline?.phase === "before") {
        await playNarration([binding.speech]);
        await playAnimations(boundAnimations);
      } else if (binding.speech.pptxTimeline?.phase === "after") {
        await playAnimations(boundAnimations);
        await playNarration([binding.speech]);
      } else {
        await runConcurrent(boundAnimations, [binding.speech]);
      }
      animationCursor = binding.end + 1;
    }
    await runConcurrent(
      animations.slice(animationCursor),
      unboundWithSpeeches.slice(unboundWithCursor).map(({ speech }) => speech),
    );
  }

  private async executeAnimationActions(
    animations: ElementAnimationAction[],
  ): Promise<void> {
    const duration = Math.max(
      0,
      ...animations.map((animation) =>
        Number.isFinite(animation.duration)
          ? (animation.startAtMs ?? 0) + animation.duration
          : 0,
      ),
    );
    await Promise.all([
      duration > 0
        ? this.waitForAnimationDuration(duration)
        : Promise.resolve(),
      ...animations.map((animation) =>
        Promise.resolve()
          .then(() => this.callbacks.onElementAnimation?.(animation))
          .catch((error) => {
            log.warn("Element animation callback failed:", error);
          }),
      ),
    ]);
  }

  private executeSpeechAction(speechAction: SpeechAction | AudioClipAction): Promise<void> {
    const isSpeech = speechAction.type === "speech";
    this.currentAudioIsClip = !isSpeech;
    this.currentSpeechId = speechAction.id;
    this.speechTail = null;
    const speechExecutionId = ++this.speechExecutionId;
    this.currentSpeechPauseAfterMs = normalizeSpeechPauseMs(
      isSpeech ? speechAction.pauseAfterMs : undefined,
    );
    if (isSpeech) this.callbacks.onSpeechStart?.(speechAction.text);
    const currentScene = this.scenes[this.sceneIndex];
    const speechCueActions = (currentScene?.actions ?? []).filter(
      (action): action is ElementAnimationAction =>
        isSpeech && action.type === "element_animation" &&
        !action.pptxTimeline &&
        action.speechCue?.speechActionId === speechAction.id,
    );
    this.speechCueScheduler?.stop();
    this.speechCueScheduler =
      speechCueActions.length || (isSpeech ? this.callbacks.onSpeechProgress : this.callbacks.onAudioClipProgress)
        ? new SpeechCueScheduler(
            speechCueActions,
            () => this.speechTail ? this.speechTail.audioDurationMs + Math.min(this.speechTail.durationMs,
              this.speechTail.durationMs - this.speechTimerRemaining + (this.speechTimer ? Date.now() - this.speechTimerStart : 0)) : this.audioPlayer.getCurrentTime(),
            (cue) => {
              void Promise.resolve(
                this.callbacks.onElementAnimation?.(cue),
              ).catch((error) => {
                log.warn("Speech cue animation callback failed:", error);
              });
            },
            (completed, scope) =>
              this.callbacks.onElementAnimationReconcile?.(completed, scope),
            (timeMs) =>
              (isSpeech ? this.callbacks.onSpeechProgress : this.callbacks.onAudioClipProgress)?.({
                actionId: speechAction.id,
                timeMs,
                durationMs: this.audioPlayer.getDuration(),
              }),
          )
        : null;

    return new Promise<void>((resolve) => {
      this.currentSpeechResolve = resolve;
      let sourceSettled = false;
      let audioAttempt = 0;
      const isActive = () =>
        speechExecutionId === this.speechExecutionId &&
        this.currentSpeechResolve !== null;
      const finishSource = () => {
        if (sourceSettled || !isActive()) return;
        sourceSettled = true;
        this.finishCurrentSpeech();
      };
      const scheduleReadingTimer = () => {
        if (!isSpeech) return;
        if (sourceSettled || !isActive()) return;
        sourceSettled = true;
        const text = speechAction.text;
        const cjkCount = (
          text.match(
            /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g,
          ) || []
        ).length;
        const isCJK = cjkCount > text.length * CJK_LANG_THRESHOLD;
        const speed = this.callbacks.getPlaybackSpeed?.() ?? 1;
        const rawMs = isCJK
          ? Math.max(2000, text.length * 150)
          : Math.max(2000, text.split(/\s+/).filter(Boolean).length * 240);
        this.scheduleSpeechTimer(rawMs / speed, () => {
          if (isActive()) this.finishCurrentSpeech();
        });
      };

      const failSource = (error: Error) => {
        if (!isActive()) return;
        if (isSpeech && this.runtime.speechFallback !== "pause" && this.runtime.speechFallback !== 'browser') {
          scheduleReadingTimer();
          return;
        }
        this.audioPlayer.pause();
        this.speechCueScheduler?.pause();
        this.retrySpeech = startAudio;
        this.setMode("paused");
        this.callbacks.onPlaybackError?.(error);
      };
      const startAudio = () => {
        if (!isActive()) return;
        const attempt = ++audioAttempt;
        const isCurrentAttempt = () => isActive() && attempt === audioAttempt;
        this.audioPlayer.onEnded(finishSource);
        this.audioPlayer.onError(error => { if (isCurrentAttempt()) failSource(error); });
        const latestAudioUrl =
          speechAction.audioId && currentScene
            ? (this.callbacks.getLatestAudioUrl?.(
                currentScene.id,
                speechAction.id,
                speechAction.audioId,
              ) ?? speechAction.audioUrl)
            : speechAction.audioUrl;
        this.audioPlayer
          .play(speechAction.audioId || "", latestAudioUrl)
          .then((audioStarted) => {
            if (!isCurrentAttempt()) return;
            if (audioStarted) {
              if (this.mode !== "playing") this.audioPlayer.pause();
              else this.speechCueScheduler?.start();
              return;
            }
            if (!isSpeech || this.runtime.speechFallback === "pause") {
              failSource(
                new Error(
                  "Audio unavailable or autoplay blocked.",
                ),
              );
              return;
            }
            if (this.runtime.speechFallback === 'browser' && latestAudioUrl) {
              failSource(new Error('Stored narration could not play. Retry this page.')); return;
            }
            const settings = this.runtime.getSpeechSettings?.() ?? {};
            if (
              settings.ttsEnabled &&
              settings.ttsProviderId === "browser-native-tts" &&
              typeof window !== "undefined" &&
              window.speechSynthesis
            )
              this.playBrowserTTS(speechAction);
            else if (this.runtime.speechFallback === 'browser') failSource(new Error('No stored narration or browser speech voice is available.'));
            else scheduleReadingTimer();
          })
          .catch(error => { if (isCurrentAttempt()) failSource(error); });
      };
      startAudio();
    });
  }

  private waitForAnimationDuration(duration: number): Promise<void> {
    return new Promise((resolve) =>
      this.scheduleAnimationTimer(duration, resolve),
    );
  }

  private scheduleAnimationTimer(duration: number, resolve: () => void): void {
    const remainingMs = Math.max(0, duration);
    const startedAt = Date.now();
    const id = setTimeout(() => {
      if (this.animationTimer?.id === id) this.animationTimer = null;
      resolve();
    }, remainingMs);
    this.animationTimer = { id, resolve, startedAt, remainingMs };
  }

  private pauseAnimationTimer(): void {
    if (!this.animationTimer) return;
    clearTimeout(this.animationTimer.id);
    this.pausedAnimationTimer = {
      resolve: this.animationTimer.resolve,
      remainingMs: Math.max(
        0,
        this.animationTimer.remainingMs -
          (Date.now() - this.animationTimer.startedAt),
      ),
    };
    this.animationTimer = null;
  }

  private resumeAnimationTimer(): boolean {
    if (!this.pausedAnimationTimer) return false;
    const { remainingMs, resolve } = this.pausedAnimationTimer;
    this.pausedAnimationTimer = null;
    this.scheduleAnimationTimer(remainingMs, resolve);
    return true;
  }

  private clearAnimationTimer(): void {
    if (this.animationTimer) {
      clearTimeout(this.animationTimer.id);
      const { resolve } = this.animationTimer;
      this.animationTimer = null;
      resolve();
    }
    if (this.pausedAnimationTimer) {
      const { resolve } = this.pausedAnimationTimer;
      this.pausedAnimationTimer = null;
      resolve();
    }
  }

  private scheduleSpeechTimer(
    durationMs: number,
    completion: () => void,
  ): void {
    if (this.speechTimer) clearTimeout(this.speechTimer);

    this.speechTimer = null;
    this.speechTimerRemaining = Math.max(0, durationMs);
    this.speechTimerCompletion = completion;
    if (this.speechTimerRemaining === 0) {
      this.completeSpeechTimer();
      return;
    }
    if (this.mode !== "playing") return;

    this.speechTimerStart = Date.now();
    this.speechTimer = setTimeout(
      () => this.completeSpeechTimer(),
      this.speechTimerRemaining,
    );
  }

  private completeSpeechTimer(): void {
    const completion = this.speechTimerCompletion;
    this.speechTimer = null;
    this.speechTimerRemaining = 0;
    this.speechTimerCompletion = null;
    completion?.();
  }

  private clearSpeechTimer(): void {
    if (this.speechTimer) clearTimeout(this.speechTimer);
    this.speechTimer = null;
    this.speechTimerRemaining = 0;
    this.speechTimerCompletion = null;
  }

  private finishCurrentSpeech(): void {
    const execution = this.speechExecutionId;
    const id = this.currentSpeechId;
    const isSpeech = !this.currentAudioIsClip;
    const durationMs = this.runtime.getSpeechTailDuration ? this.audioPlayer.getDuration() : 0;
    let tailMs = 0;
    try { tailMs = isSpeech ? Math.max(0, this.runtime.getSpeechTailDuration?.(id, durationMs) ?? 0) : 0; }
    catch (error) { this.pause(); this.callbacks.onPlaybackError?.(error instanceof Error ? error : new Error('Invalid speech timing')); return; }
    if (isSpeech && tailMs > 0) {
      this.speechTail = { actionId: id, audioDurationMs: durationMs, durationMs: tailMs };
      this.callbacks.onSpeechProgress?.({ actionId: id, timeMs: durationMs, durationMs });
    }
    const complete = () => {
      const resolve = this.currentSpeechResolve;
      if (!resolve || execution !== this.speechExecutionId) return;
      this.currentSpeechResolve = null;
      this.currentSpeechPauseAfterMs = 0;
      if (isSpeech) this.callbacks.onSpeechEnd?.();
      this.currentAudioIsClip = false;
      resolve();
    };
    const afterEffects = () => {
      if (execution !== this.speechExecutionId || !this.currentSpeechResolve) return;
      this.speechTail = null;
      this.speechCueScheduler?.stop();
      this.speechCueScheduler = null;
      (isSpeech ? this.callbacks.onSpeechProgress : this.callbacks.onAudioClipProgress)?.(null);
      if (this.currentSpeechPauseAfterMs > 0) this.scheduleSpeechTimer(this.currentSpeechPauseAfterMs, complete);
      else if (this.mode === 'paused') { this.speechTimerCompletion = complete; this.speechTimerRemaining = 0; }
      else complete();
    };
    const afterTail = () => {
      if (execution !== this.speechExecutionId || !this.currentSpeechResolve) return;
      if (isSpeech && this.runtime.waitForSpeechEffects) {
        this.waitingSpeechEffects = true;
        void this.runtime.waitForSpeechEffects(id).then(() => {
          if (execution !== this.speechExecutionId || !this.currentSpeechResolve) return;
          this.waitingSpeechEffects = false;
          if (this.mode === 'paused') { this.speechTimerCompletion = afterEffects; this.speechTimerRemaining = 0; }
          else { this.speechTimerCompletion = null; afterEffects(); }
        }).catch(error => {
          if (execution !== this.speechExecutionId || !this.currentSpeechResolve) return;
          this.waitingSpeechEffects = false; this.speechTimerCompletion = null; this.pause();
          this.callbacks.onPlaybackError?.(error instanceof Error ? error : new Error('Speech animation failed'));
        });
      } else afterEffects();
    };
    if (tailMs > 0) this.scheduleSpeechTimer(tailMs, afterTail);
    else afterTail();
  }

  private cancelCurrentSpeech(finishCues = false): void {
    this.speechTail = null;
    this.waitingSpeechEffects = false;
    (this.currentAudioIsClip ? this.callbacks.onAudioClipProgress : this.callbacks.onSpeechProgress)?.(null);
    this.retrySpeech = null;
    if (finishCues) this.speechCueScheduler?.finish();
    else this.speechCueScheduler?.stop();
    this.speechCueScheduler = null;
    this.speechExecutionId += 1;
    this.clearSpeechTimer();
    this.currentSpeechPauseAfterMs = 0;
    const resolve = this.currentSpeechResolve;
    this.currentSpeechResolve = null;
    resolve?.();
  }

  // ==================== Browser Native TTS ====================

  /**
   * Split text into sentence-level chunks for sequential playback.
   * Chrome has a bug where utterances >~15s are silently cut off and onend
   * never fires, causing the engine to hang. Chunking avoids this.
   */
  private splitIntoChunks(text: string): string[] {
    // Split on sentence-ending punctuation (Latin + CJK) and newlines
    const chunks = text
      .split(/(?<=[.!?。！？\n])\s*/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    // If splitting produced nothing (no punctuation), return the original text
    return chunks.length > 0 ? chunks : [text];
  }

  /**
   * Play text using the Web Speech API (browser-native TTS).
   * Splits text into sentence-level chunks to avoid Chrome's ~15s cutoff.
   * Uses cancel+re-speak for pause/resume (Firefox compatibility).
   */
  private playBrowserTTS(speechAction: SpeechAction): void {
    this.browserTTSChunks = this.splitIntoChunks(speechAction.text);
    this.browserTTSChunkIndex = 0;
    this.browserTTSPausedChunks = [];
    this.browserTTSActive = true;
    this.playBrowserTTSChunk();
  }

  /** Speak the current chunk; on completion, advance to next or finish. */
  private async playBrowserTTSChunk(): Promise<void> {
    const attempt = ++this.browserTTSAttempt;
    if (this.browserTTSChunkIndex >= this.browserTTSChunks.length) {
      // All chunks done
      this.browserTTSActive = false;
      this.browserTTSChunks = [];
      this.finishCurrentSpeech();
      return;
    }

    const settings = this.runtime.getSpeechSettings?.() ?? {};
    const chunkText = this.browserTTSChunks[this.browserTTSChunkIndex];
    const utterance = new SpeechSynthesisUtterance(chunkText);

    // Apply settings
    const speed = this.callbacks.getPlaybackSpeed?.() ?? 1;
    utterance.rate = (settings.ttsSpeed ?? 1) * speed;
    utterance.volume = settings.ttsMuted ? 0 : (settings.ttsVolume ?? 1);

    // Ensure voices are loaded (Chrome loads them asynchronously)
    const voices = await this.ensureVoicesLoaded();
    if (attempt !== this.browserTTSAttempt || this.mode !== 'playing') return;

    // Set voice: try user's configured voice, fall back to auto-detect language
    let voiceFound = false;
    if (settings.ttsVoice && settings.ttsVoice !== "default") {
      const voice = voices.find((v) => v.voiceURI === settings.ttsVoice);
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
        voiceFound = true;
      }
    }
    if (!voiceFound) {
      // No usable voice configured — detect text language so the browser
      // auto-selects an appropriate voice.
      const cjkRatio =
        (chunkText.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length /
        chunkText.length;
      utterance.lang = cjkRatio > CJK_LANG_THRESHOLD ? "zh-CN" : "en-US";
    }

    utterance.onend = () => {
      if (attempt !== this.browserTTSAttempt || !this.browserTTSActive) return;
      this.browserTTSChunkIndex++;
      if (this.mode === "playing") {
        this.playBrowserTTSChunk(); // next chunk
      }
    };

    utterance.onerror = (event) => {
      if (attempt !== this.browserTTSAttempt || !this.browserTTSActive) return;
      // 'canceled' is expected when stop/pause is called — not a real error
      if (event.error !== "canceled") {
        log.warn("Browser TTS chunk error:", event.error);
        if (this.runtime.speechFallback === 'browser') {
          this.pause();
          this.retrySpeech = () => {
            this.browserTTSPausedChunks = [];
            void this.playBrowserTTSChunk();
          };
          this.callbacks.onPlaybackError?.(new Error(`Browser narration failed: ${event.error}`));
          return;
        }
        // Skip failed chunk, try next
        this.browserTTSChunkIndex++;
        if (this.mode === "playing") {
          this.playBrowserTTSChunk();
        }
      }
      // On 'canceled': do nothing — pause handler already saved state
    };

    // Chrome bug workaround: cancel() before speak() to clear stale synthesis
    // state that can produce garbled/broken audio output.
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }

  /**
   * Wait for speechSynthesis voices to load (Chrome loads them asynchronously).
   * Caches result so subsequent calls return immediately.
   */
  private cachedVoices: SpeechSynthesisVoice[] | null = null;
  private async ensureVoicesLoaded(): Promise<SpeechSynthesisVoice[]> {
    if (this.cachedVoices && this.cachedVoices.length > 0) {
      return this.cachedVoices;
    }

    let voices = window.speechSynthesis.getVoices();
    if (voices.length > 0) {
      this.cachedVoices = voices;
      return voices;
    }

    // Chrome: voices load asynchronously — wait for the voiceschanged event
    await new Promise<void>((resolve) => {
      const onVoicesChanged = () => {
        window.speechSynthesis.removeEventListener(
          "voiceschanged",
          onVoicesChanged,
        );
        resolve();
      };
      window.speechSynthesis.addEventListener("voiceschanged", onVoicesChanged);
      // Timeout after 2s to avoid hanging
      setTimeout(() => {
        window.speechSynthesis.removeEventListener(
          "voiceschanged",
          onVoicesChanged,
        );
        resolve();
      }, 2000);
    });

    voices = window.speechSynthesis.getVoices();
    this.cachedVoices = voices;
    return voices;
  }

  /** Cancel any active browser-native TTS */
  private cancelBrowserTTS(): void {
    this.browserTTSAttempt += 1;
    if (this.browserTTSActive) {
      this.browserTTSActive = false;
      this.browserTTSChunks = [];
      this.browserTTSChunkIndex = 0;
      this.browserTTSPausedChunks = [];
      window.speechSynthesis?.cancel();
    }
  }
}
