export interface MediaTrim {
  /** Time removed from the original beginning/end, in milliseconds. */
  trimStartMs?: number;
  trimEndMs?: number;
  loop?: boolean;
}

export function getMediaTrimBounds(duration: number, trim: MediaTrim) {
  const positive = (value?: number) =>
    value != null && Number.isFinite(value) ? Math.max(0, value / 1000) : 0;
  const start = Math.min(positive(trim.trimStartMs), duration);
  const end = Math.max(start, duration - positive(trim.trimEndMs));
  return { start, end };
}

/** Keep the original media bytes, but play only the PowerPoint-authored segment. */
export function bindMediaTrim(
  media: HTMLMediaElement,
  trim: MediaTrim,
): () => void {
  if (!(trim.trimStartMs! > 0 || trim.trimEndMs! > 0)) return () => {};
  const originalLoop = media.loop;
  media.loop = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  const clearTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const bounds = () =>
    Number.isFinite(media.duration) && media.duration > 0
      ? getMediaTrimBounds(media.duration, trim)
      : undefined;
  const finish = () => {
    const range = bounds();
    if (!range || finished || media.paused) return;
    clearTimer();
    if (trim.loop && range.end > range.start) {
      media.currentTime = range.start;
      schedule();
    } else {
      finished = true;
      media.pause();
      media.currentTime = range.end;
      // Timeline playback waits for the same completion event as full audio.
      media.dispatchEvent(new Event("ended"));
    }
  };
  const schedule = () => {
    clearTimer();
    const range = bounds();
    if (!range || media.paused || finished) return;
    if (media.currentTime >= range.end) {
      finish();
      return;
    }
    // The timeout is only a wake-up; native media time determines completion.
    timer = setTimeout(
      schedule,
      Math.max(
        10,
        ((range.end - media.currentTime) * 1000) / (media.playbackRate || 1),
      ),
    );
  };
  const clamp = () => {
    const range = bounds();
    if (!range) return;
    // Native EOF pauses before queued trim checks; keep native looping there.
    media.loop =
      trim.loop === true && range.end === media.duration && range.end > range.start;
    if (media.currentTime < range.start) media.currentTime = range.start;
    if (media.currentTime > range.end) media.currentTime = range.end;
    schedule();
  };
  const startPlayback = () => {
    const wasFinished = finished;
    finished = false;
    const range = bounds();
    if (
      range &&
      (wasFinished ||
        media.currentTime < range.start ||
        media.currentTime >= range.end)
    ) {
      media.currentTime = range.start;
    }
    schedule();
  };
  const handlers: Record<string, () => void> = {
    loadedmetadata: clamp,
    durationchange: clamp,
    seeking: clamp,
    seeked: clamp,
    play: startPlayback,
    playing: schedule,
    timeupdate: schedule,
    ratechange: schedule,
    pause: clearTimer,
    waiting: clearTimer,
  };
  for (const [event, handler] of Object.entries(handlers))
    media.addEventListener(event, handler);
  clamp();
  return () => {
    clearTimer();
    for (const [event, handler] of Object.entries(handlers))
      media.removeEventListener(event, handler);
    media.loop = originalLoop;
  };
}
