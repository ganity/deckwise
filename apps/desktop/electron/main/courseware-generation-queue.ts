type Status = { state: string };
type Active = { submitting: boolean; accepted: boolean; refresh: () => Promise<Status | null> };
type Waiting = { start: () => void; reject: (error: unknown) => void };
const terminal = (task: Status) => ["ready", "failed", "cancelled", "archive_failed"].includes(task.state);

/** Submission responses with a task ID still occupy a generation slot. */
export class CoursewareGenerationQueue {
  private readonly active = new Set<Active>();
  private readonly waiting: Waiting[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private polling = false;

  run<T extends Status>(submit: () => Promise<T>, refresh: () => Promise<Status | null>, signal?: AbortSignal,
    check?: () => void | Promise<void>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener("abort", cancel);
      const waiting: Waiting = {
        reject: error => { cleanup(); reject(error); },
        start: () => {
          cleanup();
          const active: Active = { submitting: true, accepted: false, refresh };
          this.active.add(active);
          void (async () => {
            try { await check?.(); }
            catch (error) {
              this.active.delete(active);
              reject(error);
              this.drain();
              return;
            }
            try {
              const result = await submit();
              active.accepted = true;
              if (terminal(result)) this.active.delete(active);
              resolve(result);
            } catch (error) {
              // A lost response can hide a paid job; only a status read can release its slot.
              reject(error);
            } finally {
              active.submitting = false;
              this.drain();
            }
          })();
        },
      };
      const cancel = () => {
        const index = this.waiting.indexOf(waiting);
        if (index >= 0) this.waiting.splice(index, 1);
        waiting.reject(new Error("COURSEWARE_MEDIA_WAIT_CANCELLED"));
        this.drain();
      };
      if (signal?.aborted) { waiting.reject(new Error("COURSEWARE_MEDIA_WAIT_CANCELLED")); return; }
      signal?.addEventListener("abort", cancel, { once: true });
      this.waiting.push(waiting);
      this.drain();
    });
  }

  private drain(): void {
    while (this.waiting.length && this.active.size < 5) this.waiting.shift()!.start();
    if (!this.waiting.length && this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    // Poll only under queue pressure; status traffic never waits for a generation slot.
    if (this.waiting.length && !this.polling && this.timer === undefined && [...this.active].some(job => !job.submitting)) {
      this.timer = setTimeout(() => { this.timer = undefined; void this.poll(); }, 3000);
    }
  }

  private async poll(): Promise<void> {
    this.polling = true;
    const results = await Promise.allSettled([...this.active].filter(job => !job.submitting).map(async job => {
      const status = await job.refresh();
      if (status?.state === "submission_unknown" || status === null && job.accepted)
        throw new Error("COURSEWARE_MEDIA_GENERATION_STATUS_UNKNOWN");
      if (status === null || terminal(status)) this.active.delete(job);
    }));
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") {
      for (const waiting of this.waiting.splice(0)) waiting.reject(failure.reason);
    }
    this.polling = false;
    this.drain();
  }
}
