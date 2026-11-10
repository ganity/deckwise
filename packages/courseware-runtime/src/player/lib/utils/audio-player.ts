/**
 * Audio Player - Audio player interface
 *
 * Handles audio playback, pause, stop, and other operations
 * Plays server-generated TTS audio URLs.
 *
 */

import { createLogger } from "../logger";
import { bindMediaTrim, type MediaTrim } from "./media-trim";

const log = createLogger("AudioPlayer");

export function isExpectedAudioPlaybackInterruption(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  if (!(error instanceof Error)) return false;
  return (
    error.name === "AbortError" ||
    /play\(\) request was interrupted by (?:a call to pause|a new load request)/i.test(
      error.message,
    )
  );
}

/**
 * Audio player implementation
 */
export class AudioPlayer {
  private audio: HTMLAudioElement | null = null;
  private primedAudio: HTMLAudioElement | null = null;
  private onEndedCallback: (() => void) | null = null;
  private onErrorCallback: ((error: Error) => void) | null = null;
  private muted: boolean = false;
  private volume: number = 1;
  private playbackRate: number = 1;
  private playbackToken: number = 0;
  private completedDurationMs = 0;
  private cleanupTrim: (() => void) | null = null;
  private cleanupEvents: (() => void) | null = null;

  /** Call from a user gesture before delayed native animations; reuse this admitted element. */
  public prime(): void {
    if (this.primedAudio) return;
    const audio = new Audio();
    this.primedAudio = audio;
    audio.src = 'data:audio/wav;base64,UklGRsQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    void audio.play().then(() => { if (this.audio !== audio) audio.pause(); }).catch(() => {
      if (this.primedAudio === audio && this.audio !== audio) this.primedAudio = null;
    });
  }

  /**
   * Play audio from URL.
   * @param audioId Audio ID
   * @param audioUrl Server-generated audio URL
   * @returns true if audio started playing, false if no audio (TTS disabled or not generated)
   */
  public async play(
    audioId: string,
    audioUrl?: string,
    trim: MediaTrim = {},
  ): Promise<boolean> {
    void audioId;
    try {
      if (!audioUrl) {
        return false;
      }
      return await this.playFromSource(audioUrl, trim);
    } catch (error) {
      // NotAllowedError: browser autoplay policy blocked — not an error, just can't play yet
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        log.info(
          "Autoplay blocked by browser policy — user interaction required",
        );
        return false;
      }
      log.error("Failed to play audio:", error);
      throw error;
    }
  }

  /**
   * Pause playback
   */
  public pause(): void {
    if (this.audio && !this.audio.paused) {
      this.audio.pause();
    }
  }

  /**
   * Stop playback
   */
  public stop(): void {
    const hadActiveAudio = this.audio !== null;
    this.resetAudio();
    if (hadActiveAudio) this.notifyEnded();
  }

  /**
   * Resume playback
   */
  public resume(): void {
    const audio = this.audio;
    const token = this.playbackToken;
    if (audio?.paused) {
      audio.playbackRate = this.playbackRate;
      audio.play().catch((error) => {
        if (this.audio !== audio || this.playbackToken !== token) return;
        if (isExpectedAudioPlaybackInterruption(error)) {
          log.debug("Audio resume was interrupted by pause or stop");
          return;
        }
        log.error("Failed to resume audio:", error);
        this.onErrorCallback?.(error instanceof Error ? error : new Error(String(error)));
      });
    }
  }

  /**
   * Get current playback status (actively playing, not paused)
   */
  public isPlaying(): boolean {
    return this.audio !== null && !this.audio.paused;
  }

  /**
   * Whether there is active audio (playing or paused, but not ended)
   * Used to decide whether to resume playback or skip to the next line
   */
  public hasActiveAudio(): boolean {
    return this.audio !== null;
  }

  /**
   * Get current playback time (milliseconds)
   */
  public getCurrentTime(): number {
    return this.audio ? this.audio.currentTime * 1000 : 0;
  }

  /**
   * Get audio duration (milliseconds)
   */
  public getDuration(): number {
    return this.audio && !isNaN(this.audio.duration)
      ? this.audio.duration * 1000
      : this.completedDurationMs;
  }

  public seek(timeMs: number): void {
    if (!this.audio) return;
    const durationMs = this.getDuration();
    this.audio.currentTime =
      Math.max(0, Math.min(timeMs, durationMs || timeMs)) / 1000;
  }

  /**
   * Set playback ended callback
   */
  public onEnded(callback: () => void): void {
    this.onEndedCallback = callback;
  }

  /**
   * Set playback error callback
   */
  public onError(callback: (error: Error) => void): void {
    this.onErrorCallback = callback;
  }

  /**
   * Set mute state (takes effect immediately on currently playing audio)
   */
  public setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.audio) {
      this.audio.volume = muted ? 0 : this.volume;
    }
  }

  /**
   * Set volume (0-1)
   */
  public setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.audio && !this.muted) {
      this.audio.volume = this.volume;
    }
  }

  /**
   * Set playback speed (takes effect immediately on currently playing audio)
   */
  public setPlaybackRate(rate: number): void {
    this.playbackRate = Math.max(0.5, Math.min(2, rate));
    if (this.audio) {
      this.audio.playbackRate = this.playbackRate;
    }
  }

  /**
   * Destroy the player
   */
  public destroy(): void {
    this.stop();
    this.primedAudio?.pause();
    this.primedAudio?.removeAttribute("src");
    this.primedAudio?.load();
    this.primedAudio = null;
    this.onEndedCallback = null;
    this.onErrorCallback = null;
  }

  private async playFromSource(src: string, trim: MediaTrim): Promise<boolean> {
    this.resetAudio();
    const token = this.playbackToken;
    const audio = this.primedAudio ?? new Audio();
    this.audio = audio;
    audio.preload = "auto";
    audio.src = src;
    if (this.muted) audio.volume = 0;
    else audio.volume = this.volume;
    audio.defaultPlaybackRate = this.playbackRate;
    audio.playbackRate = this.playbackRate;
    audio.loop = trim.loop === true;
    this.cleanupTrim = bindMediaTrim(audio, trim);

    let settled = false;
    const finalize = (reason: "ended" | "error") => {
      if (settled) return;
      settled = true;
      if (this.playbackToken !== token || this.audio !== audio) {
        log.debug("Ignored stale audio callback", { reason });
        return;
      }
      // Speech animation completion still needs the measured duration after the audio ends.
      this.completedDurationMs = Number.isFinite(audio.duration) ? audio.duration * 1000 : 0;
      this.audio = null;
      this.cleanupEvents?.();
      this.cleanupEvents = null;
      this.cleanupTrim?.();
      this.cleanupTrim = null;
      this.notifyEnded();
    };

    const ended = () => finalize("ended");
    const failed = () => {
      if (settled) return;
      settled = true;
      if (this.playbackToken !== token || this.audio !== audio) {
        log.debug("Ignored stale audio callback", { reason: "error" });
        return;
      }
      const mediaError = audio.error;
      const message =
        mediaError?.message || `Audio playback failed for source: ${src}`;
      this.audio = null;
      this.cleanupEvents?.();
      this.cleanupEvents = null;
      this.cleanupTrim?.();
      this.cleanupTrim = null;
      this.onErrorCallback?.(new Error(message));
    };
    audio.addEventListener("ended", ended, { once: true });
    audio.addEventListener("error", failed, { once: true });
    this.cleanupEvents = () => {
      audio.removeEventListener("ended", ended);
      audio.removeEventListener("error", failed);
    };

    try {
      await audio.play();
    } catch (error) {
      if (this.playbackToken !== token) return false;
      // A native error event already reported this attempt's actual decoder error.
      if (settled) return true;
      if (this.audio !== audio) return false;
      if (isExpectedAudioPlaybackInterruption(error)) {
        const remainsActive =
          this.playbackToken === token && this.audio === audio;
        log.debug("Audio play was interrupted by pause or stop", {
          remainsActive,
        });
        return remainsActive;
      }
      throw error;
    }
    if (this.playbackToken === token && this.audio === audio) {
      audio.playbackRate = this.playbackRate;
    }
    return true;
  }

  private resetAudio(): void {
    this.playbackToken += 1;
    this.completedDurationMs = 0;
    this.cleanupEvents?.();
    this.cleanupEvents = null;
    this.cleanupTrim?.();
    this.cleanupTrim = null;
    const audio = this.audio;
    this.audio = null;
    if (!audio) return;
    audio.pause();
    // An empty src starts a new invalid request in Chromium instead of unloading.
    audio.removeAttribute("src");
    audio.load();
  }

  private notifyEnded(): void {
    const callback = this.onEndedCallback;
    this.onEndedCallback = null;
    callback?.();
  }
}

/**
 * Create an audio player instance
 */
export function createAudioPlayer(): AudioPlayer {
  return new AudioPlayer();
}
