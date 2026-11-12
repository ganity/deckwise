import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import test from "node:test";
import ts from "typescript";
const exports = {}, require = createRequire(import.meta.url);
new Function("require", "exports", ts.transpileModule(readFileSync(new URL("../electron/main/courseware-native-audio.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(require, exports);
const { CoursewareNativeAudio } = exports;
function setup() {
  const view = { viewId: "document.page", pageId: "page", pageNumber: 1, project: { projectId: "document", teachingRevision: "rev1",
    pages: [{ pageId: "page", locked: false, actions: [{ id: "speech", type: "speech", text: "Hello native" }] }] } };
  const records = new Map(), calls = [], bytes = Buffer.from("verified speech"), sha = createHash("sha256").update(bytes).digest("hex");
  let submits = 0;
  const host = { async call(method, args) {
    calls.push(method);
    if (method === "courseware.mediaRelay.scope") return { sessionId: "chat", teamProjectId: null };
    if (method === "courseware.mediaRelay.read") return structuredClone(records.get(args.key) ?? null);
    if (method === "courseware.mediaRelay.write") {
      const previous = records.get(args.key);
      assert.equal(args.expectedRevision, previous?.revision ?? 0);
      const next = { revision: args.expectedRevision + 1, value: structuredClone(args.value) }; records.set(args.key, next); return next;
    }
    assert.fail(method);
  } };
  const task = { model: "voice-model", state: "ready", feeState: "settled", taskId: "task", reservedPoints: 1, actualPoints: 1, errorCode: null,
    assetRef: { mime: "audio/mpeg", sha256: sha, byteLength: bytes.length } };
  const auth = { getCoursewarePrincipal: () => ({ key: "a".repeat(64), assertCurrent() {} }), coursewareMedia: {
    getTtsModels: async () => [{ model: "voice-model", voices: [] }],
    getTtsQuote: async () => ({ model: "voice-model", maxChars: 4000, maxPoints: 1, expiresAt: new Date(Date.now() + 60000).toISOString() }),
    submitConfirmedTts: async (key, request, quote, signal, project, check) => {
      await check(); submits++;
      const canonical = [request.kind, request.model, request.input, request.voice ?? null].reduce((text, field) => `${text}:${field === null ? -1 : field.length}:${field ?? ""}`, "courseware-media-v1");
      Object.assign(task, { idempotencyKey: key, requestHash: createHash("sha256").update(canonical).digest("hex") }); return task;
    }, get: async () => task, download: async () => ({ bytes, task }), findTts: async () => task,
  } };
  const route = async (operation, args) => {
    if (operation === "open") return { value: view };
    assert.equal(operation, "adopt-audio"); assert.equal(args.command.sha256, sha); assert.equal(args.command.bytes.byteLength, bytes.length);
    view.project.teachingRevision = "rev2"; return { value: view };
  };
  const make = () => new CoursewareNativeAudio(auth, () => host, () => "chat", route, async () => 1000);
  const args = () => ({ viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision });
  return { view, make, args, calls, auth, records, submits: () => submits };
}
test("automatic speech preparation reuses the exact durable order after restart and preserves manual regeneration", async () => {
  const f = setup(), request = { ...f.args(), actionId: "speech", model: "voice-model", voice: null, reuseExisting: true };
  const first = await f.make().execute("tts:prepare", request, 1, f.view);
  const service = f.make();
  const quote = await service.execute("tts:quote", { ...f.args(), intentId: first.intentId }, 1, f.view);
  await service.execute("tts:submit", { ...f.args(), intentId: first.intentId, quoteId: quote.quoteId }, 1, f.view);
  const reused = await f.make().execute("tts:prepare", request, 1, f.view);
  assert.equal(reused.intentId, first.intentId); assert.equal(reused.phase, "submitted"); assert.equal(reused.reused, true);
  assert.equal(f.submits(), 1);
  const otherVoice = await f.make().execute("tts:prepare", { ...request, voice: "different" }, 1, f.view);
  assert.notEqual(otherVoice.intentId, first.intentId);
  const manual = await f.make().execute("tts:prepare", { ...request, reuseExisting: false }, 1, f.view);
  assert.notEqual(manual.intentId, first.intentId);
  await assert.rejects(f.make().execute("tts:prepare", request, 1, f.view), /Multiple matching/);
  f.view.project.pages[0].actions[0].text = "New words";
  const changed = await f.make().execute("tts:prepare", request, 1, f.view);
  assert.notEqual(changed.intentId, first.intentId);
});

test("lost submission replies keep the original order query-only through repeated automatic preparation", async () => {
  const f = setup(), service = f.make(); let submissions = 0;
  f.auth.coursewareMedia.submitConfirmedTts = async () => { submissions++; throw new Error("Reply lost"); };
  f.auth.coursewareMedia.findTts = async () => null;
  const args = { ...f.args(), actionId: "speech", model: "voice-model", voice: null, reuseExisting: true };
  const intent = await service.execute("tts:prepare", args, 1, f.view);
  const quote = await service.execute("tts:quote", { ...f.args(), intentId: intent.intentId }, 1, f.view);
  await assert.rejects(service.execute("tts:submit", { ...f.args(), intentId: intent.intentId, quoteId: quote.quoteId }, 1, f.view), /Reply lost/);
  const restarted = f.make(), reused = await restarted.execute("tts:prepare", args, 1, f.view);
  assert.equal(reused.intentId, intent.intentId); assert.equal(reused.phase, "submission-unknown");
  const status = await restarted.execute("tts:submit", { ...f.args(), intentId: reused.intentId }, 1, f.view);
  assert.equal(status.task, null); assert.equal(submissions, 1);
});
test("native paid speech retains durable task identity and adopts only through native revision CAS", async () => {
  const f = setup(), coordinator = f.make();
  const prepared = await coordinator.execute("tts:prepare", { ...f.args(), actionId: "speech", model: "voice-model", voice: null }, 1, f.view);
  const quote = await coordinator.execute("tts:quote", { ...f.args(), intentId: prepared.intentId }, 1, f.view);
  await assert.rejects(coordinator.execute("tts:submit", { ...f.args(), intentId: prepared.intentId, quoteId: "bad" }, 1, f.view));
  await coordinator.execute("tts:submit", { ...f.args(), intentId: prepared.intentId, quoteId: quote.quoteId }, 1, f.view);
  assert.equal(f.submits(), 1);
  const restarted = f.make();
  await restarted.execute("tts:submit", { ...f.args(), intentId: prepared.intentId, quoteId: quote.quoteId }, 1, f.view);
  assert.equal(f.submits(), 1);
  await restarted.execute("tts:adopt", { ...f.args(), intentId: prepared.intentId }, 1, f.view);
  assert.equal(f.view.project.teachingRevision, "rev2");
  assert(f.calls.every(method => !method.includes("teaching") && !method.includes("parse")));
  f.view.project.pages[0].actions[0].text = "Changed after submission";
  await assert.rejects(restarted.execute("tts:adopt", { ...f.args(), intentId: prepared.intentId }, 1, f.view), /stale/);
});
test('read-only native speech rejects preparation and late submission before provider dispatch', async () => {
  const f = setup(), service = f.make();
  f.view.readOnly = true;
  await assert.rejects(service.execute('tts:prepare', { ...f.args(), actionId: 'speech', model: 'voice-model', voice: null }, 1, f.view), /read.only|changed/i);
  f.view.readOnly = false;
  const intent = await service.execute('tts:prepare', { ...f.args(), actionId: 'speech', model: 'voice-model', voice: null }, 1, f.view);
  const quote = await service.execute('tts:quote', { ...f.args(), intentId: intent.intentId }, 1, f.view);
  f.view.readOnly = true;
  await assert.rejects(service.execute('tts:submit', { ...f.args(), intentId: intent.intentId, quoteId: quote.quoteId }, 1, f.view), /read.only|changed/i);
  assert.equal(f.submits(), 0);
});
