import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../electron/main/courseware-media-canvas.ts", import.meta.url), "utf8");
const exports = {};
new Function("exports", ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText)(exports);
const { CoursewareMediaCanvasCoordinator } = exports;

function setup() {
  const calls = [];
  const state = { sessionId: "session-a", workspace: "/workspace", mode: "agent", permit: true };
  const host = { async call(method, params) {
    calls.push([method, params]);
    if (method === "session.get") return { session: { projectPath: state.sessionWorkspace ?? "/workspace", mode: state.mode } };
    return state.response ?? { revision: null, document: null };
  } };
  state.host = host;
  const coordinator = new CoursewareMediaCanvasCoordinator(() => state.host, () => state.sessionId, async () => state.workspace);
  return { state, host, calls, coordinator };
}

test("canvas coordinator derives canonical pre-PPTX scope and forwards only registered draft operations", async () => {
  const f = setup();
  const view = await f.coordinator.execute("session-a", "courseware_canvas_get", {}, () => f.state.permit);
  assert.deepEqual(view, { projectId: "canvas:session-a", revision: null, document: null });
  assert.deepEqual(f.calls, [["session.get", { id: "session-a" }], ["courseware.mediaCanvas.get", { sessionId: "session-a", projectId: "canvas:session-a" }]]);
  await assert.rejects(f.coordinator.execute("session-a", "generate_media", {}, () => true), /Unsupported/);
  await assert.rejects(f.coordinator.run("session-a", "get", { projectId: "forged" }), /Invalid/);
  await assert.rejects(f.coordinator.run("../session", "get", {}), /Invalid/);
});

test("canvas request content is frozen before asynchronous session validation", async () => {
  const f = setup();
  const document = { version: 1, projectId: "canvas:session-a", revision: 1, viewport: { x: 0, y: 0, zoom: 1 }, drafts: [] };
  const operation = f.coordinator.run("session-a", "set", { expectedRevision: null, document });
  document.projectId = "forged-after-submit";
  await operation;
  assert.equal(f.calls.at(-1)[1].document.projectId, "canvas:session-a");
  assert.equal(f.calls.at(-1)[1].expectedRevision, null);
});

test("canvas writes fail closed after session, workspace, mode, Host or turn changes", async () => {
  for (const change of [
    f => { f.state.sessionId = "session-b"; },
    f => { f.state.workspace = "/other"; },
    f => { f.state.sessionWorkspace = "/other"; },
    f => { f.state.mode = "plan"; },
    f => { f.state.host = null; },
    f => { f.state.permit = false; },
  ]) {
    const f = setup(); change(f);
    await assert.rejects(f.coordinator.run("session-a", "set", { expectedRevision: null, document: {} }, () => f.state.permit));
    assert.equal(f.calls.filter(([method]) => method === "courseware.mediaCanvas.set").length, 0);
  }
  const f = setup();
  const original = f.host.call;
  f.host.call = async (method, params) => {
    const result = await original(method, params);
    if (method === "session.get") f.state.sessionId = "session-b";
    return result;
  };
  await assert.rejects(f.coordinator.run("session-a", "get", {}), /changed/);
  assert.equal(f.calls.length, 1);
});

test("late and wrong-owner Host replies are rejected instead of updating the visible canvas", async () => {
  const f = setup();
  f.state.response = { revision: "r", document: { projectId: "canvas:other" } };
  await assert.rejects(f.coordinator.run("session-a", "get", {}), /Invalid saved/);
  f.state.response = { document: null };
  await assert.rejects(f.coordinator.run("session-a", "get", {}), /Invalid saved/);
  const original = f.host.call;
  f.host.call = async (method, params) => {
    const result = await original(method, params);
    if (method === "courseware.mediaCanvas.get") f.state.permit = false;
    return result;
  };
  await assert.rejects(f.coordinator.run("session-a", "get", {}, () => f.state.permit), /changed/);
});
