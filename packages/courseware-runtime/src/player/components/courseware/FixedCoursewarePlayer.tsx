"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { englishPlayerLabels } from "../../labels";
import { Button } from "../ui/button";
import { PlaybackCore } from "../../lib/playback/playback-core";
import type {
  EngineMode,
  PlaybackEngineCallbacks,
  PlaybackSnapshot,
  SpeechProgress,
} from "../../lib/playback/types";
import type { LoadedFixedBuild } from "../../lib/courseware/load-fixed-build";
import type { InteractionCheckpointPayload } from "../../lib/types/action";
import { AudioPlayer } from "../../lib/utils/audio-player";
import type { FixedPlayerLabels } from "../../labels";
import { TeachingQuestionResponse } from './TeachingQuestionResponse';
import { resolveSpeechAnimationCue } from '../../../speech-animation-trigger';
import { MaicQuiz } from "./MaicQuiz";
import { FixedSlide } from "./FixedSlide";
import { createMaicDomMedia } from '../../lib/courseware/maic-dom-media';
import { maicAnimationFrames } from '../../lib/courseware/maic-animation';
import type { Effect } from '../../lib/playback/types';

/** Host owns build loading/authorization/disposal; this component owns only a playback session. */
export function FixedCoursewarePlayer({
  build,
  labels,
  width = 960,
  onState,
  onPageChange,
  ...presentationEvents
}: {
  build: LoadedFixedBuild;
  labels: FixedPlayerLabels;
  width?: number;
  onState?: (mode: EngineMode, snapshot: PlaybackSnapshot) => void;
  onPageChange?: (pageId: string) => void;
} & Pick<PlaybackEngineCallbacks,
  "onSpeechStart" | "onSpeechEnd" | "onSpeechProgress" |
  "onInteractionStart" | "onInteractionComplete"
>) {
  const [animationPosition, setAnimationPosition] = useState<Pick<
    SpeechProgress,
    "actionId" | "timeMs"
  > | null>(null);
  const [progress, setProgress] = useState<SpeechProgress | null>(null);
  const [clipProgress, setClipProgress] = useState<SpeechProgress | null>(null);
  const [mode, setMode] = useState<EngineMode>("idle");
  const [pageIndex, setPageIndex] = useState(0);
  const [waiting, setWaiting] = useState<InteractionCheckpointPayload | null>(
    null,
  );
  const [error, setError] = useState("");
  const [failedSpeech, setFailedSpeech] = useState(false);
  const [retry, setRetry] = useState(0);
  const [complete, setComplete] = useState(false);
  const [quizReady, setQuizReady] = useState(false);
  const [actionEffect, setActionEffect] = useState<Effect | null>(null);
  const [nativeVisible, setNativeVisible] = useState<ReadonlySet<string>>(new Set());
  const resolvedCues = useRef(new Map<string, readonly import('../../lib/courseware/load-fixed-build').FixedVisualCue[]>());
  const resolveCues = (actionId: string, durationMs: number) => {
    const speech = build.scenes.flatMap(scene => scene.actions ?? []).find(action => action.type === 'speech' && action.id === actionId);
    const cues = (build.speechVisualCues.get(actionId) ?? []).map(cue => resolveSpeechAnimationCue(cue,
      speech?.type === 'speech' ? speech.text : '', cue.trigger?.kind === 'text' ? cue.trigger.audioAssetId : '', durationMs));
    resolvedCues.current.set(actionId, cues); return cues;
  };
  const engine = useRef<PlaybackCore | null>(null);
  const surface = useRef<HTMLElement | null>(null);
  const nativeHandles = useRef<Animation[]>([]);
  const events = useRef({ onState, onPageChange, ...presentationEvents });
  events.current = { onState, onPageChange, ...presentationEvents };
  const resourceError = useCallback((error: Error) => {
    setFailedSpeech(engine.current?.canSkipFailedSpeech() ?? false);
    if (engine.current?.getMode() === "playing") engine.current.pause();
    setError(error.message);
  }, []);
  useEffect(() => {
    const audio = new AudioPlayer();
    const media = createMaicDomMedia(() => surface.current);
    let effectTimer: ReturnType<typeof setTimeout> | undefined;
    const playback = new PlaybackCore(
      build.scenes,
      {
        ...media,
        clearEffects: () => {
          nativeHandles.current.forEach(handle => handle.cancel());
          nativeHandles.current = [];
          clearTimeout(effectTimer); setActionEffect(null);
        },
      },
      audio,
      {
        onModeChange: (state) => {
          nativeHandles.current.forEach(handle => {
            if (state === "paused" && handle.playState === "running") handle.pause();
            else if (state === "playing" && handle.playState === "paused") handle.play();
          });
          setMode(state);
          events.current.onState?.(state, playback.getSnapshot());
        },
        onSceneChange: (id) => {
          setQuizReady(false);
          setAnimationPosition(null);
          setNativeVisible(new Set());
          setPageIndex(build.scenes.findIndex((s) => s.id === id));
          events.current.onPageChange?.(id);
        },
        onSpeechStart: (text) => events.current.onSpeechStart?.(text),
        onSpeechEnd: () => events.current.onSpeechEnd?.(),
        onAudioClipProgress: setClipProgress,
        onEffectFire: effect => {
          clearTimeout(effectTimer); setActionEffect(effect);
          effectTimer = setTimeout(() => setActionEffect(null), 5000);
        },
        onSpeechProgress: (position) => {
          if (position && position.durationMs > 0) {
            try { resolveCues(position.actionId, position.durationMs); }
            catch (error) { resourceError(error instanceof Error ? error : new Error(String(error))); return; }
          }
          setProgress(position);
          setAnimationPosition((previous) =>
            position
              ? { actionId: position.actionId, timeMs: position.timeMs }
              : previous
                ? { ...previous, timeMs: Infinity }
                : null,
          );
          events.current.onSpeechProgress?.(position ? { ...position } : null);
        },
        onInteractionStart: (checkpoint) => {
          setWaiting(checkpoint);
          events.current.onInteractionStart?.(structuredClone(checkpoint));
        },
        onInteractionComplete: (id) => {
          setWaiting(null);
          events.current.onInteractionComplete?.(id);
        },
        onPlaybackError: resourceError,
        onElementAnimation: async (action) => {
          if (build.classroom) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
          const target = [...(surface.current?.querySelectorAll<HTMLElement>("[data-slide-render-element-id]") ?? [])]
            .find(element => element.dataset.slideRenderElementId === action.elementId);
          if (!target || (!build.classroom && (!action.pptxTimeline || !["fadeIn", "appear"].includes(action.effect)))) {
            resourceError(new Error("Native animation target is unavailable. Retry this page."));
            return;
          }
          setNativeVisible(previous => new Set([...previous, action.elementId]));
          if (build.classroom) {
            try {
              const handle = target.animate(maicAnimationFrames(action), { duration: action.duration, fill: 'forwards', easing: 'linear' });
              nativeHandles.current.push(handle);
            } catch (error) { resourceError(error instanceof Error ? error : new Error(String(error))); }
            return;
          }
          if (action.effect === "fadeIn") {
            const handle = target.animate([{ opacity: 0 }, { opacity: 1 }], { duration: action.duration, fill: "forwards", easing: "linear" });
            nativeHandles.current.push(handle);
          }
        },
        onComplete: () => setComplete(true),
      },
      { speechFallback: build.classroom ? 'browser' : "pause", getSpeechSettings: () => ({ ttsEnabled: true, ttsProviderId: 'browser-native-tts' }),
        waitForMediaCheckpoint: !!build.classroom, onQuizReady: () => setQuizReady(true), getSpeechTailDuration: (actionId, durationMs) =>
        Math.max(0, ...resolveCues(actionId, durationMs).filter(cue => cue.effect.kind === 'element_animation').map(cue => cue.endMs - durationMs)) },
    );
    engine.current = playback;
    resolvedCues.current.clear();
    setAnimationPosition(null);
    setProgress(null);
    setClipProgress(null);
    setMode("idle");
    setPageIndex(0);
    setWaiting(null);
    setError("");
    setFailedSpeech(false);
    setComplete(false);
    setQuizReady(false);
    setNativeVisible(new Set());
    return () => {
      playback.stop();
      audio.destroy();
      engine.current = null;
    };
  }, [build, resourceError]);
  const playPage = (index: number) => {
    const playback = engine.current;
    if (!playback || index < 0 || index >= build.scenes.length) return;
    playback.stop();
    resolvedCues.current.clear();
    setNativeVisible(new Set());
    setPageIndex(index);
    setAnimationPosition(null);
    setWaiting(null);
    setError("");
    setFailedSpeech(false);
    setComplete(false);
    setQuizReady(false);
    setRetry((r) => r + 1);
    playback.restoreFromSnapshot({
      sceneIndex: index,
      actionIndex: 0,
      consumedDiscussions: [],
      sceneId: build.scenes[index]?.id,
    });
    if (build.scenes[index]?.actions?.length || build.scenes[index]?.content.type === 'quiz') playback.continuePlayback();
    else {
      setComplete(true);
      events.current.onPageChange?.(build.scenes[index].id);
    }
  };
  const scene = build.scenes[pageIndex];
  const mediaProgress = progress ?? clipProgress;
  const native = scene && build.nativeAnimations?.get(scene.id);
  const nativeTargets = new Set(native?.steps.map(step => step.elementId));
  const nativeWaitIndex = waiting && native?.version === 1 ? scene.actions?.slice(0, native.steps.length * 2).findIndex(action =>
    action.type === "interaction_checkpoint" && action.checkpointId === waiting.checkpointId) ?? -1 : -1;
  const speechIds = (scene?.actions ?? [])
    .filter((action) => action.type === "speech")
    .map((action) => action.id);
  const positionIndex = animationPosition
    ? speechIds.indexOf(animationPosition.actionId)
    : -1;
  const animations = speechIds.flatMap((id, index) =>
    (resolvedCues.current.get(id) ?? build.speechVisualCues.get(id) ?? [])
      .filter((cue) => cue.effect.kind === "element_animation")
      .map((cue) => ({
        cue,
        timeMs:
          positionIndex < 0 || index > positionIndex
            ? -1
            : index < positionIndex
              ? Infinity
              : animationPosition!.timeMs,
      })),
  );
  const cues = progress
    ? (resolvedCues.current.get(progress.actionId) ?? build.speechVisualCues.get(progress.actionId) ?? []).filter(
        (cue) => cue.atMs <= progress.timeMs && progress.timeMs < cue.endMs,
      )
    : [];
  return (
    <section
      ref={surface}
      aria-label={labels.player}
      data-player-mode={mode}
      data-page-id={scene?.id}
      style={{ maxWidth: width, margin: "0 auto" }}
    >
      <header className="flex items-center justify-between gap-4 py-3">
        <h1 className="text-lg font-semibold">{scene?.title}</h1>
        <span aria-live="polite" className="text-sm tabular-nums">
          {pageIndex + 1} / {build.scenes.length}
        </span>
      </header>
      {scene?.content.type === "slide" && (
        <FixedSlide
          key={`${build.buildId}:${scene.id}:${retry}`}
          slide={scene.content.canvas}
          width={width}
          mode={mode}
          onError={resourceError}
          cues={actionEffect ? [...cues, { id: 'maic-action-effect', atMs: 0, endMs: Infinity, effect: actionEffect }] : cues}
          animations={animations}
          ducked={progress !== null && mode === "playing"}
          nativeTargets={nativeTargets}
          nativeVisible={nativeVisible}
        />
      )}
      {scene?.content.type === "quiz" && <MaicQuiz key={`${build.buildId}:${scene.id}:${retry}`} content={scene.content} disabled={mode === 'playing' || mode === 'paused' || (!quizReady && !!scene.actions?.length)}
        onInstantAnswer={correct => {
          setQuizReady(false); void engine.current?.answerInstantQuiz(correct);
        }} onComplete={() => {
        setQuizReady(false); engine.current?.completeQuiz();
      }} />}
      {native && <p role="note" data-native-animation-policy>
        {native.version === 2
          ? labels.boundNativeAnimationRule ?? englishPlayerLabels.boundNativeAnimationRule
          : labels.nativeAnimationRule ?? englishPlayerLabels.nativeAnimationRule}
      </p>}
      <nav
        aria-label={labels.controls}
        className="flex flex-wrap items-center gap-2 py-4"
      >
        <Button
          variant="outline"
          disabled={pageIndex === 0}
          onClick={() => playPage(pageIndex - 1)}
        >
          {labels.previousPage}
        </Button>
        {mode === "playing" ? (
          <Button onClick={() => engine.current?.pause()}>{labels.pause}</Button>
        ) : mode === "paused" ? (
          !error &&
          <Button
            onClick={() => {
              setError("");
              engine.current?.resume();
            }}
          >
            {labels.resume}
          </Button>
        ) : mode === "waiting_interaction" ? (
          <Button
            disabled={waiting?.checkpointKind === "media_playback" && waiting.waitForCompletion}
            onClick={() => engine.current?.resumeInteraction()}
          >
            {nativeWaitIndex >= 0 ? `${labels.nextNativeAnimation ?? labels.teacherContinue} ${nativeWaitIndex / 2 + 1}/${native!.steps.length}` : labels.teacherContinue}
          </Button>
        ) : (
          <Button onClick={() => playPage(pageIndex)}>
            {complete ? labels.playAgain : labels.play}
          </Button>
        )}
        <Button variant="outline" onClick={() => playPage(pageIndex)}>
          {labels.replayPage}
        </Button>
        <Button
          variant="outline"
          disabled={pageIndex === build.scenes.length - 1}
          onClick={() => playPage(pageIndex + 1)}
        >
          {labels.nextPage}
        </Button>
      </nav>
      {mediaProgress && (
        <label className="flex items-center gap-3 pb-4 text-sm">
          {clipProgress ? (labels.audioClip ?? englishPlayerLabels.audioClip) : labels.narration}
          <input
            type="range"
            aria-label={clipProgress ? (labels.seekAudioClip ?? englishPlayerLabels.seekAudioClip) : labels.seekNarration}
            min={0}
            max={mediaProgress.durationMs}
            step={10}
            value={mediaProgress.timeMs}
            disabled={!!error || !mediaProgress.durationMs}
            onChange={(event) =>
              engine.current?.seekCurrentSpeech(Number(event.target.value))
            }
            className="min-w-0 flex-1"
          />
          <output className="tabular-nums">
            {(mediaProgress.timeMs / 1000).toFixed(1)} /{" "}
            {(mediaProgress.durationMs / 1000).toFixed(1)} s
          </output>
        </label>
      )}
      {waiting && (
        <div
          role="status"
          className="border-l-4 border-amber-500 bg-amber-50 p-4 text-slate-900"
        >
          <strong>{labels.waitingForTeacher}</strong>
          <p>
            {waiting.checkpointKind === "chapter_summary"
              ? waiting.question
              : labels.continueWhenReady}
          </p>
          {waiting.checkpointKind === "chapter_summary" && waiting.response ? <TeachingQuestionResponse key={waiting.checkpointId} response={waiting.response} labels={labels} /> : null}
          {waiting.checkpointKind === "chapter_summary" && <details key={waiting.checkpointId}>
            <summary>{labels.referenceAnswer ?? englishPlayerLabels.referenceAnswer}</summary>
            <p>{waiting.referenceAnswer.summary}</p>
            <ul>{waiting.referenceAnswer.keyPoints.map((point, index) => <li key={index}>{point}</li>)}</ul>
          </details>}
          {waiting.checkpointKind === "media_playback" && waiting.videoUrl && waiting.mediaType === 'video' && <video key={waiting.checkpointId}
            controls playsInline preload="metadata" src={waiting.videoUrl}
            onEnded={() => engine.current?.resumeInteraction(waiting.checkpointId)}
            onError={() => resourceError(new Error("Video playback failed. Retry this page."))} aria-label={labels.videoClip ?? englishPlayerLabels.videoClip}
            style={{ width: "100%", maxHeight: "60vh" }} />}
          {waiting.checkpointKind === "media_playback" && waiting.videoUrl && waiting.mediaType === 'audio' && <audio key={waiting.checkpointId}
            controls preload="metadata" src={waiting.videoUrl} onEnded={() => engine.current?.resumeInteraction(waiting.checkpointId)}
            onError={() => resourceError(new Error('Audio playback failed. Retry this page.'))} />}
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="border-l-4 border-red-600 bg-red-50 p-4 text-slate-900"
        >
          <p>{error}</p>
          <Button variant="outline" onClick={() => playPage(pageIndex)}>
            {labels.retryPage}
          </Button>
          {failedSpeech && labels.skipFailedNarration && engine.current?.canSkipFailedSpeech() && (
            <Button variant="outline" onClick={() => {
              if (engine.current?.skipCurrentPlaybackPoint()) {
                setError(""); setFailedSpeech(false);
              }
            }}>
              {labels.skipFailedNarration}
            </Button>
          )}
        </div>
      )}
      {complete && <p role="status">{labels.playbackComplete}</p>}
    </section>
  );
}
