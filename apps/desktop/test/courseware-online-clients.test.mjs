import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const PROJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", CLIENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BARRIER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", PAUSE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const binding = { ownerId: CLIENT, projectId: PROJECT, sessionEpoch: 3, documentKey: "key-3", clientId: CLIENT,
  docsUserId: `tenant-1-user-2-client-${CLIENT}` };
const barrier = (state = "draining") => ({ projectId: PROJECT, sessionEpoch: 3, barrierId: BARRIER, pauseId: PAUSE, state,
  coverage: "managed", allRegisteredClientsHeld: false, authoritativeCoverage: false, consistentPublicationReady: false, proof: "client-reported",
  clients: [{ clientId: CLIENT, docsUserId: binding.docsUserId, state: "awaiting", nativeReady: true, lastSeenEpochMillis: Date.now() }], reasons: [] });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

function fixture(t, overrides = {}) {
  const timers = new Map(), calls = [], reports = [], nativeCalls = [];
  let timerId = 0, permitted = true, current = barrier(), nativeState = "held", capability = true;
  const exports = {};
  const source = ts.transpileModule(readFileSync(new URL("../electron/main/courseware-online-clients.ts", import.meta.url), "utf8"),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  new Function("exports", "setTimeout", "clearTimeout", source)(exports, callback => {
    timers.set(++timerId, callback); return timerId;
  }, id => timers.delete(id));
  const client = {
    async heartbeatNativeClient(...args) { calls.push(["heartbeat", ...args]); return structuredClone(current); },
    async getNativeBarrier(...args) { calls.push(["read", ...args]); return structuredClone(current); },
    async reportNativeBarrier(projectId, epoch, id, clientId, state, signal) {
      calls.push(["report", projectId, epoch, id, clientId, state, signal]); reports.push(state);
      const result = structuredClone(current ?? barrier());
      result.clients[0].state = state;
      return result;
    },
    async leaveNativeClient(...args) { calls.push(["leave", ...args]); return current; },
    ...overrides.client,
  };
  const worker = new exports.CoursewareOnlineClientsWorker({ binding, client,
    close(code) { calls.push(["close", code]); },
    assertCurrent() { if (!permitted) throw new Error("COURSEWARE_ONLINE_AUTH_CHANGED"); },
    async capability() { return { available: capability }; },
    async native(operation, id) {
      nativeCalls.push([operation, id]);
      return { barrierId: id, state: operation === "resume" ? "resumed" : nativeState, serverIndex: 9 };
    }, ...overrides.options });
  t.after(() => worker.stop());
  return { worker, client, calls, reports, nativeCalls, timers, revoke() { permitted = false; },
    current(value) { current = value; }, native(value) { nativeState = value; }, capability(value) { capability = value; } };
}

test("registered mount holds only after native drain acknowledgement, refreshes held evidence, then explicitly resumes", async t => {
  const f = fixture(t);
  await f.worker.poll();
  assert.deepEqual(f.reports, ["draining", "held"]);
  assert.deepEqual(f.nativeCalls, [["quiesce", BARRIER]]);
  assert.equal(f.worker.state().barrier.consistentPublicationReady, false);
  await f.worker.poll();
  assert.deepEqual(f.nativeCalls.at(-1), ["status", BARRIER]);
  assert.equal(f.reports.at(-1), "held");
  f.current(barrier("released")); await f.worker.poll();
  assert.deepEqual(f.nativeCalls.at(-1), ["resume", BARRIER]);
  assert.equal(f.reports.at(-1), "resumed");
  await f.worker.poll();
  assert.equal(f.nativeCalls.filter(([op]) => op === "resume").length, 1);
  f.worker.stop(); assert.equal(f.calls.at(-1)[0], "leave");
});

test("missing extension and uncertain native states never fabricate held or resume", async t => {
  const f = fixture(t); f.capability(false); await f.worker.poll();
  assert.deepEqual(f.reports, ["uncertain"]); assert.equal(f.nativeCalls.length, 0);
  f.capability(true); f.native("draining"); await f.worker.poll();
  assert.deepEqual(f.reports, ["uncertain", "draining", "draining"]);
  f.native("uncertain-held"); await f.worker.poll();
  assert.equal(f.reports.at(-1), "uncertain");
  assert.equal(f.nativeCalls.some(([op]) => op === "resume"), false);
});

test("native timeout reports uncertain, leaves the editor restricted, and checks status instead of replaying quiesce", async t => {
  let fail = true;
  const f = fixture(t, { options: { async native(operation, id) {
    if (fail) { fail = false; throw new Error("COURSEWARE_ONLINE_BARRIER_ACK_UNKNOWN"); }
    assert.equal(operation, "status"); return { barrierId: id, state: "held", serverIndex: 2 };
  } } });
  await f.worker.poll(); assert.deepEqual(f.reports, ["draining", "uncertain"]);
  assert.equal(f.worker.state().errorCode, "COURSEWARE_ONLINE_BARRIER_ACK_UNKNOWN");
  await f.worker.poll(); assert.deepEqual(f.reports.slice(-2), ["draining", "held"]);
});

test("a failed draining report is retried before entering native quiesce", async t => {
  const f = fixture(t); const report = f.client.reportNativeBarrier; let fail = true;
  f.client.reportNativeBarrier = async (...args) => { if (fail) { fail = false; throw new Error("offline"); } return report(...args); };
  await f.worker.poll(); assert.equal(f.nativeCalls.length, 0);
  await f.worker.poll(); assert.deepEqual(f.reports, ["draining", "held"]);
  assert.deepEqual(f.nativeCalls, [["quiesce", BARRIER]]);
});

test("account change and stop discard late replies, cancel their signals, and never resume", async t => {
  for (const kind of ["account", "stop"]) {
    const pending = deferred();
    const f = fixture(t, { client: { async heartbeatNativeClient() { return pending.promise; } } });
    const poll = f.worker.poll(); await Promise.resolve();
    if (kind === "account") f.revoke(); else f.worker.stop();
    pending.resolve(barrier()); await poll;
    assert.equal(f.nativeCalls.length, 0); assert.equal(f.reports.length, 0);
    if (kind === "account") { f.worker.stop(); assert.equal(f.calls.some(([op]) => op === "leave"), false); }
  }
});

test("poll reentry is serialized and mismatched project, epoch, client identity fail closed", async t => {
  const pending = deferred();
  let calls = 0;
  const f = fixture(t, { client: { async heartbeatNativeClient() { calls++; return pending.promise; } } });
  const first = f.worker.poll(); await Promise.resolve(); await f.worker.poll(); assert.equal(calls, 1);
  pending.resolve(null); await first;
  for (const change of [v => { v.projectId = CLIENT; }, v => { v.sessionEpoch++; }, v => { v.clients = []; },
    v => { v.clients[0].docsUserId = "tenant-1-user-3"; }]) {
    const one = fixture(t), value = barrier(); change(value); one.current(value); await one.worker.poll();
    assert.equal(one.worker.state().errorCode, "COURSEWARE_ONLINE_CLIENT_CHANGED");
    assert.equal(one.nativeCalls.length, 0); assert.equal(one.reports.length, 0);
  }
});

test("every registered window closes on permission refusal, while a temporary outage can recover", async t => {
  let error;
  const overrides = { client: { async heartbeatNativeClient() {
    if (error) throw new Error(error);
    return null;
  } } };
  const a = fixture(t, overrides), b = fixture(t, overrides);
  error = "COURSEWARE_ONLINE_HTTP_503";
  await Promise.all([a.worker.poll(), b.worker.poll()]);
  assert.equal(a.worker.state().errorCode, error);
  assert.equal(b.worker.state().errorCode, error);
  error = "COURSEWARE_ONLINE_PLATFORM_46102";
  await Promise.all([a.worker.poll(), b.worker.poll()]);
  for (const f of [a, b]) assert.deepEqual(f.calls.at(-1), ["close", "COURSEWARE_ONLINE_READ_ONLY"]);
  for (const [failure, reason] of [
    ["COURSEWARE_ONLINE_PLATFORM_46100", "ACCESS_CHANGED"], ["COURSEWARE_ONLINE_PLATFORM_46906", "ACCESS_CHANGED"],
    ["COURSEWARE_ONLINE_HTTP_401", "ACCESS_CHANGED"], ["COURSEWARE_ONLINE_HTTP_403", "ACCESS_CHANGED"],
    ["COURSEWARE_ONLINE_PLATFORM_46200", "SESSION_INACTIVE"],
  ]) {
    error = failure;
    const f = fixture(t, overrides);
    await f.worker.poll();
    assert.deepEqual(f.calls.at(-1), ["close", `COURSEWARE_ONLINE_${reason}`]);
  }
});

test("a permission refusal returned after the old window closes does not close a replacement", async t => {
  const pending = deferred();
  const f = fixture(t, { client: { async heartbeatNativeClient() {
    await pending.promise;
    throw new Error("COURSEWARE_ONLINE_PLATFORM_46100");
  } } });
  const poll = f.worker.poll();
  await Promise.resolve();
  f.worker.stop();
  pending.resolve();
  await poll;
  assert.equal(f.calls.some(([op]) => op === "close"), false);
});

test("lost current result cannot release a locally held barrier", async t => {
  const f = fixture(t); await f.worker.poll(); f.current(null);
  await f.worker.poll(); assert.equal(f.calls.at(-1)[0], "read");
  assert.equal(f.nativeCalls.some(([op]) => op === "resume"), false);
});

test("a mount that never entered native hold may report resumed only after the matching server release", async t => {
  const f = fixture(t); f.current(barrier("released")); await f.worker.poll();
  assert.deepEqual(f.reports, ["resumed"]); assert.equal(f.nativeCalls.length, 0);
});


test("capability timeout heartbeats unavailable and reports uncertainty without closing or resuming", async t => {
  const f = fixture(t, { options: { async capability() { throw new Error("COURSEWARE_ONLINE_BARRIER_ACK_UNKNOWN"); } } });
  await f.worker.poll();
  assert.equal(f.calls[0][0], "heartbeat"); assert.equal(f.calls[0][4], false);
  assert.deepEqual(f.reports, ["uncertain"]); assert.equal(f.nativeCalls.length, 0);
  assert.equal(f.worker.state().nativeReady, false);
  assert.equal(f.worker.state().errorCode, "COURSEWARE_ONLINE_BARRIER_ACK_UNKNOWN");
});


test("regained native capability re-enters draining before replacing a server uncertainty with a verified held report", async t => {
  const f = fixture(t); await f.worker.poll(); f.capability(false); await f.worker.poll();
  assert.equal(f.reports.at(-1), "uncertain");
  f.capability(true); await f.worker.poll();
  assert.deepEqual(f.reports.slice(-2), ["draining", "held"]);
  assert.equal(f.nativeCalls.at(-1)[0], "status");
});
