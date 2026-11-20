import { expect, it, vi } from "vitest";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { fixture, sha256 } from "./courseware-turn-continuation.fixture.js";

it("keeps authorized whole-scene continuation active after the pipeline result", async () => {
  vi.useFakeTimers();
  const f = fixture("visualMaster", "courseware_scene_image_refresh");
  Object.assign(f.saved, { imagePipeline: true, completed: true });
  try {
    const running = f.runtime.prompt("The cover style is approved; finish all scene images and editable PPTX.", "user", "turn");
    await vi.advanceTimersByTimeAsync(6000);
    await running;
    expect(f.calls.some(call => call.name === "courseware_scene_image_refresh" && call.args.generateRemaining === true)).toBe(true);
    expect(f.saved.generated).toBe(true);
    expect(f.calls.filter(call => call.name === "courseware_scene_compile")).toHaveLength(1);
  } finally { await f.runtime.dispose(); vi.useRealTimers(); }
});

it("reconciles only explicitly retried images and preserves unrelated failed pages", async () => {
  vi.useFakeTimers();
  const f = fixture("cleanPlate", "courseware_scene_image_refresh");
  f.saved.explicitRetry = true;
  try {
    const running = f.runtime.prompt("Retry only the failed layer split on page 1.", "user", "turn");
    await vi.advanceTimersByTimeAsync(6000);
    f.saved.completed = true;
    await vi.advanceTimersByTimeAsync(3000);
    await running;
    const refreshes = f.calls.filter(call => call.name === "courseware_scene_image_refresh");
    expect(refreshes.length).toBeGreaterThan(1);
    expect(refreshes.every(call => call.args.intentId === "decomposition")).toBe(true);
    expect(f.saved.generated).toBe(false);
    expect(f.calls.some(call => /compile|prepare|narration/u.test(call.name))).toBe(false);
    expect(f.toolCounts.at(-1)).toBe(f.toolCounts.at(-2));
  } finally { await f.runtime.dispose(); vi.useRealTimers(); }
});

it("explicit media retry waits for its job without starting missing teaching", async () => {
  vi.useFakeTimers();
  const f = fixture("cleanPlate", "courseware_media_refresh");
  Object.assign(f.saved, { explicitRetry: true, generated: true, narrationMissing: true, audioMissing: true });
  try {
    const running = f.runtime.prompt("Retry the failed TTS only.", "user", "turn");
    await vi.advanceTimersByTimeAsync(6000);
    f.saved.audioCompleted = true;
    await vi.advanceTimersByTimeAsync(3000);
    await running;
    expect(f.calls.some(call => /prepare|narration/u.test(call.name))).toBe(false);
    expect(f.calls.filter(call => call.name === "courseware_media_refresh").length).toBeGreaterThan(1);
  } finally { await f.runtime.dispose(); vi.useRealTimers(); }
});

it("queues later retry input outside a terminal reporting turn and resets the guard on the next turn", async () => {
  const f = fixture();
  f.saved.failed = true;
  const stream = f.agent.streamFunction!;
  let rejected = false;
  f.agent.streamFunction = (model, context, options) => {
    if (f.requests() === 3) {
      expect(() => f.runtime.steeringContext("turn")).toThrow("no longer accepting input");
      rejected = true;
    }
    return stream(model, context, options);
  };
  try {
    await f.runtime.prompt("Finish the courseware.", "user", "turn");
    expect(rejected).toBe(true);
    expect(f.toolCounts.at(-1)).toBe(f.toolCounts.at(-2));
    f.agent.streamFunction = stream;
    await f.runtime.prompt("Retry the failed pages with new requests.", "retry-user", "retry-turn");
    expect(f.toolCounts.at(-1)).toBeGreaterThan(0);
  } finally { await f.runtime.dispose(); }
});

it("preserves a PPTX-only request without starting narration or media", async () => {
  const f = fixture();
  Object.assign(f.saved, { completed: true, narrationMissing: true, audioMissing: true });
  try {
    await f.runtime.prompt("Only produce the editable PPTX, without narration or audio.", "user", "turn");
    expect(f.saved.generated).toBe(true);
    expect(f.calls.some(c => /^courseware_(?:media|narration)_/u.test(c.name))).toBe(false);
  } finally { await f.runtime.dispose(); }
});

it.each([
  { complete: false, omitContinuation: false },
  { complete: true, omitContinuation: false },
  { complete: true, omitContinuation: true },
])("continues ordinary course export unless explicitly PPTX-only: %j", async ({ complete, omitContinuation }) => {
  vi.useFakeTimers();
  const f = fixture("cleanPlate", "courseware_presentation_adopt");
  Object.assign(f.saved, { fullMedia: complete, omitContinuation, narrationMissing: true, audioMissing: true });
  try {
    const running = f.runtime.prompt(complete ? "Finish this complete teaching course." : "Only export the PPTX.", "user", "turn");
    await vi.advanceTimersByTimeAsync(31_000);
    expect(f.saved.generated).toBe(true);
    if (complete) {
      expect(f.saved.narrationMissing).toBe(false);
      expect(f.saved.mediaStarted).toBe(true);
      expect(f.agent.state.isStreaming).toBe(true);
      f.saved.audioCompleted = true;
      await vi.advanceTimersByTimeAsync(3000);
    }
    await running;
    expect(f.calls.some(c => c.name === "courseware_scene_compile")).toBe(false);
    expect(f.calls.some(c => c.name === "courseware_media_prepare")).toBe(complete);
    expect(f.events.filter(e => e.event.type === "agent_end")).toHaveLength(1);
  } finally { await f.runtime.dispose(); vi.useRealTimers(); }
});

it("ends after one reporting pass and prevents the model restarting blocked generation", async () => {
  vi.useFakeTimers();
  const f = fixture("cleanPlate", "courseware_media_context");
  Object.assign(f.saved, { generated: true, fullMedia: true, mediaStarted: true, audioMissing: true,
    mediaUnknown: true, retryAfterBlock: true });
  try {
    const running = f.runtime.prompt("Finish the complete course", "user", "turn");
    await vi.advanceTimersByTimeAsync(10_000);
    await running;
    expect(f.calls.filter(call => call.name === "courseware_media_prepare")).toHaveLength(0);
    expect(f.calls.filter(call => call.name === "courseware_media_refresh")).toHaveLength(1);
    expect(f.requests()).toBe(5);
  } finally { await f.runtime.dispose(); vi.useRealTimers(); }
});

it("returns completed acceptance with a blocked final tool instead of implying missing question media", async () => {
  const f = fixture("cleanPlate", "courseware_media_context");
  Object.assign(f.saved, { generated: true, fullMedia: true, retryAfterBlock: true });
  try {
    await f.runtime.prompt("Finish the complete saved course", "user", "turn");
    expect(f.checkpoint()).toMatchObject({ status: "completed" });
    expect(f.calls.filter(call => call.name === "courseware_media_prepare")).toHaveLength(0);
    const blocked = f.events.find(e => e.event.type === "tool_end" && e.event.isError);
    const text = JSON.stringify(blocked);
    expect(text).toContain("does not undo saved assets");
    expect(text).toContain('assessmentMedia');
    expect(text).toContain('\\"ready\\":true');
    expect(f.requests()).toBe(5);
  } finally { await f.runtime.dispose(); }
});

it("keeps the compiled course active through saved narration and actual TTS adoption", async () => {
  vi.useFakeTimers();
  const f = fixture();
  Object.assign(f.saved, { completed: true, fullMedia: true, narrationMissing: true, audioMissing: true });
  try {
    const running = f.runtime.prompt("Finish this complete narrated lesson.", "user", "turn");
    await vi.advanceTimersByTimeAsync(31_000);
    expect(f.saved.generated).toBe(true);
    expect(f.saved.narrationMissing).toBe(false);
    expect(f.saved.mediaStarted).toBe(true);
    expect(f.agent.state.isStreaming).toBe(true);
    expect(f.events.filter(e => e.event.type === "agent_end")).toHaveLength(0);
    f.saved.audioCompleted = true;
    await vi.advanceTimersByTimeAsync(3000);
    await running;
    expect(f.saved.audioMissing).toBe(false);
    expect(f.events.filter(e => e.event.type === "agent_end")).toHaveLength(1);
    expect(f.calls.filter(c => c.name === "courseware_media_refresh").every(c => c.args.intentId === "original-tts")).toBe(true);
  } finally { await f.runtime.dispose(); vi.useRealTimers(); }
});

it.each([false, true])('keeps the complete course active until original assessment media is archived and adopted (speech=%s)', async assessmentTts => {
  vi.useFakeTimers();
  const f = fixture('cleanPlate', 'courseware_media_context');
  Object.assign(f.saved, { generated: true, fullMedia: true, assessmentMissing: true, assessmentTts });
  try {
    const running = f.runtime.prompt('Finish the complete saved teaching course.', 'user', 'turn');
    await vi.waitFor(() => expect(f.calls.some(call => call.name === 'courseware_media_assessments' && call.args.mode === 'refresh')).toBe(true));
    const refresh = f.calls.find(call => call.name === 'courseware_media_assessments' && call.args.mode === 'refresh')!;
    expect(refresh.args.originalKey).toBe(assessmentTts ? 'maic-' + 'a'.repeat(64) : undefined);
    expect(f.events.filter(event => event.event.type === 'agent_end')).toHaveLength(0);
    f.saved.assessmentCompleted = true;
    await vi.advanceTimersByTimeAsync(3000);
    await running;
    expect(f.saved.assessmentMissing).toBe(false);
    expect(f.calls.filter(call => call.name === 'courseware_media_assessments' && call.args.mode === 'prepare')).toHaveLength(1);
    expect(f.events.filter(event => event.event.type === 'agent_end')).toHaveLength(1);
  } finally { await f.runtime.dispose(); vi.useRealTimers(); }
});

it.each([false, true])('reconciles an assessment refresh failure without a local preparation error (persistent=%s)', async persistent => {
  vi.useFakeTimers();
  const f = fixture('cleanPlate', 'courseware_media_context');
  Object.assign(f.saved, { generated: true, fullMedia: true, assessmentMissing: true });
  const call = f.runtime['host'].call.bind(f.runtime['host']);
  let refreshes = 0;
  f.runtime['host'].call = async <T>(method: string, params: unknown): Promise<T> => {
    const input = params as { toolName?: string; args?: { mode?: string } };
    if (method === 'tools.execute' && input.toolName === 'courseware_media_assessments' && input.args?.mode === 'refresh') {
      refreshes++;
      if (!persistent) f.saved.assessmentMissing = false;
      return { ok: false, content: { error: 'Classroom changed; reopen narration generation' } } as T;
    }
    return call<T>(method, params);
  };
  try {
    const run = f.runtime.prompt('Finish the complete saved teaching course.', 'user', 'turn');
    await vi.advanceTimersByTimeAsync(30_000);
    await run;
    expect(refreshes).toBe(persistent ? 2 : 1);
    expect(f.calls.filter(call => call.name === 'courseware_media_assessments' && call.args.mode === 'prepare')).toHaveLength(1);
    expect(f.events.filter(e => e.event.type === 'error')).toHaveLength(0);
    expect(f.events.filter(e => e.event.type === 'agent_end')).toHaveLength(1);
    expect(f.checkpoint()).toMatchObject({ status: persistent ? 'blocked' : 'completed' });
  } finally { await f.runtime.abort(); await f.runtime.dispose(); vi.useRealTimers(); }
});

it("does not equate speech audio with completed teaching", async () => {
  const f = fixture("cleanPlate", "courseware_media_context");
  Object.assign(f.saved, { generated: true, fullMedia: true, teachingMissing: true });
  try {
    await f.runtime.prompt("Finish the complete saved teaching course.", "user", "turn").catch(() => undefined);
    expect(f.saved.teachingMissing).toBe(true);
    expect(f.contexts.some(messages => getCurrentSystemMessage(messages)?.sections?.courseware_workflow?.includes("no saved progress"))).toBe(true);
    expect(f.events.filter(e => e.event.type === "agent_end")).toHaveLength(1);
    expect(f.calls.filter(c => c.name === "courseware_media_context").length).toBeGreaterThan(1);
    expect(f.agent.state.isStreaming).toBe(false);
  } finally { await f.runtime.dispose(); }
});

it("resumes saved teaching through all missing stages without recompiling the PPTX", async () => {
  vi.useFakeTimers();
  const f = fixture("cleanPlate", "courseware_media_context");
  Object.assign(f.saved, { generated: true, fullMedia: true, narrationMissing: true, audioMissing: true });
  try {
    const running = f.runtime.prompt("Continue and finish this saved teaching course.", "user", "turn");
    await vi.advanceTimersByTimeAsync(6000);
    expect(f.saved.narrationMissing).toBe(false);
    expect(f.saved.mediaStarted).toBe(true);
    expect(f.agent.state.isStreaming).toBe(true);
    f.saved.audioCompleted = true;
    await vi.advanceTimersByTimeAsync(3000);
    await running;
    expect(f.calls.some(c => c.name === "courseware_scene_compile")).toBe(false);
    expect(f.saved.audioMissing).toBe(false);
  } finally { await f.runtime.dispose(); vi.useRealTimers(); }
});

it("keeps the same Chat active while polling an original video job", async () => {
  vi.useFakeTimers();
  const f = fixture("cleanPlate", "courseware_media_context", "video");
  Object.assign(f.saved, { generated: true, fullMedia: true, narrationMissing: true, audioMissing: true });
  try {
    const running = f.runtime.prompt("Finish the planned teaching video.", "user", "turn");
    await vi.advanceTimersByTimeAsync(6000);
    expect(f.agent.state.isStreaming).toBe(true);
    expect(f.events.filter(e => e.event.type === "agent_end")).toHaveLength(0);
    const queries = f.calls.filter(c => c.name === "courseware_media_refresh");
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every(c => c.args.kind === "video" && c.args.intentId === "original-tts")).toBe(true);
    f.saved.audioCompleted = true;
    await vi.advanceTimersByTimeAsync(3000);
    await running;
    expect(f.events.filter(e => e.event.type === "agent_end")).toHaveLength(1);
  } finally { await f.runtime.dispose(); vi.useRealTimers(); }
});

it("saved media status alone does not arm full-course generation", async () => {
  const f = fixture("cleanPlate", "courseware_media_context");
  Object.assign(f.saved, { generated: true, narrationMissing: true, audioMissing: true });
  try {
    await f.runtime.prompt("Only check the progress.", "user", "turn");
    expect(f.calls.map(c => c.name)).toEqual(["courseware_media_context"]);
    expect(f.saved.mediaStarted).toBe(false);
  } finally { await f.runtime.dispose(); }
});

it.each(["visualMaster", "cleanPlate"] as const)("keeps Chat open for pending %s and compiles without another user prompt", async target => {
  vi.useFakeTimers();
  const f = fixture(target);
  try {
    const running = f.runtime.prompt("Continue this courseware until its PPTX is ready.", "user", "turn");
    await vi.advanceTimersByTimeAsync(31_000);
    expect(f.requests()).toBe(3);
    expect(f.agent.state.isStreaming).toBe(true);
    expect(f.events.filter(event => event.event.type === "agent_end")).toHaveLength(0);
    expect(f.calls.some(call => call.name === "courseware_scene_image_refresh")).toBe(true);
    f.saved.completed = true;
    await vi.advanceTimersByTimeAsync(3000);
    await running;
    expect(f.saved.generated).toBe(true);
    expect(f.events.filter(event => event.event.type === "agent_end")).toHaveLength(1);
    expect(f.calls.filter(call => call.name === "courseware_scene_image_refresh")
      .every(call => call.args.intentId === "decomposition" && !call.args.generatePrepared)).toBe(true);
    expect(f.agent.state.messages.filter(message => message.role === "user")).toHaveLength(1);
    expect(getCurrentSystemMessage(f.agent.state.messages)?.sections?.courseware_workflow).toContain("actual state");
    await f.runtime.prompt("Explain this result.", "next-user", "next-turn");
    expect(getCurrentSystemMessage(f.agent.state.messages)?.sections?.courseware_workflow).toBeFalsy();
  } finally {
    await f.runtime.dispose();
    vi.useRealTimers();
  }
});

it("resumes an existing job from an explicit wait request without submitting another generation", async () => {
  vi.useFakeTimers();
  const f = fixture("cleanPlate", "courseware_scene_image_refresh");
  f.saved.phase = "submission-unknown";
  try {
    const running = f.runtime.prompt("Wait for the existing tasks and finish.", "user", "turn");
    await vi.advanceTimersByTimeAsync(6000);
    expect(f.agent.state.isStreaming).toBe(true);
    f.saved.completed = true;
    await vi.advanceTimersByTimeAsync(3000);
    await running;
    expect(f.saved.generated).toBe(true);
    expect(f.calls.some(call => call.name === "courseware_scene_image_prepare")).toBe(false);
  } finally {
    await f.runtime.dispose();
    vi.useRealTimers();
  }
});

it("lets a status-only question finish without starting generation or compilation", async () => {
  const f = fixture("cleanPlate", "courseware_workflow_get");
  try {
    await f.runtime.prompt("What is the current task status?", "user", "turn");
    expect(f.calls.map(call => call.name)).toEqual(["courseware_workflow_get"]);
    expect(f.requests()).toBe(3);
    expect(f.saved.generated).toBe(false);
  } finally { await f.runtime.dispose(); }
});

it.each(["abort", "graceful"])("honors %s while waiting, without another query or compile", async stop => {
  vi.useFakeTimers();
  const f = fixture();
  try {
    const running = f.runtime.prompt("Finish this lesson.", "user", "turn");
    await vi.advanceTimersByTimeAsync(6000);
    expect(f.agent.state.isStreaming).toBe(true);
    const count = f.calls.length;
    const stopping = stop === "abort" ? f.runtime.abort() : Promise.resolve(f.runtime.requestGracefulStop());
    await vi.advanceTimersByTimeAsync(3000);
    await Promise.all([running, stopping]);
    expect(f.agent.state.isStreaming).toBe(false);
    expect(f.calls).toHaveLength(count);
    expect(f.saved.generated).toBe(false);
  } finally {
    await f.runtime.dispose();
    vi.useRealTimers();
  }
});

it("waits for the cover image, then yields only for first-page style confirmation", async () => {
  vi.useFakeTimers();
  const f = fixture("visualMaster");
  f.saved.styleConfirmed = false;
  try {
    const running = f.runtime.prompt("Generate this lesson.", "user", "turn");
    await vi.advanceTimersByTimeAsync(6000);
    expect(f.agent.state.isStreaming).toBe(true);
    f.saved.completed = true;
    await vi.advanceTimersByTimeAsync(3000);
    await running;
    expect(f.saved.generated).toBe(false);
    expect(f.requests()).toBe(4);
    expect(f.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "Please confirm the cover style." }] });
  } finally {
    await f.runtime.dispose();
    vi.useRealTimers();
  }
});

it("delivers a steering correction during polling without forcing the old workflow to resume", async () => {
  vi.useFakeTimers();
  const f = fixture();
  try {
    const running = f.runtime.prompt("Finish this lesson.", "user", "turn");
    await vi.advanceTimersByTimeAsync(6000);
    const count = f.calls.length;
    f.saved.ignoreReady = true;
    const text = "Pause this workflow and explain its status.";
    expect(f.runtime.steer({ text }, "turn", { id: "correction", role: "user", content: text,
      createdAt: new Date().toISOString() }).accepted).toBe(true);
    await vi.advanceTimersByTimeAsync(3000);
    await running;
    expect(f.requests()).toBe(4);
    expect(f.calls).toHaveLength(count);
    expect(f.saved.generated).toBe(false);
    expect(f.agent.state.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes(text))).toBe(true);
  } finally {
    await f.runtime.dispose();
    vi.useRealTimers();
  }
});

it("reports a terminal job failure and stops polling without replacing the intent", async () => {
  vi.useFakeTimers();
  const f = fixture();
  try {
    const running = f.runtime.prompt("Finish this lesson.", "user", "turn");
    await vi.advanceTimersByTimeAsync(6000);
    f.saved.failed = true;
    await vi.advanceTimersByTimeAsync(3000);
    await running;
    expect(f.requests()).toBe(4);
    expect(f.saved.generated).toBe(false);
    expect(f.agent.state.messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "The generation job failed." }] });
    const count = f.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.calls).toHaveLength(count);
  } finally {
    await f.runtime.dispose();
    vi.useRealTimers();
  }
});

it("does not continue a replaced plan", async () => {
  vi.useFakeTimers();
  const f = fixture();
  try {
    const running = f.runtime.prompt("Finish this lesson.", "user", "turn");
    await vi.advanceTimersByTimeAsync(6000);
    f.saved.planSha256 = "c".repeat(64);
    f.saved.completed = true;
    await vi.advanceTimersByTimeAsync(3000);
    await running;
    expect(f.requests()).toBe(3);
    expect(f.saved.generated).toBe(false);
  } finally {
    await f.runtime.dispose();
    vi.useRealTimers();
  }
});

it.each(["query failure", "no model progress"])("ends a local %s without provider retries or false completion", async failure => {
  vi.useFakeTimers();
  const f = fixture();
  try {
    const running = f.runtime.prompt("Finish this lesson.", "user", "turn").catch(error => error);
    await vi.advanceTimersByTimeAsync(6000);
    if (failure === "query failure") f.saved.queryError = true;
    else { f.saved.completed = true; f.saved.ignoreReady = true; }
    await vi.advanceTimersByTimeAsync(10_000);
    await running;
    expect(f.agent.state.isStreaming).toBe(false);
    expect(f.saved.generated).toBe(false);
    if (failure === "query failure") expect(f.events.find(envelope => envelope.event.type === "error")).toMatchObject({
      event: { error: { retriable: false, details: { origin: "local" } } },
    });
    else {
      expect(f.contexts.some(messages => getCurrentSystemMessage(messages)?.sections?.courseware_workflow?.includes("no saved progress"))).toBe(true);
      expect(f.events.filter(e => e.event.type === "agent_end")).toHaveLength(1);
    }
    const count = f.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.calls).toHaveLength(count);
  } finally {
    await f.runtime.dispose();
    vi.useRealTimers();
  }
});


it("dispatches automatic continuation as a fresh request without persisting another human message", async () => {
  const f = fixture();
  f.saved.completed = true;
  try {
    await f.runtime.prompt("Finish the editable courseware.", "user", "turn");
    expect(f.saved.generated).toBe(true);
    const continuation = f.contexts[3]!;
    expect(continuation.at(-1)).toMatchObject({ role: "user", content: expect.stringContaining("Continue the authorized courseware task") });
    expect(getCurrentSystemMessage(continuation)?.sections?.courseware_workflow).toContain("actual state");
    expect(f.agent.state.messages.filter(message => message.role === "user")).toHaveLength(1);
    expect(f.events.filter(event => event.event.type === "agent_end")).toHaveLength(1);
  } finally { await f.runtime.dispose(); }
});

it("bounds advisory repairs and returns a playable course without endless unchanged-diagnostic retries", async () => {
  const f = fixture("cleanPlate", "courseware_media_context");
  Object.assign(f.saved, { completed: true, generated: true, fullMedia: true });
  f.saved.qualityIssues = [{ pageId: "page", code: "FOCUS_MISSING", repair: "narration", repairable: true }];
  try {
    await f.runtime.prompt("Finish teaching, preserving the playable lesson.", "user", "turn");
    const repairPrompts = f.contexts.filter(messages => getCurrentSystemMessage(messages)?.sections?.courseware_workflow?.includes("non-blocking teaching diagnostics"));
    expect(new Set(repairPrompts.map(messages => messages.length)).size).toBeGreaterThanOrEqual(2);
    expect(f.requests()).toBeLessThan(12);
    expect(f.events.filter(e => e.event.type === "agent_end")).toHaveLength(1);
    expect(f.calls.filter(c => c.name === "courseware_scene_image_prepare")).toHaveLength(0);
  } finally { await f.runtime.dispose(); }
});

it.each(["throws", "returns failures"])("reports saved audio and advisory diagnostics when automatic focus repair %s", async failure => {
  const f = fixture("cleanPlate", "courseware_media_context");
  Object.assign(f.saved, { generated: true, fullMedia: true, readyCompletion: true });
  f.saved.qualityIssues = [{ pageId: "page", pageNumber: 1, code: "FOCUS_MISSING", repair: "narration", repairable: true }];
  const call = f.runtime["host"].call.bind(f.runtime["host"]);
  f.runtime["host"].call = async <T>(method: string, params: unknown): Promise<T> => {
    if (method === "tools.execute" && (params as { toolName: string }).toolName === "courseware_narration_propose")
      return (failure === "throws"
        ? { ok: false, errorCode: "TOOL_FAILED", content: { error: "Focus repair unavailable" } }
        : { ok: true, content: { saved: false, failures: [{ pageNumber: 1, error: "Focus repair unavailable" }] } }) as T;
    return call<T>(method, params);
  };
  try {
    await f.runtime.prompt("Finish the saved course", "user", "turn");
    expect(f.events.filter(e => e.event.type === "error")).toHaveLength(0);
    expect(f.events.filter(e => e.event.type === "agent_end")).toHaveLength(1);
    expect(f.checkpoint()).toMatchObject({ status: "completed" });
    const report = getCurrentSystemMessage(f.contexts.at(-1)!)?.sections?.courseware_workflow;
    expect(report).toContain("FOCUS_MISSING");
    expect(report).toContain("repair failed");
    expect(f.events.some(e => e.event.type === "tool_start" && e.event.toolName === "courseware_narration_propose")).toBe(true);
    if (failure === "throws") expect(f.events.some(e => e.event.type === "tool_end" && e.event.isError)).toBe(true);
    expect(f.calls.filter(c => c.name === "courseware_media_context").length).toBeGreaterThanOrEqual(2);
    expect(f.calls.some(c => c.name === "courseware_media_prepare")).toBe(false);
  } finally { await f.runtime.dispose(); }
});


it("keeps an unresolved advisory's repair budget when another page is fixed", async () => {
  const f = fixture("cleanPlate", "courseware_media_context");
  Object.assign(f.saved, { generated: true, fullMedia: true, readyCompletion: true });
  f.saved.qualityIssues = [1, 2].map(pageNumber => ({ pageId: `page-${pageNumber}`, pageNumber,
    code: "FOCUS_MISSING", repair: "narration", repairable: true }));
  const call = f.runtime["host"].call.bind(f.runtime["host"]);
  let repairs = 0;
  f.runtime["host"].call = async <T>(method: string, params: unknown): Promise<T> => {
    if (method === "tools.execute" && (params as { toolName: string }).toolName === "courseware_narration_propose") {
      repairs++;
      f.saved.qualityIssues = f.saved.qualityIssues.filter(issue => issue.pageNumber === 2);
      if (repairs > 5) f.saved.qualityIssues = [];
      return { ok: true, content: { saved: true } } as T;
    }
    return call<T>(method, params);
  };
  try {
    await f.runtime.prompt("Finish the saved course", "user", "turn");
    expect(repairs).toBe(2);
    expect(f.checkpoint()).toMatchObject({ status: "completed" });
    expect(getCurrentSystemMessage(f.contexts.at(-1)!)?.sections?.courseware_workflow).toContain("FOCUS_MISSING");
  } finally { await f.runtime.dispose(); }
});

it.each([false, true])("does not report a cancelled repair as accepted or failed teaching (required=%s)", async required => {
  const f = fixture("cleanPlate", "courseware_media_context");
  Object.assign(f.saved, { generated: true, fullMedia: true, readyCompletion: true, teachingMissing: required });
  if (!required) f.saved.qualityIssues = [{ pageId: "page", pageNumber: 1, code: "FOCUS_MISSING", repair: "narration", repairable: true }];
  const call = f.runtime["host"].call.bind(f.runtime["host"]);
  f.runtime["host"].call = async <T>(method: string, params: unknown): Promise<T> => {
    if (method === "courseware.workflow.get") {
      const result = await call<{ completion: { issues: Array<Record<string, unknown>> } }>(method, params);
      result.completion.issues.forEach(issue => { issue.pageNumber = 1; });
      return result as T;
    }
    if (method === "tools.execute" && (params as { toolName: string }).toolName === "courseware_narration_propose")
      throw Object.assign(new Error("Repair cancelled"), { name: "AbortError" });
    return call<T>(method, params);
  };
  try {
    await f.runtime.prompt("Finish the saved course", "user", "turn");
    expect(f.checkpoint()).toMatchObject({ status: "blocked" });
    expect(f.contexts.some(messages => getCurrentSystemMessage(messages)?.sections?.courseware_workflow?.includes("repair failed"))).toBe(false);
  } finally { await f.runtime.dispose(); }
});

it.each([true, false])("reconciles a required-repair failure before reporting (saved=%s)", async saved => {
  const f = fixture("cleanPlate", "courseware_media_context");
  Object.assign(f.saved, { generated: true, fullMedia: true, readyCompletion: true, teachingMissing: true });
  const call = f.runtime["host"].call.bind(f.runtime["host"]);
  let repairs = 0;
  f.runtime["host"].call = async <T>(method: string, params: unknown): Promise<T> => {
    if (method === "courseware.workflow.get") {
      const result = await call<{ checkpoint: unknown; completion: { issues: Array<Record<string, unknown>> } }>(method, params);
      result.completion.issues.forEach(issue => { issue.pageNumber = 1; });
      return result as T;
    }
    if (method === "tools.execute" && (params as { toolName: string }).toolName === "courseware_narration_propose") {
      repairs++;
      f.saved.teachingMissing = !saved;
      return { ok: false, errorCode: "TOOL_FAILED", content: { error: "Repair response lost" } } as T;
    }
    return call<T>(method, params);
  };
  try {
    await f.runtime.prompt("Complete retained teaching", "user", "turn");
    expect(f.events.filter(e => e.event.type === "error")).toHaveLength(0);
    expect(repairs).toBe(1);
    expect(f.checkpoint()).toMatchObject({ status: saved ? "completed" : "blocked" });
    expect(getCurrentSystemMessage(f.contexts.at(-1)!)?.sections?.courseware_workflow).toContain(saved ? "full playback acceptance remains unverified" : "Required teaching repair failed");
    expect(f.calls.some(c => c.name === "courseware_media_prepare")).toBe(false);
  } finally { await f.runtime.dispose(); }
});

it("ends unknown assessment submission with an original-task report instead of polling indefinitely", async () => {
  vi.useFakeTimers();
  const f = fixture("cleanPlate", "courseware_media_context");
  Object.assign(f.saved, { generated: true, fullMedia: true, readyCompletion: true, assessmentMissing: true });
  const call = f.runtime["host"].call.bind(f.runtime["host"]);
  let refreshes = 0;
  f.runtime["host"].call = async <T>(method: string, params: unknown): Promise<T> => {
    const input = params as { toolName?: string; args?: Record<string, unknown> };
    if (method === "tools.execute" && input.toolName === "courseware_media_assessments") {
      f.saved.assessmentStarted = true;
      if (input.args?.mode === "refresh") refreshes++;
      return { ok: true, content: { key: "original", state: "submission_unknown", task: { taskId: "original" } } } as T;
    }
    return call<T>(method, params);
  };
  try {
    const run = f.runtime.prompt("Finish the saved course", "user", "turn");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.agent.state.isStreaming).toBe(false);
    await run;
    expect(refreshes).toBe(1);
    expect(f.checkpoint()).toMatchObject({ status: "blocked" });
    expect(f.events.filter(e => e.event.type === "error")).toHaveLength(0);
    expect(getCurrentSystemMessage(f.contexts.at(-1)!)?.sections?.courseware_workflow).toContain("submission_unknown");
  } finally { await f.runtime.abort(); await f.runtime.dispose(); vi.useRealTimers(); }
});

it("settles a failed original batch with one report, without a fresh TTS order or repeated final answers", async () => {
  vi.useFakeTimers();
  const f = fixture("cleanPlate", "courseware_media_context");
  Object.assign(f.saved, { generated: true, fullMedia: true, mediaStarted: true, audioMissing: true, recoveryFailure: true, retryAfterBlock: true });
  try {
    const run = f.runtime.prompt("Finish the planned music and report the remaining original TTS failure; never repurchase it.", "user", "turn");
    await vi.advanceTimersByTimeAsync(30_000);
    await run;
    expect(f.calls.filter(c => c.name === "courseware_media_refresh")).toHaveLength(1);
    expect(f.calls.filter(c => c.name === "courseware_media_prepare")).toHaveLength(0);
    expect(f.requests()).toBe(5);
    expect(f.contexts[3].some(message => message.role === "system" && message.sections?.courseware_workflow?.includes("results are unknown or failed"))).toBe(true);
    expect(f.events.filter(e => e.event.type === "agent_end")).toHaveLength(1);
    expect(f.agent.state.isStreaming).toBe(false);
    expect(f.saved.audioMissing).toBe(true);
  } finally { await f.runtime.dispose(); vi.useRealTimers(); }
});


it("ends repeated ready reads at the tool boundary before full media can trigger compaction", async () => {
  const f = fixture("cleanPlate", "courseware_media_context");
  Object.assign(f.saved, { generated: true, fullMedia: true, repeatReadyReads: true });
  try {
    await f.runtime.prompt("Finish the saved course", "user", "turn");
    expect(f.requests()).toBe(4);
    expect(f.calls.filter(call => call.name === "courseware_media_context")).toHaveLength(1);
    expect(f.toolCounts.at(-1)).toBe(f.toolCounts.at(-2));
    expect(JSON.stringify(f.contexts.map(messages => messages.map(message => message.content)))).not.toContain("x".repeat(1000));
    expect(f.contexts[2].some(message => message.role === "system" && message.sections?.courseware_workflow?.includes("full playback acceptance remains unverified"))).toBe(true);
    expect(f.agent.state.isStreaming).toBe(false);
    expect(f.events.filter(e => e.event.type === "agent_end")).toHaveLength(1);
  } finally { await f.runtime.dispose(); }
});

it("persists completion and closes after one final report", async () => {
  const f = fixture("cleanPlate", "courseware_media_context");
  Object.assign(f.saved, { generated: true, fullMedia: true, readyCompletion: true });
  try {
    await f.runtime.prompt("Finish the saved course", "user", "turn");
    expect(f.checkpoint()).toMatchObject({ status: "completed", projectId: "project", sourceSha256: sha256 });
    expect(f.requests()).toBe(3);
    expect(f.toolCounts.at(-1)).toBe(f.toolCounts.at(-2));
    expect(f.contexts.at(-1)?.some(message => message.role === "system" &&
      message.sections?.courseware_workflow?.includes("full playback acceptance remains unverified"))).toBe(true);
    expect(f.agent.state.isStreaming).toBe(false);
    expect(f.events.filter(e => e.event.type === "agent_end")).toHaveLength(1);
    expect(f.events.filter(e => e.event.type === "error")).toHaveLength(0);
  } finally { await f.runtime.dispose(); }
});

it.each([
  ["courseware.workflow.get", false], ["courseware.workflow.checkpoint", false],
  ["courseware.workflow.get", true], ["courseware.workflow.checkpoint", true],
])("ends a local %s failure (abort=%s) without regenerating completion reports", async (method, aborted) => {
  vi.useFakeTimers();
  const f = fixture("cleanPlate", "courseware_media_context");
  Object.assign(f.saved, { generated: true, fullMedia: true, readyCompletion: true, checkpointError: method, checkpointAbort: aborted });
  try {
    const run = f.runtime.prompt("Finish the saved course", "user", "turn").catch(error => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.requests()).toBe(2);
    await run;
    expect(f.agent.state.isStreaming).toBe(false);
    expect(f.events.filter(e => e.event.type === "agent_end")).toHaveLength(1);
    if (aborted) expect(f.events.filter(e => e.event.type === "error")).toHaveLength(0);
    else expect(f.events.find(e => e.event.type === "error")?.event).toMatchObject({
      error: { code: "INTERNAL", retriable: false, details: { origin: "local", phase: "request-preparation" } },
    });
  } finally { await f.runtime.abort(); await f.runtime.dispose(); vi.useRealTimers(); }
});

it("retains the failed workflow operation after successful PPT adoption without a model retry", async () => {
  vi.useFakeTimers();
  const f = fixture("cleanPlate", "courseware_presentation_adopt");
  f.saved.fullMedia = true;
  const runtimeHost = f.runtime['host'];
  const call = runtimeHost.call.bind(runtimeHost);
  runtimeHost.call = async <T>(method: string, params: unknown): Promise<T> => {
    if (method === "tools.execute" && (params as { toolName: string }).toolName === "courseware_media_context")
      return { ok: false, errorCode: "COURSEWARE_WORKFLOW_REJECTED", content: { error: "private payload must not reach error UI" } } as T;
    return call(method, params) as Promise<T>;
  };
  try {
    const run = f.runtime.prompt("Finish this course", "user", "turn").catch(error => error);
    await vi.advanceTimersByTimeAsync(10000); await run;
    expect(f.saved.generated).toBe(true);
    expect(f.requests()).toBe(2);
    const error = f.events.find(e => e.event.type === "error")?.event;
    expect(error).toMatchObject({ error: { code: "COURSEWARE_WORKFLOW_REJECTED", retriable: false,
      details: { origin: "local", phase: "courseware-continuation", operation: "courseware_media_context" } } });
    expect(JSON.stringify(error)).not.toContain("private payload");
  } finally { await f.runtime.abort(); await f.runtime.dispose(); vi.useRealTimers(); }
});

it("closes completed media work when a subsequent saved check is ready without authorizing a new course", async () => {
  const { CoursewareTurnContinuation } = await import('./courseware-turn-continuation.js');
  const continuation = new CoursewareTurnContinuation();
  const turn = (name: string, args: Record<string, unknown>, details: unknown) => ({
    message: { content: [{ type: 'toolCall', id: 'call', name, arguments: args }], stopReason: 'toolUse' },
    toolResults: [{ toolName: name, toolCallId: 'call', isError: false, details }],
  }) as unknown as Parameters<InstanceType<typeof CoursewareTurnContinuation>['finish']>[0];
  const controls = { canWait: () => true, execute: vi.fn(async () => { throw new Error('No new work or status poll expected'); }) };
  await continuation.finish(turn('courseware_media_prepare', {}, { job: { sourceSha256: sha256 } }), controls);
  const result = await continuation.finish(turn('courseware_media_context', {}, {
    nativeTeaching: true, sourceSha256: sha256, jobs: [], completion: { ready: true },
  }), controls);
  expect(result).toContain('full playback acceptance remains unverified');
  expect(continuation.reportOnly).toBe(true);
  expect(controls.execute).not.toHaveBeenCalled();
  const statusOnly = new CoursewareTurnContinuation();
  expect(await statusOnly.finish(turn('courseware_media_context', {}, {
    sourceSha256: sha256, jobs: [], completion: { ready: true },
  }), controls)).toBeUndefined();
  expect(statusOnly.reportOnly).toBe(false);
});
