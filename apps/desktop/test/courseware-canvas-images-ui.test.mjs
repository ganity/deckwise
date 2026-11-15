import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/components/workpanel/CoursewareCanvasImages.tsx", import.meta.url), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const hostDraft = draft => ({ id: draft.id, kind: draft.kind, prompt: draft.prompt,
  references: draft.references.map(reference => ({ assetId: reference.assetId, label: reference.label, revision: reference.revision })),
  revision: draft.revision, title: draft.title, x: draft.x, y: draft.y });

function fixture() {
  const hooks = [], pending = [], calls = [], records = new Map();
  let cursor = 0, tree, authChanged;
  const draft = { id: "draft-a", revision: 2, kind: "image", title: "Rabbit", prompt: "  Exact saved prompt\nwith whitespace  ",
    references: [{ assetId: "private-reference", revision: "a".repeat(64), label: "Private reference" }], x: 0, y: 0 };
  const props = { sessionId: "session-a", revision: "saved-1", disabled: false,
    document: { version: 1, projectId: "project-a", revision: 4, viewport: { x: 0, y: 0, zoom: 1 },
      drafts: [draft, { ...draft, id: "draft-b", title: "Another rabbit" }, { ...draft, id: "video", kind: "video" }] } };
  const api = {
    onAuthChanged(listener) { authChanged = listener; return () => { authChanged = undefined; }; },
    async coursewareCanvasImageModels() { return [{ model: "image-model", supportsReferenceImage: true }, { model: "text-model" }]; },
    async coursewareCanvasImageList(sessionId) { calls.push(["list", sessionId]); return [...records.values()]; },
    async coursewareCanvasImagePrepare(request) {
      calls.push(["prepare", request]);
      const intent = { intentId: request.intentId, model: request.model, current: true, phase: "prepared", task: null,
        draft: structuredClone(props.document.drafts.find(value => value.id === request.draftId)) };
      records.set(intent.intentId, intent); return intent;
    },
    async coursewareCanvasImageQuote(sessionId, intentId) {
      calls.push(["quote", sessionId, intentId]);
      return { quoteId: "quote-" + intentId, intentId, model: records.get(intentId).model,
        maxPoints: 7, maxChars: 4000, expiresAt: "2099-01-01T00:00:00Z" };
    },
    async coursewareCanvasImageSubmitConfirmed(sessionId, intentId, quoteId) {
      calls.push(["submit", sessionId, intentId, quoteId]);
      const intent = { ...records.get(intentId), phase: "submitted", task: {
        state: "RUNNING", feeState: "RESERVED", reservedPoints: 7, actualPoints: null, errorCode: null } };
      records.set(intentId, intent); return intent;
    },
    async coursewareCanvasImageStatus(sessionId, intentId) { calls.push(["status", sessionId, intentId]); return records.get(intentId); },
    async coursewareCanvasImageReferencePreview(sessionId, intentId) {
      calls.push(["referencePreview", sessionId, intentId]);
      return { intentId, reference: structuredClone(records.get(intentId).draft.references[0]), dataUrl: "data:image/png;base64,cmVmZXJlbmNl" };
    },
    async coursewareCanvasImageArchive(sessionId, intentId) {
      calls.push(["archive", sessionId, intentId]);
      const image = { ...records.get(intentId), asset: { sha256: "b".repeat(64), mimeType: "image/png", byteLength: 128, width: 64, height: 32 } };
      records.set(intentId, image); return { image, dataUrl: "data:image/png;base64,Y2FuZGlkYXRl" };
    },
    async coursewareCanvasImagePreview(sessionId, intentId) {
      calls.push(["preview", sessionId, intentId]);
      return { image: records.get(intentId), dataUrl: "data:image/png;base64,Y2FuZGlkYXRl" };
    },
    async coursewareCanvasImageRestore(sessionId, intentId) {
      calls.push(["restore", sessionId, intentId]);
      return { image: records.get(intentId), dataUrl: "data:image/png;base64,Y2FuZGlkYXRl" };
    },
  };
  const exports = {};
  new Function("require", "exports", output)(id => {
    if (id === "../../lib/api") return { api };
    if (id === "react-i18next") return { useTranslation: () => ({ t: (key, values) => key + (values ? " " + JSON.stringify(values) : "") }) };
    if (id === "react") return {
      useState(initial) { const index = cursor++; if (!(index in hooks)) hooks[index] = initial;
        return [hooks[index], value => { hooks[index] = typeof value === "function" ? value(hooks[index]) : value; }]; },
      useRef(initial) { const index = cursor++; return hooks[index] ??= { current: initial }; },
      useEffect(effect, dependencies) {
        const index = cursor++, previous = hooks[index];
        if (!previous || dependencies.some((value, i) => value !== previous.dependencies[i])) {
          pending.push(() => { previous?.cleanup?.(); hooks[index] = { dependencies, cleanup: effect() }; });
        }
      },
    };
    assert.equal(id, "react/jsx-runtime");
    return { jsx: (type, properties) => ({ type, props: properties }), jsxs: (type, properties) => ({ type, props: properties }) };
  }, exports);
  const render = () => { cursor = 0; tree = exports.CoursewareCanvasImages(props); while (pending.length) pending.shift()(); };
  const nodes = (root = tree) => { const all = []; const visit = value => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return; all.push(value); visit(value.props?.children);
  }; visit(root); return all; };
  const button = key => nodes().find(node => node.type === "button" && node.props.children === "panel.canvasImages." + key);
  const settle = async () => { await flush(); render(); render(); };
  const click = async key => { const node = button(key); assert(node, key); assert.equal(!!node.props.disabled, false, key);
    node.props.onClick(); await settle(); };
  const choose = (index, value) => { nodes().filter(node => node.type === "select")[index].props.onChange({ target: { value } }); render(); render(); };
  const consent = () => { const input = nodes().find(node => node.type === "input" && node.props.type === "checkbox");
    assert(input); input.props.onChange({ target: { checked: true } }); render(); };
  const select = async () => { await click("models"); choose(0, "draft-a"); choose(1, "image-model"); };
  render(); render();
  const row = intentId => nodes().find(node => node.props?.["data-canvas-image-intent"] === intentId);
  const rowButton = (intentId, key) => nodes(row(intentId)).find(node => node.type === "button" && node.props.children === "panel.canvasImages." + key);
  const compare = async intentId => {
    const input = nodes(row(intentId)).find(node => node.type === "input" && node.props.type === "checkbox");
    assert(input, intentId); assert.equal(!!input.props.disabled, false, intentId);
    input.props.onChange(); await settle();
  };
  const seedArchived = (intentId, overrides = {}) => {
    const image = { intentId, draft: { ...structuredClone(draft), id: "deleted-" + intentId, title: "Archived " + intentId,
      prompt: "Original " + intentId, revision: 1 }, model: "original-model-" + intentId, current: false, phase: "submitted", task: null,
      asset: { sha256: "b".repeat(64), mimeType: "image/png", byteLength: 128, width: 64, height: 32 }, ...overrides };
    records.set(intentId, image); return image;
  };
  return { props, draft, api, calls, records, nodes, button, row, rowButton, compare, seedArchived, render, settle, click, choose, consent, select,
    authChanged: () => { authChanged(); render(); render(); },
    unmount: () => hooks.forEach(value => value?.cleanup?.()),
  };
}

test("archive restore is an explicit original-task action without generation or implicit preview download", async () => {
  const f = fixture(), image = f.seedArchived("historical");
  await f.click("refresh");
  assert.equal(f.calls.filter(call => call[0] === "restore").length, 0);
  f.api.coursewareCanvasImagePreview = async () => { throw new Error("Missing local archive"); };
  f.rowButton(image.intentId, "preview").props.onClick(); await f.settle();
  assert.equal(f.calls.filter(call => call[0] === "restore").length, 0);
  assert(f.nodes().some(node => node.props?.role === "alert" && String(node.props.children).includes("Missing local archive")));
  const action = f.rowButton(image.intentId, "restore"); assert(action); assert.equal(!!action.props.disabled, false);
  action.props.onClick(); await f.settle();
  assert.deepEqual(f.calls.filter(call => call[0] === "restore"), [["restore", "session-a", image.intentId]]);
  assert(f.nodes(f.row(image.intentId)).some(node => node.type === "img"));
  assert.equal(f.calls.filter(call => ["prepare", "quote", "submit"].includes(call[0])).length, 0);
});

test("saved draft -> prepare -> quote -> explicit cost/reference consent -> original task", async () => {
  const f = fixture(); await f.select();
  const draftSelect = f.nodes().find(node => node.type === "select");
  assert.equal(f.nodes(draftSelect).filter(node => node.type === "option").length, 3, "only image drafts are selectable");
  assert(f.nodes().some(node => node.type === "textarea" && node.props.readOnly && node.props.value === f.draft.prompt));
  await f.click("quote");
  const request = f.calls.find(call => call[0] === "prepare")[1];
  assert.match(request.intentId, /^[a-f0-9-]{36}$/);
  assert.deepEqual({ ...request, intentId: "attempt" }, { sessionId: "session-a", intentId: "attempt", draftId: "draft-a",
    expectedRevision: "saved-1", expectedDraftRevision: 2, model: "image-model" });
  assert.deepEqual(f.calls.filter(call => call[0] !== "list").map(call => call[0]), ["prepare", "quote", "referencePreview"]);
  assert(f.nodes().some(node => node.type === "img" && node.props.src === "data:image/png;base64,cmVmZXJlbmNl"));
  assert(f.nodes().some(node => String(node.props?.children).includes(f.draft.references[0].revision)));
  assert(f.nodes().some(node => String(node.props?.children).includes("panel.canvasImages.cost") &&
    String(node.props.children).includes('"points":7') && String(node.props.children).includes('"chars":4000')));
  assert(f.nodes().some(node => node.type === "label" && node.props.children.includes("panel.canvasImages.confirmReference")));
  assert.equal(f.button("submit").props.disabled, true);
  f.button("submit").props.onClick(); await f.settle(); assert.equal(f.calls.some(call => call[0] === "submit"), false);
  f.consent(); await f.click("submit");
  assert.deepEqual(f.calls.find(call => call[0] === "submit"), ["submit", "session-a", request.intentId, "quote-" + request.intentId]);
  assert(f.nodes().some(node => node.props?.role === "status" && String(node.props.children).includes("RESERVED")));
  await f.click("status"); assert.deepEqual(f.calls.at(-1), ["status", "session-a", request.intentId]);
  await f.click("quote");
  assert.notEqual(f.calls.filter(call => call[0] === "prepare").at(-1)[1].intentId, request.intentId, "a deliberate variant uses a fresh UUID");
  assert.equal(f.button("submit").props.disabled, true, "a fresh quote needs fresh consent");
});

test("Host-reordered draft and reference keys still show quote confirmation for the exact saved content", async () => {
  for (const referenced of [false, true]) {
    const f = fixture(); await f.select();
    if (!referenced) { f.draft.references = []; f.render(); f.render(); }
    const original = f.api.coursewareCanvasImagePrepare;
    f.api.coursewareCanvasImagePrepare = async request => {
      const intent = await original(request);
      const reordered = { ...intent, draft: hostDraft(intent.draft) };
      assert.deepEqual(reordered.draft, intent.draft);
      assert.notEqual(JSON.stringify(reordered.draft), JSON.stringify(intent.draft));
      f.records.set(intent.intentId, reordered); return reordered;
    };
    await f.click("quote");
    assert(f.button("submit"), "confirmation must be visible after a successful Host quote");
    assert.equal(f.button("submit").props.disabled, true);
    assert.equal(f.nodes().some(node => node.props?.role === "alert"), false);
    f.consent(); await f.click("submit");
    assert.equal(f.calls.filter(call => call[0] === "submit").length, 1);
  }
});

test("object key order alone preserves quote scope, consent and pending replies", async () => {
  for (const pendingQuote of [false, true]) {
    const f = fixture(); await f.select();
    const late = deferred();
    if (pendingQuote) {
      f.api.coursewareCanvasImageQuote = () => late.promise;
      f.button("quote").props.onClick(); await f.settle();
    } else { await f.click("quote"); f.consent(); }
    f.props.document = { ...f.props.document, drafts: f.props.document.drafts.map(hostDraft) };
    f.render(); f.render();
    if (pendingQuote) {
      const intent = [...f.records.values()][0];
      late.resolve({ quoteId: "reordered", intentId: intent.intentId, model: intent.model,
        maxPoints: 7, maxChars: 4000, expiresAt: "2099-01-01T00:00:00Z" }); await f.settle();
    }
    assert(f.button("submit"), "key order must not revoke an unchanged quote scope");
    assert.equal(f.button("submit").props.disabled, pendingQuote);
    if (!pendingQuote) assert.equal(f.nodes().find(node => node.type === "input").props.checked, true);
  }
});

test("archived preview and comparison accept equivalent Host-reordered snapshots", async () => {
  const f = fixture(); f.seedArchived("first"); await f.click("refresh");
  const original = f.api.coursewareCanvasImagePreview;
  f.api.coursewareCanvasImagePreview = async (...args) => {
    const result = await original(...args);
    return { ...result, image: { ...result.image, draft: hostDraft(result.image.draft) } };
  };
  f.rowButton("first", "preview").props.onClick(); await f.settle();
  assert(f.nodes(f.row("first")).some(node => node.type === "img"), "the same archived draft must preview regardless of key order");
  await f.compare("first");
  assert(f.nodes().some(node => node.props?.["data-canvas-image-comparison"] === "first"));
  assert.equal(f.nodes().some(node => node.props?.role === "alert"), false);
});

test("draft, exact content, saved revision, model and disabled changes revoke quote and consent", async () => {
  for (const change of [f => f.choose(0, "draft-b"), f => f.choose(1, "text-model"),
    f => { f.props.revision = "saved-2"; }, f => { f.props.disabled = true; },
    f => { f.draft.prompt = "Changed prompt"; }, f => { f.draft.references[0].revision = "b".repeat(64); }]) {
    const f = fixture(); await f.select(); await f.click("quote"); f.consent();
    change(f); f.render(); f.render();
    assert.equal(f.button("submit"), undefined);
    assert.equal(f.calls.some(call => call[0] === "submit"), false);
  }
});

test("list keeps deleted/stale requests and status only queries that original intent", async () => {
  const f = fixture();
  const original = { intentId: "old-intent", draft: { ...f.draft, id: "deleted", prompt: "Original frozen prompt" },
    model: "old-model", current: false, phase: "submission-unknown", task: null };
  f.records.set(original.intentId, original);
  await f.click("refresh");
  assert(f.nodes().some(node => node.props?.["data-canvas-image-intent"] === "old-intent"));
  assert(f.nodes().some(node => node.type === "textarea" && node.props.value === "Original frozen prompt"));
  await f.click("status");
  assert.deepEqual(f.calls.at(-1), ["status", "session-a", "old-intent"]);
  assert.equal(f.calls.some(call => ["prepare", "quote", "submit"].includes(call[0])), false);
});

test("uncertain submission cannot dispatch again even when recovery list is also unavailable", async () => {
  const f = fixture(); await f.select(); await f.click("quote"); f.consent();
  let submits = 0;
  f.api.coursewareCanvasImageSubmitConfirmed = async () => { submits++; throw new Error("Receipt lost"); };
  f.api.coursewareCanvasImageList = async () => { throw new Error("Recovery unavailable"); };
  const submit = f.button("submit"); submit.props.onClick(); submit.props.onClick(); await f.settle();
  assert.equal(submits, 1);
  assert.equal(f.button("submit"), undefined); assert.equal(f.button("quote").props.disabled, true);
  assert(f.nodes().some(node => node.props?.role === "alert" && String(node.props.children).includes("Receipt lost")));
  const original = [...f.records.values()][0];
  f.records.set(original.intentId, { ...original, phase: "submitted", task: null });
  await f.click("status"); assert.equal(submits, 1);
  assert.equal(f.button("quote").props.disabled, false);
});

test("status refresh preserves prepared-quote consent but revokes submission if that task becomes unknown", async () => {
  const f = fixture(); await f.select(); await f.click("quote"); f.consent();
  const original = [...f.records.values()][0];
  await f.click("status");
  assert.equal(f.button("submit").props.disabled, false);
  assert.equal(f.nodes().find(node => node.type === "input").props.checked, true);
  f.records.set(original.intentId, { ...original, phase: "submission-unknown" });
  await f.click("status");
  assert.equal(f.button("submit"), undefined);
  assert.equal(f.button("quote").props.disabled, true);
  assert.equal(f.calls.some(call => call[0] === "submit"), false);
});

test("auth clears private rows/models/quote and drops a late reply before the next account can load", async () => {
  const f = fixture(); await f.select(); await f.click("quote"); f.consent();
  const late = deferred(); f.api.coursewareCanvasImageList = () => late.promise;
  f.button("refresh").props.onClick(); f.render();
  f.authChanged();
  assert.equal(f.button("submit"), undefined);
  assert.equal(f.nodes().some(node => node.props?.["data-canvas-image-intent"]), false);
  assert(f.nodes().filter(node => node.type === "select").every(node => node.props.value === ""));
  f.api.coursewareCanvasImageList = async () => [];
  await f.click("refresh");
  late.resolve([...f.records.values()]); await f.settle();
  assert.equal(f.nodes().some(node => node.props?.["data-canvas-image-intent"]), false);
});

test("late quote replies cannot cross revision/session changes or component disposal", async () => {
  for (const change of [f => { f.props.revision = "saved-2"; }, f => { f.props.sessionId = "session-b"; },
    f => { f.props.document = { ...f.props.document, projectId: "project-b" }; }, f => { f.unmount(); }]) {
    const f = fixture(); await f.select();
    const late = deferred(); f.api.coursewareCanvasImageQuote = () => late.promise;
    f.button("quote").props.onClick(); await f.settle();
    const intent = [...f.records.values()][0];
    change(f); f.render(); f.render();
    late.resolve({ quoteId: "late", intentId: intent.intentId, model: intent.model,
      maxPoints: 7, maxChars: 4000, expiresAt: "2099-01-01T00:00:00Z" }); await f.settle();
    assert.equal(f.button("submit"), undefined);
    assert.equal(f.calls.some(call => call[0] === "submit"), false);
  }
});

test("unsaved, unsupported references and transport limits refuse preparation without truncation", async () => {
  for (const change of [f => { f.props.revision = null; }, f => { f.props.disabled = true; },
    f => f.choose(1, "text-model"), f => { f.draft.references.push({ ...f.draft.references[0], assetId: "second" }); },
    f => { f.draft.prompt = "😀".repeat(2001); }]) {
    const f = fixture(); await f.select(); change(f); f.render(); f.render();
    assert.equal(f.button("quote").props.disabled, true);
    f.button("quote").props.onClick(); await f.settle();
    assert.equal(f.calls.some(call => call[0] === "prepare"), false);
  }
  const f = fixture(); await f.select(); f.draft.references = []; f.choose(1, "text-model");
  await f.click("quote");
  assert(f.nodes().some(node => node.type === "label" && node.props.children.includes("panel.canvasImages.confirm")));
});

test("expired or mismatched quotes never expose confirmed submission", async () => {
  for (const override of [{ expiresAt: "2000-01-01T00:00:00Z" }, { expiresAt: "invalid" }, { intentId: "foreign" }, { model: "foreign" }]) {
    const f = fixture(); await f.select();
    const original = f.api.coursewareCanvasImageQuote;
    f.api.coursewareCanvasImageQuote = async (...args) => ({ ...await original(...args), ...override });
    await f.click("quote"); assert.equal(f.button("submit"), undefined);
  }
});

test("reference confirmation waits for the matching private original and rejects wrong identity, hash, label or URL", async () => {
  const f = fixture(); await f.select();
  const late = deferred(); f.api.coursewareCanvasImageReferencePreview = () => late.promise;
  f.button("quote").props.onClick(); await f.settle();
  assert.equal(f.nodes().some(node => node.type === "input" && node.props.type === "checkbox"), false);
  assert.equal(f.button("submit"), undefined);
  const intent = [...f.records.values()][0];
  late.resolve({ intentId: intent.intentId, reference: intent.draft.references[0], dataUrl: "data:image/png;base64,cmVmZXJlbmNl" });
  await f.settle();
  assert(f.nodes().some(node => node.type === "img"));
  assert.equal(f.button("submit").props.disabled, true);
  for (const override of [value => ({ ...value, intentId: "another-intent" }),
    value => ({ ...value, reference: { ...value.reference, assetId: "another-reference" } }),
    value => ({ ...value, reference: { ...value.reference, revision: "c".repeat(64) } }),
    value => ({ ...value, reference: { ...value.reference, label: "another-label" } }),
    value => ({ ...value, dataUrl: "https://private.example/image.png" }),
    value => ({ ...value, dataUrl: "file:///private/image.png" })]) {
    const g = fixture(); await g.select();
    const original = g.api.coursewareCanvasImageReferencePreview;
    g.api.coursewareCanvasImageReferencePreview = async (...args) => override(await original(...args));
    await g.click("quote");
    assert.equal(g.button("submit"), undefined);
    assert.equal(g.nodes().some(node => node.type === "img"), false);
    assert(g.nodes().some(node => node.props?.role === "alert" && String(node.props.children).includes("invalidReference")));
    assert.equal(g.calls.some(call => call[0] === "submit"), false);
  }
});

test("archive waits for ready/settled status, then stale candidates preview locally without regeneration", async () => {
  const f = fixture(); await f.select(); await f.click("quote"); f.consent(); await f.click("submit");
  const intentId = [...f.records.keys()][0];
  assert.equal(f.rowButton(intentId, "archive").props.disabled, true);
  assert.equal(f.calls.some(call => call[0] === "archive"), false);
  const row = f.records.get(intentId);
  f.records.set(intentId, { ...row, task: { ...row.task, state: "ready", feeState: "reserved" } });
  await f.click("status"); assert.equal(f.rowButton(intentId, "archive").props.disabled, true);
  f.records.set(intentId, { ...row, task: { ...row.task, state: "ready", feeState: "settled" } });
  await f.click("status");
  assert.equal(f.rowButton(intentId, "archive").props.disabled, false);
  f.rowButton(intentId, "archive").props.onClick(); await f.settle();
  assert(f.nodes(f.row(intentId)).some(node => node.type === "img" && node.props.src.startsWith("data:image/png;base64,")));
  f.props.document.drafts = []; f.props.revision = "after-deletion"; f.render(); f.render();
  f.records.set(intentId, { ...f.records.get(intentId), current: false });
  await f.click("refresh");
  f.rowButton(intentId, "preview").props.onClick(); await f.settle();
  assert.deepEqual(f.calls.at(-1), ["preview", "session-a", intentId]);
  assert.equal(f.calls.filter(call => call[0] === "archive").length, 1);
  assert.equal(f.calls.filter(call => call[0] === "submit").length, 1);
  assert(f.nodes(f.row(intentId)).some(node => node.type === "textarea" && node.props.value === row.draft.prompt));
  await f.click("closePreview");
  assert.equal(f.nodes(f.row(intentId)).some(node => node.type === "img"), false);
});

test("two explicit stale archived comparisons keep original versions across unrelated field edits", async () => {
  const f = fixture(); await f.select();
  const first = f.seedArchived("first"), second = f.seedArchived("second"); f.seedArchived("third");
  await f.click("refresh"); await f.compare("first"); await f.compare("second");
  const compared = () => f.nodes().filter(node => node.props?.["data-canvas-image-comparison"]);
  assert.deepEqual(compared().map(node => node.props["data-canvas-image-comparison"]), ["first", "second"]);
  for (const image of [first, second]) {
    const article = compared().find(node => node.props["data-canvas-image-comparison"] === image.intentId);
    assert(f.nodes(article).some(node => node.type === "strong" && node.props.children.includes(image.model)));
    assert(f.nodes(article).some(node => node.type === "textarea" && node.props.value === image.draft.prompt));
    assert(f.nodes(article).some(node => String(node.props?.children).includes(image.asset.sha256)));
    assert(f.nodes(article).some(node => String(node.props?.children).includes('"revision":1')));
  }
  const thirdCheckbox = f.nodes(f.row("third")).find(node => node.type === "input");
  assert.equal(thirdCheckbox.props.disabled, true);
  thirdCheckbox.props.onChange(); await f.settle();
  assert.equal(compared().length, 2);
  f.choose(0, "draft-b"); f.choose(1, "text-model");
  f.draft.prompt = "Latest draft prompt"; f.props.revision = "layout-or-prompt-saved"; f.render(); f.render();
  assert.deepEqual(compared().map(node => node.props["data-canvas-image-comparison"]), ["first", "second"]);
  assert.equal(f.calls.some(call => ["prepare", "quote", "submit", "archive"].includes(call[0])), false);
  await f.compare("first"); await f.compare("third");
  assert.deepEqual(compared().map(node => node.props["data-canvas-image-comparison"]), ["second", "third"]);
  assert.deepEqual(f.calls.filter(call => call[0] === "preview").map(call => call[2]), ["first", "second", "third"]);
});

test("private previews and comparisons clear on auth/session/project changes and ignore their late replies", async () => {
  for (const change of [f => f.authChanged(), f => { f.props.sessionId = "session-b"; },
    f => { f.props.document = { ...f.props.document, projectId: "project-b" }; }]) {
    const f = fixture(); f.seedArchived("first"); const second = f.seedArchived("second");
    await f.click("refresh");
    f.rowButton("first", "preview").props.onClick(); await f.settle(); await f.compare("first");
    assert.equal(f.nodes().filter(node => node.type === "img").length, 2);
    const late = deferred(); f.api.coursewareCanvasImagePreview = () => late.promise;
    f.nodes(f.row("second")).find(node => node.type === "input").props.onChange(); f.render();
    change(f); f.render(); f.render();
    assert.equal(f.nodes().some(node => node.type === "img"), false);
    late.resolve({ image: second, dataUrl: "data:image/png;base64,Y2FuZGlkYXRl" }); await f.settle();
    assert.equal(f.nodes().some(node => node.type === "img"), false);
    assert.equal(f.nodes().some(node => node.props?.["data-canvas-image-comparison"]), false);
    assert.equal(f.nodes().some(node => node.props?.["data-canvas-image-intent"]), false);
  }
});

test("late reference preview, archive and restore results cannot enter a changed draft, account or session", async () => {
  for (const action of ["reference", "archive", "restore"]) {
    for (const change of [f => f.authChanged(), f => { f.props.sessionId = "session-b"; },
      f => { f.props.revision = "saved-2"; f.draft.prompt = "Changed while waiting"; }, f => f.unmount()]) {
      const f = fixture(), late = deferred(); let response;
      if (action === "reference") {
        await f.select();
        f.api.coursewareCanvasImageReferencePreview = () => late.promise;
        f.button("quote").props.onClick(); await f.settle();
        const intent = [...f.records.values()][0];
        response = { intentId: intent.intentId, reference: intent.draft.references[0], dataUrl: "data:image/png;base64,cmVmZXJlbmNl" };
      } else {
        const row = f.seedArchived("archiving", action === "archive" ? { asset: null, current: true, task: { state: "ready", feeState: "settled" } } : {});
        await f.click("refresh");
        f.api[action === "archive" ? "coursewareCanvasImageArchive" : "coursewareCanvasImageRestore"] = () => late.promise;
        f.rowButton(row.intentId, action).props.onClick(); f.render();
        response = { image: { ...row, asset: { sha256: "b".repeat(64), mimeType: "image/png", byteLength: 128, width: 64, height: 32 } },
          dataUrl: "data:image/png;base64,Y2FuZGlkYXRl" };
      }
      change(f); f.render(); f.render(); late.resolve(response); await f.settle();
      assert.equal(f.nodes().some(node => node.type === "img"), false);
      assert.equal(f.button("submit"), undefined);
      assert.equal(f.calls.some(call => call[0] === "submit"), false);
    }
  }
});

test("candidate previews reject another task, changed snapshot/hash or nonlocal URLs", async () => {
  for (const override of [value => ({ ...value, image: { ...value.image, intentId: "wrong" } }),
    value => ({ ...value, image: { ...value.image, draft: { ...value.image.draft, prompt: "Changed" } } }),
    value => ({ ...value, image: { ...value.image, asset: { ...value.image.asset, sha256: "c".repeat(64) } } }),
    value => ({ ...value, dataUrl: "https://private.example/image.png" }),
    value => ({ ...value, dataUrl: "data:image/jpeg;base64,Y2FuZGlkYXRl" })]) {
    const f = fixture(); f.seedArchived("first"); await f.click("refresh");
    const original = f.api.coursewareCanvasImagePreview;
    f.api.coursewareCanvasImagePreview = async (...args) => override(await original(...args));
    await f.compare("first");
    assert.equal(f.nodes().some(node => node.type === "img"), false);
    assert(f.nodes().some(node => node.props?.role === "alert" && String(node.props.children).includes("invalidPreview")));
    assert.equal(f.calls.some(call => ["prepare", "quote", "submit", "archive"].includes(call[0])), false);
  }
});

test("every locale contains the complete canvas image panel catalog", async () => {
  const catalogs = [];
  for (const locale of ["en", "de", "es", "fr", "ko", "tr", "zh-CN", "zh-TW"]) {
    const text = await readFile(new URL(`../../../packages/i18n/src/locales/${locale}/index.ts`, import.meta.url), "utf8");
    const exports = {};
    new Function("exports", ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(exports);
    const catalog = Object.values(exports).find(value => value?.panel?.canvasImages)?.panel.canvasImages;
    assert(catalog, locale); catalogs.push(catalog);
    assert(Object.values(catalog).every(value => typeof value === "string" && value.length), locale);
    assert.deepEqual(Object.keys(catalog).sort(), Object.keys(catalogs[0]).sort(), locale);
  }
  for (const [, key] of source.matchAll(/panel\.canvasImages\.([A-Za-z]+)/g)) assert(key in catalogs[0], key);
});

test("definite refusal renders guidance, disables recovery, and requires a new explicit quote and consent", async () => {
  const f = fixture(); await f.select(); await f.click("quote"); f.consent();
  f.api.coursewareCanvasImageSubmitConfirmed = async (_session, intentId) => {
    f.calls.push(["submit-refused", intentId]);
    const row = { ...f.records.get(intentId), phase: "rejected", task: null };
    f.records.set(intentId, row); return row;
  };
  await f.click("submit");
  const first = [...f.records.values()][0];
  assert(f.nodes().some(node => JSON.stringify(node.props?.children)?.includes("panel.canvasImages.rejected")));
  assert.equal(f.rowButton(first.intentId, "status").props.disabled, true);
  assert(!f.nodes().some(node => node.props?.role === "alert"));
  assert.equal(f.button("submit"), undefined);
  assert.equal(f.button("quote").props.disabled, false);
  await f.click("quote");
  const next = [...f.records.values()].at(-1);
  assert.notEqual(next.intentId, first.intentId);
  assert.equal(f.button("submit").props.disabled, true);
  assert.equal(f.calls.filter(call => call[0] === "submit-refused").length, 1);
});
