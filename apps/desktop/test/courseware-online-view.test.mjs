import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const HOST = "deckwise-editor://host/online.html";
const PROTOCOL = "deckwise-docs-online/1";
const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER_OWNER = "22222222-2222-4222-8222-222222222222";
const PROJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_PROJECT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const deployment = { hostUrl: "https://office.example/courseware-online.html", apiUrl: "https://docs.example/web-apps/apps/api/documents/api.js" };
const deploymentModule = { exports: {} };
const deploymentSource = readFileSync(new URL("../electron/main/courseware-online-deployment.ts", import.meta.url), "utf8");
new Function("exports", ts.transpileModule(deploymentSource, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(deploymentModule.exports);
const launch = (projectId = PROJECT) => ({ projectId, sessionEpoch: 3, documentKey: "project-key-3", docsUserId: "tenant-1-user-2",
  source: { revision: "revision-1", sha256: "a".repeat(64) }, configJson: '{"token":"fixture-only-signed-config"}', expiresAtEpochMillis: Date.now() + 60_000 });
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function fixture(t, options = {}) {
  const ipcMain = new EventEmitter(), views = [], sessions = [], states = [], timers = new Map();
  let permitted = true, mainVisible = true, mainDestroyed = false, currentWindow, timerId = 0, accountGeneration = 0;
  const mainContents = Object.assign(new EventEmitter(), { isDestroyed: () => mainDestroyed });
  const window = Object.assign(new EventEmitter(), { get webContents() {
    if (mainDestroyed) throw new Error("Object has been destroyed");
    return mainContents;
  }, isDestroyed: () => mainDestroyed,
    isVisible: () => mainVisible, contentView: { children: [], addChildView(view) { this.children.push(view); },
      removeChildView(view) { this.children.splice(this.children.indexOf(view), 1); } } });
  currentWindow = window;
  const reply = (view, data, overrides = {}) => ipcMain.emit("deckwise-online:event",
    { sender: view.webContents, senderFrame: view.webContents.mainFrame, ...overrides }, data);
  class View {
    constructor(settings) {
      this.settings = settings; this.bounds = undefined; this.commands = []; this.destroyed = false;
      this.webContents = Object.assign(new EventEmitter(), { id: views.length + 1, mainFrame: { url: HOST },
        isDestroyed: () => this.destroyed, setWindowOpenHandler: handler => { this.popup = handler; },
        close: () => { this.destroyed = true; this.webContents.emit("destroyed"); },
        send: (channel, command) => this.commands.push({ channel, command }),
        loadURL: async url => { this.url = url; if (options.loadError) throw new Error("private upstream URL"); reply(this, { type: "wrapper-ready" }); },
      });
      views.push(this);
    }
    setBounds(bounds) { this.bounds = bounds; }
  }
  const electron = { WebContentsView: View, session: { fromPartition(partition, settings) {
    const value = Object.assign(new EventEmitter(), { partition, settings, protocol: {}, cleared: 0,
      setPermissionRequestHandler(handler) { this.permission = handler; }, setPermissionCheckHandler(handler) { this.check = handler; },
      setDevicePermissionHandler(handler) { this.device = handler; }, async clearStorageData() { this.cleared++; } });
    sessions.push(value); return value;
  } } };
  const file = new URL("../electron/main/courseware-online-view.ts", import.meta.url).pathname;
  const module = { exports: {} };
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  new Function("require", "exports", "module", "__dirname", "setTimeout", "clearTimeout", outputText)(id => {
    if (id === "electron") return electron;
    if (id === "./editor-host-protocol") return { installEditorHostProtocol() {} };
    if (id === "./courseware-online-deployment") return deploymentModule.exports;
    if (id === "./courseware-online-clients") return { CoursewareOnlineClientsWorker: class {
      constructor(value) { this.options = value; options.workers?.push(this); }
      start() { this.started = true; } stop() { this.stopped = true; }
      binding() { this.options.assertCurrent(); return this.options.binding; }
      state() { return { nativeReady: true, barrier: null }; }
    } };
    return require(id);
  }, module.exports, module, dirname(file), callback => { timers.set(++timerId, callback); return timerId; }, id => timers.delete(id));
  const joins = [];
  const controller = new module.exports.CoursewareOnlineViewController({ ipcMain, getMainWindow: () => currentWindow, emit: state => states.push(state),
    authorize: () => { const captured = accountGeneration; return { assertCurrent() {
      if (!permitted || captured !== accountGeneration) throw new Error("account private details");
    } }; },
    join(projectId, signal, clientId) { joins.push({ projectId, signal, clientId }); return options.join ? options.join(projectId, signal, clientId) : Promise.resolve(launch(projectId)); },
    ...(options.client ? { client: options.client } : {}),
    deployment: options.deployment === undefined ? deployment : options.deployment });
  t.after(() => controller.dispose());
  const envelope = (view, type, extra = {}) => {
    const open = view.commands.find(item => item.command.type === "open")?.command;
    assert.ok(open, "Main sent a correlated open command");
    const { protocol, channelId, requestId, generation, projectId, sessionEpoch, documentKey, docsUserId } = open;
    return { protocol, channelId, requestId, type, generation, projectId, sessionEpoch, documentKey, docsUserId, ...extra };
  };
  const entryReady = async () => {
    await tick(); const view = views.at(-1); assert.ok(view);
    const configure = view.commands.find(item => item.command.type === "configure")?.command;
    assert.ok(configure);
    reply(view, { protocol: PROTOCOL, channelId: configure.channelId, type: "entry-ready" });
    return view;
  };
  const ready = async () => { const view = await entryReady(); reply(view, envelope(view, "ready")); return view; };
  return { controller, ipcMain, views, sessions, states, joins, window, timers, reply, envelope, entryReady, ready,
    revoke() { permitted = false; }, changeAccount() { accountGeneration++; permitted = true; }, replaceWindow() { currentWindow = null; },
    hide() { mainVisible = false; window.emit("hide"); }, show() { mainVisible = true; window.emit("show"); },
    destroy() { mainDestroyed = true; mainContents.removeAllListeners(); window.emit("closed"); },
    expire() { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } } };
}

test("isolated online join keeps signed config out of URLs/public state and uses correlated events", async t => {
  const f = fixture(t), pending = f.controller.open(OWNER, PROJECT);
  f.controller.setBounds(OWNER, { x: 1.2, y: 2, width: 800, height: 600 }); f.controller.setVisible(OWNER, true);
  const view = await f.entryReady();
  assert.equal(f.controller.state().status, "opening");
  assert.throws(() => f.controller.teachingBinding(OWNER), /TEACHING_CHANGED/u);
  assert.equal(view.url, HOST);
  assert.equal(f.window.contentView.children[0], view);
  assert.deepEqual(view.bounds, { x: 1, y: 2, width: 800, height: 600 });
  assert.equal(f.sessions.length, 1); assert.ok(!f.sessions[0].partition.startsWith("persist:"));
  assert.equal(view.settings.webPreferences.session, f.sessions[0]);
  for (const [key, expected] of Object.entries({ sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, webSecurity: true }))
    assert.equal(view.settings.webPreferences[key], expected);
  assert.match(view.settings.webPreferences.preload, /courseware-online-host\.js$/);
  const open = view.commands.find(item => item.command.type === "open").command;
  assert.equal(open.configJson, launch().configJson); assert.equal("source" in open, false);
  assert.equal(JSON.stringify(f.states).includes("fixture-only"), false);
  f.reply(view, f.envelope(view, "ready"), { senderFrame: { url: HOST } });
  f.reply(view, f.envelope(view, "ready"), { sender: {} });
  f.reply(view, f.envelope(view, "ready", { generation: 999 }));
  f.reply(view, f.envelope(view, "ready", { projectId: OTHER_PROJECT }));
  assert.equal(f.controller.state().status, "opening");
  f.reply(view, f.envelope(view, "ready"));
  assert.equal((await pending).status, "ready"); assert.equal(f.timers.size, 0);
  assert.deepEqual(f.controller.teachingBinding(OWNER), { ownerId: OWNER, projectId: PROJECT, sessionEpoch: 3, source: launch().source });
  assert.throws(() => f.controller.teachingBinding(OTHER_OWNER), /TEACHING_CHANGED/u);
  const externalCopy = f.controller.teachingBinding(OWNER); externalCopy.source.sha256 = "b".repeat(64);
  assert.equal(f.controller.teachingBinding(OWNER).source.sha256, "a".repeat(64));
  f.reply(view, f.envelope(view, "state", { dirty: true })); assert.equal(f.controller.state().status, "sync-pending");
  f.reply(view, f.envelope(view, "state", { dirty: false })); assert.equal(f.controller.state().status, "sync-reported");
  f.reply(view, f.envelope(view, "ready")); assert.equal(f.controller.state().status, "sync-reported");
});

test("navigation, popup, permissions and download are denied except pinned remote subframes", async t => {
  const f = fixture(t), pending = f.controller.open(OWNER, PROJECT); const view = await f.ready(); await pending;
  assert.deepEqual(view.popup({ url: "https://evil.example" }), { action: "deny" });
  const navigation = (name, fields, ...args) => { let denied = false; view.webContents.emit(name, { ...fields, preventDefault() { denied = true; } }, ...args); return denied; };
  assert.equal(navigation("will-navigate", { url: deployment.hostUrl }), true);
  assert.equal(navigation("will-frame-navigate", { isMainFrame: true, url: deployment.hostUrl }), true);
  assert.equal(navigation("will-frame-navigate", { isMainFrame: false, url: "https://evil.example" }), true);
  assert.equal(navigation("will-frame-navigate", { isMainFrame: false, url: "https://docs.example/editor" }), false);
  assert.equal(navigation("will-redirect", { isMainFrame: true }, deployment.hostUrl, false, true), true);
  assert.equal(navigation("will-redirect", { isMainFrame: false }, "https://evil.example", false, false), true);
  assert.equal(navigation("will-attach-webview", {}), true);
  let allowed; f.sessions[0].permission(null, "camera", value => { allowed = value; });
  assert.equal(allowed, false); assert.equal(f.sessions[0].check(), false); assert.equal(f.sessions[0].device(), false);
  let prevented = false; f.sessions[0].emit("will-download", { preventDefault() { prevented = true; } }); assert.equal(prevented, true);
});

test("owner generation prevents late joins and stale close from replacing the new view", async t => {
  const first = deferred(), second = deferred(); let count = 0;
  const f = fixture(t, { join: () => ++count === 1 ? first.promise : second.promise });
  const old = assert.rejects(f.controller.open(OWNER, PROJECT), /VIEW_CLOSED/);
  const pending = f.controller.open(OTHER_OWNER, OTHER_PROJECT); await old;
  assert.equal(f.joins[0].signal.aborted, true);
  assert.throws(() => f.controller.teachingBinding(OWNER), /TEACHING_CHANGED/u);
  f.controller.close(OWNER); assert.equal(f.controller.state().ownerId, OTHER_OWNER);
  first.resolve(launch(PROJECT)); await tick(); assert.equal(f.views.length, 0);
  second.resolve(launch(OTHER_PROJECT)); await f.ready(); await pending;
  assert.equal(f.views.length, 1); assert.equal(f.controller.state().projectId, OTHER_PROJECT);
});

test("account/window changes, main crash and timeout abort joins and remove owned listeners", async t => {
  for (const change of ["revoke", "replaceWindow", "destroy", "crash", "expire", "invalidate"]) {
    const held = deferred(), f = fixture(t, { join: () => held.promise });
    const rejected = assert.rejects(f.controller.open(OWNER, PROJECT), /COURSEWARE_ONLINE_/);
    if (change === "crash") f.window.webContents.emit("render-process-gone", {});
    else if (change === "invalidate") f.controller.invalidate(); else f[change]();
    held.resolve(launch()); await rejected;
    assert.equal(f.joins[0].signal.aborted, true, change);
    assert.equal(f.views.length, 0, change);
    assert.equal(f.window.listenerCount("closed"), 0, change);
    assert.equal(f.window.webContents.listenerCount("render-process-gone"), 0, change);
    f.controller.dispose(); assert.equal(f.timers.size, 0);
  }
});

test("hiding detaches online view; close destroys it and clears transient storage", async t => {
  const f = fixture(t), pending = f.controller.open(OWNER, PROJECT); f.controller.setVisible(OWNER, true);
  const view = await f.ready(); await pending;
  f.hide(); assert.equal(f.window.contentView.children.length, 0);
  f.controller.setVisible(OWNER, true); assert.equal(f.window.contentView.children.length, 0);
  f.show(); assert.equal(f.window.contentView.children[0], view);
  f.controller.setVisible(OTHER_OWNER, false); assert.equal(f.window.contentView.children[0], view);
  f.controller.setVisible(OWNER, false); assert.equal(f.window.contentView.children.length, 0);
  f.controller.close(OWNER); assert.equal(view.destroyed, true); assert.equal(f.sessions[0].cleared, 1);
  assert.equal(f.controller.state().status, "closed"); assert.equal(f.joins[0].signal.aborted, true);
  f.controller.dispose(); assert.equal(f.ipcMain.listenerCount("deckwise-online:event"), 0);
});

test("authorization is rechecked on messages and expired launches never reach Office", async t => {
  const f = fixture(t), pending = f.controller.open(OWNER, PROJECT); const view = await f.ready(); await pending;
  f.revoke(); f.reply(view, f.envelope(view, "state", { dirty: true }));
  assert.equal(view.destroyed, true); assert.equal(f.controller.state().errorCode, "COURSEWARE_ONLINE_AUTH_CHANGED");
  const expired = fixture(t, { join: () => Promise.resolve({ ...launch(), expiresAtEpochMillis: Date.now() - 1 }) });
  await assert.rejects(expired.controller.open(OWNER, PROJECT), /EDITOR_UNAVAILABLE/); assert.equal(expired.views.length, 0);
});

test("join failures preserve only finite actionable codes and disabled deployment never joins", async t => {
  for (const code of ["COURSEWARE_ONLINE_SESSION_INACTIVE", "COURSEWARE_ONLINE_PLATFORM_46200", "COURSEWARE_ONLINE_READ_ONLY", "https://private.example/token?secret=fixture"]) {
    const f = fixture(t, { join: () => Promise.reject(new Error(code)) });
    await assert.rejects(f.controller.open(OWNER, PROJECT));
    assert.equal(f.controller.state().errorCode, code.startsWith("https:") ? "COURSEWARE_ONLINE_EDITOR_UNAVAILABLE" : code);
    assert.equal(JSON.stringify(f.states).includes("secret"), false);
  }
  const f = fixture(t, { deployment: null }); assert.equal(f.controller.state().available, false);
  await assert.rejects(f.controller.open(OWNER, PROJECT), /DISABLED/); assert.equal(f.joins.length, 0);
});

test("native crash, load failure and pending mount timeout fail closed", async t => {
  const failedLoad = fixture(t, { loadError: true });
  await assert.rejects(failedLoad.controller.open(OWNER, PROJECT), /LOAD_FAILED/); assert.equal(failedLoad.views[0].destroyed, true);
  for (const failure of ["crash", "timeout"]) {
    const f = fixture(t), rejected = assert.rejects(f.controller.open(OWNER, PROJECT), /COURSEWARE_ONLINE_/), view = await f.entryReady();
    if (failure === "crash") view.webContents.emit("render-process-gone", {}); else f.expire();
    await rejected; assert.equal(view.destroyed, true); assert.equal(f.sessions[0].cleared, 1);
  }
});

test("native barrier calls pin their client identity and never use dirty events as acknowledgements", async t => {
  const f = fixture(t), opening = f.controller.open(OWNER, PROJECT), view = await f.ready(); await opening;
  const capability = f.controller.nativeBarrierCapability(OWNER);
  const command = view.commands.at(-1).command;
  assert.equal(command.type, "barrier-capability"); assert.notEqual(command.requestId, f.envelope(view, "ready").requestId);
  f.reply(view, f.envelope(view, "barrier-capability", { requestId: command.requestId, result: { available: true }, sessionEpoch: 99 }));
  f.reply(view, f.envelope(view, "barrier-capability", { requestId: command.requestId, result: { available: true } }), { senderFrame: {} });
  assert.equal(f.timers.size, 1);
  f.reply(view, f.envelope(view, "barrier-capability", { requestId: command.requestId, result: { available: true } }));
  assert.deepEqual(await capability, { available: true });
  const barrierId = OTHER_OWNER;
  let completed = false;
  const drain = f.controller.nativeBarrier(OWNER, "quiesce", barrierId).then(result => { completed = true; return result; });
  const drainCommand = view.commands.at(-1).command;
  assert.deepEqual(Object.keys(drainCommand).sort(), ["protocol", "channelId", "requestId", "type", "generation", "barrierId"].sort());
  f.reply(view, f.envelope(view, "state", { dirty: false })); await tick(); assert.equal(completed, false);
  f.reply(view, f.envelope(view, "barrier", { requestId: drainCommand.requestId, result: { barrierId, state: "held", serverIndex: 4 } }));
  assert.deepEqual(await drain, { barrierId, state: "held", serverIndex: 4 });
  assert.equal(f.controller.state().status, "sync-reported"); assert.equal("barrierId" in f.controller.state(), false);
  assert.equal(view.destroyed, false); assert.equal(f.timers.size, 0);
});

test("unknown barrier outcome, unavailable engine and finite native refusal preserve the editor", async t => {
  const f = fixture(t), opening = f.controller.open(OWNER, PROJECT), view = await f.ready(); await opening;
  const timedOut = assert.rejects(f.controller.nativeBarrier(OWNER, "quiesce", OTHER_OWNER), /BARRIER_ACK_UNKNOWN/);
  const commandCount = view.commands.length;
  await assert.rejects(f.controller.nativeBarrier(OWNER, "resume", OTHER_OWNER), /BARRIER_BUSY/);
  assert.equal(view.commands.length, commandCount);
  f.expire(); await timedOut; assert.equal(view.destroyed, false); assert.equal(f.controller.state().status, "ready");
  for (const code of ["ONLINE_NATIVE_BARRIER_UNAVAILABLE", "NATIVE_BARRIER_DISCONNECTED"]) {
    const query = assert.rejects(f.controller.nativeBarrier(OWNER, "status", OTHER_OWNER), new RegExp(code));
    f.reply(view, f.envelope(view, "error", { requestId: view.commands.at(-1).command.requestId, code }));
    await query; assert.equal(view.destroyed, false);
  }
  const status = f.controller.nativeBarrier(OWNER, "status", OTHER_OWNER);
  f.reply(view, f.envelope(view, "barrier", { requestId: view.commands.at(-1).command.requestId,
    result: { barrierId: OTHER_OWNER, state: "uncertain-held", error: "NATIVE_BARRIER_ACK_UNKNOWN" } }));
  assert.deepEqual(await status, { barrierId: OTHER_OWNER, state: "uncertain-held", error: "NATIVE_BARRIER_ACK_UNKNOWN" });
  assert.equal(f.timers.size, 0);
});

test("malformed barrier receipts, foreign owners and stale pending replies cannot supply completion", async t => {
  const f = fixture(t), opening = f.controller.open(OWNER, PROJECT), view = await f.ready(); await opening;
  await assert.rejects(f.controller.nativeBarrierCapability(OTHER_OWNER), /TEACHING_CHANGED/);
  for (const result of [{ barrierId: OTHER_OWNER, state: "held" }, { barrierId: OTHER_OWNER, state: "held", serverIndex: -1 },
    { barrierId: PROJECT, state: "held", serverIndex: 1 }, { barrierId: OTHER_OWNER, state: "idle" },
    { barrierId: OTHER_OWNER, state: "uncertain-held", error: "https://private.example" },
    { barrierId: OTHER_OWNER, state: "held", serverIndex: 1, private: "fixture" }]) {
    const failure = assert.rejects(f.controller.nativeBarrier(OWNER, "status", OTHER_OWNER), /INVALID_RESPONSE/);
    f.reply(view, f.envelope(view, "barrier", { requestId: view.commands.at(-1).command.requestId, result })); await failure;
    assert.equal(view.destroyed, false);
  }
  await assert.rejects(f.controller.nativeBarrier(OWNER, "eval", OTHER_OWNER), /INVALID_REQUEST/);
  await assert.rejects(f.controller.nativeBarrier(OWNER, "resume", "bad-id"), /INVALID_REQUEST/);
  const closed = assert.rejects(f.controller.nativeBarrierCapability(OWNER), /VIEW_CLOSED/);
  f.controller.close(OWNER); await closed; assert.equal(f.timers.size, 0);
});

function wrapperFixture() {
  const events = [], forwarded = [], listeners = new Map(); let receive;
  const contentWindow = { postMessage(message, origin) { forwarded.push({ message, origin }); } };
  const iframe = { src: "", contentWindow };
  const bridge = { onCommand(listener) { receive = listener; }, sendEvent(message) { events.push(JSON.parse(JSON.stringify(message))); } };
  const window = { deckwiseOnlineHost: bridge, addEventListener(type, listener) { listeners.set(type, listener); } }; window.top = window;
  const html = readFileSync(new URL("../resources/editor-host/online.html", import.meta.url), "utf8");
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], { window, document: { getElementById: () => iframe }, location: { href: HOST }, URL, Date });
  const message = (data, source = contentWindow, origin = "https://office.example") => listeners.get("message")({ data, source, origin });
  const configure = { type: "configure", channelId: OWNER, ...deployment };
  const open = { protocol: PROTOCOL, channelId: OWNER, requestId: OTHER_OWNER, type: "open", generation: 2,
    projectId: PROJECT, sessionEpoch: 3, documentKey: "project-key-3", docsUserId: "tenant-1-user-2", configJson: launch().configJson,
    expiresAtEpochMillis: Date.now() + 60_000 };
  const event = (type, extra = {}) => { const { protocol, channelId, requestId, generation, projectId, sessionEpoch, documentKey, docsUserId } = open;
    return { protocol, channelId, requestId, type, generation, projectId, sessionEpoch, documentKey, docsUserId, ...extra }; };
  return { events, forwarded, iframe, command: value => receive(value), message, configure, open, event, listeners };
}

test("wrapper forwards only fixed correlated barrier commands and bounded receipts", () => {
  const f = wrapperFixture(); f.command(f.configure); f.message({ protocol: PROTOCOL, channelId: OWNER, type: "entry-ready" }); f.command(f.open);
  const command = { protocol: PROTOCOL, channelId: OWNER, requestId: PROJECT, type: "barrier-quiesce", generation: f.open.generation, barrierId: OTHER_OWNER };
  f.command({ ...command, method: "arbitrary" }); f.command({ ...command, barrierId: "bad" }); f.command({ ...command, generation: 99 });
  assert.equal(f.forwarded.length, 1);
  f.command(command); f.command(command); assert.equal(f.forwarded.length, 2);
  const valid = f.event("barrier", { requestId: PROJECT, result: { barrierId: OTHER_OWNER, state: "held", serverIndex: 7 } });
  const count = f.events.length;
  f.message({ ...valid, documentKey: "foreign" }); f.message(valid, {}, "https://office.example"); f.message(valid, undefined, "https://evil.example");
  assert.equal(f.events.length, count);
  f.message(valid); assert.deepEqual(f.events.at(-1), valid);
  f.message(valid); assert.equal(f.events.length, count + 1);
  f.command({ ...command, requestId: OTHER_PROJECT, type: "barrier-status" });
  f.message(f.event("barrier", { requestId: OTHER_PROJECT, result: { barrierId: OTHER_OWNER, state: "held", serverIndex: 7, private: "do-not-leak" } }));
  assert.equal(f.events.at(-1).code, "ONLINE_NATIVE_BARRIER_FAILED"); assert.equal(JSON.stringify(f.events).includes("do-not-leak"), false);
  f.command({ ...command, requestId: "capability-request", type: "barrier-capability", barrierId: undefined });
  assert.equal(f.forwarded.length, 3, "extra barrierId is refused on a capability request");
  const { barrierId: _, ...capability } = { ...command, requestId: "valid-capability", type: "barrier-capability" };
  f.command(capability); f.message(f.event("barrier-capability", { requestId: "valid-capability", result: { available: false } }));
  assert.deepEqual(f.events.at(-1).result, { available: false });
});

test("wrapper sends only deployment pins in URL and signed config only after trusted entry handshake", () => {
  const f = wrapperFixture(); assert.deepEqual(f.events, [{ type: "wrapper-ready" }]);
  f.command(f.configure); const url = new URL(f.iframe.src);
  assert.equal(url.origin, "https://office.example"); assert.equal(url.searchParams.get("parentOrigin"), "deckwise-editor://host");
  assert.deepEqual([...url.searchParams.keys()].sort(), ["apiUrl", "channelId", "parentOrigin"]);
  assert.equal(f.iframe.src.includes("fixture-only"), false);
  f.command(f.open); assert.equal(f.forwarded.length, 0);
  f.message({ protocol: PROTOCOL, channelId: OWNER, type: "entry-ready" }, {}, "https://office.example");
  f.message({ protocol: PROTOCOL, channelId: OWNER, type: "entry-ready" }, f.iframe.contentWindow, "https://evil.example");
  f.command(f.open); assert.equal(f.forwarded.length, 0);
  f.message({ protocol: PROTOCOL, channelId: OWNER, type: "entry-ready" }); f.command(f.open);
  assert.equal(f.forwarded.length, 1); assert.equal(f.forwarded[0].origin, "https://office.example");
  assert.equal(f.forwarded[0].message.configJson, launch().configJson);
  f.command(f.open); assert.equal(f.forwarded.length, 1);
});

test("Main and the wrapper accept the deployed Docs prefix", t => {
  const prefix = "https://trainwise.efrobot.com/deckwise-office";
  const pins = { hostUrl: prefix + "/client/courseware-online.html",
    apiUrl: prefix + "/web-apps/apps/api/documents/api.js", communityPluginConfigUrl: prefix + "/client/modules/config.json" };
  assert.equal(fixture(t, { deployment: pins }).controller.state().available, true);
  const wrapper = wrapperFixture();
  wrapper.command({ ...wrapper.configure, ...pins });
  assert.equal(new URL(wrapper.iframe.src).searchParams.get("apiUrl"), pins.apiUrl);
});

test("wrapper validates exact origin/source/channel/correlation/shape and sanitizes errors", () => {
  const f = wrapperFixture(); f.command(f.configure); f.message({ protocol: PROTOCOL, channelId: OWNER, type: "entry-ready" }); f.command(f.open);
  const before = f.events.length;
  for (const invalid of [{ channelId: "wrong" }, { generation: 1 }, { projectId: OTHER_PROJECT }, { requestId: "old" },
    { documentKey: "other" }, { docsUserId: "tenant-9-user-9" }, { sessionEpoch: 4 }, { unexpected: "key" }]) f.message(f.event("ready", invalid));
  f.message(f.event("ready"), {}, "https://office.example"); f.message(f.event("ready"), f.iframe.contentWindow, "https://evil.example");
  assert.equal(f.events.length, before);
  f.message(f.event("ready")); assert.equal(f.events.at(-1).type, "ready");
  f.message(f.event("state", { dirty: true })); assert.equal(f.events.at(-1).dirty, true);
  f.message(f.event("error", { code: "private error with token fixture-only" })); assert.equal(f.events.at(-1).code, "ONLINE_NATIVE_ERROR");
  assert.equal(JSON.stringify(f.events).includes("fixture-only"), false);
  f.listeners.get("pagehide")(); const length = f.events.length; f.message(f.event("ready"));
  assert.equal(f.events.length, length); assert.equal(f.iframe.src, "about:blank");
});

test("wrapper rejects invalid deployment pins and expired/malformed open payloads", () => {
  for (const invalid of [{ hostUrl: "https://evil.example/other.html" }, { hostUrl: "http://remote.example/courseware-online.html" },
    { apiUrl: "https://docs.example/api.js?token=fixture" }, { communityPluginConfigUrl: "https://evil.example/config.json" }]) {
    const f = wrapperFixture(); f.command({ ...f.configure, ...invalid }); assert.equal(f.iframe.src, "");
  }
  for (const invalid of [{ expiresAtEpochMillis: Date.now() - 1 }, { expiresAtEpochMillis: Date.now() + 180000 }, { projectId: "../private" },
    { docsUserId: "user-1" }, { source: "extra" }, { generation: 0 }, { configJson: "x".repeat(65537) }]) {
    const f = wrapperFixture(); f.command(f.configure); f.message({ protocol: PROTOCOL, channelId: OWNER, type: "entry-ready" });
    f.command({ ...f.open, ...invalid }); assert.equal(f.forwarded.length, 0);
  }
});

test("online preload exposes no bridge to nested Office frames", () => {
  const source = readFileSync(new URL("../electron/preload/courseware-online-host.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  for (const main of [false, true]) {
    const ipcRenderer = new EventEmitter(), exposed = [];
    new Function("require", "exports", "process", outputText)(() => ({ ipcRenderer, contextBridge: { exposeInMainWorld: (...args) => exposed.push(args) } }), {}, { isMainFrame: main });
    assert.equal(exposed.length, Number(main)); assert.equal(ipcRenderer.listenerCount("deckwise-online:command"), Number(main));
    if (main) assert.deepEqual(Object.keys(exposed[0][1]).sort(), ["onCommand", "sendEvent"]);
  }
});


test("each registered native mount owns a separate registry worker and late close cannot stop another mount", async t => {
  const workers = [], client = {};
  const f = fixture(t, { workers, client: () => client, join: async (projectId, _signal, clientId) => ({ ...launch(projectId), clientId,
    docsUserId: `tenant-1-user-2-client-${clientId}` }) });
  const first = f.controller.open(OWNER, PROJECT); await f.ready(); await first;
  assert.equal(workers.length, 1); assert.equal(workers[0].started, true);
  const original = f.controller.registryBinding(OWNER);
  assert.equal(original.clientId, f.joins[0].clientId); assert.equal(original.ownerId, OWNER);
  assert.equal(workers[0].options.client, client);
  assert.deepEqual(f.controller.registryState(OWNER), { nativeReady: true, barrier: null });
  const second = f.controller.open(OTHER_OWNER, OTHER_PROJECT); await f.ready(); await second;
  assert.equal(workers[0].stopped, true); assert.equal(workers[1].started, true);
  assert.notEqual(f.joins[0].clientId, f.joins[1].clientId);
  workers[0].options.close("COURSEWARE_ONLINE_ACCESS_CHANGED");
  f.controller.close(OWNER); assert.equal(workers[1].stopped, undefined);
  workers[1].options.close("COURSEWARE_ONLINE_ACCESS_CHANGED");
  assert.equal(workers[1].stopped, true);
  assert.equal(f.views.at(-1).destroyed, true);
  assert.equal(f.controller.state().errorCode, "COURSEWARE_ONLINE_ACCESS_CHANGED");
  assert.throws(() => f.controller.teachingBinding(OTHER_OWNER), /TEACHING_CHANGED/);
  assert.throws(() => f.controller.recoverySelection(OTHER_OWNER), /RECOVERY_CHANGED/);
});

test("legacy config preserves ordinary editing and exposes no managed registry", async t => {
  const workers = [], f = fixture(t, { workers, client: () => ({}) });
  const pending = f.controller.open(OWNER, PROJECT); await f.ready(); await pending;
  assert.equal(f.controller.state().status, "ready"); assert.equal(workers.length, 0);
  assert.throws(() => f.controller.registryBinding(OWNER), /CLIENT_REGISTRY_UNAVAILABLE/);
});


test("wrapper accepts per-mount Docs users without weakening correlated launch identity", () => {
  const f = wrapperFixture();
  const client = "77777777-7777-4777-8777-777777777777";
  f.open.docsUserId = `tenant-1-user-2-client-${client}`;
  f.command(f.configure);
  f.message({ protocol: PROTOCOL, channelId: OWNER, type: "entry-ready" });
  f.command(f.open);
  assert.equal(f.forwarded.at(-1).message.docsUserId, f.open.docsUserId);
});


test("registered config owns leave cleanup even if native mounting fails before ready", async t => {
  const workers = [], f = fixture(t, { workers, client: () => ({}), loadError: true,
    join: async (projectId, _signal, clientId) => ({ ...launch(projectId), clientId, docsUserId: `tenant-1-user-2-client-${clientId}` }) });
  await assert.rejects(f.controller.open(OWNER, PROJECT), /LOAD_FAILED/);
  assert.equal(workers.length, 1); assert.equal(workers[0].started, undefined); assert.equal(workers[0].stopped, true);
});


test("admission-blocked join keeps only an account-pinned project selection for recovery", async t => {
  const f = fixture(t, { join: async () => { throw new Error("COURSEWARE_ONLINE_PLATFORM_46901"); } });
  await assert.rejects(f.controller.open(OWNER, PROJECT), /PLATFORM_46901/);
  assert.equal(f.controller.state().status, "error");
  assert.equal(f.controller.state().errorCode, "COURSEWARE_ONLINE_PLATFORM_46901");
  assert.deepEqual(f.controller.recoverySelection(OWNER), { ownerId: OWNER, projectId: PROJECT });
  assert.equal(f.views.length, 0);
  assert.throws(() => f.controller.recoverySelection(OTHER_OWNER), /RECOVERY_CHANGED/);
  assert.throws(() => f.controller.teachingBinding(OWNER), /TEACHING_CHANGED/);
  assert.throws(() => f.controller.registryBinding(OWNER), /TEACHING_CHANGED/);
  await assert.rejects(f.controller.nativeBarrierCapability(OWNER), /TEACHING_CHANGED/);
  await assert.rejects(f.controller.nativeBarrier(OWNER, "resume", OTHER_OWNER), /TEACHING_CHANGED/);
  f.changeAccount();
  assert.throws(() => f.controller.recoverySelection(OWNER), /RECOVERY_CHANGED/);
});

test("recovery selection is revoked by replacement, close, invalidate and account loss", async t => {
  for (const action of ["replace", "close", "invalidate", "account"]) {
    const f = fixture(t, { join: async () => { throw new Error("COURSEWARE_ONLINE_PLATFORM_46901"); } });
    await assert.rejects(f.controller.open(OWNER, PROJECT), /PLATFORM_46901/);
    if (action === "replace") {
      await assert.rejects(f.controller.open(OTHER_OWNER, OTHER_PROJECT), /PLATFORM_46901/);
      assert.deepEqual(f.controller.recoverySelection(OTHER_OWNER), { ownerId: OTHER_OWNER, projectId: OTHER_PROJECT });
    } else if (action === "close") f.controller.close(OWNER);
    else if (action === "invalidate") f.controller.invalidate();
    else f.revoke();
    assert.throws(() => f.controller.recoverySelection(OWNER), /RECOVERY_CHANGED/);
  }
});
