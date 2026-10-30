import { questionResponseSchema } from './question-response';
import { z } from 'zod';
import { PlaybackCore } from './player/lib/playback/playback-core';
import { nativeAnimationNodeSchema, validateNativeAnimationBindings } from './native-animation-node';
import { AudioPlayer } from './player/lib/utils/audio-player';
import type { Action } from './player/lib/types/action';
import type { Scene } from './player/lib/types/stage';
import type { EngineMode, SpeechProgress } from './player/lib/playback/types';

const questionSchema = z.object({
  id: z.string().min(1).max(128), type: z.literal('interaction_checkpoint'), checkpointId: z.string().min(1).max(128),
  checkpointKind: z.literal('chapter_summary'), response: questionResponseSchema.optional(), chapterId: z.string().min(1).max(128), chapterTitle: z.string().min(1).max(1000),
  question: z.string().trim().min(1).max(4000),
  referenceAnswer: z.object({ summary: z.string().trim().min(1).max(4000), keyPoints: z.array(z.string().trim().min(1).max(1000)).min(1).max(8) }).strict(),
  context: z.object({ chapterSummary: z.string().trim().min(1).max(4000), sourceSceneIds: z.array(z.string().min(1).max(128)).min(1).max(100) }).strict(),
}).strict();
export type TeachingQuestion = z.infer<typeof questionSchema>;
export type TeachingPreviewNode = TeachingQuestion
  | { id: string; type: 'speech'; text: string; audioUrl: string; pauseAfterMs?: number }
  | { id: string; type: 'native_animation'; version: 1; sourceSha256: string; stepIndex: number }
  | { id: string; type: 'delay'; durationMs: number }
  | { id: string; type: 'audio_clip'; audioUrl: string }
  | { id: string; type: 'video_clip'; videoUrl: string }
  | { id: string; type: 'interaction_checkpoint'; checkpointId: string; checkpointKind: 'teacher_continue' };

/** One page uses the fixed player's engine and audio clock, with no reading/TTS fallback. */
export function createTeachingTimelinePreview(input: {
  pageId: string;
  nodes: TeachingPreviewNode[];
  video?: HTMLVideoElement;
  native?: { sourceSha256: string; stepCount: number; next(index: number): Promise<void>; pause(): void; resume(): void };
  onMediaProgress?(progress: SpeechProgress | null): void;
  onMode(mode: EngineMode): void;
  onProgress(progress: SpeechProgress | null): void;
  onNode(id: string): void;
  onInteraction?(question: TeachingQuestion | null): void;
  onError(error: Error): void;
  onComplete(): void;
}) {
  if (!input.pageId || !Array.isArray(input.nodes) || !input.nodes.length || input.nodes.length > 1000)
    throw new Error('Invalid teaching preview timeline');
  const nativeNodes = input.nodes.filter(node => node.type === 'native_animation');
  if (nativeNodes.length && (!input.native ||
      !validateNativeAnimationBindings(input.nodes, input.native.sourceSha256, input.native.stepCount)))
    throw new Error('Native animation bindings do not match the saved page');
  const nativeCheckpoints = new Map<string, number>();
  const reserved = new Set(input.nodes.flatMap(node => node.type === 'interaction_checkpoint' ? [node.checkpointId] : []));
  const ids = new Set<string>();
  const checkpoints = new Set<string>();
  const actions: Action[] = input.nodes.map(node => {
    if (!node || typeof node.id !== 'string' || !node.id || ids.has(node.id)) throw new Error('Invalid teaching preview node identity');
    ids.add(node.id);
    if (node.type === 'native_animation') {
      const binding = nativeAnimationNodeSchema.parse(node);
      let checkpointId = `native:${node.id}`;
      while (reserved.has(checkpointId)) checkpointId = `native:${checkpointId}`;
      reserved.add(checkpointId);
      nativeCheckpoints.set(checkpointId, binding.stepIndex);
      return { id: node.id, type: 'interaction_checkpoint', checkpointId, checkpointKind: 'teacher_continue' };
    }
    if (node.type === 'delay') {
      if (!Number.isInteger(node.durationMs) || node.durationMs < 0 || node.durationMs > 30000)
        throw new Error('Teaching preview requires a bounded delay');
      return { id: node.id, type: 'delay', durationMs: node.durationMs };
    }
    if (node.type === 'speech') {
      if (typeof node.text !== 'string' || !node.text.trim() || typeof node.audioUrl !== 'string' || !node.audioUrl.startsWith('blob:') ||
          (node.pauseAfterMs !== undefined && (!Number.isInteger(node.pauseAfterMs) || node.pauseAfterMs < 0 || node.pauseAfterMs > 30000)))
        throw new Error('Teaching preview requires local speech and a bounded pause');
      return { id: node.id, type: 'speech', text: node.text, audioId: node.id, audioUrl: node.audioUrl, pauseAfterMs: node.pauseAfterMs };
    }
    if (node.type === 'audio_clip' || node.type === 'video_clip') {
      const url = node.type === 'audio_clip' ? node.audioUrl : node.videoUrl;
      if (typeof url !== 'string' || !url.startsWith('blob:') || node.type === 'video_clip' && !input.video)
        throw new Error('Teaching preview requires local media and a video surface');
      return node.type === 'audio_clip'
        ? { id: node.id, type: 'audio_clip', audioAssetId: node.id, audioId: node.id, audioUrl: url }
        : { id: node.id, type: 'video_clip', videoAssetId: node.id, videoUrl: url };
    }
    if (node.type === 'interaction_checkpoint' && node.checkpointKind === 'chapter_summary') {
      const question = questionSchema.parse(node);
      if (checkpoints.has(question.checkpointId) || !question.context.sourceSceneIds.includes(input.pageId)) throw new Error('Invalid teaching question binding');
      checkpoints.add(question.checkpointId);
      return question;
    }
    if (node.type !== 'interaction_checkpoint' || node.checkpointKind !== 'teacher_continue' ||
        typeof node.checkpointId !== 'string' || !node.checkpointId || checkpoints.has(node.checkpointId))
      throw new Error('Unsupported teaching preview node');
    checkpoints.add(node.checkpointId);
    return { id: node.id, type: 'interaction_checkpoint', checkpointId: node.checkpointId, checkpointKind: 'teacher_continue' };
  });
  const scene: Scene = {
    id: input.pageId, stageId: 'native-teaching-preview', type: 'slide', title: input.pageId, order: 0,
    content: { type: 'slide', canvas: { id: input.pageId, viewportSize: 1000, viewportRatio: .5625, elements: [],
      theme: { backgroundColor: '#fff', themeColors: [], fontColor: '#000', fontName: 'Arial' } } }, actions,
  };
  let disposed = false;
  let waiting: string | null = null;
  let started = false;
  let activeNative: { id: string; completed: boolean } | null = null;
  let nativePaused = false;
  let nativeFailed = false;
  const finishNative = () => {
    if (disposed || nativePaused || !activeNative?.completed) return;
    const id = activeNative.id;
    activeNative = null;
    core.resumeInteraction(id);
  };
  let activeVideo: string | null = null;
  let videoPaused = false;
  let videoAttempt = 0;
  const video = input.video;
  const clearVideo = () => {
    activeVideo = null;
    videoAttempt++;
    videoPaused = false;
    if (video) { video.pause(); video.removeAttribute('src'); video.load(); video.hidden = true; }
    if (!disposed) input.onMediaProgress?.(null);
  };
  const videoError = (error: unknown) => {
    if (disposed || !activeVideo) return;
    videoPaused = true;
    video?.pause();
    input.onMode('paused');
    input.onError(error instanceof Error ? error : new Error('Local video playback failed'));
  };
  const playVideo = () => {
    if (!video || !activeVideo || disposed) return;
    const id = activeVideo, attempt = ++videoAttempt;
    try {
      if (video.error) video.load();
      void video.play().catch(error => { if (activeVideo === id && videoAttempt === attempt) videoError(error); });
    } catch (error) { videoError(error); }
  };
  const ended = () => {
    if (disposed || !activeVideo || !video?.ended) return;
    const id = activeVideo;
    clearVideo();
    core.resumeInteraction(id);
  };
  const failed = () => { if (video?.error) videoError(new Error('Local video decoding failed')); };
  const videoPlay = () => { if (!disposed && activeVideo && !video?.paused) { videoPaused = false; input.onMode('playing'); } };
  const videoPause = () => { if (!disposed && activeVideo && video?.paused && !video.ended) { videoAttempt++; videoPaused = true; input.onMode('paused'); } };
  const videoProgress = () => {
    if (!disposed && activeVideo && video) input.onMediaProgress?.({ actionId: activeVideo,
      timeMs: video.currentTime * 1000, durationMs: Number.isFinite(video.duration) ? video.duration * 1000 : 0 });
  };
  const audio = new AudioPlayer();
  const core = new PlaybackCore([scene], {
    execute: async () => { throw new Error('Unsupported teaching preview action'); },
    clearEffects: () => {}, pauseActiveVideo: () => false, resumeActiveVideo: () => false, stopActiveVideo: () => false,
  }, audio, {
    onModeChange: mode => { if (!disposed) input.onMode(mode === 'waiting_interaction' && activeVideo ? (videoPaused ? 'paused' : 'playing') : mode); },
    onAudioClipProgress: progress => { if (!disposed) input.onMediaProgress?.(progress); },
    onSpeechProgress: progress => { if (!disposed) input.onProgress(progress); },
    onProgress: snapshot => { if (!disposed) input.onNode(actions[snapshot.actionIndex].id); },
    onInteractionStart: payload => {
      if (nativeCheckpoints.has(payload.checkpointId)) {
        const current: { id: string; completed: boolean } = { id: payload.checkpointId, completed: false };
        activeNative = current;
        nativePaused = false;
        input.onMode('playing');
        // The native driver owns completion; no elapsed-time estimate or user gate.
        void (async () => {
          if (disposed || activeNative !== current) return;
          await input.native!.next(nativeCheckpoints.get(current.id)!);
        })().then(() => {
          if (disposed || activeNative !== current) return;
          current.completed = true;
          finishNative();
        }).catch(error => {
          if (disposed || activeNative !== current) return;
          nativeFailed = true;
          nativePaused = true;
          input.native!.pause();
          input.onMode('paused');
          input.onError(error instanceof Error ? error : new Error('Native animation failed'));
        });
      } else if (payload.checkpointKind === 'media_playback' && video) {
        activeVideo = payload.checkpointId;
        videoPaused = false;
        video.hidden = false;
        video.src = payload.videoUrl!;
        playVideo();
      } else {
        waiting = payload.checkpointId;
        input.onInteraction?.(payload.checkpointKind === 'chapter_summary' ? questionSchema.parse(input.nodes.find(node => node.type === 'interaction_checkpoint' && node.checkpointId === payload.checkpointId)) : null);
      }
    },
    onInteractionComplete: () => { waiting = null; input.onInteraction?.(null); },
    onPlaybackError: error => { if (!disposed) input.onError(error); },
    onComplete: () => { if (!disposed) input.onComplete(); },
  }, { speechFallback: 'pause', getSpeechSettings: () => ({ ttsEnabled: false }) });
  video?.addEventListener('ended', ended);
  video?.addEventListener('error', failed);
  video?.addEventListener('play', videoPlay);
  video?.addEventListener('pause', videoPause);
  video?.addEventListener('timeupdate', videoProgress);
  return {
    start() { if (!disposed && !started) { started = true; core.start(); } },
    pause() { if (!disposed) { if (activeNative) { nativePaused = true; input.native!.pause(); input.onMode('paused'); } else if (activeVideo) { videoAttempt++; videoPaused = true; video?.pause(); input.onMode('paused'); } else if (core.getMode() === 'playing') core.pause(); } },
    resume() { if (!disposed) { if (activeNative) { if (nativeFailed) { input.onError(new Error('Restart teaching playback after a native animation failure')); return; } nativePaused = false; input.native!.resume(); input.onMode('playing'); finishNative(); } else if (activeVideo && videoPaused) playVideo(); else if (core.getMode() === 'paused') core.resume(); } },
    continueTeacher() { if (!disposed && waiting && !activeVideo && !activeNative) core.resumeInteraction(waiting); },
    seek(timeMs: number) { if (!disposed && Number.isFinite(timeMs) && timeMs >= 0) { if (activeVideo && video && Number.isFinite(video.duration)) video.currentTime = Math.min(timeMs / 1000, video.duration); else core.seekCurrentSpeech(timeMs); } },
    dispose() {
      if (disposed) return;
      disposed = true; waiting = null; activeNative = null; core.stop();
      video?.removeEventListener('ended', ended);
      video?.removeEventListener('error', failed);
      video?.removeEventListener('play', videoPlay);
      video?.removeEventListener('pause', videoPause);
      video?.removeEventListener('timeupdate', videoProgress);
      clearVideo();
    },
  };
}
