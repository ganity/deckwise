import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const compiled = ts.transpileModule(await readFile(new URL("../src/components/courseware/CoursewareChatPresentation.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture({ exported = false, running = false, hasSvg = true } = {}) {
  const hooks = [], effects = [], opened = [], inspected = [];
  const timers = new Set();
  let cursor = 0, tree;
  const project = { projectPath: ".deckwise-ppt/projects/family", hasSvg,
    pptxPath: exported ? ".deckwise-ppt/projects/family/exports/family.pptx" : null,
    needsPptxRegeneration: false, qualityIssue: null };
  const state = { messages: [], activeSessionId: "session", runningSessions: { session: running },
    openWorkPanelTab: tab => opened.push(tab) };
  const props = { sessionId: "session", sourcePath: "/workspace/.deckwise-ppt/projects/family/exports/family.pptx",
    disabled: running, refreshKey: 0, onReady() {} };
  const api = { async pptPreviewOpen(path, sessionId, requireSlide) {
    assert.equal(path, project.projectPath);
    assert.equal(sessionId, props.sessionId);
    return requireSlide && !project.hasSvg ? null : { started: false };
  } };
  const exports = {};
  new Function("require", "exports", "window", compiled)(id => {
    if (id === "../../lib/api") return { api };
    if (id === "../../lib/ppt-master-project") return {
      referencedProject: (messages, sourcePath) => {
        const match = [sourcePath, ...messages.map(message => message.content)].join(" ").match(/\.deckwise-ppt\/projects\/[^/\s]+/);
        return match?.[0] ?? null;
      },
      async inspectProject(path) { inspected.push(path); return { ...project }; },
    };
    if (id === "../../lib/work-panel-tabs") return { svgEditorWorkPanelTab: resource => ({ kind: "svg-editor", resource }) };
    if (id === "../../stores/app-store") return { useAppStore: Object.assign(selector => selector(state), { getState: () => state }) };
    if (id === "react-i18next") return { useTranslation: () => ({ t: key => key }) };
    if (id === "react") return {
      useState(value) { const index = cursor++; if (!(index in hooks)) hooks[index] = value;
        return [hooks[index], value => { hooks[index] = typeof value === "function" ? value(hooks[index]) : value; }]; },
      useRef(value) { return hooks[cursor++] ??= { current: value }; },
      useEffect(effect, dependencies) { const index = cursor++, previous = hooks[index];
        if (!previous || dependencies.some((value, i) => value !== previous.dependencies[i]))
          effects.push(() => { previous?.cleanup?.(); hooks[index] = { dependencies, cleanup: effect() }; }); },
    };
    assert.equal(id, "react/jsx-runtime");
    return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
  }, exports, {
    setInterval(callback) { timers.add(callback); return callback; },
    clearInterval(callback) { timers.delete(callback); },
  });
  const render = () => { cursor = 0; tree = exports.CoursewareChatPresentation(props); while (effects.length) effects.shift()(); };
  const settle = async () => { for (let i = 0; i < 4; i++) { await flush(); render(); } };
  const buttons = () => { const result = []; const visit = node => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    if (node.type === "button") result.push(node);
    visit(node.props?.children);
  }; visit(tree); return result; };
  render();
  return { props, project, state, api, opened, inspected, settle, render,
    poll: () => timers.forEach(callback => callback()),
    preview: () => buttons().find(node => node.props.children === "coursewareWorkflow.previewPages"),
    dispose: () => hooks.forEach(hook => hook?.cleanup?.()) };
}

test("an adopted PPTX retains manual SVG editing without depending on retained chat messages", async () => {
  const f = fixture({ exported: true });
  let editorPreview;
  f.props.renderEditor = preview => {
    editorPreview = preview;
    return { type: "editor", props: { children: preview } };
  };
  try {
    await f.settle();
    assert.deepEqual(f.inspected, [".deckwise-ppt/projects/family"]);
    assert(editorPreview, "SVG entry must remain in the editor toolbar after export");
    assert.equal(f.preview(), editorPreview);
    f.preview().props.onClick(); await f.settle();
    assert.deepEqual(f.opened, [{ kind: "svg-editor", resource: f.project.projectPath }]);
  } finally { f.dispose(); }
});

test("the first SVG opens automatically while generation runs and refresh does not steal focus", async () => {
  const f = fixture({ running: true, hasSvg: false });
  try {
    await f.settle();
    assert.equal(f.opened.length, 0);
    f.project.hasSvg = true;
    f.poll(); await f.settle();
    assert.equal(f.opened.length, 1);
    assert.equal(f.preview().props.disabled, false);
    f.props.refreshKey++; f.render(); await f.settle();
    assert.equal(f.opened.length, 1);
  } finally { f.dispose(); }
});

test("a preview response from a previous session cannot open the current work panel", async () => {
  const f = fixture();
  let release;
  f.api.pptPreviewOpen = () => new Promise(resolve => { release = resolve; });
  try {
    await f.settle();
    f.state.activeSessionId = "other"; release({ started: false }); await f.settle();
    assert.equal(f.opened.length, 0);
  } finally { f.dispose(); }
});
test("switching projects releases a pending preview and fences its late result", async () => {
  const f = fixture();
  let release;
  f.api.pptPreviewOpen = () => new Promise(resolve => { release = resolve; });
  try {
    await f.settle();
    f.api.pptPreviewOpen = async () => ({ started: false });
    f.props.sourcePath = "/workspace/.deckwise-ppt/projects/other";
    f.project.projectPath = ".deckwise-ppt/projects/other";
    f.render(); await f.settle();
    assert.deepEqual(f.opened.map(tab => tab.resource), [f.project.projectPath]);
    release({ started: false }); await f.settle();
    assert.equal(f.opened.length, 1);
    assert.equal(f.preview().props.disabled, false);
  } finally { f.dispose(); }
});
