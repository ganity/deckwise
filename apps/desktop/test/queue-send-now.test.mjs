import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";
import ts from "typescript";
import { IPC } from "@pi-desktop/shared";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const queued = await import("../src/lib/queued-prompts.ts");
const { registerAgentIpc } = await import("../electron/main/ipc/agent-ipc.ts");
const { createSessionCoordination } = await import("../electron/main/runtime/session-coordination.ts");

test("Send now delivers queued input without stopping the turn that receives it", async () => {
  const calls = [], exports = {};
  const api = {
    async prioritizeQueuedPrompt(id) { calls.push(["prioritize", id]); },
    async stop(id) { calls.push(["stop", id]); },
  };
  const compiled = ts.transpileModule(await readFile(new URL("../src/stores/slices/queue-slice.ts", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  new Function("require", "exports", compiled)(id => {
    if (id === "../../lib/api") return { api };
    if (id === "../../lib/queued-prompts") return queued;
    if (id === "i18next") return {};
    if (id === "../../lib/session-transcript") return {};
    throw new Error(id);
  }, exports);
  const state = { activeSessionId: "chat", runningSessions: { chat: true }, queuedPrompts: { chat: [{
    id: "correction", sessionId: "chat", content: "Stop submitting and report", createdAt: 1,
    draft: { text: "Stop submitting and report", fileReferences: [] },
  }] } };
  const slice = exports.createQueueSlice({ get: () => state,
    set: value => Object.assign(state, typeof value === "function" ? value(state) : value) });
  await slice.sendQueuedNow("correction");
  assert.deepEqual(calls, [["prioritize", "correction"]]);
});

test("graceful stop fences Main dispatch before the sidecar responds without aborting the turn", async () => {
  const activeTurns = new Map([["chat", "old-turn"]]);
  const coordination = createSessionCoordination({ activeTurns, getMainWindow: () => null, getViewingSessionId: () => null });
  const handlers = new Map();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  registerAgentIpc({
    registrar: { handle: (name, fn) => handlers.set(name, fn) },
    getHost: () => ({}), getAgentHostBridge: () => null,
    getSidecar: () => ({ async call(method) { assert.equal(method, "agent.stop");
      assert.equal(coordination.isTurnDispatchable("chat", "old-turn"), false); await gate; return { requested: true }; } }),
    logger: { app() {} }, activeTurns, stopTurnDispatch: coordination.stopTurnDispatch,
  });
  const stopped = handlers.get(IPC.invoke.agentStop)({ sessionId: "chat", turnId: "old-turn" });
  assert.equal(coordination.isActiveTurn("chat", "old-turn"), true);
  assert.equal(coordination.peekAbortReason("chat", "old-turn"), undefined);
  release(); await stopped;
  coordination.releaseTurnClaims("chat", "old-turn");
  activeTurns.set("chat", "new-turn");
  assert.equal(coordination.isTurnDispatchable("chat", "new-turn"), true);
  await handlers.get(IPC.invoke.agentStop)({ sessionId: "chat", turnId: "old-turn" });
  assert.equal(coordination.isTurnDispatchable("chat", "new-turn"), true);
});
