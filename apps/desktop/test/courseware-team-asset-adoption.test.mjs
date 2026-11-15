import assert from "node:assert/strict";
import test from "node:test";
import { loadCoursewareMedia } from "./fixtures/courseware-media-loader.mjs";
const { CoursewareMediaClient } = await loadCoursewareMedia();
const projectId = "11111111-1111-4111-8111-111111111111", taskId = "22222222-2222-4222-8222-222222222222";
const assetId = "33333333-3333-4333-8333-333333333333";
const reference = { taskId, idempotencyKey: "saved-key", requestHash: "a".repeat(64) };
const adopted = { projectId, assetRef: { assetId, sha256: "b".repeat(64), mime: "audio/mpeg", byteLength: 100,
  downloadPath: `/courseware/team/projects/${projectId}/assets/${assetId}/content` } };
function fixture(options = {}) {
  let principal = {}, tokenHook = async () => {}, hook = async () => {};
  const calls = [], client = new CoursewareMediaClient({ baseUrl: "https://platform.example.invalid/api", getPrincipal: () => principal,
    resolveAccessToken: async () => { await tokenHook(); return "fixture-fresh-token"; }, fetch: async (url, init) => {
      calls.push([url, init]); await hook();
      if (options.lost) throw new Error("socket ended");
      return new Response(JSON.stringify({ code: 200, data: options.value ?? adopted }), { headers: { "content-type": "application/json" } });
    } });
  return { client, calls, change() { principal = {}; }, tokenHook(value) { tokenHook = value; }, hook(value) { hook = value; } };
}
test("adoption uses the existing authenticated task POST exactly once with no generated keys or provider submission", async () => {
  const f = fixture(), result = await f.client.adoptTeamAsset(projectId, reference);
  assert.deepEqual(result, adopted); assert.equal(f.calls.length, 1);
  const [url, init] = f.calls[0]; assert.equal(url, `https://platform.example.invalid/api/courseware/team/projects/${projectId}/assets`);
  assert.equal(init.method, "POST"); assert.equal(init.body, JSON.stringify({ taskId }));
  assert.equal(init.headers.get("Authorization"), "Bearer fixture-fresh-token"); assert.equal(init.redirect, "error"); assert.equal(init.credentials, "omit");
});
test("invalid IDs/task proof and cancelled requests fail before credentials or HTTP", async () => {
  const f = fixture();
  for (const [project, ref] of [["../p", reference], [projectId, { ...reference, taskId: "local-id" }], [projectId, { ...reference, requestHash: "bad" }]])
    await assert.rejects(f.client.adoptTeamAsset(project, ref), /INVALID_/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.client.adoptTeamAsset(projectId, reference, controller.signal), error => error.name === "AbortError");
  assert.equal(f.calls.length, 0);
});
test("wrong project/extra private task fields are not accepted as team asset proofs", async () => {
  for (const value of [{ ...adopted, projectId: taskId }, { ...adopted, taskId }, { ...adopted, assetRef: { ...adopted.assetRef, assetId: "local-audio" } }]) {
    const f = fixture({ value }); await assert.rejects(f.client.adoptTeamAsset(projectId, reference), /INVALID_RESPONSE/); assert.equal(f.calls.length, 1);
  }
});
test("account changes before send and after response fail closed; unknown POST is not retried", async () => {
  const before = fixture(); before.tokenHook(async () => before.change());
  await assert.rejects(before.client.adoptTeamAsset(projectId, reference), /AUTH_CHANGED/); assert.equal(before.calls.length, 0);
  const after = fixture(); after.hook(async () => after.change());
  await assert.rejects(after.client.adoptTeamAsset(projectId, reference), /AUTH_CHANGED/); assert.equal(after.calls.length, 1);
  const lost = fixture({ lost: true }); await assert.rejects(lost.client.adoptTeamAsset(projectId, reference), /TRANSPORT_FAILED/); assert.equal(lost.calls.length, 1);
});
