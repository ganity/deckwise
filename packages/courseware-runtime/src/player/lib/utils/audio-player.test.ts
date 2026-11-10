import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AudioPlayer,
  isExpectedAudioPlaybackInterruption,
} from "./audio-player";


class FakeAudio {
  public preload = "";
  public src = "";
  public volume = 1;
  public defaultPlaybackRate = 1;
  public playbackRate = 1;
  public paused = true;
  public currentTime = 0;
  public duration = 1;
  public error: { message?: string } | null = null;
  public playSpy = vi.fn();

  private listeners = new Map<string, Array<() => void>>();

  addEventListener(event: string, listener: () => void) {
    const current = this.listeners.get(event) ?? [];
    current.push(listener);
    this.listeners.set(event, current);
  }

  removeEventListener(event: string, listener: () => void) {
    this.listeners.set(event, (this.listeners.get(event) ?? []).filter(value => value !== listener));
  }

  removeAttribute(name: string) { if (name === "src") this.src = ""; }
  load() {}
  listenerCount(event: string) { return this.listeners.get(event)?.length ?? 0; }

  async play() {
    this.playSpy(this.src);
    this.paused = false;
  }

  pause() {
    this.paused = true;
  }

  emit(event: "ended" | "error") {
    for (const listener of this.listeners.get(event) ?? []) {
      listener();
    }
  }
}

describe("AudioPlayer", () => {
  const originalAudio = globalThis.Audio;

  afterEach(() => {
    globalThis.Audio = originalAudio;
    vi.restoreAllMocks();
  });

  it("reuses the element admitted by a user gesture after delayed animations and releases it on dispose", async () => {
    const created: FakeAudio[] = [];
    globalThis.Audio = class {
      constructor() { const audio = new FakeAudio(); created.push(audio); return audio as unknown as HTMLAudioElement; }
    } as unknown as typeof Audio;
    const player = new AudioPlayer();
    player.prime(); await Promise.resolve();
    await player.play('first', 'blob:first');
    player.stop();
    await player.play('second', 'blob:second');
    expect(created).toHaveLength(1);
    expect(created[0].src).toBe('blob:second');
    expect(created[0].paused).toBe(false);
    player.destroy();
    expect(created[0].paused).toBe(true);
    expect(created[0].src).toBe('');
    expect(created[0].listenerCount('ended')).toBe(0);
  });

  it("ignores stale ended/error events from a previous audio element", async () => {
    const created: FakeAudio[] = [];
    class FakeAudioCtor extends FakeAudio {}
    globalThis.Audio = class {
      constructor() {
        const audio = new FakeAudioCtor();
        created.push(audio);
        return audio as unknown as HTMLAudioElement;
      }
    } as unknown as typeof Audio;


    const player = new AudioPlayer();
    const onEnded = vi.fn();
    const onError = vi.fn();
    player.onEnded(onEnded);
    player.onError(onError);

    await player.play("first", "https://example.com/first.mp3");
    const first = created[0]!;

    await player.play("second", "https://example.com/second.mp3");
    const second = created[1]!;

    first.error = { message: "stale failure" };
    first.emit("error");
    first.emit("ended");

    expect(onError).not.toHaveBeenCalled();
    expect(onEnded).not.toHaveBeenCalled();

    second.emit("ended");
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it("retains measured duration for speech animation completion until the next playback or stop", async () => {
    const created: FakeAudio[] = [];
    globalThis.Audio = class {
      constructor() { const audio = new FakeAudio(); created.push(audio); return audio as unknown as HTMLAudioElement; }
    } as unknown as typeof Audio;
    const player = new AudioPlayer();
    const completedDurations: number[] = [];
    player.onEnded(() => completedDurations.push(player.getDuration()));
    await player.play('first', 'blob:first');
    created[0].duration = 2.4;
    created[0].emit('ended');
    expect(completedDurations).toEqual([2400]);
    expect(player.hasActiveAudio()).toBe(false);
    expect(player.getDuration()).toBe(2400);
    await player.play('second', 'blob:second');
    expect(player.getDuration()).toBe(1000);
    player.stop();
    expect(player.getDuration()).toBe(0);
  });

  it("does not fall back to IndexedDB cached audio when no URL is available", async () => {
    const created: FakeAudio[] = [];
    globalThis.Audio = class {
      constructor() {
        const audio = new FakeAudio();
        created.push(audio);
        return audio as unknown as HTMLAudioElement;
      }
    } as unknown as typeof Audio;

    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:cached-audio");


    const player = new AudioPlayer();
    const audioStarted = await player.play("cached-audio");

    expect(audioStarted).toBe(false);

    expect(createObjectURL).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });

  it("treats stop as a terminal playback event", async () => {
    globalThis.Audio = class {
      constructor() {
        return new FakeAudio() as unknown as HTMLAudioElement;
      }
    } as unknown as typeof Audio;

    const player = new AudioPlayer();
    const onEnded = vi.fn();
    player.onEnded(onEnded);

    await player.play("audio", "https://example.com/audio.mp3");
    player.stop();

    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(player.hasActiveAudio()).toBe(false);
  });

  it("treats play interrupted by pause as an active paused request", async () => {
    let rejectPlay: ((reason: Error) => void) | undefined;
    class PendingAudio extends FakeAudio {
      override play() {
        this.playSpy(this.src);
        this.paused = false;
        return new Promise<void>((_resolve, reject) => {
          rejectPlay = reject;
        });
      }
    }
    globalThis.Audio = class {
      constructor() {
        return new PendingAudio() as unknown as HTMLAudioElement;
      }
    } as unknown as typeof Audio;

    const player = new AudioPlayer();
    const pending = player.play("audio", "https://example.com/audio.mp3");
    await Promise.resolve();
    player.pause();
    rejectPlay?.(
      Object.assign(
        new Error("The play() request was interrupted by a call to pause()."),
        { name: "AbortError" },
      ),
    );

    await expect(pending).resolves.toBe(true);
    expect(player.hasActiveAudio()).toBe(true);
  });

  it("treats play interrupted by stop as a stale cancelled request", async () => {
    let rejectPlay: ((reason: Error) => void) | undefined;
    class PendingAudio extends FakeAudio {
      override play() {
        this.playSpy(this.src);
        this.paused = false;
        return new Promise<void>((_resolve, reject) => {
          rejectPlay = reject;
        });
      }
    }
    globalThis.Audio = class {
      constructor() {
        return new PendingAudio() as unknown as HTMLAudioElement;
      }
    } as unknown as typeof Audio;

    const player = new AudioPlayer();
    const pending = player.play("audio", "https://example.com/audio.mp3");
    await Promise.resolve();
    player.stop();
    rejectPlay?.(
      Object.assign(
        new Error("The play() request was interrupted by a new load request."),
        { name: "AbortError" },
      ),
    );

    await expect(pending).resolves.toBe(false);
    expect(player.hasActiveAudio()).toBe(false);
  });

  it("recognizes only expected browser play/pause cancellation errors", () => {
    expect(
      isExpectedAudioPlaybackInterruption(
        Object.assign(new Error("interrupted"), { name: "AbortError" }),
      ),
    ).toBe(true);
    expect(
      isExpectedAudioPlaybackInterruption(new Error("decode failed")),
    ).toBe(false);
  });

  it("ignores a rejected resume from audio replaced before the promise settles", async () => {
    const audio = new FakeAudio();
    globalThis.Audio = vi.fn(function () {
      return audio as unknown as HTMLAudioElement;
    }) as unknown as typeof Audio;
    const player = new AudioPlayer();
    await player.play("first", "blob:first");
    player.pause();
    let rejectResume!: (error: Error) => void;
    vi.spyOn(audio, "play").mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => { rejectResume = reject; }),
    );
    player.resume();
    await player.play("second", "blob:second");
    const currentError = vi.fn();
    player.onError(currentError);
    rejectResume(new DOMException("old source failed", "NotSupportedError"));
    await Promise.resolve();
    expect(currentError).not.toHaveBeenCalled();
    expect(player.isPlaying()).toBe(true);
    player.destroy();
  });

  it("still reports a current resume failure for retry", async () => {
    const audio = new FakeAudio();
    globalThis.Audio = vi.fn(function () {
      return audio as unknown as HTMLAudioElement;
    }) as unknown as typeof Audio;
    const player = new AudioPlayer();
    await player.play("first", "blob:first");
    player.pause();
    const error = new DOMException("source failed", "NotSupportedError");
    vi.spyOn(audio, "play").mockRejectedValueOnce(error);
    const currentError = vi.fn();
    player.onError(currentError);
    player.resume();
    await Promise.resolve();
    expect(currentError).toHaveBeenCalledWith(error);
    player.destroy();
  });

  it("detaches replaced audio listeners before releasing the source without an empty src assignment", async () => {
    const created: FakeAudio[] = [];
    globalThis.Audio = vi.fn(function () {
      const audio = new FakeAudio(); created.push(audio);
      return audio as unknown as HTMLAudioElement;
    }) as unknown as typeof Audio;
    const player = new AudioPlayer();
    const failed = vi.fn(); player.onError(failed);
    await player.play("first", "blob:first");
    const previous = created[0]!;
    const release = vi.spyOn(previous, "removeAttribute").mockImplementation(() => {
      expect(previous.listenerCount("error")).toBe(0);
      expect(previous.listenerCount("ended")).toBe(0);
    });
    const load = vi.spyOn(previous, "load");
    await player.play("second", "blob:second");
    expect(release).toHaveBeenCalledWith("src");
    expect(load).toHaveBeenCalledOnce();
    previous.error = { message: "old source failure" }; previous.emit("error");
    expect(failed).not.toHaveBeenCalled();
    const current = created[1]!;
    current.error = { message: "current decode failed" }; current.emit("error");
    expect(failed).toHaveBeenCalledWith(new Error("current decode failed"));
    player.destroy();
  });

  it("does not reject a newer playback when an old native play promise fails after replacement", async () => {
    let rejectOld!: (error: Error) => void;
    const first = new FakeAudio(), second = new FakeAudio();
    vi.spyOn(first, "play").mockImplementation(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
    globalThis.Audio = vi.fn().mockImplementationOnce(function () { return first; })
      .mockImplementationOnce(function () { return second; }) as unknown as typeof Audio;
    const player = new AudioPlayer();
    const failed = vi.fn(); player.onError(failed);
    const pending = player.play("old", "blob:old");
    await player.play("new", "blob:new");
    rejectOld(new DOMException("old decode failure", "NotSupportedError"));
    await expect(pending).resolves.toBe(false);
    expect(failed).not.toHaveBeenCalled();
    expect(player.isPlaying()).toBe(true);
    player.destroy();
  });

  it("keeps the actual native decoder failure when play also rejects the same attempt", async () => {
    const audio = new FakeAudio();
    globalThis.Audio = vi.fn(function () { return audio; }) as unknown as typeof Audio;
    const failure = new Error("native decoder failed");
    vi.spyOn(audio, "play").mockImplementation(async () => {
      audio.error = { message: failure.message }; audio.emit("error"); throw failure;
    });
    const player = new AudioPlayer(); const failed = vi.fn(); player.onError(failed);
    await expect(player.play("voice", "blob:bad-audio")).resolves.toBe(true);
    expect(failed).toHaveBeenCalledExactlyOnceWith(failure);
    expect(player.hasActiveAudio()).toBe(false);
    player.destroy();
  });
});
