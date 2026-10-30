/** Actual Main coordinators, Electron auth/HTTP and Host/parser; no paid provider. */
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as timers from "node:timers/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import ts from "typescript";
import * as shared from "../../../packages/shared/dist/index.js";
import { Host } from "../../../scripts/e2e/host.mjs";

test("legacy receipt compatibility through Electron Main/auth + durable Host restart and late-result isolation", {
  skip: process.env.DECKWISE_E2E_ELECTRON_NET !== "1", timeout: 160_000,
}, async (t) => {
  const electron = (await import("electron")).default;
  const audioIngestion = process.env.DECKWISE_E2E_TTS_AUDIO === "1";
  const rebindSource = process.env.DECKWISE_TTS_REBIND_SOURCE;
  assert(!rebindSource || (path.isAbsolute(rebindSource) && audioIngestion));
  const output = process.env.DECKWISE_E2E_OUTPUT;
  const binary = process.env.PI_DESKTOP_HOST_BIN;
  const source = process.env.DECKWISE_TTS_TEST_SOURCE;
  assert([output, binary, source, process.env.DECKWISE_PPTX_WORKER, process.env.DECKWISE_PPTX_NODE].every((value) => value && path.isAbsolute(value)));
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "deckwise-tts-main-"));
  const data = path.join(temp, "data"), workspace = path.join(temp, "中文课件");
  const archive = path.join(workspace, ".deckwise-ppt/revisions/tts-main/r0001/document.pptx");
  await fs.mkdir(path.dirname(archive), { recursive: true }); await fs.copyFile(source, archive);
  const officeIdentity = process.env.DECKWISE_E2E_REAL_OFFICE_IDENTITY === "1";
  const paidUi = process.env.DECKWISE_E2E_PAID_TTS_UI === "1";
  assert(!paidUi || officeIdentity);
  const officeJobId = `document-${crypto.createHash("sha256").update(path.relative(workspace, archive).replaceAll("\\", "/")).digest("hex").slice(0, 12)}`;
  const saved = officeIdentity ? path.join(workspace, ".deckwise-ppt/revisions", officeJobId, "r0001/document.pptx") : archive;
  if (officeIdentity) {
    const bytes = await fs.readFile(archive);
    await fs.mkdir(path.dirname(saved), { recursive: true });
    await fs.copyFile(archive, saved);
    await fs.writeFile(path.join(path.dirname(saved), "revision.json"), JSON.stringify({
      revision: 1, cause: "generated", createdAt: new Date().toISOString(), file: "document.pptx",
      size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    }));
  }
  await fs.mkdir(path.join(data, "plugins/market"), { recursive: true });
  await fs.writeFile(path.join(data, "plugins/market/catalog.json"), JSON.stringify({ schemaVersion: 2, providerId: "official", plugins: [] }));
  process.env.PI_DESKTOP_PLUGIN_MARKET_URL = "http://127.0.0.1:9/catalog.json";
  const host = new Host(binary, data), stored = new Map(), checks = [], http = [], logs = [];
  const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
  const audioBytes = Buffer.alloc(1644);
  audioBytes.write("RIFF"); audioBytes.writeUInt32LE(1636, 4); audioBytes.write("WAVEfmt ", 8);
  audioBytes.writeUInt32LE(16, 16); audioBytes.writeUInt16LE(1, 20); audioBytes.writeUInt16LE(1, 22);
  audioBytes.writeUInt32LE(8000, 24); audioBytes.writeUInt32LE(16000, 28); audioBytes.writeUInt16LE(2, 32);
  audioBytes.writeUInt16LE(16, 34); audioBytes.write("data", 36); audioBytes.writeUInt32LE(1600, 40);
  const realAudioPath = process.env.DECKWISE_TTS_REAL_AUDIO_PATH;
  if (realAudioPath) assert(path.isAbsolute(realAudioPath) && audioIngestion);
  const archivedAudioBytes = realAudioPath ? await fs.readFile(realAudioPath) : audioBytes;
  const archivedAudioMime = realAudioPath ? "audio/mpeg" : "audio/wav";
  const speechText = process.env.DECKWISE_TTS_REAL_AUDIO_TEXT || "Good! 小朋友😀";
  if (realAudioPath) assert.equal(digest(archivedAudioBytes), process.env.DECKWISE_TTS_REAL_AUDIO_SHA256);
  let archiveDuration = 100;
  let downloadedBytes = archivedAudioBytes;
  let userId = 7, loseResponse = false, hideRecovery = false, duringSubmit, duringAsset, submissions = 0, standInReservations = 0;
  const token = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
  const hashRequest = (input) => digest("courseware-media-v1" + [input.kind, input.model, input.input, input.voice ?? null]
    .map((value) => `:${value === null ? -1 : value.length}:${value ?? ""}`).join(""));
  const server = createServer(async (req, res) => {
    try {
      let body = ""; for await (const chunk of req) body += chunk;
      http.push({ method: req.method, url: req.url });
      const send = (data) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ code: 200, data })); };
      if (req.url.startsWith("/auth/desktop/wx/qrcode")) return send({ ticket: "ticket-1", entryUrl: "https://fixture.test/qr" });
      if (req.url === "/auth/wx/poll/ticket-1" || req.url === "/auth/desktop/refresh") return send({ status: "SUCCESS", accessToken: token, refreshToken: "fixture-refresh" });
      if (req.url === "/auth/me") return send({ edition: "EDUCATION", pcAllowed: true, role: "ADMIN", tenantId: 8, userId });
      if (req.url === "/auth/logout") return send({});
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname === "/courseware/media/tasks/by-idempotency" && req.method === "GET") {
        res.setHeader("Cache-Control", "private, no-store");
        const task = stored.get(url.searchParams.get("key"));
        if (!task || hideRecovery) {
          res.setHeader("content-type", "application/json");
          return res.end(JSON.stringify({ code: 46006, message: "TASK_NOT_FOUND" }));
        }
        assert.equal(url.searchParams.get("requestHash"), task.requestHash);
        return send(task);
      }
      if (req.url === "/courseware/media/tasks" && req.method === "POST") {
        submissions++;
        const input = JSON.parse(body), key = req.headers["idempotency-key"];
        assert.equal(input.input, speechText);
        if (!stored.has(key)) {
          standInReservations++;
          stored.set(key, { version: "courseware-media-v1", taskId: `task-${standInReservations}`, idempotencyKey: key,
            requestHash: hashRequest(input), kind: "tts", model: input.model, state: "queued", feeState: "reserved",
            reservedPoints: 5, actualPoints: null, receiptId: null, errorCode: null, assetRef: null });
        }
        await duringSubmit?.();
        if (loseResponse) {
          loseResponse = false;
          res.writeHead(200, { "content-type": "application/json", "content-length": "4096" });
          res.write("{");
          setTimeout(() => res.destroy(), 20);
          return;
        }
        return send(stored.get(key));
      }
      if (audioIngestion && [...stored.values()].some((task) => req.url === `/courseware/media/tasks/${task.taskId}/asset`)) {
        await duringAsset?.();
        res.setHeader("content-type", archivedAudioMime); return res.end(downloadedBytes);
      }
      const task = [...stored.values()].find((value) => req.url === `/courseware/media/tasks/${value.taskId}`);
      if (task) return send(task);
      res.writeHead(404); res.end();
    } catch (error) { res.destroy(error); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  process.env.DECKWISE_PLATFORM_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  const native = { "node:crypto": crypto, "node:fs/promises": fs, "node:path": path, "node:os": { ...os, homedir: () => temp },
    "node:timers/promises": timers, "@pi-desktop/shared": shared, electron };
  const modules = new Map();
  async function load(name) {
    if (modules.has(name)) return modules.get(name);
    const source = await fs.readFile(new URL(`../electron/main/${name}.ts`, import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const exports = {};
    new Function("require", "exports", compiled)((id) => {
      if (Object.hasOwn(native, id)) return native[id];
      assert(id.startsWith("./") && modules.has(id.slice(2)), `Unexpected dependency ${id}`);
      return modules.get(id.slice(2));
    }, exports);
    modules.set(name, exports); return exports;
  }
  await load("courseware-media-contracts");
  await load("courseware-generation-queue");
  await load("courseware-media-transport");
  await load("courseware-music-request");
  await load("courseware-local-media");
  await load("courseware-music-media");
  await load("courseware-video-media");
  await load("courseware-media");
  const { DesktopAuthSession } = await load("auth-session");
  await load("courseware-scene-object-view");
  const { CoursewareTeachingCoordinator } = await load("courseware-teaching");
  await load("courseware-media-scope");
  const { CoursewareTtsCoordinator } = await load("courseware-tts");
  const { decodeCoursewareAudio } = await load("courseware-audio-decode");
  const auth = new DesktopAuthSession({ dataDir: data, onChanged() {}, log() {} });
  // This historical-receipt fixture keeps its old transport; the local relay has its own actual-Host test.
  auth.coursewareMedia = new (modules.get("courseware-media").CoursewareMediaClient)({
    baseUrl: process.env.DECKWISE_PLATFORM_BASE_URL,
    fetch: (url, init) => electron.net.fetch(url, init),
    resolveAccessToken: () => auth.resolveAccessToken(),
    getPrincipal: () => auth.getState().status === "authenticated" ? auth.getState().profile : null,
  });
  const report = { status: "RUNNING", checks, temp, http, realElectronNetFetch: true, realHost: true,
    realParser: true, realAudioDecoder: audioIngestion, realOffice: false, realSpringPlatform: false, paidCalls: false, audioReady: false, realProviderAudio: Boolean(realAudioPath),
    platformBaseUrl: process.env.DECKWISE_PLATFORM_BASE_URL,
    sourceHash: digest(await fs.readFile(source)), binaryHash: digest(await fs.readFile(binary)),
    workerHash: digest(await fs.readFile(process.env.DECKWISE_PPTX_WORKER)) };
  t.after(async () => {
    logs.push(host.stderr); await host.stop(); if (!officeIdentity) await auth.logout(); server.closeAllConnections(); server.close();
    report.submissions = submissions; report.standInReservations = standInReservations;
    await fs.writeFile(path.join(output, "tts-integration.json"), JSON.stringify(report, null, 2));
    await fs.writeFile(path.join(output, "host.log"), logs.join(""));
  });
  const step = async (name, operation) => { await operation(); checks.push(name); console.log("PASS", name); };
  let sessionId, project, view, coordinator, teaching, first, unknown, late;
  const snapshot = { projectId: officeIdentity ? digest(workspace) : "native-workspace",
    documentId: officeIdentity ? officeJobId : "native-document", sessionId: "native-session", path: saved, sourcePath: saved, revision: 1, sha256: report.sourceHash };
  const context = { ...snapshot, editGeneration: 1, page: 1, readOnly: false };
  let dirty = false;
  const editor = { teachingSnapshot() {
    if (dirty) throw new Error("Save or reopen the PPTX before teaching access");
    return { ...snapshot };
  }, async verifyTeachingSource() { assert.equal(digest(await fs.readFile(saved)), snapshot.sha256); }, async getContext() { return { ...context }; } };
  const baseline = () => ({ viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision });
  const operation = (intent) => ({ ...baseline(), intentId: intent.intentId });
  const prepare = () => coordinator.prepare({ ...baseline(), actionId: "speech-1", model: "courseware-tts-v1", voice: "teacher_1" });
  const scope = (intent) => ({ sessionId, projectId: project.projectId, principalKey: auth.getCoursewarePrincipal().key, intentId: intent.intentId });
  try {
  await step("Actual login, saved PPTX parsing, page write and durable preparation precede every POST", async () => {
    await host.start(); sessionId = (await host.call("session.create", { projectPath: workspace })).session.id;
    await auth.startQrLogin(); assert.equal((await auth.pollQrLogin("ticket-1")).status, "authenticated");
    teaching = new CoursewareTeachingCoordinator(editor, () => host, async () => workspace, () => sessionId, () => {});
    view = await teaching.open(sessionId);
    view = await teaching.update({ ...baseline(), actions: [{ id: "speech-1", type: "speech", text: speechText }] }, false);
    project = view.project; coordinator = new CoursewareTtsCoordinator(teaching, auth, decodeCoursewareAudio);
    first = await prepare(); assert.equal(submissions, 0);
    assert.equal((await host.call("courseware.tts.get", scope(first))).intent.request.input, speechText);
  });
  if (paidUi) {
    for (const page of project.pages) project = (await host.call("courseware.teaching.confirm", { sessionId,
      projectId: project.projectId, pageId: page.pageId, expectedSourceRevision: project.source.revision,
      expectedTeachingRevision: project.teachingRevision })).project;
    report.projectId = project.projectId;
    report.pageCount = project.pages.length;
    report.sessionId = sessionId;
    report.workspace = workspace;
    report.status = "PASS_PAID_UI_PREPARED";
    return;
  }
  await step("Explicit submit retains the canonical task; repeated submit only queries", async () => {
    assert.equal((await coordinator.submit(operation(first))).phase, "submitted");
    assert.equal((await coordinator.status(operation(first))).task.state, "queued");
    await coordinator.submit(operation(first)); assert.equal(submissions, 1); assert.equal(standInReservations, 1);
    assert.equal((await host.call("courseware.tts.get", scope(first))).intent.taskRef.taskId, "task-1");
    const ready = [...stored.values()][0];
    Object.assign(ready, { state: "ready", feeState: "settled", actualPoints: 3, receiptId: `courseware-media:${ready.taskId}`,
      assetRef: { assetId: "fixture-audio", sha256: "a".repeat(64), mime: archivedAudioMime, byteLength: 1,
        downloadPath: `/courseware/media/tasks/${ready.taskId}/asset`, durationMs: 50 } });
    const status = await coordinator.status(operation(first));
    assert.equal(status.task.state, "ready"); assert.equal(status.audioReady, false);
  });
  if (audioIngestion) {
    await step("Actual Chromium decodes WAV/MP3 and rejects matching-header corrupt audio without leaking windows", async () => {
      const previousWindows = new Set(electron.BrowserWindow.getAllWindows().map((window) => window.id));
      const windows = previousWindows.size;
      const decoding = decodeCoursewareAudio(audioBytes, "audio/wav");
      await assert.rejects(decodeCoursewareAudio(audioBytes, "audio/wav"), /DECODE_BUSY/);
      const isolated = electron.BrowserWindow.getAllWindows().find((window) => !previousWindows.has(window.id));
      assert(isolated); assert.equal(isolated.isVisible(), false);
      const preferences = isolated.webContents.getLastWebPreferences();
      assert.equal(preferences.sandbox, true); assert.equal(preferences.nodeIntegration, false);
      assert.equal(preferences.contextIsolation, true); assert(!preferences.preload);
      assert.notEqual(isolated.webContents.session, electron.session.defaultSession);
      assert.equal(await decoding, 100);
      const mp3 = await fs.readFile(new URL("./fixtures/courseware-tts-tone.mp3", import.meta.url));
      const duration = await decodeCoursewareAudio(mp3, "audio/mpeg");
      assert(duration >= 100 && duration <= 400, `Unexpected decoded MP3 duration ${duration}`);
      if (realAudioPath) {
        archiveDuration = await decodeCoursewareAudio(archivedAudioBytes, archivedAudioMime);
        assert(archiveDuration >= 100 && archiveDuration <= 300_000, `Unexpected provider audio duration ${archiveDuration}`);
      }
      const brokenWav = Buffer.alloc(44); brokenWav.write("RIFF"); brokenWav.write("WAVE", 8);
      for (const [bytes, mime] of [[brokenWav, "audio/wav"], [Buffer.from("ID3invalid"), "audio/mpeg"]])
        await assert.rejects(decodeCoursewareAudio(bytes, mime), /DECODE_FAILED/);
      await assert.rejects(decodeCoursewareAudio(mp3, "audio/wav"), /INVALID_FORMAT/);
      const oversized = Buffer.alloc(16 * 1024 * 1024 + 1); audioBytes.copy(oversized);
      await assert.rejects(decodeCoursewareAudio(oversized, "audio/wav"), /INVALID_FORMAT/);
      const interrupted = decodeCoursewareAudio(audioBytes, "audio/wav");
      const rejectClosed = assert.rejects(interrupted, /DECODE_FAILED/);
      electron.BrowserWindow.getAllWindows().find((window) => !previousWindows.has(window.id)).destroy();
      await rejectClosed;
      assert.equal(await decodeCoursewareAudio(audioBytes, "audio/wav"), 100);
      assert.equal(electron.BrowserWindow.getAllWindows().length, windows);
    });
    await step("Authorized download must decode before durable Host archive; server duration is ignored", async () => {
      const ready = [...stored.values()][0];
      downloadedBytes = archivedAudioMime === "audio/mpeg" ? Buffer.from("ID3invalid") : Buffer.alloc(44);
      if (archivedAudioMime === "audio/wav") { downloadedBytes.write("RIFF"); downloadedBytes.write("WAVE", 8); }
      const metadata = () => Object.assign(ready.assetRef, { sha256: digest(downloadedBytes), byteLength: downloadedBytes.length, durationMs: 9999 });
      metadata();
      await assert.rejects(coordinator.archive(operation(first)), /DECODE_FAILED/);
      await assert.rejects(host.call("courseware.tts.audio.get", scope(first)), /not found/);
      downloadedBytes = archivedAudioBytes; metadata();
      const result = await coordinator.archive(operation(first));
      assert.deepEqual(result, { intentId: first.intentId, archived: true, durationMs: archiveDuration, audioReady: false });
      const archived = await host.call("courseware.tts.audio.get", scope(first));
      assert.equal(archived.audio.durationMs, archiveDuration); assert.equal(archived.audio.sha256, digest(archivedAudioBytes));
      assert.deepEqual(await fs.readFile(archived.path), archivedAudioBytes);
      const current = (await host.call("courseware.tts.get", scope(first))).current;
      assert.equal(current, true); assert.equal(view.project.pages[0].actions[0].audioAssetId, undefined);
      assert.equal(submissions, 1); assert.equal(standInReservations, 1);
    });
  }
  await step("Lost response recovers the original receipt by GET after full Host restart without POST or another reservation", async () => {
    unknown = await prepare(); const before = await host.call("courseware.tts.get", scope(unknown));
    loseResponse = true; await assert.rejects(coordinator.submit(operation(unknown)), /TRANSPORT_FAILED/);
    assert.equal(submissions, 2); logs.push(host.stderr); await host.stop(); await host.start();
    coordinator = new CoursewareTtsCoordinator(teaching, auth, decodeCoursewareAudio);
    const restored = await host.call("courseware.tts.get", scope(unknown));
    assert.equal(restored.intent.phase, "submission-unknown"); assert.equal(restored.intent.idempotencyKey, before.intent.idempotencyKey);
    assert.equal((await coordinator.list(baseline())).length, 2);
    hideRecovery = true;
    assert.equal((await coordinator.status(operation(unknown))).task, null);
    assert.deepEqual((await host.call("courseware.tts.get", scope(unknown))).intent, restored.intent);
    hideRecovery = false;
    Object.assign([...stored.values()][1], { state: "submission_unknown", errorCode: "SUBMISSION_UNKNOWN" });
    const recovered = await Promise.all([coordinator.status(operation(unknown)), coordinator.status(operation(unknown))]);
    for (const result of recovered) {
      assert.equal(result.phase, "submitted"); assert.equal(result.task.state, "submission_unknown");
      assert.equal(result.task.feeState, "reserved"); assert.equal(result.audioReady, false);
    }
    logs.push(host.stderr); await host.stop(); await host.start();
    const bound = await host.call("courseware.tts.get", scope(unknown));
    assert.equal(bound.intent.taskRef.taskId, "task-2");
    assert.equal(bound.intent.taskRef.requestHash, before.intent.requestHash);
    await coordinator.submit(operation(unknown)); await coordinator.status(operation(first)); assert.equal(submissions, 2);
    assert.equal(standInReservations, 2);
    if (audioIngestion) {
      const requests = http.length;
      assert.equal((await coordinator.archive(operation(first))).durationMs, archiveDuration);
      assert.equal(http.length, requests, "Restart recovery must use verified Host archive without HTTP");
      checks.push("Full Host restart recovers decoded audio without HTTP, POST or another reservation");
      const revisionBeforeAdopt = view.project.teachingRevision;
      const hostCall = host.call.bind(host);
      let loseAdoptionReply = true;
      host.call = async (method, params) => {
        const result = await hostCall(method, params);
        if (method === "courseware.tts.audio.adopt" && loseAdoptionReply) {
          loseAdoptionReply = false;
          throw new Error("simulated lost adoption acknowledgement");
        }
        return result;
      };
      await assert.rejects(coordinator.adopt(operation(first)), /lost adoption acknowledgement/);
      host.call = hostCall;
      view = await teaching.open(sessionId); project = view.project;
      const adoptedRevision = view.project.teachingRevision;
      coordinator = new CoursewareTtsCoordinator(teaching, auth, decodeCoursewareAudio);
      view = await coordinator.adopt(operation(first)); project = view.project;
      assert.equal(view.project.pages[0].actions[0].audioAssetId, `tts-${digest(archivedAudioBytes)}`);
      assert.notEqual(adoptedRevision, revisionBeforeAdopt);
      assert.equal(view.project.teachingRevision, adoptedRevision);
      const replayed = await coordinator.adopt(operation(first));
      assert.equal(replayed.project.teachingRevision, adoptedRevision);
      assert.equal(replayed.project.pages[0].actions[0].audioAssetId, `tts-${digest(archivedAudioBytes)}`);
      assert.equal((await coordinator.archive(operation(first))).audioReady, false);
      assert.equal(submissions, 2); assert.equal(standInReservations, 2);
      checks.push("Explicit Host CAS adoption and lost-reply replay attach once without regenerating audio");
      for (let current = project.pages.find((page) => page.reviewState !== "ready"); current;
        current = project.pages.find((page) => page.reviewState !== "ready")) {
        if (current.locked) project = (await host.call("courseware.teaching.setLock", { sessionId,
          projectId: project.projectId, pageId: current.pageId, expectedSourceRevision: project.source.revision,
          expectedTeachingRevision: project.teachingRevision, locked: false })).project;
        project = (await host.call("courseware.teaching.confirm", { sessionId, projectId: project.projectId,
          pageId: current.pageId, expectedSourceRevision: project.source.revision,
          expectedTeachingRevision: project.teachingRevision })).project;
      }
      view = await teaching.open(sessionId); project = view.project;
      coordinator = new CoursewareTtsCoordinator(teaching, auth, decodeCoursewareAudio);
      host.call = async (method, params) => {
        if (method === "courseware.snapshot.capture") {
          const original = params.assets[0];
          for (const asset of [
            { ...original, path: archive },
            { asset: original.asset },
            { ...original, tts: { ...original.tts, principalKey: "b".repeat(64) } },
            { ...original, tts: { ...original.tts, intentId: "missing-intent" } },
            { ...original, asset: { ...original.asset, mimeType: archivedAudioMime === "audio/mpeg" ? "audio/wav" : "audio/mpeg" } },
            { ...original, asset: { ...original.asset, sha256: "0".repeat(64) } },
          ]) await assert.rejects(hostCall(method, { ...params, assets: [asset] }));
        }
        return hostCall(method, params);
      };
      const frozen = await coordinator.captureSnapshot(baseline());
      host.call = hostCall;
      const frozenExport = await host.call("courseware.snapshot.get", { sessionId, projectId: project.projectId, snapshotId: frozen.snapshotId });
      assert.deepEqual(frozen.assetIds, [`tts-${digest(archivedAudioBytes)}`]);
      assert.deepEqual(frozenExport.project, project);
      assert.deepEqual(await fs.readFile(frozenExport.assets[0].path), archivedAudioBytes);
      report.fixedSnapshot = { sessionId, projectId: project.projectId, snapshotId: frozen.snapshotId };
      report.workspace = workspace;
      report.audioHash = digest(archivedAudioBytes);
      await fs.writeFile(path.join(output, "fixed-export.json"), JSON.stringify(frozenExport, null, 2));
      checks.push("Confirmed teaching snapshot freezes the adopted audio bytes and exact asset hash");
      checks.push("Host rejects mixed or missing asset sources, foreign receipts and mismatched audio metadata");
      if (rebindSource) {
        const beforeIntent = (await host.call("courseware.tts.get", scope(first))).intent;
        const lateIntent = (await host.call("courseware.tts.get", scope(unknown))).intent;
        const lateTask = stored.get(lateIntent.idempotencyKey);
        Object.assign(lateTask, { state: "ready", feeState: "settled", receiptId: `courseware-media:${lateTask.taskId}`, actualPoints: 5,
          errorCode: null, assetRef: { assetId: "late-fixture-audio", downloadPath: `/courseware/media/tasks/${lateTask.taskId}/asset`,
            sha256: digest(archivedAudioBytes), mime: archivedAudioMime, byteLength: archivedAudioBytes.length } });
        const unchanged = structuredClone(project);
        duringAsset = () => { dirty = true; context.editGeneration++; };
        await assert.rejects(coordinator.archive(operation(unknown)), /Save or reopen|changed/);
        duringAsset = undefined;
        await assert.rejects(host.call("courseware.tts.audio.get", scope(unknown)), /not found/);
        assert.deepEqual((await host.call("courseware.project.get", { sessionId, projectId: project.projectId })).project, unchanged);
        dirty = false;
        checks.push("A native edit during late audio download rejects attachment and leaves teaching unchanged");
        const beforeHttp = http.length;
        let original = project;
        assert.equal(original.pages.length, 3);
        await fs.copyFile(rebindSource, saved);
        snapshot.sha256 = digest(await fs.readFile(saved));
        assert.notEqual(snapshot.sha256, original.source.sha256);
        snapshot.revision++; context.revision++; context.editGeneration++;
        context.sha256 = snapshot.sha256; context.page = 2;
        let review = await teaching.prepareReview(sessionId);
        assert.equal(review.pageCount, 4);
        const pendingChange = (await host.call("courseware.project.context", { sessionId, projectId: project.projectId })).sourceChange;
        dirty = true; context.editGeneration++;
        await assert.rejects(teaching.adoptReview({ reviewId: review.reviewId, bindings: [2, 0, 1, null] }), /Save or reopen/);
        dirty = false;
        const reviewedSnapshot = { ...snapshot };
        await fs.copyFile(source, saved);
        snapshot.sha256 = original.source.sha256; snapshot.revision++;
        context.sha256 = snapshot.sha256; context.revision++; context.editGeneration++;
        await assert.rejects(teaching.adoptReview({ reviewId: review.reviewId, bindings: [2, 0, 1, null] }), /changed/);
        assert.deepEqual((await host.call("courseware.project.get", { sessionId, projectId: project.projectId })).project, original);
        assert.deepEqual((await host.call("courseware.project.context", { sessionId, projectId: project.projectId })).sourceChange, pendingChange);
        await fs.copyFile(rebindSource, saved);
        snapshot.sha256 = reviewedSnapshot.sha256; snapshot.revision++;
        context.sha256 = snapshot.sha256; context.revision++; context.editGeneration++;
        review = await teaching.prepareReview(sessionId);
        checks.push("Dirty editing and a newer saved PPTX both reject old source review without changing its project or receipt");
        const laterActions = structuredClone(original.pages[0].actions);
        laterActions[0].pauseAfterMs = 975;
        original = (await host.call("courseware.teaching.write", { sessionId, write: {
          projectId: original.projectId, pageId: original.pages[0].pageId,
          expectedSourceRevision: original.source.revision, expectedTeachingRevision: original.teachingRevision,
          actions: laterActions,
        } })).project;
        await assert.rejects(teaching.adoptReview({ reviewId: review.reviewId, bindings: [2, 0, 1, null] }), /changed|stale|CONFLICT/);
        assert.deepEqual((await host.call("courseware.project.get", { sessionId, projectId: project.projectId })).project, original);
        assert.equal((await host.call("courseware.project.context", { sessionId, projectId: project.projectId })).sourceChange.stale, true);
        review = await teaching.prepareReview(sessionId);
        checks.push("A teaching edit during source review rejects its stale baseline; fresh explicit review retains the later pause");
        view = await teaching.adoptReview({ reviewId: review.reviewId, bindings: [2, 0, 1, null] });
        project = view.project;
        assert.deepEqual(project.pages.slice(0, 3).map((page) => page.pageId),
          [original.pages[2].pageId, original.pages[0].pageId, original.pages[1].pageId]);
        assert.deepEqual(project.pages[1].actions, original.pages[0].actions);
        assert.equal(project.pages[1].actions[0].pauseAfterMs, 975);
        assert.deepEqual(project.pages[3].actions, []);
        assert(!original.pages.some((page) => page.pageId === project.pages[3].pageId));
        const receipt = await host.call("courseware.tts.audio.get", scope(first));
        assert.deepEqual(receipt.boundSource, project.source);
        assert.deepEqual((await host.call("courseware.tts.get", scope(first))).intent, beforeIntent);
        for (const page of [...project.pages]) project = (await host.call("courseware.teaching.confirm", {
          sessionId, projectId: project.projectId, pageId: page.pageId,
          expectedSourceRevision: project.source.revision, expectedTeachingRevision: project.teachingRevision,
        })).project;
        logs.push(host.stderr); await host.stop(); await host.start();
        view = await teaching.open(sessionId); project = view.project;
        coordinator = new CoursewareTtsCoordinator(teaching, auth, decodeCoursewareAudio);
        const nextSnapshot = await coordinator.captureSnapshot(baseline());
        const reboundExport = await host.call("courseware.snapshot.get", {
          sessionId, projectId: project.projectId, snapshotId: nextSnapshot.snapshotId,
        });
        assert.deepEqual(reboundExport.assets.map((asset) => asset.sha256), [report.audioHash]);
        assert.deepEqual(await fs.readFile(reboundExport.assets[0].path), archivedAudioBytes);
        assert.equal(reboundExport.project.pages[1].actions[0].audioAssetId, `tts-${report.audioHash}`);
        assert.deepEqual(await host.call("courseware.snapshot.get", report.fixedSnapshot), frozenExport);
        assert.deepEqual((await host.call("courseware.tts.get", scope(first))).intent, beforeIntent);
        assert.equal(http.length, beforeHttp, "Source review and snapshot capture must not contact the media service");
        const sourceNetworkRequests = http.length - beforeHttp;
        assert.equal(submissions, 2); assert.equal(standInReservations, 2);
        const beforeLate = structuredClone(project);
        assert.equal((await coordinator.status(operation(unknown))).current, false);
        assert.equal((await coordinator.archive(operation(unknown))).archived, true);
        const retainedLate = await host.call("courseware.tts.audio.get", scope(unknown));
        assert.equal(retainedLate.adoptedTeachingRevision, null);
        assert.equal(retainedLate.boundSource, null);
        assert.deepEqual(await fs.readFile(retainedLate.path), archivedAudioBytes);
        await assert.rejects(coordinator.adopt(operation(unknown)), /TTS source or speech changed/);
        assert.deepEqual((await host.call("courseware.project.get", { sessionId, projectId: project.projectId })).project, beforeLate);
        assert.deepEqual((await host.call("courseware.tts.get", scope(unknown))).intent, lateIntent);
        logs.push(host.stderr); await host.stop(); await host.start();
        view = await teaching.open(sessionId); project = view.project;
        assert.deepEqual(project, beforeLate);
        assert.deepEqual(await host.call("courseware.tts.audio.get", scope(unknown)), retainedLate);
        assert.deepEqual(await host.call("courseware.snapshot.get", report.fixedSnapshot), frozenExport);
        assert.equal(submissions, 2); assert.equal(standInReservations, 2);
        checks.push("Late audio remains privately recoverable after source association but cannot replace current audio, even after restart");
        report.reboundSnapshot = { sessionId, projectId: project.projectId, snapshotId: nextSnapshot.snapshotId };
        report.lateAudio = { intentId: unknown.intentId, receipt: retainedLate, projectUnchanged: true, submissions, standInReservations };
        report.audioRebinding = { source: rebindSource, bindings: [2, 0, 1, null], networkRequests: sourceNetworkRequests,
          originalSourceHash: original.source.sha256, reboundSourceHash: project.source.sha256 };
        await fs.writeFile(path.join(output, "rebound-export.json"), JSON.stringify(reboundExport, null, 2));
        checks.push("Explicit saved-PPTX reassociation preserves audio on its logical page and leaves the copy empty");
        checks.push("Host restart and new Main snapshot reuse identical adopted audio without HTTP or another reservation");
        checks.push("The paid intent and previous fixed snapshot remain unchanged after source rebinding");
        report.status = "PASS_MAIN_HOST_SAVED_SOURCE_AUDIO_REBINDING";
        return;
      }
    }
  });
  if (rebindSource) {
    assert.equal(report.status, "PASS_MAIN_HOST_SAVED_SOURCE_AUDIO_REBINDING");
    return;
  }
  if (officeIdentity) {
    report.status = "PASS_MAIN_DECODED_AUDIO_ADOPTION_ONLY";
    return;
  }
  await step("Editing during submission retains a stale task reference and cannot attach audio", async () => {
    late = await prepare();
    duringSubmit = async () => {
      project = (await host.call("courseware.teaching.write", { sessionId, write: { projectId: project.projectId, pageId: project.pages[0].pageId,
        expectedSourceRevision: project.source.revision, expectedTeachingRevision: project.teachingRevision,
        actions: [{ id: "speech-1", type: "speech", text: "Edited after dispatch" }] } })).project;
      context.editGeneration++;
    };
    await assert.rejects(coordinator.submit(operation(late)), /changed/); duringSubmit = undefined;
    const retained = await host.call("courseware.tts.get", scope(late));
    assert.equal(retained.intent.phase, "submitted"); assert.equal(retained.current, false); assert.equal(retained.audioReady, false);
    assert.equal(retained.intent.taskRef.taskId, "task-3"); assert.equal(submissions, 3);
    view = await teaching.open(sessionId);
    assert.equal((await coordinator.status(operation(late))).current, false);
    assert.equal(view.project.pages[0].actions[0].audioAssetId, undefined);
    assert.equal(digest(await fs.readFile(archive)), report.sourceHash);
  });
  await step("Logout invalidates captured identity; a different account cannot read the old journal", async () => {
    const principal = auth.getCoursewarePrincipal(); await auth.logout();
    assert.throws(() => principal.assertCurrent(), /AUTH_CHANGED/);
    await assert.rejects(coordinator.list(baseline()), /AUTH_REQUIRED/);
    userId = 9; await auth.startQrLogin(); await auth.pollQrLogin("ticket-1");
    assert.notEqual(auth.getCoursewarePrincipal().key, principal.key);
    assert.deepEqual(await coordinator.list(baseline()), []);
    await assert.rejects(coordinator.status(operation(first)), /not found/);
    assert.equal(submissions, 3);
    assert.equal(http.filter((request) => request.url.endsWith("/asset")).length, audioIngestion ? 2 : 0);
  });
  report.status = audioIngestion ? "PASS_MAIN_DECODED_AUDIO_ADOPTION_ONLY" : "PASS_MAIN_HOST_AUTH_TTS_ONLY";
  } catch (error) { report.status = "FAIL"; report.error = error.stack; console.error(error); throw error; }
});
