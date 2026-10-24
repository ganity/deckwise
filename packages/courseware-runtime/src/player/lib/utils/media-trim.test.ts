import { afterEach, describe, expect, it, vi } from "vitest";
import { bindMediaTrim, getMediaTrimBounds } from "./media-trim";

class Media extends EventTarget {
  duration = 84.5;
  currentTime = 0;
  playbackRate = 1;
  paused = true;
  loop = false;
  pause() {
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }
  play() {
    this.paused = false;
    this.dispatchEvent(new Event("play"));
  }
}

describe("PowerPoint media trim", () => {
  afterEach(() => vi.useRealTimers());
  it("interprets end as time removed from the tail", () => {
    expect(
      getMediaTrimBounds(84.5, { trimStartMs: 43574, trimEndMs: 38296 }),
    ).toEqual({ start: 43.574, end: 46.204 });
  });
  it("plays and completes the authored sentence, then restarts it", () => {
    vi.useFakeTimers();
    const media = new Media();
    const ended = vi.fn();
    media.addEventListener("ended", ended);
    const cleanup = bindMediaTrim(media as unknown as HTMLMediaElement, {
      trimStartMs: 43574,
      trimEndMs: 38296,
    });
    expect(media.currentTime).toBe(43.574);
    media.play();
    media.currentTime = 46.204;
    vi.advanceTimersByTime(2631);
    expect(media.paused).toBe(true);
    expect(media.currentTime).toBe(46.204);
    expect(ended).toHaveBeenCalledTimes(1);
    // Browsers round currentTime below the mathematical end by a fraction.
    media.currentTime -= 0.0000003;
    media.play();
    expect(media.currentTime).toBe(43.574);
    cleanup();
    vi.advanceTimersByTime(5000);
    expect(ended).toHaveBeenCalledTimes(1);
  });
  it("does not complete a segment while the native media clock is stopped", () => {
    vi.useFakeTimers();
    const media = new Media();
    const ended = vi.fn();
    media.addEventListener("ended", ended);
    const cleanup = bindMediaTrim(media as unknown as HTMLMediaElement, {
      trimStartMs: 43574,
      trimEndMs: 38296,
    });
    media.play();
    vi.advanceTimersByTime(6000);
    expect(media.paused).toBe(false);
    expect(media.currentTime).toBe(43.574);
    expect(ended).not.toHaveBeenCalled();
    media.currentTime = 46.204;
    media.dispatchEvent(new Event("timeupdate"));
    expect(media.paused).toBe(true);
    expect(ended).toHaveBeenCalledTimes(1);
    cleanup();
  });
  it("loops only the segment and clamps seeking", () => {
    vi.useFakeTimers();
    const media = new Media();
    media.loop = true;
    const cleanup = bindMediaTrim(media as unknown as HTMLMediaElement, {
      trimStartMs: 43574,
      trimEndMs: 38296,
      loop: true,
    });
    expect(media.loop).toBe(false);
    media.play();
    media.currentTime = 46.204;
    vi.advanceTimersByTime(2631);
    expect(media.currentTime).toBe(43.574);
    expect(media.paused).toBe(false);
    media.currentTime = 0;
    media.dispatchEvent(new Event("seeking"));
    expect(media.currentTime).toBe(43.574);
    cleanup();
    expect(media.loop).toBe(true);
  });
  it("uses native looping at EOF and clamps the rewind to the trimmed start", () => {
    vi.useFakeTimers();
    const media = new Media();
    const cleanup = bindMediaTrim(media as unknown as HTMLMediaElement, {
      trimStartMs: 80000,
      loop: true,
    });
    expect(media.loop).toBe(true);
    media.play();
    media.currentTime = 0;
    media.dispatchEvent(new Event("seeking"));
    expect(media.currentTime).toBe(80);
    expect(media.paused).toBe(false);
    media.duration = 70;
    media.dispatchEvent(new Event("durationchange"));
    expect(media.loop).toBe(false);
    cleanup();
    expect(media.loop).toBe(false);
  });
});
