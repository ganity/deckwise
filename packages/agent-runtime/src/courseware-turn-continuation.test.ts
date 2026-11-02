import { expect, it, vi } from "vitest";
import type { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, getCurrentSystemMessage, getCurrentTools, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import type { AgentEventEnvelope } from "@pi-desktop/shared";
import { DesktopAgentRuntime } from "./runtime.js";

const sha256 = "a".repeat(64);

function fixture(target: "visualMaster" | "cleanPlate" = "cleanPlate", startTool = "courseware_scene_image_prepare", mediaKind: "tts" | "video" = "tts") {
  let requests = 0;
  const contexts: Message[][] = [];
  const toolCounts: number[] = [];
  const saved = { completed: false, generated: false, failed: false, styleConfirmed: true,
    planSha256: sha256, phase: "submitted", queryError: false, ignoreReady: false, mediaUnknown: false, recoveryFailure: false, retryAfterBlock: false,
    repeatReadyReads: false, readyCompletion: false,
    checkpointError: "",
    checkpointAbort: false, explicitRetry: false,
    qualityIssues: [] as Array<{ pageId: string; code: string; repair: string; repairable: boolean }>, teachingMissing: false, fullMedia: false, narrationMissing: false, audioMissing: false, mediaStarted: false, audioCompleted: false };
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const events: AgentEventEnvelope[] = [];
  const image = () => ({ intentId: "decomposition", planSha256: sha256, pageId: "scene-001",
    target: { kind: target }, current: true, phase: saved.phase, selected: saved.completed && saved.styleConfirmed,
    task: { state: saved.failed ? "failed" : saved.completed ? "ready" : "queued" },
    asset: saved.completed ? { sha256: "b".repeat(64) } : null });
  const snapshot = () => ({ task: { taskType: "scene", generated: saved.generated },
    plan: { sha256: saved.planSha256, approvedSha256: saved.planSha256, pages: [{ pageId: "scene-001" }] },
    images: [image(), ...(saved.explicitRetry ? [{ ...image(), intentId: "unrelated-failure", phase: "submitted", selected: false, asset: null, task: { state: "failed" } }] : [])], styleConfirmed: saved.styleConfirmed, requiresHumanSelection: !saved.styleConfirmed && saved.completed,
    blockers: saved.completed ? [] : [{ pageId: "scene-001", kind: target }] });
  let checkpoint: unknown = null;
  const runtime = new DesktopAgentRuntime({
    sessionId: "chat", mode: "agent", thinkingLevel: "off",
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    provider: { id: "local", name: "Fixture", baseUrl: "http://127.0.0.1:1/v1", modelId: "fixture",
      apiKey: "", authKind: "none", supportsReasoning: false, supportedThinkingLevels: ["off"],
      modelConfig: { source: "generic", name: "Fixture", baseUrl: "http://127.0.0.1:1/v1", reasoning: false,
        input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 256_000, maxTokens: 4096 } },
    host: { async call<T>(method: string, params: unknown): Promise<T> {
      if (method === saved.checkpointError) throw Object.assign(new Error(`host method not allowed from sidecar: ${method}`), {
        code: -32601, name: saved.checkpointAbort ? "AbortError" : "Error",
      });
      if (method === "courseware.workflow.get") return { checkpoint, completion: { ready: !saved.narrationMissing && !saved.audioMissing && !saved.teachingMissing,
        sourceSha256: sha256, teachingRevision: "t1", issues: saved.teachingMissing ? [{ pageId: "page", code: "QUESTION_MISSING", repair: "narration", repairable: true }] :
          saved.narrationMissing ? [{ pageId: "page", code: "NARRATION_MISSING", repair: "narration", repairable: true }] :
          saved.audioMissing ? [{ pageId: "page", pageNumber: 1, code: "AUDIO_MISSING", repair: "tts", repairable: true }] : [] } } as T;
      if (method === "courseware.workflow.checkpoint") { checkpoint = (params as { checkpoint: unknown }).checkpoint; return { checkpoint } as T; }
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
        if (args.retryFailed === true) saved.mediaStarted = true;
        if (saved.audioCompleted) saved.audioMissing = false;
        content = saved.recoveryFailure ? { saved: false, results: [], failures: [{ intentId: "original-tts", error: "HTTP 500 original recovery unavailable" }] } : { saved: !saved.audioMissing, waitingFor: saved.audioMissing ? "service" : null,
          ...(saved.mediaUnknown ? { media: { task: { state: "submission_unknown" } } } : {}),
          ...(saved.explicitRetry ? { job: { kind: mediaKind, intentId: "original-tts", pageNumber: 1, sourceSha256: sha256 } } : {}) };
      }
      if (toolName === "courseware_media_context") content = { projectId: "project", teachingRevision: "t1", sourceSha256: sha256, narrationReady: !saved.narrationMissing,
        audioReady: !saved.audioMissing, teachingReady: !saved.audioMissing && !saved.teachingMissing, pages: [{ pageNumber: 1, narrationReady: !saved.narrationMissing, audioReady: !saved.audioMissing, speeches: [{ actionId: "speech", audioReady: !saved.audioMissing }] }],
        videoReady: mediaKind !== "video" || !saved.audioMissing,
        ...(saved.repeatReadyReads || saved.readyCompletion ? { completion: { ready: true, sourceSha256: sha256, teachingRevision: "t1" },
          approvedPlan: { narration: "x".repeat(338000) } } : {}),
        quality: { blocking: false, issues: saved.qualityIssues },
        jobs: saved.mediaStarted && saved.audioMissing ? [{ kind: mediaKind, intentId: "original-tts", pageNumber: 1, actionId: "speech", sourceSha256: sha256 }] : [] };
      return { ok: true, content } as T;
    } },
    onEvent: event => { events.push(event); },
  });
  const { agent } = runtime as unknown as { agent: Agent };
  agent.streamFunction = (_model, context) => {
    contexts.push(context.messages);
    toolCounts.push(getCurrentTools(context.messages).length);
    requests++;
    const content: AssistantMessage["content"] = requests === 1
      ? [{ type: "toolCall", id: "search", name: "ToolSearch", arguments: { query: startTool + " courseware_scene_compile courseware_narration_propose courseware_media_prepare" } }]
      : requests === 2
      ? [{ type: "toolCall", id: "start", name: startTool, arguments: startTool === "courseware_media_context" ? (saved.fullMedia ? { continueTeaching: true } : {}) : startTool === "courseware_scene_image_prepare"
        ? { planSha256: sha256, pageId: "scene-001", target: { kind: target } }
        : startTool === "courseware_scene_image_refresh" ? { intentId: "decomposition", waitForUpdate: true, ...(saved.explicitRetry ? { retryFailed: true } : {}) }
        : startTool === "courseware_media_refresh" ? { kind: mediaKind, sourceSha256: sha256, pageNumber: 1, intentId: "original-tts", retryFailed: true } : {} }]
      : saved.repeatReadyReads
        ? [{ type: "toolCall", id: `repeat-${requests}`, name: "courseware_media_context", arguments: {} }]
      : requests === 4 && saved.retryAfterBlock
        ? [{ type: "toolCall", id: "replacement", name: "courseware_media_prepare", arguments: { kind: "tts", sourceSha256: sha256, pageNumber: 1, actionId: "speech", model: "different-model" } }]
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
  return { runtime, agent, calls, events, saved, contexts, toolCounts, requests: () => requests, checkpoint: () => checkpoint };
}

it('keeps planning tools available after shell reads and repairs the first invalid draft before human review', async () => {
  const f = fixture();
  let valid = false;
  const executed: string[] = [];
  const execute = f.runtime['host'].call.bind(f.runtime['host']);
  f.runtime['host'].call = async <T>(method: string, params: unknown): Promise<T> => {
    if (method === 'project.instructions.resolve') return undefined as T;
    if (method !== 'tools.execute') return execute<T>(method, params);
    const { toolName, args } = params as { toolName: string; args: Record<string, unknown> };
    executed.push(toolName);
    if (toolName === 'Bash') return { ok: true, content: 'Reference plan' } as T;
    if (toolName === 'Write') { valid = args.content === 'corrected'; return { ok: true, content: 'Written' } as T; }
    if (toolName === 'courseware_scene_plan_submit') return (valid
      ? { ok: true, content: { validated: true, awaitingPlanApproval: true, plan: { sha256, approvedSha256: 'b'.repeat(64) } } }
      : { ok: false, content: { error: 'Question and choices must be visible on scene page 1' } }) as T;
    if (toolName === 'courseware_workflow_get') return { ok: true,
      content: { task: { taskType: 'scene', generated: false }, plan: { sha256, approvedSha256: 'b'.repeat(64) } } } as T;
    return execute<T>(method, params);
  };
  const script: Array<{ name: string; arguments: Record<string, string> }> = [
    { name: 'ToolSearch', arguments: { query: 'courseware_workflow_get' } },
    { name: 'Bash', arguments: { command: 'cat .deckwise-ppt/scenes/chat/plan.json 2>/dev/null | head -50' } },
    { name: 'Bash', arguments: { command: 'cat .deckwise-ppt/scenes/reference/plan.json | head -60' } },
    { name: 'Write', arguments: { path: '.deckwise-ppt/scenes/chat/plan.json', content: 'invalid' } },
    { name: 'Bash', arguments: { command: 'cat .deckwise-ppt/scenes/chat/plan.json' } },
    { name: 'Write', arguments: { path: '.deckwise-ppt/scenes/chat/plan.json', content: 'corrected' } },
    { name: 'courseware_scene_plan_submit', arguments: {} },
    { name: 'courseware_workflow_get', arguments: {} },
  ];
  let requests = 0;
  const declarations: string[][] = [];
  const contexts: string[] = [];
  f.agent.streamFunction = (_model, context) => {
    const call = script[requests++];
    if (requests > script.length + 1) void f.runtime.abort();
    declarations.push(getCurrentTools(context.messages).map(tool => tool.name));
    contexts.push(JSON.stringify(context.messages));
    const message: AssistantMessage = { role: 'assistant', api: 'openai-completions', provider: 'local', model: 'fixture',
      timestamp: Date.now(), stopReason: call ? 'toolUse' : 'stop',
      content: call ? [{ type: 'toolCall', id: `call-${requests}`, ...call }] : [{ type: 'text', text: 'Please review the draft.' }],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'done', reason: call ? 'toolUse' : 'stop', message });
      stream.end(message);
    });
    return stream;
  };
  try {
    await f.runtime.prompt('Create the Greetings scene draft.', 'user', 'turn');
    expect(executed.filter(name => name === 'Write'), JSON.stringify(executed)).toHaveLength(2);
    expect(contexts[4]).toContain('Question and choices must be visible on scene page 1');
    expect(executed).toContain('courseware_workflow_get');
    expect(contexts.at(-1)).toContain('approvedSha256');
    expect(requests).toBe(script.length + 1);
    for (const [index, call] of script.entries()) expect(declarations[index]).toContain(call.name);
    expect(executed.every(name => ['Write', 'Bash', 'courseware_scene_plan_submit', 'courseware_workflow_get'].includes(name))).toBe(true);
    expect(f.events.filter(event => event.event.type === 'agent_end')).toHaveLength(1);
    expect(f.events.filter(event => event.event.type === 'error')).toEqual([]);
  } finally { await f.runtime.dispose(); }
});

it.each(["stop", "steer"] as const)("fences an old batch's remaining generation calls after %s", async action => {
  const f = fixture();
  const stream = f.agent.streamFunction!;
  let batchStarted = false;
  const execute = f.runtime['host'].call.bind(f.runtime['host']);
  f.runtime['host'].call = async (method, params) => {
    if (method === 'tools.execute' && (params as { toolName: string }).toolName === 'courseware_scene_image_prepare' && !batchStarted) {
      batchStarted = true;
      if (action === 'stop') expect(f.runtime.requestGracefulStop()).toEqual({ requested: true });
      else f.runtime.steer({ text: 'Stop creating requests and report the blocker.' }, 'turn', {
        id: 'correction', role: 'user', content: 'Stop creating requests and report the blocker.', createdAt: new Date().toISOString(),
      });
    }
    return execute(method, params);
  };
  f.agent.streamFunction = (model, context, options) => {
    if (f.requests() !== 1) return stream(model, context, options);
    const original = stream(model, context, options);
    const replacement = createAssistantMessageEventStream();
    void (async () => {
      const events = await original;
      for await (const _ of events) { /* Consume the fixture response. */ }
      const message = await events.result();
      const first = message.content.find(block => block.type === 'toolCall')!;
      if (first.type !== 'toolCall') throw new Error('Expected generation call');
      const batch: AssistantMessage = { ...message, content: [first, { ...first, id: 'second' }, { ...first, id: 'third' }] };
      replacement.push({ type: 'start', partial: batch });
      replacement.push({ type: 'done', reason: 'toolUse', message: batch }); replacement.end(batch);
    })();
    return replacement;
  };
  f.saved.failed = true;
  try {
    await f.runtime.prompt('Generate the lesson.', 'user', 'turn');
    expect(batchStarted).toBe(true);
    expect(f.calls.filter(call => call.name === 'courseware_scene_image_prepare')).toHaveLength(1);
    expect(f.events.filter(e => e.event.type === 'agent_end')).toHaveLength(1);
    if (action === 'steer') expect(f.contexts.some(messages => messages.some(m => m.role === 'user' &&
      typeof m.content === 'string' && m.content.includes('Stop creating requests')))).toBe(true);
  } finally { await f.runtime.dispose(); }
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
    expect(f.toolCounts.at(-1)).toBe(0);
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
    expect(f.toolCounts.at(-1)).toBe(0);
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
    expect(f.requests()).toBe(4);
  } finally { await f.runtime.dispose(); vi.useRealTimers(); }
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
    expect(f.requests()).toBe(4);
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
    expect(f.requests()).toBe(3);
    expect(f.calls.filter(call => call.name === "courseware_media_context")).toHaveLength(1);
    expect(f.toolCounts.at(-1)).toBe(0);
    expect(JSON.stringify(f.contexts.map(messages => messages.map(message => message.content)))).not.toContain("x".repeat(1000));
    expect(f.contexts[2].some(message => message.role === "system" && message.sections?.courseware_workflow?.includes("completed"))).toBe(true);
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
    expect(f.toolCounts.at(-1)).toBe(0);
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
