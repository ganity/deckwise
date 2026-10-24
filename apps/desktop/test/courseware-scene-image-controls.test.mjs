import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/components/workpanel/CoursewareSceneImages.tsx", import.meta.url), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;

// Deterministic hook driver exercises the component's public controls without a Desktop instance.
function fixture(options = {}) {
  const supported = Object.hasOwn(options, "supported") ? options.supported : true;
  const selected = options.selected ?? true;
  const state = [], effects = [], pending = [], calls = [];
  let cursor = 0;
  const slot = initial => { const index = cursor++; if (!(index in state)) state[index] = initial; return index; };
  const react = {
    useState(initial) { const index = slot(initial); return [state[index], value => { state[index] = typeof value === "function" ? value(state[index]) : value; }]; },
    useRef(initial) { return state[slot({ current: initial })]; },
    useEffect(effect, deps) { const index = cursor++; if (!effects[index] || deps.some((value, i) => value !== effects[index][i])) { effects[index] = deps; pending.push(effect); } },
  };
  const ref = { intentId: "master", planSha256: "a".repeat(64), pageId: "scene-001", target: { kind: "visualMaster" },
    current: true, selected, model: "image-model", phase: "submitted", task: null, prompt: "Reference",
    asset: { sha256: "b".repeat(64), mimeType: "image/png", byteLength: 70, width: 1, height: 1 } };
  const intent = { ...ref, intentId: "background", target: { kind: "cleanPlate" }, asset: null, selected: false,
    phase: "prepared", referenceImage: { intentId: ref.intentId, sha256: ref.asset.sha256, mimeType: "image/png", byteLength: 70 } };
  const api = {
    onAuthChanged: () => () => {},
    async coursewareSceneImageModels() { return [{ model: "image-model", ...(supported === undefined ? {} : { supportsReferenceImage: supported }) }]; },
    async coursewareSceneImageList() { return [ref]; },
    async coursewareSceneImagePrepare(...args) { calls.push(["prepare", ...args]); return intent; },
    async coursewareSceneImageQuote() { calls.push(["quote"]); return { quoteId: "quote", model: "image-model", maxPoints: 3, expiresAt: "2099-01-01T00:00:00Z" }; },
    async coursewareSceneImagePreview() { calls.push(["preview"]); return { image: ref, dataUrl: "data:image/png;base64,local-private-preview" }; },
    async coursewareSceneImageSubmitConfirmed(...args) { calls.push(["submit", ...args]); return { ...intent, phase: "submitted" }; },
  };
  const exports = {};
  new Function("require", "exports", output)(id => {
    if (id === "react") return react;
    if (id === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
    if (id === "react-i18next") return { useTranslation: () => ({ t: (key, data) => key + (data ? " " + JSON.stringify(data) : "") }) };
    assert.equal(id, "../../lib/api"); return { api };
  }, exports);
  const props = { sessionId: "chat", plan: { sha256: ref.planSha256, pages: [{ pageId: ref.pageId, title: "Circle" }] },
    enabled: true, onActiveChange() {}, onGenerated() {} };
  let tree;
  const render = () => { cursor = 0; tree = exports.CoursewareSceneImages(props); for (const effect of pending.splice(0)) effect(); return tree; };
  const nodes = () => {
    const all = [], visit = value => { if (Array.isArray(value)) return value.forEach(visit); if (!value || typeof value !== "object") return;
      all.push(value); visit(value.props?.children); };
    visit(tree); return all;
  };
  const button = key => nodes().find(node => node.type === "button" && node.props.children === "panel.sceneImages." + key);
  const click = async key => { const node = button(key); assert(node, key); assert.equal(!!node.props.disabled, false, key);
    node.props.onClick(); await new Promise(resolve => setImmediate(resolve)); render(); };
  const choose = (index, value) => { nodes().filter(node => node.type === "select")[index].props.onChange({ target: { value } }); render(); };
  render(); render();
  return { calls, nodes, button, click, choose, render };
}

test("reference controls disclose the exact private image and require explicit fee and egress consent", async () => {
  const f = fixture();
  await f.click("models"); await f.click("refresh");
  f.choose(0, "scene-001"); f.choose(1, "image-model"); f.choose(2, "cleanPlate");
  await f.click("quote");
  assert.deepEqual(f.calls.map(call => call[0]), ["prepare", "quote", "preview"]);
  assert.equal(f.calls[0].at(-1), "master");
  assert(f.nodes().some(node => node.type === "img" && node.props.src.includes("local-private-preview")));
  assert(f.nodes().some(node => typeof node.props?.children === "string" && node.props.children.includes("referenceDisclosure") &&
    node.props.children.includes("master") && node.props.children.includes("b".repeat(64))));
  assert.equal(f.button("submit").props.disabled, true);
  const checkbox = f.nodes().find(node => node.type === "input" && node.props.type === "checkbox");
  checkbox.props.onChange({ target: { checked: true } }); f.render();
  await f.click("submit");
  assert.equal(f.calls.filter(call => call[0] === "submit").length, 1);
  assert.deepEqual(f.calls.at(-1), ["submit", "chat", "background", "quote"]);
});

test("missing selection and unsupported or absent model capability visibly disable reference quotation", async () => {
  for (const options of [{ supported: false }, { supported: undefined }, { selected: false }]) {
    const f = fixture(options);
    await f.click("models"); await f.click("refresh");
    f.choose(0, "scene-001"); f.choose(1, "image-model"); f.choose(2, "cleanPlate");
    assert.equal(f.button("quote").props.disabled, true);
    assert(f.nodes().some(node => typeof node.props?.children === "string" && node.props.children.includes("referenceRequired")));
    assert.equal(f.calls.length, 0);
    f.choose(2, "visualMaster");
    assert.equal(f.button("quote").props.disabled, false, "text-only visual masters keep existing model behavior");
  }
});
