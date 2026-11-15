import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
const require = createRequire(import.meta.url), exports = {};
const hash = request => createHash("sha256").update(JSON.stringify(request)).digest("hex");
new Function("require", "exports", ts.transpileModule(readFileSync(new URL("../electron/main/courseware-native-video.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(id => id === "./courseware-video-media" ? { videoRequestHash: hash } : require(id), exports);
function setup(durationSeconds) {
  const view = { viewId: "doc.page", pageId: "page", project: { projectId: "doc", teachingRevision: "rev", source: { sha256: "a".repeat(64) },
    pages: [{ pageId: "page", locked: false, actions: [{ id: "slot", type: "video_slot", prompt: "A family greeting",
      ...(durationSeconds === undefined ? {} : { durationSeconds }) }] }] } };
  const records = new Map(), calls = []; let posts = 0, late = false, fail = false, adopted;
  const bytes = Buffer.from("video"), sha = createHash("sha256").update(bytes).digest("hex");
  const task = { taskId: "task", model: "model", state: "ready", feeState: "settled", assetRef: { sha256: sha } };
  const host = { async call(method, args) {
    calls.push(method);
    if (method === "courseware.mediaRelay.scope") return { teamProjectId: null };
    if (method === "courseware.mediaRelay.read") return structuredClone(records.get(args.key) ?? null);
    assert.equal(method, "courseware.mediaRelay.write");
    assert.equal(args.expectedRevision, records.get(args.key)?.revision ?? 0);
    const result = { revision: args.expectedRevision + 1, value: structuredClone(args.value) }; records.set(args.key, result); return result;
  } };
  const client = { quote: async (_model, seconds) => { assert.equal(seconds, durationSeconds ?? 5); return {}; },
    async submit(key, request, quote, project, check, admit, seconds) {
    assert.equal(seconds, durationSeconds ?? 5);
    await check(); await admit(); posts++; Object.assign(task, { idempotencyKey: key, requestHash: hash(request) });
    if (fail) throw new Error("Transport failed after submission"); return task;
  }, get: async () => task, find: async () => task, download: async () => ({ bytes, task }) };
  const route = async (op, args) => {
    if (op === "open") return { value: structuredClone(view) };
    assert.equal(op, "adopt-audio"); adopted = args.command; return { value: view };
  };
  const make = () => new exports.CoursewareNativeVideo({ getCoursewarePrincipal: () => ({ key: "principal", assertCurrent() {} }), coursewareMedia: { video: client } },
    () => host, () => "chat", route, async () => { if (late) view.project.teachingRevision = "changed"; return { durationMs: 1200, width: 640, height: 480 }; });
  return { view: () => structuredClone(view), readOnly: () => { view.readOnly = true; }, make, posts: () => posts, adopted: () => adopted, calls, late: () => { late = true; }, fail: () => { fail = true; }, records };
}
test("native video verifies bytes and adopts through document CAS without a Host teaching write", async () => {
  const f = setup(10);
  const result = await f.make().execute({ actionId: "slot", model: "model" }, true, 1, f.view(), () => true);
  assert.equal(result.videoReady, true); assert.equal(f.posts(), 1); assert.equal(f.adopted().kind, "video");
  assert.equal(f.adopted().bytes.byteLength, 5); assert.equal(f.adopted().actionId, "slot");
  assert(f.calls.every(call => call.startsWith("courseware.mediaRelay.")));
});
test("native video rejects a late decoded result and recovers an uncertain submission without buying twice", async () => {
  const f = setup(); f.fail();
  await assert.rejects(f.make().execute({ actionId: "slot", model: "model" }, true, 1, f.view(), () => true), /Transport/);
  const journal = [...f.records.values()][0], intent = journal.value.intents[0];
  assert.equal(intent.phase, "submission-unknown");
  const recoverable = await f.make().jobs(1, f.view());
  assert.equal(recoverable[0].intentId, intent.id);
  assert.equal(recoverable[0].actionId, "slot");
  assert.equal(f.posts(), 1);
  f.late();
  await assert.rejects(f.make().execute({ intentId: intent.id }, false, 1, f.view(), () => true), /changed/);
  assert.equal(f.posts(), 1); assert.equal(f.adopted(), undefined);
});

test("native video rejects a read-only document before paid submission", async () => {
  const f = setup(); f.readOnly(); const view = f.view();
  await assert.rejects(f.make().execute({ actionId: "slot", model: "model" }, true, 1, view, () => true), /locked/);
  assert.equal(f.posts(), 0); assert.equal(f.adopted(), undefined);
  assert(!f.calls.includes("courseware.mediaRelay.write"));
});
