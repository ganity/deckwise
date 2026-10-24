import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
const require = createRequire(import.meta.url), exports = {};
new Function("require", "exports", ts.transpileModule(await readFile(new URL("../electron/main/courseware-online-barrier.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(id => id.startsWith("node:") ? require(id) : assert.fail(id), exports);
const { CoursewareOnlineBarrierCoordinator } = exports;
const clone = value => structuredClone(value);
const ownerId = "11111111-1111-4111-8111-111111111111", projectId = "22222222-2222-4222-8222-222222222222";
const source = { revision: "44444444-4444-4444-8444-444444444444", sha256: "a".repeat(64) };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture() {
  const f = { binding: { ownerId, projectId, sessionEpoch: 2, source }, current: true, calls: [], pause: null, barrier: null, lose: "" };
  const result = (kind, value) => { if (f.lose === kind) { f.lose = ""; throw new Error("response lost /private/token"); } return clone(value); };
  f.client = {
    async currentWritePause() { f.calls.push(["pause.read"]); return f.pause?.state === "held" ? clone(f.pause) : null; },
    async currentNativeBarrier() { f.calls.push(["barrier.read"]); return clone(f.barrier); },
    async pauseWrites(project, epoch, pauseId) {
      f.calls.push(["pause", project, epoch, pauseId]);
      if (!f.pause) f.pause = { projectId: project, sessionEpoch: epoch, pauseId, state: "held", teaching: { mappingRevision: "mapping-1", project: { projectId, source, teachingRevision: "r8" } } };
      assert.equal(f.pause.pauseId, pauseId); return result("pause", f.pause);
    },
    async startNativeBarrier(project, epoch, barrierId, pauseId) {
      f.calls.push(["start", project, epoch, barrierId, pauseId]);
      f.barrier ??= { projectId: project, sessionEpoch: epoch, barrierId, pauseId, state: "draining", coverage: "managed",
        clients: [{ state: "awaiting" }], allRegisteredClientsHeld: false, authoritativeCoverage: false, consistentPublicationReady: false, proof: "client-reported", reasons: [] };
      assert.equal(f.barrier.barrierId, barrierId); return result("start", f.barrier);
    },
    async releaseNativeBarrier(project, epoch, barrierId) { f.calls.push(["release", project, epoch, barrierId]); f.barrier.state = "released"; return result("release", f.barrier); },
    async resumeWrites(project, epoch, pauseId) { f.calls.push(["resume", project, epoch, pauseId]); assert.equal(f.barrier?.state ?? "released", "released"); f.pause.state = "released"; return result("resume", f.pause); },
  };
  f.main = new CoursewareOnlineBarrierCoordinator({ binding: () => clone(f.binding), client: () => f.client,
    principal: () => ({ assertCurrent() { if (!f.current) throw new Error("AUTH_CHANGED"); } }) });
  return f;
}

test("owner can inspect, pause registered windows, recheck held reports and explicitly resume in server order", async () => {
  const f = fixture(), idle = await f.main.read(ownerId);
  assert.equal(idle.state, "idle"); assert.equal(f.calls.some(row => row[0] === "pause"), false);
  const draining = await f.main.start(idle.viewId);
  assert.equal(draining.teachingPaused, true); assert.equal(draining.state, "draining");
  f.barrier.state = "held"; f.barrier.clients[0].state = "held"; f.barrier.allRegisteredClientsHeld = true;
  const held = await f.main.read(ownerId);
  assert.equal(held.held, 1); assert.equal(held.total, 1); assert.equal(held.consistentPublicationReady, false);
  assert(!JSON.stringify(held).includes(f.barrier.barrierId)); assert(!JSON.stringify(held).includes(f.pause.pauseId));
  const released = await f.main.resume(held.viewId);
  assert.equal(released.state, "released"); assert.equal(released.teachingPaused, false);
  assert.deepEqual(f.calls.slice(-2).map(row => row[0]), ["release", "resume"]);
});

test("lost pause/start responses retain exact identities for explicit replay; no read or cleanup silently releases", async () => {
  for (const kind of ["pause", "start"]) {
    const f = fixture(), view = await f.main.read(ownerId); f.lose = kind;
    await assert.rejects(f.main.start(view.viewId), /response lost/);
    await assert.rejects(f.main.resume(view.viewId), /BARRIER_UNCERTAIN/);
    const rechecked = await f.main.read(ownerId);
    if (kind === "pause") {
      assert.equal(rechecked.uncertain, true);
      await f.main.start(rechecked.viewId);
      const ids = f.calls.filter(row => row[0] === "pause").map(row => row[3]); assert.equal(new Set(ids).size, 1);
    } else { assert.equal(rechecked.state, "draining"); assert.equal(rechecked.uncertain, false); }
    assert(!f.calls.some(row => ["release", "resume"].includes(row[0])));
  }
});

test("lost release/resume receipts replay exact requests and preserve paused state", async () => {
  for (const kind of ["release", "resume"]) {
    const f = fixture(), view = await f.main.read(ownerId); await f.main.start(view.viewId); f.lose = kind;
    await assert.rejects(f.main.resume(view.viewId), /response lost/);
    const result = await f.main.resume(view.viewId); assert.equal(result.teachingPaused, false);
    const ids = f.calls.filter(row => row[0] === kind).map(row => row[3]); assert.equal(new Set(ids).size, 1);
  }
});

test("fresh Main can recover server held state and cannot resume a foreign pause, epoch or source", async () => {
  const f = fixture(), initial = await f.main.read(ownerId); await f.main.start(initial.viewId); f.main.invalidate();
  const recovered = await f.main.read(ownerId); assert.equal(recovered.teachingPaused, true); await f.main.resume(recovered.viewId);
  for (const mutate of [f => f.barrier.sessionEpoch++, f => f.barrier.pauseId = ownerId,
    f => f.pause.teaching.project.source = { ...source, sha256: "b".repeat(64) }, f => f.barrier.authoritativeCoverage = true]) {
    const g = fixture(), view = await g.main.read(ownerId); await g.main.start(view.viewId); mutate(g);
    await assert.rejects(g.main.read(ownerId), /BARRIER_CHANGED/);
  }
});

test("one operation at a time and account/mount changes reject delayed effects without automatic resume", async () => {
  for (const invalidate of [f => f.main.invalidate(), f => f.binding.sessionEpoch++, f => { f.current = false; }]) {
    const f = fixture(), view = await f.main.read(ownerId), pending = deferred(), real = f.client.pauseWrites;
    f.client.pauseWrites = () => pending.promise;
    const start = f.main.start(view.viewId);
    await assert.rejects(f.main.read(ownerId), /BARRIER_BUSY/);
    invalidate(f); pending.resolve(await real(projectId, 2, "test-pause"));
    await assert.rejects(start, /BARRIER_CHANGED|AUTH_CHANGED/);
    assert(!f.calls.some(row => ["start", "release", "resume"].includes(row[0])));
  }
});

test("a previous released barrier cannot replace an uncertain second start's identities after negative reads", async () => {
  const f = fixture(), first = await f.main.read(ownerId); await f.main.start(first.viewId); await f.main.resume(first.viewId);
  const old = clone(f.barrier); f.pause = null;
  const second = await f.main.read(ownerId); f.lose = "pause";
  await assert.rejects(f.main.start(second.viewId), /response lost/);
  const secondPause = clone(f.pause), negativeRead = f.client.currentWritePause;
  f.client.currentWritePause = async () => null;
  const uncertain = await f.main.read(ownerId);
  assert.equal(uncertain.uncertain, true); assert.equal(uncertain.state, "idle");
  f.client.currentWritePause = negativeRead;
  const checked = await f.main.read(ownerId);
  assert.equal(checked.uncertain, true); assert.equal(checked.state, "idle");
  const realStart = f.client.startNativeBarrier;
  f.client.startNativeBarrier = (...args) => { assert.notEqual(args[2], old.barrierId); assert.equal(args[3], secondPause.pauseId); f.barrier = null; return realStart(...args); };
  await f.main.start(checked.viewId);
  assert.equal(f.pause.pauseId, secondPause.pauseId);
});

test("a competing pause cannot replace either identity of an uncertain request", async () => {
  const f = fixture(), view = await f.main.read(ownerId); f.lose = "pause";
  await assert.rejects(f.main.start(view.viewId), /response lost/);
  const ownPause = clone(f.pause), calls = f.calls.length;
  f.pause.pauseId = ownerId;
  await assert.rejects(f.main.read(ownerId), /BARRIER_CHANGED/);
  assert.equal(f.calls.length, calls + 2);
  f.pause = ownPause;
  await f.main.start(view.viewId);
  assert.equal(f.calls.filter(row => row[0] === "pause").at(-1)[3], ownPause.pauseId);
});

test("an Owner can recover and release a server pause without joining an admission-frozen editor", async () => {
  const f = fixture(), initial = await f.main.read(ownerId); await f.main.start(initial.viewId);
  const selection = { ownerId, projectId };
  f.client.current = async () => ({ projectId, active: true, epoch: 2, sessionId: "native-key" });
  f.client.currentSource = async () => ({ projectId, source });
  const { CoursewareOnlineBarrierCoordinator: Coordinator } = exports;
  const recovery = new Coordinator({ binding() { throw new Error("native not mounted"); }, selection: () => clone(selection),
    client: () => f.client, principal: () => ({ assertCurrent() {} }) });
  const view = await recovery.read(ownerId);
  assert.equal(view.canStart, false); assert.equal(view.teachingPaused, true);
  await assert.rejects(recovery.start(view.viewId), /BARRIER_CHANGED/);
  assert.equal((await recovery.resume(view.viewId)).teachingPaused, false);
  assert.deepEqual(f.calls.slice(-2).map(row => row[0]), ["release", "resume"]);
});

test("a detached recovery read is pinned through awaits and cannot retarget a new account selection", async () => {
  const f = fixture(), pending = deferred(); let selected = { ownerId, projectId }, current = true;
  f.client.current = () => pending.promise; f.client.currentSource = async () => ({ projectId, source });
  const main = new CoursewareOnlineBarrierCoordinator({ binding() { throw new Error("not mounted"); }, selection: () => clone(selected),
    client: () => f.client, principal: () => ({ assertCurrent() { assert(current, "AUTH_CHANGED"); } }) });
  const read = main.read(ownerId); selected = { ownerId: projectId, projectId };
  pending.resolve({ projectId, epoch: 2, active: true }); await assert.rejects(read, /BARRIER_CHANGED/);
  assert.equal(f.calls.length, 0);
});
