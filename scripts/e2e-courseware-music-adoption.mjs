#!/usr/bin/env node
/** Actual source or packaged Electron/Office/Host adoption; external services are loopback fixtures. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { copyFile, mkdir, mkdtemp, readFile, readdir, readlink, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { coursewareLaunch, resolveElectronBinary } from "./e2e/boot.mjs";
import { testAdoptedPlayback } from "./e2e/tts-playback.mjs";

const runFile = promisify(execFile);
const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index], value = process.argv[index + 1];
  assert(["--app", "--host", "--evidence-dir"].includes(key) && value && !Object.hasOwn(options, key),
    "Usage: --app <source-app-directory> --host <host-binary> --evidence-dir <new-directory>"); options[key] = value;
}
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packaged = Boolean(process.env.DECKWISE_E2E_PACKAGE_ROOT);
assert(!packaged || !options["--app"] && !options["--host"], "Packaged validation must not override --app or --host");
const appDir = resolve(options["--app"] ?? join(repository, "apps/desktop"));
const launch = packaged ? coursewareLaunch(repository) : {
  executablePath: process.env.ELECTRON_EXECUTABLE ?? resolveElectronBinary(repository).electronBinary,
  cwd: appDir, args: [appDir], packaged: false,
};
const resources = packaged ? join(launch.cwd, "resources") : null;
const hostPath = packaged ? join(resources, "bin/pi-desktop-host-core") : options["--host"] ?? process.env.PI_DESKTOP_HOST_BIN;
assert(hostPath, "Provide --host or PI_DESKTOP_HOST_BIN for source validation");
const sidecarPath = packaged ? join(resources, "agent-runtime/sidecar.js") : null;
assert(process.env.DECKWISE_E2E_PPTX && process.env.DECKWISE_EDITOR_URL, "Set DECKWISE_E2E_PPTX and local DECKWISE_EDITOR_URL");
assert(["127.0.0.1", "localhost"].includes(new URL(process.env.DECKWISE_EDITOR_URL).hostname));
const directory = await mkdtemp(join(tmpdir(), "deckwise-music-adoption-"));
const out = resolve(options["--evidence-dir"] ?? join(directory, "evidence"));
await mkdir(dirname(out), { recursive: true }); await mkdir(out);
const workspace = join(directory, "workspace"); await mkdir(workspace);
const file = join(workspace, "lesson.pptx"); await copyFile(process.env.DECKWISE_E2E_PPTX, file);
const { _electron, expect } = createRequire(new URL("../packages/courseware-runtime/package.json", import.meta.url))("@playwright/test");
const bytes = await readFile(join(repository, "apps/desktop/test/fixtures/courseware-tts-tone.mp3"));
const speechBytes = await readFile(join(repository, "packages/courseware-runtime/tests/fixtures/fixed-courseware/page-1.wav"));
const digest = value => createHash("sha256").update(value).digest("hex");
const runtimeArtifacts = packaged ? [launch.executablePath, join(resources, "app.asar"), hostPath, sidecarPath,
  join(resources, "pptx-worker/pptx-worker.mjs"), join(resources, "pptx-worker/authoring.mjs"), join(resources, "pptx-worker/manifest.json")]
  : [...(process.env.DECKWISE_PPTX_WORKER ? [resolve(process.env.DECKWISE_PPTX_WORKER)] : []), join(appDir, "out/main/index.js"), join(appDir, "out/preload/index.cjs"),
    join(appDir, "out/renderer/index.html"), resolve(hostPath),
    ...(await readdir(join(appDir, "out/renderer/assets"))).filter(name => /^index-.*\.js$/u.test(name)).map(name => join(appDir, "out/renderer/assets", name))];
const artifacts = await Promise.all([resolve(process.env.DECKWISE_E2E_PPTX), ...runtimeArtifacts]
  .map(async path => { const value = await readFile(path); return { path, bytes: value.length, sha256: digest(value) }; }));
const report = { status: "RUNNING", checks: [], directory, artifacts, paidCalls: false, identityFixture: true,
  platformFixture: true, supplierFixture: true, realSpringPlatform: false, modelCalls: false, packaged, sandbox: "--no-sandbox",
  editorUrl: process.env.DECKWISE_EDITOR_URL, musicFixture: { byteLength: bytes.length, sha256: digest(bytes) }, runtimeStarts: [] };
const http = [], logs = [], tasks = new Map(), posted = [];
const token = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
const candidateIds = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
const lyrics = "One, two, three!\nCount together with me.";
let app, page, sdk, sessionId, providerId, draftId, original, exported, saved, adoptedProject;
let generationPosts = 0, exportPosts = 0, ttsPosts = 0, previewReads = 0, assetReads = 0, refuseMedia = false;
const requestHash = request => {
  const fields = [request.kind, request.model, request.input, request.voice ?? null];
  if (request.kind === "music") fields.push("courseware-music-options-v1", request.music.title, request.music.tags ?? null,
    request.music.negativeTags ?? null, request.music.instrumental == null ? null : String(request.music.instrumental));
  return digest("courseware-media-v1" + fields.map(value => `:${value === null ? -1 : value.length}:${value ?? ""}`).join(""));
};
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1"); http.push({ method: request.method, path: url.pathname });
    const send = (data, code = 200) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ code, data })); };
    if (url.pathname === "/auth/desktop/wx/qrcode") return send({ ticket: "canvas-music-ticket", entryUrl: "https://fixture.test/qr" });
    if (["/auth/wx/poll/canvas-music-ticket", "/auth/desktop/refresh", "/auth/refresh"].includes(url.pathname))
      return send({ status: "SUCCESS", accessToken: token, refreshToken: "canvas-music-fixture-refresh" });
    if (url.pathname === "/auth/me") return send({ edition: "EDUCATION", pcAllowed: true, role: "ADMIN", tenantId: 8, userId: 7 });
    if (url.pathname === "/auth/logout") return send({});
    if (url.pathname === "/v1/models") { response.setHeader("content-type", "application/json"); return response.end(JSON.stringify({ data: [{ id: "fixture-model" }] })); }
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    if (url.pathname === "/courseware/team/projects") return send([]);
    assert(!refuseMedia, "After restart, archived music must not access Platform media routes");
    if (url.pathname === "/courseware/media/models") {
      assert.equal(request.method, "GET"); const kind = url.searchParams.get("kind");
      if (kind === "tts") return send([{ model: "fixture-speech", voices: ["classroom"], providerDefaultVoice: false }]);
      assert(["music", "music-export"].includes(kind));
      return send([{ model: kind === "music" ? "canvas-music" : "canvas-mp3", voices: [], providerDefaultVoice: false }]);
    }
    if (url.pathname === "/courseware/media/models/fixture-speech/quote") {
      const expiry = Math.floor(Date.now() / 1000) + 300;
      return send({ version: "courseware-media-quote-v1", kind: "tts", model: "fixture-speech", priceVersion: "fixture-v1",
        maxPoints: 1, maxChars: 2500, expiresAt: new Date(expiry * 1000).toISOString(), quoteToken: `${expiry}.${"a".repeat(43)}` });
    }
    if (/^\/courseware\/media\/models\/(canvas-music|canvas-mp3)\/quote$/u.test(url.pathname)) {
      assert.equal(request.method, "GET"); const kind = url.searchParams.get("kind"), generation = kind === "music";
      assert(["music", "music-export"].includes(kind)); assert(url.pathname.includes(generation ? "canvas-music" : "canvas-mp3"));
      const expiry = Math.floor(Date.now() / 1000) + 300;
      return send({ version: "courseware-media-quote-v1", kind, model: generation ? "canvas-music" : "canvas-mp3", priceVersion: generation ? "music-v1" : "mp3-v1",
        maxPoints: generation ? 5 : 2, maxChars: 4000, expiresAt: new Date(expiry * 1000).toISOString(), quoteToken: `${expiry}.${"a".repeat(43)}` });
    }
    if (url.pathname === "/courseware/media/tasks/confirmed" && request.method === "POST") {
      let raw = ""; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw), key = request.headers["idempotency-key"], generation = body.request.kind === "music";
      assert.match(key, /^[a-f0-9-]{36}$/u); assert(!tasks.has(key), "No original task may dispatch again");
      if (body.request.kind === "tts") {
        assert.equal(body.request.model, "fixture-speech"); assert.equal(body.request.voice, "classroom");
        assert.equal(body.confirmation.maxPoints, 1); assert.equal(body.confirmation.priceVersion, "fixture-v1");
        assert(ttsPosts < 3, "Only three prerequisite narration fixture tasks");
        const taskId = `music-speech-${++ttsPosts}`;
        const task = { version: "courseware-media-v1", kind: "tts", taskId, idempotencyKey: key, requestHash: requestHash(body.request), model: "fixture-speech",
          state: "ready", feeState: "settled", reservedPoints: 1, actualPoints: 1, errorCode: null, receiptId: `courseware-media:${taskId}`,
          assetRef: { assetId: `asset-${taskId}`, sha256: digest(speechBytes), mime: "audio/wav", byteLength: speechBytes.length,
            durationMs: 5955, downloadPath: `/courseware/media/tasks/${taskId}/asset` } };
        tasks.set(key, task); return send(task);
      }
      assert.deepEqual(body.request, generation ? { kind: "music", model: "canvas-music", input: lyrics,
        music: { title: "Counting song", tags: "playful piano", negativeTags: "heavy metal", instrumental: false } }
        : { kind: "music-export", model: "canvas-mp3", input: candidateIds[1] });
      assert.equal(body.confirmation.maxPoints, generation ? 5 : 2);
      assert.equal(body.confirmation.priceVersion, generation ? "music-v1" : "mp3-v1");
      if (generation) { generationPosts++; assert.equal(generationPosts, 1); } else { exportPosts++; assert.equal(exportPosts, 1); }
      const task = { version: "courseware-media-v1", kind: body.request.kind, taskId: generation ? "canvas-music-task" : "canvas-export-task",
        idempotencyKey: key, requestHash: requestHash(body.request), model: body.request.model, state: "queued", feeState: "reserved",
        reservedPoints: generation ? 5 : 2, actualPoints: null, receiptId: null, errorCode: null, assetRef: null };
      tasks.set(key, task); posted.push({ key, request: body.request, requestHash: task.requestHash }); return send(task);
    }
    if (url.pathname === "/courseware/media/tasks/by-idempotency") {
      const task = tasks.get(url.searchParams.get("key")); if (!task) return send(null, 46006);
      assert.equal(request.method, "GET"); assert.equal(url.searchParams.get("requestHash"), task.requestHash); return send(task);
    }
    const speech = /^\/courseware\/media\/tasks\/(music-speech-[1-3])(\/asset)?$/u.exec(url.pathname);
    if (speech) {
      assert.equal(request.method, "GET"); const task = [...tasks.values()].find(value => value.taskId === speech[1]); assert(task);
      if (!speech[2]) return send(task);
      response.setHeader("content-type", "audio/wav"); return response.end(speechBytes);
    }
    const match = /^\/courseware\/media\/tasks\/(canvas-music-task|canvas-export-task)(.*)$/u.exec(url.pathname);
    if (match) {
      assert.equal(request.method, "GET"); const task = [...tasks.values()].find(value => value.taskId === match[1]); assert(task);
      if (!match[2]) return send(task);
      if (match[2] === "/music-candidates") {
        assert.equal(task.kind, "music"); return send(candidateIds.map((candidateId, order) => ({ candidateId, order, state: "completed", durationMs: 120, exportable: task.state === "ready" })));
      }
      const preview = /^\/music-candidates\/([^/]+)\/preview$/u.exec(match[2]);
      if (preview) { assert.equal(task.kind, "music"); assert(candidateIds.includes(preview[1])); assert.equal(task.state, "ready"); previewReads++; }
      else { assert.equal(match[2], "/asset"); assert.equal(task.kind, "music-export"); assert.equal(task.state, "ready"); assetReads++; }
      response.setHeader("content-type", "audio/mpeg"); return response.end(bytes);
    }
    throw new Error(`Unexpected fixture route ${request.method} ${url.pathname}`);
  } catch (failure) { logs.push(`FIXTUREERROR ${failure.stack}`); response.statusCode = 500; response.end("Fixture failed"); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const invoke = (name, ...args) => page.evaluate(async ({ name, args }) => {
  const result = await window.piDesktop.invoke(window.piDesktop.channels.invoke[name], ...args);
  if (!result.ok) throw new Error(JSON.stringify(result.error)); return result.data;
}, { name, args });
const canvas = () => page.locator(".courseware-media-canvas");
const properties = () => canvas().locator(".courseware-media-canvas-properties");
const music = () => page.getByRole("region", { name: "Generate canvas music", exact: true });
const row = () => music().locator(`[data-canvas-music-intent="${original.intentId}"]`);
const candidate = index => row().locator(`[data-music-candidate="${candidateIds[index]}"]`);
const exportRow = () => row().locator(`[data-music-export-intent="${exported.intentId}"]`);
const read = () => invoke("coursewareCanvasMusicList", { sessionId });
async function openCanvas() {
  await page.evaluate(() => { window.__PI_CAPTURE__ = true; window.__PI_DESKTOP__.openNewWorkPanelTab(); });
  await page.locator('[data-work-panel-launcher-item="media-canvas"]').click();
  await expect(canvas()).toBeVisible(); await expect(music()).toBeVisible();
}
async function start() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/api.?key|secret|token|password|proxy/iu.test(key)));
  app = await _electron.launch({ executablePath: launch.executablePath,
    cwd: launch.cwd, args: ["--no-sandbox", `--user-data-dir=${join(directory, "profile")}`, ...launch.args],
    env: { ...env, ELECTRON_RUN_AS_NODE: "", ELECTRON_RENDERER_URL: "", PI_DESKTOP_DATA_DIR: join(directory, "data"),
      ...(!packaged ? { PI_DESKTOP_HOST_BIN: resolve(hostPath) } : {}), DECKWISE_PLATFORM_BASE_URL: `http://127.0.0.1:${server.address().port}`, PI_DESKTOP_START_MAXIMIZED: "0" }, timeout: 60_000 });
  for (const stream of [app.process().stdout, app.process().stderr]) stream.on("data", value => logs.push(String(value)));
  page = await app.firstWindow({ timeout: 60_000 }); page.on("pageerror", failure => logs.push(`PAGEERROR ${failure.stack}`));
  const runtime = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, appPath: app.getAppPath(), executablePath: process.execPath, resourcesPath: process.resourcesPath, pid: process.pid }));
  assert.equal(runtime.packaged, packaged);
  if (packaged) {
    assert.equal(runtime.appPath, join(resources, "app.asar"));
    assert.equal(runtime.resourcesPath, resources); assert.equal(runtime.executablePath, launch.executablePath);
  }
  report.runtimeStarts.push(runtime);
  await page.waitForFunction(() => !!window.piDesktop);
  await app.evaluate(({ session, BrowserWindow }) => {
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url); callback({ cancel: /^https?:$/u.test(url.protocol) && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) });
    }); BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1600, height: 1100 });
  });
  await page.waitForFunction(() => !!window.__PI_DESKTOP__ && !document.querySelector(".auth-shell"), null, { timeout: 60_000 });
  assert.equal((await invoke("authRestore")).status, "authenticated");
  const processTable = (await runFile("ps", ["-eo", "pid=,ppid=,comm="])).stdout;
  const children = processTable.split("\n").map(line => /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/u.exec(line))
    .filter(match => match && Number(match[2]) === runtime.pid && match[3].startsWith("pi-desktop-host"));
  assert.equal(children.length, 1, "Exactly one Rust Host is a child of this owned Electron");
  runtime.hostPid = Number(children[0][1]);
  runtime.hostExecutable = await readlink(`/proc/${runtime.hostPid}/exe`);
  assert.equal(runtime.hostExecutable, await realpath(hostPath), "Owned child is the matching Rust Host executable");
  if (packaged) {
    const descendants = processTable.split("\n").map(line => /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/u.exec(line))
      .filter(match => match && Number(match[2]) === runtime.pid);
    const agents = [];
    for (const child of descendants) {
      const pid = Number(child[1]);
      const args = (await readFile(`/proc/${pid}/cmdline`)).toString().split("\0").filter(Boolean);
      if (args.includes(sidecarPath)) agents.push({ pid, args, executable: await readlink(`/proc/${pid}/exe`) });
    }
    assert.equal(agents.length, 1, "Exactly one owned Agent uses the bundled sidecar");
    assert.equal(agents[0].executable, await realpath(launch.executablePath));
    runtime.agent = agents[0];
  }
  const { defaultCommandShell: _shell, ...settings } = await invoke("settingsGet");
  await invoke("settingsSet", { ...settings, language: "en", defaultPermissionMode: "auto" }); await invoke("projectSet", workspace);
  if (!sessionId) {
    providerId = (await invoke("providersCreate", { name: "Unused fixture LLM", vendorKey: "custom", type: "openai_compatible", protocol: "openai_compatible",
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, authKind: "none", apiStyle: "chat_completions",
      models: [{ id: "fixture-model", contextWindow: 128000, maxTokens: 8192, thinkingLevels: [], defaultThinkingLevel: null, supportsImages: true }] })).provider.id;
    sessionId = (await invoke("sessionCreate", { title: "Canvas music candidates", projectPath: workspace, providerId, modelId: "fixture-model", mode: "agent" })).session.id;
  }
  await page.evaluate(async id => { window.__PI_CAPTURE__ = true; await window.__PI_DESKTOP__.refreshProviders(); await window.__PI_DESKTOP__.selectSession(id); }, sessionId);
}
async function stop() {
  if (!app) return; const child = app.process();
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once("exit", resolve)); await app.evaluate(({ app }) => app.exit(0)); await exited;
  } app = null;
}
const step = async (name, action) => { console.log("START", name); await action(); report.checks.push(name); console.log("PASS", name); };
async function verifyAudio(locator) {
  await expect(locator).toBeVisible();
  await locator.evaluate(async audio => { await audio.play(); audio.pause(); });
  await expect.poll(() => locator.evaluate(audio => audio.error === null && Number.isFinite(audio.duration) && audio.duration > 0 && audio.readyState >= 2)).toBe(true);
}
function ready(kind) {
  const task = [...tasks.values()].find(value => value.kind === kind); assert(task);
  Object.assign(task, { state: "ready", feeState: "settled", actualPoints: task.reservedPoints, receiptId: `courseware-media:${task.taskId}`,
    assetRef: kind === "music" ? null : { assetId: "music-export-mp3", sha256: digest(bytes), mime: "audio/mpeg", byteLength: bytes.length,
      downloadPath: `/courseware/media/tasks/${task.taskId}/asset` } });
}
const teaching = () => page.locator(".courseware-teaching");
const load = () => teaching().getByRole("button", { name: "Load current page", exact: true });
async function openOffice() {
  await page.evaluate(async () => { window.__PI_CAPTURE__ = true; await window.__PI_DESKTOP__.openWorkPanelArtifact("file", "lesson.pptx"); });
  sdk = undefined;
  await expect.poll(async () => {
    const host = app.context().pages().find(target => target.url().startsWith("deckwise-editor:"));
    if (!host) return false;
    for (const frame of host.frames()) if (await frame.evaluate(() => Boolean(window.Asc?.editor?.isLoadFullApi && window.Asc.editor.isDocumentLoadComplete)).catch(() => false)) { sdk = frame; return true; }
    return false;
  }, { timeout: 120_000 }).toBe(true);
  await expect(load()).toBeEnabled();
}
async function goToPage(index) {
  await sdk.evaluate(index => window.Asc.editor.goToPage(index), index);
  await expect.poll(async () => (await invoke("pptEditorGetContext")).page, { timeout: 15_000 }).toBe(index + 1);
}
async function loadTeaching() {
  await load().click(); await expect(load()).toBeEnabled({ timeout: 120_000 });
  await expect(teaching().getByRole("alert")).toHaveCount(0);
}
try {
  await step(`Real ${packaged ? "packaged" : "source"} Electron opens a saved no-timing PPTX in matching WiseOffice`, async () => {
    await start(); await invoke("coursewareTaskSet", { sessionId, taskType: "plain", educationContext: {} });
    await openOffice(); await goToPage(0); await loadTeaching();
    await teaching().locator("label textarea").last().fill("Narration remains independent of the music clip.");
    await teaching().getByRole("button", { name: "Save narration", exact: true }).click();
    await expect(load()).toBeEnabled();
    report.originalTeaching = (await invoke("pptEditorTeachingOpen", { sessionId })).project;
    await openCanvas(); await canvas().getByRole("button", { name: "Add music", exact: true }).click();
    await properties().getByRole("textbox", { name: "Name", exact: true }).fill("Counting song");
    await properties().getByRole("textbox", { name: "Lyrics", exact: true }).fill(lyrics);
    await expect.poll(async () => (await invoke("coursewareMediaCanvasGet", { sessionId })).document?.drafts[0]?.prompt).toBe(lyrics);
    draftId = (await invoke("coursewareMediaCanvasGet", { sessionId })).document.drafts[0].id;
  });
  await step("Visible music generation and separate export require two explicit fee confirmations", async () => {
    await music().getByRole("button", { name: "Load music models", exact: true }).click();
    await music().getByRole("combobox", { name: "Saved music draft", exact: true }).selectOption(draftId);
    await music().getByRole("combobox", { name: "Music generation model", exact: true }).selectOption("canvas-music");
    await music().getByRole("combobox", { name: "MP3 export model", exact: true }).selectOption("canvas-mp3");
    await music().getByRole("textbox", { name: "Style / tags", exact: true }).fill("playful piano");
    await music().getByRole("textbox", { name: "Styles to avoid", exact: true }).fill("heavy metal");
    await music().getByRole("button", { name: "Prepare music and get quote", exact: true }).click();
    await expect(music().getByRole("button", { name: "Confirm and generate music", exact: true })).toBeDisabled();
    assert.equal(generationPosts, 0); original = (await read()).find(value => value.operation === "music"); assert(original);
    await music().getByRole("checkbox", { name: "I approve this maximum cost and sending the exact saved lyrics, title and styles to the music provider.", exact: true }).check();
    await music().getByRole("button", { name: "Confirm and generate music", exact: true }).click();
    await expect(row()).toContainText("Task: queued"); ready("music");
    await row().getByRole("button", { name: "Check original task status", exact: true }).click();
    await expect(row().locator("[data-music-candidate]")).toHaveCount(2);
    await candidate(1).getByRole("button", { name: "Listen to original candidate", exact: true }).click();
    await verifyAudio(candidate(1).locator("audio"));
    await candidate(1).getByRole("button", { name: "Get separate MP3 export quote", exact: true }).click();
    await expect(music().getByRole("button", { name: "Confirm and export MP3", exact: true })).toBeDisabled();
    exported = (await read()).find(value => value.operation === "music-export"); assert(exported); assert.equal(exportPosts, 0);
    await music().getByRole("checkbox", { name: "I approve this separate maximum cost for exporting only the displayed candidate as MP3.", exact: true }).check();
    await music().getByRole("button", { name: "Confirm and export MP3", exact: true }).click();
    await expect(exportRow()).toContainText("queued"); ready("music-export");
    await exportRow().getByRole("button", { name: "Check original task status", exact: true }).click();
    await exportRow().getByRole("button", { name: "Download and archive exported MP3", exact: true }).click();
    await verifyAudio(exportRow().locator("audio")); assert.equal(assetReads, 1);
    await exportRow().screenshot({ path: join(out, "01-visible-archived-export.png") });
  });
  await step("Review freezes the saved teaching page and native page change refuses adoption", async () => {
    await exportRow().getByRole("button", { name: "Review current page for music", exact: true }).click();
    await expect(exportRow()).toContainText("Page 1");
    await expect(exportRow()).toContainText("does not replace narration or change the PPTX");
    await exportRow().screenshot({ path: join(out, "02-explicit-target-review.png") });
    const before = report.originalTeaching;
    await goToPage(1);
    await exportRow().getByRole("button", { name: "Append music after this page's teaching actions", exact: true }).click();
    await expect(music().getByRole("alert")).toHaveCount(1);
    const after = (await invoke("pptEditorTeachingOpen", { sessionId })).project;
    assert.deepEqual(after, before); report.nativePageRefusal = await music().getByRole("alert").innerText();
    assert.match(report.nativePageRefusal, /current page changed|Teaching view changed|reload teaching/i, "Refusal must be page/review binding, not an unrelated failure");
    assert.equal(after.pages.flatMap(entry => entry.actions).filter(action => action.type === "audio_clip").length, 0);
    assert.equal(generationPosts, 1); assert.equal(exportPosts, 1);
  });
  await step("Fresh review and explicit append preserve speech and add one independent teaching music clip", async () => {
    await goToPage(0);
    await exportRow().getByRole("button", { name: "Review current page for music", exact: true }).click();
    await expect(exportRow()).toContainText("Page 1");
    await exportRow().getByRole("button", { name: "Append music after this page's teaching actions", exact: true }).click();
    await expect(music().getByText(/Music appended to page 1/)).toBeVisible();
    await expect(music().getByRole("alert")).toHaveCount(0);
    adoptedProject = (await invoke("pptEditorTeachingOpen", { sessionId })).project;
    const actions = adoptedProject.pages[0].actions;
    assert.deepEqual(actions.slice(0, -1), report.originalTeaching.pages[0].actions);
    assert.equal(actions.at(-1).type, "audio_clip"); assert.equal(actions.at(-1).audioAssetId, `music-${digest(bytes)}`);
    assert.deepEqual(adoptedProject.source, report.originalTeaching.source);
    await writeFile(join(out, "adopted-teaching.json"), JSON.stringify(adoptedProject, null, 2));
    await music().screenshot({ path: join(out, "03-adoption-success.png") });
    await openOffice(); await loadTeaching();
    await expect(teaching().locator("[data-teaching-music-clip]")).toHaveCount(1);
    await teaching().locator("[data-teaching-music-clip]").scrollIntoViewIfNeeded();
    await expect(teaching().locator("label textarea").last()).toHaveValue("Narration remains independent of the music clip.");
    await teaching().screenshot({ path: join(out, "04-independent-clip-and-speech.png") });
  });
  await step("Teaching edits preserve independent clip; visible reorder saves durably", async () => {
    const clip = teaching().locator("[data-teaching-music-clip]");
    await clip.getByRole("button", { name: "Move music earlier", exact: true }).click();
    await teaching().getByRole("button", { name: "Save narration", exact: true }).click(); await expect(load()).toBeEnabled();
    let value = (await invoke("pptEditorTeachingOpen", { sessionId })).project;
    assert.equal(value.pages[0].actions[0].type, "audio_clip");
    await clip.getByRole("button", { name: "Move music later", exact: true }).click();
    await teaching().getByRole("button", { name: "Save narration", exact: true }).click(); await expect(load()).toBeEnabled();
    adoptedProject = (await invoke("pptEditorTeachingOpen", { sessionId })).project;
    assert.deepEqual(adoptedProject.pages[0].actions, report.originalTeaching.pages[0].actions.concat(value.pages[0].actions[0]));
    for (let index = 0; index < adoptedProject.pages.length; index++) {
      await goToPage(index); await loadTeaching();
      // Prerequisite narration audio uses the already-tested Main/Host path with static loopback WAV, not a supplier.
      const current = await invoke("pptEditorTeachingOpen", { sessionId });
      for (const speech of current.project.pages[index].actions.filter(action => action.type === "speech")) {
        const latest = await invoke("pptEditorTeachingOpen", { sessionId });
        const scope = { viewId: latest.viewId, expectedTeachingRevision: latest.project.teachingRevision };
        const task = await invoke("pptEditorTtsPrepare", { ...scope, actionId: speech.id, model: "fixture-speech", voice: "classroom" });
        const operation = { ...scope, intentId: task.intentId };
        const quote = await invoke("pptEditorTtsQuote", operation); assert.equal(quote.maxPoints, 1);
        await invoke("pptEditorTtsSubmitConfirmed", { ...operation, quoteId: quote.quoteId });
        await invoke("pptEditorTtsArchive", operation); await invoke("pptEditorTtsAdopt", operation);
      }
      await loadTeaching();
      const confirm = teaching().getByRole("button", { name: "Confirm this page", exact: true });
      await expect(confirm).toBeEnabled(); await confirm.click(); await expect(load()).toBeEnabled();
    }
    adoptedProject = (await invoke("pptEditorTeachingOpen", { sessionId })).project;
    assert(adoptedProject.pages.every(entry => entry.reviewState === "ready"));
    await goToPage(0); await loadTeaching();
  });
  await testAdoptedPlayback({ app, page, expect, project: adoptedProject, out, step, report });
  await step(`Full ${packaged ? "packaged" : "source"} Electron and Host restart retain teaching clip and playable local MP3 with no media requests`, async () => {
    saved = await read(); const before = http.length; refuseMedia = true;
    await stop();
    await assert.rejects(readFile(`/proc/${report.runtimeStarts[0].hostPid}/status`), { code: "ENOENT" }, "Original owned Rust Host exits before restart");
    if (packaged) await assert.rejects(readFile(`/proc/${report.runtimeStarts[0].agent.pid}/status`), { code: "ENOENT" }, "Original bundled Agent exits before restart");
    await start(); await openOffice(); await goToPage(0); await loadTeaching();
    assert.deepEqual((await invoke("pptEditorTeachingOpen", { sessionId })).project, adoptedProject);
    await expect(teaching().locator("[data-teaching-music-clip]")).toHaveCount(1);
    await teaching().locator("[data-teaching-music-clip]").scrollIntoViewIfNeeded();
    await teaching().screenshot({ path: join(out, "05-restarted-teaching-clip.png") });
    await openCanvas(); await music().getByRole("button", { name: "Refresh music attempts", exact: true }).click();
    assert.deepEqual(await read(), saved);
    await exportRow().getByRole("button", { name: "Download and archive exported MP3", exact: true }).click();
    await verifyAudio(exportRow().locator("audio"));
    assert(!http.slice(before).some(value => value.path.startsWith("/courseware/media/")));
    assert.equal(generationPosts, 1); assert.equal(exportPosts, 1); assert.equal(assetReads, 1); assert.equal(previewReads, 1);
    await exportRow().screenshot({ path: join(out, "06-restarted-local-export.png") });
  });
  assert.equal(report.runtimeStarts.length, 2); assert.notEqual(report.runtimeStarts[0].pid, report.runtimeStarts[1].pid);
  assert.notEqual(report.runtimeStarts[0].hostPid, report.runtimeStarts[1].hostPid, "Both Electron starts launch a different matching Rust Host PID");
  if (packaged) assert.notEqual(report.runtimeStarts[0].agent.pid, report.runtimeStarts[1].agent.pid, "Both packaged starts launch a different bundled Agent PID");
  assert.equal(digest(await readFile(file)), report.originalTeaching.source.sha256, "Music and teaching changes do not mutate PPTX");
  assert(!logs.some(value => /PAGEERROR|FIXTUREERROR/u.test(value)), "No renderer or fixture errors");
  report.status = packaged ? "PASS_PACKAGED_ELECTRON_OFFICE_HOST_MUSIC_ADOPTION" : "PASS_SOURCE_ELECTRON_OFFICE_HOST_MUSIC_ADOPTION"; report.sessionId = sessionId;
} catch (failure) {
  report.status = "FAIL"; report.error = String(failure.stack); console.error(failure); process.exitCode = 1;
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(out, "failure.png") }).catch(() => {});
    await writeFile(join(out, "failure-aria.txt"), await page.locator("body").ariaSnapshot()).catch(() => {});
  }
} finally {
  await stop(); await new Promise(resolve => server.close(resolve));
  Object.assign(report, { generationPosts, exportPosts, ttsPosts, previewReads, assetReads, posted });
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(join(out, "http.json"), JSON.stringify(http, null, 2) + "\n");
  await writeFile(join(out, "main.log"), logs.join("\n"));
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, out, directory, generationPosts, exportPosts, previewReads, assetReads }));
}
