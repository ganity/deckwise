import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/components/workpanel/CoursewareCanvasMusic.tsx", import.meta.url), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture() {
  const hooks = [], effects = [], calls = [], records = new Map();
  let cursor = 0, tree, authChanged;
  const draft = { id: "song", revision: 2, kind: "music", title: "Counting song", prompt: " One, two, three! ", references: [], x: 0, y: 0 };
  const props = { sessionId: "session-a", revision: "canvas-v1", disabled: false,
    document: { projectId: "project-a", drafts: [draft, { ...draft, id: "picture", kind: "image" }] } };
  const teaching = { viewId: "reviewed-page", pageId: "page-2", pageNumber: 2, project: { projectId: "office-project", title: "Counting lesson",
    teachingRevision: "teaching-1", source: { revision: "source-1", sha256: "c".repeat(64) },
    pages: [{ pageId: "page-2", locked: false, reviewState: "ready", actions: [{ id: "speech-1", type: "speech", text: "Keep this narration" }] }] } };
  const api = {
    onAuthChanged(listener) { authChanged = listener; return () => {}; },
    async coursewareCanvasMusicModels() { calls.push(["models"]); return { generation: [{ model: "song-model" }], export: [{ model: "export-model" }] }; },
    async coursewareCanvasMusicList() { calls.push(["list"]); return [...records.values()]; },
    async coursewareCanvasMusicPrepare(request) {
      calls.push(["prepare", request]); const value = { intentId: request.intentId, model: request.model, operation: "music",
        draft: structuredClone(draft), music: request.music, current: true, phase: "prepared", task: null, candidates: [], previews: [], asset: null };
      records.set(value.intentId, value); return value;
    },
    async coursewareCanvasMusicExportPrepare(request) {
      calls.push(["exportPrepare", request]); const source = records.get(request.intentId);
      const value = { ...source, intentId: request.exportIntentId, model: request.model, operation: "music-export", phase: "prepared", task: null,
        sourceIntentId: source.intentId, candidateId: request.candidateId, candidates: [], music: undefined };
      records.set(value.intentId, value); return value;
    },
    async coursewareCanvasMusicQuote(sessionId, intentId) {
      calls.push(["quote", sessionId, intentId]); return quote(intentId);
    },
    async coursewareCanvasMusicExportQuote(sessionId, intentId) {
      calls.push(["exportQuote", sessionId, intentId]); return quote(intentId);
    },
    async coursewareCanvasMusicSubmitConfirmed(sessionId, intentId, quoteId) {
      calls.push(["submit", sessionId, intentId, quoteId]); return submit(intentId);
    },
    async coursewareCanvasMusicExportSubmitConfirmed(sessionId, intentId, quoteId) {
      calls.push(["exportSubmit", sessionId, intentId, quoteId]); return submit(intentId);
    },
    async coursewareCanvasMusicStatus(sessionId, intentId) { calls.push(["status", sessionId, intentId]); return records.get(intentId); },
    async coursewareCanvasMusicExportStatus(sessionId, intentId) { calls.push(["exportStatus", sessionId, intentId]); return records.get(intentId); },
    async coursewareCanvasMusicPreview(sessionId, intentId, candidateId) {
      calls.push(["preview", sessionId, intentId, candidateId]); return { intentId, candidateId,
        asset: { sha256: "a".repeat(64), mimeType: "audio/mpeg", byteLength: 8 }, dataUrl: "data:audio/mpeg;base64,SUQzYXVkaW8=" };
    },
    async coursewareCanvasMusicExportArchive(sessionId, intentId) {
      calls.push(["archive", sessionId, intentId]); return { intentId,
        asset: { sha256: "b".repeat(64), mimeType: "audio/mpeg", byteLength: 8 }, dataUrl: "data:audio/mpeg;base64,SUQzYXVkaW8=" };
    },
    async pptEditorTeachingOpen(sessionId) { calls.push(["openTeaching", sessionId]); return structuredClone(teaching); },
    async coursewareCanvasMusicAdopt(request) {
      calls.push(["adopt", request]);
      const next = structuredClone(teaching); next.project.teachingRevision = "teaching-2";
      next.project.pages[0].actions.push({ id: "music-clip", type: "audio_clip", audioAssetId: "music-asset" }); return next;
    },
  };
  const quote = intentId => ({ quoteId: "quote-" + intentId, intentId, model: records.get(intentId).model, maxPoints: 12, maxChars: 4000, expiresAt: "2099-01-01T00:00:00Z" });
  const submit = intentId => {
    const value = { ...records.get(intentId), phase: "submitted", task: { state: "running", feeState: "reserved", reservedPoints: 12, actualPoints: null, errorCode: null } };
    records.set(intentId, value); return value;
  };
  const exports = {};
  new Function("require", "exports", output)(id => {
    if (id === "../../lib/api") return { api };
    if (id === "react-i18next") return { useTranslation: () => ({ t: (key, values) => key + (values ? " " + JSON.stringify(values) : "") }) };
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
  const render = () => { cursor = 0; tree = exports.CoursewareCanvasMusic(props); while (effects.length) effects.shift()(); };
  const nodes = (root = tree) => { const all = []; const visit = value => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return; all.push(value); visit(value.props?.children);
  }; visit(root); return all; };
  const settle = async () => { await flush(); render(); render(); };
  const button = (key, root) => nodes(root).find(node => node.type === "button" && node.props.children === "panel.canvasMusic." + key);
  const click = async (key, root) => { const value = button(key, root); assert(value, key); assert.equal(!!value.props.disabled, false, key); value.props.onClick(); await settle(); };
  const field = key => nodes().find(node => node.type === "label" && node.props.children[0] === "panel.canvasMusic." + key)?.props.children[1];
  const change = (key, value) => { const node = field(key); assert(node, key); node.props.onChange({ target: { value } }); render(); render(); };
  const consent = () => { const node = nodes().find(node => node.type === "label" && node.props.children[1] === "panel.canvasMusic.confirm" ||
    node.type === "label" && node.props.children[1] === "panel.canvasMusic.exportConfirm");
    assert(node); node.props.children[0].props.onChange({ target: { checked: true } }); render(); };
  const select = async () => { await click("models"); change("draft", "song"); change("model", "song-model"); change("exportModel", "export-model"); };
  const seedReady = () => {
    const value = { intentId: "original", draft: structuredClone(draft), model: "song-model", music: { title: draft.title, tags: "gentle" },
      operation: "music", current: false, phase: "submitted", candidates: [
        { candidateId: "candidate-1", order: 0, state: "completed", durationMs: 10_000, exportable: true },
        { candidateId: "candidate-2", order: 1, state: "failed", exportable: false },
        { candidateId: "candidate-3", order: 2, state: "completed", durationMs: 12_000, exportable: true },
      ], previews: [], asset: null, task: { state: "ready", feeState: "settled", reservedPoints: 12, actualPoints: 8, errorCode: null } };
    records.set(value.intentId, value); return value;
  };
  render(); render();
  return { props, draft, teaching, calls, records, api, nodes, button, click, field, change, consent, select, render, settle, seedReady,
    authChanged() { authChanged(); render(); render(); } };
}

test("saved lyrics and separate styles freeze in a quoted attempt; every generation needs explicit consent", async () => {
  const f = fixture(); await f.select();
  assert.equal(f.nodes(f.field("draft")).filter(node => node.type === "option").length, 2);
  f.change("tags", "playful piano"); f.change("negativeTags", "heavy metal");
  await f.click("quote");
  const request = f.calls.find(call => call[0] === "prepare")[1];
  assert.deepEqual({ ...request, intentId: "new-attempt" }, { sessionId: "session-a", intentId: "new-attempt", draftId: "song",
    expectedRevision: "canvas-v1", expectedDraftRevision: 2, model: "song-model", music: {
      title: "Counting song", tags: "playful piano", negativeTags: "heavy metal", instrumental: false } });
  assert(f.nodes().some(node => node.type === "textarea" && node.props.value === f.draft.prompt));
  assert.equal(f.button("submit").props.disabled, true);
  f.button("submit").props.onClick(); await f.settle(); assert.equal(f.calls.some(call => call[0] === "submit"), false);
  f.consent(); await f.click("submit"); assert.equal(f.calls.filter(call => call[0] === "submit").length, 1);
  await f.click("quote"); assert.equal(f.button("submit").props.disabled, true);
  assert.notEqual(f.calls.filter(call => call[0] === "prepare").at(-1)[1].intentId, request.intentId);
});

test("all candidates stay ordered; listening has no quote or export side effect; MP3 export requires separate consent", async () => {
  const f = fixture(); await f.select(); f.seedReady(); await f.click("refresh");
  const candidates = () => f.nodes().filter(node => node.props?.["data-music-candidate"]);
  assert.deepEqual(candidates().map(node => node.props["data-music-candidate"]), ["candidate-1", "candidate-2", "candidate-3"]);
  assert.equal(f.button("listen", candidates()[1]).props.disabled, true);
  await f.click("listen", candidates()[2]);
  assert.deepEqual(f.calls.at(-1), ["preview", "session-a", "original", "candidate-3"]);
  assert.equal(f.calls.some(call => ["prepare", "quote", "exportPrepare", "exportQuote", "exportSubmit"].includes(call[0])), false);
  assert.equal(f.nodes().filter(node => node.type === "audio").length, 1);
  await f.click("prepareExport", candidates()[2]);
  const request = f.calls.find(call => call[0] === "exportPrepare")[1];
  assert.deepEqual({ ...request, exportIntentId: "export-attempt" }, { sessionId: "session-a", intentId: "original",
    exportIntentId: "export-attempt", candidateId: "candidate-3", model: "export-model" });
  assert.equal(f.button("exportSubmit").props.disabled, true); assert.equal(f.calls.some(call => call[0] === "exportSubmit"), false);
  f.consent(); await f.click("exportSubmit"); assert.equal(f.calls.filter(call => call[0] === "exportSubmit").length, 1);
  const row = f.records.get(request.exportIntentId); row.task.state = "ready"; row.task.feeState = "settled";
  await f.click("refresh"); await f.click("archive");
  assert.deepEqual(f.calls.at(-1), ["archive", "session-a", request.exportIntentId]);
});

test("uncertain generation cannot dispatch again and recovers only through original task status", async () => {
  const f = fixture(); await f.select(); await f.click("quote"); f.consent();
  f.api.coursewareCanvasMusicSubmitConfirmed = async () => { throw new Error("Lost accepted reply"); };
  f.api.coursewareCanvasMusicList = async () => { throw new Error("Read unavailable"); };
  await f.click("submit");
  assert.equal(f.button("quote").props.disabled, true);
  const intent = f.calls.find(call => call[0] === "prepare")[1].intentId;
  f.api.coursewareCanvasMusicStatus = async (session, id) => { f.calls.push(["status", session, id]); return { ...f.records.get(id), phase: "submitted" }; };
  await f.click("status"); assert.deepEqual(f.calls.at(-1), ["status", "session-a", intent]);
  assert.equal(f.calls.filter(call => call[0] === "prepare").length, 1);
});

test("uncertain export preserves its original candidate and cannot prepare another export until resolved", async () => {
  const f = fixture(); await f.select(); f.seedReady(); await f.click("refresh");
  await f.click("prepareExport"); f.consent();
  f.api.coursewareCanvasMusicExportSubmitConfirmed = async () => { throw new Error("Lost export reply"); };
  f.api.coursewareCanvasMusicList = async () => { throw new Error("Read unavailable"); };
  await f.click("exportSubmit");
  assert.equal(f.button("prepareExport").props.disabled, true);
  const request = f.calls.find(call => call[0] === "exportPrepare")[1];
  const row = f.nodes().find(node => node.props?.["data-music-export-intent"] === request.exportIntentId);
  f.button("status", row).props.onClick(); await f.settle();
  assert.deepEqual(f.calls.at(-1), ["exportStatus", "session-a", request.exportIntentId]);
  assert.equal(f.calls.filter(call => call[0] === "exportPrepare").length, 1);
});

test("archived candidates and exported audio stay playable after restart without a live task-status request", async () => {
  const f = fixture(); const original = f.seedReady(); original.task = null;
  original.previews = [{ candidateId: "candidate-1", asset: { sha256: "a".repeat(64), mimeType: "audio/mpeg", byteLength: 8 } }];
  f.records.set("archived-export", { ...original, intentId: "archived-export", operation: "music-export", sourceIntentId: "original",
    candidateId: "candidate-1", candidates: [], previews: [], asset: { sha256: "b".repeat(64), mimeType: "audio/mpeg", byteLength: 8 } });
  await f.click("refresh"); await f.click("listen"); await f.click("archive");
  assert.deepEqual(f.calls.map(call => call[0]), ["list", "preview", "archive"]);
  assert.equal(f.nodes().filter(node => node.type === "audio").length, 2);
});

test("a completed exportable historical candidate can request a new export quote after List-only recovery", async () => {
  const f = fixture(); await f.select(); const original = f.seedReady(); original.task = null;
  await f.click("refresh"); await f.click("prepareExport");
  assert.equal(f.calls.filter(call => call[0] === "exportPrepare").length, 1);
  assert.equal(f.calls.filter(call => call[0] === "exportQuote").length, 1);
  assert.equal(f.calls.some(call => ["status", "submit", "exportSubmit"].includes(call[0])), false);
  assert.equal(f.button("exportSubmit").props.disabled, true);
});

test("expired and mismatched quotes never show a confirmation action", async () => {
  for (const override of [{ expiresAt: "2000-01-01T00:00:00Z" }, { intentId: "different-attempt" }, { model: "different-model" }]) {
    const f = fixture(); await f.select(); const original = f.api.coursewareCanvasMusicQuote;
    f.api.coursewareCanvasMusicQuote = async (...args) => ({ ...await original(...args), ...override });
    await f.click("quote");
    assert.equal(f.button("submit"), undefined);
    assert.equal(f.calls.some(call => call[0] === "submit"), false);
  }
});

test("changing style, source, account or session invalidates cost consent and ignores late private audio", async () => {
  const f = fixture(); await f.select(); await f.click("quote"); f.consent();
  f.change("tags", "different style"); assert.equal(f.button("submit"), undefined);
  await f.click("quote"); f.consent(); f.draft.prompt = "Edited lyrics"; f.draft.revision++; f.render(); f.render();
  assert.equal(f.button("submit"), undefined);
  f.seedReady(); await f.click("refresh");
  const late = deferred(); f.api.coursewareCanvasMusicPreview = () => late.promise;
  f.button("listen").props.onClick(); f.render(); f.authChanged();
  late.resolve({ intentId: "original", candidateId: "candidate-1", asset: { mimeType: "audio/mpeg" }, dataUrl: "data:audio/mpeg;base64,SUQzYXVkaW8=" });
  await f.settle(); assert.equal(f.nodes().some(node => node.type === "audio"), false);
  assert.equal(f.nodes().some(node => node.props?.["data-canvas-music-intent"]), false);
  assert.equal(f.field("model").props.value, "");
  f.props.sessionId = "session-b"; f.render(); f.render(); assert.equal(f.nodes().some(node => node.type === "audio"), false);
});

test("invalid drafts and foreign preview responses fail closed without truncation or dispatch", async () => {
  const f = fixture(); await f.select(); f.draft.references = [{ assetId: "image", revision: "a", label: "Image" }]; f.render(); f.render();
  assert.equal(f.button("quote").props.disabled, true);
  f.draft.references = []; f.draft.prompt = " "; f.render(); f.render(); assert.equal(f.button("quote").props.disabled, true);
  f.nodes().find(node => node.type === "label" && node.props.children[1] === "panel.canvasMusic.instrumental").props.children[0].props.onChange({ target: { checked: true } });
  f.render(); f.render(); assert.equal(f.button("quote").props.disabled, false);
  f.draft.title = "x".repeat(101); f.render(); f.render(); assert.equal(f.button("quote").props.disabled, true);
  f.draft.title = "Song"; f.draft.prompt = "x".repeat(4001); f.render(); f.render(); assert.equal(f.button("quote").props.disabled, true);
  assert.equal(f.calls.some(call => call[0] === "prepare"), false);
  f.seedReady(); await f.click("refresh");
  f.api.coursewareCanvasMusicPreview = async () => ({ intentId: "foreign", candidateId: "candidate-1", asset: { mimeType: "audio/mpeg" }, dataUrl: "https://foreign/audio.mp3" });
  await f.click("listen"); assert.equal(f.nodes().some(node => node.type === "audio"), false);
  assert(f.nodes().some(node => node.props?.role === "alert" && String(node.props.children).includes("invalidPreview")));
});

function seedExport(f, archived = true) {
  const original = f.seedReady();
  const exported = { ...original, intentId: "exported-song", operation: "music-export", sourceIntentId: original.intentId,
    candidateId: "candidate-1", candidates: [], previews: [],
    asset: archived ? { sha256: "b".repeat(64), mimeType: "audio/mpeg", byteLength: 8 } : null };
  f.records.set(exported.intentId, exported); return exported;
}

test("only an archived export can review a target; explicit confirmation appends to its frozen teaching page without billing", async () => {
  const f = fixture(); seedExport(f, false); await f.click("refresh");
  assert.equal(f.button("adoptReview").props.disabled, true);
  assert.equal(f.nodes().filter(node => node.type === "button" && node.props.children === "panel.canvasMusic.adoptReview").length, 1);
  await f.click("archive");
  assert.equal(f.button("adoptReview").props.disabled, false);
  await f.click("adoptReview");
  assert.equal(f.calls.some(call => call[0] === "adopt"), false);
  assert(f.nodes().some(node => node.type === "p" && String(node.props.children).includes('"title":"Counting lesson","page":2')));
  const reviewed = structuredClone(f.teaching);
  f.teaching.pageNumber = 3; f.teaching.project.teachingRevision = "teaching-changed";
  f.api.coursewareCanvasMusicAdopt = async request => { f.calls.push(["adopt", request]); return { ...reviewed,
    project: { ...reviewed.project, teachingRevision: "teaching-2" } }; };
  await f.click("adoptConfirm");
  assert.deepEqual(f.calls.find(call => call[0] === "adopt")[1], { sessionId: "session-a", intentId: "exported-song",
    viewId: "reviewed-page", expectedTeachingRevision: "teaching-1" });
  assert.equal(f.calls.some(call => ["quote", "prepare", "submit", "exportQuote", "exportSubmit", "exportPrepare"].includes(call[0])), false);
  assert.deepEqual(f.teaching.project.pages[0].actions, [{ id: "speech-1", type: "speech", text: "Keep this narration" }]);
  assert.equal(f.button("adoptConfirm"), undefined);
  assert(f.nodes().some(node => node.props?.role === "status" && String(node.props.children).includes("panel.canvasMusic.adopted")));
});

test("a stale adoption fails visibly and requires another explicit page review before any retry", async () => {
  const f = fixture(); seedExport(f); await f.click("refresh"); await f.click("adoptReview");
  f.api.coursewareCanvasMusicAdopt = async request => { f.calls.push(["adopt", request]); throw new Error("Teaching changed; review current page"); };
  await f.click("adoptConfirm");
  assert.equal(f.button("adoptConfirm"), undefined);
  assert(f.nodes().some(node => node.props?.role === "alert" && String(node.props.children).includes("Teaching changed")));
  assert.equal(f.calls.filter(call => call[0] === "adopt").length, 1);
  await f.click("adoptReview"); await f.click("adoptCancel");
  assert.equal(f.button("adoptConfirm"), undefined);
  assert.equal(f.calls.filter(call => call[0] === "adopt").length, 1);
});

test("locked target, changed canvas or session and late page reads cannot authorize adoption", async () => {
  const f = fixture(); seedExport(f); await f.click("refresh");
  f.teaching.project.pages[0].locked = true; await f.click("adoptReview");
  assert.equal(f.button("adoptConfirm"), undefined);
  assert(f.nodes().some(node => node.props?.role === "alert" && String(node.props.children).includes("adoptInvalid")));
  f.teaching.project.pages[0].locked = false; await f.click("adoptReview");
  f.props.revision = "canvas-v2"; f.render(); f.render(); assert.equal(f.button("adoptConfirm"), undefined);
  const late = deferred(); f.api.pptEditorTeachingOpen = () => late.promise;
  f.button("adoptReview").props.onClick(); f.render();
  f.props.sessionId = "session-b"; f.render(); f.render();
  late.resolve(structuredClone(f.teaching)); await f.settle();
  assert.equal(f.button("adoptConfirm"), undefined);
  assert.equal(f.calls.some(call => call[0] === "adopt"), false);
});

test("late adoption success is not shown after an account change", async () => {
  const f = fixture(); seedExport(f); await f.click("refresh"); await f.click("adoptReview");
  const late = deferred(); f.api.coursewareCanvasMusicAdopt = () => late.promise;
  f.button("adoptConfirm").props.onClick(); f.render(); f.authChanged();
  late.resolve(structuredClone(f.teaching)); await f.settle();
  assert.equal(f.nodes().some(node => node.props?.role === "status" && String(node.props.children).includes("panel.canvasMusic.adopted")), false);
  assert.equal(f.button("adoptConfirm"), undefined);
});
