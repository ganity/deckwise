import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/components/workpanel/CoursewarePptxCandidateReview.tsx", import.meta.url), "utf8");
function setup() {
  const state = []; let cursor = 0, tree; const calls = [];
  const props = { review: { reviewId: "review", candidateId: "candidate", kind: "page-pptx", targetPages: [{ pageId: "page", pageNumber: 1 }],
    lineageVerified: true, stale: false, effectTargets: [
      { pageId: "page", pageIndex: 0, objectId: "text", kind: "text", index: 1 },
      { pageId: "page", pageIndex: 0, objectId: "shape", kind: "shape", index: 2 }],
    effectPages: [{ objects: [{ index: 1, kind: "shape" }, { index: 2, kind: "text" }, { index: 3, kind: "line" }] }],
    effectCues: [{ pageNumber: 1, effect: "highlight", atMs: 0, endMs: 800 }, { pageNumber: 1, effect: "spotlight", atMs: 800, endMs: 1900 }] },
    disabled: false, adopt: (...args) => calls.push(args), preview() {}, reject() {}, close() {} };
  const exports = {};
  new Function("require", "exports", ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText)(id => {
    if (id === "react") return { useState(initial) { const index = cursor++; if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial;
      return [state[index], value => { state[index] = typeof value === "function" ? value(state[index]) : value; }]; } };
    if (id === "react-i18next") return { useTranslation: () => ({ t: (key, values) => key + (values ? JSON.stringify(values) : "") }) };
    if (id === "./CoursewareStyleReview") return { CoursewareStyleReview() {} };
    assert.equal(id, "react/jsx-runtime"); return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
  }, exports);
  const render = () => { cursor = 0; tree = exports.CoursewarePptxCandidateReview(props); };
  const nodes = () => { const result = []; const visit = value => { if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return; result.push(value); visit(value.props?.children); }; visit(tree); return result; };
  const selects = () => nodes().filter(node => node.type === "select");
  const boxes = () => nodes().filter(node => node.type === "input" && node.props.type === "checkbox");
  const adopt = () => nodes().find(node => node.type === "button" && node.props.children === "panel.pptEditor.pptxCandidateAdopt");
  const choose = (index, value) => { selects()[index].props.onChange({ target: { value } }); render(); };
  const check = index => { boxes()[index].props.onChange({ target: { checked: true } }); render(); };
  render(); return { props, calls, nodes, selects, boxes, adopt, choose, check, render };
}

test("candidate adoption requires all explicit distinct objects and separate timing confirmation", () => {
  const f = setup();
  assert(f.selects().every(select => select.props.value === "")); assert(f.adopt().props.disabled);
  assert(!f.nodes().some(node => node.type === "option" && node.props.value === "3"));
  f.choose(0, "2"); f.choose(1, "2"); f.check(1); assert(f.adopt().props.disabled);
  f.choose(1, "1"); assert(f.boxes().every(box => !box.props.checked));
  f.check(1); assert(f.adopt().props.disabled); f.check(0); assert.equal(f.adopt().props.disabled, false);
  f.adopt().props.onClick();
  assert.deepEqual(f.calls, [[[ { pageIndex: 0, objectId: "text", targetIndex: 2 }, { pageIndex: 0, objectId: "shape", targetIndex: 1 } ]]]);
  f.choose(0, "1"); assert(f.boxes().every(box => !box.props.checked)); assert(f.adopt().props.disabled);
});

test("candidate effect review exposes retained timings and blocks readonly stale or missing objects", () => {
  const f = setup();
  const content = JSON.stringify(f.nodes());
  assert(content.includes('\\"end\\":800')); assert(content.includes('\\"start\\":800'));
  f.choose(0, "2"); f.choose(1, "1"); f.check(0); f.check(1);
  f.props.disabled = true; f.render(); assert(f.adopt().props.disabled); assert(f.selects().every(select => select.props.disabled));
  f.props.disabled = false; f.props.review.stale = true; f.render(); assert(f.adopt().props.disabled);
  f.props.review.stale = false; f.props.review.effectPages[0].objects = []; f.render(); assert(f.adopt().props.disabled);
});

test("candidates without affected cues retain the existing adoption confirmation", () => {
  const f = setup();
  delete f.props.review.effectTargets; delete f.props.review.effectPages; delete f.props.review.effectCues;
  f.render(); assert.equal(f.selects().length, 0); assert.equal(f.boxes().length, 1);
  f.check(0); assert.equal(f.adopt().props.disabled, false);
  f.adopt().props.onClick(); assert.deepEqual(f.calls, [[undefined]]);
});
