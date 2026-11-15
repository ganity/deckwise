import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url), exports = {};
new Function("require", "exports", ts.transpileModule(await readFile(new URL("../electron/main/courseware-online-pause.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(id => id.startsWith("node:") ? require(id) : assert.fail(`Unexpected dependency: ${id}`), exports);
const { CoursewareOnlinePauseCoordinator } = exports;
const clone = value => structuredClone(value);
const ownerId = "11111111-1111-4111-8111-111111111111", projectId = "22222222-2222-4222-8222-222222222222";
const pauseId = "33333333-3333-4333-8333-333333333333";
const source = { revision: "44444444-4444-4444-8444-444444444444", sha256: "a".repeat(64) };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture() {
  const f = { binding: { ownerId, projectId, sessionEpoch: 2, source: clone(source) }, current: true, calls: [], loss: false,
    pause: { projectId, sessionEpoch: 2, pauseId, state: "held", teaching: { mappingRevision: "mapping-1",
      project: { projectId, source: clone(source), teachingRevision: "teaching-8" } } } };
  f.client = {
    async currentWritePause(...args) { f.calls.push(["read", ...args]); return f.pause?.state === "held" ? clone(f.pause) : null; },
    async resumeWrites(...args) {
      f.calls.push(["resume", ...args]); f.pause.state = "released";
      if (f.loss) { f.loss = false; throw new Error("response-lost private-url"); }
      return clone(f.pause);
    },
  };
  f.main = new CoursewareOnlinePauseCoordinator({
    binding(id) { assert.equal(id, ownerId); return clone(f.binding); }, client: () => f.client,
    principal: () => ({ assertCurrent() { if (!f.current) throw new Error("AUTH_CHANGED"); } }),
  });
  return f;
}

test("a fresh coordinator discovers the durable held pause without a local pause id and resumes only that captured version", async () => {
  const f = fixture(), view = await f.main.read(ownerId);
  assert.deepEqual(Object.keys(view).sort(), ["ownerId", "viewId", "sessionEpoch", "teachingRevision"].sort());
  assert.equal(view.teachingRevision, "teaching-8");
  assert(!JSON.stringify(view).includes(pauseId)); assert(!JSON.stringify(view).includes(source.sha256));
  assert.deepEqual(f.calls, [["read", projectId, 2]]);
  assert.deepEqual(await f.main.resume(view.viewId), { ok: true });
  assert.deepEqual(f.calls.at(-1), ["resume", projectId, 2, pauseId]);
  await assert.rejects(f.main.resume(view.viewId), /PAUSE_CHANGED/);
  assert.equal(await f.main.read(ownerId), null);
});

test("response loss retains exact resume authority for explicit idempotent replay without creating a new pause", async () => {
  const f = fixture(), view = await f.main.read(ownerId);
  f.loss = true;
  await assert.rejects(f.main.resume(view.viewId), /response-lost/);
  assert.deepEqual(await f.main.resume(view.viewId), { ok: true });
  assert.deepEqual(f.calls.filter(row => row[0] === "resume"), [["resume", projectId, 2, pauseId], ["resume", projectId, 2, pauseId]]);
});

test("a new read after an uncertain resume can establish released state and expires the old UI selector", async () => {
  const f = fixture(), view = await f.main.read(ownerId); f.loss = true;
  await assert.rejects(f.main.resume(view.viewId));
  assert.equal(await f.main.read(ownerId), null);
  await assert.rejects(f.main.resume(view.viewId), /PAUSE_CHANGED/);
  assert.equal(f.calls.filter(row => row[0] === "resume").length, 1);
});

test("discovery refuses project, epoch, source and non-held responses before granting resume authority", async () => {
  for (const mutate of [pause => { pause.projectId = ownerId; }, pause => { pause.sessionEpoch++; },
    pause => { pause.teaching.project.projectId = ownerId; }, pause => { pause.teaching.project.source.sha256 = "b".repeat(64); },
    pause => { pause.teaching.project.source.revision = ownerId; }, pause => { pause.state = "released"; }]) {
    const f = fixture(); mutate(f.pause);
    f.client.currentWritePause = async () => clone(f.pause);
    await assert.rejects(f.main.read(ownerId), /PAUSE_CHANGED/);
    await assert.rejects(f.main.resume(ownerId), /PAUSE_CHANGED/);
    assert.equal(f.calls.length, 0);
  }
});

test("resume rejects a mismatched server receipt and keeps the original proof for retry", async () => {
  for (const mutate of [pause => { pause.pauseId = ownerId; }, pause => { pause.state = "held"; },
    pause => { pause.teaching.project.teachingRevision = "wrong-version"; }, pause => { pause.teaching.mappingRevision = "wrong-mapping"; },
    pause => { pause.sessionEpoch++; }]) {
    const f = fixture(), view = await f.main.read(ownerId), actual = f.client.resumeWrites;
    f.client.resumeWrites = async (...args) => { const value = await actual(...args); mutate(value); return value; };
    await assert.rejects(f.main.resume(view.viewId), /PAUSE_CHANGED/);
    f.client.resumeWrites = actual;
    assert.deepEqual(await f.main.resume(view.viewId), { ok: true });
  }
});

test("an invalidated account, mount or epoch rejects stale results and selectors around every await", async () => {
  for (const operation of ["read", "resume"]) {
    for (const invalidate of [f => f.main.invalidate(), f => { f.binding.sessionEpoch++; }, f => { f.current = false; }]) {
      const f = fixture(), view = operation === "resume" ? await f.main.read(ownerId) : null, pending = deferred();
      if (operation === "read") f.client.currentWritePause = () => pending.promise;
      else f.client.resumeWrites = () => pending.promise;
      const result = operation === "read" ? f.main.read(ownerId) : f.main.resume(view.viewId);
      invalidate(f); pending.resolve({ ...clone(f.pause), state: operation === "read" ? "held" : "released" });
      await assert.rejects(result, /PAUSE_CHANGED|AUTH_CHANGED/);
    }
  }
  const f = fixture(), view = await f.main.read(ownerId); f.binding.sessionEpoch++;
  await assert.rejects(f.main.resume(view.viewId), /PAUSE_CHANGED/);
  assert.equal(f.calls.filter(row => row[0] === "resume").length, 0);
});

test("one recovery operation at a time retains authority through network failure", async () => {
  const f = fixture(), view = await f.main.read(ownerId), pending = deferred();
  f.client.resumeWrites = () => pending.promise;
  const resuming = f.main.resume(view.viewId);
  await assert.rejects(f.main.read(ownerId), /PAUSE_BUSY/);
  await assert.rejects(f.main.resume(view.viewId), /PAUSE_BUSY/);
  pending.resolve({ ...clone(f.pause), state: "released" }); await resuming;
});
