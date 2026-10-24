import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = await readFile(new URL("../src/components/workpanel/CoursewareTeachingPanel.tsx", import.meta.url), "utf8");
const fixture = JSON.parse(await readFile(new URL("../../../packages/shared/src/courseware-contract.fixtures/accepted.json", import.meta.url), "utf8"));
const { outputText } = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
} });

function render({ taskType = "plain", speech = true, locked = false, unsaved = false, enabled = true, recoveryUnavailable = false, sessionId = "chat", result = true, instruction = "", instructionViewId = "view-1", refreshNotice } = {}) {
  const project = structuredClone(fixture.project);
  project.taskType = taskType;
  const page = project.pages[0];
  page.locked = locked;
  page.actions = speech ? [{ id: "speech", type: "speech", text: "Existing narration" }] : [];
  const view = { viewId: "view-1", project, pageId: page.pageId, pageNumber: 1 };
  let index = 0;
  const calls = [], updates = [];
  const effects = [], refreshReads = [];
  const states = [view, unsaved ? [{ id: "draft", type: "speech", text: "Unsaved" }] : page.actions];
  const module = { exports: {} };
  new Function("require", "exports", outputText)((id) => {
    if (id === "react") return { useCallback: (callback) => callback, useEffect: (effect, deps) => effects.push([effect, deps]),
      useRef: (initial) => ({ current: initial === null && !recoveryUnavailable ? { viewId: "view-1", revision: null, serial: 0, failed: false } : initial }), useState: (initial) => {
      const slot = index++;
      const instructionState = initial?.viewId === "" && initial?.text === "";
      return [instructionState ? { viewId: instructionViewId, text: instruction } : slot < states.length ? states[slot] : initial, (value) => updates.push([slot, value])];
    } };
    if (id === "react/jsx-runtime") return require(id);
    if (id === "react-i18next") return { useTranslation: () => ({ t: (key) => key }) };
    if (id === "../../stores/app-store") return { useAppStore: (select) => select({ coursewareTeachingRefresh: refreshNotice, sendPrompt: async (...args) => {
      calls.push(args);
      if (result instanceof Error) throw result;
      return result;
    } }) };
    if (id === "@pi-desktop/shared") return {};
    if (id === "../../lib/api") return { api: {
      async pptEditorTeachingOpen(id) { refreshReads.push(id); return view; },
      async pptEditorTeachingDraftGet() { return { draft: null }; },
    } };
    return new Proxy({}, { get: () => () => null });
  }, module.exports);
  const tree = module.exports.CoursewareTeachingPanel({ sessionId, enabled });
  function find(node) {
    if (!node || typeof node !== "object") return null;
    if (node.type === "button" && String(node.props.children).includes("在主 Chat")) return node;
    return [node.props?.children].flat(Infinity).map(find).find(Boolean);
  }
  return { button: find(tree), calls, updates, page, project, refreshReads,
    refresh: () => effects.find(([, deps]) => refreshNotice && deps?.includes(refreshNotice))?.[0]() };
}

test("Chat adoption invalidation refreshes only the clean, enabled teaching view of its own session", async () => {
  const notice = { sessionId: "chat", teachingRevision: "new-revision" };
  const f = render({ refreshNotice: notice });
  f.refresh(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.refreshReads, ["chat"]);
  f.refresh(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.refreshReads, ["chat"], "An old hint cannot repeatedly reopen a newer manual revision");
  for (const options of [{ unsaved: true }, { enabled: false }, { instruction: "Keep my draft" },
    { refreshNotice: { ...notice, sessionId: "other" } },
    { refreshNotice: { ...notice, teachingRevision: f.project.teachingRevision } }]) {
    const guarded = render({ refreshNotice: notice, ...options });
    guarded.refresh(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(guarded.refreshReads, [], JSON.stringify(options));
  }
});

test("Chat source adoption refreshes clean teaching once, preserving current or drafted views", async () => {
  const notice = { sessionId: "chat", sourceSha256: "f".repeat(64) };
  const f = render({ refreshNotice: notice }); f.refresh(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.refreshReads, ["chat"]);
  f.refresh(); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(f.refreshReads, ["chat"]);
  for (const options of [{ unsaved: true }, { enabled: false }, { instruction: "Keep my draft" },
    { refreshNotice: { ...notice, sessionId: "other" } },
    { refreshNotice: { ...notice, sourceSha256: f.project.source.sha256 } }]) {
    const guarded = render({ refreshNotice: notice, ...options }); guarded.refresh(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(guarded.refreshReads, [], JSON.stringify(options));
  }
});

test("all three paths offer page narration generation and regeneration in the original Chat", async () => {
  for (const taskType of ["plain", "scene", "import"]) for (const speech of [false, true]) {
    const f = render({ taskType, speech });
    assert(f.button);
    assert.equal(f.button.props.disabled, false);
    assert(f.button.props.children.includes(speech ? "重新生成" : "生成本页"));
    await f.button.props.onClick();
    assert.equal(f.calls.length, 1);
    const [prompt, draft, session] = f.calls[0];
    assert.equal(session, "chat"); assert.equal(draft, undefined);
    for (const value of [f.page.pageId, f.project.projectId, f.project.teachingRevision,
      "ppt_get_narration_context", "ppt_propose_page_narration", "不要直接覆盖"]) assert(prompt.includes(value));
    assert.deepEqual(f.page.actions, speech ? [{ id: "speech", type: "speech", text: "Existing narration" }] : []);
  }
});

test("locked, unsaved and unavailable editors cannot submit narration", async () => {
  for (const options of [{ locked: true }, { unsaved: true }, { enabled: false }, { recoveryUnavailable: true }]) {
    const f = render(options);
    assert.equal(f.button.props.disabled, true);
    await f.button.props.onClick();
    assert.equal(f.calls.length, 0);
  }
});

test("Chat rejection and errors are visible and release the busy state", async () => {
  for (const result of [false, new Error("Chat unavailable")]) {
    const f = render({ result });
    await f.button.props.onClick();
    assert(f.updates.some(([, value]) => typeof value === "string" && value.length > 0));
    assert.deepEqual(f.updates.at(-1), [2, false]);
  }
});

test("page-specific requests reach Chat without leaking from a previous view", async () => {
  const instruction = "缩短为三句，加一句 Good job!";
  const current = render({ instruction });
  await current.button.props.onClick();
  assert(current.calls[0][0].includes(instruction));
  const previous = render({ instruction, instructionViewId: "old-view" });
  await previous.button.props.onClick();
  assert(!previous.calls[0][0].includes(instruction));
});

// Exercise the component's public controls and API boundary across renders.
function teachingControls({ actions, locked = false, draftFailure = false, stale = false } = {}) {
  const project = structuredClone(fixture.project);
  project.pages[0].actions = structuredClone(actions);
  project.pages[0].locked = locked;
  const view = { viewId: "view-controls", project, pageId: project.pages[0].pageId, pageNumber: 1 };
  const states = [], refs = [], calls = [];
  let stateIndex = 0, refIndex = 0, enabled = true, draft = null;
  let draftBarrier = Promise.resolve();
  const api = {
    pptEditorTeachingOpen: async () => { calls.push(["open"]); return structuredClone(view); },
    pptEditorTeachingDraftGet: async () => {
      if (draftFailure) throw new Error("Draft storage unavailable");
      return { draft: stale ? { revision: "stale", pageId: view.pageId, baseline: {}, actions: [], instruction: "" } : draft };
    },
    pptEditorTeachingDraftSet: async (viewId, revision, content) => {
      calls.push(["draft", viewId, revision, structuredClone(content)]);
      await draftBarrier;
      draft = content ? { revision: `draft-${calls.length}`, baseline: structuredClone(view.project), pageId: view.pageId, ...content } : null;
      return { draft };
    },
    pptEditorTeachingWrite: async (viewId, revision, next) => {
      calls.push(["write", viewId, revision, structuredClone(next)]);
      view.project.pages[0].actions = structuredClone(next);
      view.project.teachingRevision = "after-controls";
      return structuredClone(view);
    },
  };
  const editorModule = { exports: {} };
  const editor = ts.transpileModule(require("node:fs").readFileSync(new URL("../../../packages/shared/src/courseware-editor.ts", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  new Function("require", "exports", editor)(() => ({}), editorModule.exports);
  const module = { exports: {} };
  new Function("require", "exports", outputText)((id) => {
    if (id === "react") return {
      useCallback: callback => callback, useEffect: () => {},
      useState: initial => {
        const slot = stateIndex++;
        if (!(slot in states)) states[slot] = initial;
        return [states[slot], value => { states[slot] = typeof value === "function" ? value(states[slot]) : value; }];
      },
      useRef: initial => refs[refIndex++] ??= { current: initial },
    };
    if (id === "react/jsx-runtime") return require(id);
    if (id === "react-i18next") return { useTranslation: () => ({ t: key => key }) };
    if (id === "../../stores/app-store") return { useAppStore: select => select({ sendPrompt: async () => true }) };
    if (id === "@pi-desktop/shared") return editorModule.exports;
    if (id === "../../lib/api") return { api };
    return new Proxy({}, { get: () => () => null });
  }, module.exports);
  function nodes() {
    stateIndex = 0; refIndex = 0;
    const found = [];
    function visit(node) {
      if (!node || typeof node !== "object") return;
      found.push(node);
      [node.props?.children].flat(Infinity).forEach(visit);
    }
    visit(module.exports.CoursewareTeachingPanel({ sessionId: "chat", enabled }));
    return found;
  }
  const buttons = key => nodes().filter(node => node.type === "button" && node.props.children === `panel.pptEditor.${key}`);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return {
    calls, view, nodes, buttons,
    pause: () => nodes().filter(node => node.type === "input" && node.props.type === "number"),
    speech: () => nodes().filter(node => node.type === "textarea" && node.props.rows === 5 && !node.props.readOnly),
    load: async () => { buttons("teachingCurrent")[0].props.onClick(); await flush(); },
    flush,
    disable: () => { enabled = false; },
    blockDraft: () => { let release; draftBarrier = new Promise(resolve => { release = resolve; }); return release; },
  };
}

const narratedActions = () => [
  { id: "first", type: "speech", text: "First segment", audioAssetId: "tts-archive", durationMs: 1200,
    voice: "teacher", visualCues: [{ kind: "highlight", target: "object-1" }], pauseAfterMs: 100 },
  { id: "effect", type: "unknown_effect", payload: { preserve: true } },
  { id: "second", type: "speech", text: "Second segment" },
];

const musicClip = () => ({ id: "music-one", type: "audio_clip", audioAssetId: "music-archived-one" });
const musicButton = (f, key) => f.nodes().find(node => node.type === "button" && node.props.children === `panel.canvasMusic.${key}`);

test("independent music clips retain their bytes reference when narration is edited and saved", async () => {
  const clip = musicClip(), actions = [...narratedActions(), clip], f = teachingControls({ actions });
  await f.load();
  assert(f.nodes().some(node => node.props?.["data-teaching-music-clip"] === clip.id));
  f.speech()[0].props.onChange({ target: { value: "Edited narration" } }); await f.flush();
  await f.buttons("teachingSave")[0].props.onClick(); await f.flush();
  const saved = f.calls.find(call => call[0] === "write")[3];
  assert.equal(saved[0].text, "Edited narration");
  assert.deepEqual(saved.at(-1), clip);
  assert.deepEqual(saved.slice(1), actions.slice(1));
});

test("music clip reorder and deletion use the existing durable teaching draft and save controls", async () => {
  const clip = musicClip(), actions = [...narratedActions(), clip], f = teachingControls({ actions });
  await f.load();
  assert.equal(musicButton(f, "moveDown").props.disabled, true);
  musicButton(f, "moveUp").props.onClick(); await f.flush();
  const reordered = f.calls.filter(call => call[0] === "draft").at(-1)[3].actions;
  assert.deepEqual(reordered.map(action => action.id), ["first", "effect", clip.id, "second"]);
  assert.deepEqual(reordered.filter(action => action.type !== "audio_clip"), actions.filter(action => action.type !== "audio_clip"));
  await f.buttons("teachingSave")[0].props.onClick(); await f.flush();
  assert.deepEqual(f.calls.find(call => call[0] === "write")[3], reordered);
  musicButton(f, "removeClip").props.onClick(); await f.flush();
  await f.buttons("teachingSave")[0].props.onClick(); await f.flush();
  assert.deepEqual(f.calls.filter(call => call[0] === "write").at(-1)[3], narratedActions());
});

test("locked and disabled teaching pages cannot reorder or remove their independent music", async () => {
  for (const locked of [false, true]) {
    const f = teachingControls({ actions: [...narratedActions(), musicClip()], locked }); await f.load();
    if (!locked) f.disable();
    for (const key of ["moveUp", "moveDown", "removeClip"]) {
      const button = musicButton(f, key); assert.equal(button.props.disabled, true); button.props.onClick();
    }
    await f.flush(); assert.equal(f.calls.some(call => call[0] === "draft" || call[0] === "write"), false);
  }
});

test("pause edits preserve narration/audio/effects and save through the serial draft and teaching APIs", async () => {
  const actions = narratedActions(), f = teachingControls({ actions });
  await f.load();
  const input = f.pause()[0];
  assert(input, "The speech segment needs a visible pause editor");
  assert.equal(input.props.min, 0); assert.equal(input.props.max, 30000); assert.equal(input.props.step, 1);
  const release = f.blockDraft();
  input.props.onChange({ target: { value: "800", valueAsNumber: 800 } });
  const save = f.buttons("teachingSave")[0];
  assert.equal(save.props.disabled, false);
  const saving = save.props.onClick();
  await f.flush();
  assert(!f.calls.some(([method]) => method === "write"), "Save must await draft acknowledgement");
  assert.equal(f.pause()[0].props.disabled, true);
  assert.equal(f.buttons("teachingAddCheckpoint")[0].props.disabled, true);
  release(); await saving; await f.flush();
  const write = f.calls.find(([method]) => method === "write");
  assert(write);
  assert.equal(write[2], fixture.project.teachingRevision);
  assert.deepEqual(write[3], [{ ...actions[0], pauseAfterMs: 800 }, ...actions.slice(1)]);
  assert.deepEqual(f.calls.find(([method]) => method === "draft")[3].actions, write[3]);
  assert.equal(f.buttons("teachingSave")[0].props.disabled, true);
});

test("teacher waits insert after the selected speech and only supported checkpoints can be removed", async () => {
  const actions = [...narratedActions(),
    { id: "question", type: "interaction_checkpoint", checkpointId: "question", checkpointKind: "question", question: "Keep?" },
    { id: "extended", type: "interaction_checkpoint", checkpointId: "extended", checkpointKind: "teacher_continue", extraEffect: "keep" },
    { id: "existing", type: "interaction_checkpoint", checkpointId: "existing", checkpointKind: "teacher_continue" },
  ];
  const f = teachingControls({ actions }); await f.load();
  assert.equal(f.buttons("teachingAddCheckpoint").length, 2);
  assert.equal(f.buttons("teachingRemoveCheckpoint").length, 1);
  f.buttons("teachingAddCheckpoint")[0].props.onClick(); await f.flush();
  const firstDraft = f.calls.find(([method]) => method === "draft")[3].actions;
  assert.deepEqual(firstDraft[0], actions[0]);
  const checkpoint = firstDraft[1];
  assert.equal(checkpoint.type, "interaction_checkpoint"); assert.equal(checkpoint.checkpointKind, "teacher_continue");
  assert.equal(checkpoint.id, checkpoint.checkpointId);
  assert.deepEqual(firstDraft.slice(2), actions.slice(1));
  assert.equal(f.buttons("teachingRemoveCheckpoint").length, 2);
  f.buttons("teachingRemoveCheckpoint")[0].props.onClick(); await f.flush();
  assert.equal(f.calls.filter(([method]) => method === "draft").at(-1)[3], null, "Removing the added wait restores the baseline and clears its draft");
  f.buttons("teachingAddCheckpoint")[1].props.onClick(); await f.flush();
  const lastDraft = f.calls.filter(([method]) => method === "draft").at(-1)[3].actions;
  assert.deepEqual(lastDraft.slice(0, 3), actions.slice(0, 3));
  assert.equal(lastDraft[3].checkpointKind, "teacher_continue");
  assert.deepEqual(lastDraft.slice(4), actions.slice(3));
  f.buttons("teachingRemoveCheckpoint")[1].props.onClick(); await f.flush();
  f.buttons("teachingSave")[0].props.onClick(); await f.flush();
  assert.deepEqual(f.calls.find(([method]) => method === "write")[3], lastDraft.filter(action => action.id !== "existing"));
});

test("pause limits reject blank, fractional and out-of-range values while accepting both bounds", async () => {
  const f = teachingControls({ actions: narratedActions() }); await f.load();
  assert(f.pause()[0]);
  for (const value of ["", "-1", "1.5", "30001"]) {
    f.pause()[0].props.onChange({ target: { value, valueAsNumber: value === "" ? NaN : Number(value) } });
  }
  await f.flush(); assert(!f.calls.some(([method]) => method === "draft"));
  for (const value of [0, 30000]) {
    f.pause()[0].props.onChange({ target: { value: String(value), valueAsNumber: value } }); await f.flush();
    assert.equal(f.calls.filter(([method]) => method === "draft").at(-1)[3].actions[0].pauseAfterMs, value);
  }
});

test("timing and wait controls retain page lock, editor and draft recovery gates", async () => {
  for (const options of [{ locked: true }, { draftFailure: true }, { stale: true }, { disabled: true }]) {
    const actions = [...narratedActions(), { id: "wait", type: "interaction_checkpoint", checkpointId: "wait", checkpointKind: "teacher_continue" }];
    const f = teachingControls({ actions, ...options }); await f.load();
    if (options.disabled) f.disable();
    const pause = f.pause()[0], add = f.buttons("teachingAddCheckpoint")[0], remove = f.buttons("teachingRemoveCheckpoint")[0];
    assert(pause && add && remove);
    for (const control of [pause, add, remove]) assert.equal(control.props.disabled, true);
    pause.props.onChange({ target: { value: "500", valueAsNumber: 500 } }); add.props.onClick(); remove.props.onClick();
    await f.flush(); assert(!f.calls.some(([method]) => method === "draft"));
  }
});

test("speech replacement still uses the existing audio invalidation helper", async () => {
  const actions = narratedActions(), f = teachingControls({ actions }); await f.load();
  f.speech()[0].props.onChange({ target: { value: "Revised narration" } }); await f.flush();
  const next = f.calls.find(([method]) => method === "draft")[3].actions;
  assert.equal(next[0].text, "Revised narration"); assert.equal(next[0].pauseAfterMs, 100);
  for (const key of ["audioAssetId", "durationMs", "visualCues"]) assert(!Object.hasOwn(next[0], key));
  assert.deepEqual(next.slice(1), actions.slice(1));
});

test("saving a timing draft refuses a changed teaching baseline and retains the draft", async () => {
  const f = teachingControls({ actions: narratedActions() }); await f.load();
  f.pause()[0].props.onChange({ target: { value: "500", valueAsNumber: 500 } }); await f.flush();
  f.view.project.teachingRevision = "changed-elsewhere";
  f.buttons("teachingSave")[0].props.onClick(); await f.flush();
  assert(!f.calls.some(([method]) => method === "write"));
  assert(f.nodes().some(node => node.props?.role === "alert" && String(node.props.children).includes("Teaching changed")));
  assert.equal(f.pause()[0].props.value, 500);
  assert.equal(f.calls.filter(([method]) => method === "draft").length, 1);
});
