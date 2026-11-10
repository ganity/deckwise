import { afterEach, expect, it, vi } from 'vitest';
import { createTeachingTimelinePreview } from './teaching-timeline-preview';

class LocalAudio extends EventTarget {
  src = '';
  paused = true;
  currentTime = 0;
  duration = 1;
  async play() { this.paused = false; }
  pause() { this.paused = true; }
  removeAttribute() { this.src = ''; }
  load() {}
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('finishes real audio-backed speech, its end-triggered animation, then the next speech', async () => {
  vi.useFakeTimers();
  const clips: LocalAudio[] = [];
  vi.stubGlobal('Audio', class extends LocalAudio {
    constructor() { super(); clips.push(this); }
  });
  const next = vi.fn(async () => {}), onError = vi.fn(), onComplete = vi.fn();
  const preview = createTeachingTimelinePreview({
    pageId: 'page',
    nodes: ['first', 'second'].map(id => ({ id, type: 'speech', text: id, audioUrl: `blob:${id}` })),
    native: { sourceSha256: 'a'.repeat(64), stepCount: 2, next, pause() {}, resume() {} },
    speechMotions: [
      { actionId: 'first', stepIndex: 0, atMs: 0, endMs: 600, trigger: { version: 1, kind: 'start' } },
      { actionId: 'first', stepIndex: 1, atMs: 0, endMs: 600, trigger: { version: 1, kind: 'end' } },
    ],
    onMode() {}, onProgress() {}, onNode() {}, onError, onComplete,
  });
  try {
    preview.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(next).toHaveBeenCalledWith(0);
    expect(next).not.toHaveBeenCalledWith(1);
    clips[0]!.currentTime = 1;
    clips[0]!.dispatchEvent(new Event('ended'));
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(1);
    expect(clips).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(600);
    expect(clips).toHaveLength(2);
    expect(clips[1]!.src).toBe('blob:second');
    clips[1]!.dispatchEvent(new Event('ended'));
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledOnce();
  } finally {
    preview.dispose();
  }
});
