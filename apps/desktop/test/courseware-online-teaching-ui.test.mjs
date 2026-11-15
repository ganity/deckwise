import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { replaceNarrationText } from "@pi-desktop/shared";

const source = await readFile(new URL("../src/components/workpanel/CoursewareOnlineTeachingPanel.tsx", import.meta.url), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const base = () => ({ schemaVersion: "deckwise-courseware/1", projectId: "team-1", taskType: "plain", title: "Lesson", source: { revision: "remote-source-1", sha256: "a".repeat(64) },
  teachingRevision: "teaching-1", pages: [
    { pageId: "logical-1", locked: false, reviewState: "review", actions: [
      { id: "speech-1", type: "speech", text: "Original narration", speakerId: "teacher", audioAssetId: "old-audio", visualCues: [{ timing: "old" }], pauseAfterMs: 300 },
      { id: "checkpoint-1", type: "interaction_checkpoint", checkpointKind: "teacher_continue", checkpointId: "wait-1" },
      { id: "music-1", type: "audio_clip", audioAssetId: "music-asset" },
      { id: "future-1", type: "future_action", data: { nested: [1, "keep"] } },
    ] },
    { pageId: "logical-2", locked: false, reviewState: "review", actions: [{ id: "speech-2", type: "speech", text: "Second page" }] },
  ] });

function fixture(options = {}) {
  const hooks = [], effects = [], calls = [], dirties = [], pendingSaves = [], timers = new Map();
  let cursor = 0, tree, writes = 0, time = 10_000, timerId = 0, viewId = 0, uuid = 0, latest;
  const project = structuredClone(options.project ?? base());
  const props = { ownerId: "owner-1", enabled: options.enabled ?? true, managePause: options.managePause ?? false,
    onDirtyChange: dirty => dirties.push(dirty), onPendingSaveChange: pending => pendingSaves.push(pending) };
  const api = {
    async coursewareOnlineTeachingRead(ownerId, pageId) {
      calls.push(["read", ownerId, pageId]);
      if (options.read) return options.read(ownerId, pageId);
      latest = { ownerId, viewId: `view-${++viewId}`, project: structuredClone(project), mappingRevision: "mapping-1", sessionEpoch: 2,
        pageId: pageId ?? project.pages[0].pageId, pageNumber: pageId === "logical-2" ? 2 : 1 };
      return structuredClone(latest);
    },
    async coursewareOnlineTeachingAcquire(id) { calls.push(["acquire", id]); latest = { ...latest, leaseExpiresAtEpochMillis: time + 60_000 }; return structuredClone(latest); },
    async coursewareOnlineTeachingRenew(id) { calls.push(["renew", id]); latest = { ...latest, leaseExpiresAtEpochMillis: time + 60_000 }; return structuredClone(latest); },
    async coursewareOnlineTeachingSave(id, actions) {
      calls.push(["save", id, structuredClone(actions)]);
      project.pages.find(page => page.pageId === latest.pageId).actions = structuredClone(actions);
      project.teachingRevision = "teaching-2";
      latest = { ...latest, project: structuredClone(project), leaseExpiresAtEpochMillis: time + 60_000 };
      return structuredClone(latest);
    },
    async coursewareOnlineTeachingRelease(id) { calls.push(["release", id]); const { leaseExpiresAtEpochMillis, ...next } = latest; latest = next; return structuredClone(latest); },
  };
  const exports = {};
  const schedule = (callback, delay, interval) => { const id = ++timerId; timers.set(id, { callback, at: time + delay, interval }); return id; };
  new Function("require", "exports", "crypto", "Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval", output)(id => {
    if (id === "@pi-desktop/shared") return { replaceNarrationText };
    if (id === "../../lib/api") return { api };
    if (id === "./CoursewareOnlineBarrierPanel") return { CoursewareOnlineBarrierPanel: "BarrierPanel" };
    if (id === "./CoursewareOnlinePauseRecovery") return { CoursewareOnlinePauseRecovery: "PauseRecovery" };
    if (id === "react-i18next") return { useTranslation: () => ({ t: (key, values) => key + (values ? " " + JSON.stringify(values) : "") }) };
    if (id === "react") return {
      useState(initial) { const index = cursor++; if (!(index in hooks)) hooks[index] = initial;
        return [hooks[index], value => { writes++; hooks[index] = typeof value === "function" ? value(hooks[index]) : value; }]; },
      useRef(initial) { const index = cursor++; return hooks[index] ??= { current: initial }; },
      useEffect(effect, dependencies) { const index = cursor++, previous = hooks[index];
        if (!previous || dependencies.some((value, i) => value !== previous.dependencies[i])) effects.push(() => { previous?.cleanup?.(); hooks[index] = { dependencies, cleanup: effect() }; }); },
    };
    assert.equal(id, "react/jsx-runtime");
    return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
  }, exports, { randomUUID: () => `added-${++uuid}` }, class extends Date { static now() { return time; } },
  (callback, delay) => schedule(callback, delay, 0), id => timers.delete(id),
  (callback, delay) => schedule(callback, delay, delay), id => timers.delete(id));
  const render = () => { cursor = 0; tree = exports.CoursewareOnlineTeachingPanel(props); while (effects.length) effects.shift()(); };
  const nodes = () => { const list = []; const visit = node => { if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return; list.push(node); visit(node.props?.children); }; visit(tree); return list; };
  const button = key => nodes().find(node => node.type === "button" && node.props.children === `panel.onlineTeaching.${key}`);
  const settle = async () => { await flush(); render(); render(); };
  const edit = async () => { button("edit").props.onClick(); await settle(); };
  const textareas = () => nodes().filter(node => node.type === "textarea");
  const text = value => { textareas()[0].props.onChange({ target: { value } }); render(); };
  const select = value => { nodes().find(node => node.type === "select").props.onChange({ target: { value } }); render(); };
  const tick = async (ms, onlyExpiry = false) => {
    const target = time + ms;
    for (;;) {
      const due = [...timers].filter(([, entry]) => entry.at <= target && (!onlyExpiry || !entry.interval)).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, entry] = due; time = entry.at;
      if (entry.interval) entry.at += entry.interval; else timers.delete(id);
      entry.callback(); await settle();
    }
    time = target; render();
  };
  const unmount = () => { for (const hook of hooks) hook?.cleanup?.(); };
  render(); render();
  return { api, props, project, calls, dirties, pendingSaves, render, settle, edit, text, textareas, select, nodes, button, tick, unmount, timers, writes: () => writes };
}

test("shared narration reads through the mounted owner and stays read-only until explicit lease acquisition", async () => {
  const f = fixture(); await f.settle();
  assert.deepEqual(f.calls, [["read", "owner-1", undefined]]);
  assert.equal(f.textareas()[0].props.disabled, true);
  assert(f.nodes().some(node => node.props?.role === "note" && node.props.children === "panel.onlineTeaching.pageScope"));
  assert.equal(f.nodes().filter(node => node.type === "option").length, 2);
  assert.equal(f.nodes().filter(node => typeof node.props?.children === "string" && node.props.children.startsWith("panel.onlineTeaching.preservedAction")).length, 3);
  f.button("save").props.onClick(); await f.settle(); assert.equal(f.calls.length, 1);
  await f.edit(); assert.deepEqual(f.calls[1], ["acquire", "view-1"]); assert.equal(f.textareas()[0].props.disabled, false);
  f.unmount(); assert.deepEqual(f.calls.at(-1), ["release", "view-1"]);
});

test("text and bounded pause edits save exact peer actions; adding/removing speech preserves checkpoints, music and unknown data", async () => {
  const f = fixture(); await f.settle(); await f.edit(); const peers = structuredClone(f.project.pages[0].actions.slice(1));
  f.text("Changed narration");
  let pause = f.nodes().find(node => node.type === "input");
  pause.props.onChange({ target: { value: "30001", valueAsNumber: 30001 } }); f.render();
  assert.equal(f.nodes().find(node => node.type === "input").props.value, 300);
  pause.props.onChange({ target: { value: "500", valueAsNumber: 500 } }); f.render();
  f.button("addSpeech").props.onClick(); f.render(); assert.equal(f.textareas().length, 2); assert.equal(f.button("save").props.disabled, true);
  f.textareas()[1].props.onChange({ target: { value: "Additional" } }); f.render(); assert.equal(f.button("save").props.disabled, false);
  f.nodes().filter(node => node.type === "button" && node.props.children === "panel.onlineTeaching.removeSpeech")[1].props.onClick(); f.render();
  f.button("save").props.onClick(); await f.settle();
  const saved = f.calls.find(call => call[0] === "save");
  assert.equal(saved[1], "view-1"); assert.deepEqual(saved[2].slice(1), peers);
  assert.deepEqual(saved[2][0], { id: "speech-1", type: "speech", text: "Changed narration", speakerId: "teacher", pauseAfterMs: 500 });
  assert.equal(f.dirties.at(-1), false); assert.equal(f.button("save").props.disabled, true);
  assert.equal(f.project.pages[1].actions[0].text, "Second page"); f.unmount();
});

test("lease renews every 20 seconds; renewal failure freezes writing and retains the draft", async () => {
  const f = fixture(); await f.settle(); await f.edit(); f.text("Unsaved");
  await f.tick(20_000); assert.equal(f.calls.filter(call => call[0] === "renew").length, 1);
  f.api.coursewareOnlineTeachingRenew = async id => { f.calls.push(["renew", id]); throw new Error("LEASE_CONFLICT private-token"); };
  await f.tick(20_000);
  assert.equal(f.textareas()[0].props.value, "Unsaved"); assert.equal(f.textareas()[0].props.disabled, true);
  assert.equal(f.dirties.at(-1), true); assert.equal(f.button("save").props.disabled, true);
  assert(!JSON.stringify(f.nodes()).includes("private-token")); f.unmount();
});

test("expiry disables stale captured text/save handlers without losing the draft", async () => {
  const f = fixture(); await f.settle(); await f.edit(); f.text("Unsaved");
  const edit = f.textareas()[0].props.onChange, save = f.button("save").props.onClick;
  await f.tick(60_001, true); edit({ target: { value: "Late" } }); save(); await f.settle();
  assert.equal(f.textareas()[0].props.value, "Unsaved"); assert.equal(f.calls.filter(call => call[0] === "save").length, 0);
  assert(f.nodes().some(node => node.props?.role === "alert" && node.props.children === "panel.onlineTeaching.expired")); f.unmount();
});

test("save conflicts retain local drafts; refresh and page change require explicit discard before any read", async () => {
  const f = fixture(); await f.settle(); await f.edit(); f.text("My unsaved words");
  f.api.coursewareOnlineTeachingSave = async () => { throw new Error("TEACHING_REVISION_CONFLICT private-detail"); };
  f.button("save").props.onClick(); await f.settle();
  assert.equal(f.textareas()[0].props.value, "My unsaved words"); assert.equal(f.dirties.at(-1), true);
  f.button("refresh").props.onClick(); f.render(); assert.equal(f.calls.filter(call => call[0] === "read").length, 1);
  f.button("keepDraft").props.onClick(); f.render(); assert.equal(f.textareas()[0].props.value, "My unsaved words");
  f.select("logical-2"); assert.equal(f.calls.filter(call => call[0] === "read").length, 1);
  f.button("discardDraft").props.onClick(); await f.settle();
  assert.deepEqual(f.calls.at(-1), ["read", "owner-1", "logical-2"]); assert.equal(f.textareas()[0].props.value, "Second page");
  assert.equal(f.dirties.at(-1), false); assert(!JSON.stringify(f.nodes()).includes("private-detail")); f.unmount();
});

test("release and reacquire retain a draft instead of replacing it with a lease response", async () => {
  const f = fixture(); await f.settle(); await f.edit(); f.text("Keep across release");
  f.button("release").props.onClick(); await f.settle(); assert.equal(f.textareas()[0].props.value, "Keep across release");
  assert.equal(f.textareas()[0].props.disabled, true); assert.equal(f.dirties.at(-1), true);
  await f.edit(); assert.equal(f.textareas()[0].props.value, "Keep across release");
  f.button("save").props.onClick(); await f.settle(); assert.equal(f.project.pages[0].actions[0].text, "Keep across release"); f.unmount();
});

test("captured controls cannot save an invalid new draft or edit the subsequently selected page", async () => {
  const f = fixture(); await f.settle(); await f.edit(); f.text("Valid draft");
  const save = f.button("save").props.onClick;
  f.textareas()[0].props.onChange({ target: { value: "" } }); save(); await f.settle();
  assert.equal(f.calls.filter(call => call[0] === "save").length, 0);
  const previousText = f.textareas()[0].props.onChange;
  f.select("logical-2"); f.button("discardDraft").props.onClick(); await f.settle();
  await f.edit(); previousText({ target: { value: "Wrong page" } }); f.render();
  assert.equal(f.textareas()[0].props.value, "Second page"); f.unmount();
});

test("lease acquisition accepts a newer global revision when source, mapping and selected page are unchanged", async () => {
  const f = fixture(); await f.settle();
  const acquire = f.api.coursewareOnlineTeachingAcquire;
  f.project.teachingRevision = "peer-update"; f.project.pages[1].actions[0].text = "Peer page updated";
  f.api.coursewareOnlineTeachingAcquire = async id => ({ ...await acquire(id), project: structuredClone(f.project) });
  await f.edit(); assert.equal(f.textareas()[0].props.disabled, false);
  f.text("My current page"); f.button("save").props.onClick(); await f.settle();
  assert.equal(f.project.pages[0].actions[0].text, "My current page"); assert.equal(f.project.pages[1].actions[0].text, "Peer page updated"); f.unmount();
});

test("unknown save results freeze exact actions and allow only explicit same-view replay even after lease deadline", async () => {
  const f = fixture(); await f.settle(); await f.edit(); f.text("Original uncertain draft");
  const save = f.api.coursewareOnlineTeachingSave, attempts = [];
  f.api.coursewareOnlineTeachingSave = async (viewId, actions) => { attempts.push([viewId, structuredClone(actions)]);
    if (attempts.length === 1) throw new Error("COURSEWARE_ONLINE_TEACHING_PENDING_WRITE"); return save(viewId, actions); };
  const oldText = f.textareas()[0].props.onChange;
  f.button("save").props.onClick(); await f.settle();
  assert.equal(f.pendingSaves.at(-1), true); assert.equal(f.textareas()[0].props.disabled, true);
  assert.equal(f.button("release").props.disabled, true); assert.equal(f.button("refresh").props.disabled, true);
  oldText({ target: { value: "Cannot replace uncertain body" } }); f.button("refresh").props.onClick(); f.select("logical-2"); await f.settle();
  assert.equal(f.calls.filter(call => call[0] === "read").length, 1); assert.equal(f.textareas()[0].props.value, "Original uncertain draft");
  await f.tick(60_001); assert.equal(f.calls.filter(call => call[0] === "renew").length, 0);
  assert.equal(f.button("resumeSave").props.disabled, false); f.button("resumeSave").props.onClick(); await f.settle();
  assert.deepEqual(attempts[1], attempts[0]); assert.equal(f.pendingSaves.at(-1), false); assert.equal(f.dirties.at(-1), false);
  assert.equal(f.textareas()[0].props.value, "Original uncertain draft"); f.unmount();
});

test("disabled/empty/locked states do not acquire; disconnected controls and late responses cannot mutate", async () => {
  const disabled = fixture({ enabled: false }); await disabled.settle(); assert.deepEqual(disabled.calls, []);
  disabled.props.enabled = true; disabled.render(); await disabled.settle(); assert.equal(disabled.calls[0][0], "read"); disabled.unmount();
  const empty = fixture({ read: async () => null }); await empty.settle(); assert.equal(empty.button("edit"), undefined);
  assert(empty.nodes().some(node => node.props?.children === "panel.onlineTeaching.empty")); empty.unmount();
  const project = base(); project.pages[0].locked = true;
  const locked = fixture({ project }); await locked.settle(); assert.equal(locked.button("edit").props.disabled, true);
  locked.button("edit").props.onClick(); await locked.settle();
  assert.equal(locked.calls.filter(call => call[0] === "acquire").length, 0); locked.unmount();
  const f = fixture(); await f.settle(); await f.edit(); f.text("Keep offline"); const save = f.button("save").props.onClick;
  f.props.enabled = false; f.render(); save(); await f.settle(); assert.equal(f.calls.filter(call => call[0] === "save").length, 0);
  assert.equal(f.textareas()[0].props.value, "Keep offline"); f.unmount();
  const pending = deferred(), late = fixture({ read: () => pending.promise }); late.unmount(); const writes = late.writes();
  pending.resolve(null); await flush(); assert.equal(late.writes(), writes);
});

test("Owner pause recovery freezes new edits without losing a draft and resumes through the guarded page reader", async () => {
  const f = fixture({ managePause: true }); await f.settle();
  const recovery = () => f.nodes().find(node => node.type === "PauseRecovery");
  assert.equal(recovery().props.ownerId, "owner-1");
  await f.edit(); f.text("Keep my draft");
  const oldText = f.textareas()[0].props.onChange;
  recovery().props.onHeldChange(true); f.render();
  assert.equal(f.textareas()[0].props.disabled, true);
  assert.equal(recovery().props.blocked, true);
  oldText({ target: { value: "Late edit after pause" } }); f.render();
  assert.equal(f.textareas()[0].props.value, "Keep my draft");
  recovery().props.onResumed(); await f.settle();
  assert.equal(f.calls.filter(call => call[0] === "read").length, 1);
  assert(f.nodes().some(node => node.props?.children === "panel.onlineTeaching.discardPrompt"));
  assert.equal(f.textareas()[0].props.value, "Keep my draft"); f.unmount();

  const clean = fixture({ managePause: true }); await clean.settle();
  const previousEdit = clean.button("edit").props.onClick;
  const pause = () => clean.nodes().find(node => node.type === "PauseRecovery");
  pause().props.onHeldChange(true); clean.render(); previousEdit(); await clean.settle();
  assert.equal(clean.calls.filter(call => call[0] === "acquire").length, 0);
  pause().props.onHeldChange(false); pause().props.onResumed(); await clean.settle();
  assert.equal(clean.calls.filter(call => call[0] === "read").length, 2);
  await clean.edit(); assert.equal(clean.textareas()[0].props.disabled, false); clean.unmount();
});


test("native barrier uncertainty cannot be cleared by the independent teaching pause read", async () => {
  const f = fixture({ managePause: true }); await f.settle(); await f.edit();
  const barrier = () => f.nodes().find(node => node.type === "BarrierPanel");
  const recovery = () => f.nodes().find(node => node.type === "PauseRecovery");
  barrier().props.onHeldChange(true); f.render();
  recovery().props.onHeldChange(false); f.render();
  assert.equal(f.textareas()[0].props.disabled, true);
  assert.equal(recovery().props.blocked, true);
  barrier().props.onHeldChange(false); f.render();
  assert.equal(f.textareas()[0].props.disabled, false); f.unmount();
});

test("Owner recovery remains usable after native join fails while narration stays disconnected", async () => {
  const f = fixture({ managePause: true, enabled: false }); f.props.barrierEnabled = true; f.render();
  const barrier = f.nodes().find(node => node.type === "BarrierPanel");
  assert.equal(barrier.props.enabled, true);
  assert.equal(f.nodes().find(node => node.type === "PauseRecovery").props.enabled, false);
  assert.equal(f.button("edit"), undefined); assert.equal(f.calls.length, 0); f.unmount();
});
