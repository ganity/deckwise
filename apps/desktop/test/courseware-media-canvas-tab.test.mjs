import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import * as model from "../src/lib/courseware-media-canvas.ts";

const source = await readFile(new URL("../src/components/workpanel/CoursewareMediaCanvasTab.tsx", import.meta.url), "utf8");
const flush = () => new Promise(resolve => setImmediate(resolve));

async function setup() {
  const hooks = [], effects = [], calls = [], saved = new Map();
  let cursor = 0, tree;
  const props = { sessionId: "session-a" };
  const store = { isRunning: false, activeSessionId: "session-a", async sendPrompt(...args) { calls.push(["chat", ...args]); return true; } };
  const api = {
    onAuthChanged(listener) { api.authChanged = listener; return () => {}; },
    async coursewareSceneImageList() { return []; },
    async coursewareCanvasImageList() { return []; },
    async coursewareMediaCanvasGet(sessionId) {
      calls.push(["get", sessionId]);
      return structuredClone(saved.get(sessionId) ?? { projectId: sessionId + "-project", revision: null, document: null });
    },
    async coursewareMediaCanvasSet(sessionId, revision, document) {
      calls.push(["set", sessionId, revision, structuredClone(document)]);
      const previous = saved.get(sessionId);
      if ((previous?.revision ?? null) !== revision) throw new Error("COURSEWARE_CONFLICT");
      const result = { projectId: document.projectId, revision: `save-${document.revision}`, document: structuredClone(document) };
      saved.set(sessionId, result); return structuredClone(result);
    },
  };
  const exports = {};
  const Child = () => {};
  const Images = () => {};
  new Function("require", "exports", ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText)(id => {
    if (id === "../../lib/api") return { api };
    if (id === "../../lib/courseware-media-canvas") return model;
    if (id === "./CoursewareMediaCanvas") return { CoursewareMediaCanvas: Child };
    if (id === "./CoursewareCanvasImages") return { CoursewareCanvasImages: Images };
    if (id === "./CoursewareCanvasMusic") return { CoursewareCanvasMusic: () => {} };
    if (id === "../../stores/app-store") { const useAppStore = selector => selector(store); useAppStore.getState = () => store; return { useAppStore }; }
    if (id === "react-i18next") return { useTranslation: () => ({ t: key => key }) };
    if (id === "react") return {
      useState(initial) { const index = cursor++; if (!(index in hooks)) hooks[index] = initial;
        return [hooks[index], value => { hooks[index] = typeof value === "function" ? value(hooks[index]) : value; }]; },
      useRef(initial) { const index = cursor++; return hooks[index] ??= { current: initial }; },
      useEffect(effect, dependencies) { const index = cursor++, previous = hooks[index];
        if (!previous || dependencies.some((value, i) => value !== previous.dependencies[i])) {
          effects.push(() => { previous?.cleanup?.(); hooks[index] = { dependencies, cleanup: effect() }; });
        }
      },
    };
    assert.equal(id, "react/jsx-runtime");
    return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
  }, exports);
  const render = () => { cursor = 0; tree = exports.CoursewareMediaCanvasTab(props); while (effects.length) effects.shift()(); };
  const nodes = () => { const out = []; const visit = value => { if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return; out.push(value); visit(value.props?.children); }; visit(tree); return out; };
  const child = () => nodes().find(node => node.type === Child)?.props;
  const button = key => nodes().find(node => node.type === "button" && node.props.children === `panel.mediaCanvas.${key}`);
  render(); await flush(); render();
  const images = () => nodes().find(node => node.type === Images)?.props;
  return { props, api, store, calls, saved, render, nodes, child, images, button };
}

test("canvas queues Host CAS writes, coalesces layout edits, and restores persisted state after reload", async () => {
  const f = await setup();
  let document = model.addMediaCanvasDraft(f.child().document, "draft", "image", "Image");
  f.child().onChange(document); f.render();
  document = model.editMediaCanvasDraft(document, "draft", 0, { prompt: "Latest prompt" });
  f.child().onChange(document); f.render();
  assert.equal(f.child().saveState, "saving");
  assert.equal(f.images().disabled, true);
  await flush(); f.render();
  assert.equal(f.calls.filter(call => call[0] === "set").length, 1);
  assert.equal(f.child().saveState, "saved");
  assert.equal(f.images().disabled, false);
  assert.equal(f.images().revision, "save-2");
  assert.equal(f.images().document.drafts[0].prompt, "Latest prompt");
  f.button("reload").props.onClick(); f.render(); await flush(); f.render();
  assert.equal(f.child().document.drafts[0].prompt, "Latest prompt");
});

test("conflict retains local draft across sessions; retry keeps CAS and discard needs explicit confirmation", async () => {
  const f = await setup();
  const document = model.addMediaCanvasDraft(f.child().document, "draft", "image", "Unsaved image");
  f.saved.set("session-a", { projectId: "session-a-project", revision: "foreign", document: model.createMediaCanvasDocument("session-a-project") });
  f.child().onChange(document); await flush(); f.render();
  assert.equal(f.child().saveState, "error");
  assert.equal(f.button("reload").props.disabled, true);
  assert.equal(f.button("discardReload").props.disabled, true);
  f.props.sessionId = "session-b"; f.store.activeSessionId = "session-b"; f.render(); await flush(); f.render();
  assert.equal(f.child().document.projectId, "session-b-project");
  f.props.sessionId = "session-a"; f.store.activeSessionId = "session-a"; f.render(); f.render();
  assert.equal(f.child().document.drafts[0].title, "Unsaved image");
  f.button("retrySave").props.onClick(); await flush(); f.render();
  assert.equal(f.child().saveState, "error");
  assert.equal(f.saved.get("session-a").document.drafts.length, 0);
  f.nodes().find(node => node.type === "input").props.onChange({ target: { checked: true } }); f.render();
  f.button("discardReload").props.onClick(); f.render(); await flush(); f.render();
  assert.equal(f.child().document.drafts.length, 0);
});

test("Chat targets existing main conversation, then refreshes from Host when the turn finishes", async () => {
  const f = await setup();
  const document = model.addMediaCanvasDraft(f.child().document, "draft", "image", "Image");
  f.child().onChange(document); await flush(); f.render();
  await f.child().onEditInChat({ projectId: document.projectId, draftId: "draft", expectedRevision: 0, instruction: "Make it cheerful" });
  const chat = f.calls.find(call => call[0] === "chat");
  assert.equal(chat[3], "session-a"); assert.match(chat[1], /courseware_canvas_edit/);
  assert.match(chat[1], /expected draft revision: 0/);
  f.store.isRunning = true; f.render();
  const remote = f.saved.get("session-a");
  remote.document = model.editMediaCanvasDraft(remote.document, "draft", 0, { prompt: "Cheerful rabbit" }); remote.revision = "remote-edit";
  f.store.isRunning = false; f.render(); await flush(); f.render();
  assert.equal(f.child().document.drafts[0].prompt, "Cheerful rabbit");
  f.store.activeSessionId = "wrong-session";
  await assert.rejects(f.child().onEditInChat({ projectId: document.projectId, draftId: "draft", expectedRevision: 1, instruction: "Edit" }), /chatUnavailable/);
});

test("reference loading is explicit, scoped to selected archived images and invalidated on account change", async () => {
  const f = await setup();
  let reads = 0;
  f.api.coursewareSceneImageList = async sessionId => {
    reads++; assert.equal(sessionId, "session-a");
    return [
      { intentId: "approved", current: true, selected: true, asset: { sha256: "a".repeat(64) }, pageId: "scene-001", target: { kind: "layer", name: "Rabbit" } },
      { intentId: "unselected", current: true, selected: false, asset: { sha256: "b".repeat(64) } },
      { intentId: "stale", current: false, selected: true, asset: { sha256: "c".repeat(64) } },
      { intentId: "unarchived", current: true, selected: true, asset: null },
    ];
  };
  assert.equal(reads, 0); assert.deepEqual(f.child().references, []);
  await f.button("loadReferences").props.onClick(); f.render();
  assert.deepEqual(f.child().references, [{ assetId: "approved", revision: "a".repeat(64), label: "scene-001 · Rabbit" }]);
  f.api.authChanged(); f.render(); assert.deepEqual(f.child().references, []);
  let finish;
  f.api.coursewareSceneImageList = () => new Promise(resolve => { finish = resolve; });
  const operation = f.button("loadReferences").props.onClick(); f.render();
  f.api.authChanged(); f.render(); finish([]); await operation; f.render();
  assert.deepEqual(f.child().references, []);
});

test("generated canvas references retain archived originals after prompt edits and require an explicit draft save", async () => {
  const f = await setup();
  let reads = 0;
  f.api.coursewareCanvasImageList = async sessionId => {
    reads++; assert.equal(sessionId, "session-a");
    return [
      { intentId: "original", phase: "submitted", current: false, draft: { title: "Original rabbit" }, asset: { sha256: "a".repeat(64), mimeType: "image/png" } },
      { intentId: "jpeg", phase: "submitted", draft: { title: "JPEG reference" }, asset: { sha256: "b".repeat(64), mimeType: "image/jpeg" } },
      { intentId: "webp", phase: "submitted", draft: { title: "Unsupported WebP" }, asset: { sha256: "c".repeat(64), mimeType: "image/webp" } },
      { intentId: "pending", phase: "prepared", draft: { title: "Not submitted" }, asset: { sha256: "d".repeat(64), mimeType: "image/png" } },
      { intentId: "not-archived", phase: "submitted", draft: { title: "No bytes" }, asset: null },
    ];
  };
  assert.equal(reads, 0);
  await f.button("loadReferences").props.onClick(); f.render();
  assert.deepEqual(f.child().references, [
    { assetId: "canvas-image:original", revision: "a".repeat(64), label: "Original rabbit · aaaaaaaaaaaa" },
    { assetId: "canvas-image:jpeg", revision: "b".repeat(64), label: "JPEG reference · bbbbbbbbbbbb" },
  ]);
  assert.equal(f.calls.filter(call => call[0] === "set").length, 0, "Loading references cannot modify a draft or submit generation");
  let document = model.addMediaCanvasDraft(f.child().document, "next", "image", "Next variation");
  document = model.editMediaCanvasDraft(document, "next", 0, { prompt: "Change the rabbit's pose", references: [f.child().references[0]] });
  f.child().onChange(document); await flush(); f.render();
  assert.equal(f.saved.get("session-a").document.drafts[0].references[0].assetId, "canvas-image:original");
  f.button("reload").props.onClick(); f.render(); await flush(); f.render();
  assert.deepEqual(f.child().document.drafts[0].references, document.drafts[0].references);
});

test("late canvas reference reads cannot publish another account or Chat's candidate metadata", async () => {
  for (const changed of ["account", "chat"]) {
    const f = await setup();
    let finish;
    f.api.coursewareCanvasImageList = () => new Promise(resolve => { finish = resolve; });
    const pending = f.button("loadReferences").props.onClick(); f.render();
    if (changed === "account") f.api.authChanged();
    else { f.props.sessionId = "session-b"; f.store.activeSessionId = "session-b"; }
    f.render();
    finish([{ intentId: "private", phase: "submitted", draft: { title: "Private candidate" }, asset: { sha256: "a".repeat(64), mimeType: "image/png" } }]);
    await pending; await flush(); f.render();
    assert.deepEqual(f.child().references, [], changed);
  }
});
