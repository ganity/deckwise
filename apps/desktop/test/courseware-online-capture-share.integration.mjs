import * as coursewareRuntime from "../electron/main/courseware-runtime.ts";
/** Main IPC → real Host/parser/SQLite → real fixed build → isolated Platform HTTP.
 * Native Docs and the remote Platform/OSS are fixtures, not a real Docs acceptance gate.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import ts from "typescript";
import * as shared from "../../../packages/shared/dist/index.js";
import * as runtime from "../../../packages/courseware-runtime/dist/node.mjs";
import { Host } from "../../../scripts/e2e/host.mjs";
import { loadCoursewareMedia } from "./fixtures/courseware-media-loader.mjs";

const binary = process.env.DECKWISE_E2E_ONLINE_CAPTURE_HOST;
const worker = process.env.DECKWISE_E2E_ONLINE_CAPTURE_WORKER;
assert(binary && worker && isAbsolute(binary) && isAbsolute(worker),
  "Set absolute DECKWISE_E2E_ONLINE_CAPTURE_HOST and DECKWISE_E2E_ONLINE_CAPTURE_WORKER; no build or fallback is performed");
const output = process.env.DECKWISE_E2E_ONLINE_CAPTURE_OUTPUT;
if (output) { assert(isAbsolute(output)); await fs.mkdir(output); }
const require = createRequire(import.meta.url);
const modules = new Map([["@pi-desktop/shared", shared], ["@pi-desktop/courseware-runtime/node", runtime]]);
async function load(name, dependencies = {}) {
  const exports = {}, source = await fs.readFile(new URL(`../electron/main/${name}.ts`, import.meta.url), "utf8");
  new Function("require", "exports", ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText)(id => {
    if (Object.hasOwn(dependencies, id)) return dependencies[id];
    if (id.startsWith("node:")) return require(id);
    assert(modules.has(id), `Unexpected dependency: ${id}`); return modules.get(id);
  }, exports);
  modules.set(`./${name}`, exports); return exports;
}
for (const name of ["office-file", "courseware-online-editing", "courseware-online-source-files", "courseware-online-snapshot",
  "courseware-online-teaching", "courseware-online-pause", "courseware-online-barrier", "courseware-online-deployment",
  "courseware-fixed-build", "courseware-build-files"]) await load(name);
await load("courseware-online-source-review", {
  "./courseware-source-visuals": { renderCoursewareSourceVisuals() { assert.fail("No native preview is requested in this gate"); } },
});
const { CoursewareOnlineEditingClient } = modules.get("./courseware-online-editing");
const { CoursewareMediaClient } = await loadCoursewareMedia();
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const clone = value => structuredClone(value);
const projectId = "22222222-2222-4222-8222-222222222222", ownerId = randomUUID();
const originalRevision = randomUUID(), oldTeachingRevision = randomUUID(), pauseId = randomUUID(), barrierId = randomUUID();
const documentKey = randomUUID(), clientId = randomUUID(), audioId = randomUUID(), epoch = 7, callbackId = "c".repeat(64);
const token = "isolated-integration-access", principalKey = "a".repeat(64);
const originalBytes = await fs.readFile(new URL("../../../packages/courseware-runtime/tests/fixtures/office-lineage-b7/source.pptx", import.meta.url));
const targetBytes = await fs.readFile(new URL("../../../packages/courseware-runtime/tests/fixtures/office-lineage-b7/native-edited.pptx", import.meta.url));
assert.notEqual(digest(originalBytes), digest(targetBytes));
const audioBytes = Buffer.alloc(44 + 1600);
audioBytes.write("RIFF"); audioBytes.writeUInt32LE(audioBytes.length - 8, 4); audioBytes.write("WAVEfmt ", 8);
audioBytes.writeUInt32LE(16, 16); audioBytes.writeUInt16LE(1, 20); audioBytes.writeUInt16LE(1, 22);
audioBytes.writeUInt32LE(8000, 24); audioBytes.writeUInt32LE(16000, 28); audioBytes.writeUInt16LE(2, 32);
audioBytes.writeUInt16LE(16, 34); audioBytes.write("data", 36); audioBytes.writeUInt32LE(1600, 40);

test("public capture persists independent online snapshot; public fixed build/share survives Host restart and lost publish response", { timeout: 180_000 }, async t => {
  const root = await fs.mkdtemp(join(tmpdir(), "deckwise-online-capture-share-"));
  const data = join(root, "data"), workspace = join(root, "workspace");
  await fs.mkdir(workspace); await fs.mkdir(join(data, "plugins/market"), { recursive: true });
  await fs.writeFile(join(data, "plugins/market/catalog.json"), JSON.stringify({ schemaVersion: 2, providerId: "official", plugins: [] }));
  const sourcePath = join(workspace, "original.pptx"); await fs.writeFile(sourcePath, originalBytes);
  const f = { host: null, gateway: null, project: null, mapping: null, saved: null, captured: null,
    requests: [], rpc: [], errors: [], uploaded: new Map(), pointer: null, receipt: null, captureDrop: true, shareDrop: true, disposed: [], hostPids: [] };
  const base = `/courseware/team/projects/${projectId}`, publication = `${base}/editing-session/${epoch}`;
  const report = { status: "RUNNING", realMainIpc: true, realHost: true, realParser: true, realSqlite: true,
    realFixedBuild: true, externalHttpFixture: true, realDocs: false, realPlatform: false, paidCalls: false, checks: [] };
  let baseUrl, sessionId, currentInvoke, activeViewId;
  const server = createServer(async (req, res) => {
    const json = (value, code = 200) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ code, data: value })); };
    try {
      const url = new URL(req.url, "http://fixture"), path = url.pathname;
      f.requests.push({ method: req.method, path });
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      if (path === "/archives/original" || path === "/archives/saved") {
        assert.equal(req.headers.authorization, undefined, "Storage never receives the Platform bearer");
        const body = path.endsWith("original") ? originalBytes : targetBytes;
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": body.length }); res.end(body); return;
      }
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      const input = bytes.length && !req.headers["content-type"]?.startsWith("multipart/") ? JSON.parse(bytes.toString("utf8")) : null;
      if (path === `${base}/editing-session`) return json({ projectId, epoch, sessionId: documentKey, active: true });
      if (path === `${publication}/write-pauses/current` || path === `${publication}/write-pauses/${pauseId}`) return json({ projectId, sessionEpoch: epoch, pauseId, state: "held",
        teaching: { project: f.project, mappingRevision: f.mapping.revision } });
      if (path === `${publication}/native-barriers/current` || path === `${publication}/native-barriers/${barrierId}`) return json({ projectId, sessionEpoch: epoch, barrierId, pauseId,
        state: "held", coverage: "managed", allRegisteredClientsHeld: true, authoritativeCoverage: false,
        consistentPublicationReady: false, proof: "client-reported", reasons: ["DOCS_COVERAGE_NOT_VERIFIED"],
        clients: [{ clientId, docsUserId: `tenant-1-user-2-client-${clientId}`, state: "held", nativeReady: true, lastSeenEpochMillis: Date.now() }] });
      if (path === `${base}/teaching/mappings/${f.mapping.revision}`) {
        assert.equal(url.searchParams.get("sourceRevision"), originalRevision);
        return json({ projectId, source: f.project.source, mapping: f.mapping });
      }
      if (path === `${publication}/native-barriers/${barrierId}/force-saves`) {
        assert.equal(req.method, "POST"); assert.deepEqual(Object.keys(input), ["requestId"]); assert.equal(f.saved, null);
        f.saved = { requestId: input.requestId, key: documentKey, sessionEpoch: epoch, state: "archived", commandError: 0, callbackId };
        return json(f.saved);
      }
      if (path === `${publication}/callbacks/${callbackId}/archive`) return json({ receipt: { callbackId, key: documentKey,
        sessionEpoch: epoch, documentStatus: 6, state: "archived", sha256: digest(targetBytes), byteLength: targetBytes.length },
      downloadUrl: `${baseUrl}/archives/saved` });
      if (path === `${base}/sources/${originalRevision}/download`) return json({ version: { projectId, source: f.project.source,
        byteLength: originalBytes.length, requestId: randomUUID(), sessionEpoch: null, callbackId: null }, downloadUrl: `${baseUrl}/archives/original` });
      if (path === `${base}/teaching/verified-source-reviews`) {
        assert.equal(req.method, "POST"); assert.equal(input.barrierId, barrierId); assert.equal(input.pauseId, pauseId);
        assert.equal(input.forceSaveRequestId, f.saved.requestId); assert.equal(input.expectedSourceRevision, originalRevision);
        assert.equal(input.expectedTeachingRevision, oldTeachingRevision); assert.equal(input.sessionEpoch, epoch); assert.equal(f.captured, null);
        assert(shared.isCoursewareProject(input.project)); assert(shared.isCoursewareOnlineSourceMapping(input.mapping));
        f.captured = { snapshotId: input.requestId, sessionEpoch: epoch, forceSaveRequestId: f.saved.requestId, callbackId,
          sourceByteLength: targetBytes.length, baselineSourceRevision: originalRevision, baselineTeachingRevision: oldTeachingRevision,
          teaching: { project: { ...clone(input.project), teachingRevision: randomUUID() }, mappingRevision: input.mapping.revision }, mapping: clone(input.mapping) };
        if (f.captureDrop) { f.captureDrop = false; req.socket.destroy(); return; }
        return json(f.captured);
      }
      if (f.captured && path === `${base}/teaching/verified-source-reviews/${f.captured.snapshotId}`) return json(f.captured);
      if (path === `${base}/assets/${audioId}`) return json({ projectId, assetRef: { assetId: audioId, sha256: digest(audioBytes),
        mime: "audio/wav", byteLength: audioBytes.length, downloadPath: `${base}/assets/${audioId}/content` } });
      if (path === `${base}/assets/${audioId}/content`) { res.writeHead(200, { "content-type": "audio/wav" }); res.end(audioBytes); return; }
      if (path === `${base}/fixed-builds` && req.method === "POST") {
        assert.equal(f.uploaded.size, 0, "Do not upload a second time during recovery");
        const form = await new Request(`${baseUrl}/upload`, { method: "POST", headers: req.headers, body: bytes }).formData();
        for (const file of [form.get("manifest"), ...form.getAll("files")]) f.uploaded.set(file.name, Buffer.from(await file.arrayBuffer()));
        assert.equal(digest(f.uploaded.get("manifest.json")), url.searchParams.get("manifestSha256"));
        assert.equal(digest(f.uploaded.get("package.json")), url.searchParams.get("buildId"));
        assert.deepEqual(f.uploaded.get("source.pptx"), targetBytes);
        f.build = { buildId: url.searchParams.get("buildId"), snapshotId: url.searchParams.get("snapshotId"), packageSha256: url.searchParams.get("buildId") };
        return json(f.build);
      }
      if (path === `${base}/publish/formal`) return json(f.pointer ?? { projectId, channel: "formal", buildId: null, snapshotId: null, packageSha256: null, version: 0 });
      if (path === `${base}/publish` && req.method === "POST") {
        assert.equal(f.receipt, null, "Publication is not retried"); assert.equal(input.expectedVersion, 0); assert.equal(input.channel, "formal");
        f.pointer = { projectId, channel: "formal", ...f.build, version: 1 };
        f.receipt = { intentId: input.intentId, expectedVersion: 0, pointer: clone(f.pointer) };
        if (f.shareDrop) { f.shareDrop = false; req.socket.destroy(); return; }
        return json(f.pointer);
      }
      if (f.build && path === `${base}/fixed-builds/${f.build.buildId}`) return json({ build: f.build,
        manifestSha256: digest(f.uploaded.get("manifest.json")), expiresAt: new Date(Date.now() + 60_000).toISOString(),
        files: [...f.uploaded].map(([path, bytes]) => ({ file: { path, sha256: digest(bytes), byteLength: bytes.length,
          mimeType: path === "source.pptx" ? "application/vnd.openxmlformats-officedocument.presentationml.presentation" :
            path.endsWith(".json") ? "application/json" : "audio/wav" },
        downloadUrl: `https://fixture.oss-cn-hangzhou.aliyuncs.com/${path}?fixture=1` })) });
      if (f.receipt && path === `${base}/publish/receipts/${f.receipt.intentId}`) return json(f.receipt);
      assert.fail(`Unexpected fixture request: ${req.method} ${path}`);
    } catch (error) { f.errors.push(error); if (!res.headersSent) res.writeHead(500); res.end(JSON.stringify({ code: 500 })); }
  });
  const previousWorker = process.env.DECKWISE_PPTX_WORKER, previousNode = process.env.DECKWISE_PPTX_NODE;
  process.env.DECKWISE_PPTX_WORKER = join(worker, "pptx-worker.mjs"); process.env.DECKWISE_PPTX_NODE = process.execPath;
  t.after(async () => {
    if (activeViewId && currentInvoke) await currentInvoke("coursewareOnlineSourceClear", { viewId: activeViewId }).catch(() => {});
    for (const dispose of f.disposed.splice(0)) dispose();
    await f.host?.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    if (previousWorker === undefined) delete process.env.DECKWISE_PPTX_WORKER; else process.env.DECKWISE_PPTX_WORKER = previousWorker;
    if (previousNode === undefined) delete process.env.DECKWISE_PPTX_NODE; else process.env.DECKWISE_PPTX_NODE = previousNode;
    if (output) await fs.writeFile(join(output, "report.json"), JSON.stringify({ ...report, hostPids: f.hostPids, http: f.requests,
      rpcMethods: f.rpc.map(row => row.method), fixtureErrors: f.errors.map(error => error.message) }, null, 2));
    await fs.rm(root, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); baseUrl = `http://127.0.0.1:${server.address().port}`;
  async function start() {
    await f.host?.stop(); f.host = new Host(binary, data); await f.host.start(); f.hostPids.push(f.host.child.pid);
    const host = f.host;
    f.gateway = { call(method, params) { f.rpc.push({ method, params: clone(params) }); return host.call(method, params, 95_000); }, onExit() { return () => {}; } };
  }
  const call = (method, params) => f.gateway.call(method, params);
  async function parse(path) {
    const { jobId } = await call("courseware.parseStart", { sessionId, path }), deadline = Date.now() + 95_000;
    while (Date.now() < deadline) {
      const result = await call("courseware.parseStatus", { jobId });
      if (result.status !== "RUNNING") { assert.equal(result.status, "SUCCEEDED", JSON.stringify(result));
        return { jobId, identity: JSON.parse(await fs.readFile(join(result.outputDirectory, "identity.json"), "utf8")) }; }
      await delay(25);
    }
    assert.fail("Parser timeout");
  }
  const principal = { tenantId: 1, userId: 2 }, options = { baseUrl, fetch, getPrincipal: () => principal, resolveAccessToken: async () => token };
  const onlineClient = new CoursewareOnlineEditingClient(options), media = new CoursewareMediaClient(options);
  const auth = { getCoursewareOnlineClient: () => onlineClient, coursewareMedia: media,
    getCoursewarePrincipal: () => ({ key: principalKey, assertCurrent() {} }), onStateChanged: () => () => {} };
  const binding = () => ({ ownerId, projectId, sessionEpoch: epoch, source: clone(f.project.source) });
  class NativeViewFixture { teachingBinding(id) { assert.equal(id, ownerId); return binding(); } registryBinding(id) {
    assert.equal(id, ownerId); return { documentKey }; } dispose() {} }
  const { registerCoursewareOnlineIpc } = await load("ipc/courseware-online-ipc", Object.fromEntries([
    ["../courseware-online-view", { CoursewareOnlineViewController: NativeViewFixture }],
    ...["courseware-online-deployment", "courseware-online-teaching", "courseware-online-pause", "courseware-online-barrier", "courseware-online-source-review"]
      .map(name => [`../${name}`, modules.get(`./${name}`)]),
  ]));
  const { registerCoursewarePlaybackIpc } = await load("ipc/courseware-playback-ipc", {
    "../courseware-runtime": coursewareRuntime, "../courseware-fixed-build": modules.get("./courseware-fixed-build"), "../courseware-build-files": modules.get("./courseware-build-files"),
    "../courseware-player-preview": { CoursewarePlayerPreview: class { close() {} } },
  });
  function register() {
    const handlers = new Map(), frame = {}, sender = { id: 1, mainFrame: frame }, event = { sender, senderFrame: frame };
    const registrar = { ipcMain: {}, assertMainWindowSender(value) { assert.equal(value, event); },
      handleWithEvent(channel, handler) { assert(!handlers.has(channel)); handlers.set(channel, handler); } };
    const common = { registrar, authSession: auth, getMainWindow: () => null, getHost: () => f.gateway,
      getWorkspaceRoot: async () => workspace, getViewingSessionId: () => sessionId };
    f.disposed.push(registerCoursewareOnlineIpc({ ...common, sendToRenderer() {} }));
    f.disposed.push(registerCoursewarePlaybackIpc({ ...common, dataDir: data }));
    currentInvoke = (name, payload) => { assert(handlers.has(shared.IPC.invoke[name]), name); return handlers.get(shared.IPC.invoke[name])(event, payload); };
    return currentInvoke;
  }
  await start(); sessionId = (await call("session.create", { projectPath: workspace })).session.id;
  await call("courseware.task.set", { sessionId, taskType: "import" });
  const parsed = await parse(sourcePath);
  f.project = { schemaVersion: "deckwise-courseware/1", projectId, taskType: "import", title: "Online fixed publication integration",
    source: { revision: originalRevision, sha256: digest(originalBytes) }, teachingRevision: oldTeachingRevision,
    pages: parsed.identity.pages.map((_, index) => ({ pageId: `page-${index + 1}`, locked: false, reviewState: "ready",
      actions: [{ id: `speech-${index + 1}`, type: "speech", text: `Good! This is page ${index + 1}.`, audioAssetId: audioId }] })) };
  f.mapping = { revision: "mapping-original", sourceSha256: f.project.source.sha256, pages: parsed.identity.pages.map((page, index) => ({
    pageId: f.project.pages[index].pageId, importPageId: page.importPageId,
    objects: page.objects.map((object, i) => ({ objectId: `object-${index}-${i}`, importElementId: object.importElementId })) })) };
  await call("courseware.parseRelease", { jobId: parsed.jobId });
  let invoke = register();
  const view = await invoke("coursewareOnlineSourceBegin", { ownerId, sessionId });
  activeViewId = view.viewId;
  assert.equal(view.targetPages.length, 3); assert.deepEqual(view.original.project, f.project);
  const decisions = { pages: view.targetPages.map((page, index) => ({ kind: "carry", targetImportPageId: page.importPageId,
    oldPageId: view.previousPages[index].pageId, confirmReady: true })), removedPages: [], cues: [] };
  const resolved = await invoke("coursewareOnlineSourceResolve", { viewId: view.viewId, decisions });
  assert.equal(resolved.readyPages, 3); assert.equal(f.captured, null);
  await assert.rejects(invoke("coursewareOnlineSourceCapture", { viewId: view.viewId }), /CAPTURE_UNCERTAIN/);
  const captureRecoveryOffset = f.requests.length;
  const captured = await invoke("coursewareOnlineSourceCapture", { viewId: view.viewId });
  assert(f.requests.slice(captureRecoveryOffset).every(row => row.method === "GET"), "Unknown capture recovers without a second POST");
  assert.deepEqual(captured.snapshot.assetIds, [audioId]); assert.equal(captured.snapshot.source.sha256, digest(targetBytes));
  assert.deepEqual(await invoke("coursewareOnlineSourceCapture", { viewId: view.viewId }), captured);
  const selection = { sessionId, projectId, snapshotId: captured.snapshot.snapshotId };
  const frozen = await call("courseware.snapshot.get", selection);
  assert.deepEqual(frozen.snapshot, captured.snapshot); assert.deepEqual(frozen.project, f.captured.teaching.project);
  assert.deepEqual(await fs.readFile(frozen.sourcePath), targetBytes); assert.notEqual(frozen.sourcePath, sourcePath);
  assert.deepEqual(await fs.readFile(frozen.assets[0].path), audioBytes);
  assert.equal((await call("courseware.snapshot.onlineOrigin", selection)).teamProjectId, projectId);
  assert.deepEqual(f.project.source, { revision: originalRevision, sha256: digest(originalBytes) });
  assert.equal(f.project.teachingRevision, oldTeachingRevision, "Capture does not replace the remote live teaching");
  assert.equal(f.requests.filter(row => row.method === "POST" && row.path.endsWith("/teaching/verified-source-reviews")).length, 1);
  report.checks.push("Public begin/explicit resolve/capture → lost reply/GET recovery → real parser/Host → immutable UUID audio/PPTX snapshot");
  await invoke("coursewareOnlineSourceClear", { viewId: view.viewId });
  activeViewId = undefined;
  f.project.teachingRevision = randomUUID(); f.project.pages[0].actions[0].text = "Later live R9 narration";
  const liveR9 = clone(f.project);
  for (const dispose of f.disposed.splice(0)) dispose();
  await fs.writeFile(sourcePath, Buffer.from("changed live source after capture"));
  await start(); invoke = register();
  assert.deepEqual(await call("courseware.snapshot.get", selection), frozen);
  assert.deepEqual(f.project, liveR9, "Fixed publication never rewrites the later live R9 teaching");
  report.checks.push("Host restart recovers exact persisted snapshot independently of the live source");
  let build = await invoke("coursewareFixedBuild", selection);
  if (build.status === "review") {
    const codes = [...new Set(build.diagnostics.filter(entry => (entry.severity ?? "warning") === "warning").map(entry => entry.code))];
    report.reviewedWarnings = codes;
    build = await invoke("coursewareFixedApprove", { reviewId: build.reviewId, codes });
  }
  assert.equal(build.status, "ready", JSON.stringify(build)); assert.equal(build.buildRef.snapshotId, selection.snapshotId);
  await assert.rejects(invoke("coursewareFixedShare", { previewId: build.previewId, projectId, sessionId, channel: "formal" }), /result is unknown/);
  assert(f.receipt); const status = await invoke("coursewareFixedShareStatus", { sessionId });
  assert.equal(status.intent.state, "unknown"); assert.equal(status.intent.receiptAware, true);
  assert.equal(status.intent.selection.snapshotId, selection.snapshotId);
  report.checks.push("Real fixed worker build and public share upload exact bytes; lost publish reply keeps a durable unknown intent");
  for (const dispose of f.disposed.splice(0)) dispose();
  await start(); invoke = register();
  assert.deepEqual(await call("courseware.snapshot.get", selection), frozen);
  const persistedStatus = await invoke("coursewareFixedShareStatus", { sessionId }); assert.deepEqual(persistedStatus, status);
  const before = f.requests.length;
  const recovered = await invoke("coursewareFixedShareRecover", { sessionId, intentId: status.intent.intentId });
  assert.equal(recovered.intent.state, "bound");
  assert.deepEqual(f.requests.slice(before).map(({ method, path }) => ({ method, path })), [
    { method: "GET", path: `${base}/fixed-builds/${build.buildRef.buildId}` },
    { method: "GET", path: `${base}/publish/receipts/${status.intent.intentId}` },
  ]);
  assert.deepEqual(f.errors.map(error => error.message), []);
  assert.equal(f.requests.filter(row => row.method === "POST" && row.path.endsWith("/publish")).length, 1);
  report.checks.push("Second Host restart preserves share receipt identity; public recovery uses two GETs and never repeats publication");
  for (const dispose of f.disposed.splice(0)) dispose(); await f.host.stop(); f.host = null;
  async function databases(directory) {
    const found = []; for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name); if (entry.isDirectory()) found.push(...await databases(path));
      else if (entry.name.endsWith(".sqlite")) found.push(path);
    } return found;
  }
  const dbs = await databases(data); assert.equal(dbs.length, 1);
  const dbReadback = spawnSync("python3", ["-c", "import sqlite3,json,sys; c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); print(json.dumps([dict(ns=r[0],key=r[1],value=json.loads(r[2])) for r in c.execute(\"select ns,key,value_json from kv where ns in ('coursewareSnapshots.v1','coursewareOnlineSnapshots.v1')\")]))", dbs[0]], { encoding: "utf8" });
  assert.equal(dbReadback.status, 0, dbReadback.stderr);
  const rows = JSON.parse(dbReadback.stdout); assert.equal(rows.length, 2);
  assert.deepEqual(rows.find(row => row.ns === "coursewareSnapshots.v1").value.snapshot, captured.snapshot);
  assert.deepEqual(rows.find(row => row.ns === "coursewareOnlineSnapshots.v1").value, captured.snapshot);
  report.checks.push("Independent read-only SQLite query matches the exact snapshot and online origin marker");
  report.status = "PASSED"; report.binarySha256 = digest(await fs.readFile(binary));
  report.workerManifestSha256 = digest(await fs.readFile(join(worker, "manifest.json")));
  report.snapshot = captured.snapshot; report.buildRef = build.buildRef;
  if (output) {
    await fs.writeFile(join(output, "snapshot-export.json"), JSON.stringify(frozen, null, 2));
    await fs.writeFile(join(output, "sqlite-readback.json"), JSON.stringify(rows, null, 2));
    await fs.copyFile(dbs[0], join(output, "isolated.sqlite"));
    await fs.writeFile(join(output, "snapshot-source.pptx"), await fs.readFile(frozen.sourcePath));
    for (const [name, bytes] of f.uploaded) { const path = join(output, "uploaded", name); await fs.mkdir(join(path, ".."), { recursive: true }); await fs.writeFile(path, bytes); }
  }
});
