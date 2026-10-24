/** Actual Main coordinators, Host process and HTTP client; loopback identity/media only. */
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import * as shared from "../../../packages/shared/dist/index.js";
import { Host } from "../../../scripts/e2e/host.mjs";
import { loadCoursewareMedia } from "./fixtures/courseware-media-loader.mjs";

async function load(name, dependencies) {
  const exports = {};
  const source = await readFile(new URL(`../electron/main/${name}.ts`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } });
  new Function("require", "exports", outputText)(id => {
    assert(Object.hasOwn(dependencies, id), `Unexpected dependency ${id}`);
    return dependencies[id];
  }, exports);
  return exports;
}

const { CoursewareMediaClient } = await loadCoursewareMedia();
const mediaScope = await load("courseware-media-scope", {});
// No asset download/archive is part of this submission-scope test.
const assets = new Proxy({}, { get() { throw new Error("Unexpected image-archive operation"); } });
const { CoursewareCanvasImages } = await load("courseware-canvas-images", { "node:crypto": crypto,
  "@pi-desktop/shared": shared, "./courseware-scene-image-assets": assets, "./courseware-media-scope": mediaScope });
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const requestHash = request => digest("courseware-media-v1" + [request.kind, request.model, request.input, null]
  .map(value => `:${value === null ? -1 : value.length}:${value ?? ""}`).join(""));

// Requires a freshly built Host; never falls back to an older installed binary.
test("durable media scope through actual Main, Host restart and HTTP routes", {
  skip: !process.env.DECKWISE_E2E_MEDIA_SCOPE_HOST, timeout: 90_000,
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), "deckwise-media-scope-"));
  const workspace = join(directory, "workspace"), data = join(directory, "data");
  await mkdir(workspace); await mkdir(join(data, "plugins/market"), { recursive: true });
  await writeFile(join(data, "plugins/market/catalog.json"), JSON.stringify({ schemaVersion: 2, providerId: "official", plugins: [] }));
  const host = new Host(process.env.DECKWISE_E2E_MEDIA_SCOPE_HOST, data);
  const http = [], tasks = new Map();
  let failNext = false, afterBegin, sessionId, refusal;
  const team = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", principalKey = "a".repeat(64);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      http.push({ method: request.method, path: url.pathname });
      assert.equal(request.headers.authorization, "Bearer fixture-access");
      const send = (data, code = 200) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ code, data })); };
      if (url.pathname === "/courseware/media/models") return send([{ model: "scope-image", voices: [], providerDefaultVoice: false, supportsReferenceImage: false }]);
      if (url.pathname === "/courseware/media/models/scope-image/quote") {
        const expiry = Math.floor(Date.now() / 1000) + 300;
        return send({ version: "courseware-media-quote-v1", kind: "image", model: "scope-image", priceVersion: "fixture-v1",
          maxPoints: 3, maxChars: 4000, expiresAt: new Date(expiry * 1000).toISOString(), quoteToken: `${expiry}.${"a".repeat(43)}` });
      }
      if (request.method === "POST") {
        assert(["/courseware/media/tasks/confirmed", `/courseware/team/projects/${team}/media/tasks/confirmed`].includes(url.pathname));
        let raw = ""; for await (const bytes of request) raw += bytes;
        const { request: body } = JSON.parse(raw), key = request.headers["idempotency-key"];
        assert(!tasks.has(key), "One original key cannot POST twice");
        if (refusal) return send(null, refusal);
        const task = { version: "courseware-media-v1", kind: "image", taskId: `scope-task-${tasks.size + 1}`,
          idempotencyKey: key, requestHash: requestHash(body), model: body.model, state: "queued", feeState: "reserved",
          reservedPoints: 3, actualPoints: null, receiptId: null, errorCode: null, assetRef: null };
        tasks.set(key, task);
        if (failNext) { failNext = false; request.socket.destroy(); return; }
        return send(task);
      }
      assert.equal(url.pathname, "/courseware/media/tasks/by-idempotency");
      const task = tasks.get(url.searchParams.get("key"));
      assert(task); return send(task);
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  t.after(async () => {
    await host.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); await host.start();
  const principal = { tenantId: 1, userId: 2 };
  const client = new CoursewareMediaClient({ baseUrl: `http://127.0.0.1:${server.address().port}`,
    getPrincipal: () => principal, resolveAccessToken: async () => "fixture-access", fetch });
  const wrapped = { async call(method, params) {
    const result = await host.call(method, params);
    if (method === "courseware.mediaCanvas.image.begin") await afterBegin?.();
    return result;
  } };
  const make = () => new CoursewareCanvasImages(() => wrapped, () => sessionId, () => false, {
    coursewareMedia: client, getCoursewarePrincipal: () => ({ key: principalKey, assertCurrent() {} }),
  });
  async function prepare(coordinator = make()) {
    sessionId = (await host.call("session.create", { projectPath: workspace })).session.id;
    await host.call("courseware.task.set", { sessionId, taskType: "plain" });
    const projectId = `canvas:${sessionId}`;
    const canvas = await host.call("courseware.mediaCanvas.set", { sessionId, projectId, expectedRevision: null,
      document: { version: 1, projectId, revision: 0, viewport: { x: 0, y: 0, zoom: 1 }, drafts: [{
        id: "picture", revision: 0, kind: "image", title: "Circle", prompt: "Bright circle 小朋友😀", references: [], x: 20, y: 30,
      }] } });
    const image = await coordinator.prepare({ sessionId, intentId: crypto.randomUUID(), expectedRevision: canvas.revision, draftId: "picture", expectedDraftRevision: 0, model: "scope-image" });
    const operation = { sessionId, intentId: image.intentId };
    return { coordinator, operation, scope: { ...operation, principalKey } };
  }
  const bind = () => host.call("courseware.task.bindTeam", { sessionId, teamProjectId: team });
  const submit = async item => {
    const quote = await item.coordinator.quote(item.operation);
    return item.coordinator.submitConfirmed({ ...item.operation, quoteId: quote.quoteId });
  };
  const posts = () => http.filter(row => row.method === "POST");

  await t.test("prepared personal intent takes team scope if binding commits before begin", async () => {
    const item = await prepare(); await bind();
    assert.equal((await submit(item)).phase, "submitted");
    const saved = await host.call("courseware.mediaCanvas.image.get", item.scope);
    assert.deepEqual(saved.intent.submissionScope, { sessionId, teamProjectId: team });
    assert.equal(posts().at(-1).path, `/courseware/team/projects/${team}/media/tasks/confirmed`);
    await host.stop(); await host.start();
    assert.deepEqual((await host.call("courseware.mediaCanvas.image.get", item.scope)).intent, saved.intent);
  });
  await t.test("later first binding cannot retarget the already begun personal request", async () => {
    const item = await prepare(); afterBegin = bind;
    try { assert.equal((await submit(item)).phase, "submitted"); } finally { afterBegin = undefined; }
    const saved = await host.call("courseware.mediaCanvas.image.get", item.scope);
    assert.deepEqual(saved.intent.submissionScope, { sessionId, teamProjectId: null });
    assert.equal(posts().at(-1).path, "/courseware/media/tasks/confirmed");
    assert.equal((await host.call("courseware.task.get", { sessionId })).task.teamProjectId, team);
  });
  await t.test("lost personal receipt remains personal after sharing and full Host restart; recovery only GETs", async () => {
    const item = await prepare(); failNext = true;
    await assert.rejects(submit(item));
    const unknown = await host.call("courseware.mediaCanvas.image.get", item.scope);
    assert.equal(unknown.intent.phase, "submission-unknown");
    assert.equal(unknown.intent.submissionScope.teamProjectId, null);
    await bind(); await host.stop(); await host.start();
    const before = posts().length;
    const recovered = await make().status(item.operation);
    assert.equal(recovered.phase, "submitted"); assert.equal(posts().length, before);
    assert.deepEqual((await host.call("courseware.mediaCanvas.image.get", item.scope)).intent.submissionScope, unknown.intent.submissionScope);
  });
  await t.test("two independent Main coordinators cannot both begin or POST one intent", async () => {
    const item = await prepare(); await bind();
    const other = make();
    const q1 = await item.coordinator.quote(item.operation), q2 = await other.quote(item.operation);
    const before = posts().length;
    const outcomes = await Promise.allSettled([
      item.coordinator.submitConfirmed({ ...item.operation, quoteId: q1.quoteId }),
      other.submitConfirmed({ ...item.operation, quoteId: q2.quoteId }),
    ]);
    assert(outcomes.some(result => result.status === "fulfilled"));
    assert.equal(posts().length, before + 1);
    assert.equal(posts().at(-1).path, `/courseware/team/projects/${team}/media/tasks/confirmed`);
  });
  assert.equal(posts().length, 4);

  for (const code of [46100, 46102]) await t.test(`team refusal ${code} survives restart without GET or POST and requires fresh confirmation`, async () => {
    const item = await prepare(); await bind(); refusal = code;
    const rejected = await submit(item);
    assert.equal(rejected.phase, "rejected"); assert.equal(rejected.task, null);
    const saved = await host.call("courseware.mediaCanvas.image.get", item.scope);
    assert.equal(saved.intent.phase, "rejected"); assert.equal(saved.intent.taskRef, null);
    assert(!tasks.has(saved.intent.idempotencyKey));
    await host.stop(); await host.start();
    const before = http.length;
    const restarted = make();
    assert.equal((await restarted.status(item.operation)).phase, "rejected");
    assert.equal((await restarted.submitConfirmed({ ...item.operation, quoteId: "expired-quote" })).phase, "rejected");
    assert.equal(http.length, before, "terminal refusal cannot trigger task lookup or resubmission");
    assert.deepEqual((await host.call("courseware.mediaCanvas.image.get", item.scope)).intent, saved.intent);
    refusal = undefined;
    const canvas = await host.call("courseware.mediaCanvas.get", { sessionId, projectId: `canvas:${sessionId}` });
    const fresh = await restarted.prepare({ sessionId, intentId: crypto.randomUUID(), expectedRevision: canvas.revision,
      draftId: "picture", expectedDraftRevision: 0, model: "scope-image" });
    const op = { sessionId, intentId: fresh.intentId };
    const next = await host.call("courseware.mediaCanvas.image.get", { ...op, principalKey });
    assert.notEqual(next.intent.idempotencyKey, saved.intent.idempotencyKey);
    const quote = await restarted.quote(op);
    const count = posts().length;
    await assert.rejects(restarted.submitConfirmed({ ...op, quoteId: "expired-quote" }), /QUOTE_REQUIRED/);
    assert.equal(posts().length, count);
    assert.equal((await restarted.submitConfirmed({ ...op, quoteId: quote.quoteId })).phase, "submitted");
    assert.equal(posts().length, count + 1);
  });
  await t.test("generic team denial stays uncertain and status uses GET without paid resubmission", async () => {
    const item = await prepare(); await bind(); refusal = 403;
    await assert.rejects(submit(item), /COURSEWARE_MEDIA_PLATFORM_403/); refusal = undefined;
    const saved = await host.call("courseware.mediaCanvas.image.get", item.scope);
    assert.equal(saved.intent.phase, "submission-unknown");
    // The fixture lookup deliberately fails for this absent task; neither failure can prove a safe retry.
    const before = posts().length;
    await assert.rejects(make().status(item.operation));
    assert.equal(posts().length, before);
    assert.equal((await host.call("courseware.mediaCanvas.image.get", item.scope)).intent.phase, "submission-unknown");
  });
});
