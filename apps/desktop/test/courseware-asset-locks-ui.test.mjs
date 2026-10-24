import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/components/workpanel/CoursewareAssetLocks.tsx", import.meta.url), "utf8");
const flush = () => new Promise(resolve => setImmediate(resolve));
const result = { revision: "locks-r1", sourceSha256: "source", mappingRevision: "mapping", pageId: "page", objects: [
  { objectId: "image", index: 2, assetSha256: "a".repeat(64), locked: false, eligible: true },
  { objectId: "unsupported", index: 3, locked: false, eligible: false },
], staleLocks: [{ objectId: "old-image", assetSha256: "b".repeat(64) }] };

function setup() {
  const hooks = [], effects = [], activity = [], calls = [];
  let cursor = 0, tree;
  const props = { view: { viewId: "view", pageId: "page", project: { source: { sha256: "source" }, teachingRevision: "teaching" } },
    disabled: false, onActivity: value => activity.push(value) };
  const api = {
    async pptEditorAssetLocksRead(...args) { calls.push(["read", ...args]); return structuredClone(result); },
    async pptEditorAssetLockSet(...args) {
      calls.push(["set", ...args]);
      return { ...structuredClone(result), revision: "locks-r2", objects: result.objects.map(object =>
        ({ ...object, locked: object.objectId === args[3] ? args[4] : object.locked })),
        staleLocks: args[3] === "old-image" ? [] : structuredClone(result.staleLocks) };
    },
  };
  const exports = {};
  new Function("require", "exports", ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText)(id => {
    if (id === "../../lib/api") return { api };
    if (id === "react-i18next") return { useTranslation: () => ({ t: key => key }) };
    if (id === "react") return {
      useState(initial) { const index = cursor++; if (!(index in hooks)) hooks[index] = initial;
        return [hooks[index], value => { hooks[index] = typeof value === "function" ? value(hooks[index]) : value; }]; },
      useRef(initial) { const index = cursor++; return hooks[index] ??= { current: initial }; },
      useEffect(effect, dependencies) { const index = cursor++, previous = hooks[index];
        if (!previous || dependencies.some((value, i) => value !== previous.dependencies[i])) {
          effects.push(() => { previous?.cleanup?.(); hooks[index] = { dependencies, cleanup: effect() }; });
        }
      },
    };
    assert.equal(id, "react/jsx-runtime");
    return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
  }, exports);
  const render = () => { cursor = 0; tree = exports.CoursewareAssetLocks(props); while (effects.length) effects.shift()(); };
  const nodes = () => { const out = []; const visit = value => { if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return; out.push(value); visit(value.props?.children); }; visit(tree); return out; };
  const button = key => nodes().find(node => node.type === "button" && node.props.children === "panel.pptEditor." + key);
  const checks = () => nodes().filter(node => node.type === "input");
  render(); render();
  return { props, api, calls, activity, render, nodes, button, checks };
}

test("image locks require saved-page read, explicit selection and the current lock revision", async () => {
  const f = setup();
  assert.equal(f.checks().length, 0); assert.deepEqual(f.calls, []);
  f.button("assetLocksRead").props.onClick(); await flush(); f.render();
  assert.deepEqual(f.calls, [["read", "view", "teaching"]]);
  assert.deepEqual(f.checks().map(node => node.props.checked), [false, false]);
  assert.equal(f.checks()[1].props.disabled, true);
  f.checks()[0].props.onChange({ target: { checked: true } }); await flush(); f.render();
  assert.deepEqual(f.calls[1], ["set", "view", "teaching", "locks-r1", "image", true]);
  assert.equal(f.checks()[0].props.checked, true);
  f.button("assetLocksRemoveStale").props.onClick(); await flush(); f.render();
  assert.deepEqual(f.calls[2], ["set", "view", "teaching", "locks-r2", "old-image", false]);
  assert.equal(f.button("assetLocksRemoveStale"), undefined);
  assert.deepEqual(f.activity, [true, false, true, false, true, false]);
});

test("disabled and pending image locks cannot start overlapping writes", async () => {
  const f = setup(); f.props.disabled = true; f.render();
  assert(f.button("assetLocksRead").props.disabled);
  f.button("assetLocksRead").props.onClick(); await flush(); assert.equal(f.calls.length, 0);
  f.props.disabled = false; f.render();
  let finish; f.api.pptEditorAssetLocksRead = () => new Promise(resolve => { finish = resolve; });
  const click = f.button("assetLocksRead").props.onClick;
  click(); click(); assert.equal(f.activity.filter(Boolean).length, 1);
  finish(structuredClone(result)); await flush(); f.render(); assert.equal(f.checks().length, 2);
});

test("changed-page and rejected lock responses never expose old images or leave editing busy", async () => {
  const f = setup(); let finish;
  f.api.pptEditorAssetLocksRead = () => new Promise(resolve => { finish = resolve; });
  f.button("assetLocksRead").props.onClick();
  f.props.view = { ...f.props.view, viewId: "next-view", pageId: "next-page" }; f.render(); f.render();
  finish(structuredClone(result)); await flush(); f.render();
  assert.equal(f.checks().length, 0); assert.equal(f.activity.at(-1), false);
  f.api.pptEditorAssetLocksRead = async () => structuredClone(result);
  f.button("assetLocksRead").props.onClick(); await flush(); f.render();
  assert.equal(f.checks().length, 0);
  assert(f.nodes().some(node => node.props?.role === "alert"));
  assert.equal(f.activity.at(-1), false);
});
