import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/components/workpanel/CoursewareChatChanges.tsx", import.meta.url), "utf8");
function setup() {
  const state = [], calls = []; let cursor = 0, tree;
  const change = { changeGroupId: "group", receiptSha256: "a".repeat(64), acknowledged: 1, pending: 0, uncertain: 0,
    plan: { pageId: "page", pageNumber: 1, items: [{ label: "Missing narration", status: "not-recorded" }] } };
  const props = { view: { pageId: "page", chatChanges: [change], project: { pages: [{ pageId: "page", reviewState: "review" }] } },
    disabled: false, resolve: value => calls.push(value) };
  const exports = {};
  new Function("require", "exports", ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText)(id => {
    if (id === "react") return { useState(initial) { const n = cursor++; if (!(n in state)) state[n] = initial;
      return [state[n], value => { state[n] = value; }]; } };
    if (id === "react-i18next") return { useTranslation: () => ({ t: key => key }) };
    assert.equal(id, "react/jsx-runtime"); return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
  }, exports);
  const render = () => { cursor = 0; tree = exports.CoursewareChatChanges(props); };
  const nodes = () => { const result = []; const visit = node => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return; result.push(node); visit(node.props?.children);
  }; visit(tree); return result; };
  const button = key => nodes().find(node => node.type === "button" && node.props.children === `panel.pptEditor.${key}`);
  const input = type => nodes().find(node => node.type === type);
  render(); return { props, change, calls, nodes, render, button, input };
}

test("closing requires explicit note and confirmation; preserves missing-step display", () => {
  const f = setup(); f.button("chatResolutionReview").props.onClick(); f.render();
  assert(f.button("chatResolutionConfirm").props.disabled);
  f.input("textarea").props.onChange({ target: { value: "Retain narration; cancel remaining request." } }); f.render();
  assert(f.button("chatResolutionConfirm").props.disabled);
  f.input("input").props.onChange({ target: { checked: true } }); f.render();
  assert.equal(f.button("chatResolutionConfirm").props.disabled, false);
  f.button("chatResolutionConfirm").props.onClick();
  assert.deepEqual(f.calls, [{ changeGroupId: "group", receiptSha256: "a".repeat(64), note: "Retain narration; cancel remaining request." }]);
  f.input("textarea").props.onChange({ target: { value: "Changed disposition" } }); f.render();
  assert(f.button("chatResolutionConfirm").props.disabled);
  f.change.resolution = { note: "Reviewed" }; f.render();
  assert.equal(f.button("chatResolutionConfirm"), undefined);
  assert(JSON.stringify(f.nodes()).includes("Missing narration"));
  assert.equal(f.change.plan.items[0].status, "not-recorded");
});

test("disabled and foreign-page reviews cannot close; removed targets need all remaining pages confirmed", () => {
  const f = setup(); f.props.disabled = true; f.render(); assert(f.button("chatResolutionReview").props.disabled);
  f.props.disabled = false; f.props.view.pageId = "other"; f.render(); assert(f.button("chatResolutionReview").props.disabled);
  f.props.view.project.pages = [{ pageId: "other", reviewState: "review" }]; f.render(); assert(f.button("chatResolutionReview").props.disabled);
  f.props.view.project.pages[0].reviewState = "ready"; f.render(); assert.equal(f.button("chatResolutionReview").props.disabled, false);
  delete f.change.receiptSha256; f.render(); assert.equal(f.button("chatResolutionReview"), undefined);
});
