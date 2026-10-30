import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import * as baseShared from "../../../packages/shared/dist/index.js";

const editorExports = {};
new Function("require", "exports", ts.transpileModule(await readFile(new URL("../../../packages/shared/src/courseware-editor.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(() => baseShared, editorExports);
const shared = { ...baseShared, ...editorExports };

const semantics = { exports: {} };
const semanticsSource = await readFile(new URL("../electron/main/courseware-scene-object-view.ts", import.meta.url), "utf8");
new Function("require", "exports", ts.transpileModule(semanticsSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)((id) => {
  if (id === "@pi-desktop/shared") return shared;
  throw new Error(id);
}, semantics.exports);

const source = await readFile(new URL("../electron/main/courseware-teaching.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
const module = { exports: {} };
new Function("require", "exports", outputText)((id) => {
  if (id === "@pi-desktop/shared") return shared;
  if (id === "./courseware-scene-object-view") return semantics.exports;
  if (id === "node:crypto") return { randomUUID: () => crypto.randomUUID() };
  if (id === "node:timers/promises") return { setTimeout: async () => {} };
  throw new Error(id);
}, module.exports);
const { CoursewareTeachingCoordinator } = module.exports;
const fixture = JSON.parse(await readFile(new URL("../../../packages/shared/src/courseware-contract.fixtures/accepted.json", import.meta.url), "utf8"));

function historyFixture() {
  return { entries: [{ teachingRevision: "old-teaching", sourceRevision: "old-source", pageId: "deleted-page", pageNumber: 2,
    actions: [{ id: "recovered-speech", type: "speech", text: "Good!", source: "generated", pauseAfterMs: 1200 }],
    omittedAudioCount: 1, omittedCueCount: 1 }], skippedEntryCount: 0 };
}

test("history reads deleted-page text through the current saved view and keeps the write pin usable", async () => {
  const f = setup(), call = f.host.call, history = historyFixture();
  f.host.call = async (method, params) => {
    if (method !== "courseware.teachingHistory.list") return call(method, params);
    assert.deepEqual(params, { sessionId: "chat-1", jobId: "job-1" });
    return history;
  };
  const coordinator = f.make(), view = await coordinator.open("chat-1");
  const before = structuredClone(f.project());
  const result = await coordinator.history({ viewId: view.viewId });
  assert.deepEqual(result, history);
  result.entries[0].actions[0].text = "Edited draft";
  assert.equal(history.entries[0].actions[0].text, "Good!");
  assert.deepEqual(f.project(), before);
  const saved = await coordinator.update({ viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision,
    actions: result.entries[0].actions }, false);
  assert.equal(saved.project.pages[0].actions[0].text, "Edited draft");
});

for (const change of ["view", "extra", "dirty", "workspace", "chat", "page", "owner", "teaching", "response-media", "response-current-page", "during-read", "during-teaching"])
  test(`history refuses ${change} without changing saved teaching`, async () => {
    const f = setup(), call = f.host.call;
    const coordinator = f.make(), view = await coordinator.open("chat-1");
    const result = historyFixture();
    if (change === "dirty") f.dirty();
    if (change === "workspace") f.switchWorkspace();
    if (change === "chat") f.switchChat();
    if (change === "page") f.context.page = 2;
    if (change === "owner") f.loseOwner();
    if (change === "teaching") f.project().teachingRevision = "newer-teaching";
    if (change === "response-media") result.entries[0].actions[0].audioAssetId = "old-audio";
    if (change === "response-current-page") result.entries[0].pageId = view.pageId;
    const before = structuredClone(f.project());
    f.host.call = async (method, params) => {
      if (method !== "courseware.teachingHistory.list") return call(method, params);
      if (change === "during-read") f.context.page = 2;
      if (change === "during-teaching") f.project().teachingRevision = "concurrent-write";
      return result;
    };
    await assert.rejects(coordinator.history({ viewId: change === "view" ? "expired" : view.viewId,
      ...(change === "extra" ? { path: "/other/project" } : {}) }));
    assert.deepEqual(f.project().pages, before.pages);
    assert(!f.calls.some(([method]) => ["courseware.teaching.write", "courseware.teaching.setLock", "courseware.teaching.confirm"].includes(method)));
  });

test("saved-page change receipts reach the sidebar and refresh after teaching confirmation", async () => {
  const f = setup();
  f.project().pages[0].reviewState = "review";
  f.project().pages[1].reviewState = "ready";
  const call = f.host.call;
  f.host.call = async (method, params) => {
    const result = await call(method, params);
    if (method !== "courseware.project.context") return result;
    const project = result.project;
    const pendingPageIds = project.pages.filter(page => page.reviewState !== "ready").map(page => page.pageId);
    return { ...result, sourceChange: { changeGroupId: "review-1", phase: pendingPageIds.length ? "teaching-review" : "complete", stale: false,
      baselineSource: "b".repeat(64), baselineTeachingRevision: "old", targetSource: project.source.sha256,
      expected: ["source-associated", "teaching-review"], completed: ["source-saved", "source-associated", ...(!pendingPageIds.length ? ["teaching-review"] : [])],
      associationTeachingRevision: "associated", currentTeachingRevision: project.teachingRevision, pendingPageIds } };
  };
  const teaching = f.make();
  const view = await teaching.open("chat-1");
  assert.equal(view.sourceChange.phase, "teaching-review");
  assert.deepEqual(view.sourceChange.pendingPageIds, [view.pageId]);
  const ready = await teaching.update({ viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision }, "confirm");
  assert.equal(ready.viewId, view.viewId);
  assert.equal(ready.sourceChange.phase, "complete");
  assert.deepEqual(ready.sourceChange.pendingPageIds, []);
  const reopened = await f.make().open("chat-1");
  assert.deepEqual(reopened.sourceChange, ready.sourceChange);
});

test("explicit Chat disposition requires exact saved view and receipt and retains newer teaching", async () => {
  const f = setup(), call = f.host.call;
  const raw = { changeGroupId: "group", receiptSha256: "a".repeat(64), operations: [],
    plan: { pageId: f.project().pages[0].pageId, pageNumber: 1,
      items: [{ label: "Rewrite narration", toolName: "ppt_propose_page_narration", status: "not-recorded" }] } };
  let resolved = false;
  f.host.call = async (method, params) => {
    const result = await call(method, params);
    if (method === "courseware.teaching.confirm") {
      assert.deepEqual(params.resolution, { changeGroupId: "group", receiptSha256: "a".repeat(64), note: "Keep newer content." });
      resolved = true;
    }
    if (method !== "courseware.project.context") return result;
    return { ...result, chatChanges: [{ ...raw, sessionId: "chat-1", ...(resolved ? { resolution: {
      changeGroupId: "group", sessionId: "chat-1", receiptSha256: raw.receiptSha256, note: "Keep newer content.",
      source: result.project.source, teachingRevision: result.project.teachingRevision, projectSha256: "c".repeat(64),
    } } : {}) }] };
  };
  const teaching = f.make(), view = await teaching.open("chat-1");
  const request = { viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision,
    resolution: { changeGroupId: "group", receiptSha256: "a".repeat(64), note: "Keep newer content." } };
  for (const patch of [{ note: "" }, { receiptSha256: "b".repeat(64) }, { changeGroupId: "foreign" }, { extra: true }])
    await assert.rejects(teaching.update({ ...request, resolution: { ...request.resolution, ...patch } }, "confirm"));
  assert.equal(f.calls.filter(([method]) => method === "courseware.teaching.confirm").length, 0);
  const originalActions = structuredClone(view.project.pages.map(page => page.actions));
  const next = await teaching.update(request, "confirm");
  assert.deepEqual(next.project.pages.map(page => page.actions), originalActions);
  assert.equal(next.chatChanges[0].plan.items[0].status, "not-recorded");
  assert.equal(next.chatChanges[0].resolution.note, "Keep newer content.");
  await assert.rejects(teaching.update({ ...request, expectedTeachingRevision: next.project.teachingRevision }, "confirm"));
});

function setup() {
  let project = structuredClone(fixture.project);
  project.pages[1].locked = false;
  const snapshot = { projectId: "workspace-hash", documentId: "lesson-hash", sessionId: "native-1", path: "/workspace/saved.pptx", sourcePath: "/workspace/lesson.pptx", revision: 8, sha256: project.source.sha256 };
  const context = { ...snapshot, editGeneration: 1, page: 1, readOnly: false };
  let dirty = false;
  let owner = true;
  let visible = true;
  const calls = [];
  const host = { async call(method, params) {
    calls.push([method, params]);
    if (method === "courseware.parseStart") return { jobId: "job-1" };
    if (method === "courseware.parseStatus") return { status: "SUCCEEDED", summary: { sourceSha256: snapshot.sha256 } };
    if (method === "courseware.parseRelease" || method === "courseware.parseCancel") return {};
    if (method === "courseware.project.attach") return { attached: false };
    if (method === "courseware.project.openSaved" || method === "courseware.project.get") return { project: structuredClone(project) };
    if (method === "courseware.project.context") return { project: structuredClone(project) };
    const write = method === "courseware.teaching.write" ? params.write : { ...params, actions: [] };
    const page = project.pages.find((entry) => entry.pageId === write.pageId);
    assert.equal(params.sessionId, "chat-1");
    const check = shared.checkTeachingWrite(project, write);
    if (check === "stale" || (!["courseware.teaching.setLock", "courseware.teaching.confirm"].includes(method) && check !== "accepted")) throw new Error(check);
    if (method.endsWith("setLock")) page.locked = params.locked;
    else if (method.endsWith("confirm")) page.reviewState = "ready";
    else { page.actions = structuredClone(write.actions); page.reviewState = "review"; }
    project.teachingRevision = crypto.randomUUID();
    return { project: structuredClone(project) };
  } };
  let workspace = "/workspace";
  const editor = {
    async verifyTeachingSource() {},
    teachingSnapshot(root) { if (dirty || root !== "/workspace") throw new Error("Save or reopen"); return { ...snapshot }; },
    async getContext() { return { ...context }; },
  };
  let viewingSession = "chat-1";
  const make = () => new CoursewareTeachingCoordinator(editor, () => host, async () => workspace, () => viewingSession,
    () => { if (!owner || !visible) throw new Error("PPT editor is no longer active in this Chat"); },
    () => { if (!owner) throw new Error("PPT editor no longer belongs to this Chat"); });
  return { make, host, editor, snapshot, context, calls, hide: () => { owner = false; }, hideEditor: () => { visible = false; },
    loseOwner: () => { owner = false; }, switchChat: () => { viewingSession = "chat-2"; }, project: () => project,
    dirty: () => { dirty = true; }, switchWorkspace: () => { workspace = "/other"; } };
}

test("every saved parse attaches the authorized source before opening teaching", async () => {
  const f = setup(), original = f.host.call;
  f.host.call = async (method, params) => {
    if (method === "courseware.project.attach") {
      f.calls.push([method, params]);
      assert.deepEqual(params, { sessionId: "chat-1", jobId: "job-1", sourcePath: f.snapshot.sourcePath });
      return { attached: true };
    }
    return original(method, params);
  };
  await f.make().open("chat-1");
  await f.make().open("chat-1");
  const methods = f.calls.map(([method]) => method);
  assert.equal(methods.filter(method => method === "courseware.project.attach").length, 2);
  assert(methods.indexOf("courseware.project.attach") < methods.indexOf("courseware.project.openSaved"));
});

test("cancellation during portable attachment releases parsing without running a saved operation", async () => {
  const f = setup(), original = f.host.call, abort = new AbortController();
  f.host.call = async (method, params) => {
    if (method !== "courseware.project.attach") return original(method, params);
    abort.abort();
    return { attached: true };
  };
  await assert.rejects(f.make().withSaved("chat-1", async () => assert.fail("Cancelled saved operation ran"), abort.signal));
  assert(f.calls.some(([method]) => method === "courseware.parseRelease"));
});

for (const change of ["error", "invalid-result", "page", "source-path", "session"]) test(`portable attachment refuses ${change} and releases the parser`, async () => {
  const f = setup(), original = f.host.call;
  f.host.call = async (method, params) => {
    if (method !== "courseware.project.attach") return original(method, params);
    if (change === "error") throw new Error("COURSEWARE_CONFLICT: portable baseline changed");
    if (change === "invalid-result") return { attached: true, path: "/private" };
    if (change === "page") f.context.page = 2;
    if (change === "source-path") f.snapshot.sourcePath = "/workspace/other.pptx";
    if (change === "session") f.switchChat();
    return { attached: true };
  };
  await assert.rejects(f.make().open("chat-1"));
  assert(!f.calls.some(([method]) => method === "courseware.project.openSaved"));
  assert(f.calls.some(([method]) => method === "courseware.parseRelease"));
});

test("scene teaching shows only this page's saved object roles and invalidation states", async () => {
  const f = setup();
  f.project().taskType = "scene";
  const project = f.project(), pageId = project.pages[0].pageId;
  const original = f.host.call;
  const objects = ["mapped", "missing", "content_changed", "identity_mismatch"].map((status, index) => ({
    objectId: `object-${index}`, status,
    element: { elementId: `layer-${index}`, type: "native_shape", semanticRole: `teaching role ${index}`, spokenAliases: ["apple", "苹果"],
      regenerationPrompt: "private generation requirements" },
  }));
  const context = { project: structuredClone(project), sceneObjects: {
    schemaVersion: "deckwise-scene-objects/1", sourceSha256: project.source.sha256, requiresReview: true,
    pages: [{ pageId, objects }, { pageId: project.pages[1].pageId, objects: [] }],
  } };
  f.host.call = async (method, params) => method === "courseware.project.context" ? structuredClone(context) : original(method, params);
  const view = await f.make().open("chat-1");
  assert.equal(view.teachingObjects.length, 4);
  assert.deepEqual(view.teachingObjects.map(object => object.status), objects.map(object => object.status));
  assert.deepEqual(view.teachingObjects[0], { objectId: "object-0", name: "layer-0", role: "teaching role 0",
    aliases: ["apple", "苹果"], status: "mapped", effectTargetEligible: true });
  assert(!JSON.stringify(view.teachingObjects).includes("private generation"));
  f.context.page = 2;
  assert.deepEqual((await f.make().open("chat-1")).teachingObjects, []);
  assert.equal(semantics.exports.sceneObjectsForTeaching({ project }, project, pageId), undefined);
  for (const change of [
    value => { value.project.teachingRevision = "changed"; },
    value => { value.sceneObjects.sourceSha256 = "b".repeat(64); },
    value => { value.sceneObjects.pages[0].objects[0].status = "approved"; },
    value => { value.sceneObjects.pages[0].objects.push(value.sceneObjects.pages[0].objects[0]); },
    value => { value.sceneObjects.pages.push(value.sceneObjects.pages[0]); },
  ]) {
    const invalid = structuredClone(context); change(invalid);
    assert.throws(() => semantics.exports.sceneObjectsForTeaching(invalid, project, pageId));
  }
});

test("scene source review exposes only canonical rebound UUIDs as generic eligible objects", () => {
  const project = structuredClone(fixture.project); project.taskType = "scene";
  const pageId = project.pages[0].pageId;
  project.pages[0].actions = [{ id: "speech", type: "speech", text: "Look.", visualCues: [
    { id: "cue", atMs: 0, endMs: 800, effect: { type: "highlight", elementIds: ["rebound", "not-saved"] } },
  ] }];
  const raw = { project, sceneObjects: { schemaVersion: "deckwise-scene-objects/1", sourceSha256: project.source.sha256,
    requiresReview: true, pages: [{ pageId, objects: [{ objectId: "old-semantic", status: "missing",
      element: { elementId: "old-layer", type: "native_shape", spokenAliases: [] } }] }] },
    mapping: { revision: "current", sourceSha256: project.source.sha256, pages: project.pages.map((page, index) => ({
      pageId: page.pageId, objects: index ? [] : [{ objectId: "rebound" }, { objectId: "unreviewed" }, { objectId: "line" }] })) },
    savedObjects: { sourceSha256: project.source.sha256, mappingRevision: "current", pages: project.pages.map((page, index) => ({
      pageId: page.pageId, objects: index ? [] : [{ objectId: "rebound", kind: "shape", index: 1 },
        { objectId: "unreviewed", kind: "shape", index: 2 }, { objectId: "line", kind: "line", index: 3 }] })) } };
  const objects = semantics.exports.objectsForTeaching(raw, project, pageId);
  assert.deepEqual(objects.map(object => [object.objectId, object.effectTargetEligible]), [["old-semantic", false], ["rebound", true]]);
  assert.equal(objects[1].savedKind, "shape");
  project.pages[0].actions[0].visualCues[0].effect.elementIds = ["line"];
  assert.deepEqual(semantics.exports.objectsForTeaching(raw, project, pageId).map(object => object.objectId), ["old-semantic"]);
  project.pages[0].actions[0].visualCues[0].effect.elementIds = ["rebound"];
  raw.sceneObjects.pages[0].objects.push({ objectId: "rebound", status: "mapped", element: {
    elementId: "panda-layer", type: "image_layer", semanticRole: "Panda Pandy", spokenAliases: ["熊猫", "Panda Pandy"] } });
  const retained = semantics.exports.objectsForTeaching(raw, project, pageId).find(object => object.objectId === "rebound");
  assert.equal(retained.role, "Panda Pandy");
  assert.deepEqual(retained.aliases, ["熊猫", "Panda Pandy"]);
  raw.nativeSaved = true;
  raw.savedObjects.pages[0].objects[1].sourceObjectName = "New native shape";
  const native = semantics.exports.objectsForTeaching(raw, project, pageId);
  assert.deepEqual(native.map(object => [object.objectId, object.effectTargetEligible]), [["rebound", true], ["unreviewed", true], ["line", false]]);
  assert.equal(native[1].sourceObjectName, "New native shape");
  raw.savedObjects.mappingRevision = "stale";
  assert.throws(() => semantics.exports.objectsForTeaching(raw, project, pageId), /Invalid current saved object context/);
});

test("attention authoring writes only reviewed current mapped targets and preserves audio, narration and checkpoints", async () => {
  for (const failure of [null, "unconfirmed", "missing", "connector", "foreign", "audio", "interval", "locked", "stale", "changed-context", "plain", "import"]) {
    const f = setup(), original = f.host.call;
    f.project().taskType = failure === "plain" || failure === "import" ? failure : "scene";
    const speech = { id: "speech-1", type: "speech", text: "Look at the apple.", audioAssetId: "voice-1", pauseAfterMs: 500,
      visualCues: [{ id: "existing-animation", atMs: 0, endMs: 200, effect: { type: "element_animation", elementId: "object-a", effect: "fadeIn" } }] };
    const checkpoint = { id: "wait", type: "interaction_checkpoint", checkpointId: "wait", checkpointKind: "teacher_continue" };
    f.project().pages[0].actions = [speech, checkpoint];
    if (failure === "unconfirmed") f.project().pages[0].reviewState = "review";
    if (failure === "locked") f.project().pages[0].locked = true;
    f.host.call = async (method, params) => {
      if (method === "courseware.project.context") return { project: structuredClone(f.project()), sceneObjects: {
        schemaVersion: "deckwise-scene-objects/1", sourceSha256: f.project().source.sha256, requiresReview: true,
        pages: [{ pageId: f.project().pages[0].pageId, objects: [{ objectId: "object-a", status: failure === "missing" ? "missing" : "mapped",
          element: { elementId: "Apple", type: failure === "connector" ? "connector" : "image_layer", spokenAliases: ["apple"] } }] }],
      } };
      return original(method, params);
    };
    const teaching = f.make(), view = await teaching.open("chat-1");
    const cue = { id: "attention-1", atMs: 200, endMs: failure === "interval" ? 200 : 900,
      effect: { type: "highlight", elementIds: [failure === "foreign" ? "other-page-object" : "object-a"] } };
    const actions = [{ ...speech, visualCues: [...speech.visualCues, cue] }, checkpoint];
    if (failure === "audio") delete actions[0].audioAssetId;
    if (failure === "stale") f.dirty();
    if (failure === "changed-context") f.project().teachingRevision = "changed";
    const save = () => teaching.update({ viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision, actions }, false);
    if (failure) {
      await assert.rejects(save(), /effect|Effect|Save or reopen|changed|locked/i, failure);
      assert.equal(f.calls.filter(([method]) => method === "courseware.teaching.write").length, 0, failure);
    } else {
      const result = await save();
      assert.deepEqual(result.project.pages[0].actions, actions);
      assert.equal(result.project.pages[0].reviewState, "review");
      assert.deepEqual(result.project.pages[1], view.project.pages[1]);
      assert.equal(result.project.pages[0].actions[0].audioAssetId, "voice-1");
    }
  }
});

test("ordinary and imported effect saves use only the exact current Host-bound page objects", async () => {
  for (const taskType of ["plain", "import"]) for (const failure of [null, "source", "revision", "order", "foreign", "raw-id", "unknown", "missing", "task", "locked"]) {
    const f = setup(), original = f.host.call;
    f.project().taskType = taskType;
    const speech = { id: "speech-1", type: "speech", text: "Look at these objects.", audioAssetId: "voice-1", pauseAfterMs: 500 };
    const checkpoint = { id: "wait", type: "interaction_checkpoint", checkpointId: "wait", checkpointKind: "teacher_continue" };
    f.project().pages[0].actions = [speech, checkpoint];
    let reads = 0;
    f.host.call = async (method, params) => {
      if (method !== "courseware.project.context") return original(method, params);
      const project = structuredClone(f.project()), mapping = { revision: "mapping-1", sourceSha256: project.source.sha256,
        pages: project.pages.map((page, index) => ({ pageId: page.pageId, importPageId: "page_" + (index + 1),
          objects: [{ objectId: "bound-" + index, importElementId: "pptx_shape_1" }] })) };
      const savedObjects = { sourceSha256: project.source.sha256, mappingRevision: "mapping-1",
        pages: mapping.pages.map((page, index) => ({ pageId: page.pageId, objects: [{ objectId: "bound-" + index, kind: "shape", index: 1 }] })) };
      if (++reads > 1) {
        if (failure === "source") savedObjects.sourceSha256 = "f".repeat(64);
        if (failure === "revision") savedObjects.mappingRevision = "another";
        if (failure === "order") savedObjects.pages[0].objects[0].index = 2;
        if (failure === "unknown") savedObjects.pages[0].objects[0].kind = "unknown-native";
        if (failure === "missing") savedObjects.pages[0].objects[0].objectId = "replaced-object";
        if (failure === "task") project.taskType = "scene";
        if (failure === "locked") project.pages[0].locked = true;
      }
      return { project, mapping, savedObjects };
    };
    const teaching = f.make(), view = await teaching.open("chat-1");
    assert.deepEqual(view.teachingObjects, [{ objectId: "bound-0", name: "1", aliases: [], status: "mapped",
      savedKind: "shape", savedIndex: 1, effectTargetEligible: true }]);
    const targets = [failure === "foreign" ? "bound-1" : failure === "raw-id" ? "pptx_shape_1" : "bound-0"];
    const actions = [{ ...speech, visualCues: [{ id: "cue-1", atMs: 0, endMs: 1000, effect: { type: "highlight", elementIds: targets } }] }, checkpoint];
    const save = () => teaching.update({ viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision, actions }, false);
    if (failure) {
      await assert.rejects(save(), /object|context|mapping|target|changed/i, taskType + ":" + failure);
      assert.equal(f.calls.filter(([method]) => method === "courseware.teaching.write").length, 0);
    } else {
      const saved = await save();
      assert.deepEqual(saved.project.pages[0].actions, actions);
      assert.deepEqual(saved.project.pages[1], view.project.pages[1]);
      assert.equal(saved.project.pages[0].reviewState, "review");
    }
  }
});

test("draft IPC derives identity and baseline, survives navigation tokens and refuses forged or foreign owners", async () => {
  const f = setup(), teaching = f.make(), original = f.host.call;
  let stored = null;
  f.host.call = async (method, params) => {
    if (!method.startsWith("courseware.teachingDraft.")) return original(method, params);
    assert.equal(params.sessionId, "chat-1");
    assert.equal(params.projectId, fixture.project.projectId);
    assert.equal(params.pageId, fixture.project.pages[0].pageId);
    if (method.endsWith("set")) {
      assert.equal(params.expectedRevision, stored?.revision ?? null);
      if (params.draft) {
        assert.deepEqual(params.draft.baseline, f.project());
        stored = { ...params.draft, pageId: params.pageId, revision: "draft-revision" };
      } else stored = null;
    }
    return { draft: structuredClone(stored) };
  };
  const view = await teaching.open("chat-1");
  const payload = { viewId: view.viewId, expectedRevision: null, draft: { actions: [{ id: "new", type: "speech", text: "" }], instruction: "Short" } };
  assert.equal((await teaching.draft(payload, true)).draft.instruction, "Short");
  f.context.page = 2;
  await teaching.open("chat-1");
  assert.equal((await teaching.draft({ viewId: view.viewId }, false)).draft.revision, "draft-revision");
  await assert.rejects(teaching.draft({ ...payload, projectId: "forged" }, true));
  await assert.rejects(teaching.draft({ ...payload, expectedRevision: 1 }, true));
  await assert.rejects(teaching.draft({ ...payload, draft: { ...payload.draft, instruction: "x".repeat(4001) } }, true));
  await assert.rejects(teaching.draft({ ...payload, draft: { ...payload.draft, baseline: f.project() } }, true));
  f.switchChat();
  await assert.rejects(teaching.draft({ viewId: view.viewId }, false), /owner changed/);
});

test("draft recovery captures the refreshed teaching baseline after explicit audio adoption", async () => {
  const f = setup(), teaching = f.make(), original = f.host.call;
  f.project().pages[0].actions = [{ id: "speech-1", type: "speech", text: "Hello" }];
  const assetId = `tts-${"a".repeat(64)}`;
  f.host.call = async (method, params) => {
    if (method === "courseware.tts.audio.adopt") {
      f.project().pages[0].actions[0].audioAssetId = assetId;
      f.project().teachingRevision = "adopted-audio";
      return { project: structuredClone(f.project()) };
    }
    if (method === "courseware.teachingDraft.set") {
      assert.deepEqual(params.draft.baseline, f.project());
      return { draft: { ...params.draft, pageId: params.pageId, revision: "draft-1" } };
    }
    return original(method, params);
  };
  const view = await teaching.open("chat-1");
  const context = await teaching.ttsContext({ viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision });
  const adopted = await context.adoptAudio({ principalKey: "account", intentId: "intent", actionId: "speech-1", assetId });
  assert.equal(adopted.project.teachingRevision, "adopted-audio");
  const result = await teaching.draft({ viewId: adopted.viewId, expectedRevision: null,
    draft: { actions: [{ id: "speech-1", type: "speech", text: "New text" }], instruction: "" } }, true);
  assert.equal(result.draft.baseline.pages[0].actions[0].audioAssetId, assetId);
});

test("music adoption derives the frozen native page and keeps its existing narration", async () => {
  const f = setup(), teaching = f.make(), before = structuredClone(f.project()), call = f.host.call;
  const assetId = `music-${"c".repeat(64)}`;
  f.host.call = async (method, params) => {
    if (method !== "courseware.mediaCanvas.music.adopt") return call(method, params);
    assert.deepEqual(params, { sessionId: "chat-1", projectId: before.projectId, pageId: before.pages[0].pageId,
      expectedSourceRevision: before.source.revision, expectedTeachingRevision: before.teachingRevision,
      principalKey: "account", intentId: "export", durationMs: 1300 });
    f.project().pages[0].actions.push({ id: "music-action", type: "audio_clip", audioAssetId: assetId });
    f.project().pages[0].reviewState = "review"; f.project().teachingRevision = "music-adopted";
    return { project: structuredClone(f.project()), adoption: { pageId: before.pages[0].pageId, actionId: "music-action", assetId } };
  };
  const view = await teaching.open("chat-1");
  const context = await teaching.ttsContext({ viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision });
  const adopted = await context.adoptMusic({ principalKey: "account", intentId: "export", assetId, durationMs: 1300 });
  assert.equal(adopted.project.teachingRevision, "music-adopted");
  assert.deepEqual(adopted.project.pages[0].actions.slice(0, -1), before.pages[0].actions);
  assert.deepEqual(adopted.project.pages[1], before.pages[1]);
  await assert.rejects(teaching.ttsContext({ viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision }), /view changed/);
});

test("music adoption refuses a changed native page or locked target before Host mutation", async () => {
  for (const locked of [false, true]) {
    const f = setup(); f.project().pages[0].locked = locked;
    const teaching = f.make(), view = await teaching.open("chat-1");
    const context = await teaching.ttsContext({ viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision });
    if (!locked) f.context.page = 2;
    await assert.rejects(context.adoptMusic({ principalKey: "account", intentId: "export", assetId: `music-${"c".repeat(64)}`, durationMs: 1000 }),
      /PAGE_LOCKED|changed/);
    assert(!f.calls.some(([method]) => method === "courseware.mediaCanvas.music.adopt"));
  }
});

test("hidden editor music adoption retains the saved page while TTS still requires the active editor", async () => {
  const f = setup(), teaching = f.make(), before = structuredClone(f.project()), call = f.host.call;
  const assetId = `music-${"c".repeat(64)}`;
  f.host.call = async (method, params) => {
    if (method !== "courseware.mediaCanvas.music.adopt") return call(method, params);
    assert.deepEqual(params, { sessionId: "chat-1", projectId: before.projectId, pageId: before.pages[0].pageId,
      expectedSourceRevision: before.source.revision, expectedTeachingRevision: before.teachingRevision,
      principalKey: "account", intentId: "export", durationMs: 1300 });
    f.project().pages[0].actions.push({ id: "music-action", type: "audio_clip", audioAssetId: assetId });
    f.project().pages[0].reviewState = "review";
    f.project().teachingRevision = "hidden-music-adopted";
    return { project: structuredClone(f.project()), adoption: { pageId: before.pages[0].pageId, actionId: "music-action", assetId } };
  };
  const view = await teaching.open("chat-1");
  const payload = { viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision };
  f.hideEditor();
  await assert.rejects(teaching.ttsContext(payload), /no longer active/);
  const context = await teaching.musicAdoptionContext(payload);
  const adopted = await context.adoptMusic({ principalKey: "account", intentId: "export", assetId, durationMs: 1300 });
  assert.equal(adopted.project.teachingRevision, "hidden-music-adopted");
  assert.deepEqual(adopted.project.pages[0].actions.slice(0, -1), before.pages[0].actions);
  assert.deepEqual(adopted.project.pages[1], before.pages[1]);
});

test("hidden editor music context retains page, source, session, edit generation and owner guards", async () => {
  for (const change of ["page", "dirty", "hash", "revision", "chat", "workspace", "readonly", "owner", "generation", "binding", "pin", "external-file"]) {
    const f = setup(), teaching = f.make(), view = await teaching.open("chat-1");
    const payload = { viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision };
    f.hideEditor();
    const context = await teaching.musicAdoptionContext(payload);
    if (change === "page") f.context.page++;
    if (change === "dirty") f.dirty();
    if (change === "hash") f.snapshot.sha256 = "b".repeat(64);
    if (change === "revision") f.snapshot.revision++;
    if (change === "chat") f.switchChat();
    if (change === "workspace") f.switchWorkspace();
    if (change === "readonly") f.context.readOnly = true;
    if (change === "owner") f.loseOwner();
    if (change === "generation") f.context.editGeneration++;
    if (change === "binding") f.context.sessionId = "another-native-session";
    if (change === "pin") await teaching.open("chat-1");
    if (change === "external-file") f.editor.verifyTeachingSource = async () => { throw new Error("Source file changed outside the editor"); };
    await assert.rejects(context.adoptMusic({ principalKey: "account", intentId: "export", assetId: `music-${"c".repeat(64)}`, durationMs: 1000 }),
      /changed|Save or reopen|belongs/i, change);
    assert(!f.calls.some(([method]) => method === "courseware.mediaCanvas.music.adopt"), change);
  }
});

test("hidden editor music refuses ownership lost during asynchronous source verification", async () => {
  for (const phase of ["context", "adoption"]) {
    const f = setup(), teaching = f.make(), view = await teaching.open("chat-1");
    const payload = { viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision };
    f.hideEditor();
    const context = phase === "adoption" ? await teaching.musicAdoptionContext(payload) : null;
    f.editor.verifyTeachingSource = async () => { await Promise.resolve(); f.loseOwner(); };
    const operation = () => context
      ? context.adoptMusic({ principalKey: "account", intentId: "export", assetId: `music-${"c".repeat(64)}`, durationMs: 1000 })
      : teaching.musicAdoptionContext(payload);
    await assert.rejects(operation(), /belongs/i, phase);
    assert(!f.calls.some(([method]) => method === "courseware.mediaCanvas.music.adopt"), phase);
  }
});

test("ordinary saved Office revision imports its PPTX notes once without replacing later teaching", async () => {
  const f = setup();
  const project = f.project();
  project.taskType = "plain";
  for (const page of project.pages) { page.actions = []; page.locked = false; page.reviewState = "review"; }
  const original = f.host.call;
  f.host.call = async (method, params) => {
    if (method === "courseware.pageNotes") return { text: `讲解第 ${params.pageNumber} 页` };
    if (method === "session.get") return { session: { title: "问候课" } };
    if (method === "courseware.project.initializeGenerated") {
      assert.equal(params.sourceSha256, f.snapshot.sha256);
      assert.deepEqual(params.narrations, ["讲解第 1 页", "讲解第 2 页"]);
      project.title = params.title;
      project.pages.forEach((page, index) => { page.actions = [{ id: "narration-0", type: "speech", text: params.narrations[index] }]; });
      project.teachingRevision = crypto.randomUUID();
      return { project: structuredClone(project) };
    }
    return original(method, params);
  };
  const teaching = f.make();
  const first = await teaching.open("chat-1");
  assert.equal(first.project.pages[0].actions[0].text, "讲解第 1 页");
  await teaching.open("chat-1");
  assert.equal(f.calls.filter(([method]) => method === "courseware.parseStart").length, 1);
  let noteCalls = 0;
  const wrapped = f.host.call;
  f.host.call = async (method, params) => { if (method === "courseware.pageNotes") noteCalls++; return wrapped(method, params); };
  await teaching.open("chat-1");
  assert.equal(noteCalls, 0);
});

test("a plain deck with notes disabled still opens blank teaching, while partial notes stop initialization", async () => {
  for (const partial of [false, true]) {
    const f = setup();
    f.project().taskType = "plain";
    for (const page of f.project().pages) { page.actions = []; page.locked = false; page.reviewState = "review"; }
    const original = f.host.call;
    f.host.call = async (method, params) => {
      if (method === "courseware.pageNotes") {
        if (partial && params.pageNumber === 1) return { text: "第一页讲解" };
        throw new Error("COURSEWARE_NOTES_EMPTY: page has no speaker notes");
      }
      if (method === "courseware.project.initializeGenerated") throw new Error("Unexpected initialization");
      return original(method, params);
    };
    if (partial) await assert.rejects(f.make().open("chat-1"), /部分 PPT 页面没有讲解备注/);
    else assert.deepEqual((await f.make().open("chat-1")).project.pages[0].actions, []);
  }
});

test("imported PPT notes are a current-page preview and never silently write teaching", async () => {
  const f = setup();
  f.project().taskType = "import";
  f.project().pages[0].actions = [];
  const original = f.host.call;
  f.host.call = async (method, params) => method === "courseware.pageNotes"
    ? { text: "原稿第一张备注" } : original(method, params);
  const result = await f.make().importCurrentPageNotes("chat-1");
  assert.equal(result.text, "原稿第一张备注");
  assert.equal(result.view.pageNumber, 1);
  assert.deepEqual(f.project().pages[0].actions, []);
  assert.equal(f.calls.filter(([method]) => method === "courseware.parseStart").length, 2);
  f.project().pages[0].actions = [{ id: "edited", type: "speech", text: "人工已写" }];
  await assert.rejects(f.make().importCurrentPageNotes("chat-1"), /不能从原 PPT 备注导入/);
});

test("saved-page validation tolerates selection changes but keeps source, page and owner checks", async () => {
  for (const change of ["generation", "page", "dirty", "revision", "hash", "chat", "workspace", "readonly"]) {
    const f = setup(), teaching = f.make(), pinned = { ...f.context }, snapshot = { ...f.snapshot };
    if (change === "generation") f.context.editGeneration++;
    if (change === "page") f.context.page++;
    if (change === "dirty") f.dirty();
    if (change === "revision") f.snapshot.revision++;
    if (change === "hash") f.snapshot.sha256 = "b".repeat(64);
    if (change === "chat") f.switchChat();
    if (change === "workspace") f.switchWorkspace();
    if (change === "readonly") f.context.readOnly = true;
    const validate = () => teaching.assertCurrent(snapshot, pinned, "chat-1", f.host, "saved-page");
    if (change === "generation") {
      await validate();
      await assert.rejects(teaching.assertCurrent(snapshot, pinned, "chat-1", f.host));
    } else await assert.rejects(validate(), undefined, change);
  }
});

test("TTS context reuses current saved source, Chat, workspace, native page and retained teaching pin", async () => {
  for (const change of ["dirty", "hide", "chat", "workspace", "page", "generation", "revision", "pin", "teaching"]) {
    const f = setup(), teaching = f.make();
    const view = await teaching.open("chat-1");
    const payload = { viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision };
    const context = await teaching.ttsContext(payload);
    assert.equal(context.host, f.host); assert.equal(context.sessionId, "chat-1");
    assert.equal(context.projectId, view.project.projectId); assert.equal(context.pageId, view.pageId);
    if (change === "dirty") f.dirty();
    if (change === "hide") f.hide();
    if (change === "chat") f.switchChat();
    if (change === "workspace") f.switchWorkspace();
    if (change === "page") f.context.page++;
    if (change === "generation") f.context.editGeneration++;
    if (change === "revision") f.snapshot.revision++;
    if (change === "pin") await teaching.open("chat-1");
    if (change === "teaching") await teaching.update({ ...payload, locked: true }, true);
    await assert.rejects(context.assertCurrent(), undefined, change);
  }
});

test("explicit page confirmation preserves locked teaching and rejects stale, forged or dirty views", async () => {
  const f = setup();
  const teaching = f.make();
  let view = await teaching.open("chat-1");
  view = await teaching.update({ viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision, locked: true }, true);
  const before = structuredClone(view);
  view = await teaching.update({ viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision }, "confirm");
  assert.equal(view.project.pages[0].reviewState, "ready");
  assert.equal(view.project.pages[0].locked, true);
  assert.deepEqual(view.project.pages[0].actions, before.project.pages[0].actions);
  assert.notEqual(view.project.teachingRevision, before.project.teachingRevision);
  await assert.rejects(teaching.update({ viewId: view.viewId, expectedTeachingRevision: before.project.teachingRevision }, "confirm"), /stale/);
  await assert.rejects(teaching.update({ viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision, projectId: "forged" }, "confirm"), /view changed/);
  const count = f.calls.filter(([method]) => method === "courseware.teaching.confirm").length;
  f.dirty();
  await assert.rejects(teaching.update({ viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision }, "confirm"), /Save or reopen/);
  assert.equal(f.calls.filter(([method]) => method === "courseware.teaching.confirm").length, count);
});

function snapshotFixture() {
  const f = setup();
  for (const page of f.project().pages) { page.actions = []; page.reviewState = "ready"; }
  const call = f.host.call;
  f.host.call = async (method, params) => {
    if (method !== "courseware.snapshot.capture") return call(method, params);
    f.calls.push([method, params]);
    return { snapshot: { snapshotId: params.snapshotId, projectId: f.project().projectId,
      source: structuredClone(f.project().source), teachingRevision: f.project().teachingRevision,
      mappingRevision: "mapping-1", assetIds: [] }, sourcePath: "/private/archive.pptx", assets: [] };
  };
  return f;
}

test("snapshot capture derives its source from a fresh saved parser and keeps archive paths private", async () => {
  const f = snapshotFixture(); const teaching = f.make(); const view = await teaching.open("chat-1");
  const input = { viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision };
  for (const forged of [{ path: "/etc/passwd" }, { assets: [] }, { projectId: "other" }])
    await assert.rejects(teaching.captureSnapshot({ ...input, ...forged }), /view changed/);
  const captured = await teaching.captureSnapshot(input);
  assert(shared.isCoursewareSnapshot(captured));
  assert(!JSON.stringify(captured).includes("private"));
  assert.deepEqual(f.calls.find(([method]) => method === "courseware.snapshot.capture")[1], {
    sessionId: "chat-1", jobId: "job-1", snapshotId: captured.snapshotId,
    expectedSourceRevision: view.project.source.revision, expectedTeachingRevision: input.expectedTeachingRevision, assets: [],
  });
  assert.equal(f.calls.filter(([method]) => method === "courseware.parseStart").length, 2);
  assert.equal(f.calls.at(-1)[0], "courseware.parseRelease");
  await teaching.update({ ...input, actions: [] }, false);
});

test("snapshot capture requires speech, music and video while retaining provider and local proofs", async () => {
  const f = snapshotFixture(), hash = "c".repeat(64), speechHash = "d".repeat(64);
  f.project().pages[0].actions = [{ id: "music", type: "audio_clip", audioAssetId: `music-${hash}` }];
  f.project().pages[1].actions = [{ id: "speech", type: "speech", text: "Good", audioAssetId: `tts-${speechHash}` }];
  const videoHash = "e".repeat(64);
  f.project().pages[0].actions.push({ id: "video", type: "video_clip", videoAssetId: `video-${videoHash}` });
  const assets = [{ asset: { id: `music-${hash}`, sha256: hash, mimeType: "audio/mpeg" }, music: { principalKey: "account", intentId: "export" } },
    { asset: { id: `tts-${speechHash}`, sha256: speechHash, mimeType: "audio/wav" }, tts: { principalKey: "account", intentId: "tts" } },
    { asset: { id: `video-${videoHash}`, sha256: videoHash, mimeType: "video/mp4" }, local: true }];
  const call = f.host.call;
  f.host.call = async (method, params) => {
    const result = await call(method, params);
    if (method === "courseware.snapshot.capture") result.snapshot.assetIds = params.assets.map(entry => entry.asset.id).sort();
    return result;
  };
  const teaching = f.make(), view = await teaching.open("chat-1");
  const input = { viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision };
  await assert.rejects(teaching.captureSnapshot(input, assets.slice(1)), /AUDIO_REQUIRED/);
  await assert.rejects(teaching.captureSnapshot(input, assets.slice(0, -1)), /AUDIO_REQUIRED/);
  const snapshot = await teaching.captureSnapshot(input, assets);
  assert.deepEqual(snapshot.assetIds, assets.map(entry => entry.asset.id).sort());
  assert.deepEqual(f.calls.find(([method]) => method === "courseware.snapshot.capture")[1].assets, assets);
});

test("snapshot capture refuses unconfirmed pages, unarchived speech and stale or hidden views", async () => {
  for (const change of ["review", "speech", "revision", "dirty", "chat", "hidden"]) {
    const f = snapshotFixture();
    if (change === "review") f.project().pages[1].reviewState = "review";
    if (change === "speech") f.project().pages[1].actions = [{ id: "speech-1", type: "speech", text: "Good!", audioAssetId: "forged-audio" }];
    const teaching = f.make(); const view = await teaching.open("chat-1");
    if (change === "revision") f.project().teachingRevision = "new-revision";
    if (change === "dirty") f.dirty();
    if (change === "chat") f.switchChat();
    if (change === "hidden") f.hide();
    await assert.rejects(teaching.captureSnapshot({ viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision }),
      /REVIEW_REQUIRED|AUDIO_REQUIRED|Teaching changed|Save or reopen|changed|no longer active/);
    assert(!f.calls.some(([method]) => method === "courseware.snapshot.capture"));
  }
});

test("late snapshot parsing and invalid Host snapshot results never become selectable", async () => {
  for (const change of ["page", "capture"]) {
    const f = snapshotFixture(); const teaching = f.make(); const view = await teaching.open("chat-1");
    const call = f.host.call;
    f.host.call = async (method, params) => {
      const result = await call(method, params);
      if (method === "courseware.parseStatus" && change === "page") f.context.page++;
      if (method === "courseware.snapshot.capture" && change === "capture") result.snapshot.teachingRevision = "forged";
      return result;
    };
    await assert.rejects(teaching.captureSnapshot({ viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision }), /changed|Invalid Host/);
    assert.equal(f.calls.at(-1)[0], "courseware.parseRelease");
    if (change === "page") assert(!f.calls.some(([method]) => method === "courseware.snapshot.capture"));
  }
});

test("media account changes during fresh parsing block capture and late replies never become selectable", async () => {
  for (const stage of ["courseware.parseStatus", "courseware.snapshot.capture"]) {
    const f = snapshotFixture(), teaching = f.make(), view = await teaching.open("chat-1");
    const call = f.host.call; let active = true;
    f.host.call = async (method, params) => { const result = await call(method, params);
      if (method === stage) active = false; return result; };
    await assert.rejects(teaching.captureSnapshot({ viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision }, [],
      () => { if (!active) throw new Error("AUTH_CHANGED"); }), /AUTH_CHANGED/);
    assert.equal(f.calls.filter(([method]) => method === "courseware.snapshot.capture").length, stage === "courseware.parseStatus" ? 0 : 1);
    assert.equal(f.calls.at(-1)[0], "courseware.parseRelease");
  }
});

test("page changes between the retained view guard and fresh parsing reject snapshot capture", async () => {
  const f = snapshotFixture(); const teaching = f.make(); const view = await teaching.open("chat-1");
  const assertCurrent = teaching.assertCurrent.bind(teaching);
  let first = true;
  teaching.assertCurrent = async (...args) => {
    await assertCurrent(...args);
    if (first) { first = false; f.context.page++; }
  };
  await assert.rejects(teaching.captureSnapshot({ viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision }), /view changed/);
  assert(!f.calls.some(([method]) => method === "courseware.snapshot.capture"));
  assert.equal(f.calls.at(-1)[0], "courseware.parseRelease");
});

test("current-page saves, lock and reopen preserve two separate logical pages", async () => {
  const f = setup();
  const teaching = f.make();
  let view = await teaching.open("chat-1");
  assert.equal(view.pageId, "fixture-page-1");
  view = await teaching.update({ viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision, actions: [{ id: "speech-1", type: "speech", text: "First edited" }] }, false);
  f.context.page = 2; f.context.editGeneration++;
  await assert.rejects(teaching.update({ viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision, actions: [] }, false), /current page changed/);
  view = await teaching.open("chat-1");
  assert.equal(view.pageId, "fixture-page-2");
  view = await teaching.update({ viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision, actions: [{ id: "speech-2", type: "speech", text: "Second edited" }] }, false);
  view = await teaching.update({ viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision, locked: true }, true);
  await assert.rejects(teaching.update({ viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision, actions: [] }, false), /locked/);
  f.context.sessionId = f.snapshot.sessionId = "native-2";
  const reopened = await f.make().open("chat-1");
  assert.deepEqual(reopened.project.pages.map((page) => [page.actions[0].text, page.locked]), [["First edited", false], ["Second edited", true]]);
  assert(f.calls.filter(([method]) => method === "courseware.parseStart").every(([, params]) => params.sessionId === "chat-1" && params.path === f.snapshot.path));
  assert.equal(f.calls.filter(([method]) => method === "courseware.parseRelease").length, 2);
});

test("PPTX candidate review is read-only, preview stays Main-private, and rejection is explicit", async () => {
  const f = setup();
  const hash = "d".repeat(64);
  const candidate = { candidateId: "pptx-1", projectId: "course-01", kind: "page-fade", status: "needs-review",
    source: { sha256: f.snapshot.sha256 }, teachingRevision: f.project().teachingRevision, targetPageIds: ["fixture-page-1"],
    outputSha256: hash, pageCount: 2, stale: false, lineageVerified: true, applied: false };
  const call = f.host.call;
  f.host.call = async (method, params) => {
    if (method === "courseware.sourceCandidate.get") return structuredClone(candidate);
    if (method === "courseware.sourceCandidate.preview") return { candidate: structuredClone(candidate), path: "/host/private/candidate.pptx" };
    if (method === "courseware.sourceCandidate.reject") { candidate.status = "rejected"; return { ...candidate }; }
    return call(method, params);
  };
  const teaching = f.make();
  const review = await teaching.reviewPptxCandidate({ sessionId: "chat-1", candidateId: "pptx-1" });
  assert.equal(review.lineageVerified, true);
  assert.equal(review.applied, false);
  assert.equal(candidate.status, "needs-review");
  assert.deepEqual(await teaching.previewPptxCandidate(review.reviewId), { path: "/host/private/candidate.pptx", candidateId: "pptx-1", sha256: hash });
  await assert.rejects(teaching.previewPptxCandidate("forged"), /expired/);
  await teaching.rejectPptxCandidate(review.reviewId);
  assert.equal(candidate.status, "rejected");
  await assert.rejects(teaching.rejectPptxCandidate(review.reviewId), /expired/);
});

test("rebuilt candidate review pins targets and rejects incomplete or changed effect associations before adoption", async () => {
  for (const kind of ["page-pptx", "page-style-batch"]) {
    const f = setup(), call = f.host.call;
    const pageId = f.project().pages[0].pageId;
    f.project().pages[0].actions = [{ id: "speech", type: "speech", text: "Good!", visualCues: [
      { id: "cue", atMs: 0, endMs: 800, effect: { type: "highlight", elementIds: ["old-text", "old-shape"] } },
    ] }];
    const candidate = { candidateId: "pptx-effects", projectId: f.project().projectId, kind, status: "needs-review",
      source: { sha256: f.snapshot.sha256 }, teachingRevision: f.project().teachingRevision,
      targetPageIds: kind === "page-style-batch" ? [pageId, f.project().pages[1].pageId] : [pageId],
      outputSha256: "d".repeat(64), pageCount: 2, stale: false, lineageVerified: true, applied: false,
      effectTargets: [{ pageId, objectId: "old-text", kind: "text", index: 1 }, { pageId, objectId: "old-shape", kind: "shape", index: 2 }],
      effectPages: [{ objects: [{ index: 1, kind: "shape" }, { index: 2, kind: "text" }, { index: 3, kind: "line" }] }, { objects: [] }] };
    let prepares = 0;
    f.host.call = async (method, params) => {
      if (method === "courseware.sourceCandidate.get") return structuredClone(candidate);
      if (method === "courseware.sourceAdoption.prepare") {
        prepares++; assert.deepEqual(params.effectBindings, [{ pageIndex: 0, objectId: "old-text", targetIndex: 2 }, { pageIndex: 0, objectId: "old-shape", targetIndex: 1 }]);
        return { path: "/host/candidate.pptx", adoption: { adoptionId: "adopt-effects", projectId: candidate.projectId, candidateId: candidate.candidateId,
          sourceSha256: f.snapshot.sha256, outputSha256: candidate.outputSha256, sourcePath: params.sourcePath, status: "pending" } };
      }
      return call(method, params);
    };
    const teaching = f.make(), review = await teaching.reviewPptxCandidate({ sessionId: "chat-1", candidateId: candidate.candidateId });
    assert.equal(review.effectTargets[0].pageIndex, 0);
    assert.deepEqual(review.effectCues, [{ pageNumber: 1, effect: "highlight", atMs: 0, endMs: 800 }]);
    const valid = [{ pageIndex: 0, objectId: "old-text", targetIndex: 2 }, { pageIndex: 0, objectId: "old-shape", targetIndex: 1 }];
    for (const bad of [undefined, [], valid.slice(0, 1), [valid[0], { ...valid[1], targetIndex: 2 }],
      [valid[0], { ...valid[1], pageIndex: 1 }], [valid[0], { ...valid[1], targetIndex: 3 }],
      [valid[0], { ...valid[1], extra: true }], [valid[0], { ...valid[1], objectId: "foreign" }]])
      await assert.rejects(teaching.preparePptxAdoption(review.reviewId, "/workspace/lesson.pptx", bad), /effect|association/);
    assert.equal(prepares, 0);
    await teaching.preparePptxAdoption(review.reviewId, "/workspace/lesson.pptx", valid); assert.equal(prepares, 1);
    candidate.effectPages[0].objects[0].kind = "image";
    await assert.rejects(teaching.preparePptxAdoption(review.reviewId, "/workspace/lesson.pptx", valid), /effect targets changed/);
    assert.equal(prepares, 1);
  }
});

test("renderer cannot choose source, workspace or target and changed editor state rejects writes", async () => {
  for (const change of ["dirty", "page", "session", "source", "workspace", "generation", "chat"]) {
    const f = setup(); const teaching = f.make(); const view = await teaching.open("chat-1");
    const input = { viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision, actions: [] };
    await assert.rejects(teaching.update({ ...input, path: "/other" }, false), /view changed/);
    await assert.rejects(teaching.update({ ...input, pageId: "fixture-page-2" }, false), /view changed/);
    if (change === "chat") f.switchChat();
    if (change === "dirty") f.dirty();
    if (change === "page") f.context.page++;
    if (change === "session") f.context.sessionId = "stale";
    if (change === "source") f.snapshot.sha256 = "a".repeat(64);
    if (change === "workspace") f.switchWorkspace();
    if (change === "generation") f.context.editGeneration++;
    await assert.rejects(teaching.update(input, false), /Save or reopen|changed/);
    assert.equal(f.calls.filter(([method]) => method === "courseware.teaching.write").length, 0);
  }
});

for (const kind of ["page-fade", "page-pptx", "page-style-batch"]) test(`${kind} adoption requires a retained verified review and a matching Host intent`, async () => {
  const f = setup(); const call = f.host.call;
  const outputSha256 = "d".repeat(64);
  const candidate = { candidateId: "pptx-1", projectId: f.project().projectId, kind, status: "needs-review",
    source: { sha256: f.snapshot.sha256 }, teachingRevision: f.project().teachingRevision,
    targetPageIds: kind === "page-style-batch" ? ["fixture-page-1", "fixture-page-2"] : ["fixture-page-1"], outputSha256, pageCount: 2, stale: false, lineageVerified: true, applied: false };
  let corrupt = true;
  f.host.call = async (method, params) => {
    if (method === "courseware.sourceCandidate.get") return structuredClone(candidate);
    if (method === "courseware.sourceAdoption.prepare") {
      assert.deepEqual(params, { sessionId: "chat-1", jobId: "job-1", candidateId: "pptx-1", sourcePath: "/workspace/lesson.pptx" });
      return { path: "/host/private/candidate.pptx", adoption: { adoptionId: "adopt-1", projectId: candidate.projectId,
        candidateId: candidate.candidateId, sourceSha256: f.snapshot.sha256, outputSha256: corrupt ? "e".repeat(64) : outputSha256,
        sourcePath: params.sourcePath, status: "pending" } };
    }
    return call(method, params);
  };
  const teaching = f.make();
  await assert.rejects(teaching.preparePptxAdoption("forged", "/workspace/lesson.pptx"), /Review a current/);
  const review = await teaching.reviewPptxCandidate({ sessionId: "chat-1", candidateId: "pptx-1" });
  await assert.rejects(teaching.preparePptxAdoption(review.reviewId, "/workspace/lesson.pptx"), /Invalid source adoption intent/);
  corrupt = false;
  const prepared = await teaching.preparePptxAdoption(review.reviewId, "/workspace/lesson.pptx");
  assert.equal(prepared.host, f.host); assert.equal(prepared.adoption.outputSha256, outputSha256);
  assert.equal(f.calls.at(-1)[0], "courseware.parseRelease");
  f.dirty();
  await assert.rejects(teaching.preparePptxAdoption(review.reviewId, "/workspace/lesson.pptx"), /Save or reopen/);
});

test("redo adoption refuses stale, unverified, dirty and changed ownership before creating an intent", async () => {
  for (const change of ["stale", "unverified", "dirty", "chat", "workspace", "source", "readonly"]) {
    const f = setup(), call = f.host.call; let prepares = 0;
    const candidate = { candidateId: "redo-1", projectId: f.project().projectId, kind: "page-pptx", status: "needs-review",
      source: { sha256: f.snapshot.sha256 }, teachingRevision: f.project().teachingRevision,
      targetPageIds: [f.project().pages[0].pageId], outputSha256: "d".repeat(64), pageCount: 2,
      stale: change === "stale", lineageVerified: change !== "unverified", applied: false };
    f.host.call = async (method, params) => {
      if (method === "courseware.sourceCandidate.get") return structuredClone(candidate);
      if (method === "courseware.sourceAdoption.prepare") { prepares++; assert.fail("Stale adoption dispatched"); }
      return call(method, params);
    };
    const teaching = f.make(), review = await teaching.reviewPptxCandidate({ sessionId: "chat-1", candidateId: "redo-1" });
    if (change === "dirty") f.dirty();
    if (change === "chat") f.switchChat();
    if (change === "workspace") f.switchWorkspace();
    if (change === "source") f.snapshot.sha256 = "e".repeat(64);
    if (change === "readonly") f.context.readOnly = true;
    await assert.rejects(teaching.preparePptxAdoption(review.reviewId, "/workspace/lesson.pptx"), undefined, change);
    assert.equal(prepares, 0, change);
  }
});

test("late parse result cannot initialize teaching for another current page", async () => {
  const f = setup(); const call = f.host.call;
  f.host.call = async (method, params) => { const result = await call(method, params); if (method === "courseware.parseStatus") f.context.page = 2; return result; };
  await assert.rejects(f.make().open("chat-1"), /current page changed/);
  assert(!f.calls.some(([method]) => method === "courseware.project.openSaved"));
  assert.equal(f.calls.at(-1)[0], "courseware.parseRelease");
});

test("cleanup failure invalidates the view; stale caller baselines stay stale", async () => {
  const f = setup(); const teaching = f.make(); const view = await teaching.open("chat-1");
  const input = { viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision, actions: [] };
  await teaching.update(input, false);
  await assert.rejects(teaching.update(input, false), /stale/);
  const call = f.host.call;
  f.host.call = async (method, params) => { if (method === "courseware.parseRelease") throw new Error("disk failure"); return call(method, params); };
  f.snapshot.revision++; // A new saved revision must parse, even after a warm page read.
  await assert.rejects(teaching.open("chat-1"), /cleanup failed/);
  await assert.rejects(teaching.update(input, false), /Open current-page/);
});

test("explicit saved-source review translates indexes using its pinned old pages and reparses before CAS", async () => {
  const f = setup();
  const call = f.host.call;
  const hostReview = { reviewId: "host-review-1", project: structuredClone(f.project()), pageCount: 2, targetSha256: f.snapshot.sha256 };
  f.host.call = async (method, params) => {
    if (method === "courseware.review.prepare") { f.calls.push([method, params]); return structuredClone(hostReview); }
    if (method === "courseware.review.adopt") {
      f.calls.push([method, params]);
      assert.equal(params.reviewId, hostReview.reviewId);
      assert.deepEqual(params.bindings, ["fixture-page-2", "fixture-page-1"]);
      f.project().pages.reverse();
      return { project: structuredClone(f.project()) };
    }
    return call(method, params);
  };
  const teaching = f.make();
  const review = await teaching.prepareReview("chat-1");
  assert.notEqual(review.reviewId, hostReview.reviewId);
  await assert.rejects(teaching.adoptReview({ reviewId: review.reviewId, bindings: [1, 0], path: "/forged" }), /Review changed/);
  await assert.rejects(teaching.adoptReview({ reviewId: review.reviewId, bindings: [9, 0] }), /Invalid page/);
  f.context.page = 2;
  f.context.editGeneration++;
  const view = await teaching.adoptReview({ reviewId: review.reviewId, bindings: [1, 0] });
  assert.equal(view.pageId, "fixture-page-1");
  assert.equal(f.calls.filter(([method]) => method === "courseware.parseStart").length, 2);
  assert.equal(f.calls.filter(([method]) => method === "courseware.parseRelease").length, 2);
  await assert.rejects(teaching.adoptReview({ reviewId: review.reviewId, bindings: [1, 0] }), /Review changed/);
});

test("review cannot adopt after Chat, source, dirty native state or readonly changes", async () => {
  for (const change of ["chat", "source", "dirty", "readonly"]) {
    const f = setup(); const call = f.host.call;
    f.host.call = async (method, params) => method === "courseware.review.prepare" ?
      { reviewId: "review-host", project: structuredClone(f.project()), pageCount: 2, targetSha256: f.snapshot.sha256 } : call(method, params);
    const teaching = f.make(); const review = await teaching.prepareReview("chat-1");
    if (change === "chat") f.switchChat();
    if (change === "source") f.snapshot.sha256 = "b".repeat(64);
    if (change === "dirty") f.dirty();
    if (change === "readonly") f.context.readOnly = true;
    await assert.rejects(teaching.adoptReview({ reviewId: review.reviewId, bindings: [0, 1] }), /changed|Save or reopen/);
    assert(!f.calls.some(([method]) => method === "courseware.review.adopt"));
  }
});

test("saved-source effect review pins every old target and rejects omitted, merged or cross-page associations before Host", async () => {
  const f = setup(); const call = f.host.call;
  f.project().pages[0].actions = [{ id: "speech", type: "speech", text: "Find both.", audioAssetId: `tts-${"a".repeat(64)}`,
    visualCues: [{ id: "cue", atMs: 0, endMs: 800, effect: { type: "highlight", elementIds: ["old-text", "old-shape"] } }] }];
  const hostReview = { reviewId: "host-effects", project: structuredClone(f.project()), pageCount: 2, targetSha256: f.snapshot.sha256,
    effectTargets: ["old-text", "old-shape"].map((objectId, index) => ({ pageId: f.project().pages[0].pageId, objectId, index: index + 1, kind: index ? "shape" : "text" })),
    targetPages: [{ objects: [{ index: 1, kind: "shape" }, { index: 2, kind: "text" }, { index: 3, kind: "line" }] }, { objects: [{ index: 1, kind: "text" }] }] };
  f.host.call = async (method, params) => {
    if (method === "courseware.review.prepare") return structuredClone(hostReview);
    if (method === "courseware.review.adopt") { f.calls.push([method, params]); return { project: structuredClone(f.project()) }; }
    return call(method, params);
  };
  const teaching = f.make(), review = await teaching.prepareReview("chat-1");
  const effectBindings = [{ pageIndex: 0, objectId: "old-text", targetIndex: 2 }, { pageIndex: 0, objectId: "old-shape", targetIndex: 1 }];
  for (const effects of [undefined, [], effectBindings.slice(0, 1), [effectBindings[0], { ...effectBindings[1], targetIndex: 2 }],
    [effectBindings[0], { ...effectBindings[1], pageIndex: 1 }], [effectBindings[0], { ...effectBindings[1], objectId: "raw-ooxml" }],
    [effectBindings[0], { ...effectBindings[1], targetIndex: 3 }], [effectBindings[0], { ...effectBindings[1], targetIndex: 99 }],
    [effectBindings[0], { ...effectBindings[1], extra: true }]]) {
    await assert.rejects(teaching.adoptReview({ reviewId: review.reviewId, bindings: [0, 1], ...(effects === undefined ? {} : { effectBindings: effects }) }), /effect|association/);
  }
  await assert.rejects(teaching.adoptReview({ reviewId: review.reviewId, bindings: [null, 1], effectBindings }), /effect|association/);
  assert(!f.calls.some(([method]) => method === "courseware.review.adopt"));
  await teaching.adoptReview({ reviewId: review.reviewId, bindings: [0, 1], effectBindings });
  assert.deepEqual(f.calls.find(([method]) => method === "courseware.review.adopt")[1].effectBindings, effectBindings);
  assert.equal(f.calls.filter(([method]) => method === "courseware.parseStart").length, 2);
});

test("source review refuses a Host projection omitting cue targets or inventing eligible kinds", async () => {
  for (const patch of [{ effectTargets: [] }, { kind: "line" }, { targetPages: [] }, { effect: "native" }]) {
    const f = setup(); const call = f.host.call;
    f.project().pages[0].actions = [{ id: "speech", type: "speech", text: "Find it.", visualCues: [
      { id: "cue", atMs: 0, endMs: 800, effect: patch.effect ? { type: "native", elementId: "old" } : { type: "highlight", elementIds: ["old"] } }] }];
    f.host.call = async (method, params) => method === "courseware.review.prepare" ? {
      reviewId: "review", project: structuredClone(f.project()), pageCount: 2, targetSha256: f.snapshot.sha256,
      effectTargets: patch.effectTargets ?? [{ pageId: f.project().pages[0].pageId, objectId: "old", index: 1, kind: patch.kind ?? "text" }],
      targetPages: patch.targetPages ?? [{ objects: [] }, { objects: [] }],
    } : call(method, params);
    await assert.rejects(f.make().prepareReview("chat-1"), /source-review|effect/);
  }
});


function narrationSetup() {
  const f = setup();
  const original = f.host.call;
  const candidate = { candidateId: "candidate-1", kind: "page-narration", status: "needs-review", audioReady: false,
    write: { projectId: f.project().projectId, pageId: f.project().pages[0].pageId,
      expectedSourceRevision: f.project().source.revision, expectedTeachingRevision: f.project().teachingRevision,
      actions: [{ id: "new-speech", type: "speech", text: "Good! What do you see?", pauseAfterMs: 4000 }] } };
  let late;
  f.host.call = async (method, params) => {
    if (method.startsWith("courseware.narrationCandidate.")) {
      f.calls.push([method, structuredClone(params)]);
      assert.equal(params.sessionId, "chat-1");
      if (method.endsWith("get")) { assert.equal(params.projectId, f.project().projectId); late?.(); return structuredClone(candidate); }
      if (method.endsWith("adopt")) {
        assert.equal(params.jobId, "job-1");
        assert.equal(candidate.status, "needs-review");
        const result = await original("courseware.teaching.write", { sessionId: params.sessionId, write: candidate.write });
        candidate.status = "adopted";
        return result;
      }
      assert(method.endsWith("reject")); candidate.status = "rejected"; return structuredClone(candidate);
    }
    return original(method, params);
  };
  return { ...f, candidate, late(fn) { late = fn; } };
}

test("known narration receipt is reviewed without applying; explicit adopt updates only its page", async () => {
  const f = narrationSetup(); const teaching = f.make();
  const before = structuredClone(f.project());
  const review = await teaching.reviewNarration({ sessionId: "chat-1", candidateId: "candidate-1" });
  assert.equal(review.stale, false); assert.equal(review.status, "needs-review");
  assert.equal(review.actions[0].pauseAfterMs, 4000); assert.deepEqual(f.project(), before);
  assert.equal(review.teaching.pageId, before.pages[0].pageId);
  await assert.rejects(teaching.decideNarration({ reviewId: review.reviewId, decision: "adopt", actions: [] }), /review changed/);
  const adopted = await teaching.decideNarration({ reviewId: review.reviewId, decision: "adopt" });
  assert.deepEqual(adopted.project.pages[0].actions, review.actions);
  assert.deepEqual(adopted.project.pages.slice(1), before.pages.slice(1));
  assert.deepEqual(adopted.project.source, before.source);
  await assert.rejects(teaching.decideNarration({ reviewId: review.reviewId, decision: "adopt" }), /review changed/);
  const recovered = await f.make().reviewNarration({ sessionId: "chat-1", candidateId: "candidate-1" });
  assert.equal(recovered.status, "adopted");
  await assert.rejects(teaching.decideNarration({ reviewId: recovered.reviewId, decision: "reject" }), /review changed/);
  assert.equal(f.calls.filter(([method]) => method === "courseware.parseRelease").length, 3);
});

test("stale and terminal proposals are visible for recovery but cannot be adopted", async () => {
  const f = narrationSetup(); const teaching = f.make();
  f.candidate.write.expectedTeachingRevision = "old-revision";
  const before = structuredClone(f.project());
  const review = await teaching.reviewNarration({ sessionId: "chat-1", candidateId: "candidate-1" });
  assert.equal(review.stale, true);
  await assert.rejects(teaching.decideNarration({ reviewId: review.reviewId, decision: "adopt" }), /stale/);
  await teaching.decideNarration({ reviewId: review.reviewId, decision: "reject" });
  assert.deepEqual(f.project(), before);
  const reopened = await f.make().reviewNarration({ sessionId: "chat-1", candidateId: "candidate-1" });
  assert.equal(reopened.status, "rejected");
});

test("candidate receipt, page and active native-owner boundaries cannot be forged", async () => {
  for (const change of ["input", "page", "project", "kind", "status", "audio", "effect", "pause", "owner", "late-owner", "late-page"]) {
    const f = narrationSetup(); const teaching = f.make();
    const input = { sessionId: "chat-1", candidateId: "candidate-1" };
    if (change === "input") input.path = "/etc/passwd";
    if (change === "page") f.candidate.write.pageId = "fixture-page-2";
    if (change === "project") f.candidate.write.projectId = "other-project";
    if (change === "kind") f.candidate.kind = "page-fade";
    if (change === "status") f.candidate.status = "unknown";
    if (change === "audio") f.candidate.audioReady = true;
    if (change === "effect") f.candidate.write.actions[0].visualCues = [];
    if (change === "pause") f.candidate.write.actions[0].pauseAfterMs = -1;
    if (change === "owner") f.hide();
    if (change === "late-owner") f.late(() => f.hide());
    if (change === "late-page") f.late(() => f.context.page++);
    await assert.rejects(teaching.reviewNarration(input), /Invalid|another page|active|changed/);
    assert(!f.calls.some(([method]) => method.endsWith(".adopt") || method.endsWith(".reject")));
  }
});

test("dirty, hidden, switched or changed native reviews cannot mutate candidates; fresh parses are fenced too", async () => {
  for (const change of ["dirty", "owner", "page", "binding", "revision", "hash", "generation", "workspace", "chat", "readonly", "external-file", "late-parse"]) {
    const f = narrationSetup(); const teaching = f.make();
    const review = await teaching.reviewNarration({ sessionId: "chat-1", candidateId: "candidate-1" });
    if (change === "dirty") f.dirty();
    if (change === "owner") f.hide();
    if (change === "page") f.context.page++;
    if (change === "binding") f.context.sessionId = "another-native-session";
    if (change === "revision") f.snapshot.revision++;
    if (change === "hash") f.snapshot.sha256 = "c".repeat(64);
    if (change === "generation") f.context.editGeneration++;
    if (change === "workspace") f.switchWorkspace();
    if (change === "chat") f.switchChat();
    if (change === "readonly") f.context.readOnly = true;
    if (change === "external-file") f.editor.verifyTeachingSource = async () => { throw new Error("Source file changed outside the editor"); };
    if (change === "late-parse") {
      const call = f.host.call;
      f.host.call = async (method, params) => { const result = await call(method, params); if (method === "courseware.parseStatus") f.context.editGeneration++; return result; };
    }
    await assert.rejects(teaching.decideNarration({ reviewId: review.reviewId, decision: "adopt" }), /Save or reopen|changed|active/);
    assert.equal(f.candidate.status, "needs-review");
    assert(!f.calls.some(([method]) => method === "courseware.narrationCandidate.adopt"));
  }
});

test("lost commit reply requires persisted-status recovery and never retries adoption", async () => {
  const f = narrationSetup(); const teaching = f.make();
  const review = await teaching.reviewNarration({ sessionId: "chat-1", candidateId: "candidate-1" });
  const call = f.host.call;
  f.host.call = async (method, params) => { const result = await call(method, params); if (method === "courseware.narrationCandidate.adopt") throw new Error("Reply lost"); return result; };
  await assert.rejects(teaching.decideNarration({ reviewId: review.reviewId, decision: "adopt" }), /Reply lost/);
  await assert.rejects(teaching.decideNarration({ reviewId: review.reviewId, decision: "adopt" }), /review changed/);
  const recovered = await teaching.reviewNarration({ sessionId: "chat-1", candidateId: "candidate-1" });
  assert.equal(recovered.status, "adopted");
  assert.equal(f.calls.filter(([method]) => method === "courseware.narrationCandidate.adopt").length, 1);
});


test("native navigation during live-source hashing rejects the existing teaching write", async () => {
  const f = setup(); const teaching = f.make(); const view = await teaching.open("chat-1");
  f.editor.verifyTeachingSource = async () => { f.context.page++; f.context.editGeneration++; };
  await assert.rejects(teaching.update({ viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision, actions: [] }, false), /current page changed/);
  assert(!f.calls.some(([method]) => method === "courseware.teaching.write"));
});

test("replacement parser releases the original first, keeps exclusive ownership and cleans a failed output", async () => {
  const f = setup(); const teaching = f.make();
  await assert.rejects(teaching.withSaved("chat-1", async (_host, _jobId, _snapshot, _context, _sessionId, parseOutput) => {
    await assert.rejects(teaching.open("chat-1"), /already opening/);
    await parseOutput("/workspace/candidate.pptx", "c".repeat(64));
  }), /Parsed source differs/);
  assert.deepEqual(f.calls.filter(([method]) => !method.endsWith("Status")).map(([method]) => method), [
    "courseware.parseStart", "courseware.project.attach", "courseware.parseRelease", "courseware.parseStart", "courseware.parseRelease",
  ]);
  await teaching.open("chat-1");
});

test("abort during replacement parsing cancels and releases that exact job", async () => {
  const f = setup(); const teaching = f.make(); const controller = new AbortController();
  const call = f.host.call; let output = false, cancelled = false;
  f.host.call = async (method, params) => {
    if (method === "courseware.parseStart" && params.path.endsWith("candidate.pptx")) output = true;
    const result = await call(method, params);
    if (method === "courseware.parseCancel") cancelled = true;
    if (output && method === "courseware.parseStatus" && !cancelled) { controller.abort(); return { status: "RUNNING" }; }
    return result;
  };
  await assert.rejects(teaching.withSaved("chat-1", async (_host, _jobId, _snapshot, _context, _sessionId, parseOutput) => {
    await parseOutput("/workspace/candidate.pptx", "c".repeat(64));
  }, controller.signal));
  assert.equal(cancelled, true);
  assert.equal(f.calls.at(-1)[0], "courseware.parseRelease");
});

test("batch review lists every numbered target and refuses scope drift before adoption", async () => {
  const f = setup(), call = f.host.call;
  const candidate = { candidateId: "batch", projectId: f.project().projectId, kind: "page-style-batch", status: "needs-review",
    source: { sha256: f.snapshot.sha256 }, teachingRevision: f.project().teachingRevision,
    targetPageIds: ["fixture-page-1", "fixture-page-2"], outputSha256: "d".repeat(64), pageCount: 2,
    stale: false, lineageVerified: true, applied: false };
  let prepares = 0;
  f.host.call = async (method, params) => {
    if (method === "courseware.sourceCandidate.get") return structuredClone(candidate);
    if (method === "courseware.sourceAdoption.prepare") { prepares++; assert.fail("Changed batch scope cannot be adopted"); }
    return call(method, params);
  };
  const teaching = f.make();
  const review = await teaching.reviewPptxCandidate({ sessionId: "chat-1", candidateId: "batch" });
  assert.deepEqual(review.targetPages, [{ pageId: "fixture-page-1", pageNumber: 1 }, { pageId: "fixture-page-2", pageNumber: 2 }]);
  candidate.targetPageIds.reverse();
  await assert.rejects(teaching.preparePptxAdoption(review.reviewId, "/workspace/lesson.pptx"), /scope or output changed/);
  assert.equal(prepares, 0);
  for (const ids of [["fixture-page-1"], ["fixture-page-1", "fixture-page-1"], ["fixture-page-1", "foreign"]]) {
    candidate.targetPageIds = ids;
    await assert.rejects(teaching.reviewPptxCandidate({ sessionId: "chat-1", candidateId: "batch" }), /Invalid or outdated/);
  }
});


test("native preview exposes only current mapped shape proofs, never original or ordinal IDs", () => {
  const project = structuredClone(fixture.project); project.taskType = "scene";
  const pageId = project.pages[0].pageId;
  const raw = { project, sceneObjects: { schemaVersion: "deckwise-scene-objects/1",
    sourceSha256: project.source.sha256, requiresReview: true, pages: [{ pageId, objects:
      ["mapped", "missing", "content_changed", "identity_mismatch"].map((status, index) => ({
        objectId: `object-${index}`, status, currentSourceShapeId: "42",
        element: { elementId: "layer", objectName: "compiler-layer", sourceShapeId: "old", type: "image_layer", spokenAliases: [] },
      })),
    }] } };
  const result = semantics.exports.objectsForTeaching(raw, project, pageId);
  assert.equal(result[0].sourceShapeId, "42");
  assert.equal(result[0].sourceObjectName, "compiler-layer");
  assert(result.slice(1).every(object => object.sourceObjectName === undefined));
  assert(result.slice(1).every(object => object.sourceShapeId === undefined));
  delete raw.sceneObjects.pages[0].objects[0].currentSourceShapeId;
  assert.equal(semantics.exports.objectsForTeaching(raw, project, pageId)[0].sourceShapeId, undefined);
});

test("video reuse commits only to its pinned page and rejects a late page change", async () => {
  for (const navigate of [false, true]) {
    const f = setup(), teaching = f.make(), call = f.host.call;
    const view = await teaching.open("chat-1"), assetId = `video-${"a".repeat(64)}`;
    f.host.call = async (method, params) => {
      if (method !== "courseware.video.reuse") return call(method, params);
      assert.equal(params.pageId, view.pageId);
      assert.equal(params.expectedSourceRevision, view.project.source.revision);
      f.project().pages[0].actions.push({ id: params.actionId, type: "video_clip", videoAssetId: assetId });
      f.project().teachingRevision = "reused-video";
      if (navigate) f.context.page = 2;
      return { project: structuredClone(f.project()) };
    };
    const pending = teaching.reuseVideo({ viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision,
      principalKey: "a".repeat(64), intentId: "old-video", actionId: "new-video", assetId });
    if (navigate) await assert.rejects(pending, /changed|Save|page/i);
    else assert.equal((await pending).project.pages[0].actions.at(-1).id, "new-video");
    assert.equal(f.project().pages[1].actions.some(a => a.id === "new-video"), false);
  }
});

test("native timeline writes preserve exact-source steps through Desktop and reject malformed or stale bindings", async () => {
  const f = setup(), coordinator = f.make();
  let view = await coordinator.open("chat-1");
  const original = structuredClone(view.project.pages[0].actions);
  const node = { id: "native-step", type: "native_animation", version: 1,
    sourceSha256: view.project.source.sha256, stepIndex: 0 };
  const actions = [...original, node];
  view = await coordinator.update({ viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision, actions }, false);
  assert.deepEqual(view.project.pages[0].actions, actions);
  const writes = () => f.calls.filter(([method]) => method === "courseware.teaching.write");
  const count = writes().length;
  for (const invalid of [{ ...node, version: 2 }, { ...node, stepIndex: 1 }, { ...node, target: "untrusted-runtime-id" }]) {
    await assert.rejects(coordinator.update({ viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision,
      actions: [...original, invalid] }, false), /Invalid teaching update/);
    assert.equal(writes().length, count);
  }
  await assert.rejects(coordinator.update({ viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision,
    actions: [...original, { ...node, sourceSha256: "f".repeat(64) }] }, false), /stale/);
  assert.deepEqual(f.project().pages[0].actions, actions);
});

test("complete project copy uses saved source and retains the unchanged teaching sidebar", async () => {
  const f = setup(); const teaching = f.make();
  const original = f.host.call;
  const before = structuredClone(f.project());
  f.host.call = async (method, params) => {
    if (method !== "courseware.project.copy") return original(method, params);
    assert.deepEqual(params, { sessionId: "chat-1", jobId: "job-1",
      expectedSourceRevision: before.source.revision, expectedTeachingRevision: before.teachingRevision });
    return { path: "/workspace/courseware-copies/copy.deckwise", mediaCount: 2,
      sourceSha256: before.source.sha256, teachingRevision: before.teachingRevision };
  };
  const view = await teaching.open("chat-1");
  assert.deepEqual(await teaching.copyProject("chat-1"), { path: "/workspace/courseware-copies/copy.deckwise", mediaCount: 2 });
  const context = await teaching.ttsContext({ viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision });
  assert.equal(context.projectId, view.project.projectId);
  assert.deepEqual(f.project(), before);
  assert.equal(f.calls.filter(([method]) => method === "courseware.parseRelease").length, 2);
});

test("copy failure leaves an unchanged teaching view usable and never regenerates media", async () => {
  const f = setup(); const teaching = f.make();
  const original = f.host.call;
  f.host.call = async (method, params) => {
    if (method === "courseware.project.copy") throw new Error("portable media is missing");
    return original(method, params);
  };
  const view = await teaching.open("chat-1");
  await assert.rejects(teaching.copyProject("chat-1"), /media is missing/);
  await teaching.ttsContext({ viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision });
  assert(!f.calls.some(([method]) => /\.begin$|\.prepare$|\.stage$|\.submit$/.test(method)));
});

test("copy rejects dirty, inactive and forged sessions before creating a copy", async () => {
  for (const mode of ["dirty", "inactive", "forged"]) {
    const f = setup(); const teaching = f.make();
    if (mode === "dirty") f.dirty();
    if (mode === "inactive") f.switchChat();
    await assert.rejects(teaching.copyProject(mode === "forged" ? { sessionId: "chat-1", path: "/outside" } : "chat-1"));
    assert(!f.calls.some(([method]) => method === "courseware.project.copy"));
  }
});

test("copy refuses stale native context and malformed Host receipts", async () => {
  for (const mode of ["switch-chat", "source", "revision", "count", "path"]) {
    const f = setup(); const teaching = f.make();
    const original = f.host.call;
    f.host.call = async (method, params) => {
      if (method !== "courseware.project.copy") return original(method, params);
      if (mode === "switch-chat") f.switchChat();
      return { path: mode === "path" ? null : "/workspace/copy.deckwise", mediaCount: mode === "count" ? -1 : 0,
        sourceSha256: mode === "source" ? "f".repeat(64) : f.project().source.sha256,
        teachingRevision: mode === "revision" ? "stale" : f.project().teachingRevision };
    };
    await assert.rejects(teaching.copyProject("chat-1"));
    assert(f.calls.some(([method]) => method === "courseware.parseRelease"));
  }
});

test("copy retains an unchanged prepared review, but parser cleanup failure invalidates views", async () => {
  const f = setup(), teaching = f.make();
  const original = f.host.call;
  let cleanupFails = false;
  f.host.call = async (method, params) => {
    if (method === "courseware.review.prepare") return { reviewId: "host-review", project: structuredClone(f.project()), pageCount: 2, targetSha256: f.snapshot.sha256 };
    if (method === "courseware.review.adopt") return { project: structuredClone(f.project()) };
    if (method === "courseware.project.copy") return { path: "/workspace/copy.deckwise", mediaCount: 0,
      sourceSha256: f.snapshot.sha256, teachingRevision: f.project().teachingRevision };
    if (method === "courseware.parseRelease" && cleanupFails) throw new Error("disk failure");
    return original(method, params);
  };
  const review = await teaching.prepareReview("chat-1");
  await teaching.copyProject("chat-1");
  const view = await teaching.adoptReview({ reviewId: review.reviewId, bindings: [0, 1] });
  cleanupFails = true;
  await assert.rejects(teaching.copyProject("chat-1"), /cleanup failed/);
  await assert.rejects(teaching.ttsContext({ viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision }));
});

test("switching teaching pages reuses parsed saved source while reading fresh canonical teaching", async () => {
  const f = setup(), coordinator = f.make();
  const first = await coordinator.open("chat-1");
  f.project().pages[1].actions[0].text = "Updated by Chat";
  f.project().teachingRevision = "chat-updated-revision";
  f.context.page = 2;
  const second = await coordinator.open("chat-1");
  assert.equal(first.pageNumber, 1);
  assert.equal(second.pageNumber, 2);
  assert.equal(second.project.pages[1].actions[0].text, "Updated by Chat");
  assert.equal(second.project.teachingRevision, "chat-updated-revision");
  assert.equal(f.calls.filter(([method]) => method === "courseware.parseStart").length, 1);
});

for (const change of ["revision", "path", "documentId", "sourcePath"]) test(`saved teaching read reparses after ${change} changes`, async () => {
  const f = setup(), teaching = f.make();
  await teaching.open("chat-1");
  if (change === "revision") f.snapshot.revision++;
  else f.snapshot[change] += "-changed";
  if (change === "documentId") f.context.documentId = f.snapshot.documentId;
  await teaching.open("chat-1");
  assert.equal(f.calls.filter(([method]) => method === "courseware.parseStart").length, 2);
});

test("warm teaching reads reject dirty source and never bypass saved-source checks", async () => {
  const f = setup(), teaching = f.make();
  await teaching.open("chat-1"); f.dirty();
  await assert.rejects(teaching.open("chat-1"), /Save or reopen/);
  assert.equal(f.calls.filter(([method]) => method === "courseware.parseStart").length, 1);
});

for (const change of ["readonly", "external-source", "project-source"]) test(`warm teaching reads reject ${change} and invalidate the saved read`, async () => {
  const f = setup(), teaching = f.make();
  await teaching.open("chat-1");
  const verify = f.editor.verifyTeachingSource;
  const originalSource = f.project().source.sha256;
  if (change === "readonly") f.context.readOnly = true;
  if (change === "external-source") f.editor.verifyTeachingSource = async () => { throw new Error("external source changed"); };
  if (change === "project-source") f.project().source.sha256 = "f".repeat(64);
  await assert.rejects(teaching.open("chat-1"));
  f.context.readOnly = false;
  f.editor.verifyTeachingSource = verify;
  f.project().source.sha256 = originalSource;
  await teaching.open("chat-1");
  assert.equal(f.calls.filter(([method]) => method === "courseware.parseStart").length, 2);
});
