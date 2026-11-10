import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { AgentTurnContext } from "@earendil-works/pi-agent-core";
import type { CoursewareWorkflowCheckpoint } from "@pi-desktop/shared";
import { CoursewareTurnContinuation } from "./courseware-turn-continuation.js";
import { CoursewareWorkflowError, coursewareFailureRecovery } from "./courseware-workflow-recovery.js";

const sha = "a".repeat(64), nextSha = "b".repeat(64);
const message: AgentTurnContext["message"] = { role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture", timestamp: 0,
  content: [{ type: "text", text: "Done" }], stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
const closing: AgentTurnContext = { context: { messages: [] }, newMessages: [], toolResults: [], message };

it.each([false, true])("bounds planning recovery by corrected drafts and unchanged submissions (unchanged=%s)", async unchanged => {
  const continuation = new CoursewareTurnContinuation();
  const controls = { canWait: () => true, execute: vi.fn(async () => {
    throw new CoursewareWorkflowError("COURSEWARE_WORKFLOW_REJECTED", "Body pages exceed limit: 6 > 4");
  }) };
  const write = (version: number): AgentTurnContext => ({ ...closing,
    message: { ...message, stopReason: "toolUse", content: [{ type: "toolCall", id: "write", name: "Write",
      arguments: { path: ".deckwise-ppt/scenes/chat/plan.json", content: JSON.stringify({ version }) } }] },
    toolResults: [{ role: "toolResult", toolCallId: "write", toolName: "Write", timestamp: 0, isError: false, content: [] }],
  });
  await continuation.finish(write(0), controls);
  expect(continuation.reportOnly).toBe(false);
  await continuation.finish(write(unchanged ? 0 : 1), controls);
  expect(continuation.reportOnly).toBe(false);
  const report = await continuation.finish(write(unchanged ? 0 : 2), controls);
  expect(continuation.reportOnly).toBe(true);
  expect(report).toContain(unchanged ? "repeated submission" : "two corrections");
  expect(report).toContain("6 > 4");
  await continuation.finish(closing, controls);
  expect(controls.execute).toHaveBeenCalledTimes(3);
});
function activation(): AgentTurnContext { return { ...closing, message: { ...message, stopReason: "toolUse", content: [
  { type: "toolCall", id: "activate", name: "courseware_media_context", arguments: { continueTeaching: true } } ] }, toolResults: [
  { role: "toolResult", toolCallId: "activate", toolName: "courseware_media_context", timestamp: 0, content: [], isError: false, details: { sourceSha256: sha } } ] }; }
function fixture() {
  const snapshot = { projectId: "project", teachingRevision: "t1", sourceSha256: sha, jobs: [],
    narrationReady: true, audioReady: true, teachingReady: true,
    quality: { issues: [{ pageId: "page", code: "FOCUS_MISSING", repair: "narration", repairable: true }] } };
  let checkpoint: CoursewareWorkflowCheckpoint | null = null;
  const writes: CoursewareWorkflowCheckpoint[] = [];
  const controls = { canWait: () => true, execute: vi.fn(async (_name: string, _args: Record<string, unknown>, _signal?: AbortSignal) => ({ content: [], details: snapshot })), checkpoints: {
    read: async () => ({ checkpoint, completion: { sourceSha256: snapshot.sourceSha256, teachingRevision: snapshot.teachingRevision, ready: true, issues: [] } }),
    write: async (next: CoursewareWorkflowCheckpoint, expected: number) => {
      expect(expected).toBe(checkpoint?.revision ?? 0); checkpoint = structuredClone(next); writes.push(checkpoint);
    },
  } };
  return { snapshot, controls, writes, rebind: () => { if (!checkpoint) throw new Error("Missing checkpoint");
    checkpoint = { ...checkpoint, revision: checkpoint.revision + 1, sourceSha256: nextSha }; snapshot.sourceSha256 = nextSha; } };
}

it("keeps advisory repair budgets across runtime replacement and leaves status reads inactive", async () => {
  const f = fixture();
  for (let attempt = 0; attempt < 2; attempt++) {
    const continuation = new CoursewareTurnContinuation();
    await continuation.finish(activation(), f.controls);
    expect(await continuation.finish(closing, f.controls)).toContain("non-blocking teaching diagnostics");
  }
  const idle = new CoursewareTurnContinuation();
  await idle.finish(closing, f.controls);
  expect(f.writes.at(-1)?.status).toBe("running");
  await idle.finish(activation(), f.controls);
  expect(await idle.finish(closing, f.controls)).toContain("unresolved teaching diagnostics");
  expect(f.writes.at(-1)?.status).toBe("completed");
  expect(Object.values(f.writes.at(-1)!.repairAttempts)).toEqual([2]);
});

it("continues only a Host-verified native source transition and rejects unrelated replacements", async () => {
  for (const verified of [true, false]) {
    const f = fixture(), continuation = new CoursewareTurnContinuation();
    await continuation.finish(activation(), f.controls);
    await continuation.finish(closing, f.controls);
    if (verified) f.rebind(); else f.snapshot.sourceSha256 = nextSha;
    if (verified) expect(await continuation.finish(closing, f.controls)).toContain(nextSha);
    else expect(await continuation.finish(closing, f.controls)).toContain("COURSEWARE_CONFLICT");
    expect(f.writes.at(-1)?.sourceSha256).toBe(verified ? nextSha : sha);
  }
});

it.each(["legacy budget", "checkpoint capacity"])("stops advisory repair at %s without an invalid checkpoint", async limit => {
  const f = fixture(), continuation = new CoursewareTurnContinuation();
  const legacy = createHash("sha256").update(JSON.stringify([["page", "FOCUS_MISSING", "narration"]])).digest("hex");
  if (limit === "checkpoint capacity") f.snapshot.quality.issues = Array.from({ length: 101 }, (_, index) => ({
    pageId: `page-${index}`, code: "FOCUS_MISSING", repair: "narration", repairable: true,
  }));
  let checkpoint: CoursewareWorkflowCheckpoint | null = limit === "legacy budget" ? {
    revision: 1, projectId: "project", sourceSha256: sha, status: "running", repairAttempts: { [legacy]: 2 }, lastResume: null,
  } : null;
  const controls = { ...f.controls, checkpoints: {
    read: async () => ({ ...(await f.controls.checkpoints.read()), checkpoint }),
    write: async (next: CoursewareWorkflowCheckpoint, expected: number) => {
      expect(expected).toBe(checkpoint?.revision ?? 0);
      checkpoint = structuredClone(next); f.writes.push(checkpoint);
    },
  } };
  await continuation.finish(activation(), controls);
  expect(await continuation.finish(closing, controls)).toContain("unresolved teaching diagnostics");
  expect(f.writes.at(-1)?.status).toBe("completed");
  expect(Object.keys(f.writes.at(-1)!.repairAttempts).length).toBeLessThanOrEqual(100);
  expect(f.controls.execute.mock.calls.every(([name]) => name === "courseware_media_context")).toBe(true);
});

it("retains the complete-course goal after a tool failure and checks actual saved state", async () => {
  const f = fixture(), continuation = new CoursewareTurnContinuation();
  await continuation.finish(activation(), f.controls);
  const failed: AgentTurnContext = { ...closing, toolResults: [{ role: "toolResult", toolCallId: "failed", toolName: "courseware_narration_propose",
    timestamp: 0, content: [{ type: "text", text: "Provider unavailable" }], isError: true }] };
  expect(await continuation.finish(failed, f.controls)).toContain("non-blocking teaching diagnostics");
  expect(f.controls.execute).toHaveBeenCalled();
});

it("repairs a missing approved activity through the protected operation and rechecks acceptance", async () => {
  const f = fixture(), continuation = new CoursewareTurnContinuation();
  f.snapshot.quality.issues = [];
  let repaired = false;
  const execute = vi.fn(async (name: string) => {
    if (name === "courseware_narration_propose") { repaired = true; return { content: [], details: { saved: true } }; }
    return { content: [], details: f.snapshot };
  });
  const controls = { ...f.controls, execute, checkpoints: { ...f.controls.checkpoints,
    read: async () => ({ ...(await f.controls.checkpoints.read()), completion: { ready: repaired, sourceSha256: sha, teachingRevision: "t1",
      issues: repaired ? [] : [{ pageId: "page", pageNumber: 1, code: "QUESTION_MISSING", repair: "narration", repairable: true }] } }),
  } };
  await continuation.finish(activation(), controls);
  expect(await continuation.finish(closing, controls)).toContain("completed");
  expect(continuation.reportOnly).toBe(true);
  expect(execute).toHaveBeenCalledWith("courseware_narration_propose", expect.objectContaining({ pageNumbers: [1], repairRequiredTeaching: true }), undefined);
  expect(f.writes.at(-1)?.status).toBe("completed");
});

it("retries a transient original-job read twice, without preparing another paid job", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture(), continuation = new CoursewareTurnContinuation();
    await continuation.finish(activation(), f.controls);
    const execute = vi.fn().mockRejectedValueOnce(new CoursewareWorkflowError("TASK_STATUS_UNAVAILABLE", "Unavailable"))
      .mockRejectedValueOnce(new CoursewareWorkflowError("TASK_STATUS_UNAVAILABLE", "Unavailable"))
      .mockResolvedValue({ content: [], details: f.snapshot });
    const running = continuation.finish(closing, { ...f.controls, execute });
    await vi.advanceTimersByTimeAsync(3000);
    expect(await running).toContain("non-blocking teaching diagnostics");
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls.every(([name]) => name === "courseware_media_context")).toBe(true);
  } finally { vi.useRealTimers(); }
});

it.each([false, true])("rechecks actual state after a missing repair receipt (saved=%s)", async actuallySaved => {
  const f = fixture(), continuation = new CoursewareTurnContinuation();
  f.snapshot.quality.issues = [];
  let calls = 0;
  const execute = vi.fn(async (name: string) => {
    if (name === "courseware_narration_propose") {
      calls++;
      return { content: [], details: { saved: false, error: "Save receipt missing" } };
    }
    return { content: [], details: f.snapshot };
  });
  const controls = { ...f.controls, execute, checkpoints: { ...f.controls.checkpoints,
    read: async () => ({ ...(await f.controls.checkpoints.read()), completion: {
      ready: actuallySaved && calls > 0, sourceSha256: sha, teachingRevision: "t1",
      issues: actuallySaved && calls > 0 ? [] : [{ pageId: "page", pageNumber: 1, code: "QUESTION_MISSING", repair: "narration", repairable: true }],
    } }),
  } };
  await continuation.finish(activation(), controls);
  const result = await continuation.finish(closing, controls);
  expect(calls).toBe(1);
  if (actuallySaved) {
    expect(result).toContain("completed");
    expect(continuation.reportOnly).toBe(true);
    expect(f.writes.at(-1)?.status).toBe("completed");
  } else {
    expect(result).toContain("Required teaching repair failed");
    expect(result).toContain("Save receipt missing");
    expect(f.writes.at(-1)?.status).toBe("blocked");
    const restarted = new CoursewareTurnContinuation();
    await restarted.finish(activation(), controls);
    expect(await restarted.finish(closing, controls)).toContain("Required teaching repair failed");
    expect(calls).toBe(2);
    const exhausted = new CoursewareTurnContinuation();
    await exhausted.finish(activation(), controls);
    expect(await exhausted.finish(closing, controls)).toContain("two repairs");
    expect(calls).toBe(2);
  }
});

it("Stop during retry backoff prevents further reads and checkpoint writes", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture(), continuation = new CoursewareTurnContinuation();
    await continuation.finish(activation(), f.controls);
    const initializedWrites = f.writes.length;
    let active = true;
    const execute = vi.fn().mockRejectedValue(new CoursewareWorkflowError("TASK_STATUS_UNAVAILABLE", "Unavailable"));
    const running = continuation.finish(closing, { ...f.controls, execute, canWait: () => active }).catch(e => e);
    await vi.advanceTimersByTimeAsync(100); active = false;
    await vi.advanceTimersByTimeAsync(5000); await running;
    expect(execute).toHaveBeenCalledTimes(1);
    expect(f.writes).toHaveLength(initializedWrites);
  } finally { vi.useRealTimers(); }
});

it.each(["COURSEWARE_SUBMISSION_UNKNOWN", "COURSEWARE_MEDIA_GENERATION_STATUS_UNKNOWN", "INVALID_PARAMS", "TOOL_TURN_CANCELLED", "UNRECOGNIZED_FAILURE"])(
  "never blindly retries %s", async code => {
    const f = fixture(), continuation = new CoursewareTurnContinuation();
    await continuation.finish(activation(), f.controls);
    const execute = vi.fn().mockRejectedValue(new CoursewareWorkflowError(code, code));
    await expect(continuation.finish(closing, { ...f.controls, execute })).rejects.toThrow();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(coursewareFailureRecovery(new CoursewareWorkflowError(code, code))).not.toBe("retry-read");
  });


it("keeps monotonic repair budgets when unchanged work transitions to a blocked report", async () => {
  const f = fixture(), continuation = new CoursewareTurnContinuation();
  f.snapshot.narrationReady = false;
  const controls = { ...f.controls, checkpoints: { ...f.controls.checkpoints,
    read: async () => ({ ...(await f.controls.checkpoints.read()), completion: { ready: false, sourceSha256: sha, teachingRevision: "t1",
      issues: [{ pageId: "page", pageNumber: 1, code: "NARRATION_MISSING", repair: "narration", repairable: true }] } }),
    write: async (next: CoursewareWorkflowCheckpoint, revision: number) => {
      for (const [key, count] of Object.entries(f.writes.at(-1)?.repairAttempts ?? {}))
        expect(next.repairAttempts[key]).toBeGreaterThanOrEqual(count);
      await f.controls.checkpoints.write(next, revision);
    },
  } };
  await continuation.finish(activation(), controls);
  expect(await continuation.finish(closing, controls)).toContain("unfinished");
  expect(await continuation.finish(closing, controls)).toContain("no saved progress");
  expect(f.writes.at(-1)?.status).toBe("blocked");
  expect(Object.values(f.writes.at(-1)!.repairAttempts)).toEqual([2]);
  expect(await continuation.finish(closing, controls)).toBeUndefined();
});
