/** Actual Main preparation/transport and Rust Host; only Platform HTTP and saved editor are fixtures. */
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import * as shared from "../../../packages/shared/dist/index.js";
import { Host } from "../../../scripts/e2e/host.mjs";
import { loadCoursewareMedia } from "./fixtures/courseware-media-loader.mjs";

const binary = process.env.DECKWISE_E2E_ONLINE_PREPARE_HOST;
assert(binary, "Set DECKWISE_E2E_ONLINE_PREPARE_HOST to the newly built Host binary; this test never builds or falls back");
const require = createRequire(import.meta.url), modules = new Map([["@pi-desktop/shared", shared]]);
for (const name of ["fs-panel", "office-file", "ppt-editor-files", "courseware-source-files", "courseware-online-editing", "courseware-online-seed", "courseware-online-audio", "courseware-online-prepare"]) {
  const exports = {}, source = await fs.readFile(new URL(`../electron/main/${name}.ts`, import.meta.url), "utf8");
  new Function("require", "exports", ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText)(id => id.startsWith("node:") ? require(id) : modules.get(id) ?? assert.fail(`Unexpected dependency: ${id}`), exports);
  modules.set(`./${name}`, exports);
}
const { CoursewareOnlinePreparation } = modules.get("./courseware-online-prepare");
const { CoursewareOnlineEditingClient } = modules.get("./courseware-online-editing");
const { readLiveSource, sourceHash } = modules.get("./courseware-source-files");
const { CoursewareMediaClient } = await loadCoursewareMedia();
const projectId = "22222222-2222-4222-8222-222222222222", principalKey = "a".repeat(64);
const pptx = await fs.readFile(new URL("../../../packages/courseware-runtime/tests/fixtures/office-lineage-b7/source.pptx", import.meta.url));
const sha256 = sourceHash(pptx), fixtureToken = "fixture-platform-access";
const uploadRevision = "33333333-3333-4333-8333-333333333333";
const clone = value => structuredClone(value);

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "deckwise-online-prepare-integration-"));
  const workspace = join(root, "workspace"), data = join(root, "data");
  await fs.mkdir(workspace); await fs.mkdir(join(data, "plugins/market"), { recursive: true });
  await fs.writeFile(join(data, "plugins/market/catalog.json"), JSON.stringify({ schemaVersion: 2, providerId: "official", plugins: [] }));
  const sourcePath = join(workspace, "lesson.pptx"), savedPath = join(workspace, ".deckwise-ppt/revisions/lesson/r0001/document.pptx");
  await fs.mkdir(join(workspace, ".deckwise-ppt/revisions/lesson/r0001"), { recursive: true });
  await fs.writeFile(sourcePath, pptx); await fs.writeFile(savedPath, pptx);
  const f = { source: null, session: { projectId, epoch: 0, sessionId: null, active: false }, boundKey: null,
    teaching: null, mapping: null, teachingRequest: null, teachingInput: null, teachingPosts: [], dropTeaching: false,
    http: [], rpc: [], errors: [], dropStart: false, dirty: false, account: true, tokenCount: 0, host: null, gateway: null };
  const base = `/courseware/team/projects/${projectId}`;
  const server = createServer(async (request, response) => {
    const send = (value, code = 200) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ code, data: value })); };
    try {
      const url = new URL(request.url, "http://127.0.0.1"), route = url.pathname;
      f.http.push({ method: request.method, route, ...(url.search ? { query: url.search } : {}) });
      assert.equal(request.headers.authorization, `Bearer ${fixtureToken}`);
      const raw = [];
      let length = 0;
      for await (const chunk of request) { length += chunk.length; assert(length <= 21 * 1024 * 1024); raw.push(chunk); }
      const body = Buffer.concat(raw);
      if (request.method === "GET") {
        if (route === "/courseware/team/projects") return send([{ projectId, ownerUserId: 2, role: "OWNER", createdAt: "2026-10-24T00:00:00.000Z" }]);
        if (route === `${base}/sources/current`) return f.source ? send(f.source) : send(null, 46402);
        if (route === `${base}/teaching`) return f.teaching ? send(f.teaching) : send(null, 46606);
        if (route.startsWith(`${base}/teaching/mappings/`)) {
          assert.equal(route, `${base}/teaching/mappings/${f.mapping?.mapping.revision}`);
          assert.equal(url.searchParams.size, 1);
          assert.equal(url.searchParams.get("sourceRevision"), f.mapping?.source.revision);
          return f.mapping ? send(f.mapping) : send(null, 46607);
        }
        assert.equal(route, `${base}/editing-session`); return send(f.session);
      }
      assert.equal(request.method, "POST");
      if (route === `${base}/sources`) {
        assert.equal(f.session.active, false, "The fixture forbids replacing an active source");
        assert.match(request.headers["content-type"], /^multipart\/form-data; boundary=/u);
        const form = await new Request("http://127.0.0.1/upload", { method: "POST", headers: request.headers, body }).formData();
        assert.equal(form.has("expectedSourceRevision"), false);
        const file = form.get("source");
        assert.equal(file.name, "lesson.pptx");
        assert.deepEqual(Buffer.from(await file.arrayBuffer()), pptx);
        assert.equal(form.get("sourceSha256"), sha256);
        assert.equal(f.source, null, "The same accepted upload must not be submitted again");
        f.source = { projectId, source: { revision: uploadRevision, sha256 }, byteLength: pptx.length,
          requestId: form.get("requestId"), sessionEpoch: null, callbackId: null };
        return send(f.source);
      }
      const input = JSON.parse(body.toString("utf8"));
      if (route === `${base}/teaching`) {
        assert.equal(f.session.active, false);
        assert.equal(input.requestId, f.source.requestId);
        assert.deepEqual(input.project.source, f.source.source);
        assert.equal(input.project.projectId, projectId); assert(shared.isCoursewareProject(input.project));
        assert(shared.isCoursewareOnlineSourceMapping(input.mapping));
        assert.equal(input.mapping.revision, input.mappingRevision);
        assert.equal(input.mapping.sourceSha256, f.source.source.sha256);
        assert.deepEqual(input.mapping.pages.map(page => page.pageId), input.project.pages.map(page => page.pageId));
        f.teachingPosts.push(clone(input));
        if (f.teaching) assert.deepEqual(input, f.teachingInput, "Recovery must replay the identical teaching request");
        else {
          f.teachingInput = clone(input); f.teachingRequest = input.requestId;
          f.teaching = { project: { ...clone(input.project), teachingRevision: randomUUID() }, mappingRevision: input.mappingRevision };
          f.mapping = { projectId, source: clone(input.project.source), mapping: clone(input.mapping) };
        }
        if (f.dropTeaching) { f.dropTeaching = false; request.socket.destroy(); return; }
        return send(f.teaching);
      }
      if (route === `${base}/editing-session`) {
        assert.equal(f.session.active, false, "Never repeat a successful start after a lost response");
        assert.deepEqual(input, { expectedEpoch: f.session.epoch, expectedSourceRevision: f.source.source.revision });
        f.session = { projectId, epoch: f.session.epoch + 1, sessionId: randomUUID(), active: true };
        if (f.dropStart) { f.dropStart = false; request.socket.destroy(); return; }
        return send(f.session);
      }
      if (route === `${base}/editing-session/document-binding`) {
        assert.deepEqual(input, { expectedEpoch: f.session.epoch }); assert.equal(f.session.active, true);
        f.boundKey = f.session.sessionId;
        return send({ key: f.boundKey, sessionEpoch: f.session.epoch, callbackUrl: "http://127.0.0.1/fixture-callback" });
      }
      assert.equal(route, `${base}/editing-session/${f.session.epoch}/editor-config`);
      assert.deepEqual(input, {}); assert.equal(f.boundKey, f.session.sessionId);
      const expiresAtEpochMillis = (Math.floor(Date.now() / 1000) + 60) * 1000;
      const document = { key: f.boundKey, fileType: "pptx", title: "lesson.pptx", url: "http://127.0.0.1/fixture-source", permissions: { edit: true } };
      const editorConfig = { mode: "edit", user: { id: "tenant-1-user-2", name: "Fixture Owner" },
        callbackUrl: "http://127.0.0.1/fixture-callback", coEditing: { mode: "fast", change: false }, customization: { autosave: true } };
      const claims = { documentType: "slide", document, editorConfig, exp: expiresAtEpochMillis / 1000 };
      const unsigned = `${Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
      const token = `${unsigned}.${createHmac("sha256", "integration-fixture-signing-key-no-real-credentials").update(unsigned).digest("base64url")}`;
      return send({ projectId, sessionEpoch: f.session.epoch, source: f.source.source, documentKey: f.boundKey, docsUserId: "tenant-1-user-2",
        configJson: JSON.stringify({ documentType: "slide", document, editorConfig, token }), expiresAtEpochMillis });
    } catch (error) {
      f.errors.push(error);
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: 500, message: "FIXTURE_FAILURE" }));
    }
  });
  t.after(async () => {
    try { await f.host?.stop(); }
    finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const principal = { tenantId: 1, userId: 2 };
  const transportOptions = { baseUrl: `http://127.0.0.1:${server.address().port}`, fetch, getPrincipal: () => f.account ? principal : null,
    resolveAccessToken: async () => { f.tokenCount++; return fixtureToken; } };
  const client = new CoursewareOnlineEditingClient(transportOptions);
  const auth = { coursewareMedia: new CoursewareMediaClient(transportOptions),
    getCoursewareOnlineClient: () => client,
    getCoursewarePrincipal: () => ({ key: principalKey, assertCurrent() { assert.equal(f.account, true); } }),
    joinCoursewareOnline: (id, signal) => client.join(id, signal),
  };
  // This is a saved-editor adapter, not a native editor or a mock of source-file validation.
  const editor = { sourceAdoptionSnapshot(currentWorkspace) {
    assert.equal(currentWorkspace, workspace); assert.equal(f.dirty, false, "Save the editor before preparing online editing");
    return { path: savedPath, sourcePath, revision: 1, sha256, projectId: "office-lesson", documentId: "lesson", sessionId: "fixture-office-session" };
  }, async verifyTeachingSource(currentWorkspace) {
    editor.sourceAdoptionSnapshot(currentWorkspace);
    assert.equal(sourceHash(await readLiveSource(workspace, sourcePath)), sha256);
    editor.sourceAdoptionSnapshot(currentWorkspace);
  } };
  f.restartHost = async () => {
    await f.host?.stop();
    f.host = new Host(binary, data);
    const previous = { node: process.env.DECKWISE_PPTX_NODE, worker: process.env.DECKWISE_PPTX_WORKER };
    if (f.requireParser) {
      process.env.DECKWISE_PPTX_NODE = process.execPath;
      process.env.DECKWISE_PPTX_WORKER = fileURLToPath(new URL("../../../packages/courseware-runtime/dist/pptx-worker.mjs", import.meta.url));
    }
    try { await f.host.start(); }
    finally {
      if (previous.node === undefined) delete process.env.DECKWISE_PPTX_NODE; else process.env.DECKWISE_PPTX_NODE = previous.node;
      if (previous.worker === undefined) delete process.env.DECKWISE_PPTX_WORKER; else process.env.DECKWISE_PPTX_WORKER = previous.worker;
    }
    const instance = f.host;
    f.gateway = { async call(method, params) {
      f.rpc.push({ method, params: clone(params) });
      return instance.call(method, params, 15_000);
    } };
  };
  await f.restartHost();
  f.sessionId = (await f.gateway.call("session.create", { projectPath: workspace })).session.id;
  await f.gateway.call("courseware.task.set", { sessionId: f.sessionId, taskType: "plain", educationContext: { grade: "Grade 3" } });
  f.make = () => new CoursewareOnlinePreparation({ editor, auth, getHost: () => f.gateway, getWorkspace: async () => workspace,
    getSessionId: () => f.sessionId, assertOwned(id) { assert.equal(id, f.sessionId); } });
  f.main = f.make();
  f.receipt = async () => (await f.gateway.call("courseware.onlinePrepare.get", { sessionId: f.sessionId, principalKey })).receipt;
  f.task = async () => (await f.gateway.call("courseware.task.get", { sessionId: f.sessionId })).task;
  f.posts = suffix => f.http.filter(row => row.method === "POST" && row.route === `${base}${suffix}`);
  f.assertNoFixtureErrors = () => assert.deepEqual(f.errors.map(error => error.message), []);
  f.assertFreshTokens = () => assert.equal(f.tokenCount, f.http.length);
  f.initializeSeed = async () => {
    f.requireParser = true; await f.restartHost();
    const { jobId } = await f.gateway.call("courseware.parseStart", { sessionId: f.sessionId, path: savedPath });
    const deadline = Date.now() + 90_000;
    let parsed;
    while (Date.now() < deadline) {
      parsed = await f.gateway.call("courseware.parseStatus", { jobId });
      if (parsed.status !== "RUNNING") break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(parsed.status, "SUCCEEDED", JSON.stringify(parsed));
    const { project } = await f.gateway.call("courseware.project.initializeGenerated", {
      sessionId: f.sessionId, jobId, sourceSha256: sha256, title: "Teaching seed integration",
      narrations: Array.from({ length: parsed.summary.pages }, (_, i) => `Welcome to page ${i + 1}.`),
    });
    await f.gateway.call("courseware.parseRelease", { jobId });
    assert.equal(project.projectId, "office-lesson");
    const context = await f.gateway.call("courseware.project.context", { sessionId: f.sessionId, projectId: project.projectId });
    assert.deepEqual(context.project, project); assert.equal(context.mapping.sourceSha256, sha256);
    assert.deepEqual(context.mapping.pages.map(page => page.pageId), project.pages.map(page => page.pageId));
    return context;
  };
  return f;
}

test("real preparation/HTTP/Host reviews without writes, confirms source CAS and durable task binding, then pins join", { timeout: 90_000 }, async t => {
  const f = await fixture(t);
  assert.equal(await f.receipt(), null);
  const beforeTask = await f.task(), beforeRpc = f.rpc.length;
  const review = await f.main.review(f.sessionId, projectId);
  assert.equal(review.sha256, sha256); assert.equal(review.byteLength, pptx.length);
  assert.equal(f.http.some(row => row.method === "POST"), false);
  assert.equal(f.rpc.slice(beforeRpc).some(row => ["courseware.onlinePrepare.begin", "courseware.onlinePrepare.advance", "courseware.task.bindTeam"].includes(row.method)), false);
  assert.equal(await f.receipt(), null); assert.deepEqual(await f.task(), beforeTask);
  const result = await f.main.confirm(review.reviewId);
  const receipt = await f.receipt();
  assert.equal(receipt.phase, "bound"); assert.equal(receipt.requestId, f.source.requestId);
  assert.equal(receipt.uploadedRevision, uploadRevision); assert.equal(receipt.sessionEpoch, 1);
  const task = await f.task();
  assert.equal(task.teamProjectId, projectId); assert.deepEqual(task.educationContext, beforeTask.educationContext);
  assert.deepEqual(result, { projectId, sessionEpoch: 1, source: { revision: uploadRevision, sha256 } });
  assert.deepEqual(f.http.filter(row => row.method === "POST").map(row => row.route), [
    `/courseware/team/projects/${projectId}/sources`, `/courseware/team/projects/${projectId}/editing-session`,
    `/courseware/team/projects/${projectId}/editing-session/document-binding`,
  ]);
  const prepared = clone(f.session), preparedKey = f.boundKey;
  f.session = { ...f.session, epoch: 2, sessionId: randomUUID() }; f.boundKey = f.session.sessionId;
  await assert.rejects(f.main.join(projectId), /PREPARATION_CHANGED/);
  f.session = prepared; f.boundKey = preparedKey;
  const launch = await f.main.join(projectId);
  assert.equal(launch.sessionEpoch, result.sessionEpoch); assert.deepEqual(launch.source, result.source);
  assert.equal(f.posts("/sources").length, 1); assert.equal(f.posts("/editing-session").length, 1);
  await assert.rejects(f.main.confirm(review.reviewId), /PREPARATION_CHANGED/);
  await f.restartHost();
  assert.equal((await f.receipt()).phase, "bound"); assert.equal((await f.task()).teamProjectId, projectId);
  f.assertNoFixtureErrors(); f.assertFreshTokens();
  t.diagnostic(`Real Host receipt/task binding survived restart; PPTX bytes=${pptx.length}, SHA256=${sha256}; upload/start/bind=1/1/1`);
});

test("accepted start with lost HTTP response resumes after real Host restart and rebuilt Main without repeat upload/start", { timeout: 90_000 }, async t => {
  const f = await fixture(t), review = await f.main.review(f.sessionId, projectId);
  f.dropStart = true;
  await assert.rejects(f.main.confirm(review.reviewId));
  const interrupted = await f.receipt();
  assert.equal(interrupted.phase, "start-pending"); assert.equal(f.session.active, true);
  assert.equal((await f.task()).teamProjectId, undefined);
  assert.equal(f.posts("/sources").length, 1); assert.equal(f.posts("/editing-session").length, 1);
  await f.restartHost(); f.main = f.make();
  assert.deepEqual(await f.receipt(), interrupted);
  const beforeHttp = f.http.length, beforeRpc = f.rpc.length;
  const recovered = await f.main.review(f.sessionId, projectId);
  assert.equal(recovered.recovering, true);
  assert.equal(f.http.slice(beforeHttp).some(row => row.method === "POST"), false);
  assert.equal(f.rpc.slice(beforeRpc).some(row => row.method !== "session.get" && row.method !== "courseware.task.get" && row.method !== "courseware.onlinePrepare.get"), false);
  const result = await f.main.confirm(recovered.reviewId), saved = await f.receipt();
  assert.equal(saved.phase, "bound"); assert.equal(saved.requestId, interrupted.requestId);
  assert.equal(saved.uploadedRevision, interrupted.uploadedRevision);
  assert.equal((await f.task()).teamProjectId, projectId);
  assert.equal(f.posts("/sources").length, 1); assert.equal(f.posts("/editing-session").length, 1);
  assert.equal(f.posts("/editing-session/document-binding").length, 1);
  const launch = await f.main.join(projectId);
  assert.deepEqual(launch.source, result.source); assert.equal(launch.sessionEpoch, 1);
  await f.restartHost();
  assert.deepEqual(await f.receipt(), saved); assert.equal((await f.task()).teamProjectId, projectId);
  f.assertNoFixtureErrors(); f.assertFreshTokens();
  t.diagnostic("Accepted lost start response recovered original durable request after Host+Main restart; upload/start/bind=1/1/1");
});

test("real Host teaching context and seed pins survive lost HTTP initialization and Host/Main restart", { timeout: 120_000 }, async t => {
  const f = await fixture(t), context = await f.initializeSeed();
  const { onlineTeachingSeed } = modules.get("./courseware-online-seed");
  const expectedPins = onlineTeachingSeed(context, "office-lesson", sha256).pins;
  const beforeTask = await f.task(), beforeRpc = f.rpc.length;
  const review = await f.main.review(f.sessionId, projectId, true);
  assert.deepEqual(review.teaching, { pageCount: context.project.pages.length, narrationCount: context.project.pages.length });
  assert.equal(f.http.some(row => row.method === "POST"), false); assert.equal(await f.receipt(), null);
  assert.deepEqual(await f.task(), beforeTask);
  assert(!f.rpc.slice(beforeRpc).some(row => /onlinePrepare\.(begin|advance)$/u.test(row.method)));
  f.dropTeaching = true;
  await assert.rejects(f.main.confirm(review.reviewId));
  const interrupted = await f.receipt(), acceptedTeaching = clone(f.teaching), acceptedMapping = clone(f.mapping);
  assert.deepEqual(f.teachingPosts[0].mapping, context.mapping);
  assert.deepEqual(acceptedMapping, { projectId, source: { revision: uploadRevision, sha256 }, mapping: context.mapping });
  assert.equal(interrupted.phase, "uploaded"); assert.deepEqual(interrupted.teaching, expectedPins);
  assert.equal(interrupted.requestId, f.teachingRequest); assert.equal((await f.task()).teamProjectId, undefined);
  assert.equal(f.posts("/sources").length, 1); assert.equal(f.posts("/teaching").length, 1);
  assert.equal(f.posts("/editing-session").length, 0);
  await f.restartHost(); f.main = f.make();
  assert.deepEqual(await f.receipt(), interrupted);
  assert.deepEqual(await f.gateway.call("courseware.project.context", { sessionId: f.sessionId, projectId: "office-lesson" }), context);
  const before = f.http.length, recovered = await f.main.review(f.sessionId, projectId, true);
  assert.equal(recovered.recovering, true); assert(!f.http.slice(before).some(row => row.method === "POST"));
  assert(f.http.slice(before).some(row => row.route === `${baseRoute()}/teaching/mappings/${context.mapping.revision}` &&
    row.query === `?sourceRevision=${uploadRevision}`));
  const result = await f.main.confirm(recovered.reviewId), saved = await f.receipt();
  assert.equal(saved.phase, "bound"); assert.deepEqual(saved.teaching, expectedPins);
  assert.equal(saved.requestId, interrupted.requestId); assert.equal((await f.task()).teamProjectId, projectId);
  assert.deepEqual(f.teachingPosts[0], f.teachingPosts[1]); assert.deepEqual(f.teaching, acceptedTeaching);
  assert.deepEqual(f.mapping, acceptedMapping);
  assert.deepEqual(f.http.filter(row => row.method === "POST").map(row => row.route), [
    `${baseRoute()}/sources`, `${baseRoute()}/teaching`, `${baseRoute()}/teaching`,
    `${baseRoute()}/editing-session`, `${baseRoute()}/editing-session/document-binding`,
  ]);
  assert.deepEqual((await f.main.join(projectId)).source, result.source);
  await f.restartHost(); assert.deepEqual(await f.receipt(), saved);
  assert.equal((await f.task()).teamProjectId, projectId);
  f.assertNoFixtureErrors(); f.assertFreshTokens();
  t.diagnostic(`Actual saved parser + Host context/receipt persisted all four teaching pins including complete mapping; pages=${context.project.pages.length}; GET map pins source tuple; lost init replay same request/body; upload/init/start/bind=1/2/1/1`);
});

function baseRoute() { return `/courseware/team/projects/${projectId}`; }
