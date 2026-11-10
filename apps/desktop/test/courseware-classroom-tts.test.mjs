import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import test from "node:test";
import ts from "typescript";
import * as runtime from "../../../packages/courseware-runtime/dist/node.mjs";
const exports = {};
new Function("require", "exports", ts.transpileModule(await readFile(new URL("../electron/main/courseware-classroom-tts.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)((id) => {
  if (id === "node:crypto") return { createHash, randomUUID };
  if (id === "node:fs/promises") return { mkdir, readFile, writeFile };
  if (id === "node:path") return { dirname };
  if (id === "@pi-desktop/courseware-runtime/node") return runtime;
  if (id === "./courseware-media-scope") return { coursewareMediaSubmissionProject: (scope, sessionId) => {
    assert.equal(scope.sessionId, sessionId); return scope.teamProjectId ?? undefined;
  } };
  if (id === "./fs-panel") return { resolveRealPathForCreateWithinRoot: async (root, path) => join(root, path) };
  throw new Error(id);
}, exports);
const { CoursewareClassroomTts } = exports;
function fixture(root = "/unused", nativeTeaching = false) {
  const args = { sessionId: "session", projectId: "project", expectedRevision: "revision-1", expectedSourceRevision: "source-1",
    sceneId: "quiz", actionId: "speech", model: "model", voice: "voice" };
  let view = { nativeTeaching, projectId: "project", revision: "revision-1", sourceRevision: "source-1", classroom: { id: "classroom", createdAt: "2026-01-01",
    stage: { id: "stage", name: "Lesson", createdAt: 1, updatedAt: 1 }, scenes: [{ id: "quiz", stageId: "stage", type: "quiz", title: "Quiz", order: 0,
      content: { type: "quiz", questions: [{ id: "q", type: "single", question: "Hello?", options: [{ value: "A", label: "Hello" }, { value: "B", label: "Bye" }], answer: ["A"] }] },
      actions: [{ id: "speech", type: "speech", text: "Choose a greeting" }] }] } };
  const calls = [], tasks = new Map(), bytes = Buffer.from("RIFFtest-audio");
  let principal = "principal-1", sessionOwned = true, corrupt = false;
  const host = { async call(method, payload) {
    calls.push({ method, payload });
    if (method === "courseware.classroom.get") return structuredClone(view);
    if (method === (nativeTeaching ? "courseware.mediaRelay.scope" : "courseware.classroom.mediaScope")) return { sessionId: "session", teamProjectId: "team-project" };
    if (method === "courseware.classroom.write") {
      assert.equal(payload.expectedRevision, view.revision); assert.equal(payload.expectedSourceRevision, view.sourceRevision);
      view = { ...view, revision: "revision-2", classroom: payload.classroom }; return structuredClone(view);
    }
    throw Error(method);
  } };
  const auth = { getCoursewarePrincipal() { const captured = principal; return { key: captured, assertCurrent() { assert.equal(captured, principal, "principal changed"); } }; },
    coursewareMedia: {
      async getTtsModels() { return [{ model: "model", voices: ["voice"], providerDefaultVoice: false }]; },
      async getTtsQuote() { return { model: "model", maxChars: 4000, maxPoints: 3, expiresAt: new Date(Date.now() + 60000).toISOString() }; },
      async findTts(ref) { return tasks.get(ref.idempotencyKey) ?? null; },
      async submitConfirmedTts(key, request, quote, signal, projectId, check, admit) {
        await check(); const team = await admit(); assert.equal(team, "team-project");
        calls.push({ method: "submit", key, request });
        const task = { taskId: "task", idempotencyKey: key, requestHash: Array.from(tasks.values())[0]?.requestHash,
          state: "running", model: request.model };
        tasks.set(key, task); return task;
      },
      async get(ref) { return tasks.get(ref.idempotencyKey); },
      async download(ref) { return { task: tasks.get(ref.idempotencyKey), bytes: corrupt ? Buffer.from("corrupt") : bytes }; },
    } };
  const coordinator = new CoursewareClassroomTts({ auth, ...(nativeTeaching ? { adoptNative: async (args, asset) => {
    calls.push({ method: 'native-adopt' });
    view.classroom.scenes[0].actions[0].audioId = 'tts-' + asset.sha256;
    view.revision = 'revision-2'; view.sourceRevision = 'source-2';
    return structuredClone(view);
  } } : {}), open: async () => structuredClone(view), getHost: () => host, getWorkspace: async () => root,
    assertOwned() { assert(sessionOwned, "session changed"); }, decodeAudio: async () => 1000 });
  return { coordinator, args, calls, tasks, bytes, setPrincipal: value => { principal = value; }, setOwned: value => { sessionOwned = value; },
    setCorrupt: () => { corrupt = true; }, setRevision: value => { view.revision = value; }, getView: () => view };
}
test("canonical-only TTS requires quoted confirmation and routes via Host scoped team admission", async () => {
  const f = fixture(); await assert.rejects(f.coordinator.submit(f.args), /Confirm a current narration quote/);
  const quote = await f.coordinator.quote(f.args); assert.equal(quote.quote.maxPoints, 3);
  const task = await f.coordinator.submit({ ...f.args, quoteId: quote.quote.quoteId });
  assert.equal(task.state, "running"); assert.equal(f.calls.filter(call => call.method === "submit").length, 1);
});
test("identical retry finds durable relay task without a second submission", async () => {
  const f = fixture(), first = await f.coordinator.quote(f.args);
  await f.coordinator.submit({ ...f.args, quoteId: first.quote.quoteId });
  const second = await f.coordinator.quote(f.args);
  await f.coordinator.submit({ ...f.args, quoteId: second.quote.quoteId });
  assert.equal(first.key, second.key); assert.equal(f.calls.filter(call => call.method === "submit").length, 1);
});
test("manual regeneration creates a fresh task for the saved version and keeps retries idempotent", async () => {
  const f = fixture(), original = await f.coordinator.quote(f.args);
  await f.coordinator.submit({ ...f.args, quoteId: original.quote.quoteId });
  const input = { ...f.args, regenerate: true }, first = await f.coordinator.quote(input);
  await f.coordinator.submit({ ...input, quoteId: first.quote.quoteId });
  const retry = await f.coordinator.quote(input);
  await f.coordinator.submit({ ...input, quoteId: retry.quote.quoteId });
  assert.notEqual(original.key, first.key); assert.equal(first.key, retry.key);
  f.setRevision('adopted-revision');
  const next = await f.coordinator.quote({...input,expectedRevision:'adopted-revision'});
  assert.notEqual(next.key, first.key);
  assert.equal(f.calls.filter(call => call.method === 'submit').length, 2);
  await assert.rejects(f.coordinator.quote({...input,regenerate:'yes'}),/Invalid classroom TTS selection/);
});
test("quote binds principal and current canonical revision", async () => {
  const f = fixture(), quote = await f.coordinator.quote(f.args);
  f.setPrincipal("principal-2"); await assert.rejects(f.coordinator.submit({ ...f.args, quoteId: quote.quote.quoteId }), /Confirm a current narration quote/);
  f.setRevision("new-revision"); await assert.rejects(f.coordinator.quote(f.args), /Classroom changed/);
});
test("refresh is read only while provider task is pending", async () => {
  const f = fixture(), quote = await f.coordinator.quote(f.args);
  await f.coordinator.submit({ ...f.args, quoteId: quote.quote.quoteId });
  assert.equal((await f.coordinator.refresh(f.args)).state, "running");
  assert.equal(f.calls.filter(call => call.method === "courseware.classroom.write").length, 0);
});
test("ready canonical Quiz narration archives verified audio and adopts MAIC audio manifest under CAS", async () => {
  const root = await mkdtemp(join(tmpdir(), "maic-tts-"));
  try {
    const f = fixture(root), quote = await f.coordinator.quote(f.args);
    await f.coordinator.submit({ ...f.args, quoteId: quote.quote.quoteId });
    const task = f.tasks.get(quote.key); task.state = "ready"; task.assetRef = { sha256: createHash("sha256").update(f.bytes).digest("hex"), mime: "audio/wav" };
    const result = await f.coordinator.refresh(f.args);
    assert.equal(result.state, "adopted"); assert.equal(result.view.revision, "revision-2");
    const entry = result.view.classroom.audioManifest[0]; assert.equal(entry.sceneId, "quiz"); assert.equal(entry.actionId, "speech");
    assert.deepEqual(await readFile(join(root, entry.url)), f.bytes);
    assert.equal(result.view.classroom.scenes[0].actions[0].audioUrl, entry.url);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("corrupt provider bytes and stale owner cannot adopt narration", async () => {
  const f = fixture(), quote = await f.coordinator.quote(f.args);
  await f.coordinator.submit({ ...f.args, quoteId: quote.quote.quoteId });
  const task = f.tasks.get(quote.key); task.state = "ready"; task.assetRef = { sha256: "0".repeat(64), mime: "audio/wav" };
  f.setCorrupt(); await assert.rejects(f.coordinator.refresh(f.args), /archive verification/);
  f.setOwned(false); await assert.rejects(f.coordinator.refresh(f.args), /session changed/);
  assert.equal(f.calls.filter(call => call.method === "courseware.classroom.write").length, 0);
});

test("refresh reconciles two original question audios across an unrelated adoption without repurchasing", async () => {
  const root = await mkdtemp(join(tmpdir(), "maic-tts-sequence-"));
  try {
    const f = fixture(root);
    f.getView().classroom.scenes[0].actions.push({ id: "second-speech", type: "speech", text: "Name a family member" });
    const second = { ...f.args, actionId: "second-speech" };
    for (const args of [f.args, second]) {
      const quote = await f.coordinator.quote(args);
      await f.coordinator.submit({ ...args, quoteId: quote.quote.quoteId });
      const task = f.tasks.get(quote.key);
      task.state = "ready"; task.assetRef = { sha256: createHash("sha256").update(f.bytes).digest("hex"), mime: "audio/wav" };
    }
    await f.coordinator.refresh(f.args);
    const result = await f.coordinator.refresh(second);
    assert.equal(result.state, "adopted");
    assert.equal(result.view.classroom.audioManifest.length, 2);
    assert.equal(f.calls.filter(call => call.method === "submit").length, 2);
    assert.equal(f.calls.filter(call => call.method === "courseware.classroom.write").length, 2);
    await assert.rejects(f.coordinator.quote(second), /Classroom changed/);
    await f.coordinator.refresh(second);
    assert.equal(f.calls.filter(call => call.method === "courseware.classroom.write").length, 2, "Already adopted audio is idempotent");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("refresh never applies an original task to edited question text or a different source", async () => {
  const f = fixture(), quote = await f.coordinator.quote(f.args);
  await f.coordinator.submit({ ...f.args, quoteId: quote.quote.quoteId });
  const task = f.tasks.get(quote.key);
  task.state = "ready"; task.assetRef = { sha256: createHash("sha256").update(f.bytes).digest("hex"), mime: "audio/wav" };
  f.setRevision("edited");
  f.getView().classroom.scenes[0].actions[0].text = "Changed question";
  assert.equal((await f.coordinator.refresh(f.args)).state, "not_submitted");
  f.getView().sourceRevision = "different-source";
  await assert.rejects(f.coordinator.refresh(f.args), /Classroom changed/);
  assert.equal(f.calls.filter(call => call.method === "courseware.classroom.write").length, 0);
  assert.equal(f.calls.filter(call => call.method === "submit").length, 1);
});


test('native question TTS uses scoped admission and adopts once without a classroom mirror', async () => {
  const f = fixture('/unused', true), quote = await f.coordinator.quote(f.args);
  await f.coordinator.submit({ ...f.args, quoteId: quote.quote.quoteId });
  const task = f.tasks.get(quote.key);
  task.state = 'ready'; task.assetRef = { sha256: createHash('sha256').update(f.bytes).digest('hex'), mime: 'audio/wav' };
  const adopted = await f.coordinator.refresh(f.args);
  assert.equal(adopted.state, 'adopted');
  const again = await f.coordinator.refresh({ ...f.args, expectedRevision: adopted.view.revision, expectedSourceRevision: adopted.view.sourceRevision });
  assert.equal(again.state, 'adopted');
  assert.equal(f.calls.filter(c => c.method === 'native-adopt').length, 1);
  assert(f.calls.some(c => c.method === 'courseware.mediaRelay.scope'));
  assert(!f.calls.some(c => c.method.startsWith('courseware.classroom.')));
});
