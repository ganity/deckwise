import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { isCoursewareAttentionCue } from "@pi-desktop/shared";

const source = await readFile(new URL("../src/components/workpanel/CoursewareSourceReview.tsx", import.meta.url), "utf8");
function setup() {
  const state = []; let cursor = 0, tree; const calls = [];
  const props = { review: { reviewId: "review", pageCount: 2, project: { pages: [
    { pageId: "old-page", locked: true, actions: [{ type: "speech", text: "Preserved audio narration", pauseAfterMs: 500 }] },
    { pageId: "peer", locked: false, actions: [] }] },
    effectTargets: [{ pageId: "old-page", objectId: "text-uuid", kind: "text", index: 1 }, { pageId: "old-page", objectId: "shape-uuid", kind: "shape", index: 2 }],
    targetPages: [{ objects: [{ index: 1, kind: "shape" }, { index: 2, kind: "text" }, { index: 3, kind: "line" }] }, { objects: [] }] },
    disabled: false, adopt: (...args) => calls.push(args), cancel() {} };
  const exports = {};
  new Function("require", "exports", ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText)(id => {
    if (id === "react") return { useState(initial) { const index = cursor++; if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial;
      return [state[index], value => { state[index] = typeof value === "function" ? value(state[index]) : value; }]; } };
    if (id === "react-i18next") return { useTranslation: () => ({ t: (key, values) => key + (values ? JSON.stringify(values) : "") }) };
    if (id === "@pi-desktop/shared") return { isCoursewareAttentionCue };
    assert.equal(id, "react/jsx-runtime"); return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
  }, exports);
  const render = () => { cursor = 0; tree = exports.CoursewareSourceReview(props); };
  const nodes = () => { const result = []; const visit = value => { if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return; result.push(value); visit(value.props?.children); }; visit(tree); return result; };
  const selects = () => nodes().filter(node => node.type === "select");
  const checkboxes = () => nodes().filter(node => node.type === "input" && node.props.type === "checkbox");
  const adopt = () => nodes().find(node => node.type === "button" && node.props.children === "panel.pptEditor.sourceReviewAdopt");
  const choose = (index, value) => { selects()[index].props.onChange({ target: { value } }); render(); };
  const check = index => { checkboxes()[index].props.onChange({ target: { checked: true } }); render(); };
  render(); return { props, calls, nodes, selects, checkboxes, adopt, choose, check, render };
}

test("source review requires each explicit target and separate review, never preselects or merges", () => {
  const f = setup(); assert(f.selects().every(select => select.props.value === ""));
  assert(f.selects().slice(2).every(select => select.props.disabled)); assert(f.adopt().props.disabled);
  f.choose(0, "0"); f.choose(1, "1");
  assert(f.selects().slice(2).every(select => select.props.value === ""));
  assert(!f.nodes().some(node => node.type === "option" && node.props.value === "3"), "Unsupported source kind is not offered");
  f.choose(2, "2"); f.choose(3, "2"); assert(f.adopt().props.disabled); assert(f.checkboxes().every(box => box.props.disabled));
  f.choose(3, "1"); f.check(1); assert(f.adopt().props.disabled); f.check(0); assert.equal(f.adopt().props.disabled, false);
  f.adopt().props.onClick(); assert.deepEqual(f.calls, [[[0, 1], [
    { pageIndex: 0, objectId: "text-uuid", targetIndex: 2 }, { pageIndex: 0, objectId: "shape-uuid", targetIndex: 1 }]]]);
  f.choose(0, "new"); assert(f.adopt().props.disabled); assert(f.selects().slice(2).every(select => select.props.value === ""));
  assert(f.checkboxes().every(box => !box.props.checked));
});

test("read-only review and missing current objects remain blocked", () => {
  const f = setup(); f.choose(0, "0"); f.choose(1, "1"); f.choose(2, "2"); f.choose(3, "1"); f.check(0); f.check(1);
  f.props.disabled = true; f.render(); assert(f.adopt().props.disabled); assert(f.selects().every(select => select.props.disabled));
  f.props.disabled = false; f.props.review.targetPages[0].objects = []; f.render(); assert(f.adopt().props.disabled);
});

test("source review shows each retained speech cue interval before target and timing confirmation", () => {
  const f = setup();
  f.props.review.project.pages[0].actions[0].visualCues = [
    { id: "cue-highlight", atMs: 0, endMs: 800, effect: { type: "highlight", elementIds: ["text-uuid"] } },
    { id: "cue-spotlight", atMs: 800, endMs: 1900, effect: { type: "spotlight", elementId: "shape-uuid" } },
  ];
  f.props.review.project.pages[0].actions.push({ id: "second", type: "speech", text: "Next narration", visualCues: [
    { id: "cue-next", atMs: 50, endMs: 700, effect: { type: "highlight", elementIds: ["text-uuid"] } },
  ] });
  const previous = structuredClone(f.props.review.project);
  f.render();
  const cues = f.nodes().filter(node => node.type === "p" && typeof node.props.children === "string" &&
    node.props.children.startsWith("panel.pptEditor.effectsCue"));
  assert.deepEqual(cues.map(node => JSON.parse(node.props.children.slice("panel.pptEditor.effectsCue".length))), [
    { effect: "panel.pptEditor.effectsHighlight", start: 0, end: 800 },
    { effect: "panel.pptEditor.effectsSpotlight", start: 800, end: 1900 },
    { effect: "panel.pptEditor.effectsHighlight", start: 50, end: 700 },
  ]);
  assert(f.adopt().props.disabled);
  assert(f.checkboxes().every(box => !box.props.checked));
  assert.deepEqual(f.props.review.project, previous);
});
