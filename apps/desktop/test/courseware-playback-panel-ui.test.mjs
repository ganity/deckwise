import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const output = ts.transpileModule(await readFile(new URL("../src/components/workpanel/CoursewarePlaybackPanel.tsx", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const snapshot = { snapshotId: "snapshot-1", projectId: "team-1", source: { revision: "source-1", sha256: "a".repeat(64) }, teachingRevision: "teaching-1", mappingRevision: "mapping-1", assetIds: [] };
const ready = { status: "ready", previewId: "preview-1", snapshot, buildRef: { buildId: "build-1", snapshotId: snapshot.snapshotId, packageSha256: "b".repeat(64) }, report: { visualFidelity: "checked", diagnostics: [] } };
const unknown = { intentId: "intent-1", state: "unknown", selection: { projectId: "team-1", snapshotId: "snapshot-1", buildId: "build-1", manifestSha256: "b".repeat(64), teamProjectId: "team-1", channel: "shared" } };

function fixture(options = {}) {
  const hooks = [], effects = [], calls = [], auth = new Set();
  let cursor = 0, tree;
  const props = { sessionId: "chat-1", enabled: true, onActiveChange: value => calls.push(["active", value]),
    ...(options.local ? { view: { viewId: "local-view", project: { teachingRevision: "teaching-1", pages: [{ reviewState: "ready", actions: [] }] } } }
      : { onlineSource: { viewId: "online-view", ownerId: "owner-1", teamProjectId: "team-1", readyPages: options.readyPages ?? 1, totalPages: 1 } }) };
  let intent = options.intent ?? null;
  const api = {
    onAuthChanged(listener) { auth.add(listener); return () => auth.delete(listener); },
    async coursewareFixedCancel() { calls.push(["cancel"]); return { ok: true }; },
    async coursewareOnlineSourceCapture(request) { calls.push(["capture", request]); return options.capture ? options.capture(request) : { viewId: "online-view", ownerId: "owner-1", snapshot }; },
    async pptEditorSnapshotCapture(...args) { calls.push(["local-capture", ...args]); return snapshot; },
    async coursewareFixedBuild(...args) { calls.push(["build", ...args]); return options.build ? options.build(...args) : ready; },
    async coursewareFixedApprove(...args) { calls.push(["approve", ...args]); return ready; },
    async coursewareFixedPlay(...args) { calls.push(["play", ...args]); return { ok: true }; },
    async coursewareTeamProjects() { calls.push(["teams"]); return [{ projectId: "team-1", role: "OWNER" }, { projectId: "other-team", role: "EDITOR" }]; },
    async coursewareFixedShare(...args) { calls.push(["share", ...args]); if (options.share) return options.share(...args); return { ok: true }; },
    async coursewareFixedShareStatus(...args) { calls.push(["status", ...args]); return options.status ? options.status(...args) : { intent }; },
    async coursewareFixedShareRecover(...args) { calls.push(["recover", ...args]); intent = { ...unknown, state: "bound" }; return { intent }; },
  };
  const exports = {};
  new Function("require", "exports", output)(id => {
    if (id === "../../lib/api") return { api };
    if (id === "react-i18next") return { useTranslation: () => ({ t: key => key, i18n: { language: "zh-CN" } }) };
    if (id === "react") return {
      useState(initial) { const index = cursor++; if (!(index in hooks)) hooks[index] = initial; return [hooks[index], value => { hooks[index] = typeof value === "function" ? value(hooks[index]) : value; }]; },
      useRef(initial) { return hooks[cursor++] ??= { current: initial }; },
      useCallback(callback, dependencies) { const index = cursor++, previous = hooks[index]; if (!previous || dependencies.some((value, i) => value !== previous.dependencies[i])) hooks[index] = { dependencies, callback }; return hooks[index].callback; },
      useEffect(effect, dependencies) { const index = cursor++, previous = hooks[index]; if (!previous || dependencies.some((value, i) => value !== previous.dependencies[i])) effects.push(() => { previous?.cleanup?.(); hooks[index] = { dependencies, cleanup: effect() }; }); },
    };
    assert.equal(id, "react/jsx-runtime");
    return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
  }, exports);
  const nodes = () => { const values = []; const visit = node => { if (Array.isArray(node)) return node.forEach(visit); if (!node || typeof node !== "object") return; values.push(node); visit(node.props?.children); }; visit(tree); return values; };
  const render = () => { cursor = 0; tree = exports.CoursewarePlaybackPanel(props); while (effects.length) effects.shift()(); };
  const settle = async () => { for (let i = 0; i < 3; i++) { await flush(); render(); } };
  const button = key => nodes().find(node => node.type === "button" && node.props.children === key);
  render(); render();
  return { props, calls, nodes, render, settle, button, auth: () => { for (const listener of auth) listener(); }, setIntent: value => { intent = value; },
    unmount: () => { for (const hook of hooks) hook?.cleanup?.(); } };
}
const source = key => `panel.onlineSource.${key}`;
const playback = key => `panel.pptEditor.playback${key}`;
async function build(f) { f.button(source("capture")).props.onClick(); await f.settle(); }
function confirmShare(f) { const checkbox = f.nodes().find(node => node.type === "input" && node.props.type === "checkbox"); checkbox.props.onChange({ target: { checked: true } }); f.render(); }

test("online fixed build only captures explicitly after every page is ready; local capture keeps its existing API", async () => {
  const f = fixture({ readyPages: 0 }); await f.settle();
  assert.equal(f.button(source("capture")).props.disabled, true); f.button(source("capture")).props.onClick(); await f.settle();
  assert(!f.calls.some(call => call[0] === "capture")); f.unmount();
  const g = fixture(); await g.settle(); assert(!g.calls.some(call => call[0] === "capture")); await build(g);
  assert.deepEqual(g.calls.find(call => call[0] === "capture"), ["capture", { viewId: "online-view" }]);
  assert.deepEqual(g.calls.find(call => call[0] === "build"), ["build", "chat-1", snapshot]);
  assert(!g.calls.some(call => call[0] === "local-capture" || call[0] === "teams" || call[0] === "share"));
  assert.equal(g.nodes().filter(node => node.type === "select").length, 1, "online target is fixed; only the channel is selectable"); g.unmount();
  const h = fixture({ local: true }); await h.settle(); h.button(playback("Build")).props.onClick(); await h.settle();
  assert.deepEqual(h.calls.find(call => call[0] === "local-capture"), ["local-capture", "local-view", "teaching-1"]);
  assert(h.calls.some(call => call[0] === "teams")); assert(!h.calls.some(call => call[0] === "capture")); h.unmount();
});

test("capture refuses foreign owner/view/project and keeps errors generic", async () => {
  for (const change of [{ ownerId: "foreign" }, { viewId: "foreign" }, { snapshot: { ...snapshot, projectId: "foreign" } }]) {
    const f = fixture({ capture: () => ({ viewId: "online-view", ownerId: "owner-1", snapshot, ...change }) }); await build(f);
    assert(!f.calls.some(call => call[0] === "build")); assert(f.nodes().some(node => node.props?.role === "alert" && node.props.children === source("playbackFailed"))); f.unmount();
  }
});

test("conversion warnings require each explicit approval before preview and channel-specific publication confirmation", async () => {
  const f = fixture({ build: () => ({ status: "review", reviewId: "warning-1", snapshot, diagnostics: [{ code: "FONT_FALLBACK", severity: "warning" }, { code: "UNSUPPORTED_TRANSITION", severity: "warning" }] }) });
  await build(f); const proceed = f.button(playback("Continue")); assert.equal(proceed.props.disabled, true); proceed.props.onClick(); assert(!f.calls.some(call => call[0] === "approve"));
  while (f.nodes().some(node => node.type === "input" && !node.props.checked)) {
    f.nodes().find(node => node.type === "input" && !node.props.checked).props.onChange({ target: { checked: true } }); f.render();
  }
  f.button(playback("Continue")).props.onClick(); await f.settle();
  assert.deepEqual(f.calls.find(call => call[0] === "approve"), ["approve", "warning-1", ["FONT_FALLBACK", "UNSUPPORTED_TRANSITION"]]);
  f.button(playback("Play")).props.onClick(); await f.settle(); assert.deepEqual(f.calls.find(call => call[0] === "play"), ["play", "preview-1", "zh-CN"]);
  assert.equal(f.button(source("publishShared")).props.disabled, true); f.button(source("publishShared")).props.onClick(); assert(!f.calls.some(call => call[0] === "share"));
  confirmShare(f); const staleShared = f.button(source("publishShared")).props.onClick;
  f.nodes().find(node => node.type === "select").props.onChange({ target: { value: "formal" } }); f.render(); staleShared();
  assert.equal(f.button(source("publishFormal")).props.disabled, true); assert(!f.calls.some(call => call[0] === "share"));
  confirmShare(f); const publish = f.button(source("publishFormal")).props.onClick; publish(); publish(); await f.settle();
  assert.deepEqual(f.calls.filter(call => call[0] === "share"), [["share", "preview-1", "team-1", "chat-1", "formal"]]);
  assert(f.nodes().some(node => node.props?.children === source("publishedFormal"))); f.unmount();
});

test("lost publication response allows only original receipt queries, including captured publish handlers", async () => {
  const f = fixture({ share: () => { f.setIntent(unknown); throw new Error("private-token https://secret.invalid"); } }); await build(f); confirmShare(f);
  const publish = f.button(source("publishShared")).props.onClick; publish(); await f.settle();
  assert.equal(f.calls.filter(call => call[0] === "share").length, 1); publish(); await f.settle();
  assert.equal(f.calls.filter(call => call[0] === "share").length, 1); assert.equal(f.button(source("publishShared")).props.disabled, true);
  assert(!JSON.stringify(f.nodes()).includes("private-token"));
  f.button(source("recover")).props.onClick(); await f.settle(); assert.deepEqual(f.calls.find(call => call[0] === "recover"), ["recover", "chat-1", "intent-1"]);
  assert.equal(f.calls.filter(call => call[0] === "share").length, 1); assert(f.nodes().some(node => node.props?.children === source("publishKnown"))); f.unmount();
});

test("failed status checks block publication until an explicit status refresh succeeds", async () => {
  let fail = true;
  const f = fixture({ status: () => { if (fail) throw new Error("offline"); return { intent: null }; } }); await build(f); confirmShare(f);
  assert.equal(f.button(source("publishShared")).props.disabled, true); f.button(source("publishShared")).props.onClick(); assert(!f.calls.some(call => call[0] === "share"));
  fail = false; f.button(source("recover")).props.onClick(); await f.settle(); confirmShare(f); f.button(source("publishShared")).props.onClick(); await f.settle();
  assert.equal(f.calls.filter(call => call[0] === "share").length, 1); f.unmount();
});

test("a lost publication with no receipt or a different receipt never unlocks a second POST", async () => {
  const f = fixture({ share: () => { throw new Error("response lost"); } }); await build(f); confirmShare(f);
  const publish = f.button(source("publishShared")).props.onClick; publish(); await f.settle();
  assert.equal(f.button(source("publishShared")).props.disabled, true);
  f.button(source("recover")).props.onClick(); await f.settle(); confirmShare(f); publish();
  f.setIntent({ ...unknown, state: "bound", selection: { ...unknown.selection, buildId: "other-build" } });
  f.button(source("recover")).props.onClick(); await f.settle(); confirmShare(f); publish(); await f.settle();
  assert.equal(f.calls.filter(call => call[0] === "share").length, 1);
  assert.equal(f.button(source("publishShared")).props.disabled, true); f.unmount();
});

test("unconfirmed prior publication blocks new POST even after a fresh build", async () => {
  const f = fixture({ intent: unknown }); await build(f); confirmShare(f); const button = f.button(source("publishShared")); assert.equal(button.props.disabled, true); button.props.onClick();
  assert(!f.calls.some(call => call[0] === "share")); f.button(source("recover")).props.onClick(); await f.settle(); assert(f.calls.some(call => call[0] === "recover")); f.unmount();
});

test("session/account/owner changes and closure fence late captures and captured controls", async () => {
  for (const change of [f => { f.props.sessionId = "other-chat"; f.render(); }, f => { f.props.onlineSource = { ...f.props.onlineSource, ownerId: "other-owner" }; f.render(); }, f => f.auth(), f => f.unmount()]) {
    const pending = deferred(); const f = fixture({ capture: () => pending.promise }); await f.settle(); const start = f.button(source("capture")).props.onClick; start(); await f.settle(); change(f);
    pending.resolve({ viewId: "online-view", ownerId: "owner-1", snapshot }); await f.settle(); start(); await f.settle();
    assert(!f.calls.some(call => call[0] === "build")); assert.equal(f.calls.filter(call => call[0] === "capture").length, 1); f.unmount();
  }
});

test("closing a fixed preview cancels it and cannot resume native or teaching editing", async () => {
  const f = fixture(); await build(f); const play = f.button(playback("Play")).props.onClick;
  f.button(playback("Close")).props.onClick(); await f.settle(); play(); await f.settle();
  assert(!f.calls.some(call => call[0] === "play")); assert(f.calls.filter(call => call[0] === "cancel").length >= 2);
  assert(!f.calls.some(call => /resume|clear|source-begin/i.test(call[0]))); f.unmount();
});
