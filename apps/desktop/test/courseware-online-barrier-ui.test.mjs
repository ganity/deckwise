import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/components/workpanel/CoursewareOnlineBarrierPanel.tsx", import.meta.url), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const state = (ownerId = "owner-1", value = "idle") => ({ ownerId, viewId: "view-1", sessionEpoch: 2, state: value, teachingPaused: value !== "idle" && value !== "released", uncertain: false, canStart: true, held: value === "held" ? 1 : 0, total: value === "idle" ? 0 : 1, consistentPublicationReady: false });

function fixture(options = {}) {
  const hooks = [], effects = [], calls = [], heldChanges = [], resumed = [];
  let cursor = 0, tree, writes = 0;
  const props = { ownerId: "owner-1", enabled: true, blocked: false,
    onHeldChange: value => heldChanges.push(["owner-1", value]), onResumed: () => resumed.push("owner-1"), ...options.props };
  const api = {
    async coursewareOnlineBarrierRead(ownerId) { calls.push(["read", ownerId]); return options.read ? options.read(ownerId) : state(ownerId); },
    async coursewareOnlineBarrierResume(viewId) { calls.push(["resume", viewId]); return options.resume ? options.resume(viewId) : state("owner-1", "released"); },
  };
  api.coursewareOnlineBarrierStart = async viewId => { calls.push(["start", viewId]); return options.start ? options.start(viewId) : state("owner-1", "draining"); };
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
  const render = () => { cursor = 0; tree = exports.CoursewareOnlineBarrierPanel(props); while (effects.length) effects.shift()(); };
  const nodes = () => { const list = []; const visit = node => { if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return; list.push(node); visit(node.props?.children); }; visit(tree); return list; };
  const button = key => nodes().find(node => node.type === "button" && node.props.children === `panel.onlineBarrier.${key}`);
  const settle = async () => { await flush(); render(); render(); };
  const unmount = () => { for (const hook of hooks) hook?.cleanup?.(); };
  render(); render();
  return { props, api, calls, heldChanges, resumed, render, nodes, button, settle, unmount, writes: () => writes };
}

test("inspect is read only; explicit start and refresh show registered reports without offering publication", async () => {
  let next = state();
  const f = fixture({ read: () => next, start: () => { next = state("owner-1", "draining"); return next; } }); await f.settle();
  assert.deepEqual(f.calls, [["read", "owner-1"]]);
  assert(f.nodes().some(node => node.props?.role === "note" && node.props.children === "panel.onlineBarrier.incompleteProof"));
  const start = f.button("start").props.onClick; start(); start(); await f.settle();
  assert.deepEqual(f.calls.at(-1), ["start", "view-1"]); assert.equal(f.calls.filter(row => row[0] === "start").length, 1);
  assert.equal(f.heldChanges.at(-1)[1], true);
  next = state("owner-1", "held"); f.button("refresh").props.onClick(); await f.settle();
  assert(f.nodes().some(node => typeof node.props?.children?.[2] === "string" && node.props.children[2].includes('"held":1,"total":1')));
  assert.equal(f.button("resume").props.disabled, false); f.button("resume").props.onClick(); await f.settle();
  assert.deepEqual(f.calls.at(-1), ["resume", "view-1"]); assert.equal(f.heldChanges.at(-1)[1], false); assert.deepEqual(f.resumed, ["owner-1"]);
  f.unmount();
});

test("unsaved teaching disables captured mutating controls while permitting recheck", async () => {
  const f = fixture(); await f.settle(); const start = f.button("start").props.onClick;
  f.props.blocked = true; f.render(); start(); await f.settle();
  assert.equal(f.button("start").props.disabled, true); assert.equal(f.calls.filter(row => row[0] === "start").length, 0);
  f.button("refresh").props.onClick(); await f.settle(); assert.equal(f.calls.filter(row => row[0] === "read").length, 2); f.unmount();
});

test("lost start leaves teaching read only and shows fixed uncertainty copy without auto retry or release", async () => {
  const f = fixture({ start() { throw new Error("/private/token"); } }); await f.settle();
  f.button("start").props.onClick(); await f.settle();
  assert.equal(f.heldChanges.at(-1)[1], true);
  assert(f.nodes().some(node => node.props?.role === "alert" && node.props.children === "panel.onlineBarrier.uncertain"));
  assert(!JSON.stringify(f.nodes()).includes("/private")); assert.deepEqual(f.resumed, []);
  assert.equal(f.calls.filter(row => row[0] === "start").length, 1); f.unmount();
});

test("a pending read from another owner or a disabled/unmounted instance cannot install controls", async () => {
  const late = deferred(), f = fixture({ read: owner => owner === "owner-1" ? late.promise : state(owner) });
  const old = f.button("refresh").props.onClick;
  f.props.ownerId = "owner-2"; f.render(); await f.settle(); const count = f.calls.length;
  old(); late.resolve(state("owner-1", "held")); await f.settle(); assert.equal(f.calls.length, count);
  assert.equal(f.button("resume").props.disabled, true);
  f.props.enabled = false; f.render(); f.button("start").props.onClick(); assert.equal(f.calls.length, count);
  f.unmount();
});

test("foreign owner results and uncertain main state never grant resume or clear pause", async () => {
  const f = fixture({ read: () => state("foreign", "held") }); await f.settle();
  assert.equal(f.button("start").props.disabled, true); assert.equal(f.button("resume").props.disabled, true);
  assert(f.nodes().some(node => node.props?.role === "alert")); assert.deepEqual(f.heldChanges, []); f.unmount();
  const g = fixture({ read: () => ({ ...state(), uncertain: true, teachingPaused: true }) }); await g.settle();
  assert.equal(g.heldChanges.at(-1)[1], true); assert.equal(g.button("resume").props.disabled, true); g.unmount();
});

test("start freezes teaching before its deferred request settles and unknown outcomes require read before retry", async () => {
  const pending = deferred(), f = fixture({ start: () => pending.promise }); await f.settle();
  const start = f.button("start").props.onClick; start();
  assert.equal(f.heldChanges.at(-1)[1], true);
  pending.reject(new Error("lost")); await f.settle();
  assert.equal(f.button("start").props.disabled, true); start(); await f.settle();
  assert.equal(f.calls.filter(row => row[0] === "start").length, 1);
  f.button("refresh").props.onClick(); await f.settle();
  assert.equal(f.button("start").props.disabled, false); f.unmount();
});

test("failed read after an unknown start preserves uncertainty and blocks all captured mutation handlers", async () => {
  let failRead = false;
  const f = fixture({ read() { if (failRead) throw new Error("offline"); return state(); }, start() { throw new Error("lost"); } });
  await f.settle(); const start = f.button("start").props.onClick;
  start(); await f.settle(); failRead = true; f.button("refresh").props.onClick(); await f.settle();
  assert(f.nodes().some(node => node.props?.role === "alert" && node.props.children === "panel.onlineBarrier.uncertain"));
  assert.equal(f.button("start").props.disabled, true); start(); await f.settle();
  assert.equal(f.calls.filter(row => row[0] === "start").length, 1); f.unmount();
});
