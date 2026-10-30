import type { ElementAnimationAction } from "../types/action";

export class SpeechCueScheduler {
  private frame: number | undefined;
  private lastTime = 0;
  private readonly fired = new Set<string>();

  constructor(
    private readonly cues: ElementAnimationAction[],
    private readonly getCurrentTime: () => number,
    private readonly onCue: (cue: ElementAnimationAction) => void,
    private readonly onReconcile?: (
      completed: ElementAnimationAction[],
      scope: ElementAnimationAction[],
    ) => void,
    private readonly onTime?: (timeMs: number) => void,
  ) {}

  start() {
    this.stopFrame();
    this.fired.clear();
    const currentTime = this.getCurrentTime();
    if (currentTime > 0) this.reconcile(currentTime);
    else {
      this.onReconcile?.([], this.cues);
      this.onTime?.(0);
    }
    this.lastTime = currentTime > 0 ? currentTime : -1;
    this.schedule();
  }

  pause() {
    this.onTime?.(this.getCurrentTime());
    this.stopFrame();
  }

  resume() {
    this.lastTime = this.getCurrentTime();
    this.onTime?.(this.lastTime);
    this.schedule();
  }

  stop() {
    this.stopFrame();
    this.fired.clear();
    this.lastTime = 0;
  }

  finish() {
    this.stopFrame();
    this.reconcile(Number.POSITIVE_INFINITY);
  }

  seek(time = this.getCurrentTime()) {
    this.fired.clear();
    this.reconcile(time);
    this.lastTime = time;
  }

  private reconcile(time: number) {
    if (Number.isFinite(time)) this.onTime?.(time);
    const completed: ElementAnimationAction[] = [];
    for (const cue of this.cues) {
      if (!cue.speechCue || cue.speechCue.disabled || cue.speechCue.atMs > time)
        continue;
      this.fired.add(cue.id);
      if (cue.animationType !== "attention") completed.push(cue);
    }
    this.onReconcile?.(completed, this.cues);
  }

  private schedule() {
    if (typeof requestAnimationFrame === "undefined") return;
    this.frame = requestAnimationFrame(() => {
      const currentTime = this.getCurrentTime();
      if (currentTime >= this.lastTime) {
        for (const cue of this.cues) {
          const atMs = cue.speechCue?.atMs;
          if (
            atMs === undefined ||
            cue.speechCue?.disabled ||
            this.fired.has(cue.id) ||
            atMs <= this.lastTime ||
            atMs > currentTime
          ) {
            continue;
          }
          this.fired.add(cue.id);
          this.onCue(cue);
        }
      } else {
        this.seek(currentTime);
      }
      this.lastTime = currentTime;
      this.onTime?.(currentTime);
      this.schedule();
    });
  }

  private stopFrame() {
    if (
      this.frame !== undefined &&
      typeof cancelAnimationFrame !== "undefined"
    ) {
      cancelAnimationFrame(this.frame);
    }
    this.frame = undefined;
  }
}
