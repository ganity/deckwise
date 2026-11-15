import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { IPC, IPC_WHITELIST } from "../../../packages/shared/dist/protocol.js";

const load = async (name, dependencies) => {
  const source = await readFile(new URL(`../electron/main/${name}.ts`, import.meta.url), "utf8");
  const exports = {};
  new Function("require", "exports", ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText)(id => { assert(Object.hasOwn(dependencies, id), id); return dependencies[id]; }, exports);
  return exports;
};
const { coursewareOnlineDeployment } = await load("courseware-online-deployment", {});
const pins = { DECKWISE_DOCS_ONLINE_ENTRY_URL: "https://office.test/wiseoffice/courseware-online.html",
  DECKWISE_DOCS_API_URL: "https://docs.test/web-apps/apps/api/documents/api.js" };

test("online deployment pins are installation-owned and explicitly unavailable until both origins are configured", () => {
  assert.equal(coursewareOnlineDeployment({}), null);
  assert.deepEqual(coursewareOnlineDeployment(pins), { hostUrl: pins.DECKWISE_DOCS_ONLINE_ENTRY_URL, apiUrl: pins.DECKWISE_DOCS_API_URL });
  assert.equal(coursewareOnlineDeployment({ DECKWISE_DOCS_ONLINE_ENTRY_URL: "http://127.0.0.1:4410/courseware-online.html",
    DECKWISE_DOCS_API_URL: "http://localhost:4411/web-apps/apps/api/documents/api.js" }).hostUrl, "http://127.0.0.1:4410/courseware-online.html");
  assert.equal(coursewareOnlineDeployment({ ...pins,
    DECKWISE_DOCS_PLUGIN_CONFIG_URL: "https://office.test/plugins/courseware/config.json" }).communityPluginConfigUrl,
  "https://office.test/plugins/courseware/config.json");
  for (const patch of [{ DECKWISE_DOCS_API_URL: undefined }, { DECKWISE_DOCS_ONLINE_ENTRY_URL: "http://remote.test/courseware-online.html" },
    { DECKWISE_DOCS_ONLINE_ENTRY_URL: "https://u:secret@office.test/courseware-online.html" },
    { DECKWISE_DOCS_ONLINE_ENTRY_URL: "https://office.test/courseware-online.html?token=secret" },
    { DECKWISE_DOCS_API_URL: "file:///private/api.js" }, { DECKWISE_DOCS_API_URL: "https://docs.test/other" },
    { DECKWISE_DOCS_API_URL: "https://docs.test/other/api.js" },
    { DECKWISE_DOCS_PLUGIN_CONFIG_URL: "https://foreign.test/config.json" },
    { DECKWISE_DOCS_PLUGIN_CONFIG_URL: "https://plugin.test/config.json#secret" }])
    assert.throws(() => coursewareOnlineDeployment({ ...pins, ...patch }), /INVALID_DEPLOYMENT/);
});

function setup() {
  const calls = [], handlers = new Map();
  let changed, controller, detached = false;
  class Controller {
    constructor(options) { this.options = options; controller = this; }
    state() { calls.push(["state"]); return { available: false, status: "closed", projectId: null, ownerId: this.ownerId ?? null }; }
    open(...args) { this.ownerId = args[0]; calls.push(["open", ...args]); return { available: true, status: "opening", ownerId: args[0], projectId: args[1] }; }
    setBounds(...args) { calls.push(["bounds", ...args]); }
    setVisible(...args) { calls.push(["visible", ...args]); }
    close(...args) { calls.push(["close", ...args]); }
    invalidate() { calls.push(["invalidate"]); }
    dispose() { calls.push(["dispose"]); }
  }
  const auth = { getCoursewarePrincipal: () => ({ assertCurrent() {} }), joinCoursewareOnline: (...args) => calls.push(["join", ...args]),
    onStateChanged(fn) { changed = fn; return () => { detached = true; }; } };
  const registrar = { ipcMain: {}, assertMainWindowSender(event) { if (event.sender.id !== 1) throw new Error("sender refused"); },
    handleWithEvent(channel, handler) { handlers.set(channel, handler); } };
  const frame = {}, event = { sender: { id: 1, mainFrame: frame }, senderFrame: frame };
  return { calls, handlers, auth, registrar, event, Controller, stateChanged: () => changed(), get controller() { return controller; }, get detached() { return detached; } };
}

async function register(f) {
  class Teaching {
    read(...args) { f.calls.push(["teaching.read", ...args]); return null; }
    acquire(...args) { f.calls.push(["teaching.acquire", ...args]); return { ok: true }; }
    renew(...args) { f.calls.push(["teaching.renew", ...args]); return { ok: true }; }
    save(...args) { f.calls.push(["teaching.save", ...args]); return { ok: true }; }
    release(...args) { f.calls.push(["teaching.release", ...args]); return { ok: true }; }
    assertNoPendingOperation() { if (f.teachingBusy) throw new Error("COURSEWARE_ONLINE_TEACHING_BUSY"); }
    invalidate() { f.calls.push(["teaching.invalidate"]); }
  }
  class Barrier {
    read(...args) { f.calls.push(["barrier.read", ...args]); return { ok: true }; }
    start(...args) { f.calls.push(["barrier.start", ...args]); return { ok: true }; }
    resume(...args) { f.calls.push(["barrier.resume", ...args]); return { ok: true }; }
    invalidate() { f.calls.push(["barrier.invalidate"]); }
  }
  class Pause {
    read(...args) { f.calls.push(["pause.read", ...args]); return null; }
    resume(...args) { f.calls.push(["pause.resume", ...args]); return { ok: true }; }
    invalidate() { f.calls.push(["pause.invalidate"]); }
  }
  class SourceReview {
    begin(...args) { f.calls.push(["source.begin", ...args]); if (f.sourceFailure) throw new Error(f.sourceFailure); return { viewId: ownerId, ownerId }; }
    resolve(...args) { f.calls.push(["source.resolve", ...args]); return { status: "reviewed" }; }
    preview(...args) { f.calls.push(["source.preview", ...args]); return "data:image/png;base64,cGFnZQ=="; }
    capture(...args) { f.calls.push(["source.capture", ...args]); if (f.sourceFailure) throw new Error(f.sourceFailure);
      return { viewId: args[0], ownerId, snapshot: { snapshotId: projectId } }; }
    clear(...args) { f.calls.push(["source.clear", ...args]); }
    assertNoPendingOperation() { if (f.sourceBusy) throw new Error("COURSEWARE_ONLINE_SOURCE_BUSY"); }
    invalidate() { f.calls.push(["source.invalidate"]); }
  }
  const { registerCoursewareOnlineIpc } = await load("ipc/courseware-online-ipc", {
    "@pi-desktop/shared": { IPC }, "../courseware-online-view": { CoursewareOnlineViewController: f.Controller },
    "../courseware-online-deployment": { coursewareOnlineDeployment: () => null },
    "../courseware-online-teaching": { CoursewareOnlineTeachingCoordinator: Teaching },
    "../courseware-online-pause": { CoursewareOnlinePauseCoordinator: Pause },
    "../courseware-online-barrier": { CoursewareOnlineBarrierCoordinator: Barrier },
    "../courseware-online-source-review": { CoursewareOnlineSourceReviewCoordinator: SourceReview },
  });
  return registerCoursewareOnlineIpc({ registrar: f.registrar, authSession: f.auth, getMainWindow: () => null, sendToRenderer() {},
    getHost: () => null, getWorkspaceRoot: async () => null, getViewingSessionId: () => null });
}
const ownerId = "11111111-1111-4111-8111-111111111111", projectId = "22222222-2222-4222-8222-222222222222";

test("online IPC routes finite public state and owned operations, with synchronous auth invalidation and teardown", async () => {
  const f = setup(), dispose = await register(f);
  const invoke = (channel, ...args) => f.handlers.get(channel)(f.event, ...args);
  assert.equal((await invoke(IPC.invoke.coursewareOnlineState)).available, false);
  assert.equal((await invoke(IPC.invoke.coursewareOnlineOpen, { ownerId, projectId })).projectId, projectId);
  await invoke(IPC.invoke.coursewareOnlineSetBounds, { ownerId, bounds: { x: 0, y: 50, width: 800, height: 600 } });
  await invoke(IPC.invoke.coursewareOnlineSetVisible, { ownerId, visible: true });
  await invoke(IPC.invoke.coursewareOnlineClose, { ownerId });
  f.stateChanged(); assert.deepEqual(f.calls.at(-1), ["invalidate"]);
  dispose(); assert(f.detached); assert.deepEqual(f.calls.at(-1), ["dispose"]);
  for (const channel of [...f.handlers.keys(), IPC.event.coursewareOnlineState]) assert(IPC_WHITELIST.has(channel));
});

test("online IPC rejects foreign frames, untrusted selectors, malformed bounds and extra arguments before dispatch", async () => {
  const f = setup(); await register(f);
  const cases = [
    [IPC.invoke.coursewareOnlineOpen, { ownerId, projectId, configJson: "injected" }],
    [IPC.invoke.coursewareOnlineOpen, { ownerId, projectId: "../other" }],
    [IPC.invoke.coursewareOnlineOpen, { ownerId: "bad-owner", projectId }],
    [IPC.invoke.coursewareOnlineState, {}],
    [IPC.invoke.coursewareOnlineSetVisible, { ownerId, visible: 1 }],
    [IPC.invoke.coursewareOnlineSetBounds, { ownerId, bounds: { x: -1, y: 0, width: 10, height: 10 } }],
    [IPC.invoke.coursewareOnlineSetBounds, { ownerId, bounds: { x: 0, y: 0, width: Infinity, height: 10 } }],
    [IPC.invoke.coursewareOnlineSetBounds, { ownerId, bounds: { x: 0, y: 0, width: 10, height: 10, projectId } }],
    [IPC.invoke.coursewareOnlineClose, { ownerId }, "extra"],
  ];
  for (const [channel, ...args] of cases) await assert.rejects(f.handlers.get(channel)(f.event, ...args));
  for (const event of [{ ...f.event, senderFrame: {} }, { ...f.event, sender: { id: 9 } }])
    await assert.rejects(f.handlers.get(IPC.invoke.coursewareOnlineOpen)(event, { ownerId, projectId }));
  assert.deepEqual(f.calls, []);
});

test("online teaching IPC exposes only view selectors and finite narration operations to the main frame", async () => {
  const f = setup(); await register(f);
  const invoke = (channel, payload, event = f.event) => f.handlers.get(channel)(event, payload);
  const viewId = "33333333-3333-4333-8333-333333333333";
  const read = IPC.invoke.coursewareOnlineTeachingRead, save = IPC.invoke.coursewareOnlineTeachingSave;
  assert.equal(await invoke(read, { ownerId }), null);
  await invoke(read, { ownerId, pageId: "logical-page-2" });
  for (const channel of [IPC.invoke.coursewareOnlineTeachingAcquire, IPC.invoke.coursewareOnlineTeachingRenew,
    IPC.invoke.coursewareOnlineTeachingRelease]) await invoke(channel, { viewId });
  await invoke(save, { viewId, actions: [{ id: "speech-1", type: "speech", text: "new narration" }] });
  assert.deepEqual(f.calls.map(([name]) => name), ["teaching.read", "teaching.read", "teaching.acquire", "teaching.renew", "teaching.release", "teaching.save"]);
  const count = f.calls.length;
  for (const [channel, payload] of [[read, { ownerId, pageId: ".." }], [read, { ownerId, pageId: undefined }],
    [read, { ownerId, sessionEpoch: 9 }], [save, { viewId, actions: [], leaseToken: "injected" }],
    [save, { viewId: "../other", actions: [] }], [save, { viewId }]]) await assert.rejects(invoke(channel, payload));
  await assert.rejects(invoke(read, { ownerId }, { ...f.event, senderFrame: {} }));
  await assert.rejects(invoke(read, { ownerId }, { ...f.event, sender: { id: 9 } }));
  assert.equal(f.calls.length, count);
});

test("late close from an obsolete owner cannot invalidate the active teaching draft or uncertain request", async () => {
  const f = setup(); await register(f);
  const invoke = (channel, payload) => f.handlers.get(channel)(f.event, payload);
  await invoke(IPC.invoke.coursewareOnlineOpen, { ownerId, projectId });
  const before = f.calls.filter(([name]) => name === "teaching.invalidate").length;
  await invoke(IPC.invoke.coursewareOnlineClose, { ownerId: "33333333-3333-4333-8333-333333333333" });
  assert.equal(f.calls.filter(([name]) => name === "teaching.invalidate").length, before);
  await invoke(IPC.invoke.coursewareOnlineClose, { ownerId });
  assert.equal(f.calls.filter(([name]) => name === "teaching.invalidate").length, before + 1);
});

test("pause recovery IPC is Main-frame only, holds server selectors in Main and refuses an unresolved teaching operation", async () => {
  const f = setup(); await register(f);
  const viewId = "33333333-3333-4333-8333-333333333333";
  const read = IPC.invoke.coursewareOnlinePauseRead, resume = IPC.invoke.coursewareOnlinePauseResume;
  const invoke = (channel, payload, event = f.event, ...extra) => f.handlers.get(channel)(event, payload, ...extra);
  assert.equal(await invoke(read, { ownerId }), null);
  assert.deepEqual(await invoke(resume, { viewId }), { ok: true });
  assert.deepEqual(f.calls, [["pause.read", ownerId], ["pause.resume", viewId]]);
  f.teachingBusy = true;
  await assert.rejects(invoke(resume, { viewId }), /TEACHING_BUSY/);
  for (const [channel, payload] of [[read, { ownerId, sessionEpoch: 2 }], [resume, { viewId, pauseId: ownerId }],
    [read, { ownerId: "bad" }], [resume, { ownerId }]]) await assert.rejects(invoke(channel, payload));
  await assert.rejects(invoke(read, { ownerId }, { ...f.event, senderFrame: {} }));
  await assert.rejects(invoke(resume, { viewId }, f.event, "extra"));
  assert.equal(f.calls.length, 2);
  for (const channel of [read, resume]) assert(IPC_WHITELIST.has(channel));
});


test("native barrier IPC exposes finite owned selectors and blocks teaching-pending operations", async () => {
  const f = setup(); await register(f);
  const viewId = "33333333-3333-4333-8333-333333333333";
  const channels = [IPC.invoke.coursewareOnlineBarrierRead, IPC.invoke.coursewareOnlineBarrierStart, IPC.invoke.coursewareOnlineBarrierResume];
  const invoke = (channel, payload, event = f.event, ...extra) => f.handlers.get(channel)(event, payload, ...extra);
  for (const [index, channel] of channels.entries()) {
    await invoke(channel, index === 0 ? { ownerId } : { viewId });
    assert(IPC_WHITELIST.has(channel));
    await assert.rejects(invoke(channel, index === 0 ? { ownerId, barrierId: viewId } : { viewId, pauseId: ownerId }));
    await assert.rejects(invoke(channel, index === 0 ? { ownerId } : { viewId }, { ...f.event, senderFrame: {} }));
    await assert.rejects(invoke(channel, index === 0 ? { ownerId } : { viewId }, f.event, "extra"));
  }
  assert.deepEqual(f.calls, [["barrier.read", ownerId], ["barrier.start", viewId], ["barrier.resume", viewId]]);
  f.teachingBusy = true;
  await assert.rejects(invoke(channels[1], { viewId }), /TEACHING_BUSY/);
  await assert.rejects(invoke(channels[2], { viewId }), /TEACHING_BUSY/);
  assert.equal(f.calls.length, 3);
});

test("source review IPC routes owned selectors without caller archive paths or publication operations", async () => {
  const f = setup(); await register(f);
  const viewId = "33333333-3333-4333-8333-333333333333";
  const invoke = (channel, payload, event = f.event, ...extra) => f.handlers.get(channel)(event, payload, ...extra);
  const decisions = { pages: [], removedPages: [], cues: [] };
  await invoke(IPC.invoke.coursewareOnlineSourceBegin, { ownerId, sessionId: "chat-1" });
  await invoke(IPC.invoke.coursewareOnlineSourceResolve, { viewId, decisions });
  assert.deepEqual(await invoke(IPC.invoke.coursewareOnlineSourcePreview, { viewId, side: "target", page: 2 }),
    { image: "data:image/png;base64,cGFnZQ==" });
  assert.deepEqual(await invoke(IPC.invoke.coursewareOnlineSourceClear, { viewId }), { ok: true });
  assert.deepEqual(f.calls, [["source.begin", ownerId, "chat-1"], ["source.resolve", viewId, decisions],
    ["source.preview", viewId, "target", 2], ["source.clear", viewId]]);
  for (const channel of [IPC.invoke.coursewareOnlineSourceBegin, IPC.invoke.coursewareOnlineSourceResolve,
    IPC.invoke.coursewareOnlineSourcePreview, IPC.invoke.coursewareOnlineSourceClear]) assert(IPC_WHITELIST.has(channel));
  const invalid = [
    [IPC.invoke.coursewareOnlineSourceBegin, { ownerId, sessionId: "chat-1", archivePath: "/private" }],
    [IPC.invoke.coursewareOnlineSourceBegin, { ownerId, sessionId: "../other" }],
    [IPC.invoke.coursewareOnlineSourceBegin, { ownerId, sessionId: ".." }],
    [IPC.invoke.coursewareOnlineSourceResolve, { viewId, decisions: null }],
    [IPC.invoke.coursewareOnlineSourceResolve, { viewId, decisions, source: {} }],
    [IPC.invoke.coursewareOnlineSourcePreview, { viewId, side: "remote", page: 1 }],
    [IPC.invoke.coursewareOnlineSourcePreview, { viewId, side: "target", page: 1.5 }],
    [IPC.invoke.coursewareOnlineSourcePreview, { viewId, side: "target", page: 101 }],
    [IPC.invoke.coursewareOnlineSourceClear, { viewId, projectId }],
  ];
  for (const [channel, payload] of invalid) await assert.rejects(invoke(channel, payload), /INVALID_REQUEST/);
  await assert.rejects(invoke(IPC.invoke.coursewareOnlineSourceBegin, { ownerId, sessionId: "chat-1" }, { ...f.event, senderFrame: {} }));
  await assert.rejects(invoke(IPC.invoke.coursewareOnlineSourceClear, { viewId }, f.event, "extra"));
  assert.equal(f.calls.length, 4);
});

test("source review blocks resume until clear, refuses pending teaching saves, and redacts unexpected failures", async () => {
  const f = setup(); await register(f);
  const viewId = "33333333-3333-4333-8333-333333333333";
  const invoke = (channel, payload) => f.handlers.get(channel)(f.event, payload);
  f.sourceBusy = true;
  for (const channel of [IPC.invoke.coursewareOnlinePauseResume, IPC.invoke.coursewareOnlineBarrierStart, IPC.invoke.coursewareOnlineBarrierResume])
    await assert.rejects(invoke(channel, { viewId }), /SOURCE_BUSY/);
  assert.equal(f.calls.length, 0);
  f.sourceBusy = false; f.teachingBusy = true;
  await assert.rejects(invoke(IPC.invoke.coursewareOnlineSourceBegin, { ownerId, sessionId: "chat-1" }), /TEACHING_BUSY/);
  assert.equal(f.calls.length, 0);
  f.teachingBusy = false; f.sourceFailure = "transport secret-url-and-cookie";
  await assert.rejects(invoke(IPC.invoke.coursewareOnlineSourceBegin, { ownerId, sessionId: "chat-1" }), { message: "COURSEWARE_ONLINE_SOURCE_FAILED" });
  f.sourceFailure = "COURSEWARE_ONLINE_SOURCE_NOT_READY";
  await assert.rejects(invoke(IPC.invoke.coursewareOnlineSourceBegin, { ownerId, sessionId: "chat-1" }), /SOURCE_NOT_READY/);
});

test("source capture accepts only an owned view selector from the Main frame and preserves finite recovery errors", async () => {
  const f = setup(); await register(f);
  const viewId = "33333333-3333-4333-8333-333333333333", channel = IPC.invoke.coursewareOnlineSourceCapture;
  const invoke = (payload, event = f.event, ...extra) => f.handlers.get(channel)(event, payload, ...extra);
  assert(IPC_WHITELIST.has(channel));
  assert.deepEqual(await invoke({ viewId }), { viewId, ownerId, snapshot: { snapshotId: projectId } });
  for (const payload of [{ viewId, projectId }, { viewId, source: {} }, { viewId, barrierId: ownerId },
    { viewId, audio: [] }, { ownerId }, { viewId: "../other" }]) await assert.rejects(invoke(payload), /INVALID_REQUEST/);
  await assert.rejects(invoke({ viewId }, { ...f.event, senderFrame: {} }), /INVALID_REQUEST/);
  await assert.rejects(invoke({ viewId }, { ...f.event, sender: { id: 9 } }), /sender refused/);
  await assert.rejects(invoke({ viewId }, f.event, "extra"), /INVALID_REQUEST/);
  assert.deepEqual(f.calls, [["source.capture", viewId]]);
  for (const message of ["COURSEWARE_ONLINE_SOURCE_CAPTURE_UNCERTAIN", "COURSEWARE_ONLINE_SOURCE_IMPORT_UNCERTAIN",
    "COURSEWARE_ONLINE_SOURCE_NOT_READY", "COURSEWARE_ONLINE_SOURCE_CHANGED"]) {
    f.sourceFailure = message;
    await assert.rejects(invoke({ viewId }), { message });
  }
  f.sourceFailure = "private archive path and bearer credential";
  await assert.rejects(invoke({ viewId }), { message: "COURSEWARE_ONLINE_SOURCE_FAILED" });
});
