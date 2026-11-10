import { afterEach, expect, it, vi } from "vitest";
import { PlaybackCore, type PlaybackActions } from "./playback-core";
import type { AudioPlayer } from "../utils/audio-player";
import type { Scene } from "../types/stage";
const actions: PlaybackActions = {
  execute: async () => {},
  clearEffects: () => {},
  pauseActiveVideo: () => false,
  resumeActiveVideo: () => false,
  stopActiveVideo: () => false,
};
function scene(id: string): Scene {
  return {
    id,
    stageId: "fixed",
    type: "slide",
    title: id,
    order: 1,
    content: {
      type: "slide",
      canvas: {
        id,
        viewportSize: 1000,
        viewportRatio: 0.5625,
        elements: [],
        theme: {
          backgroundColor: "#fff",
          themeColors: [],
          fontColor: "#000",
          fontName: "Arial",
        },
      },
    },
    actions: [
      {
        id: `${id}-speech`,
        type: "speech",
        text: "Fixed narration",
        audioId: "voice",
        audioUrl: "blob:fixed",
      },
    ],
  };
}
function fixture(play: () => Promise<boolean>) {
  let ended = () => {};
  let failed = (_error: Error) => {};
  const audio = {
    play: vi.fn(play),
    onEnded: (cb: () => void) => {
      ended = cb;
    },
    onError: (cb: (e: Error) => void) => {
      failed = cb;
    },
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    isPlaying: () => false,
    hasActiveAudio: () => false,
    getCurrentTime: () => 0,
  } as unknown as AudioPlayer;
  return {
    audio,
    end: () => ended(),
    fail: () => failed(new Error("decoder failed")),
    captureFailure: () => {
      const callback = failed;
      return () => callback(new Error("stale decoder failure"));
    },
    captureEnd: () => ended,
  };
}
afterEach(() => vi.useRealTimers());
it("plays a verified music clip sequentially with pause, seek and no narration observers", async () => {
  const f = fixture(async () => true);
  f.audio.isPlaying = () => true;
  f.audio.hasActiveAudio = () => true;
  f.audio.seek = vi.fn();
  f.audio.getDuration = () => 6000;
  const page = scene("music");
  page.actions!.unshift({ id: "music-clip", type: "audio_clip", audioAssetId: "music", audioId: "music", audioUrl: "blob:music" });
  const speechStart = vi.fn(), speechEnd = vi.fn(), clipProgress = vi.fn();
  const core = new PlaybackCore([page], actions, f.audio, { onSpeechStart: speechStart, onSpeechEnd: speechEnd, onAudioClipProgress: clipProgress });
  core.start(); await Promise.resolve();
  expect(f.audio.play).toHaveBeenLastCalledWith("music", "blob:music");
  expect(speechStart).not.toHaveBeenCalled();
  expect(clipProgress).toHaveBeenLastCalledWith({ actionId: "music-clip", timeMs: 0, durationMs: 6000 });
  core.pause(); expect(f.audio.pause).toHaveBeenCalled();
  core.seekCurrentSpeech(500); expect(f.audio.seek).toHaveBeenCalledWith(500);
  core.resume(); expect(f.audio.resume).toHaveBeenCalled();
  f.end(); await Promise.resolve();
  expect(speechStart).toHaveBeenCalledWith("Fixed narration");
  expect(speechEnd).not.toHaveBeenCalled();
  expect(f.audio.play).toHaveBeenLastCalledWith("voice", "blob:fixed");
  expect(clipProgress).toHaveBeenLastCalledWith(null);
  core.stop();
});
it("pauses failed music without narration or reading fallback and ignores late events after navigation", async () => {
  vi.useFakeTimers();
  const f = fixture(async () => false);
  const page = scene("music-failure");
  page.actions = [{ id: "clip", type: "audio_clip", audioAssetId: "music", audioId: "music", audioUrl: "blob:music" }];
  const error = vi.fn(), complete = vi.fn(), speech = vi.fn();
  const core = new PlaybackCore([page, scene("next")], actions, f.audio, { onPlaybackError: error, onComplete: complete, onSpeechStart: speech });
  core.start(); await Promise.resolve();
  expect(core.getMode()).toBe("paused"); expect(error).toHaveBeenCalledOnce();
  expect(core.canSkipFailedSpeech()).toBe(true);
  await vi.advanceTimersByTimeAsync(30000);
  expect(complete).not.toHaveBeenCalled(); expect(speech).not.toHaveBeenCalled();
  const oldEnd = f.captureEnd(), oldFailure = f.captureFailure();
  core.stop();
  vi.mocked(f.audio.play).mockResolvedValue(true);
  core.restoreFromSnapshot({ sceneIndex: 1, actionIndex: 0, consumedDiscussions: [] });
  core.continuePlayback(); await Promise.resolve();
  oldEnd(); oldFailure(); await Promise.resolve();
  expect(core.getMode()).toBe("playing"); expect(complete).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledOnce(); core.stop();
});
it("allows explicit skip only for the current failed speech while paused and keeps the next teacher wait", async () => {
  const f = fixture(async () => true);
  const page = scene("skip-failed");
  page.actions!.push({ id: "teacher-wait", type: "interaction_checkpoint", checkpointId: "wait", checkpointKind: "teacher_continue" });
  const error = vi.fn(), complete = vi.fn();
  const core = new PlaybackCore([page], actions, f.audio, { onPlaybackError: error, onComplete: complete }, { speechFallback: "pause" });
  core.start(); await Promise.resolve();
  vi.spyOn(f.audio, "hasActiveAudio").mockReturnValue(true);
  core.pause();
  expect(core.canSkipFailedSpeech()).toBe(false);
  expect(core.skipCurrentPlaybackPoint()).toBe(false);
  core.resume(); await Promise.resolve();
  f.fail(); const staleFailure = f.captureFailure();
  vi.mocked(f.audio.hasActiveAudio).mockReturnValue(false);
  expect(core.getMode()).toBe("paused");
  expect(core.canSkipFailedSpeech()).toBe(true);
  expect(complete).not.toHaveBeenCalled();
  expect(core.skipCurrentPlaybackPoint()).toBe(true);
  await Promise.resolve();
  expect(core.canSkipFailedSpeech()).toBe(false);
  expect(core.getMode()).toBe("waiting_interaction");
  staleFailure(); f.end(); await Promise.resolve();
  expect(core.getMode()).toBe("waiting_interaction");
  expect(complete).not.toHaveBeenCalled();
  core.resumeInteraction("wait"); expect(complete).toHaveBeenCalledOnce(); core.stop();
});
it("ignores a late rejected audio start after an explicit retry of the same speech", async () => {
  let rejectOld!: (error: Error) => void;
  const f = fixture(() => new Promise<boolean>((_resolve, reject) => { rejectOld = reject; }));
  const error = vi.fn();
  const core = new PlaybackCore([scene("retry")], actions, f.audio, { onPlaybackError: error }, { speechFallback: "pause" });
  core.start(); f.fail();
  expect(core.canSkipFailedSpeech()).toBe(true);
  vi.mocked(f.audio.play).mockResolvedValue(true);
  core.resume(); await Promise.resolve();
  rejectOld(new Error("old attempt decode rejection"));
  await Promise.resolve(); await Promise.resolve();
  expect(core.getMode()).toBe("playing");
  expect(error).toHaveBeenCalledOnce();
  expect(core.canSkipFailedSpeech()).toBe(false);
  core.stop();
});
it("does not let a skipped speech's old events advance the next narration", async () => {
  const f = fixture(async () => true);
  const page = scene("skip-next");
  page.actions!.push({ id: "next-speech", type: "speech", text: "Next narration", audioId: "next", audioUrl: "blob:next" });
  const error = vi.fn(), complete = vi.fn();
  const core = new PlaybackCore([page], actions, f.audio, { onPlaybackError: error, onComplete: complete }, { speechFallback: "pause" });
  core.start(); await Promise.resolve();
  const oldEnd = f.captureEnd(), oldFail = f.captureFailure();
  f.fail(); expect(core.skipCurrentPlaybackPoint()).toBe(true); await Promise.resolve();
  expect(f.audio.play).toHaveBeenCalledTimes(2);
  oldEnd(); oldFail(); await Promise.resolve();
  expect(core.getMode()).toBe("playing");
  expect(error).toHaveBeenCalledOnce(); expect(complete).not.toHaveBeenCalled();
  f.end(); await Promise.resolve(); expect(complete).toHaveBeenCalledOnce(); core.stop();
});
it.each([29_999, 30_000])(
  "preserves a %i ms fixed narration pause across pause/resume",
  async (pauseAfterMs) => {
    vi.useFakeTimers();
    const page = scene("fixed-pause");
    const speech = page.actions![0];
    if (speech.type !== "speech") throw new Error("Expected narration");
    speech.pauseAfterMs = pauseAfterMs;
    const f = fixture(async () => true);
    const complete = vi.fn();
    const core = new PlaybackCore([page], actions, f.audio,
      { onComplete: complete }, { speechFallback: "pause" });
    try {
      core.start();
      await Promise.resolve();
      f.end();
      await vi.advanceTimersByTimeAsync(3001);
      expect(complete).not.toHaveBeenCalled();
      core.pause();
      await vi.advanceTimersByTimeAsync(8000);
      expect(complete).not.toHaveBeenCalled();
      core.resume();
      await vi.advanceTimersByTimeAsync(pauseAfterMs - 3002);
      expect(complete).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(complete).toHaveBeenCalledOnce();
    } finally {
      core.stop();
    }
  },
);
it("delivers question and reference answer while waiting for teacher continuation", async () => {
  const page = scene("question");
  const question = { id: "question", type: "interaction_checkpoint" as const, checkpointId: "question", checkpointKind: "chapter_summary" as const,
    chapterId: "question", chapterTitle: "Shapes", question: "How many sides?", response: { kind: "single" as const, options: ["Three", "Four"], answerIndices: [1] }, referenceAnswer: { summary: "Four", keyPoints: ["Four equal sides"] },
    context: { chapterSummary: "A square has four equal sides", sourceSceneIds: ["question"] } };
  page.actions = [question];
  const checkpoint = vi.fn(), complete = vi.fn();
  const core = new PlaybackCore([page], actions, fixture(async () => true).audio, { onInteractionStart: checkpoint, onComplete: complete });
  core.start(); await Promise.resolve();
  expect(core.getMode()).toBe("waiting_interaction");
  expect(checkpoint).toHaveBeenCalledWith(expect.objectContaining({ question: question.question, response: question.response, referenceAnswer: question.referenceAnswer }));
  expect(complete).not.toHaveBeenCalled();
  core.resumeInteraction("question");
  expect(complete).toHaveBeenCalledOnce();
  core.stop();
});
it("waits at a teacher checkpoint until explicitly resumed", async () => {
  const page = scene("teacher-wait");
  page.actions = [{ id: "continue", type: "interaction_checkpoint", checkpointId: "continue", checkpointKind: "teacher_continue" }];
  const f = fixture(async () => true);
  const complete = vi.fn();
  const checkpoint = vi.fn();
  const core = new PlaybackCore([page], actions, f.audio, { onComplete: complete, onInteractionStart: checkpoint }, { speechFallback: "pause" });
  core.start();
  await Promise.resolve();
  expect(core.getMode()).toBe("waiting_interaction");
  expect(checkpoint).toHaveBeenCalledWith({ checkpointId: "continue", checkpointKind: "teacher_continue" });
  expect(complete).not.toHaveBeenCalled();
  core.resumeInteraction("continue");
  expect(complete).toHaveBeenCalledOnce();
  core.stop();
});
it('keeps Quiz between its intro and review speech until explicitly submitted', async () => {
  const quiz: Scene = { ...scene('quiz'), type: 'quiz', content: { type: 'quiz', questions: [] }, actions: [1, 2, 3].map(n => ({ id: `speech-${n}`, type: 'speech', text: `Speech ${n}`, audioId: `audio-${n}`, audioUrl: 'blob:audio' })) };
  const f = fixture(async () => true), ready = vi.fn(), complete = vi.fn();
  const core = new PlaybackCore([quiz, scene('after')], actions, f.audio, { onComplete: complete }, { onQuizReady: ready });
  core.start(); await Promise.resolve(); f.end(); await Promise.resolve(); await Promise.resolve();
  expect(f.audio.play).toHaveBeenCalledTimes(2);
  f.end(); await Promise.resolve(); await Promise.resolve();
  expect(ready).toHaveBeenCalledWith('quiz'); expect(core.getSnapshot().sceneId).toBe('quiz');
  expect(core.getMode()).toBe('idle'); expect(complete).not.toHaveBeenCalled();
  core.completeQuiz(); await Promise.resolve(); expect(f.audio.play).toHaveBeenCalledTimes(3);
  f.end(); await Promise.resolve(); await Promise.resolve();
  expect(core.getSnapshot().sceneId).toBe('after'); expect(f.audio.play).toHaveBeenCalledTimes(4);
  core.stop();
});
it('announces an empty-action Quiz rather than skipping it', async () => {
  const quiz: Scene = { ...scene('quiz'), type: 'quiz', content: { type: 'quiz', questions: [] }, actions: [] };
  const ready = vi.fn(), complete = vi.fn(); const f = fixture(async () => true);
  const core = new PlaybackCore([quiz], actions, f.audio, { onComplete: complete }, { onQuizReady: ready });
  core.start(); expect(ready).toHaveBeenCalledWith('quiz'); expect(complete).not.toHaveBeenCalled();
  core.completeQuiz(); expect(complete).toHaveBeenCalledOnce(); core.stop();
});
it('waits for configured instant feedback speech, retries wrong answers and advances only correct answers', async () => {
  const quiz: Scene = { ...scene('instant'), type: 'quiz', content: { type: 'quiz', interactionMode: 'classroom_instant_feedback', questions: [],
    playbackConfig: { introSpeechMode: 'page_enter_only', attemptPolicy: 'until_correct', successSpeechText: 'Configured success', failureSpeechText: 'Configured retry', cueUserOnEnter: true, cueUserOnRetry: false } }, actions: [] };
  const f = fixture(async () => true), ready = vi.fn(), speech = vi.fn();
  const core = new PlaybackCore([quiz, scene('after')], actions, f.audio, { onSpeechStart: speech }, { onQuizReady: ready });
  core.start(); const wrong = core.answerInstantQuiz(false); await Promise.resolve();
  expect(speech).toHaveBeenLastCalledWith('Configured retry'); expect(core.getMode()).toBe('playing'); expect(core.getSnapshot().sceneId).toBe('instant');
  f.end(); await wrong; expect(core.getMode()).toBe('idle'); expect(ready).toHaveBeenCalledTimes(2);
  const correct = core.answerInstantQuiz(true); await Promise.resolve(); expect(speech).toHaveBeenLastCalledWith('Configured success');
  f.end(); await correct; expect(core.getSnapshot().sceneId).toBe('after'); core.stop();
});
it('hands canonical media checkpoints to the player until media completion', () => {
  const page = scene('media'); page.actions = [{ id: 'media', type: 'interaction_checkpoint', checkpointId: 'media', checkpointKind: 'media_playback', elementId: 'video', mediaType: 'video', startMode: 'teacher_triggered', waitForCompletion: true, videoUrl: 'blob:video' }];
  const ready = vi.fn(), complete = vi.fn();
  const core = new PlaybackCore([page], actions, fixture(async () => true).audio, { onInteractionStart: ready, onComplete: complete }, { waitForMediaCheckpoint: true });
  core.start(); expect(core.getMode()).toBe('waiting_interaction'); expect(ready).toHaveBeenCalledWith(expect.objectContaining({ videoUrl: 'blob:video' }));
  expect(complete).not.toHaveBeenCalled(); core.resumeInteraction('media'); expect(complete).toHaveBeenCalledOnce(); core.stop();
});
it("pauses on autoplay rejection and retries the same narration without estimating completion", async () => {
  vi.useFakeTimers();
  const f = fixture(async () => false);
  const error = vi.fn();
  const complete = vi.fn();
  const core = new PlaybackCore(
    [scene("page")],
    actions,
    f.audio,
    { onPlaybackError: error, onComplete: complete },
    { speechFallback: "pause" },
  );
  core.start();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(core.getMode()).toBe("paused");
  expect(error).toHaveBeenCalledOnce();
  expect(complete).not.toHaveBeenCalled();
  vi.mocked(f.audio.play).mockResolvedValue(true);
  core.resume();
  await Promise.resolve();
  expect(f.audio.play).toHaveBeenCalledTimes(2);
  f.end();
  await Promise.resolve();
  expect(complete).toHaveBeenCalledOnce();
});
it('does not estimate completion when canonical browser narration is unavailable', async () => {
  vi.useFakeTimers(); const page = scene('browser'); page.actions = [{ id: 'speech', type: 'speech', text: 'No stored audio' }];
  const error = vi.fn(), complete = vi.fn();
  const core = new PlaybackCore([page], actions, fixture(async () => false).audio, { onPlaybackError: error, onComplete: complete },
    { speechFallback: 'browser', getSpeechSettings: () => ({ ttsEnabled: true, ttsProviderId: 'browser-native-tts' }) });
  core.start(); await vi.advanceTimersByTimeAsync(60_000);
  expect(core.getMode()).toBe('paused'); expect(error).toHaveBeenCalledOnce(); expect(complete).not.toHaveBeenCalled(); core.stop();
});
it.each([false, true])('keeps visible Quiz feedback usable when system speech fails (correct=%s)', async correct => {
  vi.useFakeTimers();
  let utterance: SpeechSynthesisUtterance;
  const synthesis = { getVoices: () => [{ voiceURI: 'test', lang: 'en-US' }], cancel: vi.fn(), speak: vi.fn(value => { utterance = value; }) };
  vi.stubGlobal('window', { speechSynthesis: synthesis });
  vi.stubGlobal('SpeechSynthesisUtterance', class { constructor(public text: string) {} });
  const quiz: Scene = { ...scene('instant'), type: 'quiz', content: { type: 'quiz', interactionMode: 'classroom_instant_feedback', questions: [] }, actions: [] };
  const interaction = scene('interaction');
  interaction.actions = [{ id: 'checkpoint', type: 'interaction_checkpoint', checkpointId: 'checkpoint', checkpointKind: 'chapter_summary', chapterId: 'chapter', chapterTitle: 'Chapter', question: 'Say hello', referenceAnswer: { summary: '', keyPoints: [] }, context: { chapterSummary: '', sourceSceneIds: [] } }];
  const error = vi.fn();
  const core = new PlaybackCore([quiz, interaction], actions, fixture(async () => false).audio, { onPlaybackError: error },
    { onQuizReady: vi.fn(), speechFallback: 'browser', getSpeechSettings: () => ({ ttsEnabled: true, ttsProviderId: 'browser-native-tts' }) });
  try {
    core.start(); const feedback = core.answerInstantQuiz(correct);
    await vi.advanceTimersByTimeAsync(0);
    expect(synthesis.speak).toHaveBeenCalledOnce();
    utterance!.onerror!({ error: 'synthesis-failed' } as SpeechSynthesisErrorEvent);
    expect(core.getMode()).toBe('playing');
    await vi.advanceTimersByTimeAsync(1000);
    expect(core.getSnapshot().sceneId).toBe('instant');
    await vi.advanceTimersByTimeAsync(10000); await feedback;
    expect(core.getSnapshot().sceneId).toBe(correct ? 'interaction' : 'instant');
    expect(core.getMode()).toBe(correct ? 'waiting_interaction' : 'idle');
    expect(error).not.toHaveBeenCalled();
  } finally { core.stop(); vi.unstubAllGlobals(); vi.useRealTimers(); }
});
it("does not let stale narration errors pause a different page", async () => {
  const f = fixture(async () => true);
  const error = vi.fn();
  const core = new PlaybackCore(
    [scene("one"), scene("two")],
    actions,
    f.audio,
    { onPlaybackError: error },
    { speechFallback: "pause" },
  );
  core.start();
  const oldFail = f.captureFailure();
  core.stop();
  core.restoreFromSnapshot({
    sceneIndex: 1,
    actionIndex: 0,
    consumedDiscussions: [],
  });
  core.continuePlayback();
  // stop invalidates the speech execution; no reading-time fallback is installed.
  expect(core.getSnapshot().sceneIndex).toBe(1);
  oldFail();
  expect(error).not.toHaveBeenCalled();
  expect(core.getMode()).toBe("playing");
  core.stop();
});
it("announces the next page before its first narration", async () => {
  const f = fixture(async () => true);
  const pages: string[] = [];
  const core = new PlaybackCore(
    [scene("one"), scene("two")],
    actions,
    f.audio,
    { onSceneChange: (id) => pages.push(id) },
    { speechFallback: "pause" },
  );
  core.start();
  await Promise.resolve();
  f.end();
  await Promise.resolve();
  expect(pages).toEqual(["one", "two"]);
  core.stop();
});
it("exports the cursor's actual page identity through restore, advance, completion and replay", async () => {
  const f = fixture(async () => true);
  const core = new PlaybackCore([scene("one"), scene("two")], actions, f.audio,
    {}, { speechFallback: "pause" });
  core.restoreFromSnapshot({ sceneIndex: 1, actionIndex: 0,
    consumedDiscussions: [], sceneId: "one" });
  expect(core.getSnapshot()).toMatchObject({ sceneIndex: 1, sceneId: "two" });
  core.continuePlayback();
  await Promise.resolve();
  core.pause();
  expect(core.getSnapshot()).toMatchObject({ sceneIndex: 1, sceneId: "two" });
  core.resume();
  f.end();
  await Promise.resolve();
  expect(core.getSnapshot()).toMatchObject({ sceneIndex: 2, sceneId: undefined });
  core.stop();
  expect(core.getSnapshot()).toMatchObject({ sceneIndex: 0, sceneId: "one" });
  core.start();
  await Promise.resolve();
  f.end();
  await Promise.resolve();
  expect(core.getSnapshot()).toMatchObject({ sceneIndex: 1, sceneId: "two" });
  core.stop();
});
it("keeps an asynchronous audio start paused when Pause wins the race", async () => {
  let resolve!: (value: boolean) => void;
  const f = fixture(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const core = new PlaybackCore(
    [scene("one")],
    actions,
    f.audio,
    {},
    { speechFallback: "pause" },
  );
  core.start();
  core.pause();
  resolve(true);
  await Promise.resolve();
  await Promise.resolve();
  expect(f.audio.pause).toHaveBeenCalled();
  expect(core.getMode()).toBe("paused");
  core.stop();
});
it("pauses on decoder errors and does not call the reading timer", async () => {
  vi.useFakeTimers();
  const f = fixture(async () => true);
  const complete = vi.fn();
  const core = new PlaybackCore(
    [scene("one")],
    actions,
    f.audio,
    { onComplete: complete },
    { speechFallback: "pause" },
  );
  core.start();
  await Promise.resolve();
  f.fail();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(core.getMode()).toBe("paused");
  expect(complete).not.toHaveBeenCalled();
  core.stop();
});

it("publishes actual narration position, clamps seek, and clears the audio phase before fixed silence", async () => {
  let frame: FrameRequestCallback | undefined;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frame = callback;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const f = fixture(async () => true);
  let time = 0;
  f.audio.getCurrentTime = () => time;
  f.audio.getDuration = () => 6000;
  f.audio.hasActiveAudio = () => true;
  f.audio.seek = vi.fn((value) => {
    time = Math.min(6000, Math.max(0, value));
  });
  const progress = vi.fn();
  const page = scene("page");
  const speech = page.actions![0];
  if (speech.type !== "speech") throw new Error("Missing narration");
  speech.pauseAfterMs = 1200;
  const core = new PlaybackCore(
    [page],
    actions,
    f.audio,
    { onSpeechProgress: progress },
    { speechFallback: "pause" },
  );
  core.start();
  await Promise.resolve();
  time = 1200;
  frame?.(1200);
  expect(progress).toHaveBeenLastCalledWith({
    actionId: "page-speech",
    timeMs: 1200,
    durationMs: 6000,
  });
  core.pause();
  core.seekCurrentSpeech(9000);
  expect(progress).toHaveBeenLastCalledWith({
    actionId: "page-speech",
    timeMs: 6000,
    durationMs: 6000,
  });
  core.seekCurrentSpeech(Number.NaN);
  expect(f.audio.seek).toHaveBeenCalledTimes(1);
  core.seekCurrentSpeech(100);
  expect(progress).toHaveBeenLastCalledWith({
    actionId: "page-speech",
    timeMs: 100,
    durationMs: 6000,
  });
  core.resume();
  f.end();
  expect(progress).toHaveBeenLastCalledWith(null);
  core.stop();
  core.seekCurrentSpeech(800);
  expect(f.audio.seek).toHaveBeenCalledTimes(2);
  vi.unstubAllGlobals();
});

it("keeps legacy narration seek working without visual cues or progress subscribers", async () => {
  const f = fixture(async () => true);
  f.audio.hasActiveAudio = () => true;
  f.audio.seek = vi.fn();
  const core = new PlaybackCore([scene("legacy")], actions, f.audio);
  core.start();
  await Promise.resolve();
  core.seekCurrentSpeech(800);
  expect(f.audio.seek).toHaveBeenCalledWith(800);
  core.stop();
});

it("waits for archived video playback before speaking and never executes a draft", async () => {
  const f = fixture(async () => true), interaction = vi.fn(), complete = vi.fn();
  const page = scene("video");
  page.actions!.unshift({ id: "clip", type: "video_clip", videoAssetId: "asset", videoUrl: "blob:verified-video" });
  const core = new PlaybackCore([page], actions, f.audio, { onInteractionStart: interaction, onInteractionComplete: complete });
  core.start(); await Promise.resolve();
  expect(core.getMode()).toBe("waiting_interaction");
  expect(f.audio.play).not.toHaveBeenCalled();
  expect(interaction).toHaveBeenCalledWith(expect.objectContaining({ checkpointId: "clip", checkpointKind: "media_playback", videoUrl: "blob:verified-video" }));
  core.resumeInteraction(); await Promise.resolve();
  expect(complete).toHaveBeenCalledWith("clip");
  expect(f.audio.play).toHaveBeenCalledTimes(1);
  core.stop();
});
