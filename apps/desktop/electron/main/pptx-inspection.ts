import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { PptxInspection, PptxInspectionWarning } from "@pi-desktop/shared";

type Host = { call<T>(method: string, params: unknown): Promise<T> };
type WorkerStatus = {
  status: "RUNNING" | "SUCCEEDED" | "FAILED";
  message?: string;
  summary?: { sourceSha256: string; pages: number; warningCount: number; errorCount: number; warnings: PptxInspectionWarning[] };
};

/** Only the editor supplies a saved revision. Renderer input never selects files. */
export class PptxInspector {
  private current: { state: PptxInspection; abort: AbortController } | null = null;

  start(host: Host, snapshot: { path: string; revision: number; sha256: string }): PptxInspection {
    if (this.current?.state.status === "RUNNING") throw new Error("An inspection is already running");
    const current = {
      state: { checkId: randomUUID(), revision: snapshot.revision, sourceSha256: snapshot.sha256, status: "RUNNING" } as PptxInspection,
      abort: new AbortController(),
    };
    this.current = current;
    void this.run(host, snapshot, current);
    return current.state;
  }

  status(payload: unknown): PptxInspection {
    if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
        Object.keys(payload).length !== 1 || !("checkId" in payload) ||
        typeof payload.checkId !== "string" || payload.checkId !== this.current?.state.checkId) {
      throw new Error("Unknown inspection");
    }
    return this.current.state;
  }

  cancel(payload: unknown): PptxInspection {
    this.status(payload);
    this.stop();
    return this.current!.state;
  }

  stop(): void {
    this.current?.abort.abort();
  }

  private async run(host: Host, snapshot: { path: string; sha256: string }, current: NonNullable<PptxInspector["current"]>) {
    let jobId: string | undefined;
    let terminal = false;
    let canceled = false;
    let result: Partial<PptxInspection> = {};
    try {
      const job = await host.call<{ jobId: string }>("courseware.parseStart", { path: snapshot.path });
      jobId = job.jobId;
      let status: WorkerStatus;
      do {
        if (current.abort.signal.aborted && !canceled) {
          await host.call("courseware.parseCancel", { jobId });
          canceled = true;
        }
        status = await host.call<WorkerStatus>("courseware.parseStatus", { jobId });
        if (status.status === "RUNNING") await delay(100);
      } while (status.status === "RUNNING");
      terminal = true;
      if (status.status !== "SUCCEEDED") throw new Error(status.message || "PPTX inspection failed");
      if (status.summary?.sourceSha256 !== snapshot.sha256) throw new Error("Saved revision hash changed; inspect again");
      if (!Number.isSafeInteger(status.summary.warningCount) || status.summary.warningCount < 0 ||
          !Number.isSafeInteger(status.summary.errorCount) || status.summary.errorCount < 0 ||
          status.summary.errorCount > status.summary.warningCount) throw new Error("Invalid inspection diagnostic counts; update the Host and inspect again");
      result = { status: "SUCCEEDED", pages: status.summary.pages, warningCount: status.summary.warningCount, errorCount: status.summary.errorCount, warnings: status.summary.warnings };
    } catch (error) {
      result = { status: "FAILED", message: error instanceof Error ? error.message : String(error) };
    } finally {
      if (jobId) {
        try {
          if (!terminal) {
            await host.call("courseware.parseCancel", { jobId });
            while ((await host.call<WorkerStatus>("courseware.parseStatus", { jobId })).status === "RUNNING") await delay(100);
          }
          await host.call("courseware.parseRelease", { jobId });
        } catch (error) {
          result = { status: "FAILED", message: `Inspection cleanup failed: ${String(error)}` };
        }
      }
      if (current.abort.signal.aborted && result.status !== "FAILED") result = { status: "CANCELED" };
      // A canceled worker normally reports FAILED; cleanup errors must remain visible.
      if (current.abort.signal.aborted && canceled && result.status === "FAILED" &&
          "message" in result && result.message === "PPTX parsing canceled") result = { status: "CANCELED" };
      current.state = { ...current.state, ...result } as PptxInspection;
    }
  }
}
