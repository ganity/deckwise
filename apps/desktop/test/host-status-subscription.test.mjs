import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS } }).outputText;
const flush = () => new Promise(resolve => setImmediate(resolve));
const status = { ok: false, fatal: true, message: "DB_SCHEMA_TOO_NEW", schema: { found: 25, supported: 24 } };

function fixture() {
  let event, resolve, reject;
  const calls = [], result = new Promise((yes, no) => { resolve = yes; reject = no; });
  const window = { piDesktop: {
    invoke(channel) { calls.push(channel); return result; },
    on(channel, listener) { assert.equal(channel, "host-status-event"); event = listener; return () => { event = undefined; }; },
  } };
  const exports = {};
  new Function("require", "exports", "window", compiled)(id => {
    assert.equal(id, "@pi-desktop/shared");
    return { IPC: { event: { hostStatus: "host-status-event" }, invoke: { appHostStatus: "host-status-read" } } };
  }, exports, window);
  return { api: exports.api, calls, emit: value => event(value),
    resolve: value => resolve({ ok: true, data: value }), reject, hasListener: () => !!event };
}

test("a late shell subscriber receives the actual retained boot failure", async () => {
  const f = fixture(), received = [];
  const off = f.api.onHostStatus(value => received.push(value));
  assert.deepEqual(f.calls, ["host-status-read"]);
  f.resolve(status); await flush(); assert.deepEqual(received, [{ ...status, restarted: false }]); off();
});

test("a newer live recovery wins over a held stale status read", async () => {
  const f = fixture(), received = [];
  const off = f.api.onHostStatus(value => received.push(value));
  f.emit({ ok: true, restarted: true }); f.resolve(status); await flush();
  assert.deepEqual(received, [{ ok: true, restarted: true }]); off();
});

test("unmount fences the held read and a null initial status does not invent a failure", async () => {
  const f = fixture(), received = [];
  const off = f.api.onHostStatus(value => received.push(value)); off();
  f.resolve(status); await flush(); assert.deepEqual(received, []); assert.equal(f.hasListener(), false);
  const empty = fixture(); const stop = empty.api.onHostStatus(value => received.push(value));
  empty.resolve(null); await flush(); assert.deepEqual(received, []); stop();
});

test("status read failure keeps live subscription and retained restart state does not replay success effects", async () => {
  const f = fixture(), received = [];
  const off = f.api.onHostStatus(value => received.push(value));
  f.reject(new Error("bridge closed")); await flush(); f.emit(status);
  assert.deepEqual(received, [status]); off();
  const restored = fixture(); const stop = restored.api.onHostStatus(value => received.push(value));
  restored.resolve({ ok: true, restarted: true }); await flush();
  assert.equal(received[1].ok, true); assert.equal(received[1].restarted, false); stop();
});
