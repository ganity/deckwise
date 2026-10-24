import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/components/workpanel/CoursewareImageAssets.tsx", import.meta.url), "utf8");
const flush = () => new Promise(resolve => setImmediate(resolve));
const archived = { intentId: "canvas-1", current: false, draft: { title: "Frozen rabbit", prompt: "A cheerful rabbit", revision: 1 },
  model: "image-model", asset: { width: 512, height: 256 }, phase: "submitted", task: null };
const review = { reviewId: "review-1", projectId: "project", asset: { assetId: "approved-asset", width: 512, height: 256,
  byteLength: 1000 }, preview: "data:image/png;base64,cHJldmlldw==" };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function setup() {
  const hooks = [], pending = [], calls = [], activity = [];
  let cursor = 0, tree;
  const props = { sessionId: "session-a", enabled: true, onActiveChange: value => activity.push(value) };
  const api = {
    onAuthChanged(listener) { api.authChanged = listener; return () => {}; },
    async pptEditorImageClear() { calls.push(["clear"]); },
    async coursewareCanvasImageList(...args) { calls.push(["list", ...args]); return [structuredClone(archived), { ...archived, intentId: "not-archived", asset: null }]; },
    async pptEditorImagePrepare(...args) { calls.push(["team", ...args]); return structuredClone(review); },
    async pptEditorCanvasImagePrepare(...args) { calls.push(["canvas", ...args]); return { ...structuredClone(review), target: { page: 2, operation: args[2] } }; },
    async pptEditorImageApprove(...args) { calls.push(["approve", ...args]); return { assetId: review.asset.assetId }; },
  };
  const exports = {};
  new Function("require", "exports", ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText)(id => {
    if (id === "../../lib/api") return { api };
    if (id === "react-i18next") return { useTranslation: () => ({ t: (key, values) => key + (values ? JSON.stringify(values) : "") }) };
    if (id === "react") return {
      useState(initial) { const index = cursor++; if (!(index in hooks)) hooks[index] = initial;
        return [hooks[index], value => { hooks[index] = typeof value === "function" ? value(hooks[index]) : value; }]; },
      useRef(initial) { const index = cursor++; return hooks[index] ??= { current: initial }; },
      useEffect(effect, dependencies) { const index = cursor++, previous = hooks[index];
        if (!previous || dependencies.some((value, i) => value !== previous.dependencies[i])) {
          pending.push(() => { previous?.cleanup?.(); hooks[index] = { dependencies, cleanup: effect() }; });
        }
      },
    };
    assert.equal(id, "react/jsx-runtime");
    return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
  }, exports);
  const render = () => { cursor = 0; tree = exports.CoursewareImageAssets(props); for (const effect of pending.splice(0)) effect(); };
  const nodes = () => { const values = []; const visit = value => { if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return; values.push(value); visit(value.props?.children); }; visit(tree); return values; };
  const button = key => nodes().find(value => value.type === "button" && value.props.children === `panel.pptEditor.${key}`);
  const choose = (index, value) => { nodes().filter(value => value.type === "select")[index].props.onChange({ target: { value } }); render(); };
  const click = async key => { const value = button(key); assert(value, key); assert.equal(value.props.disabled, false, key);
    value.props.onClick(); await flush(); render(); };
  const prepare = async () => { assert.equal(button("imagePreview").props.disabled, false);
    nodes().find(value => value.type === "form").props.onSubmit({ preventDefault() {} }); await flush(); render(); };
  const confirm = () => { nodes().find(value => value.type === "input" && value.props.type === "checkbox").props.onChange({ target: { checked: true } }); render(); };
  const canvas = async () => { choose(0, "canvas"); await click("imageCanvasRefresh"); choose(1, "canvas-1"); };
  render(); render();
  return { props, api, calls, activity, render, nodes, button, choose, click, prepare, confirm, canvas };
}

test("team remains the default and retains explicit preview/approval flow", async () => {
  const f = setup();
  assert.equal(f.nodes().find(value => value.type === "select").props.value, "team");
  assert.equal(f.calls.some(call => call[0] === "list"), false);
  const inputs = f.nodes().filter(value => value.type === "input");
  inputs[0].props.onChange({ target: { value: " team-project " } }); f.render();
  f.nodes().filter(value => value.type === "input")[1].props.onChange({ target: { value: " team-asset " } }); f.render();
  await f.prepare();
  assert.deepEqual(f.calls.find(call => call[0] === "team"), ["team", "session-a", "team-project", "team-asset"]);
  assert.equal(f.button("imageApprove").props.disabled, true);
  f.confirm(); await f.click("imageApprove");
  assert.deepEqual(f.calls.find(call => call[0] === "approve"), ["approve", "review-1"]);
  assert(f.nodes().some(value => value.props?.role === "status" && value.props.children.includes("imageApproved")));
  assert.equal(f.calls.some(call => call[0] === "canvas"), false);
});

test("canvas reviews only archived candidates, frozen metadata and explicit page/operation before main Chat use", async () => {
  const f = setup(); await f.canvas();
  const options = f.nodes().filter(value => value.type === "option");
  assert(options.some(value => value.props.value === "canvas-1"));
  assert.equal(options.some(value => value.props.value === "not-archived"), false);
  assert(f.nodes().some(value => value.type === "pre" && value.props.children === "A cheerful rabbit"));
  assert(f.nodes().some(value => value.type === "strong" && value.props.children === "Frozen rabbit"));
  f.choose(2, "insert"); await f.prepare();
  assert.deepEqual(f.calls.find(call => call[0] === "canvas"), ["canvas", "session-a", "canvas-1", "insert"]);
  assert(f.nodes().some(value => typeof value.props?.children === "string" && value.props.children.includes('"page":2') && value.props.children.includes("imageCanvasInsert")));
  assert.equal(f.button("imageApprove").props.disabled, true);
  f.confirm(); await f.click("imageApprove");
  assert(f.nodes().some(value => value.props?.role === "status" && value.props.children.includes("imageCanvasApproved") && value.props.children.includes("approved-asset")));
  assert.deepEqual(f.calls.filter(call => !["clear", "list"].includes(call[0])).map(call => call[0]), ["canvas", "approve"]);
});

test("source/candidate/operation changes revoke preview and explicit consent", async () => {
  for (const change of [f => f.choose(0, "team"), f => f.choose(1, ""), f => f.choose(2, "insert")]) {
    const f = setup(); await f.canvas(); await f.prepare(); f.confirm();
    const clears = f.calls.filter(call => call[0] === "clear").length;
    change(f);
    assert.equal(f.nodes().some(value => value.type === "img"), false);
    assert.equal(f.button("imageApprove"), undefined);
    assert(f.calls.filter(call => call[0] === "clear").length > clears);
  }
});

test("account and Chat changes remove private candidate metadata and ignore late responses", async () => {
  for (const change of [f => f.api.authChanged(), f => { f.props.sessionId = "session-b"; f.render(); },
    f => { f.props.enabled = false; f.render(); }]) {
    const f = setup(); await f.canvas();
    const late = deferred(); f.api.pptEditorCanvasImagePrepare = () => late.promise;
    f.nodes().find(value => value.type === "form").props.onSubmit({ preventDefault() {} });
    change(f); f.render();
    late.resolve({ ...review, target: { page: 2, operation: "replace" } }); await flush(); f.render();
    assert.equal(f.nodes().some(value => value.type === "img"), false);
    assert.equal(f.button("imageApprove"), undefined);
    assert.equal(f.activity.at(-1), false);
    if (f.props.enabled) assert.equal(f.nodes().some(value => value.type === "pre"), false);
  }
  const f = setup(); f.choose(0, "canvas");
  const late = deferred(); f.api.coursewareCanvasImageList = () => late.promise;
  f.button("imageCanvasRefresh").props.onClick(); f.api.authChanged(); f.render();
  late.resolve([archived]); await flush(); f.render(); f.choose(0, "canvas");
  assert.equal(f.nodes().some(value => value.type === "option" && value.props.value === "canvas-1"), false);
});

test("canvas preview without a matching valid target cannot enable approval", async () => {
  for (const target of [undefined, { page: 2, operation: "insert" }, { page: 0, operation: "replace" }]) {
    const f = setup(); await f.canvas();
    f.api.pptEditorCanvasImagePrepare = async () => ({ ...review, target });
    await f.prepare();
    assert.equal(f.button("imageApprove"), undefined);
    assert(f.nodes().some(value => value.props?.role === "alert" && value.props.children.includes("imageCanvasTargetRequired")));
  }
});

test("concurrent preview clicks are coalesced and failed requests remain visible", async () => {
  const f = setup(); await f.canvas(); let requests = 0;
  const late = deferred(); f.api.pptEditorCanvasImagePrepare = () => { requests++; return late.promise; };
  const submit = f.nodes().find(value => value.type === "form").props.onSubmit;
  submit({ preventDefault() {} }); submit({ preventDefault() {} }); assert.equal(requests, 1);
  late.resolve({ ...review, target: { page: 2, operation: "replace" } }); await flush(); f.render();
  f.api.pptEditorImageApprove = async () => { throw new Error("Target changed"); };
  f.confirm(); await f.click("imageApprove");
  assert(f.nodes().some(value => value.props?.role === "alert" && value.props.children.includes("Target changed")));
  assert.equal(f.nodes().some(value => value.props?.role === "status" && value.props.children.includes("imageCanvasApproved")), false);
});

test("canvas and team API requests share the existing review IPC with distinct exact payloads", async () => {
  const { IPC } = await import("../../../packages/shared/src/protocol.ts");
  const apiSource = await readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8");
  const calls = [], exports = {};
  new Function("require", "exports", "window", ts.transpileModule(apiSource, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText)(id => {
    assert.equal(id, "@pi-desktop/shared"); return { IPC };
  }, exports, { piDesktop: { async invoke(...args) { calls.push(args); return { ok: true, data: review }; } } });
  await exports.api.pptEditorCanvasImagePrepare("chat", "canvas-1", "insert");
  await exports.api.pptEditorImagePrepare("chat", "team-project", "team-image");
  assert.deepEqual(calls, [
    [IPC.invoke.pptEditorImagePrepare, { sessionId: "chat", intentId: "canvas-1", operation: "insert" }],
    [IPC.invoke.pptEditorImagePrepare, { sessionId: "chat", projectId: "team-project", assetId: "team-image" }],
  ]);
});

test("every locale supplies the canvas adoption controls and disclosures", async () => {
  const { readdir } = await import("node:fs/promises");
  const directory = new URL("../../../packages/i18n/src/locales/", import.meta.url);
  const keys = [...source.matchAll(/"panel\.pptEditor\.(image(?:Source|Canvas)[A-Za-z]*)"/g)].map(match => match[1]);
  for (const locale of await readdir(directory, { withFileTypes: true })) {
    if (!locale.isDirectory()) continue;
    const text = await readFile(new URL(`${locale.name}/index.ts`, directory), "utf8");
    for (const key of new Set(keys)) assert.match(text, new RegExp(`\\b${key}:`), `${locale.name}: ${key}`);
  }
});
