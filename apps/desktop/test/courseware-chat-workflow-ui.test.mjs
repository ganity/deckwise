import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import * as shared from "@pi-desktop/shared";

globalThis.window = { setInterval, clearInterval, addEventListener() {}, removeEventListener() {} };
globalThis.document = { activeElement: null, body: { style: { overflow: "" } }, querySelector: () => null };
globalThis.HTMLElement = class {};
globalThis.requestAnimationFrame = fn => fn();
const plan = { title: "Shapes", sha256: "a".repeat(64), approvedSha256: null, pages: [
  { pageId: "scene-001", title: "Circle", visibleText: ["Circle"], visualIntent: "A circle", narration: "Good!" },
] };

async function fixture(t, component, props, overrides = {}) {
  const state = [], effects = [], pending = [], calls = [];
  const store = { activeSessionId: "chat", runningSessions: {}, messages: [], sessions: [{ id: "chat", projectPath: "/workspace" }],
    newSession: async (...args) => { calls.push(["create", ...args]); },
    sendPrompt: async (...args) => { calls.push(["prompt", ...args]); return true; },
    openWorkPanelTab: tab => calls.push(["editor", tab]) };
  const currentPlan = structuredClone(plan);
  const master = { intentId: "master", planSha256: plan.sha256, pageId: "scene-001", target: { kind: "visualMaster" },
    current: true, selected: false, phase: "prepared", prompt: "Circle in a garden", model: "image-model", task: null, asset: null };
  let taskType = "scene", rows = [master], picker = { token: "picked" }, fail = false;
  let cursor = 0, tree;
  const slot = initial => { const index = cursor++; if (!(index in state)) state[index] = initial; return index; };
  const react = {
    useState(initial) { const index = slot(initial); return [state[index], value => { state[index] = typeof value === "function" ? value(state[index]) : value; }]; },
    useRef(initial) { return state[slot({ current: initial })]; },
    useEffect(effect, deps) { const index = cursor++;
      if (!effects[index] || deps.some((value, i) => value !== effects[index].deps[i])) {
        effects[index]?.cleanup?.(); effects[index] = { deps }; pending.push(() => { effects[index].cleanup = effect(); });
      }
    },
  };
  const api = {
    async coursewareWorkflowGet() { if (fail) throw new Error("Invalid scene draft"); return { task: taskType ? { taskType, imported: false, generated: false } : null,
      plan: taskType === "scene" ? structuredClone(currentPlan) : null }; },
    async coursewareScenePlanApprove(...args) { calls.push(["approve", ...args]); currentPlan.approvedSha256 = currentPlan.sha256; return { plan: structuredClone(currentPlan) }; },
    async pickFiles() { calls.push(["pick"]); return picker; },
    async coursewareImportPptx(...args) { calls.push(["import", ...args]); return { path: "/workspace/import.pptx" }; },
    async coursewareTaskGet() { return { task: { importPath: "/workspace/import.pptx" } }; },
    onAuthChanged: () => () => {},
    async coursewareSceneImageList() { return structuredClone(rows); },
    async coursewareSceneImageQuote() { calls.push(["quote"]); return { quoteId: "priced", model: "image-model", maxPoints: 3, expiresAt: "2099-01-01T00:00:00Z" }; },
    async coursewareSceneImageSubmitConfirmed(...args) { calls.push(["paid", ...args]); return { ...master, phase: "submitted" }; },
    ...overrides,
  };
  const useAppStore = select => select(store); useAppStore.getState = () => store;
  const isDialog = component === "CoursewareTaskDialog";
  const source = await readFile(new URL(`../src/components/${isDialog ? component : "courseware/" + component}.tsx`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source + (component === "CoursewareChatWorkflow" ? "\nexports.Workflow = Workflow;" : isDialog ? "\nexports.TaskForm = TaskForm;" : ""), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  new Function("require", "exports", compiled)(id => {
    if (id === "react") return react;
    if (id === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
    if (id === "react-i18next") return { useTranslation: () => ({ t: key => key }) };
    if (id === "@pi-desktop/shared") return shared;
    if (id === "../../lib/api") return { api };
    if (id === "../../lib/work-panel-tabs") return { pptEditorWorkPanelTab: path => ({ path }) };
    if (id === "../../stores/app-store" || id === "../stores/app-store") return { useAppStore };
    if (id === "./ui") return { Button: "button", TooltipButton: "button", portalOverlay: value => value };
    if (id === "./icons") return { IconClose: "icon" };
    if (id === "./CoursewareChatImages" || id === "./CoursewareChatPresentation") return {};
    assert.fail(id);
  }, exports);
  const render = () => { cursor = 0; tree = exports[component === "CoursewareChatWorkflow" ? "Workflow" : isDialog ? "TaskForm" : component](props);
    for (const effect of pending.splice(0)) effect(); return tree; };
  const flush = async () => { await new Promise(resolve => setImmediate(resolve)); render(); await new Promise(resolve => setImmediate(resolve)); render(); };
  const nodes = () => {
    const all = []; const visit = value => { if (Array.isArray(value)) return value.forEach(visit); if (!value || typeof value !== "object") return;
      all.push(value); visit(value.props?.children); }; visit(tree); return all;
  };
  const button = name => nodes().find(node => node.type === "button" && node.props.children === "coursewareWorkflow." + name);
  const click = async name => { const node = button(name); assert(node, name); assert.equal(!!node.props.disabled, false, name); node.props.onClick(); await flush(); };
  t.after(() => { for (const effect of effects) effect?.cleanup?.(); });
  render(); await flush();
  return { calls, store, nodes, button, click, flush, render, props, empty: () => { taskType = null; },
    import: () => { taskType = "import"; }, picker: value => { picker = value; }, fail: () => { fail = true; },
    rows: value => { rows = value; }, plan: currentPlan };
}

test("scene review in the main Chat pins the reviewed plan then continues the same conversation", async t => {
  const f = await fixture(t, "CoursewareChatWorkflow", { sessionId: "chat" });
  assert(f.nodes().some(node => node.type === "strong" && node.props.children === "Circle"));
  await f.click("approveContinue");
  assert.deepEqual(f.calls[0], ["approve", "chat", plan.sha256]);
  assert.deepEqual(f.calls[1], ["prompt", "coursewareWorkflow.continuePrompt", undefined, "chat"]);
  assert.equal(f.button("approveContinue"), undefined);
});

test("ordinary conversations do not gain a courseware card and an invalid draft remains actionable", async t => {
  const f = await fixture(t, "CoursewareChatWorkflow", { sessionId: "chat" });
  f.empty(); await f.click("refresh");
  assert.equal(f.nodes().length, 0);
  const failed = await fixture(t, "CoursewareChatWorkflow", { sessionId: "chat" }, {
    coursewareWorkflowGet: async () => { throw new Error("Invalid scene draft"); },
  });
  assert(failed.nodes().some(node => node.props?.role === "alert")); assert(failed.button("refresh"));
});

test("PPT import can be cancelled and retried in the same Chat without the workbench", async t => {
  const f = await fixture(t, "CoursewareChatWorkflow", { sessionId: "chat" });
  f.import(); await f.click("refresh");
  f.picker({}); await f.click("selectPpt");
  assert.equal(f.calls.filter(call => call[0] === "import").length, 0);
  f.picker({ token: "picked" }); await f.click("selectPpt");
  assert.deepEqual(f.calls.find(call => call[0] === "import"), ["import", "chat", "picked"]);
  assert.deepEqual(f.calls.at(-1), ["editor", { path: "/workspace/import.pptx" }]);
});

test("main Chat asset quotation requires an unchecked explicit cost confirmation and rejects stale task clicks", async t => {
  const f = await fixture(t, "CoursewareChatImages", { sessionId: "chat", plan: { ...plan, approvedSha256: plan.sha256 }, disabled: false, onContinue: async () => {} });
  await f.click("quote");
  assert.equal(f.button("submitImage").props.disabled, true);
  assert.equal(f.calls.some(call => call[0] === "paid"), false);
  f.nodes().find(node => node.type === "input" && node.props.type === "checkbox").props.onChange({ target: { checked: true } }); f.render();
  const stale = f.button("submitImage");
  f.store.activeSessionId = "peer"; stale.props.onClick(); await f.flush();
  assert.equal(f.calls.some(call => call[0] === "paid"), false);
  f.store.activeSessionId = "chat"; await f.click("submitImage");
  assert.deepEqual(f.calls.at(-1), ["paid", "chat", "master", "priced"]);
});

test("refresh reconciles assets prepared in the retained secondary panel", async t => {
  const props = { sessionId: "chat", plan: { ...plan, approvedSha256: plan.sha256 }, disabled: false, refreshKey: 0, onContinue: async () => {} };
  const f = await fixture(t, "CoursewareChatImages", props);
  assert(f.button("quote"));
  f.rows([]); props.refreshKey++; f.render(); await f.flush();
  assert.equal(f.button("quote"), undefined);
});

test("new-task dialog saves the chosen route and teaching settings before returning to Chat", async t => {
  let closed = 0;
  const f = await fixture(t, "CoursewareTaskDialog", { projectPath: "/workspace", onClose: () => { closed++; } });
  f.nodes().find(node => node.type === "input" && node.props.value === "scene").props.onChange(); f.render();
  f.nodes().filter(node => node.type === "select")[0].props.onChange({ target: { value: "kindergarten" } }); f.render();
  f.nodes().filter(node => node.type === "select")[1].props.onChange({ target: { value: "english" } }); f.render();
  f.nodes().find(node => node.type === "input" && node.props.type === "checkbox").props.onChange({ target: { checked: true } }); f.render();
  f.nodes().find(node => node.type === "form").props.onSubmit({ preventDefault() {} }); await f.flush();
  assert.deepEqual(f.calls, [["create", { projectPath: "/workspace", courseware: { taskType: "scene",
    educationContext: { schoolStage: "kindergarten", subject: "english", fullEnglishTeaching: true, grade: undefined, customSubjectName: undefined } } }]]);
  assert.equal(closed, 1);
  assert.equal(document.body.style.overflow, "hidden");
});
