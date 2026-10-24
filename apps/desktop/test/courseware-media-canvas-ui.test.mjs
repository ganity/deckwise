import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import * as model from "../src/lib/courseware-media-canvas.ts";

const source = await readFile(new URL("../src/components/workpanel/CoursewareMediaCanvas.tsx", import.meta.url), "utf8");
const flush = () => new Promise(resolve => setImmediate(resolve));

function setup() {
  let tree, cursor = 0;
  const hooks = [], changes = [], chat = [];
  const props = { document: model.createMediaCanvasDocument("project"), saveState: "saved", references: [{ assetId: "picture", revision: "sha256:1", label: "Picture" }],
    onChange(document) { changes.push(document); props.document = document; },
    async onEditInChat(request) { chat.push(request); } };
  const exports = {};
  new Function("require", "exports", ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText)(id => {
    if (id === "../../lib/courseware-media-canvas") return model;
    if (id.endsWith(".css")) return {};
    if (id === "lucide-react") return { ZoomIn: "zoom-in", ZoomOut: "zoom-out", X: "x" };
    if (id === "react-i18next") return { useTranslation: () => ({ t: key => key }) };
    if (id === "react") return {
      useState(initial) { const index = cursor++; if (!(index in hooks)) hooks[index] = initial;
        return [hooks[index], value => { hooks[index] = typeof value === "function" ? value(hooks[index]) : value; }]; },
      useRef(initial) { const index = cursor++; return hooks[index] ??= { current: initial }; },
    };
    assert.equal(id, "react/jsx-runtime");
    return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
  }, exports);
  const render = () => { cursor = 0; tree = exports.CoursewareMediaCanvas(props); };
  const nodes = () => { const out = []; const visit = value => { if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return; out.push(value); visit(value.props?.children); }; visit(tree); return out; };
  const button = key => nodes().find(node => node.type === "button" && node.props.children === `panel.mediaCanvas.${key}`);
  const field = key => nodes().find(node => node.type === "label" && node.props.children[0] === `panel.mediaCanvas.${key}`).props.children[1];
  render();
  return { props, changes, chat, render, nodes, button, field };
}

test("canvas properties and accepted Chat refresh use one controlled draft with pinned references", async () => {
  const f = setup(); f.button("addImage").props.onClick(); f.render();
  f.field("prompt").props.onChange({ target: { value: "Draw a rabbit" } }); f.render();
  f.field("reference").props.onChange({ target: { value: "picture" } }); f.render();
  assert.equal(f.props.document.drafts[0].prompt, "Draw a rabbit");
  assert.equal(f.props.document.drafts[0].references[0].revision, "sha256:1");
  f.field("chatInstruction").props.onChange({ target: { value: "Make it cheerful" } }); f.render();
  await f.button("editInChat").props.onClick(); await flush(); f.render();
  assert.deepEqual(f.chat[0], { projectId: "project", draftId: f.props.document.drafts[0].id, expectedRevision: 2, instruction: "Make it cheerful" });
  f.props.document = model.editMediaCanvasDraft(f.props.document, f.props.document.drafts[0].id, 2, { prompt: "A cheerful rabbit" }); f.render();
  assert.equal(f.field("prompt").props.value, "A cheerful rabbit");
  assert.equal(f.props.document.drafts[0].references.length, 1);
  assert.equal(f.field("chatInstruction").props.value, "");
});

test("pointer placement and zoom affect layout only, and removal leaves external referenced assets intact", () => {
  const f = setup(); f.button("addImage").props.onClick(); f.render();
  const card = () => f.nodes().find(node => node.props?.className === "courseware-media-canvas-draft");
  const pointer = { pointerId: 4, button: 0, clientX: 10, clientY: 20, preventDefault() {}, stopPropagation() {}, currentTarget: { setPointerCapture() {} } };
  card().props.onPointerDown(pointer); card().props.onPointerMove({ ...pointer, clientX: 110, clientY: 220 }); card().props.onPointerUp(); f.render();
  assert.deepEqual([f.props.document.drafts[0].x, f.props.document.drafts[0].y], [100, 200]);
  assert.equal(f.props.document.drafts[0].revision, 0);
  const zoom = f.nodes().find(node => node.props?.["aria-label"] === "panel.mediaCanvas.zoomIn");
  zoom.props.onClick(); f.render(); assert.equal(f.props.document.viewport.zoom, 1.2);
  f.button("removeDraft").props.onClick(); f.render(); assert.equal(f.props.document.drafts.length, 0);
  assert.deepEqual(f.props.references, [{ assetId: "picture", revision: "sha256:1", label: "Picture" }]);
  assert.deepEqual(f.chat, []);
});

test("unsaved and disabled states prevent Chat submission and cross-project selection leakage", async () => {
  const f = setup(); f.button("addImage").props.onClick(); f.render();
  f.field("chatInstruction").props.onChange({ target: { value: "Change prompt" } }); f.render();
  f.props.saveState = "saving"; f.render();
  assert.equal(f.button("editInChat").props.disabled, true);
  await f.button("editInChat").props.onClick(); assert.equal(f.chat.length, 0);
  f.props.disabled = true; f.props.saveState = "saved"; f.render();
  assert.equal(f.field("prompt").props.disabled, true);
  const previous = f.props.document;
  f.field("prompt").props.onChange({ target: { value: "Forbidden" } }); assert.equal(f.props.document, previous);
  f.props.document = { ...model.createMediaCanvasDocument("other"), drafts: previous.drafts }; f.render();
  assert.equal(f.nodes().some(node => node.type === "textarea"), false);
});

test("Chat errors retain the instruction and report failure without changing drafts", async () => {
  const f = setup(); f.button("addImage").props.onClick(); f.render();
  f.field("chatInstruction").props.onChange({ target: { value: "Try this" } }); f.render();
  f.props.onEditInChat = async () => { throw new Error("Conversation changed"); }; f.render();
  const before = JSON.stringify(f.props.document);
  await f.button("editInChat").props.onClick(); await flush(); f.render();
  assert.equal(f.field("chatInstruction").props.value, "Try this");
  assert(f.nodes().some(node => node.props?.role === "alert" && String(node.props.children).includes("Conversation changed")));
  assert.equal(JSON.stringify(f.props.document), before);
});
