import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, register } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const require = createRequire(import.meta.url);
const ts = require("typescript");
const { IPC } = await import("@pi-desktop/shared");
const { createSessionCoordination } = await import("../electron/main/runtime/session-coordination.ts");
const { summarizeToolResult } = await import("../electron/main/logger.ts");

// Execute the complete real factory; its Electron resource-loading imports are unused here.
const sourcePath = fileURLToPath(new URL("../electron/main/runtime/sidecar.ts", import.meta.url));
const source = ts.createSourceFile(sourcePath, readFileSync(sourcePath, "utf8"), ts.ScriptTarget.Latest, true);
const factory = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "createSidecarRuntime");
assert(factory);
const compiled = ts.transpileModule(factory.getText(source).replace(/^export /, ""), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const createSidecarRuntime = new Function("IPC", "summarizeToolResult", `${compiled}; return createSidecarRuntime;`)(IPC, summarizeToolResult);

function fixture(liveTurn) {
  const activeTurns = new Map(liveTurn ? [["s", liveTurn]] : []);
  const coordination = createSessionCoordination({ activeTurns, getMainWindow: () => null, getViewingSessionId: () => null });
  const sent = [], ingested = [], persisted = [], logs = [];
  const runtimeState = { agentHostBridge: { ingest: (row) => ingested.push(row) } };
  const runtime = createSidecarRuntime({
    runtimeState, activeTurns, isStaleTerminalEvent: coordination.isStaleTerminalEvent,
    isTurnDispatchable: coordination.isTurnDispatchable,
    sendToRenderer: (_channel, row) => sent.push(row),
    persistAgentEvent: (row) => { persisted.push(row); return undefined; },
    logger: { app: (...args) => logs.push(args) },
  });
  const envelope = (event, turnId = "old", extra = {}) => ({ sessionId: "s", turnId, ts: 1, event, ...extra });
  return { ...runtime, coordination, activeTurns, sent, ingested, persisted, logs, envelope };
}

test("failed courseware tool keeps its safe reason and call identity through sidecar fan-out", () => {
  const f = fixture("new");
  let notify;
  f.wireSidecar({ onNotification: callback => { notify = callback; }, onExit() {} });
  notify("agent.event", f.envelope({ type: "tool_start", toolCallId: "call", toolName: "courseware_narration_propose", args: {} }, "new"));
  const end = f.envelope({ type: "tool_end", toolCallId: "call", isError: true,
    result: { content: [{ type: "text", text: "COURSEWARE_PAGE_CONTENT_MISMATCH: private lesson" }] } }, "new");
  notify("agent.event", end);
  const failure = f.logs.find(row => row[2] === "tool execution failed")[3];
  assert.equal(failure.code, "COURSEWARE_PAGE_CONTENT_MISMATCH");
  assert.equal(failure.toolCallId, "call");
  assert.equal(failure.turnId, "new");
  assert.equal(failure.data.toolName, "courseware_narration_propose");
  assert.doesNotMatch(JSON.stringify(f.logs), /private lesson/);
  assert.equal(f.persisted.at(-1), end);
  assert.equal(f.sent.at(-1), end);
});

for (const event of [
  { type: "agent_start" }, { type: "turn_start" },
  { type: "status", status: { isRunning: true } },
  { type: "status", status: { isRunning: false } },
]) test(`late ${event.type}/${event.status?.isRunning ?? "start"} cannot reactivate an aborted turn`, () => {
  const f = fixture();
  f.emitAgentEvent(f.envelope(event));
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.ingested, []);
});

test("old activity cannot overwrite a newer turn while current activity still flows", () => {
  const f = fixture("new");
  for (const event of [{ type: "turn_start" }, { type: "status", status: { isRunning: false } }]) f.emitAgentEvent(f.envelope(event));
  assert.deepEqual(f.sent, []);
  const current = f.envelope({ type: "turn_start" }, "new");
  f.emitAgentEvent(current);
  assert.deepEqual(f.sent, [current]);
  assert.deepEqual(f.ingested, [current]);
});

test("tool results and their history persistence survive stale activity filtering", () => {
  const f = fixture();
  let notify;
  f.wireSidecar({ onNotification: (callback) => { notify = callback; }, onExit() {} });
  const result = f.envelope({ type: "tool_end", toolCallId: "tool", result: "aborted", isError: true });
  notify("agent.event", f.envelope({ type: "turn_start" }));
  notify("agent.event", result);
  assert.deepEqual(f.sent, [result]);
  assert.deepEqual(f.persisted, [f.envelope({ type: "turn_start" }), result]);
});

test("unrelated delegate and legacy untagged activity keep their existing delivery", () => {
  const f = fixture();
  const delegate = f.envelope({ type: "turn_start" }, "delegate", { parentToolCallId: "parent" });
  const legacy = f.envelope({ type: "status", status: { isRunning: false } }, undefined);
  delete legacy.turnId;
  f.emitAgentEvent(delegate); f.emitAgentEvent(legacy);
  assert.deepEqual(f.sent, [delegate, legacy]);
});

for (const phase of ["aborting", "finalizing"]) {
  for (const event of [
    { type: "agent_start" }, { type: "turn_start" },
    { type: "status", status: { isRunning: true } },
    { type: "status", status: { isRunning: false } },
  ]) test(`${phase} current-turn ${event.type}/${event.status?.isRunning ?? "start"} cannot revive activity`, () => {
    const f = fixture("old");
    if (phase === "aborting") f.coordination.lockAbortReason("s", "old");
    else f.coordination.turnFinalizations.set(f.coordination.planSubmissionTurnKey("s", "old"), Promise.resolve());
    assert.equal(f.coordination.isActiveTurn("s", "old"), true);
    f.emitAgentEvent(f.envelope(event));
    assert.deepEqual(f.sent, []);
    assert.deepEqual(f.ingested, []);
    const result = f.envelope({ type: "tool_end", toolCallId: "tool", result: "aborted", isError: true });
    f.emitAgentEvent(result);
    assert.deepEqual(f.sent, [result]);
  });
}
