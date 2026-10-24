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
  const projectPath = ".deckwise-ppt/projects/lesson";
  const project = { report: { stage: "final", summary: { errors: 0 } }, inputTime: 10, reportTime: 20, exported: false };
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
    async fsList(path) {
      const names = path === projectPath ? ["design_spec.md", "spec_lock.md"] :
        path === `${projectPath}/svg_output` ? ["P01.svg"] :
        path === `${projectPath}/notes` ? ["total.md"] :
        path === `${projectPath}/validation` ? ["svg_quality_report.json"] :
        path === `${projectPath}/exports` && project.exported ? ["lesson.pptx"] : [];
      return { entries: names.map(name => ({ name, kind: "file", mtimeMs: name === "svg_quality_report.json" ? project.reportTime :
        name === "lesson.pptx" ? 30 : project.inputTime })) };
    },
    async fsRead(path) {
      if (path === `${projectPath}/validation/svg_quality_report.json`) return { kind: "text", content: JSON.stringify(project.report) };
      throw new Error("File not found");
    },
    async pptPreviewOpen(path) { calls.push(["preview", path]); },
    onAuthChanged: () => () => {},
    async coursewareSceneImageList() { return structuredClone(rows); },
    async coursewareSceneImageQuote() { calls.push(["quote"]); return { quoteId: "priced", model: "image-model", maxPoints: 3, expiresAt: "2099-01-01T00:00:00Z" }; },
    async coursewareSceneImageSubmitConfirmed(...args) { calls.push(["paid", ...args]); return { ...master, phase: "submitted" }; },
    ...overrides,
  };
  const useAppStore = select => select(store); useAppStore.getState = () => store;
  useAppStore.setState = value => Object.assign(store, value);
  if (component === "CoursewareChatPresentation") store.messages = [{ role: "assistant", content: `Preview ${projectPath}/svg_output/P01.svg` }];
  const projectModule = {};
  const toolModule = {};
  new Function("require", "exports", ts.transpileModule(await readFile(new URL("../src/lib/tool-presentation.ts", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText)(() => ({}), toolModule);
  const projectSource = await readFile(new URL("../src/lib/ppt-master-project.ts", import.meta.url), "utf8");
  new Function("require", "exports", ts.transpileModule(projectSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText)(id => { assert.equal(id, "./api"); return { api }; }, projectModule);
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
    if (id === "../../lib/ppt-master-project") return projectModule;
    if (id === "../../lib/tool-presentation") return toolModule;
    if (id === "../workpanel/CoursewareNarrationReview") return { CoursewareNarrationReview: "narration-review" };
    if (id === "../../lib/work-panel-tabs") return { pptEditorWorkPanelTab: path => ({ path }), svgEditorWorkPanelTab: path => ({ svgPath: path }) };
    if (id === "../../stores/app-store" || id === "../stores/app-store") return { useAppStore };
    if (id === "./ui") return { Button: "button", TooltipButton: "button", portalOverlay: value => value };
    if (id === "./icons") return { IconClose: "icon" };
    if (id === "./CoursewareChatImages" || id === "./CoursewareChatPresentation" || id === "./CoursewareChatNarration") return {};
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
  return { calls, store, nodes, button, click, flush, render, props, image: master, empty: () => { taskType = null; },
    import: () => { taskType = "import"; }, plain: () => { taskType = "plain"; }, picker: value => { picker = value; }, fail: () => { fail = true; },
    rows: value => { rows = value; }, plan: currentPlan, project, projectPath };
}

const narrationReceipt = (patch = {}) => ({ role: "tool", toolName: "ppt_propose_page_narration", toolStatus: "success",
  toolResult: { details: { kind: "page-narration", candidateId: "candidate-1", reviewState: "needs-review",
    applied: false, saved: false, baseline: { sessionId: "office-mount-1" } } }, ...patch });
const narrationButton = f => f.nodes().find(node => node.type === "button" && Array.isArray(node.props.children));
const narrationReview = f => f.nodes().find(node => node.type === "narration-review");
const showNarration = async (f, rows = [narrationReceipt()]) => { f.store.messages = rows; f.render(); await f.flush(); };
const narrationView = { reviewId: "review-1", candidateId: "candidate-1", status: "needs-review", stale: false,
  teaching: { viewId: "teaching-1" }, actions: [] };

test("main Chat narration entrances read native-session receipts from its own transcript, not assistant prose", async t => {
  const f = await fixture(t, "CoursewareChatNarration", { sessionId: "chat", disabled: false });
  const receipt = narrationReceipt();
  await showNarration(f, [receipt, receipt,
    narrationReceipt({ role: "assistant" }), narrationReceipt({ role: "user" }),
    narrationReceipt({ toolStatus: "error" }), narrationReceipt({ isError: true }),
    narrationReceipt({ parentToolCallId: "delegate" }), narrationReceipt({ toolName: "Write" }),
    narrationReceipt({ toolResult: { details: { ...receipt.toolResult.details, baseline: { sessionId: "" } } } }),
    narrationReceipt({ toolResult: { details: { ...receipt.toolResult.details, candidateId: "../../outside" } } }),
    narrationReceipt({ toolResult: { details: { ...receipt.toolResult.details, applied: true } } }),
    narrationReceipt({ toolResult: "broken JSON" })]);
  assert.equal(f.nodes().filter(node => node.type === "button").length, 1);
  assert.equal(f.calls.length, 0, "Reading receipts never opens a review or adopts");
  await showNarration(f, [narrationReceipt({ toolResult: { content: [{ type: "text", text: JSON.stringify(receipt.toolResult.details) }] } })]);
  assert(narrationButton(f), "Persisted text envelopes use the existing tool-result decoder");
});

test("main Chat reviews and explicitly adopts through existing APIs without exposing a candidate-ID field", async t => {
  const calls = [];
  const f = await fixture(t, "CoursewareChatNarration", { sessionId: "chat", disabled: false }, {
    async pptEditorNarrationReview(...args) { calls.push(["review", ...args]); return narrationView; },
    async pptEditorTeachingDraftGet(...args) { calls.push(["draft", ...args]); return { draft: null }; },
    async pptEditorNarrationDecide(...args) { calls.push(["decide", ...args]); return { project: { teachingRevision: "new-revision" } }; },
  });
  await showNarration(f);
  narrationButton(f).props.onClick(); narrationButton(f).props.onClick(); await f.flush();
  assert.deepEqual(calls, [["review", "chat", "candidate-1"], ["draft", "teaching-1"]]);
  assert(!f.nodes().some(node => node.type === "input"));
  narrationReview(f).props.decide("adopt"); await f.flush();
  assert.deepEqual(calls.slice(-2), [["draft", "teaching-1"], ["decide", "review-1", "adopt"]]);
  assert(!narrationReview(f));
  assert.deepEqual(f.store.coursewareTeachingRefresh, { sessionId: "chat", teachingRevision: "new-revision" });
  assert(f.nodes().some(node => node.props?.role === "status" && node.props.children.endsWith("_adopted")));
});

test("manual narration drafts block review and a draft written after review blocks adoption", async t => {
  let draft = {}, decisions = 0;
  const f = await fixture(t, "CoursewareChatNarration", { sessionId: "chat", disabled: false }, {
    async pptEditorNarrationReview() { return narrationView; },
    async pptEditorTeachingDraftGet() { return { draft }; },
    async pptEditorNarrationDecide() { decisions++; },
  });
  await showNarration(f); narrationButton(f).props.onClick(); await f.flush();
  assert(!narrationReview(f));
  assert(f.nodes().some(node => node.props?.role === "alert" && node.props.children.includes("reviewDraftFirst")));
  draft = null; narrationButton(f).props.onClick(); await f.flush();
  assert(narrationReview(f)); draft = {};
  narrationReview(f).props.decide("adopt"); await f.flush();
  assert.equal(decisions, 0); assert(!narrationReview(f));
});

test("an uncertain narration decision requires rereading persisted status, never automatic replay", async t => {
  let decisions = 0, status = "needs-review";
  const f = await fixture(t, "CoursewareChatNarration", { sessionId: "chat", disabled: false }, {
    async pptEditorNarrationReview() { return { ...narrationView, status }; },
    async pptEditorTeachingDraftGet() { return { draft: null }; },
    async pptEditorNarrationDecide() { decisions++; status = "adopted"; throw new Error("Response lost"); },
  });
  await showNarration(f); narrationButton(f).props.onClick(); await f.flush();
  narrationReview(f).props.decide("adopt"); await f.flush();
  assert(!narrationReview(f)); assert.equal(decisions, 1);
  assert(f.nodes().some(node => node.props?.role === "alert" && node.props.children.includes("Response lost")));
  narrationButton(f).props.onClick(); await f.flush();
  assert.equal(narrationReview(f).props.review.status, "adopted"); assert.equal(decisions, 1);
});

test("narration actions fence stale clicks, running turns and late reads after navigation", async t => {
  let complete, reads = 0;
  const f = await fixture(t, "CoursewareChatNarration", { sessionId: "chat", disabled: false }, {
    pptEditorNarrationReview() { reads++; return new Promise(resolve => { complete = resolve; }); },
    async pptEditorTeachingDraftGet() { assert.fail("Do not read drafts after switching tasks"); },
  });
  await showNarration(f); const button = narrationButton(f);
  f.store.activeSessionId = "other"; button.props.onClick(); await f.flush(); assert.equal(reads, 0);
  f.store.activeSessionId = "chat"; f.store.runningSessions.chat = true; button.props.onClick(); await f.flush(); assert.equal(reads, 0);
  f.store.runningSessions.chat = false; button.props.onClick(); await f.flush(); assert.equal(reads, 1);
  f.store.activeSessionId = "other"; complete(narrationView); await f.flush(); assert(!narrationReview(f));
});

test("ordinary Chat preview, repair and export use the current project without the workbench", async t => {
  const props = { sessionId: "chat", disabled: false, refreshKey: 0 };
  const f = await fixture(t, "CoursewareChatPresentation", props);
  const status = () => f.nodes().find(node => node.props?.role === "status")?.props.children;
  assert.equal(status(), "coursewareWorkflow.previewReady");
  assert(!f.nodes().some(node => node.props?.children === "coursewareWorkflow.briefHint"));
  await f.click("previewPages");
  assert.deepEqual(f.calls.slice(-2), [["preview", f.projectPath], ["editor", { svgPath: f.projectPath }]]);
  f.project.report = { stage: "final", summary: { errors: 1 }, categories: { blocking: { issues: [{ file: "P01.svg", message: "Text overflow" }] } } };
  props.refreshKey++; f.render(); await f.flush();
  assert.equal(f.button("buildPpt").props.disabled, true);
  assert.equal(status(), "coursewareWorkflow.needsRepair");
  await f.click("repairPages");
  const repair = f.calls.at(-1);
  assert.equal(repair[0], "prompt"); assert.equal(repair[3], "chat");
  assert.match(repair[1], /P01\.svg: Text overflow/);
  assert.match(repair[1], /project_manager\.py validate/);
  assert.match(repair[1], /--canonical-authoring --stage final --json/);
  f.project.report = { stage: "final", summary: { errors: 0 } };
  props.refreshKey++; f.render(); await f.flush();
  assert.equal(f.button("repairPages"), undefined);
  assert.equal(status(), "coursewareWorkflow.previewReady");
  await f.click("buildPpt");
  assert.deepEqual(f.calls.at(-1), ["prompt", "coursewareWorkflow.exportPrompt", undefined, "chat"]);
  f.project.exported = true; props.refreshKey++; f.render(); await f.flush();
  assert.equal(status(), "coursewareWorkflow.editable");
  await f.click("openEditor");
  assert.deepEqual(f.calls.at(-1), ["editor", { path: `${f.projectPath}/exports/lesson.pptx` }]);
  f.project.inputTime = 40; props.refreshKey++; f.render(); await f.flush();
  assert.equal(f.button("openEditor"), undefined);
  assert.equal(f.button("buildPpt").props.disabled, true);
  assert(f.button("repairPages"));
  assert.equal(status(), "coursewareWorkflow.needsRepair");
  f.project.reportTime = 50; props.refreshKey++; f.render(); await f.flush();
  assert.equal(status(), "coursewareWorkflow.pagesChanged");
  f.store.runningSessions.chat = true; f.render();
  assert.equal(status(), "coursewareWorkflow.working");
});

test("ordinary Chat requirements appear only before a project is referenced", async t => {
  const props = { sessionId: "chat", disabled: false, refreshKey: 0 };
  const f = await fixture(t, "CoursewareChatPresentation", props);
  f.store.messages = []; f.render(); await f.flush();
  assert(f.nodes().some(node => node.props?.role === "status" && node.props.children === "coursewareWorkflow.requirements"));
  assert(f.nodes().some(node => node.props?.children === "coursewareWorkflow.briefHint"));
  assert.equal(f.button("buildPpt"), undefined);
  f.store.messages = [{ role: "assistant", content: `Planning ${f.projectPath}/design_spec.md` }];
  f.render();
  assert(f.nodes().some(node => node.props?.role === "status" && node.props.children === "coursewareWorkflow.checkingPages"));
  await f.flush();
  assert(f.nodes().some(node => node.props?.role === "status" && node.props.children === "coursewareWorkflow.previewReady"));
});

test("the ordinary Chat parent delegates status and requirements to its project inspector", async t => {
  const f = await fixture(t, "CoursewareChatWorkflow", { sessionId: "chat" });
  f.plain(); await f.click("refresh");
  assert(!f.nodes().some(node => node.type === "header"));
  assert(!f.nodes().some(node => node.props?.children === "coursewareWorkflow.briefHint"));
});

test("a referenced project without saved pages stays pending rather than asking for the topic again", async t => {
  const f = await fixture(t, "CoursewareChatPresentation", { sessionId: "chat", disabled: false, refreshKey: 0 }, {
    fsList: async () => ({ entries: [] }),
  });
  assert(f.nodes().some(node => node.props?.role === "status" && node.props.children === "coursewareWorkflow.pagesPending"));
  assert(!f.nodes().some(node => node.props?.children === "coursewareWorkflow.briefHint"));
  assert.equal(f.button("buildPpt"), undefined);
});

test("ordinary Chat actions reject stale-session clicks and failed sends remain retryable", async t => {
  const f = await fixture(t, "CoursewareChatPresentation", { sessionId: "chat", disabled: false, refreshKey: 0 });
  const stale = f.button("buildPpt");
  f.store.activeSessionId = "other"; stale.props.onClick(); await f.flush();
  assert.equal(f.calls.length, 0);
  f.store.activeSessionId = "chat";
  f.store.sendPrompt = async () => false;
  await f.click("buildPpt");
  assert(f.nodes().some(node => node.props?.role === "alert" && node.props.children.includes("coursewareWorkflow.sendFailed")));
  f.store.sendPrompt = async (...args) => { f.calls.push(["prompt", ...args]); return true; };
  await f.click("buildPpt");
  assert.equal(f.calls.length, 1);
});

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

test("Chat image rows show task status and refusals without offering another paid submission", async t => {
  const props = { sessionId: "chat", plan: { ...plan, approvedSha256: plan.sha256 }, disabled: false, refreshKey: 0, onContinue: async () => {} };
  const f = await fixture(t, "CoursewareChatImages", props);
  f.rows([{ ...f.image, phase: "submission-unknown" }]); props.refreshKey++; f.render(); await f.flush();
  assert(f.nodes().some(node => node.props?.role === "status" && node.props.children?.[0] === "panel.sceneImages.submission-unknown"));
  assert.equal(f.button("quote"), undefined); assert.equal(f.button("inspect").props.disabled, false);
  f.rows([{ ...f.image, phase: "submitted", task: { state: "failed", feeState: "refunded", reservedPoints: 3, actualPoints: 0, errorCode: "IMAGE_PROVIDER_FAILED" } }]);
  props.refreshKey++; f.render(); await f.flush();
  assert(f.nodes().some(node => node.props?.role === "alert" && node.props.children === "IMAGE_PROVIDER_FAILED"));
  assert(f.nodes().some(node => node.props?.role === "status" && node.props.children?.[1]?.includes("panel.sceneImages.task")));
  f.rows([{ ...f.image, phase: "rejected" }]); props.refreshKey++; f.render(); await f.flush();
  assert.equal(f.button("inspect").props.disabled, true); assert.equal(f.button("quote"), undefined);
  assert.equal(f.calls.some(call => call[0] === "paid"), false);
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
    educationContext: { schoolStage: "kindergarten", subject: "english", fullEnglishTeaching: true } } }]]);
  assert.equal(closed, 1);
  assert.equal(document.body.style.overflow, "hidden");
});

test("new-task dialog carries the exact brief to Chat and preserves values when choices change", async t => {
  const f = await fixture(t, "CoursewareTaskDialog", { projectPath: "/workspace", onClose() {} });
  const brief = "  An illustrated lesson about circles.\nKeep the introduction short.  ";
  f.nodes().find(node => node.type === "textarea").props.onChange({ target: { value: brief } }); f.render();
  const change = (type, label, value) => {
    const node = f.nodes().find(node => node.type === type && node.props.children?.[0]?.props?.children === label);
    assert(node, label);
    node.props.children[1].props.onChange({ target: { value } }); f.render();
  };
  change("label", "coursewareTask.grade", "Grade 3");
  change("label", "coursewareTask.schoolStage", "primary");
  change("label", "coursewareTask.subject", "other");
  change("label", "coursewareTask.customSubjectName", "Art");
  change("label", "coursewareTask.subject", "math");
  change("label", "coursewareTask.subject", "other");
  f.nodes().find(node => node.type === "input" && node.props.value === "import").props.onChange(); f.render();
  f.nodes().find(node => node.type === "form").props.onSubmit({ preventDefault() {} }); await f.flush();
  const setup = f.calls[0][1].courseware;
  assert.equal(setup.initialPrompt, brief);
  assert.equal(setup.taskType, "import");
  assert.equal(setup.educationContext.grade, "Grade 3");
  assert.equal(setup.educationContext.customSubjectName, "Art");
  assert.equal(f.calls.some(call => call[0] === "prompt" || call[0] === "paid"), false);
});

test("repeated create clicks share one operation, and failed creation retains the brief for retry", async t => {
  let reject;
  const f = await fixture(t, "CoursewareTaskDialog", { projectPath: "/workspace", onClose() {} });
  f.store.newSession = () => { f.calls.push(["create"]); return new Promise((_, fail) => { reject = fail; }); };
  f.nodes().find(node => node.type === "textarea").props.onChange({ target: { value: "Circles" } }); f.render();
  const submit = f.nodes().find(node => node.type === "form").props.onSubmit;
  submit({ preventDefault() {} }); submit({ preventDefault() {} }); await f.flush();
  assert.equal(f.calls.length, 1);
  reject(new Error("Workspace unavailable")); await f.flush();
  assert.equal(f.nodes().find(node => node.type === "textarea").props.value, "Circles");
  assert(f.nodes().some(node => node.props.role === "alert" && node.props.children === "Workspace unavailable"));
  f.store.newSession = async options => { f.calls.push(["create", options]); };
  f.nodes().find(node => node.type === "form").props.onSubmit({ preventDefault() {} }); await f.flush();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls.at(-1)[1].courseware.initialPrompt, "Circles");
});
