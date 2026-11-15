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

test("chat changes retain failed, omitted and native-unsaved results without a resolution gate", () => {
  const f = setup();
  f.change.plan.items.push({ label: "Native response", status: "native-unsaved" });
  f.change.candidates = [{ candidateId: "failed-call", status: "rejected" }]; f.render();
  const rendered = JSON.stringify(f.nodes());
  for (const text of ["Missing narration", "chatPlanNotRecorded", "Native response", "chatPlanNativeResponse", "failed-call", "chatCandidateRejected"]) assert(rendered.includes(text));
  assert(!f.nodes().some(node => ["button", "textarea", "input"].includes(node.type)));
  assert.deepEqual(f.calls, []);
  f.change.resolution = { note: "Previously reviewed" }; f.render();
  assert(JSON.stringify(f.nodes()).includes("chatResolutionClosed"));
  assert.equal(f.change.plan.items[0].status, "not-recorded");
});

test("empty change history has no panel", () => {
  const f = setup(); f.props.view.chatChanges = []; f.render(); assert.deepEqual(f.nodes(), []);
});
