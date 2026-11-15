import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/components/workpanel/CoursewareOnlinePauseRecovery.tsx", import.meta.url), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const held = (ownerId = "owner-1", viewId = "view-1") => ({ ownerId, viewId, sessionEpoch: 2, teachingRevision: "frozen-revision" });

function fixture(options = {}) {
  const hooks = [], effects = [], calls = [], heldChanges = [], resumed = [];
  let cursor = 0, tree, writes = 0;
  const props = { ownerId: "owner-1", enabled: true, blocked: false,
    onHeldChange: value => heldChanges.push(["owner-1", value]), onResumed: () => resumed.push("owner-1"), ...options.props };
  const api = {
    async coursewareOnlinePauseRead(ownerId) { calls.push(["read", ownerId]); return options.read ? options.read(ownerId) : null; },
    async coursewareOnlinePauseResume(viewId) { calls.push(["resume", viewId]); return options.resume ? options.resume(viewId) : { ok: true }; },
  };
  const exports = {};
  new Function("require", "exports", output)(id => {
    if (id === "../../lib/api") return { api };
    if (id === "react-i18next") return { useTranslation: () => ({ t: (key, values) => key + (values ? " " + JSON.stringify(values) : "") }) };
    if (id === "react") return {
      useState(initial) { const index = cursor++; if (!(index in hooks)) hooks[index] = initial;
        return [hooks[index], value => { writes++; hooks[index] = typeof value === "function" ? value(hooks[index]) : value; }]; },
      useRef(initial) { const index = cursor++; return hooks[index] ??= { current: initial }; },
      useEffect(effect, dependencies) { const index = cursor++, previous = hooks[index];
        if (!previous || dependencies.some((value, i) => value !== previous.dependencies[i])) effects.push(() => {
          previous?.cleanup?.(); hooks[index] = { dependencies, cleanup: effect() };
        }); },
    };
    assert.equal(id, "react/jsx-runtime");
    return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
  }, exports);
  const render = () => { cursor = 0; tree = exports.CoursewareOnlinePauseRecovery(props); while (effects.length) effects.shift()(); };
  const nodes = () => { const list = []; const visit = node => { if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return; list.push(node); visit(node.props?.children); }; visit(tree); return list; };
  const button = key => nodes().find(node => node.type === "button" && node.props.children === `panel.onlineTeaching.${key}`);
  const settle = async () => { await flush(); render(); render(); };
  const unmount = () => { for (const hook of hooks) hook?.cleanup?.(); };
  render(); render();
  return { props, api, calls, heldChanges, resumed, render, nodes, button, settle, unmount, writes: () => writes };
}

test("mount reads without mutation; no pause shows a concise status and explicit check", async () => {
  const f = fixture(); await f.settle();
  assert.deepEqual(f.calls, [["read", "owner-1"]]); assert.deepEqual(f.resumed, []);
  assert.equal(f.button("pauseResume"), undefined);
  assert(f.nodes().some(node => node.props?.role === "status" && node.props.children === "panel.onlineTeaching.pauseNotHeld"));
  f.button("pauseCheck").props.onClick(); await f.settle();
  assert.deepEqual(f.calls, [["read", "owner-1"], ["read", "owner-1"]]); f.unmount();
});

test("held pause displays its frozen revision and native-editing boundary; only explicit resume changes it", async () => {
  const f = fixture({ read: () => held() }); await f.settle();
  assert.equal(f.heldChanges.at(-1)[1], true);
  assert(f.nodes().some(node => typeof node.props?.children === "string" && node.props.children.includes('"revision":"frozen-revision","epoch":2')));
  assert(f.nodes().some(node => node.props?.role === "note" && node.props.children === "panel.onlineTeaching.pauseScope"));
  assert.equal(f.calls.filter(call => call[0] === "resume").length, 0);
  const resume = f.button("pauseResume").props.onClick; resume(); resume(); await f.settle();
  assert.deepEqual(f.calls, [["read", "owner-1"], ["resume", "view-1"]]);
  assert.deepEqual(f.resumed, ["owner-1"]); assert.equal(f.heldChanges.at(-1)[1], false); assert.equal(f.button("pauseResume"), undefined); f.unmount();
});

test("blocked state permits reads but guards both visible and previously captured resume handlers", async () => {
  const f = fixture({ read: () => held() }); await f.settle();
  const resume = f.button("pauseResume").props.onClick;
  f.props.blocked = true; f.render(); resume(); await f.settle();
  assert.equal(f.button("pauseResume").props.disabled, true); assert.equal(f.button("pauseCheck").props.disabled, false);
  f.button("pauseCheck").props.onClick(); await f.settle();
  assert.equal(f.calls.filter(call => call[0] === "read").length, 2); assert.equal(f.calls.filter(call => call[0] === "resume").length, 0);
  f.props.blocked = false; f.render(); f.button("pauseResume").props.onClick(); await f.settle(); assert.deepEqual(f.resumed, ["owner-1"]); f.unmount();
});

test("read failure exposes fixed copy and an explicit retry; failed recheck retains a previously held view", async () => {
  let fail = true;
  const f = fixture({ read() { if (fail) throw new Error("/private/profile/token"); return held(); } }); await f.settle();
  assert(f.nodes().some(node => node.props?.role === "alert" && node.props.children === "panel.onlineTeaching.pauseRecoverFailed"));
  assert(!JSON.stringify(f.nodes()).includes("/private"));
  fail = false; f.button("pauseCheck").props.onClick(); await f.settle(); assert.equal(f.heldChanges.at(-1)[1], true);
  fail = true; f.button("pauseCheck").props.onClick(); await f.settle();
  assert(f.button("pauseResume")); assert.equal(f.heldChanges.at(-1)[1], true); f.unmount();
});

test("lost resume response retains the exact view for explicit same-ID retry, without automatic DELETE", async () => {
  let attempts = 0;
  const f = fixture({ read: () => held(), resume() { if (++attempts === 1) throw new Error("lost response /private/auth"); return { ok: true }; } });
  await f.settle(); f.button("pauseResume").props.onClick(); await f.settle();
  assert.deepEqual(f.calls.filter(call => call[0] === "resume"), [["resume", "view-1"]]);
  assert.equal(f.heldChanges.at(-1)[1], true); assert.deepEqual(f.resumed, []);
  assert(f.nodes().some(node => node.props?.role === "alert" && node.props.children === "panel.onlineTeaching.pauseResumeFailed"));
  assert(!JSON.stringify(f.nodes()).includes("/private"));
  f.button("pauseResume").props.onClick(); await f.settle();
  assert.deepEqual(f.calls.filter(call => call[0] === "resume"), [["resume", "view-1"], ["resume", "view-1"]]);
  assert.deepEqual(f.resumed, ["owner-1"]); f.unmount();
});

test("new owner rejects late reads and old controls and clears only the previous callback ownership", async () => {
  const pending = deferred();
  const f = fixture({ read: owner => owner === "owner-1" ? pending.promise : held(owner, "view-2") });
  const oldCheck = f.button("pauseCheck").props.onClick;
  f.props.ownerId = "owner-2"; f.props.onHeldChange = value => f.heldChanges.push(["owner-2", value]);
  f.props.onResumed = () => f.resumed.push("owner-2"); f.render(); await f.settle();
  const count = f.calls.length, changes = f.heldChanges.length;
  oldCheck(); pending.resolve(held()); await f.settle();
  assert.equal(f.calls.length, count); assert.equal(f.heldChanges.length, changes);
  assert.deepEqual(f.heldChanges, [["owner-1", false], ["owner-1", false], ["owner-2", false], ["owner-2", true]]);
  f.button("pauseResume").props.onClick(); await f.settle(); assert.deepEqual(f.calls.at(-1), ["resume", "view-2"]); assert.deepEqual(f.resumed, ["owner-2"]); f.unmount();
});

test("late resume cannot clear a new owner's held state or invoke its reload", async () => {
  const pending = deferred();
  const f = fixture({ read: owner => held(owner, owner === "owner-1" ? "view-1" : "view-2"), resume: () => pending.promise });
  await f.settle(); const oldResume = f.button("pauseResume").props.onClick; oldResume();
  f.props.ownerId = "owner-2"; f.props.onHeldChange = value => f.heldChanges.push(["owner-2", value]);
  f.props.onResumed = () => f.resumed.push("owner-2"); f.render(); await f.settle();
  const count = f.calls.length, changes = f.heldChanges.length; oldResume(); pending.resolve({ ok: true }); await f.settle();
  assert.equal(f.calls.length, count); assert.equal(f.heldChanges.length, changes); assert.deepEqual(f.resumed, []);
  assert.equal(f.heldChanges.at(-1)[0], "owner-2"); assert.equal(f.heldChanges.at(-1)[1], true); f.unmount();
});

test("disabled transitions and unmount reject in-flight results and captured handlers without automatic resume", async () => {
  const pending = deferred(), f = fixture({ read: () => pending.promise });
  const check = f.button("pauseCheck").props.onClick;
  f.props.enabled = false; f.render(); const changes = f.heldChanges.length; check();
  pending.resolve(held()); await f.settle();
  assert.equal(f.heldChanges.length, changes); assert.equal(f.button("pauseCheck").props.disabled, true); assert.equal(f.button("pauseResume"), undefined);
  f.api.coursewareOnlinePauseRead = async ownerId => { f.calls.push(["read", ownerId]); return held(ownerId); };
  f.props.enabled = true; f.render(); await f.settle();
  assert.equal(f.heldChanges.at(-1)[1], true);
  const late = deferred(); f.api.coursewareOnlinePauseResume = async viewId => { f.calls.push(["resume", viewId]); return late.promise; };
  const resume = f.button("pauseResume").props.onClick; resume(); f.unmount();
  const writes = f.writes(), callbacks = f.heldChanges.length; resume(); late.resolve({ ok: true }); await flush();
  assert.equal(f.writes(), writes); assert.equal(f.heldChanges.length, callbacks); assert.deepEqual(f.resumed, []);
});

test("a foreign-owner read cannot be presented or resumed", async () => {
  const f = fixture({ read: () => held("foreign") }); await f.settle();
  assert.equal(f.button("pauseResume"), undefined); assert.equal(f.heldChanges.at(-1)[1], false);
  assert(f.nodes().some(node => node.props?.children === "panel.onlineTeaching.pauseRecoverFailed")); f.unmount();
});
