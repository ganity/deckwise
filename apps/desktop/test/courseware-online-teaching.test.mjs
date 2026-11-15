import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as shared from "@pi-desktop/shared";

const require = createRequire(import.meta.url), exports = {};
new Function("require", "exports", ts.transpileModule(await readFile(new URL("../electron/main/courseware-online-teaching.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(id => id === "@pi-desktop/shared" ? shared : id.startsWith("node:") ? require(id) : assert.fail(`Unexpected dependency: ${id}`), exports);
const { CoursewareOnlineTeachingCoordinator, assertOnlineNarrationEdits } = exports;
const ownerId = "11111111-1111-4111-8111-111111111111", projectId = "22222222-2222-4222-8222-222222222222";
const source = { revision: "33333333-3333-4333-8333-333333333333", sha256: "a".repeat(64) };
const token = "44444444-4444-4444-8444-444444444444";
const clone = value => structuredClone(value);
const remoteTeaching = () => ({ mappingRevision: "mapping-1", project: {
  schemaVersion: "deckwise-courseware/1", projectId, title: "Lesson", taskType: "plain", source: clone(source), teachingRevision: "revision-1",
  pages: [{ pageId: "page-1", locked: false, reviewState: "ready", actions: [
    { id: "speech-1", type: "speech", text: "Hello", audioAssetId: "tts-original", durationMs: 2000,
      visualCues: [{ id: "cue-1", atMs: 0, endMs: 1000, effect: { type: "highlight", elementIds: ["object-1"] } }] },
    { id: "checkpoint-1", type: "interaction_checkpoint", checkpointId: "continue-1", checkpointKind: "teacher_continue" },
    { id: "music-1", type: "audio_clip", audioAssetId: "music-existing" },
  ] }, { pageId: "page-2", locked: false, reviewState: "ready", actions: [{ id: "speech-2", type: "speech", text: "Second page" }] }],
} });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture() {
  const f = { remote: remoteTeaching(), binding: { ownerId, projectId, sessionEpoch: 1, source: clone(source) }, principalCurrent: true,
    calls: [], loseWrite: false, releaseError: null, renewError: null, writeError: null, receipts: new Map(), writes: 0,
    lease: { projectId, pageId: "page-1", sessionEpoch: 1, leaseEpoch: 1, leaseToken: token, expiresAtEpochMillis: Date.now() + 60_000 } };
  f.client = {
    async current(id) { f.calls.push(["current", id]); return { projectId: id, epoch: 1, active: true, sessionId: "fixture-document" }; },
    async currentTeaching(id) { f.calls.push(["currentTeaching", id]); return clone(f.remote); },
    async acquirePageLease(...args) { f.calls.push(["acquire", ...args]); return clone(f.lease); },
    async renewPageLease(...args) { f.calls.push(["renew", ...args]); if (f.renewError) throw f.renewError; return clone(f.lease); },
    async releasePageLease(...args) { f.calls.push(["release", ...args]); if (f.releaseError) throw f.releaseError; },
    async writeTeaching(id, input) {
      f.calls.push(["write", id, clone(input)]);
      if (f.receipts.has(input.requestId)) { assert.deepEqual(input, f.receipts.get(input.requestId).input); return clone(f.receipts.get(input.requestId).result); }
      if (f.writeError) throw f.writeError;
      assert.equal(input.write.expectedTeachingRevision, f.remote.project.teachingRevision);
      f.remote.project.pages.find(page => page.pageId === input.write.pageId).actions = clone(input.write.actions);
      f.remote.project.pages.find(page => page.pageId === input.write.pageId).reviewState = "review";
      f.remote.project.teachingRevision = `revision-${++f.writes + 1}`;
      f.receipts.set(input.requestId, { input: clone(input), result: clone(f.remote) });
      if (f.loseWrite) { f.loseWrite = false; throw new Error("response-lost"); }
      return clone(f.remote);
    },
  };
  f.main = new CoursewareOnlineTeachingCoordinator({ binding(id) { assert.equal(id, ownerId); return clone(f.binding); }, client: () => f.client,
    principal: () => ({ assertCurrent() { if (!f.principalCurrent) throw new Error("AUTH_CHANGED"); } }) });
  f.ready = async () => f.main.acquire((await f.main.read(ownerId)).viewId);
  f.actions = text => { const actions = clone(f.remote.project.pages[0].actions); actions[0] = shared.replaceNarrationText(actions[0], text); return actions; };
  f.callsFor = name => f.calls.filter(row => row[0] === name);
  return f;
}

test("read, acquire, whole-project CAS save, renew and release keep authority in Main", async () => {
  const f = fixture(), initial = await f.main.read(ownerId);
  assert.equal(initial.pageId, "page-1"); assert.equal(initial.pageNumber, 1); assert.equal(initial.leaseExpiresAtEpochMillis, undefined);
  const leased = await f.main.acquire(initial.viewId);
  assert.equal(leased.leaseExpiresAtEpochMillis, f.lease.expiresAtEpochMillis);
  const actions = f.actions("Updated");
  const saved = await f.main.save(leased.viewId, actions);
  assert.notEqual(saved.viewId, leased.viewId); assert.equal(saved.project.teachingRevision, "revision-2");
  assert.equal(saved.project.pages[0].actions[0].audioAssetId, undefined);
  assert.deepEqual(saved.project.pages[0].actions.slice(1), initial.project.pages[0].actions.slice(1));
  assert.equal((await f.main.renew(saved.viewId)).leaseExpiresAtEpochMillis, f.lease.expiresAtEpochMillis);
  const released = await f.main.release(saved.viewId);
  assert.equal(released.leaseExpiresAtEpochMillis, undefined);
  for (const view of [initial, leased, saved, released]) {
    assert(!JSON.stringify(view).includes(token)); assert.equal(Object.hasOwn(view, "lease"), false);
    assert.equal(Object.hasOwn(view, "pending"), false); assert.equal(Object.hasOwn(view, "principal"), false);
  }
  assert.equal((await f.main.read(ownerId, "page-2")).pageNumber, 2);
  await assert.rejects(f.main.save(leased.viewId, actions), /TEACHING_CHANGED/);
});

test("acquire refuses a changed mapping even when selected page contents are identical and releases its lease", async () => {
  const f = fixture(), view = await f.main.read(ownerId);
  f.remote.mappingRevision = "mapping-2";
  await assert.rejects(f.main.acquire(view.viewId), /TEACHING_CONFLICT/);
  assert.equal(f.callsFor("release").length, 1);
  assert.equal((await f.main.read(ownerId)).mappingRevision, "mapping-2");
});

test("renew while acquire is pending reports busy instead of pretending its old deadline was renewed", async () => {
  const f = fixture(), view = await f.main.read(ownerId), pending = deferred();
  f.client.acquirePageLease = async (...args) => { f.calls.push(["acquire", ...args]); return pending.promise; };
  const acquiring = f.main.acquire(view.viewId);
  try { await assert.rejects(f.main.renew(view.viewId), /TEACHING_BUSY/); }
  finally { pending.resolve(clone(f.lease)); await acquiring; }
  assert.equal(f.callsFor("renew").length, 0);
});

test("save rebases only an unchanged target page and mapping, refusing page/source/lock conflicts", async () => {
  const f = fixture(), view = await f.ready();
  f.remote.project.pages[1].actions[0].text = "Other writer"; f.remote.project.teachingRevision = "revision-remote";
  const saved = await f.main.save(view.viewId, f.actions("My update"));
  assert.equal(f.callsFor("write")[0][2].write.expectedTeachingRevision, "revision-remote");
  assert.equal(saved.project.pages[1].actions[0].text, "Other writer");
  for (const mutate of [remote => { remote.mappingRevision = "mapping-2"; }, remote => { remote.project.source.revision = ownerId; },
    remote => { remote.project.pages[0].locked = true; }, remote => { remote.project.pages[0].actions[0].text = "Concurrent target edit"; }]) {
    const changed = fixture(), pin = await changed.ready(), actions = changed.actions("Draft"); mutate(changed.remote);
    await assert.rejects(changed.main.save(pin.viewId, actions), /TEACHING_CONFLICT/);
    assert.equal(changed.callsFor("write").length, 0);
  }
});

test("lost accepted write replays the original request/body exactly and rejects a different draft", async () => {
  const f = fixture(), view = await f.ready(), actions = f.actions("Accepted before response loss");
  f.loseWrite = true;
  await assert.rejects(f.main.save(view.viewId, actions), error => error.message === "COURSEWARE_ONLINE_TEACHING_PENDING_WRITE" && error.cause?.message === "response-lost");
  const first = clone(f.callsFor("write")[0][2]);
  await assert.rejects(f.main.save(view.viewId, f.actions("Different draft")), /PENDING_WRITE/);
  await assert.rejects(f.main.release(view.viewId), /TEACHING_BUSY/);
  const clock = Date.now;
  let recovered;
  try { Date.now = () => f.lease.expiresAtEpochMillis + 1; recovered = await f.main.save(view.viewId, actions); }
  finally { Date.now = clock; }
  assert.deepEqual(f.callsFor("write")[1][2], first); assert.equal(f.writes, 1);
  assert.equal(recovered.project.pages[0].actions[0].text, "Accepted before response loss");
  await f.main.release(recovered.viewId);
});

test("definite stale write rejection clears pending intent for an explicitly corrected retry", async () => {
  const f = fixture(), view = await f.ready();
  f.writeError = new Error("COURSEWARE_ONLINE_PLATFORM_46603");
  await assert.rejects(f.main.save(view.viewId, f.actions("First")), /PLATFORM_46603/);
  const first = f.callsFor("write")[0][2].requestId;
  f.writeError = null;
  await f.main.save(view.viewId, f.actions("Corrected"));
  assert.notEqual(f.callsFor("write")[1][2].requestId, first);
});

test("only uncertain write submission is a pending write; preflight, invalid request and result conflicts keep their own errors", async () => {
  const beforeSubmit = fixture(), view = await beforeSubmit.ready();
  beforeSubmit.client.currentTeaching = async () => { throw new Error("preflight-failed"); };
  await assert.rejects(beforeSubmit.main.save(view.viewId, beforeSubmit.actions("Draft")), /preflight-failed/);
  await beforeSubmit.main.release(view.viewId);
  const invalid = fixture(), held = await invalid.ready();
  invalid.writeError = new Error("COURSEWARE_ONLINE_INVALID_REQUEST");
  await assert.rejects(invalid.main.save(held.viewId, invalid.actions("Too large")), /ONLINE_INVALID_REQUEST/);
  invalid.writeError = null;
  await invalid.main.save(held.viewId, invalid.actions("Valid draft"));
  const conflict = fixture(), owned = await conflict.ready();
  const actualWrite = conflict.client.writeTeaching;
  conflict.client.writeTeaching = async (...args) => ({ ...await actualWrite(...args), mappingRevision: "changed-mapping" });
  await assert.rejects(conflict.main.save(owned.viewId, conflict.actions("Draft")), /TEACHING_CONFLICT/);
  await conflict.main.release(owned.viewId);
  assert.equal((await conflict.main.read(ownerId)).pageId, "page-1");
});

test("expired lease cannot save or renew; stale release unblocks another page but an uncertain release retains authority for retry", async () => {
  const f = fixture(); f.lease.expiresAtEpochMillis = Date.now() - 1;
  const view = await f.ready();
  await assert.rejects(f.main.save(view.viewId, f.actions("Draft")), /LEASE_EXPIRED/);
  await assert.rejects(f.main.renew(view.viewId), /LEASE_EXPIRED/);
  f.releaseError = new Error("COURSEWARE_ONLINE_PLATFORM_46202");
  const released = await f.main.release(view.viewId);
  assert.equal(released.leaseExpiresAtEpochMillis, undefined);
  assert.equal((await f.main.read(ownerId, "page-2")).pageNumber, 2);
  const uncertain = fixture(), held = await uncertain.ready();
  uncertain.releaseError = new Error("response-lost");
  await assert.rejects(uncertain.main.release(held.viewId), /response-lost/);
  await assert.rejects(uncertain.main.read(ownerId), /TEACHING_BUSY/);
  uncertain.releaseError = new Error("COURSEWARE_ONLINE_PLATFORM_46202");
  await uncertain.main.release(held.viewId); await uncertain.main.read(ownerId);
});

test("read/acquire/save discard invalidated owner/session/principal while awaiting remote results", async () => {
  for (const operation of ["read", "acquire", "save"]) {
    for (const invalidate of [f => { f.main.invalidate(); }, f => { f.binding.sessionEpoch++; }, f => { f.principalCurrent = false; }]) {
      const f = fixture(), view = operation === "read" ? null : operation === "acquire" ? await f.main.read(ownerId) : await f.ready();
      const pending = deferred();
      if (operation === "acquire") f.client.acquirePageLease = () => pending.promise;
      else f.client.currentTeaching = () => pending.promise;
      const result = operation === "read" ? f.main.read(ownerId) : operation === "acquire" ? f.main.acquire(view.viewId) : f.main.save(view.viewId, f.actions("Draft"));
      if (operation === "read") await Promise.resolve();
      invalidate(f); pending.resolve(clone(operation === "acquire" ? f.lease : f.remote));
      await assert.rejects(result, /TEACHING_CHANGED|AUTH_CHANGED/);
      assert.equal(f.callsFor("write").length, 0);
    }
  }
});

test("narration edits preserve opaque actions and forbid injecting audio or cue authority", () => {
  const previous = remoteTeaching().project.pages[0].actions;
  const next = clone(previous); next[0] = shared.replaceNarrationText(next[0], "New text"); next[0].pauseAfterMs = 300;
  assert.doesNotThrow(() => assertOnlineNarrationEdits(previous, next));
  assert.doesNotThrow(() => assertOnlineNarrationEdits(previous, clone(previous)));
  for (const mutate of [actions => { actions[0].audioAssetId = "injected"; }, actions => { actions[0].visualCues = []; },
    actions => { actions[2].audioAssetId = "replaced"; }, actions => { actions.splice(1, 1); },
    actions => { actions.push({ id: "new-music", type: "audio_clip", audioAssetId: "injected" }); },
    actions => { actions[0].pauseAfterMs = 30001; }, actions => { actions[0].text = "x".repeat(2501); },
    actions => { actions.push({ id: "new-speech", type: "speech", text: "new", audioAssetId: "injected" }); }]) {
    const invalid = clone(next); mutate(invalid);
    assert.throws(() => assertOnlineNarrationEdits(previous, invalid), /INVALID_ACTIONS/);
  }
});
