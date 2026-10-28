import { expect, it, vi } from "vitest";
import type { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, getCurrentSystemMessage, type AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentEventEnvelope } from "@pi-desktop/shared";
import { DesktopAgentRuntime } from "./runtime.js";

const sha256 = "a".repeat(64);

function fixture(target: "visualMaster" | "cleanPlate" = "cleanPlate", startTool = "courseware_scene_image_prepare", mediaKind: "tts" | "video" = "tts") {
  let requests = 0;
  const saved = { completed: false, generated: false, failed: false, styleConfirmed: true,
    planSha256: sha256, phase: "submitted", queryError: false, ignoreReady: false,
    teachingMissing: false, fullMedia: false, narrationMissing: false, audioMissing: false, mediaStarted: false, audioCompleted: false };
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const events: AgentEventEnvelope[] = [];
  const image = () => ({ intentId: "decomposition", planSha256: sha256, pageId: "scene-001",
    target: { kind: target }, current: true, phase: saved.phase, selected: saved.completed && saved.styleConfirmed,
    task: { state: saved.failed ? "failed" : saved.completed ? "ready" : "queued" },
    asset: saved.completed ? { sha256: "b".repeat(64) } : null });
  const snapshot = () => ({ task: { taskType: "scene", generated: saved.generated },
    plan: { sha256: saved.planSha256, approvedSha256: saved.planSha256, pages: [{ pageId: "scene-001" }] },
    images: [image()], styleConfirmed: saved.styleConfirmed, requiresHumanSelection: !saved.styleConfirmed && saved.completed,
    blockers: saved.completed ? [] : [{ pageId: "scene-001", kind: target }] });
  const runtime = new DesktopAgentRuntime({
    sessionId: "chat", mode: "agent", thinkingLevel: "off",
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    provider: { id: "local", name: "Fixture", baseUrl: "http://127.0.0.1:1/v1", modelId: "fixture",
      apiKey: "", authKind: "none", supportsReasoning: false, supportedThinkingLevels: ["off"],
      modelConfig: { source: "generic", name: "Fixture", baseUrl: "http://127.0.0.1:1/v1", reasoning: false,
        input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 256_000, maxTokens: 4096 } },
    host: { async call<T>(method: string, params: unknown): Promise<T> {
      if (method !== "tools.execute") return {} as T;
      const { toolName, args } = params as { toolName: string; args: Record<string, unknown> };
      calls.push({ name: toolName, args });
      if (saved.queryError) return { ok: false, errorCode: "TASK_STATUS_UNAVAILABLE" } as T;
      let content: unknown = snapshot();
      if (["courseware_scene_image_prepare", "courseware_scene_image_refresh"].includes(toolName)) content = {
        image: image(), styleConfirmed: saved.styleConfirmed, requiresHumanSelection: !saved.styleConfirmed && saved.completed,
        waitingFor: saved.completed || saved.failed ? null : "service",
      };
      if (toolName === "courseware_scene_compile") { saved.generated = true; content = { generated: true }; }
      if (toolName === "courseware_narration_propose") { saved.narrationMissing = false; content = { saved: true, failures: [] }; }
      if (toolName === "courseware_media_prepare") { saved.mediaStarted = true; content = { waitingFor: "service", job: { kind: mediaKind, intentId: "original-tts", pageNumber: 1, sourceSha256: sha256 } }; }
      if (toolName === "courseware_media_refresh") {
        if (saved.audioCompleted) saved.audioMissing = false;
        content = { saved: !saved.audioMissing, waitingFor: saved.audioMissing ? "service" : null };
      }
      if (toolName === "courseware_media_context") content = { sourceSha256: sha256, narrationReady: !saved.narrationMissing,
        audioReady: !saved.audioMissing, teachingReady: !saved.audioMissing && !saved.teachingMissing, pages: [{ pageNumber: 1, narrationReady: !saved.narrationMissing, audioReady: !saved.audioMissing }],
        videoReady: mediaKind !== "video" || !saved.audioMissing,
        jobs: saved.mediaStarted && saved.audioMissing ? [{ kind: mediaKind, intentId: "original-tts", pageNumber: 1, sourceSha256: sha256 }] : [] };
      return { ok: true, content } as T;
    } },
    onEvent: event => { events.push(event); },
  });
  const { agent } = runtime as unknown as { agent: Agent };
  agent.streamFunction = () => {
    requests++;
    const content: AssistantMessage["content"] = requests === 1
      ? [{ type: "toolCall", id: "search", name: "ToolSearch", arguments: { query: startTool + " courseware_scene_compile courseware_narration_propose courseware_media_prepare" } }]
      : requests === 2
      ? [{ type: "toolCall", id: "start", name: startTool, arguments: startTool === "courseware_media_context" ? (saved.fullMedia ? { continueTeaching: true } : {}) : startTool === "courseware_scene_image_prepare"
        ? { planSha256: sha256, pageId: "scene-001", target: { kind: target } }
        : startTool === "courseware_scene_image_refresh" ? { intentId: "decomposition", waitForUpdate: true } : {} }]
      : requests === 4 && !saved.generated && saved.styleConfirmed && !saved.failed && !saved.ignoreReady
        ? [{ type: "toolCall", id: "compile", name: "courseware_scene_compile", arguments: { planSha256: sha256, ...(saved.fullMedia ? { continueTeaching: true } : {}) } }]
        : saved.fullMedia && requests === (startTool === "courseware_media_context" ? 4 : 6)
          ? [{ type: "toolCall", id: "narration", name: "courseware_narration_propose", arguments: { sourceSha256: sha256, pageNumbers: [1], instruction: "Explain the whole lesson" } }]
        : saved.fullMedia && requests === (startTool === "courseware_media_context" ? 6 : 8)
          ? [{ type: "toolCall", id: "tts", name: "courseware_media_prepare", arguments: { kind: "tts", sourceSha256: sha256, pageNumber: 1, actionId: "speech", model: "tts" } }]
        : [{ type: "text", text: saved.failed ? "The generation job failed." : saved.generated ? "Editable PPTX completed." :
          saved.completed && !saved.styleConfirmed ? "Please confirm the cover style." : "Tasks are processing; click Continue later." }];
    const toolUse = content[0]?.type === "toolCall";
    const message: AssistantMessage = { role: "assistant", content, api: "openai-completions",
      provider: "local", model: "fixture", timestamp: Date.now(), stopReason: toolUse ? "toolUse" : "stop",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: toolUse ? "toolUse" : "stop", message });
      stream.end(message);
    });
    return stream;
  };
  return { runtime, agent, calls, events, saved, requests: () => requests };
}

it("preserves a PPTX-only request without starting narration or media", async () => {
  const f = fixture();
  Object.assign(f.saved, { completed: true, narrationMissing: true, audioMissing: true });
  try {
    await f.runtime.prompt("Only produce the editable PPTX, without narration or audio.", "user", "turn");
    expect(f.saved.generated).toBe(true);
    expect(f.calls.some(c => /^courseware_(?:media|narration)_/u.test(c.name))).toBe(false);
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

it("does not equate speech audio with completed teaching", async () => {
  const f = fixture("cleanPlate", "courseware_media_context");
  Object.assign(f.saved, { generated: true, fullMedia: true, teachingMissing: true });
  try {
    await f.runtime.prompt("Finish the complete saved teaching course.", "user", "turn").catch(() => undefined);
    expect(f.events.some(e => e.event.type === "error")).toBe(true);
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
    await vi.advanceTimersByTimeAsync(3000);
    await running;
    expect(f.agent.state.isStreaming).toBe(false);
    expect(f.saved.generated).toBe(false);
    expect(f.events.find(envelope => envelope.event.type === "error")).toMatchObject({
      event: { error: { retriable: false, details: { origin: "local" } } },
    });
    const count = f.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.calls).toHaveLength(count);
  } finally {
    await f.runtime.dispose();
    vi.useRealTimers();
  }
});
