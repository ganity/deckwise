import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const media = vi.hoisted(() => ({ plays: [] as string[], ended: () => {}, error: (_: Error) => {},
  position: 0, paused: false, available: true, stop: vi.fn() }));
vi.mock('./player/lib/utils/audio-player', () => ({ AudioPlayer: class {
  play(_id: string, url: string) { media.plays.push(url); media.paused = false; return Promise.resolve(media.available); }
  onEnded(cb: () => void) { media.ended = cb; }
  onError(cb: (e: Error) => void) { media.error = cb; }
  pause() { media.paused = true; }
  resume() { media.paused = false; }
  stop() { media.stop(); }
  getCurrentTime() { return media.position; }
  getDuration() { return 1000; }
  isPlaying() { return !media.paused; }
  hasActiveAudio() { return true; }
  seek(ms: number) { media.position = ms; }
} }));
import { createTeachingTimelinePreview, type TeachingPreviewNode } from './teaching-timeline-preview';
import { evaluateQuestionAnswer } from './question-response';
let current: ReturnType<typeof createTeachingTimelinePreview> | undefined;
beforeEach(() => { vi.useFakeTimers(); media.plays = []; media.available = true; media.position = 0; media.stop.mockClear(); });
afterEach(() => { current?.dispose(); current = undefined; vi.useRealTimers(); });
const speech = (id: string, pauseAfterMs = 0): TeachingPreviewNode => ({ id, type: 'speech', text: id, audioUrl: `blob:${id}`, pauseAfterMs });
it('pauses and resumes page-entry native animation even when no speech owns a native step', async () => {
  const native = { sourceSha256: 'a'.repeat(64), stepCount: 0, next: vi.fn(), pause: vi.fn(), resume: vi.fn() };
  current = createTeachingTimelinePreview({ pageId: 'page', nodes: [speech('intro')], native,
    onMode: vi.fn(), onProgress: vi.fn(), onNode: vi.fn(), onError: vi.fn(), onComplete: vi.fn() });
  current.start(); await Promise.resolve();
  current.pause(); expect(native.pause).toHaveBeenCalledOnce();
  current.resume(); expect(native.resume).toHaveBeenCalledOnce();
  expect(native.next).not.toHaveBeenCalled();
});
function setup(nodes: TeachingPreviewNode[], video?: HTMLVideoElement) {
  const callbacks = { onMode: vi.fn(), onProgress: vi.fn(), onNode: vi.fn(), onError: vi.fn(), onComplete: vi.fn(), onMediaProgress: vi.fn() };
  current = createTeachingTimelinePreview({ pageId: 'page', nodes, video, ...callbacks });
  return { preview: current, ...callbacks };
}
it('plays in order, freezes post-speech silence on pause, and requires explicit teacher continuation', async () => {
  const f = setup([speech('first', 500), { id: 'wait', type: 'interaction_checkpoint', checkpointId: 'teacher', checkpointKind: 'teacher_continue' }, speech('second')]);
  f.preview.start(); await Promise.resolve();
  expect(media.plays).toEqual(['blob:first']);
  media.ended(); await vi.advanceTimersByTimeAsync(200);
  f.preview.pause(); await vi.advanceTimersByTimeAsync(1000);
  expect(f.onMode).toHaveBeenLastCalledWith('paused');
  expect(media.plays).toHaveLength(1);
  f.preview.resume(); await vi.advanceTimersByTimeAsync(300);
  expect(f.onMode).toHaveBeenLastCalledWith('waiting_interaction');
  f.preview.resume(); await vi.advanceTimersByTimeAsync(5000);
  expect(media.plays).toHaveLength(1);
  f.preview.continueTeacher(); await Promise.resolve();
  expect(media.plays).toEqual(['blob:first', 'blob:second']);
  media.ended(); await vi.advanceTimersByTimeAsync(0);
  expect(f.onComplete).toHaveBeenCalledOnce();
  expect(f.onNode.mock.calls.map(([id]) => id)).toEqual(['first', 'wait', 'second']);
});
it('pauses failed audio without reading fallback and retries the same node explicitly', async () => {
  media.available = false;
  const f = setup([speech('first'), speech('second')]);
  f.preview.start(); await Promise.resolve();
  expect(f.onError).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(60000);
  expect(f.onComplete).not.toHaveBeenCalled();
  expect(media.plays).toEqual(['blob:first']);
  media.available = true; f.preview.resume(); await Promise.resolve();
  expect(media.plays).toEqual(['blob:first', 'blob:first']);
  media.ended(); await vi.advanceTimersByTimeAsync(0);
  expect(media.plays.at(-1)).toBe('blob:second');
});
it('seeks through the audio clock and rejects late completion/error after disposal', async () => {
  const f = setup([speech('first'), speech('second')]);
  f.preview.start(); await Promise.resolve();
  f.preview.seek(700); expect(media.position).toBe(700);
  const end = media.ended, error = media.error;
  f.preview.dispose(); const before = f.onProgress.mock.calls.length;
  end(); error(new Error('late decoder error')); await vi.advanceTimersByTimeAsync(60000);
  expect(media.plays).toEqual(['blob:first']);
  expect(f.onComplete).not.toHaveBeenCalled(); expect(f.onError).not.toHaveBeenCalled();
  expect(f.onProgress).toHaveBeenCalledTimes(before);
  expect(media.stop).toHaveBeenCalled();
});
it('rejects duplicate identities, external audio and invalid pause lengths before playback', () => {
  expect(() => setup([speech('same'), speech('same')])).toThrow();
  expect(() => setup([{ ...speech('id'), audioUrl: 'https://remote/audio.wav' } as TeachingPreviewNode])).toThrow();
  expect(() => setup([speech('id', 30001)])).toThrow();
  expect(media.plays).toEqual([]);
});
class LocalVideo extends EventTarget {
  src = ''; hidden = true; paused = true; currentTime = 0; duration = 2; ended = false; error: Error | null = null;
  rejectPlay = false;
  play() { if (this.rejectPlay) return Promise.reject(new Error('blocked decoder')); this.paused = false; this.ended = false; this.dispatchEvent(new Event('play')); return Promise.resolve(); }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
  removeAttribute() { this.src = ''; }
  load() {}
}
it('plays adopted music between speeches using the same audio player', async () => {
  const f = setup([speech('first'), { id: 'music', type: 'audio_clip', audioUrl: 'blob:music' }, speech('last')]);
  f.preview.start(); await Promise.resolve();
  media.ended(); await vi.advanceTimersByTimeAsync(0);
  expect(media.plays).toEqual(['blob:first', 'blob:music']);
  f.preview.pause(); expect(media.paused).toBe(true);
  f.preview.resume(); expect(media.paused).toBe(false);
  media.ended(); await vi.advanceTimersByTimeAsync(0);
  expect(media.plays.at(-1)).toBe('blob:last');
  media.ended(); await vi.advanceTimersByTimeAsync(0);
  expect(f.onComplete).toHaveBeenCalledOnce();
});
it('auto-plays a video, pauses/resumes/seeks it, and waits for its real end before the next speech', async () => {
  const video = new LocalVideo();
  const f = setup([{ id: 'video', type: 'video_clip', videoUrl: 'blob:video' }, speech('last')], video as unknown as HTMLVideoElement);
  f.preview.start(); await Promise.resolve();
  expect(video.src).toBe('blob:video'); expect(video.hidden).toBe(false);
  expect(f.onMode).toHaveBeenLastCalledWith('playing');
  f.preview.continueTeacher(); await vi.advanceTimersByTimeAsync(10000);
  expect(media.plays).toEqual([]);
  f.preview.pause(); expect(f.onMode).toHaveBeenLastCalledWith('paused');
  f.preview.seek(800); expect(video.currentTime).toBe(.8);
  video.dispatchEvent(new Event('timeupdate'));
  expect(f.onMediaProgress).toHaveBeenLastCalledWith({ actionId: 'video', timeMs: 800, durationMs: 2000 });
  f.preview.resume(); expect(f.onMode).toHaveBeenLastCalledWith('playing');
  video.ended = true; video.dispatchEvent(new Event('ended')); await vi.advanceTimersByTimeAsync(0);
  expect(media.plays).toEqual(['blob:last']); expect(video.hidden).toBe(true); expect(video.src).toBe('');
});
it('keeps a failed video on the same node until an explicit retry and ignores late events after stop', async () => {
  const video = new LocalVideo(); video.rejectPlay = true;
  const f = setup([{ id: 'video', type: 'video_clip', videoUrl: 'blob:video' }, speech('last')], video as unknown as HTMLVideoElement);
  f.preview.start(); await Promise.resolve();
  expect(f.onError).toHaveBeenCalledOnce(); expect(f.onMode).toHaveBeenLastCalledWith('paused');
  await vi.advanceTimersByTimeAsync(10000); expect(media.plays).toEqual([]);
  video.rejectPlay = false; f.preview.resume(); await Promise.resolve();
  expect(f.onMode).toHaveBeenLastCalledWith('playing');
  f.preview.dispose(); video.dispatchEvent(new Event('ended')); video.dispatchEvent(new Event('error'));
  await vi.advanceTimersByTimeAsync(10000);
  expect(media.plays).toEqual([]); expect(f.onComplete).not.toHaveBeenCalled(); expect(f.onError).toHaveBeenCalledOnce();
});
it('rejects external clip URLs and a video without a playback surface', () => {
  expect(() => setup([{ id: 'a', type: 'audio_clip', audioUrl: 'https://audio' }])).toThrow();
  expect(() => setup([{ id: 'v', type: 'video_clip', videoUrl: 'blob:video' }])).toThrow();
});

it('does not let queued media events from a preceding clip advance or pause the next clip', async () => {
  const video = new LocalVideo();
  const f = setup([
    { id: 'v1', type: 'video_clip', videoUrl: 'blob:first' },
    { id: 'v2', type: 'video_clip', videoUrl: 'blob:second' },
    speech('last'),
  ], video as unknown as HTMLVideoElement);
  f.preview.start(); await Promise.resolve();
  video.ended = true; video.dispatchEvent(new Event('ended')); await Promise.resolve();
  expect(video.src).toBe('blob:second');
  const modes = f.onMode.mock.calls.length;
  video.dispatchEvent(new Event('pause')); video.dispatchEvent(new Event('ended')); video.dispatchEvent(new Event('error'));
  await vi.advanceTimersByTimeAsync(0);
  expect(media.plays).toEqual([]); expect(f.onMode).toHaveBeenCalledTimes(modes); expect(f.onError).not.toHaveBeenCalled();
  video.ended = true; video.dispatchEvent(new Event('ended')); await vi.advanceTimersByTimeAsync(0);
  expect(media.plays).toEqual(['blob:last']);
});

it('freezes an explicit delay on pause and completes it before the next node', async () => {
  const f = setup([{ id: 'delay', type: 'delay', durationMs: 1000 }, speech('next')]);
  f.preview.start(); await vi.advanceTimersByTimeAsync(300);
  expect(f.onNode).toHaveBeenLastCalledWith('delay');
  expect(media.plays).toEqual([]);
  f.preview.pause(); await vi.advanceTimersByTimeAsync(5000);
  expect(f.onComplete).not.toHaveBeenCalled();
  f.preview.continueTeacher();
  f.preview.resume(); await vi.advanceTimersByTimeAsync(699);
  expect(media.plays).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(media.plays).toEqual(['blob:next']);
  media.ended(); await vi.advanceTimersByTimeAsync(0);
  expect(f.onComplete).toHaveBeenCalledOnce();
});
it('cancels an explicit delay without late completion', async () => {
  const f = setup([{ id: 'delay', type: 'delay', durationMs: 1000 }, speech('next')]);
  f.preview.start(); await vi.advanceTimersByTimeAsync(200);
  f.preview.dispose(); await vi.advanceTimersByTimeAsync(5000);
  expect(media.plays).toEqual([]);
  expect(f.onComplete).not.toHaveBeenCalled();
});
it.each([-1, 0.5, 30001, NaN, Infinity])('rejects invalid delay %s before playback', durationMs => {
  expect(() => setup([{ id: 'delay', type: 'delay', durationMs }])).toThrow('bounded delay');
  expect(media.plays).toEqual([]);
});


it('waits for actual native step completion between speech and teacher waits, freezing completion while paused', async () => {
  let complete = () => {};
  const native = { sourceSha256: 'a'.repeat(64), stepCount: 2, next: vi.fn(() => new Promise<void>(resolve => { complete = resolve; })), pause: vi.fn(), resume: vi.fn() };
  const node = (stepIndex: number): TeachingPreviewNode => ({ id: `n${stepIndex}`, type: 'native_animation', version: 1, sourceSha256: native.sourceSha256, stepIndex });
  const onMode = vi.fn(), onComplete = vi.fn(), onError = vi.fn();
  current = createTeachingTimelinePreview({ pageId: 'page', native,
    nodes: [speech('intro'), node(0), speech('middle'), { id: 'wait', type: 'interaction_checkpoint', checkpointId: 'native:n0', checkpointKind: 'teacher_continue' }, node(1), speech('last')],
    onMode, onComplete, onError, onNode: vi.fn(), onProgress: vi.fn() });
  current.start(); await Promise.resolve();
  expect(native.next).not.toHaveBeenCalled();
  media.ended(); await vi.advanceTimersByTimeAsync(0);
  expect(native.next).toHaveBeenLastCalledWith(0);
  current.continueTeacher(); await vi.advanceTimersByTimeAsync(60000);
  expect(media.plays).toEqual(['blob:intro']);
  current.pause(); expect(native.pause).toHaveBeenCalledOnce();
  complete(); await vi.advanceTimersByTimeAsync(0);
  expect(media.plays).toEqual(['blob:intro']);
  current.resume(); await vi.advanceTimersByTimeAsync(0);
  expect(media.plays.at(-1)).toBe('blob:middle');
  media.ended(); await vi.advanceTimersByTimeAsync(0);
  expect(onMode).toHaveBeenLastCalledWith('waiting_interaction');
  expect(native.next).toHaveBeenCalledTimes(1);
  current.continueTeacher(); await vi.advanceTimersByTimeAsync(0);
  expect(native.next).toHaveBeenLastCalledWith(1);
  complete(); await vi.advanceTimersByTimeAsync(0);
  expect(media.plays.at(-1)).toBe('blob:last');
  media.ended(); await vi.advanceTimersByTimeAsync(0);
  expect(onComplete).toHaveBeenCalledOnce(); expect(onError).not.toHaveBeenCalled();
});
it('rejects stale native bindings before playback and fences failure or completion after stop', async () => {
  const node: TeachingPreviewNode = { id: 'n', type: 'native_animation', version: 1, sourceSha256: 'a'.repeat(64), stepIndex: 0 };
  const native = { sourceSha256: 'a'.repeat(64), stepCount: 1, next: vi.fn(() => Promise.resolve()), pause: vi.fn(), resume: vi.fn() };
  const callbacks = { onMode: vi.fn(), onComplete: vi.fn(), onError: vi.fn(), onNode: vi.fn(), onProgress: vi.fn() };
  for (const adapter of [undefined, { ...native, sourceSha256: 'b'.repeat(64) }, { ...native, stepCount: 2 }])
    expect(() => createTeachingTimelinePreview({ pageId: 'page', nodes: [node], native: adapter, ...callbacks })).toThrow();
  let reject = (_: Error) => {};
  native.next.mockImplementation(() => new Promise((_, failed) => { reject = failed; }));
  current = createTeachingTimelinePreview({ pageId: 'page', nodes: [node, speech('after')], native, ...callbacks });
  current.start(); reject(new Error('native failure')); await vi.advanceTimersByTimeAsync(0);
  expect(callbacks.onError).toHaveBeenCalledOnce(); expect(native.pause).toHaveBeenCalledOnce();
  current.resume(); current.continueTeacher(); await vi.advanceTimersByTimeAsync(60000);
  expect(native.next).toHaveBeenCalledTimes(1); expect(media.plays).toEqual([]);
  current.dispose(); callbacks.onError.mockClear(); callbacks.onComplete.mockClear();
  let complete = () => {};
  native.next.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  current = createTeachingTimelinePreview({ pageId: 'page', nodes: [node, speech('after')], native, ...callbacks });
  current.start(); current.dispose(); complete(); await vi.advanceTimersByTimeAsync(0);
  expect(callbacks.onError).not.toHaveBeenCalled(); expect(callbacks.onComplete).not.toHaveBeenCalled(); expect(media.plays).toEqual([]);
});

it.each([{ sourceSceneIds: [] }, { sourceSceneIds: ['source-lesson-page'] }])('preserves teacher-led context with source scene IDs $sourceSceneIds and waits for continuation', async ({ sourceSceneIds }) => {
  const question = { id: 'question', type: 'interaction_checkpoint' as const, checkpointId: 'question', checkpointKind: 'chapter_summary' as const,
    chapterId: 'page', chapterTitle: 'Practice', question: 'Who says Hello?', referenceAnswer: { summary: 'Monkey', keyPoints: ['Monkey waves'] },
    context: { chapterSummary: 'Greetings', sourceSceneIds } };
  const expected = structuredClone(question);
  const onInteraction = vi.fn();
  const onMode = vi.fn(), onError = vi.fn(), onComplete = vi.fn();
  current = createTeachingTimelinePreview({ pageId: 'page', nodes: [question, speech('after')], onInteraction,
    onMode, onProgress: vi.fn(), onNode: vi.fn(), onError, onComplete });
  current.start(); await vi.advanceTimersByTimeAsync(0);
  expect(onInteraction).toHaveBeenCalledExactlyOnceWith(expected);
  expect(question).toEqual(expected);
  expect(onMode).toHaveBeenLastCalledWith('waiting_interaction');
  expect(media.plays).toEqual([]);
  await vi.advanceTimersByTimeAsync(60000);
  expect(media.plays).toEqual([]);
  expect(onComplete).not.toHaveBeenCalled();
  current.continueTeacher(); await vi.advanceTimersByTimeAsync(0);
  expect(media.plays).toEqual(['blob:after']);
  media.ended(); await vi.advanceTimersByTimeAsync(0);
  expect(onComplete).toHaveBeenCalledOnce();
  expect(onError).not.toHaveBeenCalled();
  expect(() => setup([{ ...question, context: { ...question.context, sourceSceneIds: [''] } }])).toThrow();
  expect(() => setup([{ ...question, context: { ...question.context, sourceSceneIds: Array(101).fill('page') } }])).toThrow();
});
it.each(['single', 'multiple', 'judge'] as const)('plays a saved %s quiz without optional explanatory text and preserves its answer key', async kind => {
  const question = { id: 'quiz', type: 'interaction_checkpoint' as const, checkpointId: 'quiz', checkpointKind: 'chapter_summary' as const,
    chapterId: 'chapter', chapterTitle: 'Family', question: 'Which picture shows grandmother?',
    response: { kind, options: ['Grandfather', 'Grandmother'], answerIndices: [1] },
    referenceAnswer: { summary: '', keyPoints: [] }, context: { chapterSummary: 'Family', sourceSceneIds: [] } };
  const onInteraction = vi.fn(), onComplete = vi.fn(), onError = vi.fn();
  current = createTeachingTimelinePreview({ pageId: 'page', nodes: [question, speech('after')], onInteraction,
    onMode: vi.fn(), onProgress: vi.fn(), onNode: vi.fn(), onComplete, onError });
  current.start(); await vi.advanceTimersByTimeAsync(0);
  expect(onInteraction).toHaveBeenCalledExactlyOnceWith(question);
  expect(evaluateQuestionAnswer(onInteraction.mock.calls[0][0].response, [0])).toBe(false);
  expect(evaluateQuestionAnswer(onInteraction.mock.calls[0][0].response, [1])).toBe(true);
  await vi.advanceTimersByTimeAsync(60000);
  expect(media.plays).toEqual([]);
  current.continueTeacher(); await vi.advanceTimersByTimeAsync(0);
  expect(media.plays).toEqual(['blob:after']);
  media.ended(); await vi.advanceTimersByTimeAsync(0);
  expect(onComplete).toHaveBeenCalledOnce();
  expect(onError).not.toHaveBeenCalled();
  expect(() => setup([{ ...question, response: { ...question.response, answerIndices: [2] } }])).toThrow();
});
it('starts native motion on the audio clock and waits for both audio and native completion', async () => {
  let finish!: () => void;
  const native = { sourceSha256: 'a'.repeat(64), stepCount: 1, next: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })), pause: vi.fn(), resume: vi.fn() };
  const callbacks = { onMode: vi.fn(), onProgress: vi.fn(), onNode: vi.fn(), onError: vi.fn(), onComplete: vi.fn() };
  current = createTeachingTimelinePreview({ pageId: 'page', nodes: [speech('first'), speech('last')], native,
    speechMotions: [{ actionId: 'first', stepIndex: 0 }], ...callbacks });
  current.start(); await vi.advanceTimersByTimeAsync(20);
  expect(media.plays).toEqual(['blob:first']);
  expect(native.next).toHaveBeenCalledExactlyOnceWith(0);
  current.pause(); expect(native.pause).toHaveBeenCalled();
  current.resume(); expect(native.resume).toHaveBeenCalled();
  media.ended(); await vi.advanceTimersByTimeAsync(1000);
  current.continueTeacher(); expect(media.plays).toEqual(['blob:first']);
  finish(); await vi.advanceTimersByTimeAsync(0);
  expect(media.plays).toEqual(['blob:first', 'blob:last']);
  media.ended(); await vi.advanceTimersByTimeAsync(0);
  expect(callbacks.onComplete).toHaveBeenCalledOnce();
});
it('plays additional edited PPT click steps for one speech once, in native order, and waits before the next speech', async () => {
  const finish: Array<() => void> = [];
  const native = { sourceSha256: 'a'.repeat(64), stepCount: 2,
    next: vi.fn(() => new Promise<void>(resolve => finish.push(resolve))), pause: vi.fn(), resume: vi.fn() };
  const callbacks = { onMode: vi.fn(), onProgress: vi.fn(), onNode: vi.fn(), onError: vi.fn(), onComplete: vi.fn() };
  current = createTeachingTimelinePreview({ pageId: 'page', nodes: [speech('first'), speech('last')], native,
    speechMotions: [{ actionId: 'first', stepIndex: 0 }, { actionId: 'first', stepIndex: 1 }], ...callbacks });
  current.start(); await vi.advanceTimersByTimeAsync(20);
  expect(native.next.mock.calls).toEqual([[0]]);
  media.ended(); await vi.advanceTimersByTimeAsync(1000);
  expect(media.plays).toEqual(['blob:first']);
  finish[0](); await vi.advanceTimersByTimeAsync(0);
  expect(native.next.mock.calls).toEqual([[0], [1]]);
  current.pause(); finish[1](); await vi.advanceTimersByTimeAsync(0);
  expect(media.plays).toEqual(['blob:first']);
  current.resume(); await vi.advanceTimersByTimeAsync(0);
  expect(media.plays).toEqual(['blob:first', 'blob:last']);
  media.ended(); await vi.advanceTimersByTimeAsync(0);
  expect(callbacks.onComplete).toHaveBeenCalledOnce();
  expect(callbacks.onError).not.toHaveBeenCalled();
});
it('holds queued native steps while paused and cancels them when playback stops', async () => {
  let finish!: () => void;
  const native = { sourceSha256: 'a'.repeat(64), stepCount: 2,
    next: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })), pause: vi.fn(), resume: vi.fn() };
  current = createTeachingTimelinePreview({ pageId: 'page', nodes: [speech('first')], native,
    speechMotions: [{ actionId: 'first', stepIndex: 0 }, { actionId: 'first', stepIndex: 1 }],
    onMode: vi.fn(), onProgress: vi.fn(), onNode: vi.fn(), onError: vi.fn(), onComplete: vi.fn() });
  current.start(); await vi.advanceTimersByTimeAsync(20);
  current.pause(); finish(); await vi.advanceTimersByTimeAsync(20);
  expect(native.next.mock.calls).toEqual([[0]]);
  current.dispose(); await vi.advanceTimersByTimeAsync(20);
  expect(native.next.mock.calls).toEqual([[0]]);
});
it('rejects interleaved speech bindings that would reorder native click steps', () => {
  const native = { sourceSha256: 'a'.repeat(64), stepCount: 3, next: vi.fn(), pause: vi.fn(), resume: vi.fn() };
  expect(() => createTeachingTimelinePreview({ pageId: 'page', nodes: [speech('first'), speech('last')], native,
    speechMotions: [{ actionId: 'first', stepIndex: 0 }, { actionId: 'last', stepIndex: 1 }, { actionId: 'first', stepIndex: 2 }],
    onMode: vi.fn(), onProgress: vi.fn(), onNode: vi.fn(), onError: vi.fn(), onComplete: vi.fn() })).toThrow('Invalid speech-native');
});
it('fires simultaneous calibrated native motions at audio time, then sentence-end motion before the post-speech pause', async () => {
  const oldRaf = globalThis.requestAnimationFrame, oldCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = cb => setTimeout(() => cb(0), 16) as unknown as number;
  globalThis.cancelAnimationFrame = id => clearTimeout(id);
  const next = vi.fn(async (_index: number) => {}), onError = vi.fn(), complete = vi.fn();
  try {
    current = createTeachingTimelinePreview({ pageId: 'page', nodes: [{ id: 'speech', type: 'speech', text: '小狗好', audioAssetId: 'audio', audioUrl: 'blob:voice', pauseAfterMs: 300 }],
      native: { sourceSha256: 'a'.repeat(64), stepCount: 3, next, pause() {}, resume() {} },
      speechMotions: [
        { actionId: 'speech', stepIndex: 0, atMs: 400, endMs: 600, trigger: { version: 1, kind: 'text', text: '小狗', start: 0, end: 2, phase: 'with', audioAssetId: 'audio' } },
        { actionId: 'speech', stepIndex: 1, atMs: 400, endMs: 600 },
        { actionId: 'speech', stepIndex: 2, atMs: 1000, endMs: 1600, trigger: { version: 1, kind: 'end' } },
      ], onMode() {}, onProgress() {}, onNode() {}, onError, onComplete: complete });
    current.start(); await vi.advanceTimersByTimeAsync(16);
    expect(next).not.toHaveBeenCalled();
    current.seek(400); await vi.advanceTimersByTimeAsync(16);
    expect(next.mock.calls.map(([i]) => i)).toEqual([0, 1]);
    current.pause(); media.position = 800; await vi.advanceTimersByTimeAsync(1000);
    expect(next).toHaveBeenCalledTimes(2);
    current.resume(); media.position = 1000; media.ended();
    await vi.advanceTimersByTimeAsync(300); expect(next.mock.calls.map(([i]) => i)).toEqual([0, 1, 2]); expect(complete).not.toHaveBeenCalled();
    current.pause(); await vi.advanceTimersByTimeAsync(1000); expect(complete).not.toHaveBeenCalled();
    current.resume(); await vi.advanceTimersByTimeAsync(599); expect(complete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(complete).toHaveBeenCalledOnce(); expect(onError).not.toHaveBeenCalled();
  } finally { current?.dispose(); globalThis.requestAnimationFrame = oldRaf; globalThis.cancelAnimationFrame = oldCancel; }
});

it('allows forward seeking with native speech motions but rejects rewinding their state', async () => {
  const onError = vi.fn();
  current = createTeachingTimelinePreview({ pageId: 'page', nodes: [speech('s')],
    native: { sourceSha256: 'a'.repeat(64), stepCount: 1, next: vi.fn(async () => {}), pause() {}, resume() {} },
    speechMotions: [{ actionId: 's', stepIndex: 0 }],
    onMode() {}, onProgress() {}, onNode() {}, onError, onComplete() {} });
  current.start(); await vi.advanceTimersByTimeAsync(0);
  current.seek(700); expect(media.position).toBe(700); expect(onError).not.toHaveBeenCalled();
  current.seek(200); expect(media.position).toBe(700); expect(onError).toHaveBeenCalledOnce();
});
