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
  return { view, make, args, calls, submits: () => submits };
}
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
