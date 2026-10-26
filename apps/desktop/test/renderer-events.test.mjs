import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import * as shared from "../../../packages/shared/dist/index.js";

const source = await readFile(new URL("../electron/main/runtime/renderer-events.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;
const exports = {};
new Function("require", "exports", compiled)((id) => {
  assert.equal(id, "@pi-desktop/shared"); return shared;
}, exports);
const { createRendererEventSender } = exports;

function fixture() {
  const sent = [], state = { hostStatus: null };
  let pluginChanges = 0;
  let window = { isDestroyed: () => false, webContents: {
    isDestroyed: () => false, send: (...args) => sent.push(args),
  } };
  const send = createRendererEventSender({ getWindow: () => window, state,
    onPluginChanged: () => pluginChanges++ });
  return { send, state, sent, get window() { return window; },
    set window(value) { window = value; }, get pluginChanges() { return pluginChanges; } };
}

test("a missing window retains failure and later recovery without inventing an initial status", () => {
  const f = fixture(); assert.equal(f.state.hostStatus, null); f.window = null;
  const failure = { ok: false, fatal: true, message: "DB_SCHEMA_TOO_NEW", schema: { found: 25, supported: 24 } };
  f.send(shared.IPC.event.hostStatus, failure);
  assert.deepEqual(f.state.hostStatus, failure); assert.deepEqual(f.sent, []);
  f.send(shared.IPC.event.hostStatus, { ok: true, restarted: true });
  assert.deepEqual(f.state.hostStatus, { ok: true, restarted: true });
});

test("only whitelisted events reach the attached window", () => {
  const f = fixture(), payload = { ok: true };
  f.send("untrusted-arbitrary-channel", payload); assert.deepEqual(f.sent, []);
  f.send(shared.IPC.event.hostStatus, payload);
  assert.deepEqual(f.sent, [[shared.IPC.event.hostStatus, payload]]);
});

test("destroyed windows and frames drop sends but keep the latest runtime state", () => {
  for (const destroyed of ["window", "frame"]) {
    const f = fixture();
    if (destroyed === "window") f.window.isDestroyed = () => true;
    else f.window.webContents.isDestroyed = () => true;
    f.send(shared.IPC.event.hostStatus, { ok: false });
    assert.deepEqual(f.state.hostStatus, { ok: false }); assert.deepEqual(f.sent, []);
  }
});

test("a frame disposed during send does not interrupt supervision or lose status", () => {
  const f = fixture(); f.window.webContents.send = () => { throw new Error("frame disposed"); };
  assert.doesNotThrow(() => f.send(shared.IPC.event.hostStatus, { ok: false, restarting: true }));
  assert.deepEqual(f.state.hostStatus, { ok: false, restarting: true });
});

test("native theme synchronization still runs for a plugin event without a renderer", () => {
  const f = fixture(); f.window = null;
  f.send(shared.IPC.event.pluginChanged, { reason: "changed" });
  assert.equal(f.pluginChanges, 1); assert.equal(f.state.hostStatus, null);
});
