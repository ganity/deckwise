import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/components/workpanel/CoursewareTeachingHistory.tsx", import.meta.url), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const entry = (revision = "history-r1") => ({ teachingRevision: revision, sourceRevision: "deleted-source", pageId: "deleted-page", pageNumber: 4,
  actions: [{ id: "fresh-speech", type: "speech", text: "Recovered <b>plain</b> narration.\nSecond line.", source: "user", pauseAfterMs: 1200 },
    { id: "fresh-wait", type: "interaction_checkpoint", checkpointId: "fresh-checkpoint", checkpointKind: "teacher_continue" }],
  omittedAudioCount: 2, omittedCueCount: 3 });

function fixture() {
  const hooks = [], effects = [], calls = [], restored = [];
  let cursor = 0, tree, stateWrites = 0;
  const props = { view: { viewId: "view-1", pageId: "current-page", pageNumber: 1,
    project: { projectId: "project-1", teachingRevision: "teaching-1", source: { revision: "source-1", sha256: "source-hash" } } },
    disabled: false, onRestore: actions => restored.push(actions) };
  const api = { async pptEditorTeachingHistory(viewId) { calls.push(viewId); return { entries: [entry(), entry("history-r2")], skippedEntryCount: 1 }; } };
  const exports = {};
  new Function("require", "exports", output)(id => {
    if (id === "../../lib/api") return { api };
    if (id === "react-i18next") return { useTranslation: () => ({ t: (key, values) => key + (values ? " " + JSON.stringify(values) : "") }) };
    if (id === "react") return {
      useState(initial) { const index = cursor++; if (!(index in hooks)) hooks[index] = initial;
        return [hooks[index], value => { stateWrites++; hooks[index] = typeof value === "function" ? value(hooks[index]) : value; }]; },
      useRef(initial) { const index = cursor++; return hooks[index] ??= { current: initial }; },
      useEffect(effect, dependencies) { const index = cursor++, previous = hooks[index];
        if (!previous || dependencies.some((value, i) => value !== previous.dependencies[i]))
          effects.push(() => { previous?.cleanup?.(); hooks[index] = { dependencies, cleanup: effect() }; });
      },
    };
    assert.equal(id, "react/jsx-runtime");
    return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
  }, exports);
  const render = () => { cursor = 0; tree = exports.CoursewareTeachingHistory(props); while (effects.length) effects.shift()(); };
  const nodes = () => { const out = []; const visit = node => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return; out.push(node); visit(node.props?.children);
  }; visit(tree); return out; };
  const button = key => nodes().find(node => node.type === "button" && node.props.children === "panel.teachingHistory." + key);
  const select = () => nodes().find(node => node.type === "select");
  const check = () => nodes().find(node => node.type === "input");
  const settle = async () => { await flush(); render(); render(); };
  const load = async () => { button("load").props.onClick(); await settle(); };
  const choose = (index = "0") => { select().props.onChange({ target: { value: index } }); render(); render(); };
  const confirm = () => { check().props.onChange({ target: { checked: true } }); render(); };
  const unmount = () => { for (const hook of hooks) hook?.cleanup?.(); };
  render(); render();
  return { props, api, calls, restored, render, nodes, button, select, check, settle, load, choose, confirm, unmount,
    writes: () => stateWrites };
}

test("history is read on demand; explicit version and consent restore only an independent editable draft", async () => {
  const f = fixture(); assert.deepEqual(f.calls, []); assert.equal(f.select(), undefined);
  await f.load(); assert.deepEqual(f.calls, ["view-1"]); assert.equal(f.check(), undefined);
  const options = f.nodes().filter(node => node.type === "option");
  assert.equal(options.length, 3); assert.match(options[1].props.children, /"page":4/);
  assert.match(options[1].props.children, /history-r1/); assert.match(options[1].props.children, /deleted-source/);
  f.choose();
  assert(f.nodes().some(node => node.type === "p" && node.props.children === entry().actions[0].text));
  assert(f.nodes().some(node => typeof node.props?.children === "string" && node.props.children.includes('panel.teachingHistory.pause {"ms":1200}')));
  assert(f.nodes().some(node => node.props?.children === "panel.teachingHistory.wait"));
  assert(f.nodes().some(node => node.props?.role === "note" && node.props.children.includes('"audio":2,"cues":3')));
  assert(f.nodes().some(node => node.props?.children === 'panel.teachingHistory.skipped {"count":1}'));
  assert.equal(f.button("restore").props.disabled, true);
  f.button("restore").props.onClick(); assert.deepEqual(f.restored, []);
  f.confirm(); const restore = f.button("restore").props.onClick;
  restore(); restore(); f.render();
  assert.deepEqual(f.restored, [entry().actions]); assert.equal(f.button("restore").props.disabled, true);
  f.restored[0][0].text = "Parent edited the draft";
  f.confirm(); f.button("restore").props.onClick();
  assert.equal(f.restored[1][0].text, entry().actions[0].text);
  assert.deepEqual(f.calls, ["view-1"]);
});

test("selecting another history version revokes consent and stale selection handlers cannot restore it", async () => {
  const f = fixture(); await f.load(); f.choose(); f.confirm();
  const previous = f.button("restore").props.onClick, previousCheck = f.check().props.onChange;
  f.choose("1"); previousCheck({ target: { checked: true } }); previous(); f.render();
  assert.deepEqual(f.restored, []); assert.equal(f.button("restore").props.disabled, true);
  f.confirm(); f.button("restore").props.onClick(); assert.equal(f.restored.length, 1);
});

test("view/project/source/teaching/page changes discard pending responses and confirmed old callbacks", async () => {
  const changes = [
    view => ({ ...view, viewId: "view-2" }),
    view => ({ ...view, project: { ...view.project, projectId: "project-2" } }),
    view => ({ ...view, project: { ...view.project, source: { ...view.project.source, revision: "source-2" } } }),
    view => ({ ...view, project: { ...view.project, teachingRevision: "teaching-2" } }),
    view => ({ ...view, pageId: "page-2" }),
    view => ({ ...view, pageNumber: 2 }),
  ];
  for (const change of changes) {
    const f = fixture(); await f.load(); f.choose(); f.confirm(); const oldRestore = f.button("restore").props.onClick;
    const pending = deferred(); f.api.pptEditorTeachingHistory = () => pending.promise;
    f.button("load").props.onClick(); f.props.view = change(f.props.view); f.render(); f.render();
    oldRestore(); pending.resolve({ entries: [entry()], skippedEntryCount: 0 }); await f.settle();
    assert.equal(f.select(), undefined); assert.deepEqual(f.restored, []);
  }
});

test("disabled state fences loads, captured callbacks and in-flight results until a new explicit read", async () => {
  const f = fixture(); await f.load(); f.choose(); f.confirm(); const restore = f.button("restore").props.onClick;
  const pending = deferred(); f.api.pptEditorTeachingHistory = () => pending.promise;
  f.button("load").props.onClick(); f.props.disabled = true; f.render(); f.render();
  assert.equal(f.button("load").props.disabled, true); f.button("load").props.onClick(); restore();
  pending.resolve({ entries: [entry()], skippedEntryCount: 0 }); await f.settle();
  assert.equal(f.select(), undefined); assert.deepEqual(f.restored, []);
  f.props.disabled = false; f.render(); f.render();
  assert.equal(f.select(), undefined); assert.equal(f.button("load").props.disabled, false);
});

test("rejected reads show a generic translated error, recover explicitly, and empty/skipped results stay visible", async () => {
  const f = fixture(); f.api.pptEditorTeachingHistory = async () => { throw new Error("private-file-path-token"); };
  await f.load();
  assert(f.nodes().some(node => node.props?.role === "alert" && node.props.children === "panel.teachingHistory.failed"));
  assert(!JSON.stringify(f.nodes()).includes("private-file-path-token"));
  f.api.pptEditorTeachingHistory = async () => ({ entries: [], skippedEntryCount: 2 });
  await f.load(); assert.equal(f.select(), undefined);
  assert(f.nodes().some(node => node.props?.children === "panel.teachingHistory.empty"));
  assert(f.nodes().some(node => node.props?.children === 'panel.teachingHistory.skipped {"count":2}'));
  assert(!f.nodes().some(node => node.props?.role === "alert")); assert.deepEqual(f.restored, []);
});

test("unmount ignores late results and old restore callbacks; duplicate reads are bounded", async () => {
  const f = fixture(); await f.load(); f.choose(); f.confirm(); const restore = f.button("restore").props.onClick;
  const pending = deferred(); let reads = 0;
  f.api.pptEditorTeachingHistory = () => { reads++; return pending.promise; };
  const load = f.button("load").props.onClick; load(); load(); assert.equal(reads, 1);
  f.unmount(); const writes = f.writes(); restore(); load();
  pending.resolve({ entries: [entry()], skippedEntryCount: 0 }); await flush();
  assert.equal(f.writes(), writes); assert.deepEqual(f.restored, []); assert.equal(reads, 1);
});
