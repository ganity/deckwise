/** Real Main coordinator/HTTP transport/Host, isolated data and a synthetic supplier. */
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as files from "node:fs/promises";
import * as paths from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import test from "node:test";
import ts from "typescript";
import * as shared from "../../../packages/shared/dist/index.js";
import { Host } from "../../../scripts/e2e/host.mjs";
import { loadCoursewareMedia } from "./fixtures/courseware-media-loader.mjs";

async function load(name, dependencies) {
  const source = await files.readFile(new URL(`../electron/main/${name}.ts`, import.meta.url), "utf8"), exports = {};
  new Function("require", "exports", ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText)(id => { assert(Object.hasOwn(dependencies, id), id); return dependencies[id]; }, exports);
  return exports;
}
const requests = await loadCoursewareMedia("courseware-music-request"), mediaScope = await load("courseware-media-scope", {});
const { CoursewareMediaClient } = await loadCoursewareMedia();
const { CoursewareCanvasMusic } = await load("courseware-canvas-music", { "node:crypto": crypto, "node:fs": fs,
  "node:fs/promises": files, "node:path": paths, "@pi-desktop/shared": shared,
  "./courseware-music-request": requests, "./courseware-media-scope": mediaScope });

test("real Main/Host music lifecycle retains every candidate and separate export across full restarts", {
  skip: !process.env.DECKWISE_E2E_MUSIC_HOST, timeout: 90_000,
}, async t => {
  const root = await files.mkdtemp(paths.join(tmpdir(), "deckwise-music-host-"));
  const workspace = paths.join(root, "workspace"), data = paths.join(root, "data");
  await files.mkdir(workspace); await files.mkdir(paths.join(data, "plugins/market"), { recursive: true });
  await files.writeFile(paths.join(data, "plugins/market/catalog.json"), JSON.stringify({ schemaVersion: 2, providerId: "official", plugins: [] }));
  const host = new Host(process.env.DECKWISE_E2E_MUSIC_HOST, data), calls = [], tasks = new Map();
  const audio = await files.readFile(new URL("fixtures/courseware-tts-tone.mp3", import.meta.url));
  const sha256 = crypto.createHash("sha256").update(audio).digest("hex");
  const candidateIds = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
  const candidates = candidateIds.map((candidateId, order) => ({ candidateId, order, state: "completed", exportable: true }));
  const team = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  let sessionId, loseNext = true;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1"); calls.push([request.method, url.pathname]);
      assert.equal(request.headers.authorization, "Bearer fixture-access");
      const send = value => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ code: 200, data: value })); };
      if (url.pathname.endsWith("/models")) return send([{ model: url.searchParams.get("kind") === "music" ? "song-model" : "export-model", voices: [], providerDefaultVoice: false }]);
      if (url.pathname.endsWith("/quote")) {
        const expiry = Math.floor(Date.now() / 1000) + 300, kind = url.searchParams.get("kind");
        return send({ version: "courseware-media-quote-v1", kind, model: kind === "music" ? "song-model" : "export-model", priceVersion: "fixture-v1",
          maxPoints: 5, maxChars: 4000, expiresAt: new Date(expiry * 1000).toISOString(), quoteToken: `${expiry}.${"a".repeat(43)}` });
      }
      if (request.method === "POST") {
        assert.equal(url.pathname, `/courseware/team/projects/${team}/media/tasks/confirmed`);
        let raw = ""; for await (const chunk of request) raw += chunk;
        const { request: body } = JSON.parse(raw), key = request.headers["idempotency-key"];
        assert(!tasks.has(key), "No repeat POST after an accepted lost response");
        const taskId = `music-${tasks.size + 1}`, exported = body.kind === "music-export";
        const task = { version: "courseware-media-v1", kind: body.kind, taskId, idempotencyKey: key, requestHash: requests.musicRequestHash(body), model: body.model,
          state: "ready", feeState: "settled", reservedPoints: 5, actualPoints: 5, receiptId: `courseware-media:${taskId}`, errorCode: null,
          assetRef: exported ? { assetId: "export-asset", sha256, mime: "audio/mpeg", byteLength: audio.length, downloadPath: `/courseware/media/tasks/${taskId}/asset` } : null };
        tasks.set(key, task);
        if (loseNext) { loseNext = false; request.socket.destroy(); return; } return send(task);
      }
      if (url.pathname.endsWith("/by-idempotency")) return send(tasks.get(url.searchParams.get("key")));
      if (url.pathname.endsWith("/music-candidates")) return send(candidates);
      if (url.pathname.endsWith("/preview") || url.pathname.endsWith("/asset")) {
        response.setHeader("content-type", "audio/mpeg"); response.end(audio); return;
      }
      const task = [...tasks.values()].find(value => url.pathname.endsWith(`/${value.taskId}`)); assert(task); return send(task);
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  t.after(async () => { await host.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await files.rm(root, { recursive: true, force: true }); });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); await host.start();
  sessionId = (await host.call("session.create", { projectPath: workspace })).session.id;
  await host.call("courseware.task.set", { sessionId, taskType: "plain" });
  await host.call("courseware.task.bindTeam", { sessionId, teamProjectId: team });
  const projectId = `canvas:${sessionId}`, draft = { id: "song", kind: "music", revision: 0, title: "Good job song", prompt: "One, two, good job! 小朋友😀", references: [], x: 0, y: 0 };
  const canvas = await host.call("courseware.mediaCanvas.set", { sessionId, projectId, expectedRevision: null,
    document: { version: 1, projectId, revision: 0, viewport: { x: 0, y: 0, zoom: 1 }, drafts: [draft] } });
  const principal = {}, principalKey = "a".repeat(64);
  const client = new CoursewareMediaClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, fetch,
    getPrincipal: () => principal, resolveAccessToken: async () => "fixture-access" });
  const make = () => new CoursewareCanvasMusic(() => host, () => sessionId, () => false, {
    coursewareMedia: client, getCoursewarePrincipal: () => ({ key: principalKey, assertCurrent() {} }),
  });
  let main = make(); const op = { sessionId, intentId: crypto.randomUUID() };
  await main.prepare({ ...op, expectedRevision: canvas.revision, draftId: draft.id, expectedDraftRevision: 0,
    model: "song-model", music: { title: draft.title, negativeTags: "", tags: null, instrumental: false } });
  const quote = await main.quote(op);
  await assert.rejects(main.submitConfirmed({ ...op, quoteId: quote.quoteId }), /TRANSPORT_FAILED/);
  await host.stop(); await host.start(); main = make();
  const recovered = await main.status(op); assert.equal(recovered.candidates.length, 2); assert.equal(recovered.phase, "submitted");
  for (const candidateId of candidateIds) assert.equal((await main.preview({ ...op, candidateId })).asset.sha256, sha256);
  const exportIntentId = crypto.randomUUID();
  await main.exportPrepare({ ...op, exportIntentId, candidateId: candidateIds[1], model: "export-model" });
  const exportOp = { sessionId, intentId: exportIntentId }, exportQuote = await main.exportQuote(exportOp);
  loseNext = true;
  await assert.rejects(main.exportSubmitConfirmed({ ...exportOp, quoteId: exportQuote.quoteId }), /TRANSPORT_FAILED/);
  await host.stop(); await host.start(); main = make();
  assert.equal((await main.exportStatus(exportOp)).phase, "submitted");
  assert.equal((await main.exportArchive(exportOp)).asset.sha256, sha256);
  await host.stop(); await host.start(); main = make();
  const before = calls.length;
  for (const candidateId of candidateIds) assert.equal((await main.preview({ ...op, candidateId })).asset.sha256, sha256);
  assert.equal((await main.exportArchive(exportOp)).asset.sha256, sha256);
  assert.equal(calls.length, before, "Archived audio restart reads stay local");
  assert.equal(calls.filter(([method]) => method === "POST").length, 2);
  const stored = (await host.call("courseware.mediaCanvas.music.list", { sessionId, principalKey })).intents;
  assert.equal(stored.length, 2); assert.equal(stored[0].intent.previews.length, 2);
  assert.deepEqual(stored[1].intent.submissionScope, { sessionId, teamProjectId: team });
  assert.equal(stored[1].intent.sourceIntentId, op.intentId);
  assert.deepEqual(await files.readFile(paths.join(data, "courseware-assets", `${sha256}.bin`)), audio);
  t.diagnostic(JSON.stringify({ scenario: "music-originals", mockPosts: 2, recoveredOriginals: 2, archivedExports: 1 }));
});
