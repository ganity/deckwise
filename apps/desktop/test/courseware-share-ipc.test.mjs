import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import ts from "typescript";
const protocol = {};
new Function("exports", ts.transpileModule(await readFile(new URL("../../../packages/shared/src/protocol.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(protocol);
const { IPC } = protocol;
import { Host } from "../../../scripts/e2e/host.mjs";

const source = await readFile(new URL("../electron/main/ipc/courseware-playback-ipc.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
const teamA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const teamB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

function setup(options = {}) {
  const handlers = new Map(), calls = [];
  let session = options.sessionId ?? "chat-1", currentHost, workspace = options.workspace ?? "/workspace", account = {};
  const store = options.store ?? { task: options.online ? null : { taskType: "plain" }, intent: null, onlineOrigin: options.online ? teamA : null };
  let task = store.task, prepare = async () => ({ files: [], manifestHash: "b".repeat(64) }), publish = async () => {}, query = async () => {}, bindingFailure = null;
  const selection = { snapshot: { projectId: options.online ? teamA : "office-1", snapshotId: "snapshot-1" }, build: { directory: "/private/build", buildId: "a".repeat(64) } };
  let origin = async () => ({ teamProjectId: store.onlineOrigin ?? null });
  let selected = async () => structuredClone(selection);
  const host = { onExit() { return () => {}; }, async call(method, params) {
    calls.push({ method, params: structuredClone(params) });
    if (options.host) return options.host.call(method, params);
    if (method === "courseware.snapshot.onlineOrigin") return origin(params);
    if (method === "courseware.task.get") return { task: structuredClone(task) };
    if (method === "courseware.fixedShare.get") return { intent: structuredClone(store.intent) };
    if (method === "courseware.fixedShare.prepare") {
      if (store.intent?.state === "unknown") throw new Error("Share result unknown; query before sharing again");
      store.intent = { intentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", state: "unknown", selection: structuredClone(params.selection), receiptAware: params.receiptAware ?? false };
      return { intent: structuredClone(store.intent) };
    }
    if (method === "courseware.fixedShare.complete") {
      if (bindingFailure) throw bindingFailure;
      assert.equal(params.intentId, store.intent.intentId);
      if (store.onlineOrigin) {
        assert.equal(store.intent.selection.projectId, store.onlineOrigin);
        assert.equal(store.intent.selection.teamProjectId, store.onlineOrigin);
        store.intent.state = "bound";
        return { intent: structuredClone(store.intent) };
      }
      if (!task) throw new Error("Select a courseware task first");
      if (task.teamProjectId && task.teamProjectId !== store.intent.selection.teamProjectId) throw new Error("Task bound to another team");
      task.teamProjectId = store.intent.selection.teamProjectId;
      store.intent.state = "bound";
      return { intent: structuredClone(store.intent) };
    }
    throw new Error(method);
  } };
  currentHost = host;
  const exports = {};
  new Function("require", "exports", outputText)((id) => {
    if (id === "node:path") return { dirname, join };
    if (id === "@pi-desktop/shared") return { IPC };
    if (id === "../courseware-fixed-build") return { CoursewareFixedBuildCoordinator: class {
      async selected(id) { if (id !== "preview-1") throw new Error("Preview expired"); return selected(); }
      cancel() { selected = async () => { throw new Error("Preview expired"); }; }
    } };
    if (id === "../courseware-player-preview") return { CoursewarePlayerPreview: class { close() {} } };
    if (id === "../courseware-build-files") return { async openCoursewareBuildUpload(...args) {
      calls.push({ method: "upload.read", args }); return prepare();
    } };
    throw new Error(id);
  }, exports);
  const cancel = exports.registerCoursewarePlaybackIpc({
    registrar: { ipcMain: {}, handleWithEvent(channel, handler) { handlers.set(channel, handler); },
      assertMainWindowSender(event) { if (event.sender !== "main") throw new Error("PERMISSION_DENIED"); } },
    getMainWindow: () => null, getHost: () => currentHost, getWorkspaceRoot: async () => workspace,
    getViewingSessionId: () => session, dataDir: "/private",
    authSession: { getCoursewarePrincipal() {
      const captured = account;
      return { key: "d".repeat(64), assertCurrent() { if (account !== captured) throw new Error("Account changed"); } };
    }, coursewareMedia: { async uploadAndPublishFixedBuild(...args) {
      calls.push({ method: "publish", args }); return publish(...args);
    }, async queryFixedBuildPublication(...args) { calls.push({ method: "query", args }); return query(...args); } } },
  });
  const payload = { previewId: "preview-1", projectId: teamA, sessionId: session };
  const share = (value = payload, ...extra) => handlers.get(IPC.invoke.coursewareFixedShare)({ sender: "main" }, value, ...extra);
  const recover = (intentId = store.intent?.intentId) => handlers.get(IPC.invoke.coursewareFixedShareRecover)({ sender: "main" }, { sessionId: session, intentId });
  const status = () => handlers.get(IPC.invoke.coursewareFixedShareStatus)({ sender: "main" }, { sessionId: session });
  return { calls, host, handlers, payload, share, cancel, recover, status, store,
    task: (value) => { task = value; store.task = value; }, readTask: () => structuredClone(task),
    prepare: (fn) => { prepare = fn; }, publish: (fn) => { publish = fn; },
    query: (fn) => { query = fn; }, failBinding: (error) => { bindingFailure = error; },
    session: (id) => { session = id; }, hostChanged: () => { currentHost = { ...host }; },
    accountChanged: () => { account = {}; },
    workspace: (value) => { workspace = value; }, selected: (fn) => { selected = fn; }, origin: (fn) => { origin = fn; } };
}

test("online snapshots share only to their original team without requiring or changing a local task", async () => {
  for (const channel of ["shared", "formal"]) {
    const f = setup({ online: true });
    await f.share({ ...f.payload, channel });
    assert.equal(f.readTask(), null);
    assert.equal(f.store.intent.state, "bound");
    assert.equal(f.calls.find(({ method }) => method === "publish").args[0], teamA);
    assert.equal(f.calls.find(({ method }) => method === "publish").args[4], channel);
    assert.deepEqual(f.calls.find(({ method }) => method === "courseware.snapshot.onlineOrigin").params,
      { sessionId: "chat-1", projectId: teamA, snapshotId: "snapshot-1" });
    assert(!f.calls.some(({ method }) => method === "courseware.task.get" || method === "courseware.task.bindTeam"));
    const conflicting = { taskType: "scene", teamProjectId: teamB, instruction: "Retain local task" };
    const g = setup({ online: true }); g.task(conflicting); await g.share();
    assert.deepEqual(g.readTask(), conflicting);
  }
});

test("online origin mismatch, missing origin and legacy unmarked snapshots fail before reading files or publishing", async () => {
  for (const scenario of [
    f => ({ ...f.payload, projectId: teamB }),
    f => { f.origin(async () => ({})); return f.payload; },
    f => { f.origin(async () => null); return f.payload; },
    f => { f.origin(async () => ({ teamProjectId: null })); return f.payload; },
    f => { f.selected(async () => ({ snapshot: { projectId: "office-1", snapshotId: "snapshot-1" }, build: { directory: "/private/build", buildId: "a".repeat(64) } })); return f.payload; },
  ]) {
    const f = setup({ online: true }); await assert.rejects(f.share(scenario(f)), /origin|team|task/i);
    assert(!f.calls.some(({ method }) => ["upload.read", "publish", "courseware.fixedShare.prepare"].includes(method)));
    assert.equal(f.store.intent, null); assert.equal(f.readTask(), null);
  }
});

test("online origin is rechecked after file reads and before journaling", async () => {
  const f = setup({ online: true }); f.prepare(async () => { f.store.onlineOrigin = null; return { files: [], manifestHash: "b".repeat(64) }; });
  await assert.rejects(f.share(), /task/);
  assert(!f.calls.some(({ method }) => method === "publish" || method === "courseware.fixedShare.prepare"));
  assert.equal(f.store.intent, null);
});

test("online unknown publication survives Main restart and recovers its exact receipt without a local task", async () => {
  const first = setup({ online: true }); first.publish(async () => { throw new Error("Lost response"); });
  await assert.rejects(first.share({ ...first.payload, channel: "formal" }), /unknown/);
  const saved = structuredClone(first.store.intent);
  const restarted = setup({ online: true, store: first.store });
  restarted.selected(async () => { throw new Error("Preview closed on restart"); });
  const result = await restarted.recover();
  assert.equal(result.intent.state, "bound"); assert.equal(restarted.readTask(), null);
  assert.deepEqual(restarted.calls.find(({ method }) => method === "query").args[0], saved.selection);
  assert.equal(restarted.calls.find(({ method }) => method === "query").args[2], saved.intentId);
  assert(!restarted.calls.some(({ method }) => ["publish", "upload.read", "courseware.task.get", "courseware.task.bindTeam"].includes(method)));
});

test("local reads fail before journaling; an unknown remote outcome blocks another POST and another team", async () => {
  const f = setup();
  f.prepare(async () => { throw new Error("Sharing failed"); });
  await assert.rejects(f.share(), /Sharing failed/);
  assert.equal(f.store.intent, null);
  f.prepare(async () => ({ files: [], manifestHash: "b".repeat(64) }));
  f.publish(async () => { throw new Error("Lost success response"); });
  await assert.rejects(f.share(), /result is unknown/);
  assert.equal(f.readTask().teamProjectId, undefined);
  await assert.rejects(f.share({ ...f.payload, projectId: teamB }), /unknown/);
  assert.equal(f.calls.filter(({ method }) => method === "publish").length, 1);
});

test("successful sharing validates first, publishes then durably binds the exact team", async () => {
  const f = setup();
  await f.share({ ...f.payload, channel: "formal" });
  assert.equal(f.calls.filter(({ method }) => method === "publish").length, 1);
  const published = f.calls.findIndex(({ method }) => method === "publish");
  const bound = f.calls.findIndex(({ method }) => method === "courseware.fixedShare.complete");
  assert(published >= 0 && bound > published);
  assert.equal(f.calls[published].args[0], teamA);
  assert.equal(f.calls[published].args[4], "formal");
  assert.equal(f.calls[published].args[6], f.store.intent.intentId);
  assert.equal(f.calls.find(({ method }) => method === "courseware.fixedShare.prepare").params.receiptAware, true);
  assert.deepEqual(f.calls[bound].params, { sessionId: "chat-1", principalKey: "d".repeat(64), intentId: f.store.intent.intentId });
  assert.equal(f.readTask().teamProjectId, teamA);
});

test("a conflicting or missing task refuses sharing before any file or network work", async () => {
  for (const task of [null, { taskType: "plain", teamProjectId: teamB }]) {
    const f = setup(); f.task(task);
    await assert.rejects(f.share(), /task|team/i);
    assert(!f.calls.some(({ method }) => ["upload.read", "publish", "courseware.task.bindTeam"].includes(method)));
  }
});

test("a prior binding survives a failed share and cannot be reassigned", async () => {
  const f = setup(); f.task({ taskType: "plain", teamProjectId: teamA });
  f.publish(async () => { throw new Error("Upload rejected"); });
  await assert.rejects(f.share(), /unknown/);
  assert.equal(f.readTask().teamProjectId, teamA);
  await assert.rejects(f.share({ ...f.payload, projectId: teamB }), /another team/);
  assert.equal(f.calls.filter(({ method }) => method === "publish").length, 1);
});

test("a concurrent share cannot publish into a second team while the first is pending", async () => {
  const f = setup(), gate = deferred(), began = deferred();
  f.publish(async () => { began.resolve(); await gate.promise; });
  const first = f.share(); await began.promise;
  try { await assert.rejects(f.share({ ...f.payload, projectId: teamB }), /already.*sharing|share.*running/i); }
  finally { gate.resolve(); await first; }
  assert.equal(f.calls.filter(({ method }) => method === "publish").length, 1);
  assert.equal(f.readTask().teamProjectId, teamA);
});

test("a changed Chat, account, Host, workspace or canceled preview cannot publish after file reads", async () => {
  for (const change of [(f) => f.session("other-chat"), (f) => f.accountChanged(), (f) => f.hostChanged(), (f) => f.workspace("/other"), (f) => f.cancel()]) {
    const f = setup();
    f.prepare(async () => { change(f); return { files: [] }; });
    await assert.rejects(f.share(), /changed|expired|canceled/i);
    assert(!f.calls.some(({ method }) => ["publish", "courseware.task.bindTeam"].includes(method)));
  }
});

test("late publication after owner changes never binds or reports success for the new owner", async () => {
  const f = setup();
  f.publish(async () => { f.session("other-chat"); });
  await assert.rejects(f.share(), (error) => /result is unknown/.test(error.message) && /changed/i.test(error.cause.message));
  assert.equal(f.readTask().teamProjectId, undefined);
});

test("a local binding failure after publication is explicit and never retries or rolls back the remote pointer", async () => {
  const f = setup(); f.failBinding(new Error("Local disk unavailable"));
  await assert.rejects(f.share(), (error) => /result is unknown/.test(error.message) && error.cause.message === "Local disk unavailable");
  assert.equal(f.calls.filter(({ method }) => method === "publish").length, 1);
  assert.equal(f.calls.filter(({ method }) => method === "courseware.fixedShare.complete").length, 1);
  f.failBinding(null); await f.recover();
  assert.equal(f.readTask().teamProjectId, teamA);
  assert.equal(f.calls.filter(({ method }) => method === "publish").length, 1);
});

test("cancel propagates to a pending upload without a local bind or another share dispatch", async () => {
  const f = setup(), began = deferred();
  f.publish(async (...args) => new Promise((_resolve, reject) => {
    const signal = args[5];
    assert(signal instanceof AbortSignal);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    began.resolve();
  }));
  const pending = f.share(); await began.promise; f.cancel();
  await assert.rejects(pending, (error) => /unknown/.test(error.message) && /canceled/.test(String(error.cause)));
  assert.equal(f.calls.filter(({ method }) => method === "publish").length, 1);
  assert.equal(f.readTask().teamProjectId, undefined);
});

test("share input is pinned before awaits; invalid IDs, extra fields and foreign senders have no effects", async () => {
  for (const change of [
    { projectId: "invalid" }, { previewId: "" }, { sessionId: "other-chat" },
    { channel: "other" }, { path: "/attacker/file" }, { channel: "shared", extra: true },
  ]) {
    const f = setup();
    await assert.rejects(f.share({ ...f.payload, ...change }));
    assert.equal(f.calls.length, 0);
  }
  const f = setup();
  await assert.rejects(f.share(f.payload, "extra"), /Unexpected/);
  await assert.rejects(f.handlers.get(IPC.invoke.coursewareFixedShare)({ sender: "other" }, f.payload), /PERMISSION_DENIED/);
  assert.equal(f.calls.length, 0);
  const gate = deferred(), began = deferred();
  f.selected(async () => { began.resolve(); await gate.promise; return { snapshot: { projectId: "office-1", snapshotId: "snapshot-1" }, build: { directory: "/private/build", buildId: "a".repeat(64) } }; });
  const pending = f.share(); await began.promise;
  f.payload.projectId = teamB; f.payload.sessionId = "other-chat"; gate.resolve();
  await pending;
  assert.equal(f.readTask().teamProjectId, teamA);
  assert.equal(f.calls.find(({ method }) => method === "publish").args[0], teamA);
});

test("real Host requires a persisted snapshot before dispatch and preserves binding absence across restart",
  { skip: !process.env.PI_DESKTOP_HOST_BIN }, async (t) => {
    const temp = await mkdtemp(join(tmpdir(), "deckwise-share-binding-"));
    const workspace = join(temp, "workspace"), data = join(temp, "data");
    await mkdir(workspace);
    await mkdir(join(data, "plugins/market"), { recursive: true });
    await writeFile(join(data, "plugins/market/catalog.json"), JSON.stringify({ schemaVersion: 2, providerId: "official", plugins: [] }));
    const host = new Host(process.env.PI_DESKTOP_HOST_BIN, data);
    t.after(async () => { await host.stop(); await rm(temp, { recursive: true, force: true }); });
    await host.start();
    const sessionId = (await host.call("session.create", { projectPath: workspace })).session.id;
    await host.call("courseware.task.set", { sessionId, taskType: "plain" });
    const failed = setup({ host, sessionId, workspace });
    await assert.rejects(failed.share(), /snapshot not found/);
    assert.equal(failed.calls.filter(({ method }) => method === "publish").length, 0);
    assert.equal((await host.call("courseware.task.get", { sessionId })).task.teamProjectId, undefined);
    await host.restart();
    assert.equal((await host.call("courseware.task.get", { sessionId })).task.teamProjectId, undefined);
    assert.equal((await host.call("courseware.fixedShare.get", { sessionId, principalKey: "d".repeat(64) })).intent, null);
  });

test("lost success receipt persists the original formal selection and a new Main recovers using GET only", async () => {
  const first = setup();
  first.publish(async () => { throw new Error("Connection lost after publication"); });
  await assert.rejects(first.share({ ...first.payload, channel: "formal" }), /unknown/);
  const unknown = await first.status();
  assert.equal(unknown.intent.state, "unknown");
  const restarted = setup({ store: first.store });
  restarted.selected(async () => { throw new Error("No preview after restart"); });
  const result = await restarted.recover();
  assert.equal(result.intent.state, "bound");
  assert.deepEqual(restarted.calls.find(({ method }) => method === "query").args[0], unknown.intent.selection);
  assert.equal(restarted.calls.find(({ method }) => method === "query").args[2], unknown.intent.intentId);
  assert.equal(unknown.intent.selection.channel, "formal");
  assert.equal(restarted.readTask().teamProjectId, teamA);
  assert.equal(restarted.calls.filter(({ method }) => method === "publish" || method === "upload.read").length, 0);
});

test("a legacy journal recovers only through the original pinned current pointer path", async () => {
  const f = setup(); f.publish(async () => { throw new Error("Lost legacy response"); });
  await assert.rejects(f.share(), /unknown/);
  delete f.store.intent.receiptAware;
  const restarted = setup({ store: f.store });
  await restarted.recover();
  assert.equal(restarted.calls.find(({ method }) => method === "query").args[2], undefined);
  assert.equal(restarted.store.intent.state, "bound");
  assert.equal(restarted.calls.filter(({ method }) => method === "publish").length, 0);
});

test("unavailable, revoked and competing remote results remain visible unknown and never dispatch publication", async () => {
  for (const reason of ["COURSEWARE_MEDIA_PLATFORM_46100", "COURSEWARE_MEDIA_TEAM_SHARE_NOT_CONFIRMED", "Offline"]) {
    const f = setup(); f.publish(async () => { throw new Error("Lost receipt"); });
    await assert.rejects(f.share(), /unknown/);
    const before = f.calls.filter(({ method }) => method === "publish").length;
    f.query(async () => { throw new Error(reason); });
    await assert.rejects(f.recover(), new RegExp(reason));
    assert.equal((await f.status()).intent.state, "unknown");
    assert.equal(f.readTask().teamProjectId, undefined);
    assert.equal(f.calls.filter(({ method }) => method === "publish").length, before);
    assert.equal(f.calls.filter(({ method }) => method === "courseware.fixedShare.complete").length, 0);
  }
});

test("recovery pins actor, session, workspace and Host across the remote GET before binding", async () => {
  for (const change of [(f) => f.accountChanged(), (f) => f.session("other"), (f) => f.workspace("/other"), (f) => f.hostChanged(), (f) => f.cancel()]) {
    const f = setup(); f.publish(async () => { throw new Error("Lost receipt"); });
    await assert.rejects(f.share(), /unknown/);
    f.query(async () => change(f));
    await assert.rejects(f.recover(), /changed|canceled/);
    assert.equal(f.store.intent.state, "unknown");
    assert.equal(f.readTask().teamProjectId, undefined);
    assert.equal(f.calls.filter(({ method }) => method === "courseware.fixedShare.complete").length, 0);
  }
});

test("recovery never rebinds a task concurrently associated with another team", async () => {
  const f = setup(); f.publish(async () => { throw new Error("Lost receipt"); });
  await assert.rejects(f.share(), /unknown/);
  f.query(async () => f.task({ taskType: "plain", teamProjectId: teamB }));
  await assert.rejects(f.recover(), /another team/);
  assert.equal(f.readTask().teamProjectId, teamB);
  assert.equal(f.store.intent.state, "unknown");
});
