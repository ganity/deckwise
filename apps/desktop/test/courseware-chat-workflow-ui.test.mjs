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

async function fixture(t, component, props, overrides = {}, translate = key => key) {
  const state = [], effects = [], pending = [], calls = [];
  const store = { workPanelTabs: [], activeSessionId: "chat", runningSessions: {}, messages: [], sessions: [{ id: "chat", projectPath: "/workspace" }],
    newSession: async (...args) => { calls.push(["create", ...args]); },
    sendPrompt: async (...args) => { calls.push(["prompt", ...args]); return true; },
    replaceWorkPanelTab: (id, tab) => calls.push(["workspace", id, tab]),
    openWorkPanelTab: tab => calls.push(["editor", tab]) };
  const currentPlan = structuredClone(plan);
  const projectPath = ".deckwise-ppt/projects/lesson";
  const project = { report: { stage: "final", summary: { errors: 0 } }, inputTime: 10, reportTime: 20, exported: false };
  const master = { intentId: "master", planSha256: plan.sha256, pageId: "scene-001", target: { kind: "visualMaster" },
    current: true, selected: false, phase: "prepared", prompt: "Circle in a garden", model: "image-model", task: null, asset: null };
  let attached = false;
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
    async coursewareWorkflowGet() { if (fail) throw new Error("Invalid scene draft"); return { task: taskType ? { taskType, imported: attached && taskType === "import", generated: attached && taskType !== "import", ...(attached ? { sourcePath: "/workspace/import.pptx" } : {}) } : null,
      plan: taskType === "scene" ? structuredClone(currentPlan) : null }; },
    async coursewareScenePlanApprove(...args) { calls.push(["approve", ...args]); currentPlan.approvedSha256 = currentPlan.sha256; return { plan: structuredClone(currentPlan) }; },
    async pickFiles() { calls.push(["pick"]); return picker; },
    async coursewareImportPptx(...args) { attached = true; calls.push(["import", ...args]); return { path: "/workspace/import.pptx" }; },
    async coursewareTaskGet() { return { task: taskType ? { taskType, importPath: "/workspace/import.pptx" } : null }; },
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
    async coursewareSceneImagePreview(_sessionId, intentId) { return { image: structuredClone(rows.find(row => row.intentId === intentId)), dataUrl: "data:image/png;base64,aGVsbG8=" }; },
    async coursewareSceneImageList() { return structuredClone(rows); },
    async coursewareSceneImageGenerate(...args) { calls.push(["generate", ...args]); rows = rows.map(row => ({ ...row, phase: "submitted" })); return rows[0]; },
    async coursewareSceneImageStatus(_sessionId, intentId) { return structuredClone(rows.find(row => row.intentId === intentId)); },
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
  const candidateModule = {};
  new Function("require", "exports", ts.transpileModule(await readFile(new URL("../src/lib/courseware-chat-candidates.ts", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText)(id => { assert.equal(id, "./tool-presentation"); return toolModule; }, candidateModule);
  const projectSource = await readFile(new URL("../src/lib/ppt-master-project.ts", import.meta.url), "utf8");
  new Function("require", "exports", ts.transpileModule(projectSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText)(id => { assert.equal(id, "./api"); return { api }; }, projectModule);
  const isDialog = component === "CoursewareTaskDialog";
  const source = await readFile(new URL(`../src/components/${isDialog ? component : (component === "CoursewareSourceVisuals" ? "workpanel/" : "courseware/") + component}.tsx`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source + (component === "CoursewareChatWorkflow" ? "\nexports.Workflow = Workflow;" : isDialog ? "\nexports.TaskForm = TaskForm;" : component === "CoursewareWorkspaceEntry" ? "\nexports.Entry = Entry;" : ""), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  new Function("require", "exports", compiled)(id => {
    if (id === "react") return react;
    if (id === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
    if (id === "react-i18next") return { useTranslation: () => ({ t: translate }) };
    if (id === "lucide-react") return new Proxy({}, { get: (_target, key) => `icon-${key}` });
    if (id === "@pi-desktop/shared") return shared;
    if (id === "@pi-desktop/courseware-runtime/player") return { MaicQuiz: "maic-quiz" };
    if (id === "@pi-desktop/courseware-runtime/player.css") return {};
    if (id === "../../lib/api") return { api };
    if (id === "../../lib/ppt-master-project") return projectModule;
    if (id === "../../lib/tool-presentation") return toolModule;
    if (id === "../../lib/courseware-chat-candidates") return candidateModule;
    if (id === "../workpanel/PptEditorTab") return { PptEditorTab: "ppt-editor" };
    if (id === "../workpanel/CoursewareClassroomEditor") return { CoursewareClassroomEditor: "classroom-editor" };
    if (id === "../workpanel/CoursewareImportDialog") return { CoursewareImportDialog: "publish-dialog" };
    if (id === "../workpanel/CoursewareSourceVisuals") return { CoursewareSourceVisuals: "source-visuals" };
    if (id === "../workpanel/CoursewarePptxCandidateReview") return { CoursewarePptxCandidateReview: "pptx-review" };
    if (id === "../../lib/work-panel-tabs") return { pptEditorWorkPanelTab: path => ({ path }), svgEditorWorkPanelTab: path => ({ svgPath: path }), toolWorkPanelTab: kind => ({ id: kind, kind }) };
    if (id === "../../stores/app-store" || id === "../stores/app-store") return { useAppStore };
    if (id === "./ui") return { Button: "button", TooltipButton: "button", portalOverlay: value => value };
    if (id === "./icons") return { IconClose: "icon" };
    if (id === "./CoursewareChatPresentation") return { CoursewareChatPresentation: "plain-presentation" };
    if (id === "./CoursewareChatImages") return { CoursewareChatImages: "scene-images" };
    if (id === "./CoursewareChatNarration" || id === "./CoursewareChatPptxCandidates") return {};
    if (id === "./CoursewareSceneThumbnail") return { CoursewareSceneThumbnail: "scene-thumbnail" };
    assert.fail(id);
  }, exports);
  const render = () => { cursor = 0; tree = exports[component === "CoursewareChatWorkflow" ? "Workflow" : isDialog ? "TaskForm" : component === "CoursewareWorkspaceEntry" ? "Entry" : component](props);
    for (const effect of pending.splice(0)) effect(); return tree; };
  const flush = async () => { await new Promise(resolve => setImmediate(resolve)); render(); await new Promise(resolve => setImmediate(resolve)); render(); };
  const nodes = () => {
    const all = []; const visit = value => { if (Array.isArray(value)) return value.forEach(visit); if (!value || typeof value !== "object") return;
      all.push(value); visit(value.props?.children);
      // Inspect the editor slots supplied by Workflow; editor rendering has its own browser tests.
      if (value.type === "ppt-editor") { visit(value.props.actions); visit(value.props.reviewPanel); }
    }; visit(tree); return all;
  };
  const button = name => nodes().find(node => node.type === "button" && node.props.children === "coursewareWorkflow." + name);
  const click = async name => { const node = button(name); assert(node, name); assert.equal(!!node.props.disabled, false, name); node.props.onClick(); await flush(); };
  const unmount = () => { for (const effect of effects) effect?.cleanup?.(); };
  t.after(unmount);
  render(); await flush();
  return { calls, store, nodes, button, click, flush, render, unmount, props, image: master, empty: () => { taskType = null; },
    attached: type => { taskType = type; attached = true; },
    import: () => { taskType = "import"; }, plain: () => { taskType = "plain"; }, picker: value => { picker = value; }, fail: () => { fail = true; },
    rows: value => { rows = value; }, plan: currentPlan, project, projectPath };
}

const narrationReceipt = (patch = {}) => ({ role: "tool", toolName: "ppt_propose_page_narration", toolStatus: "success",
  toolResult: { details: { kind: "page-narration", applied: true, saved: true, pageNumber: 1,
    teachingRevision: "T2", baseline: { sessionId: "office-mount-1", pageId: "page-1" } } }, ...patch });
const showNarration = async (f, rows = [narrationReceipt()]) => { f.store.messages = rows; f.render(); await f.flush(); };

test("generated PPT delegates current-page Quiz and checkpoint editing to the native editor toolbar", async t => {
  const f = await fixture(t, "CoursewareChatWorkflow", { sessionId: "chat" });
  f.attached("scene");
  await f.click("refresh");
  const entrance = f.nodes().find(node => node.type === "button" && node.props.children === "Quiz / 互动编辑");
  assert(!entrance, "Current-page editing belongs to the mounted PPT toolbar");
  assert(f.nodes().some(node => node.type === "ppt-editor"));
});

test("narration shows successful saves and refreshes teaching without review or adoption controls", async t => {
  const f = await fixture(t, "CoursewareChatNarration", { sessionId: "chat", disabled: false });
  const receipt = narrationReceipt();
  await showNarration(f, [receipt, receipt, narrationReceipt({ role: "assistant" }), narrationReceipt({ toolStatus: "error" }),
    narrationReceipt({ isError: true }), narrationReceipt({ parentToolCallId: "delegate" }), narrationReceipt({ toolName: "Write" })]);
  assert.equal(f.nodes().filter(n => n.type === "li").length, 1);
  assert.equal(f.nodes().filter(n => ["button", "input", "narration-review"].includes(n.type)).length, 0);
  assert(f.nodes().some(n => n.props.role === "status" && n.props.children === "panel.pptEditor.teachingSaved"));
  assert.deepEqual(f.store.coursewareTeachingRefresh, { sessionId: "chat", reread: true });
  assert.equal(f.calls.length, 0);
  await showNarration(f, [narrationReceipt({ toolResult: { content: [{ type: "text", text: JSON.stringify(receipt.toolResult.details) }] } })]);
  assert.equal(f.nodes().filter(n => n.type === "li").length, 1);
});

test("partial batch displays all saved pages while ignoring failed and malformed entries", async t => {
  const f = await fixture(t, "CoursewareChatNarration", { sessionId: "chat", disabled: false });
  const rows = [1, 2, 3].map(pageNumber => ({ pageNumber, pageId: `page-${pageNumber}`, teachingRevision: `T${pageNumber}`, saved: true }));
  await showNarration(f, [narrationReceipt({ toolName: "courseware_narration_propose", toolResult: { details: {
    saved: false, savedPages: [...rows, rows[0], { ...rows[0], pageId: "../bad" }, { ...rows[0], saved: false }], failures: [{ pageNumber: 4 }],
  } } })]);
  assert.equal(f.nodes().filter(n => n.type === "li").length, 3);
  assert.equal(f.nodes().filter(n => n.type === "button").length, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.coursewareTeachingRefresh.reread, true);
});

test("legacy candidates never expose narration adoption and other sessions cannot refresh teaching", async t => {
  const f = await fixture(t, "CoursewareChatNarration", { sessionId: "chat", disabled: false });
  await showNarration(f, [narrationReceipt({ toolResult: { details: { candidateId: "old", kind: "page-narration", reviewState: "needs-review", applied: false, saved: false } } })]);
  assert.equal(f.nodes().length, 0);
  assert.equal(f.store.coursewareTeachingRefresh, undefined);
  f.store.activeSessionId = "other";
  await showNarration(f);
  assert.equal(f.store.coursewareTeachingRefresh, undefined);
});

const pptxReceipt = (kind = "page-fade", patch = {}) => ({ role: "tool", toolStatus: "success",
  toolName: { "page-fade": "ppt_propose_page_fade", "page-pptx": "ppt_propose_page_redo", "page-style-batch": "ppt_propose_page_style_batch" }[kind],
  toolResult: { details: { kind, candidateId: kind, reviewState: "needs-review", applied: false, saved: false,
    outputSha256: "a".repeat(64), baseline: { sessionId: "native-office" } } }, ...patch });
const pptxReview = f => f.nodes().find(node => node.type === "pptx-review");
const pptxButtons = f => f.nodes().filter(node => node.type === "button");
const pptxView = { reviewId: "pptx-review-1", candidateId: "page-fade", kind: "page-fade", targetPages: [{ pageNumber: 1 }], stale: false, lineageVerified: true, outputSha256: "a".repeat(64) };
const pptxDraftApi = { async pptEditorTeachingOpen() { return { viewId: "current-page" }; }, async pptEditorTeachingDraftGet() { return { draft: null }; } };

test("main Chat shows deduplicated redo, fade and batch receipts, without trusting prose or mismatched tools", async t => {
  const f = await fixture(t, "CoursewareChatPptxCandidates", { sessionId: "chat", disabled: false });
  const receipt = pptxReceipt();
  f.store.messages = [receipt, receipt, pptxReceipt("page-pptx"), pptxReceipt("page-style-batch"),
    pptxReceipt("page-fade", { role: "assistant" }), pptxReceipt("page-fade", { toolStatus: "error" }),
    pptxReceipt("page-fade", { isError: true }), pptxReceipt("page-fade", { parentToolCallId: "delegate" }),
    pptxReceipt("page-fade", { toolName: "ppt_propose_page_redo" }),
    pptxReceipt("page-fade", { toolResult: { details: { ...receipt.toolResult.details, candidateId: "../outside" } } }),
    pptxReceipt("page-fade", { toolResult: { details: { ...receipt.toolResult.details, outputSha256: "invalid" } } })];
  f.render(); await f.flush(); assert.equal(pptxButtons(f).length, 3); assert.equal(f.calls.length, 0);
  assert(!f.nodes().some(node => node.type === "input"));
});

test("main Chat opens a saved PPTX review, previews, forwards explicit effect choices and adopts once", async t => {
  const calls = []; let complete;
  const f = await fixture(t, "CoursewareChatPptxCandidates", { sessionId: "chat", disabled: false }, {
    ...pptxDraftApi,
    async pptEditorPptxCandidateReview(...args) { calls.push(["review", ...args]); return pptxView; },
    async pptEditorPptxCandidatePreview(...args) { calls.push(["preview", ...args]); },
    pptEditorPptxCandidateAdopt(...args) { calls.push(["adopt", ...args]); return new Promise(resolve => { complete = resolve; }); },
  });
  f.store.messages = [pptxReceipt()]; f.render(); await f.flush();
  pptxButtons(f)[0].props.onClick(); pptxButtons(f)[0].props.onClick(); await f.flush();
  assert.deepEqual(calls, [["review", "chat", "page-fade"]]);
  pptxReview(f).props.preview(); await f.flush(); assert.deepEqual(calls.at(-1), ["preview", "pptx-review-1"]);
  const choices = [{ pageIndex: 0, objectId: "shape", targetIndex: 2 }];
  pptxReview(f).props.adopt(choices); pptxReview(f).props.adopt(choices); await f.flush();
  assert.deepEqual(calls.at(-1), ["adopt", "pptx-review-1", choices]);
  complete({ ok: true }); await f.flush(); assert(!pptxReview(f)); assert.equal(pptxButtons(f).length, 0);
  assert.deepEqual(f.store.coursewareTeachingRefresh, { sessionId: "chat", sourceSha256: pptxView.outputSha256 });
  assert(f.nodes().some(node => node.props?.role === "status" && node.props.children.endsWith("_adopted")));
});

test("PPTX review and adoption preserve stored narration drafts", async t => {
  let draft = {}, reads = 0, adopts = 0;
  const f = await fixture(t, "CoursewareChatPptxCandidates", { sessionId: "chat", disabled: false }, {
    ...pptxDraftApi, async pptEditorTeachingDraftGet() { return { draft }; },
    async pptEditorPptxCandidateReview() { reads++; return pptxView; },
    async pptEditorPptxCandidateAdopt() { adopts++; },
  });
  f.store.messages = [pptxReceipt()]; f.render(); await f.flush(); pptxButtons(f)[0].props.onClick(); await f.flush();
  assert.equal(reads, 0); assert(!pptxReview(f));
  draft = null; pptxButtons(f)[0].props.onClick(); await f.flush(); assert(pptxReview(f));
  draft = {}; pptxReview(f).props.adopt(); await f.flush(); assert.equal(adopts, 0); assert(!pptxReview(f));
});

test("uncertain PPTX adoption is never replayed and rejection uses the existing persisted decision", async t => {
  let reads = 0, adopts = 0, rejected = 0;
  const f = await fixture(t, "CoursewareChatPptxCandidates", { sessionId: "chat", disabled: false }, {
    ...pptxDraftApi,
    async pptEditorPptxCandidateReview() { reads++; return pptxView; },
    async pptEditorPptxCandidateAdopt() { adopts++; throw new Error("Lost adoption response"); },
    async pptEditorPptxCandidateReject(id) { assert.equal(id, pptxView.reviewId); rejected++; },
  });
  f.store.messages = [pptxReceipt()]; f.render(); await f.flush(); pptxButtons(f)[0].props.onClick(); await f.flush();
  pptxReview(f).props.adopt(); await f.flush(); assert(!pptxReview(f)); assert.equal(adopts, 1);
  assert(f.nodes().some(node => node.props?.role === "alert" && node.props.children.includes("Lost adoption response")));
  pptxButtons(f)[0].props.onClick(); await f.flush(); assert.equal(reads, 2); assert.equal(adopts, 1);
  pptxReview(f).props.reject(); await f.flush(); assert.equal(rejected, 1); assert.equal(pptxButtons(f).length, 0);
  assert.deepEqual(f.store.coursewareTeachingRefresh, { sessionId: "chat", reread: true });
});

test("closing a Chat PPTX review refreshes teaching without deciding or regenerating the candidate", async t => {
  const f = await fixture(t, "CoursewareChatPptxCandidates", { sessionId: "chat", disabled: false }, {
    ...pptxDraftApi, async pptEditorPptxCandidateReview() { return pptxView; },
  });
  f.store.messages = [pptxReceipt()]; f.render(); await f.flush();
  pptxButtons(f)[0].props.onClick(); await f.flush();
  pptxReview(f).props.close(); await f.flush();
  assert(!pptxReview(f)); assert.equal(pptxButtons(f).length, 1);
  assert.deepEqual(f.store.coursewareTeachingRefresh, { sessionId: "chat", reread: true });
  f.store.coursewareTeachingRefresh = undefined;
  pptxButtons(f)[0].props.onClick(); await f.flush();
  f.store.activeSessionId = "other"; pptxReview(f).props.close(); await f.flush();
  assert.equal(f.store.coursewareTeachingRefresh, undefined);
});

test("PPTX actions fence switched tasks, running turns, disabled state and late reads", async t => {
  let complete, reads = 0;
  const props = { sessionId: "chat", disabled: false };
  const f = await fixture(t, "CoursewareChatPptxCandidates", props, { ...pptxDraftApi,
    pptEditorPptxCandidateReview() { reads++; return new Promise(resolve => { complete = resolve; }); },
  });
  f.store.messages = [pptxReceipt()]; f.render(); await f.flush(); const button = pptxButtons(f)[0];
  f.store.activeSessionId = "other"; button.props.onClick(); await f.flush(); assert.equal(reads, 0);
  f.store.activeSessionId = "chat"; f.store.runningSessions.chat = true; button.props.onClick(); await f.flush(); assert.equal(reads, 0);
  f.store.runningSessions.chat = false; props.disabled = true; f.render(); pptxButtons(f)[0].props.onClick(); await f.flush(); assert.equal(reads, 0);
  props.disabled = false; f.render(); pptxButtons(f)[0].props.onClick(); await f.flush(); assert.equal(reads, 1);
  f.store.activeSessionId = "other"; complete(pptxView); await f.flush(); assert(!pptxReview(f));
});

for (const locale of ["en", "zh-CN", "zh-TW", "de", "es", "fr", "ko", "tr"]) {
  test(`ordinary export action requests the complete teaching handoff in ${locale}`, async t => {
    const translations = {};
    new Function("exports", ts.transpileModule(await readFile(new URL(`../../../packages/i18n/src/locales/${locale}/index.ts`, import.meta.url), "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText)(translations);
    const prompt = Object.values(translations)[0].coursewareWorkflow.exportPrompt;
    assert.match(prompt, /TTS|语音/);
    assert.match(prompt, /PPTX-only|仅导出 PPTX/);
    assert.match(prompt, /original jobs|原有任务/);
    const f = await fixture(t, "CoursewareChatPresentation", { sessionId: "chat", disabled: false, refreshKey: 0 }, {},
      key => key === "coursewareWorkflow.exportPrompt" ? prompt : key);
    await f.click("buildPpt");
    assert.deepEqual(f.calls.at(-1), ["prompt", prompt, undefined, "chat"]);
  });
}

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
  assert.equal(f.nodes().filter(node => node.type === "header").length, 1);
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
  f.calls.length = 0; // Automatic SVG preview is covered separately.
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
  assert.deepEqual(f.calls[1], ["prompt", "coursewareWorkflow.planPrompt", undefined, "chat"]);
  assert.equal(f.button("approveContinue"), undefined);
});

test("ordinary conversations do not gain a courseware card and an invalid draft remains actionable", async t => {
  const f = await fixture(t, "CoursewareChatWorkflow", { sessionId: "chat" });
  f.empty(); await f.click("refresh");
  assert(f.nodes().some(node => node.props?.children === "coursewareWorkflow.briefHint"));
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
  assert(f.nodes().some(node => node.type === "ppt-editor" && node.props.path === "/workspace/import.pptx"));
});

test("preview labels keep body image counts separate from independent assessments", async t => {
  const mixed = { ...plan, approvedSha256: plan.sha256, pages: [...plan.pages,
    { pageId: "quiz", title: "Quiz", quiz: { type: "quiz", questions: [] } },
    { pageId: "checkpoint", title: "Discuss", teaching: { question: { text: "Why?" } } },
  ] };
  const f = await fixture(t, "CoursewareChatImages", { sessionId: "chat", plan: mixed, disabled: false, onContinue: async () => {} }, {},
    (key, values) => values ? `${key}:${JSON.stringify(values)}` : key);
  const heading = f.nodes().find(node => node.props?.className === "courseware-scene-section-heading");
  assert.deepEqual(heading.props.children, ['coursewareWorkflow.pages:{"count":1}', ' · coursewareWorkflow.quizPages:{"count":1}', ' · coursewareWorkflow.interactionPages:{"count":1}']);
  assert(f.nodes().some(node => node.props?.children === 'coursewareWorkflow.pageProgress:{"count":0,"total":1,"assets":0}'));
});

test("resuming uses the existing task and fences stale clicks without direct media submission", async t => {
  let resumed = 0;
  const f = await fixture(t, "CoursewareChatImages", { sessionId: "chat", plan: { ...plan, approvedSha256: plan.sha256 }, disabled: false,
    onContinue: async action => { assert.equal(action, "resume"); resumed++; } });
  assert(!f.button("submitImage"));
  const stale = f.button("resume");
  f.store.activeSessionId = "peer"; stale.props.onClick(); await f.flush();
  assert.equal(resumed, 0);
  f.store.activeSessionId = "chat"; await f.click("resume");
  assert.equal(resumed, 1); assert.equal(f.calls.length, 0);
});

test("refresh reconciles asset intents while Chat is running without exposing generation controls", async t => {
  const props = { sessionId: "chat", plan: { ...plan, approvedSha256: plan.sha256 }, disabled: true, refreshKey: 0, onContinue: async () => {} };
  const f = await fixture(t, "CoursewareChatImages", props);
  assert(f.nodes().some(node => node.props?.["data-scene-image-intent"] === "master"));
  assert(!f.button("resume"));
  f.rows([]); props.refreshKey++; f.render(); await f.flush();
  assert(!f.nodes().some(node => node.props?.["data-scene-image-intent"]));
});

test("scene preview distinguishes pending and failed tasks without payment controls", async t => {
  const props = { sessionId: "chat", plan: { ...plan, approvedSha256: plan.sha256 }, disabled: false, refreshKey: 0, onContinue: async () => {} };
  const f = await fixture(t, "CoursewareChatImages", props);
  f.rows([{ ...f.image, phase: "submission-unknown" }]); props.refreshKey++; f.render(); await f.flush();
  assert(f.nodes().some(node => node.props?.role === "status" && node.props.children === "coursewareWorkflow.imageState.submission-unknown"));
  assert.equal(f.button("submitImage"), undefined);
  const original = '{"error":{"code":"OutputImageSensitiveContentDetected.PolicyViolation"}}';
  f.rows([{ ...f.image, phase: "submitted", task: { state: "failed", feeState: "refunded", errorCode: "UPSTREAM_HTTP_400",
    upstreamResponse: { status: 400, contentType: "application/json", requestId: "provider-request-1", body: original, bodyEncoding: "utf-8", truncated: false } } }]);
  props.refreshKey++; f.render(); await f.flush();
  assert(f.nodes().some(node => node.props?.role === "alert" && node.props.children === "UPSTREAM_HTTP_400"));
  assert(f.nodes().some(node => node.type === "pre" && node.props.children === original));
  assert.equal(f.button("submitImage"), undefined);
  assert.equal(f.calls.length, 0);
});

test("ready images actually render and style confirmation adopts then continues the same Chat", async t => {
  let continued = 0;
  const props = { sessionId: "chat", plan: { ...plan, approvedSha256: plan.sha256 }, disabled: false, refreshKey: 0, onContinue: async () => { continued++; } };
  let image;
  const f = await fixture(t, "CoursewareChatImages", props, {
    async coursewareSceneImagePreview() { return { image, dataUrl: "data:image/png;base64,aGVsbG8=" }; },
    async coursewareSceneImageAdopt(...args) { f.calls.push(["adopt", ...args]); return [{ ...image, selected: true }]; },
  });
  image = { ...f.image, phase: "submitted", asset: { sha256: "b".repeat(64) } };
  f.rows([image]); props.refreshKey++; f.render(); await f.flush(); await f.flush();
  assert.equal(f.nodes().find(node => node.type === "img").props.src, "data:image/png;base64,aGVsbG8=");
  await f.click("confirmStyle");
  assert.deepEqual(f.calls, [["adopt", "chat", "master", null]]);
  assert.equal(continued, 1);
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

test("scene style presets can be customized and persist without changing the brief or other routes", async t => {
  const f = await fixture(t, "CoursewareTaskDialog", { projectPath: "/workspace", onClose() {} });
  const chooseRoute = kind => {
    f.nodes().find(node => node.type === "input" && node.props.value === kind).props.onChange(); f.render();
  };
  const styleField = () => f.nodes().find(node => node.type === "select" && node.props.id === "courseware-task-style");
  assert.equal(styleField(), undefined);
  chooseRoute("scene");
  const preset = styleField().props.children.flat().find(node => node?.type === "option" && node.props.value)?.props.value;
  assert(preset, "scene creation offers a style preset");
  styleField().props.onChange({ target: { value: preset } }); f.render();
  assert.equal(f.nodes().find(node => node.props.id === "courseware-task-style-description").props.value, preset);
  const custom = "Matte clay 3D, cream and blue, soft daylight; no watercolor or crayon texture.";
  f.nodes().find(node => node.props.id === "courseware-task-style-description").props.onChange({ target: { value: custom } }); f.render();
  assert.equal(styleField().props.value, "");
  chooseRoute("import");
  assert.equal(styleField(), undefined);
  chooseRoute("scene");
  assert.equal(f.nodes().find(node => node.props.id === "courseware-task-style-description").props.value, custom);
  styleField().props.onChange({ target: { value: "" } }); f.render();
  assert.equal(f.nodes().find(node => node.props.id === "courseware-task-style-description").props.value, "");
  f.nodes().find(node => node.props.id === "courseware-task-style-description").props.onChange({ target: { value: custom } }); f.render();
  const brief = "  A greeting lesson.  ";
  f.nodes().find(node => node.type === "textarea").props.onChange({ target: { value: brief } }); f.render();
  f.nodes().find(node => node.type === "form").props.onSubmit({ preventDefault() {} }); await f.flush();
  const setup = f.calls.at(-1)[1].courseware;
  assert.equal(setup.educationContext.visualStyle, custom);
  assert.equal(setup.initialPrompt, brief);
});

test("creating another route omits any previously entered scene-only style", async t => {
  for (const kind of ["plain", "import"]) {
    const f = await fixture(t, "CoursewareTaskDialog", { projectPath: "/workspace", onClose() {} });
    f.nodes().find(node => node.type === "input" && node.props.value === "scene").props.onChange(); f.render();
    f.nodes().find(node => node.props.id === "courseware-task-style-description").props.onChange({ target: { value: "Clay 3D" } }); f.render();
    f.nodes().find(node => node.type === "input" && node.props.value === kind).props.onChange(); f.render();
    f.nodes().find(node => node.type === "form").props.onSubmit({ preventDefault() {} }); await f.flush();
    assert.equal(f.calls.at(-1)[1].courseware.educationContext.visualStyle, undefined);
  }
});


const visualButton = (f, name) => f.nodes().find(node => node.type === "button" && node.props.children === "panel.pptEditor." + name);
const sourceVisual = { reviewId: "visual-1", pageNumber: 1, original: { preview: "original.png" }, nativeTextless: { preview: "textless.png" } };

async function visuals(t, overrides = {}) {
  const calls = [];
  const f = await fixture(t, "CoursewareSourceVisuals", { sessionId: "chat", enabled: true, disabled: false, onActiveChange() {} }, {
    async pptEditorVisualClear() { calls.push(["clear"]); },
    async pptEditorTeachingOpen() { calls.push(["teaching"]); return { viewId: "teaching-1" }; },
    async pptEditorTeachingDraftGet() { return { draft: null }; },
    async pptEditorVisualPrepare(...args) { calls.push(["prepare", ...args]); return sourceVisual; },
    async pptEditorVisualApprove(...args) { calls.push(["approve", ...args]); },
    ...overrides,
  });
  return { ...f, visualCalls: calls };
}

test("main Chat offers visual preparation only after a PPTX source exists", async t => {
  const f = await fixture(t, "CoursewareChatWorkflow", { sessionId: "chat" });
  assert(!f.nodes().some(node => node.type === "source-visuals"));
  f.import(); f.render(); await f.click("refresh");
  assert(!f.nodes().some(node => node.type === "source-visuals"));
  for (const type of ["plain", "scene", "import"]) {
    f.attached(type); await f.click("refresh");
    const node = f.nodes().find(node => node.type === "source-visuals");
    assert(node, type); assert.equal(node.props.sessionId, "chat");
    f.store.coursewareTeachingRefresh = undefined;
    node.props.onActiveChange(false); f.render();
    assert.equal(f.store.coursewareTeachingRefresh, undefined, "Idle mount must not start a competing teaching read");
    node.props.onActiveChange(true); f.render();
    assert(f.button("publish").props.disabled);
    node.props.onActiveChange(false); f.render();
    assert.equal(f.store.coursewareTeachingRefresh.reread, true);
    assert.equal(f.calls.filter(call => call[0] === "editor").length, 0);
  }
});

test("visual preparation requires explicit unchecked confirmation and never adopts a PPTX", async t => {
  const f = await visuals(t);
  visualButton(f, "visualPrepare").props.onClick(); await f.flush();
  assert.deepEqual(f.visualCalls, [["clear"], ["clear"], ["teaching"], ["prepare", "chat"]]);
  assert.equal(f.nodes().filter(node => node.type === "img").length, 2);
  assert(visualButton(f, "visualApprove").props.disabled);
  const checkbox = f.nodes().find(node => node.type === "input");
  assert.equal(checkbox.props.checked, false);
  checkbox.props.onChange({ target: { checked: true } }); f.render();
  visualButton(f, "visualApprove").props.onClick(); await f.flush();
  assert.deepEqual(f.visualCalls.at(-1), ["approve", "visual-1"]);
  f.props.disabled = true; f.render(); await f.flush();
  f.props.disabled = false; f.render(); await f.flush();
  assert(f.nodes().some(node => node.props?.role === "status"));
  assert.equal(f.visualCalls.filter(call => call[0] === "clear").length, 2, "An Agent turn must not revoke the reviewed inputs it needs");
});

test("visual preparation fences duplicate clicks, active turns and stored narration drafts", async t => {
  let release;
  const f = await visuals(t, { async pptEditorVisualPrepare() { f.visualCalls.push(["prepare"]); return new Promise(resolve => { release = resolve; }); } });
  const click = visualButton(f, "visualPrepare").props.onClick;
  click(); click(); await f.flush();
  assert.equal(f.visualCalls.filter(call => call[0] === "prepare").length, 1);
  release(sourceVisual); await f.flush();
  f.props.disabled = true; f.render();
  visualButton(f, "visualPrepare").props.onClick(); await f.flush();
  assert.equal(f.visualCalls.filter(call => call[0] === "prepare").length, 1);
  const draft = await visuals(t, { async pptEditorTeachingDraftGet() { return { draft: { instruction: "Keep my manual draft" } }; } });
  visualButton(draft, "visualPrepare").props.onClick(); await draft.flush();
  assert(!draft.visualCalls.some(call => call[0] === "prepare"));
  assert(draft.nodes().some(node => node.props?.role === "alert"));
});


test("late visual preparation cannot dispatch after switching Chat", async t => {
  let release;
  const f = await visuals(t, { async pptEditorTeachingDraftGet() { return new Promise(resolve => { release = resolve; }); } });
  visualButton(f, "visualPrepare").props.onClick(); await f.flush();
  f.props.sessionId = "other"; f.render(); await f.flush();
  release({ draft: null }); await f.flush();
  assert(!f.visualCalls.some(call => call[0] === "prepare"));
  assert.equal(f.nodes().filter(node => node.type === "img").length, 0);
});


test("unmounted Chat visual controls cannot clear or prepare another review", async t => {
  const f = await visuals(t);
  const click = visualButton(f, "visualPrepare").props.onClick;
  f.unmount();
  const count = f.visualCalls.length;
  click(); await f.flush();
  assert.equal(f.visualCalls.length, count);
});


test("ordinary exported projects expose the shared visuals without a scene generatedPath flag and retain them during an Agent turn", async t => {
  const marker = { type: "ordinary-source-visuals", props: {} };
  const props = { sessionId: "chat", disabled: false, refreshKey: 0, sourceVisuals: marker };
  const f = await fixture(t, "CoursewareChatPresentation", props);
  assert(!f.nodes().some(node => node.type === marker.type));
  f.project.exported = true; props.refreshKey++; f.render(); await f.flush();
  assert(f.nodes().some(node => node.type === marker.type));
  props.disabled = true; f.store.runningSessions.chat = true; f.render();
  assert(f.nodes().some(node => node.type === marker.type), "Reinspection cannot unmount and revoke approved inputs before redo starts");
  await f.flush(); assert(f.nodes().some(node => node.type === marker.type));
  props.disabled = false; f.store.runningSessions.chat = false; f.project.inputTime = 40; props.refreshKey++; f.render(); await f.flush();
  assert(!f.nodes().some(node => node.type === marker.type), "Changed generation inputs require a current exported source");
});

test("the ordinary workflow passes its single visual reviewer through the project inspector", async t => {
  const f = await fixture(t, "CoursewareChatWorkflow", { sessionId: "chat" });
  f.plain(); await f.click("refresh");
  const ordinary = f.nodes().find(node => node.type === "plain-presentation");
  assert(ordinary?.props.sourceVisuals);
  assert.equal(f.nodes().filter(node => node.type === "source-visuals").length, 0, "Parent attachment flags must not decide ordinary readiness");
});


test("preview polling survives Chat completion and disposes its timer on unmount", async t => {
  const interval = window.setInterval, clear = window.clearInterval;
  let tick, cleared = 0, statusReads = 0;
  window.setInterval = callback => { tick = callback; return 42; };
  window.clearInterval = id => { assert.equal(id, 42); cleared++; };
  t.after(() => { window.setInterval = interval; window.clearInterval = clear; });
  const props = { sessionId: "chat", plan: { ...plan, approvedSha256: plan.sha256 }, disabled: false, refreshKey: 0, onContinue: async () => {} };
  const f = await fixture(t, "CoursewareChatImages", props, {
    async coursewareSceneImageStatus() { statusReads++; return { ...f.image, phase: "submitted", task: { state: "submitted" } }; },
  });
  f.rows([{ ...f.image, phase: "submitted" }]);
  tick(); await f.flush();
  assert.equal(statusReads, 1);
  f.store.runningSessions.chat = true;
  tick(); await f.flush();
  assert.equal(statusReads, 2);
  f.store.runningSessions.chat = false;
  tick(); await f.flush();
  assert.equal(statusReads, 3);
  f.unmount();
  assert.equal(cleared, 1);
  tick(); await f.flush();
  assert.equal(statusReads, 3);
});


test("approved scenes replace planning with previews in the same workspace", async t => {
  const f = await fixture(t, "CoursewareChatWorkflow", { sessionId: "chat" });
  await f.click("approveContinue");
  assert(f.nodes().some(node => node.type === "scene-images"));
  assert(!f.button("imagePreview")); assert(!f.button("continue"));
  assert(!f.calls.some(call => call[0] === "editor"));
  assert(!f.nodes().some(node => node.type === "ppt-editor"));
});

test("visual master preview exposes the actual planned student text, never narration", async t => {
  const props = { sessionId: "chat", plan: { ...plan, approvedSha256: plan.sha256,
    pages: [{ ...plan.pages[0], visibleText: ["Hello, Pandy!", "I am a panda."], narration: "Teacher-only narration" }] },
    disabled: false, onContinue: async () => {} };
  const f = await fixture(t, "CoursewareChatImages", props, {
    async coursewareSceneImagePreview() { return { image: { ...f.image, asset: { sha256: "b".repeat(64) } }, dataUrl: "data:image/png;base64,aGVsbG8=" }; },
  });
  f.rows([{ ...f.image, phase: "submitted", asset: { sha256: "b".repeat(64) } }]);
  props.refreshKey = 1; f.render(); await f.flush(); await f.flush();
  const text = f.nodes().map(node => node.props?.children).filter(value => typeof value === "string");
  assert(text.includes("Hello, Pandy!"));
  assert(text.includes("I am a panda."));
  assert(!text.includes("Teacher-only narration"));
});

test("course visual guide is visible in the plan review before approval", async t => {
  const f = await fixture(t, "CoursewareChatWorkflow", { sessionId: "chat" });
  f.plan.visualBible = { artDirection: "Matte watercolor", characters: "Pandy wears a green scarf", setting: "Woodland classroom" };
  await f.click("refresh");
  const text = f.nodes().map(node => node.props?.children).filter(value => typeof value === "string");
  for (const value of Object.values(f.plan.visualBible)) assert(text.includes(value));
  assert(f.button("approveContinue"));
});

test("preview student text follows the focused page and is hidden for decomposed layers", async t => {
  const props = { sessionId: "chat", plan: { ...plan, approvedSha256: plan.sha256,
    pages: [plan.pages[0], { ...plan.pages[0], pageId: "scene-002", visibleText: ["Hello, Pandy!"] }] },
    disabled: false, onContinue: async () => {} };
  let images;
  const f = await fixture(t, "CoursewareChatImages", props, {
    async coursewareSceneImagePreview(_session, id) { return { image: images.find(row => row.intentId === id), dataUrl: "data:image/png;base64,aGVsbG8=" }; },
  });
  images = [{ ...f.image, phase: "submitted", asset: { sha256: "b".repeat(64) } },
    { ...f.image, intentId: "second", pageId: "scene-002", phase: "submitted", asset: { sha256: "c".repeat(64) } },
    { ...f.image, intentId: "layer", target: { kind: "layer", name: "Pandy" }, phase: "submitted", asset: { sha256: "d".repeat(64) } }];
  f.rows(images); props.refreshKey = 1; f.render(); await f.flush(); await f.flush();
  const focus = async id => {
    f.nodes().find(node => node.props?.["data-scene-page"] === images.find(row => row.intentId === id).pageId).props.onClick();
    f.render(); await f.flush();
    f.nodes().find(node => node.props?.["data-scene-image-intent"] === id).props.onClick();
    f.render(); await f.flush(); await f.flush(); };
  await focus("second");
  assert(f.nodes().some(node => node.type === "p" && node.props.children === "Hello, Pandy!"));
  await focus("layer");
  assert(!f.nodes().some(node => node.props?.["aria-label"] === "coursewareWorkflow.pageText"));
});

test("a prepared cover has an explicit generation hint and no false style confirmation", async t => {
  const props = { sessionId: "chat", plan: { ...plan, approvedSha256: plan.sha256 }, disabled: false, onContinue: async () => {} };
  const f = await fixture(t, "CoursewareChatImages", props);
  assert(f.nodes().some(node => node.props?.role === "status" && node.props.children === "coursewareWorkflow.phase_cover"));
  assert(f.button("resume")); assert(!f.button("submitImage"));
  assert(!f.button("confirmStyle"));
  assert(!f.nodes().some(node => node.props?.children === "coursewareWorkflow.sceneStyleReview"));
});

test("service uncertainty never asks for another style confirmation or blocks independent generation", async t => {
  for (const unknown of [{ phase: "submission-unknown", task: null },
    { phase: "submitted", task: { state: "submission_unknown", feeState: "reserved" } }]) {
    const props = { sessionId: "chat", plan: { ...plan, approvedSha256: plan.sha256 }, disabled: false, refreshKey: 0, onContinue: async () => {} };
    const f = await fixture(t, "CoursewareChatImages", props);
    f.rows([{ ...f.image, selected: true, asset: { sha256: "b".repeat(64) } },
      { ...f.image, intentId: "uncertain", target: { kind: "cleanPlate" }, ...unknown },
      { ...f.image, intentId: "prepared-layer", target: { kind: "layer", name: "Pandy" } }]);
    props.refreshKey++; f.render(); await f.flush();
    assert(!f.nodes().some(node => ["coursewareWorkflow.sceneSubmissionUnknown", "coursewareWorkflow.sceneStyleReview"].includes(node.props?.children)));
    f.nodes().find(node => node.props?.["data-scene-image-intent"] === "prepared-layer").props.onClick();
    f.render(); await f.flush();
    assert.equal(f.button("resume").props.disabled, false);
    assert(f.nodes().some(node => node.props?.children === "coursewareWorkflow.activity_unknown"));
    assert(!f.button("confirmStyle"));
    assert(!f.calls.some(call => call[0] === "generate"));
  }
});

test("scene workspace groups requests under numbered pages and keeps navigation and details separate", async t => {
  const props = { sessionId: "chat", plan: { ...plan, approvedSha256: plan.sha256,
    pages: [plan.pages[0], { ...plan.pages[0], pageId: "scene-002", title: "Panda" }] },
    disabled: false, refreshKey: 0, onContinue: async () => {} };
  const f = await fixture(t, "CoursewareChatImages", props);
  f.rows([f.image, { ...f.image, intentId: "layer", target: { kind: "layer", name: "Circle" } },
    { ...f.image, intentId: "second", pageId: "scene-002" }]);
  props.refreshKey++; f.render(); await f.flush();
  assert.equal(f.nodes().filter(node => node.props?.["data-scene-page"]).length, 2);
  for (const tag of ["nav", "main", "aside"]) assert(f.nodes().some(node => node.type === tag), tag);
  assert(f.nodes().some(node => node.props?.["data-scene-image-intent"] === "layer"));
  const next = f.nodes().find(node => node.type === "button" && node.props["aria-label"] === "coursewareWorkflow.nextPage");
  assert(next); next.props.onClick(); f.render(); await f.flush();
  assert(f.nodes().some(node => node.props?.["data-scene-page"] === "scene-002" && node.props["aria-current"] === "page"));
  assert(!f.nodes().some(node => node.props?.["data-scene-image-intent"] === "layer"));
});

test("failed preview offers a retry and cannot adopt an unseen image", async t => {
  let fail = true;
  const props = { sessionId: "chat", plan: { ...plan, approvedSha256: plan.sha256 }, disabled: false, refreshKey: 0, onContinue: async () => {} };
  const f = await fixture(t, "CoursewareChatImages", props, {
    async coursewareSceneImagePreview() {
      if (fail) throw new Error("Archive read failed");
      return { image: { ...f.image, asset: { sha256: "b".repeat(64) } }, dataUrl: "data:image/png;base64,aGVsbG8=" };
    },
  });
  f.rows([{ ...f.image, asset: { sha256: "b".repeat(64) }, phase: "submitted" }]);
  props.refreshKey++; f.render(); await f.flush(); await f.flush();
  assert(!f.button("confirmStyle")); assert(f.button("retryPreview"));
  fail = false; await f.click("retryPreview"); await f.flush();
  assert(f.nodes().some(node => node.type === "img")); assert(f.button("confirmStyle"));
});


test("later masters and decomposition previews have no manual adoption control", async t => {
  const props = { sessionId: "chat", plan: { ...plan, approvedSha256: plan.sha256,
    pages: [plan.pages[0], { ...plan.pages[0], pageId: "scene-002" }] }, disabled: false, refreshKey: 0, onContinue: async () => {} };
  let images;
  const f = await fixture(t, "CoursewareChatImages", props, {
    async coursewareSceneImagePreview(_session, id) { return { image: images.find(row => row.intentId === id), dataUrl: "data:image/png;base64,aGVsbG8=" }; },
  });
  images = [{ ...f.image, selected: true, asset: { sha256: "c".repeat(64) } },
    { ...f.image, intentId: "later", pageId: "scene-002", asset: { sha256: "b".repeat(64) } },
    { ...f.image, intentId: "clean", target: { kind: "cleanPlate" }, asset: { sha256: "d".repeat(64) } }];
  f.rows(images); props.refreshKey++; f.render(); await f.flush();
  for (const image of images.slice(1)) {
    f.nodes().find(node => node.props?.["data-scene-page"] === image.pageId).props.onClick(); f.render(); await f.flush();
    f.nodes().find(node => node.props?.["data-scene-image-intent"] === image.intentId).props.onClick(); f.render(); await f.flush();
    assert(!f.button("selectContinue"));
    assert(!f.button("confirmStyle"));
  }
});

test("a saved PPT mounts the real editor component while the Agent continues teaching", async t => {
  const f = await fixture(t, "CoursewareChatWorkflow", { sessionId: "chat" });
  f.attached("scene"); f.store.runningSessions.chat = true; f.render(); await f.flush();
  const editor = f.nodes().find(node => node.type === "ppt-editor");
  assert.equal(editor.props.path, "/workspace/import.pptx");
  assert.equal(editor.props.tabId, "ppt");
  assert(!f.button("openEditor")); assert(!f.button("continue"));
  assert(!f.nodes().some(node => node.type === "scene-images"));
  assert(f.button("publish").props.disabled);
  await f.click("refresh");
  assert.equal(f.nodes().find(node => node.type === "ppt-editor").props.path, editor.props.path);
});

test("ordinary inspection hands a validated PPT to the workspace during an active turn", async t => {
  const paths = [], props = { sessionId: "chat", disabled: true, refreshKey: 0, onReady: path => paths.push(path) };
  const f = await fixture(t, "CoursewareChatPresentation", props);
  f.store.runningSessions.chat = true; f.project.exported = true; props.refreshKey++; f.render(); await f.flush();
  assert.equal(paths.at(-1), `${f.projectPath}/exports/lesson.pptx`);
  assert.equal(f.button("openEditor").props.disabled, true);
  const before = f.calls.length;
  f.button("openEditor").props.onClick(); await f.flush();
  assert.equal(f.calls.length, before);
});

test("images, layers and compiler stages never expose PPT editor tools", async t => {
  const props = { sessionId: "chat", plan: { ...plan, approvedSha256: plan.sha256 }, disabled: true, refreshKey: 0, onContinue: async () => {} };
  const f = await fixture(t, "CoursewareChatImages", props);
  f.rows([{ ...f.image, selected: true, phase: "submitted", asset: { sha256: "b".repeat(64), byteLength: 100 } }]);
  props.refreshKey++; f.render(); await f.flush();
  assert(f.nodes().some(node => node.props?.["data-courseware-phase"] === "layers"));
  props.compilation = { planSha256: plan.sha256, state: "running" }; f.render(); await f.flush();
  assert(f.nodes().some(node => node.props?.["data-courseware-phase"] === "converting"));
  assert(!f.nodes().some(node => node.type === "ppt-editor"));
  assert(!f.button("submitImage")); assert(!f.button("confirmStyle"));
  assert.equal(f.calls.length, 0);
});

test("a style change sends its own instruction and never adopts the displayed cover", async t => {
  const actions = [], props = { sessionId: "chat", plan: { ...plan, approvedSha256: plan.sha256 }, disabled: false, refreshKey: 0,
    onContinue: async (...args) => actions.push(args) };
  const f = await fixture(t, "CoursewareChatImages", props);
  f.rows([{ ...f.image, asset: { sha256: "b".repeat(64) }, phase: "submitted" }]);
  props.refreshKey++; f.render(); await f.flush(); await f.flush();
  assert(f.button("restyle").props.disabled);
  f.nodes().find(node => node.type === "textarea").props.onChange({ target: { value: "Soft clay figures" } }); f.render();
  await f.click("restyle");
  assert.deepEqual(actions, [["restyle", "Soft clay figures"]]);
  assert(!f.calls.some(call => call[0] === "adopt" || call[0] === "generate"));
});


test("the compact entrance opens a new workspace once and never reopens it on later messages", async t => {
  const f = await fixture(t, "CoursewareWorkspaceEntry", { sessionId: "chat" });
  assert(f.button("openWorkspace")); assert.equal(f.calls.length, 1);
  f.store.messages = [{ role: "assistant", content: "working" }]; f.render(); await f.flush();
  assert.equal(f.calls.length, 1);
  await f.click("openWorkspace"); assert.equal(f.calls.length, 2);
});

test("a retained work panel is not replaced when the courseware entrance mounts", async t => {
  let release;
  const f = await fixture(t, "CoursewareWorkspaceEntry", { sessionId: "chat" }, {
    coursewareTaskGet: () => new Promise(resolve => { release = resolve; }),
  });
  f.store.workPanelTabs = [{ id: "file:notes.txt", kind: "file", resource: "notes.txt" }];
  release({ task: {} }); await f.flush();
  assert(f.button("openWorkspace")); assert.equal(f.calls.length, 0);
});


test("failed continuation remains actionable after successful workspace polling", async t => {
  const f = await fixture(t, "CoursewareChatWorkflow", { sessionId: "chat" });
  f.store.sendPrompt = async () => false;
  await f.click("approveContinue");
  assert(f.nodes().some(node => node.props?.role === "alert" && String(node.props.children).includes("sendFailed")));
  await f.click("refresh");
  assert(f.nodes().some(node => node.props?.role === "alert" && String(node.props.children).includes("sendFailed")));
  assert(f.nodes().some(node => node.type === "scene-images"));
  assert.equal(f.calls.filter(call => call[0] === "approve").length, 1);
});

for (const state of ["ready", "failed", "cancelled", "archive_failed"]) test(`${state} image receipts survive list refreshes without repeated supplier polling`, async t => {
  const originalInterval = window.setInterval;
  let tick;
  window.setInterval = callback => { tick = callback; return 0; };
  t.after(() => { window.setInterval = originalInterval; });
  const props = { sessionId: "chat", plan: { ...plan, approvedSha256: plan.sha256 }, disabled: false, refreshKey: 0, onContinue: async () => {} };
  const reads = [];
  let authChanged;
  const f = await fixture(t, "CoursewareChatImages", props, {
    onAuthChanged(callback) { authChanged = callback; return () => {}; },
    async coursewareSceneImageArchive(_session, id) {
      return { image: { ...f.image, intentId: id, asset: { sha256: "b".repeat(64) } }, dataUrl: "data:image/png;base64,aGVsbG8=" };
    },
    async coursewareSceneImageStatus(_session, id) {
      reads.push(id);
      return { ...f.image, intentId: id, phase: "submitted", task: { state, feeState: state === "ready" ? "settled" : "released", errorCode: state === "ready" ? null : "UPSTREAM_HTTP_400" } };
    },
  });
  f.rows([{ ...f.image, intentId: "failed", phase: "submitted" }]);
  tick(); await f.flush();
  assert.deepEqual(reads, ["failed"]);
  tick(); await f.flush();
  props.refreshKey++; f.render(); await f.flush();
  tick(); await f.flush();
  assert.deepEqual(reads, ["failed"]);
  assert(f.nodes().some(node => node.type === "small" && node.props.children === `coursewareWorkflow.imageState.${state}`));
  f.nodes().find(node => node.type === "button" && node.props["aria-label"] === "coursewareWorkflow.refresh").props.onClick();
  f.render(); await f.flush();
  assert.equal(reads.length, 2, "Explicit refresh may reread the original job");
  tick(); await f.flush();
  assert.equal(reads.length, 2);
  authChanged(); f.render(); await f.flush();
  assert.deepEqual(reads, ["failed", "failed", "failed"], "Authentication changes require a fresh receipt");
  tick(); await f.flush();
  assert.equal(reads.length, 3);
});

test("idle workflow reads once while active workflow keeps refreshing", async t => {
  const timers = new Map();
  t.mock.method(window, "setInterval", fn => { const id = Symbol(); timers.set(id, fn); return id; });
  t.mock.method(window, "clearInterval", id => timers.delete(id));
  const f = await fixture(t, "CoursewareChatWorkflow", { sessionId: "chat" });
  assert.equal(timers.size, 0);
  f.store.runningSessions.chat = true; f.render(); await f.flush();
  assert.equal(timers.size, 1);
  f.store.runningSessions.chat = false; f.render(); await f.flush();
  assert.equal(timers.size, 0);
});

test("a failed image status stays with its task while other pages continue refreshing", async t => {
  const originalInterval = window.setInterval;
  let tick;
  window.setInterval = callback => { tick = callback; return 0; };
  t.after(() => { window.setInterval = originalInterval; });
  const pages = [...plan.pages, { ...plan.pages[0], pageId: "scene-002", title: "Square" }];
  const props = { sessionId: "chat", plan: { ...plan, pages, approvedSha256: plan.sha256 }, disabled: false, onContinue: async () => {} };
  let recovered = false;
  const reads = [];
  const f = await fixture(t, "CoursewareChatImages", props, {
    async coursewareSceneImageStatus(_session, id) {
      reads.push(id);
      if (id === "broken" && !recovered) throw new Error("COURSEWARE_MEDIA_HTTP_503");
      return { ...f.image, intentId: id, pageId: id === "broken" ? "scene-001" : "scene-002", phase: "submitted", asset: { sha256: "b".repeat(64) } };
    },
  });
  f.rows(["broken", "healthy"].map((id, index) => ({ ...f.image, intentId: id, pageId: pages[index].pageId, phase: "submitted" })));
  tick(); await f.flush();
  assert.deepEqual(reads, ["broken", "healthy"]);
  assert(f.nodes().some(node => node.props?.["data-scene-image-error"] === "broken"));
  const next = f.nodes().find(node => node.type === "button" && node.props?.["aria-label"] === "coursewareWorkflow.nextPage");
  assert(next); next.props.onClick(); await f.flush();
  assert(f.nodes().some(node => node.props?.["data-scene-image-intent"] === "healthy"));
  assert(!f.nodes().some(node => node.props?.["data-scene-image-error"] === "broken"), "Another page must not show the failed task's error");
  recovered = true;
  tick(); await f.flush();
  const previous = f.nodes().find(node => node.type === "button" && node.props?.["aria-label"] === "coursewareWorkflow.previousPage");
  previous.props.onClick(); await f.flush();
  assert(!f.nodes().some(node => node.props?.["data-scene-image-error"] === "broken"), "Successful refresh clears the task's error");
  assert(!f.calls.some(call => ["generate", "paid"].includes(call[0])));
});

const teachingStory = { schemaVersion: 1, revision: 1, sha256: "c".repeat(64), approvedSha256: null, bound: false, educationContext: {}, draft: {
  title: "Rainbow rescue", summary: "Find the colors", setting: "A garden", objectives: ["Name red"], characters: [{ name: "Robin", description: "A round robot" }],
  beats: [{ id: "find", title: "Find red", event: "Find the ball", objective: "Name red", activity: "Sort colors" }], assumptions: [] } };
for (const taskType of ["plain", "scene"]) test(`story review confirms the exact version and resumes the selected ${taskType} route`, async t => {
  let story = structuredClone(teachingStory);
  const f = await fixture(t, "CoursewareChatWorkflow", { sessionId: "chat" }, {
    async coursewareWorkflowGet() { return { task: { taskType, generated: false, imported: false, storyFirst: true }, story: structuredClone(story), plan: null }; },
    async coursewareStoryDecision(...args) { assert.deepEqual(args, ["chat", 1, teachingStory.sha256, "approve"]); story.approvedSha256 = story.sha256; return { story: structuredClone(story) }; },
  });
  assert(f.nodes().some(n => n.props?.children === "Rainbow rescue"));
  assert(!f.nodes().some(n => n.type === "plain-presentation" || n.type === "scene-images"));
  const approve = () => f.nodes().find(n => n.type === "button" && n.props.children === "coursewareStory.approve");
  f.store.runningSessions.chat = true; f.render(); assert.equal(approve().props.disabled, true);
  f.store.runningSessions.chat = false; f.render(); approve().props.onClick(); await f.flush();
  assert(f.calls.some(call => call[0] === "prompt" && call[1] === "coursewareStory.continuePrompt"));
  assert(!f.nodes().some(n => n.type === "button" && n.props.children === "coursewareStory.approve"));
});
test("new task keeps direct generation by default and preserves story selection only for supported routes", async t => {
  for (const taskType of ["plain", "scene", "import"]) {
    const f = await fixture(t, "CoursewareTaskDialog", { projectPath: "/workspace", onClose() {} });
    const story = f.nodes().find(n => n.type === "input" && n.props.name === "creation-mode" && !n.props.checked);
    assert(story); story.props.onChange(); f.render();
    f.nodes().find(n => n.type === "input" && n.props.name === "courseware-task-type" && n.props.value === taskType).props.onChange(); f.render();
    f.nodes().find(n => n.type === "form").props.onSubmit({ preventDefault() {} }); await f.flush();
    const setup = f.calls.find(call => call[0] === "create")[1].courseware;
    assert.equal(setup.taskType, taskType); assert.equal(setup.storyFirst, taskType === "import" ? undefined : true);
    f.unmount();
  }
});

test("a confirmed story survives failed continuation and resumes without another approval", async t => {
  const story = structuredClone(teachingStory);
  let confirmations = 0;
  const f = await fixture(t,"CoursewareChatWorkflow",{sessionId:"chat"},{
    async coursewareWorkflowGet() { return { task:{taskType:"plain",generated:false,imported:false,storyFirst:true},story:structuredClone(story),plan:null }; },
    async coursewareStoryDecision() { confirmations++; story.approvedSha256=story.sha256; return {story:structuredClone(story)}; },
  });
  f.store.sendPrompt=async()=>false;
  f.nodes().find(node=>node.type==="button"&&node.props.children==="coursewareStory.approve").props.onClick(); await f.flush();
  assert(f.nodes().some(node=>node.props?.role==="alert"&&String(node.props.children).includes("sendFailed")));
  assert(!f.nodes().some(node=>node.type==="button"&&node.props.children==="coursewareStory.approve"));
  let resumed=false;
  f.store.sendPrompt=async()=>{resumed=true;return true;};
  await f.click("resume");
  assert(resumed); assert.equal(confirmations,1);
  story.bound=true; await f.click("refresh");
  assert(!f.nodes().some(node=>node.type==="button"&&node.props.children==="coursewareStory.disable"));
});


test("saved story belongs to the editor sidebar instead of a block above the PPT", async t => {
  const story={...structuredClone(teachingStory),bound:true,approvedSha256:teachingStory.sha256};
  const f=await fixture(t,'CoursewareChatWorkflow',{sessionId:'chat'},{
    async coursewareWorkflowGet(){return {task:{taskType:'scene',generated:true,sourcePath:'/workspace/story.pptx',storyFirst:true},story,plan:null};},
  });
  const editor=f.nodes().find(node=>node.type==='ppt-editor');
  assert(editor?.props.storyPanel);
  assert(JSON.stringify(editor.props.storyPanel).includes('Rainbow rescue'));
  assert(!f.nodes().some(node=>node.type==='summary'&&node.props.children==='coursewareStory.saved'));
});
