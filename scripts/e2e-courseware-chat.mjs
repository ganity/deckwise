/** Real main Chat -> local deterministic SSE -> runtime -> Host permissions -> native Office. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { coursewareLaunch, retainCoursewareWorkspace } from "./e2e/boot.mjs";
import { testChatTtsPlayback, testAdoptedPlayback, testNativeAudioSave } from "./e2e/tts-playback.mjs";
import { createCanvasReplacementFixture, testCanvasImageReplacement } from "./e2e/canvas-image-replacement.mjs";
import { createRebuiltAttentionFixture, testRebuiltAttentionPlayback } from "./e2e/rebuilt-attention.mjs";
import { testNativeAudioConcurrency } from "./e2e/native-audio-concurrency.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

for (const key of ["DECKWISE_E2E_OFFICE_ROOT", "DECKWISE_E2E_PPTX", "DECKWISE_EDITOR_URL", "DECKWISE_E2E_OUTPUT",
  ...(process.env.DECKWISE_E2E_PACKAGE_ROOT ? [] : ["PI_DESKTOP_HOST_BIN", "DECKWISE_PPTX_WORKER"])]) assert(process.env[key], `Missing ${key}`);
assert(["127.0.0.1", "localhost"].includes(new URL(process.env.DECKWISE_EDITOR_URL).hostname));
const launch = coursewareLaunch();
const require = createRequire(join(resolve(process.env.DECKWISE_E2E_OFFICE_ROOT), "package.json"));
const { _electron, expect } = require("@playwright/test");
const runFile = promisify(execFile);
const out = resolve(process.env.DECKWISE_E2E_OUTPUT);
await mkdir(dirname(out), { recursive: true });
await mkdir(out);
const recovery = process.env.DECKWISE_E2E_RESUME_PLAYBACK_REPORT
  ? JSON.parse(await readFile(process.env.DECKWISE_E2E_RESUME_PLAYBACK_REPORT, "utf8")) : null;
if (recovery) assert(recovery.status === "FAIL" && recovery.recovery?.directory && recovery.recovery?.sessionId &&
  recovery.continuousTts?.length && (recovery.paidCalls || recovery.mediaProviderFixture === true), "Playback recovery needs an original retained media project");
const temp = recovery?.recovery.directory || await mkdtemp(join(tmpdir(), "deckwise-teaching-"));
const workspace = join(temp, "workspace");
if (!recovery) await mkdir(workspace);
let file = join(workspace, "lesson.pptx");
if (!recovery) await copyFile(process.env.DECKWISE_E2E_PPTX, file);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const originalHash = hash(await readFile(file));
const report = { case: "A2-NATIVE-CHAT", status: "RUNNING", packaged: launch.packaged, checks: [], originalHash, sandbox: "--no-sandbox", paidCalls: false };
const logs = [];
let app;
let page;
let sessionId = recovery?.recovery.sessionId;
let restoreRecoveryAuth = !!recovery;
let providerId;
let otherSessionId;
let invoke;
let sdk;
let importedPath;
const imageReplacement = process.env.DECKWISE_E2E_EXPECT_IMAGE === "1";
const chatChanges = process.env.DECKWISE_E2E_CHAT_CHANGES === "1";
const chatPlan = process.env.DECKWISE_E2E_CHAT_PLAN === "1";
const chatResolution = process.env.DECKWISE_E2E_CHAT_RESOLUTION === "1";
assert(!chatPlan || chatChanges, "Declared-plan acceptance requires durable Chat receipts");
assert(!chatResolution || chatPlan, "Resolution acceptance requires a declared Chat plan");
const nativeAudioConcurrency = process.env.DECKWISE_E2E_NATIVE_AUDIO_CONCURRENCY === "1";
let firstChatChange;
const canvasImage = process.env.DECKWISE_E2E_CANVAS_IMAGE === "1";
assert(!canvasImage || imageReplacement, "Canvas image acceptance requires DECKWISE_E2E_EXPECT_IMAGE=1");
const canvasImageInsert = process.env.DECKWISE_E2E_CANVAS_IMAGE_INSERT === "1";
assert(!canvasImageInsert || canvasImage, "Canvas insertion requires the canvas image acceptance path");
const imageSize = process.env.DECKWISE_E2E_EXPECT_IMAGE_SIZE === "1";
const imagePosition = process.env.DECKWISE_E2E_EXPECT_IMAGE_POSITION === "1";
const objectAnimation = process.env.DECKWISE_E2E_EXPECT_OBJECT_ANIMATION === "1";
const assetLocks = process.env.DECKWISE_E2E_EXPECT_ASSET_LOCKS === "1";
assert(!(imageSize && imagePosition), "Select only one native image geometry operation per run");
const realPlatform = process.env.DECKWISE_E2E_REAL_PLATFORM_URL;
const loopbackTts = process.env.DECKWISE_E2E_LOOPBACK_TTS === "1";
const realTts = process.env.DECKWISE_E2E_REAL_TTS === "1";
const nativeAudioSave = process.env.DECKWISE_E2E_NATIVE_AUDIO_SAVE === "1";
assert(!nativeAudioSave || (!realTts && (loopbackTts || recovery?.mediaProviderFixture === true)), "Native-audio save acceptance uses bounded loopback media or its retained project");
if (loopbackTts) assert(realPlatform && process.env.DECKWISE_E2E_EXPECT_NARRATION === "1" &&
  process.env.DECKWISE_E2E_TTS_MODEL === "loopback-courseware", "Loopback TTS needs the dedicated fixture Platform runner");
if (realTts) assert(realPlatform && !loopbackTts && process.env.DECKWISE_E2E_EXPECT_NARRATION === "1" &&
  process.env.DECKWISE_E2E_TTS_MODEL === "doubao-courseware" && process.env.DECKWISE_E2E_TTS_VOICE,
  "Real TTS requires the authorized bounded runner and explicit model/voice");
if (realPlatform) {
  const url = new URL(realPlatform);
  assert(["127.0.0.1", "localhost"].includes(url.hostname) && url.protocol === "http:");
  assert(process.env.DECKWISE_E2E_REFRESH_TOKEN_FILE && !imageReplacement);
  report.authFixtureOnly = false;
  report.platformBaseUrl = url.origin;
}
const redo = process.env.DECKWISE_E2E_EXPECT_REDO === "1";
const adoptRedo = process.env.DECKWISE_E2E_EXPECT_REDO_ADOPTION === "1";
const redoAttention = process.env.DECKWISE_E2E_EXPECT_REDO_ATTENTION === "1";
const styleReview = process.env.DECKWISE_E2E_EXPECT_STYLE_REVIEW === "1";
assert(!adoptRedo || redo);
assert(!styleReview || redo);
const styleBatch = process.env.DECKWISE_E2E_EXPECT_STYLE_BATCH === "1";
assert(!styleBatch || (styleReview && adoptRedo));
assert(!redoAttention || (redo && adoptRedo), "Rebuilt attention acceptance requires reviewed adoption");
const attentionFixture = redoAttention ? await createRebuiltAttentionFixture() : null;
const raceFixture = nativeAudioConcurrency ? await createRebuiltAttentionFixture(/^Look! What do you see\?$/u) : null;
assert(!nativeAudioConcurrency || (!realPlatform && !redo && !imageReplacement && !chatChanges &&
  process.env.DECKWISE_E2E_EXPECT_NARRATION === "1" && process.env.DECKWISE_E2E_TASK_TYPE === "plain"),
"Native concurrency uses only the bounded local speech fixture and ordinary narration path");
let holdNextBatchScene = false;
const teamProjectId = "11111111-1111-4111-8111-111111111111";
const teamAssetId = "22222222-2222-4222-8222-222222222222";
const teamPath = `/courseware/team/projects/${teamProjectId}/assets/${teamAssetId}`;
const teamRequests = [];
let teamPng;
let replacementAssetId = teamAssetId;
const canvasImageFixture = canvasImage ? createCanvasReplacementFixture(() => teamPng) : null;
let revoked = false;
const localAccessToken = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 7200 })).toString("base64url")}.signature`;
const button = (name) => page.locator(".courseware-teaching").getByRole("button", { name });
const load = () => button(/Load current page|读取当前页讲解/);
async function step(name, action) {
  console.log("START", name);
  await action(); report.checks.push(name); console.log("PASS", name);
}
async function start() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/api.?key|secret|token|password|proxy/i.test(key)));
  app = await _electron.launch({ executablePath: launch.executablePath, args: ["--no-sandbox", "--user-data-dir=" + join(temp, "profile"), ...launch.args], cwd: launch.cwd,
    env: { ...env, ELECTRON_RUN_AS_NODE: "", ELECTRON_RENDERER_URL: "", PI_DESKTOP_DATA_DIR: join(temp, "data"), PI_DESKTOP_START_MAXIMIZED: "0", DECKWISE_PLATFORM_BASE_URL: realPlatform || (imageReplacement || redoAttention || nativeAudioConcurrency ? baseUrl.replace(/\/v1$/, "") : "http://127.0.0.1:9/test-platform") }, timeout: 60_000 });
  for (const stream of [app.process().stdout, app.process().stderr]) stream.on("data", (bytes) => logs.push(String(bytes)));
  page = await app.firstWindow({ timeout: 120_000 });
  if (imageReplacement || redoAttention || nativeAudioConcurrency || realPlatform) {
    await app.evaluate((_, home) => {
      process.getBuiltinModule("os").homedir = () => home;
      process.getBuiltinModule("module").syncBuiltinESMExports();
    }, join(temp, "isolated-home"));
  }
  if (imageReplacement) {
    teamPng = Buffer.from(await app.evaluate(({ nativeImage }) =>
      Array.from(nativeImage.createFromBitmap(Buffer.from(Array(4).fill([0, 0, 255, 255]).flat()), { width: 2, height: 2 }).toPNG())));
    await writeFile(join(out, "approved.png"), teamPng);
  }
  report.runtime = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath, executablePath: process.execPath }));
  assert.equal(report.runtime.packaged, launch.packaged);
  if (launch.packaged) {
    assert.equal(report.runtime.appPath, join(launch.cwd, "resources/app.asar"));
    assert.equal(report.runtime.resourcesPath, join(launch.cwd, "resources"));
    assert.equal(report.runtime.executablePath, launch.executablePath);
  }
  const observePage = (target) => {
    target.on("pageerror", (error) => logs.push("PAGEERROR " + target.url() + " " + error.stack));
    target.on("console", (message) => { if (message.type() === "error") logs.push("CONSOLE " + target.url() + " " + message.text()); });
    target.on("requestfailed", (request) => logs.push("REQUESTFAILED " + request.url() + " " + request.failure()?.errorText));
    target.on("response", (response) => { if (response.status() >= 400) logs.push("HTTP " + response.status() + " " + response.url()); });
  };
  for (const target of app.context().pages()) observePage(target);
  app.context().on("page", observePage);
  await app.evaluate(({ session }) => session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    callback({ cancel: /^https?:$/.test(url.protocol) && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) });
  }));
  await page.waitForFunction(() => !!window.piDesktop);
  if (!imageReplacement && !redoAttention && !nativeAudioConcurrency && !realPlatform) await page.locator(".auth-refresh").waitFor({ state: "visible", timeout: 60_000 });
  const channels = await page.evaluate(() => window.piDesktop.channels);
  if (realPlatform) {
    if (!sessionId || restoreRecoveryAuth) {
      const authDir = join(temp, "data/auth");
      await mkdir(authDir, { recursive: true });
      await writeFile(join(authDir, "session.token"), await readFile(process.env.DECKWISE_E2E_REFRESH_TOKEN_FILE), { mode: 0o600 });
      restoreRecoveryAuth = false;
    }
    const state = await page.evaluate(async () => {
      const result = await window.piDesktop.invoke(window.piDesktop.channels.invoke.authRestore);
      if (!result.ok) throw new Error(JSON.stringify(result));
      return result.data;
    });
    assert.equal(state.status, "authenticated");
    assert.equal(state.profile.edition, "EDUCATION");
    assert.notEqual(state.profile.role, "STAFF");
    report.platformIdentity = { tenantId: state.profile.tenantId, userId: state.profile.userId, role: state.profile.role };
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1500, height: 950 }));
  } else if (imageReplacement || redoAttention || nativeAudioConcurrency) {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1500, height: 950 }));
    await page.evaluate(async () => {
      const invoke = async name => {
        const result = await window.piDesktop.invoke(window.piDesktop.channels.invoke[name], ...(name === "authPollQr" ? [{ ticket: "image-ticket" }] : []));
        if (!result.ok) throw new Error(JSON.stringify(result)); return result.data;
      };
      if ((await invoke("authRestore")).status !== "authenticated") { await invoke("authStartQr"); await invoke("authPollQr"); }
    });
  } else await app.evaluate(({ ipcMain, BrowserWindow }, channels) => {
    const state = { status: "authenticated", profile: { userId: 1, userName: "Local teaching verification", edition: "EDUCATION", role: "TEACHER", pcAllowed: true } };
    for (const name of ["authRestore", "authStartQr"]) { ipcMain.removeHandler(channels.invoke[name]); ipcMain.handle(channels.invoke[name], () => ({ ok: true, data: state })); }
    const window = BrowserWindow.getAllWindows()[0];
    window.setBounds({ x: 0, y: 0, width: 1500, height: 950 });
    const send = window.webContents.send.bind(window.webContents);
    window.webContents.send = (channel, ...args) => send(channel, ...(channel === channels.event.authChanged ? [state] : args));
    send(channels.event.authChanged, state);
  }, channels);
  await page.reload();
  await page.waitForFunction(() => !!window.__PI_DESKTOP__);
  invoke = (name, ...args) => page.evaluate(async ({ name, args }) => {
    const response = await window.piDesktop.invoke(window.piDesktop.channels.invoke[name], ...args);
    if (!response.ok) throw new Error(JSON.stringify(response));
    return response.data;
  }, { name, args });
  await invoke("projectSet", workspace);
  if (!sessionId) {
    const { provider } = await invoke("providersCreate", { name: "Local native Chat fixture", vendorKey: "custom", type: "openai_compatible", protocol: "openai_compatible", baseUrl,
      authKind: "none", defaultModelId: "native-chat-fixture", apiStyle: "chat_completions",
      ...(redo ? { models: [{ id: "native-chat-fixture", contextWindow: 128000, maxTokens: 8192,
        thinkingLevels: [], defaultThinkingLevel: null, supportsImages: true }] } : {}) });
    providerId = provider.id;
    sessionId = (await invoke("sessionCreate", { title: "Native Chat verification", projectPath: workspace, providerId: provider.id, modelId: "native-chat-fixture", mode: "agent" })).session.id;
    if (process.env.DECKWISE_E2E_TASK_TYPE === "plain" || canvasImage || redoAttention) {
      const { task } = await invoke("coursewareTaskSet", { sessionId, taskType: "plain", educationContext: {} });
      assert.equal(task.taskType, "plain"); report.taskType = "plain";
    }
    otherSessionId = (await invoke("sessionCreate", { title: "Unbound Chat", projectPath: workspace, providerId,
      modelId: "native-chat-fixture", mode: "agent" })).session.id;
  }
  await page.reload();
  await page.waitForFunction(() => !!window.__PI_DESKTOP__);
  await page.evaluate(async () => window.__PI_DESKTOP__.refreshProviders());
  await page.evaluate(async (id) => window.__PI_DESKTOP__.selectSession(id), sessionId);
  if (process.env.DECKWISE_E2E_IMPORT_PICKER === "1" && !importedPath) {
    await page.evaluate(() => { window.__PI_CAPTURE__ = true; window.__PI_DESKTOP__.openNewWorkPanelTab(); });
    await page.locator('[data-work-panel-launcher-item="ppt-master"]').click();
    await page.getByRole("button", { name: "已有 PPT 导入" }).click();
    await app.evaluate(({ dialog }, source) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] }); }, file);
    await page.getByRole("button", { name: "选择 PPTX 并导入" }).click();
    await expect.poll(async () => (await invoke("coursewareTaskGet", { sessionId })).task?.importPath, { timeout: 30_000 }).toMatch(/\.deckwise-ppt\/imports\//);
    importedPath = (await invoke("coursewareTaskGet", { sessionId })).task.importPath;
    assert.deepEqual(await readFile(importedPath), await readFile(file));
    file = importedPath;
    report.taskType = "import";
  }
  await page.evaluate(async (path) => { window.__PI_CAPTURE__ = true; await window.__PI_DESKTOP__.openWorkPanelArtifact("file", path); }, importedPath || "lesson.pptx");
  await waitForOffice();
  await expect(load()).toBeEnabled();
  await expect.poll(async () => page.locator(".ppt-editor-surface").evaluate((surface) => {
    const r = surface.getBoundingClientRect();
    return r.width > 250 && r.height > 200;
  })).toBe(true);

}
async function waitForOffice() {
  sdk = undefined;
  await expect.poll(async () => {
    const host = app.context().pages().find((target) => target.url().startsWith("deckwise-editor:"));
    if (!host) return false;
    for (const frame of host.frames()) {
      if (await frame.evaluate(() => Boolean(window.Asc?.editor?.isLoadFullApi && window.Asc.editor.isDocumentLoadComplete)).catch(() => false)) { sdk = frame; return true; }
    }
    return false;
  }, { timeout: 120_000 }).toBe(true);
}
async function goToPage(index) {
  await sdk.evaluate((index) => window.Asc.editor.goToPage(index), index);
  await expect.poll(async () => (await invoke("pptEditorGetContext")).page, { timeout: 15_000 }).toBe(index + 1);
}
async function stop() {
  const current = app;
  app = undefined;
  if (current && current.process().exitCode === null && current.process().signalCode === null) {
    const exited = new Promise((resolve) => current.process().once("exit", resolve));
    await current.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await exited;
  }
}

const requests = [];
const heldCompletions = new Set();
let cancelledCompletions = 0;
let sequence = 0;
const narration = process.env.DECKWISE_E2E_EXPECT_NARRATION === "1";
const narrationCompletionUrl = process.env.DECKWISE_E2E_NARRATION_COMPLETION_URL;
const teacherContinue = process.env.DECKWISE_E2E_TEACHER_CONTINUE === "1";
assert(!teacherContinue || (narration && !narrationCompletionUrl && !loopbackTts && !realTts),
  "Teacher-continuation regression uses only the local model fixture and no media submission");
if (teacherContinue) Object.assign(report, { mainChatModelFixture: true, narrationModelFixture: true,
  authFixtureOnly: !realPlatform, teacherLogin: false });
if (narrationCompletionUrl) {
  const url = new URL(narrationCompletionUrl);
  assert(narration && url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname) &&
    !url.username && !url.password && !url.search && !url.hash && url.pathname === "/complete");
  report.realNarrationCompletion = true;
  report.mainChatModelFixture = true;
  report.paidCalls = false;
  report.modelCalls = 1;
  report.paidMediaCalls = false;
}
const formatting = process.env.DECKWISE_E2E_EXPECT_FORMATTING === "1";
const fontFamily = process.env.DECKWISE_E2E_EXPECT_FONT_FAMILY === "1";
assert(!fontFamily || formatting, "Font-family acceptance requires native formatting");
const requestLimit = (narration ? 55 : 35) + (formatting ? 25 : 0) + (fontFamily ? 10 : 0) + (redo ? 45 : 0);
let sceneRequests = 0;
const formats = [
  ...(fontFamily ? [["FAMILY", "set_slide_font_family", { fontFamily: "" }]] : []),
  ["SIZE", "set_slide_font_size", { fontSizePt: 24.5 }],
  ["COLOR", "set_slide_text_color", { colorHex: "336699" }],
  ["POSITION", "set_slide_text_box_position", { xMm: 25, yMm: 35 }],
];
const fade = process.env.DECKWISE_E2E_EXPECT_FADE === "1";
const adoptFade = process.env.DECKWISE_E2E_EXPECT_FADE_ADOPTION === "1";
assert(!adoptFade || fade);
const sourcePauses = process.env.DECKWISE_E2E_EXPECT_SOURCE_PAUSES === "1";
assert(!sourcePauses || narration, "Source-pause acceptance requires actual Chat narration generation");
const narrationBlocks = [{ type: "speech", text: "Look! What do you see?" }, { type: "wait", durationMs: 4000 }, { type: "speech", text: "Thank you for trying." }];
if (teacherContinue) narrationBlocks.splice(2, 0, { type: "wait", mode: "teacher_continue" });
const plain = (value) => typeof value === "string" ? value : JSON.stringify(value ?? "");
const server = createServer(async (req, res) => {
  try {
    if ((imageReplacement || redoAttention || nativeAudioConcurrency) && !req.url.startsWith("/v1")) {
      teamRequests.push({ method: req.method, path: req.url });
      const send = (data, code = 200) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ code, data })); };
      if (req.url.startsWith("/auth/desktop/wx/qrcode")) return send({ ticket: "image-ticket", entryUrl: "https://fixture.test/qr" });
      if (req.url === "/auth/wx/poll/image-ticket") return send({ status: "SUCCESS", accessToken: localAccessToken, refreshToken: "local-image-refresh" });
      if (req.url === "/auth/desktop/refresh") return send({ accessToken: localAccessToken, refreshToken: "local-image-refresh" });
      if (req.url === "/auth/me") return send({ edition: "EDUCATION", pcAllowed: true, role: "ADMIN", userId: 7, tenantId: 8 });
      if (req.url === "/auth/logout") return send({});
      assert.equal(req.headers.authorization, `Bearer ${localAccessToken}`);
      if (redoAttention && await attentionFixture.handle(req, res)) return;
      if (nativeAudioConcurrency && await raceFixture.handle(req, res)) return;
      if (canvasImage && await canvasImageFixture.handle(req, res)) return;
      if (revoked) return send(null, 46100);
      if (req.url === teamPath) return send({ projectId: teamProjectId, assetRef: { assetId: teamAssetId, sha256: hash(teamPng), mime: "image/png", byteLength: teamPng.length, width: 2, height: 2, downloadPath: `${teamPath}/content` } });
      if (req.url === `${teamPath}/content`) { res.setHeader("content-type", "image/png"); return res.end(teamPng); }
      res.writeHead(404); return res.end();
    }
    if (req.method === "GET") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "native-chat-fixture" }] })); return; }
    let body = ""; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    assert(requests.length < requestLimit, "Fixture request limit exceeded");
    requests.push(payload);
    const lastUser = payload.messages.findLastIndex((row) => row.role === "user");
    const user = plain(payload.messages[lastUser]?.content);
    const rows = payload.messages.slice(lastUser + 1);
    const tools = rows.filter((row) => row.role === "tool");
    const calls = rows.flatMap((row) => row.tool_calls ?? []);
    const resultFor = (name) => {
      for (let index = calls.length - 1; index >= 0; index -= 1) {
        const call = calls[index];
        if (call.function?.name !== name) continue;
        const result = tools.find((row) => row.tool_call_id === call.id);
        if (result) return result;
      }
      return undefined;
    };
    let name, args;
    const nativeAvailable = payload.tools?.some((tool) => tool.function?.name.startsWith("ppt_"));
    let answer = "Fixture title";
    if (payload.messages.some((row) => row.role === "system" && plain(row.content).includes("Produce one JSON editable page scene"))) {
      assert(redo); assert(!payload.tools?.length); sceneRequests++;
      const parts = payload.messages[lastUser].content;
      const data = JSON.parse(parts.find(part => part.type === "text").text);
      assert.equal(parts.filter(part => part.type === "image_url").length, data.representative ? 3 : 2);
      assert.match(data.sourceHash, /^sha256:[a-f0-9]{64}$/);
      if (data.representative) { assert(styleBatch); assert(data.sourceVisual); }
      else assert(data.pageText.includes("CHAT_ADDED_IN_OFFICE"));
      if (data.instruction.includes("CANCEL_REDO") || (data.representative && holdNextBatchScene)) {
        holdNextBatchScene = false;
        heldCompletions.add(res); res.once("close", () => { heldCompletions.delete(res); cancelledCompletions++; });
        res.writeHead(200, { "content-type": "text/event-stream" }); res.write(": held scene for explicit cancellation\n\n"); return;
      }
      answer = JSON.stringify({ version: 1, slideId: data.pageId, sourceHash: data.sourceHash, canvas: data.canvas,
        visualMasterAssetId: data.visualMasterAssetId, cleanPlateAssetId: data.cleanPlateAssetId, elements: [
          { id: "title", type: "native_text", content: data.representative ? "CHAT_BATCH_EDITABLE" : "CHAT_REDO_EDITABLE", bboxPx: [50, 50, 800, 90], zIndex: 1,
            style: { fontFace: "Arial", fontSizePt: 30, color: "#1741B6" } },
          { id: "shape", type: "native_shape", shape: "ellipse", fill: "#DDEEFF", bboxPx: [100, 250, 150, 150], zIndex: 2 },
        ] });
    } else if (payload.messages.some((row) => row.role === "system" && plain(row.content).includes("Rewrite only this page."))) {
      assert(!payload.tools?.length, "Completion has no tools");
      const data = JSON.parse(user); assert(data.pageText.includes("CHAT_ADDED_IN_OFFICE"));
      if (data.instruction.includes("CANCEL_NARRATION")) {
        heldCompletions.add(res);
        res.once("close", () => { heldCompletions.delete(res); cancelledCompletions++; });
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": held for explicit user cancellation\n\n");
        return;
      }
      if (narrationCompletionUrl) {
        const response = await fetch(narrationCompletionUrl, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages: payload.messages }), signal: AbortSignal.timeout(150_000) });
        assert.equal(response.status, 200, "Configured narration completion failed");
        const output = await response.json();
        assert(typeof output.text === "string" && output.text.length > 0 && output.text.length <= 32_000);
        answer = output.text;
      } else answer = JSON.stringify({ blocks: narrationBlocks });
    } else if (/CHAT_NATIVE_/.test(user)) {
      if (/CHAT_NATIVE_OTHER/.test(user)) {
        assert(!nativeAvailable); assert(!plain(payload.messages[0]).includes("ppt_get_presentation_text"));
        if (!resultFor("ToolSearch")) { name = "ToolSearch"; args = { query: "ppt" }; }
        else { assert(!plain(resultFor("ToolSearch").content).includes("ppt_add_slide_text")); answer = "CHAT_NATIVE_UNAVAILABLE"; }
      } else if (!resultFor("Skill")) { name = "Skill"; args = { id: "deckwise/ppt-edit" }; }
      else if (!nativeAvailable && !resultFor("ToolSearch")) { name = "ToolSearch"; args = { query: "ppt" }; }
      else if (!nativeAvailable) { answer = "CHAT_NATIVE_TOOL_FAILED"; }
      else if (!resultFor("ppt_get_presentation_text")) { name = "ppt_get_presentation_text"; args = {}; }
      else if (!plain(resultFor("ppt_get_presentation_text").content).includes('"editGeneration"')) { answer = "CHAT_NATIVE_TOOL_FAILED"; }
      else if (/CHAT_NATIVE_READ/.test(user)) { answer = "CHAT_NATIVE_READ_DONE"; }
      else if (/CHAT_NATIVE_OBJECT_ANIMATION_(APPEAR|FADE)/.test(user)) {
        assert(objectAnimation);
        const command = "ppt_add_slide_object_animation";
        const effect = user.includes("CHAT_NATIVE_OBJECT_ANIMATION_APPEAR") ? "appear" : "fade";
        if (!payload.tools?.some(tool => tool.function?.name === command)) { name = "ToolSearch"; args = { query: command }; }
        else if (!resultFor(command)) {
          const read = JSON.parse(resultFor("ppt_get_presentation_text").content);
          assert(read.context.capabilities.some(item => item.name === "add_slide_object_animation"));
          name = command; args = { effect, editGeneration: read.context.editGeneration };
        } else {
          const receipt = JSON.parse(resultFor(command).content);
          assert.equal(receipt.saved, false); assert.equal(receipt.response.status, "verified");
          assert.equal(receipt.response.result.effect, effect);
          answer = `CHAT_NATIVE_OBJECT_ANIMATION_${effect.toUpperCase()}_DONE`;
        }
      }
      else if (/CHAT_NATIVE_IMAGE_(?:SIZE|POSITION)/.test(user)) {
        assert(imageSize || imagePosition);
        const command = imagePosition ? "ppt_set_slide_image_position" : "ppt_set_slide_image_size";
        if (!payload.tools?.some(tool => tool.function?.name === command)) { name = "ToolSearch"; args = { query: command }; }
        else if (!resultFor(command)) {
          const read = JSON.parse(resultFor("ppt_get_presentation_text").content);
          assert(read.context.capabilities.some(item => item.name === command.slice(4)));
          name = command; args = imagePosition ? { xMm: 25.5, yMm: 35, editGeneration: read.context.editGeneration }
            : { widthMm: 80.5, heightMm: 30, editGeneration: read.context.editGeneration };
        } else {
          const receipt = JSON.parse(resultFor(command).content);
          assert.equal(receipt.saved, false); assert.equal(receipt.response.status, "verified");
          if (imagePosition) { assert.equal(receipt.response.result.xMm, 25.5); assert.equal(receipt.response.result.yMm, 35); }
          else { assert.equal(receipt.response.result.widthMm, 80.5); assert.equal(receipt.response.result.heightMm, 30); }
          answer = imagePosition ? "CHAT_NATIVE_IMAGE_POSITION_DONE" : "CHAT_NATIVE_IMAGE_SIZE_DONE";
        }
      }
      else if (/CHAT_NATIVE_IMAGE/.test(user)) {
        assert(imageReplacement);
        const tool = canvasImageInsert ? "insert_slide_image_from_asset" : "replace_slide_image_from_asset";
        const command = `ppt_${tool}`;
        if (!payload.tools?.some(tool => tool.function?.name === command)) { name = "ToolSearch"; args = { query: command }; }
        else if (!resultFor(command)) {
          const read = JSON.parse(resultFor("ppt_get_presentation_text").content);
          assert(read.context.capabilities.some(item => item.name === tool));
          name = command; args = { assetId: replacementAssetId, editGeneration: read.context.editGeneration,
            ...(canvasImageInsert ? { xMm: 25, yMm: 35, widthMm: 40, heightMm: 30 } : {}) };
        } else {
          const receipt = JSON.parse(resultFor(command).content);
          assert.equal(receipt.saved, false); assert.equal(receipt.response.result.sha256, hash(teamPng));
          assert(!JSON.stringify(receipt).includes('"imageId"'));
          answer = "CHAT_NATIVE_IMAGE_DONE";
        }
      }
      else if (/CHAT_NATIVE_FORMAT_/.test(user)) {
        const operation = formats.find(([marker]) => user.includes(`CHAT_NATIVE_FORMAT_${marker}`));
        assert(formatting && operation, "Unexpected formatting request");
        const [marker, command, input] = operation;
        const read = row => JSON.parse(typeof row.content === "string" ? row.content : row.content.map(part => part.text ?? "").join(""));
        if (!payload.tools?.some(tool => tool.function?.name === `ppt_${command}`)) {
          name = "ToolSearch"; args = { query: `ppt_${command}` };
        } else if (!resultFor(`ppt_${command}`)) {
          const context = read(resultFor("ppt_get_presentation_text")).context;
          assert(context.capabilities.some(capability => capability.name === command), "Real Office must advertise the requested capability");
          name = `ppt_${command}`; args = { ...input, editGeneration: context.editGeneration };
        } else {
          const receipt = read(resultFor(`ppt_${command}`));
          assert.equal(receipt.saved, false);
          assert.equal(receipt.response.status, "verified");
          assert.equal(receipt.response.result.page, 2);
          for (const [key, value] of Object.entries(input)) assert.equal(receipt.response.result[key], value);
          answer = `CHAT_NATIVE_FORMAT_${marker}_DONE`;
        }
      }
      else if (/CHAT_NATIVE_STYLE_BATCH/.test(user)) {
        assert(styleBatch);
        const read = row => typeof row.content === "string" ? row.content : row.content.map(part => part.text ?? "").join("");
        if (!payload.tools?.some(tool => tool.function?.name === "ppt_propose_page_style_batch")) {
          name = "ToolSearch"; args = { query: "ppt_propose_page_style_batch" };
        } else if (!resultFor("ppt_propose_page_style_batch")) {
          name = "ppt_propose_page_style_batch"; args = { editGeneration: JSON.parse(read(resultFor("ppt_get_presentation_text"))).context.editGeneration };
        } else if (user.includes("UNAPPROVED")) {
          assert.match(read(resultFor("ppt_propose_page_style_batch")), /capability unavailable/); answer = "CHAT_NATIVE_STYLE_BATCH_UNAVAILABLE";
        } else {
          const receipt = JSON.parse(read(resultFor("ppt_propose_page_style_batch")));
          assert.equal(receipt.kind, "page-style-batch"); assert.equal(receipt.applied, false); assert.equal(receipt.saved, false);
          assert.equal(receipt.reviewState, "needs-review"); assert(receipt.targetPageIds.length >= 2);
          answer = `CHAT_NATIVE_STYLE_BATCH_DONE ${receipt.candidateId} ${receipt.outputSha256}`;
        }
      }
      else if (/CHAT_NATIVE_REDO/.test(user)) {
        const read = row => typeof row.content === "string" ? row.content : row.content.map(part => part.text ?? "").join("");
        if (!payload.tools?.some(tool => tool.function?.name === "ppt_propose_page_redo")) {
          name = "ToolSearch"; args = { query: "ppt_propose_page_redo" };
        } else if (!resultFor("ppt_propose_page_redo")) {
          name = "ppt_propose_page_redo"; args = { editGeneration: JSON.parse(read(resultFor("ppt_get_presentation_text"))).context.editGeneration,
            instruction: user.includes("CANCEL_REDO") ? "CANCEL_REDO" : "Rebuild the current page with editable text and a blue accent" };
        } else if (user.includes("UNAPPROVED")) {
          assert.match(read(resultFor("ppt_propose_page_redo")), /capability unavailable/); answer = "CHAT_NATIVE_REDO_UNAVAILABLE";
        } else {
          const receipt = JSON.parse(read(resultFor("ppt_propose_page_redo")));
          assert.equal(receipt.kind, "page-pptx"); assert.equal(receipt.applied, false); assert.equal(receipt.saved, false);
          assert.equal(receipt.reviewState, "needs-review"); answer = `CHAT_NATIVE_REDO_DONE ${receipt.candidateId} ${receipt.outputSha256}`;
        }
      }
      else if (/CHAT_NATIVE_NARRATION/.test(user)) {
        if (!payload.tools?.some(tool => tool.function?.name === "ppt_propose_page_narration")) {
          name = "ToolSearch"; args = { query: "ppt_propose_page_narration" };
        } else if (!resultFor("ppt_propose_page_narration")) {
          const row = resultFor("ppt_get_presentation_text");
          const text = typeof row.content === "string" ? row.content : row.content.map((part) => part.text ?? "").join("");
          name = "ppt_propose_page_narration"; args = { instruction: /CANCEL_NARRATION/.test(user) ? "CANCEL_NARRATION" : narrationCompletionUrl
            ? "Rewrite the current page for grade-3 learners in short Chinese sentences. Return exactly three blocks: one speech block containing the entire explanation and one relevant question, one fixed wait block of exactly 4000 ms, and one final speech block containing only Good job! Use exactly two speech blocks; keep all explanation sentences together in the first block, under 160 Chinese characters. Do not claim to have heard a learner answer."
            : "Use short sentences and simple English encouragement", editGeneration: JSON.parse(text).context.editGeneration };
        } else {
          const row = resultFor("ppt_propose_page_narration");
          const text = typeof row.content === "string" ? row.content : row.content.map((part) => part.text ?? "").join("");
          const receipt = JSON.parse(text);
          assert.equal(receipt.applied, false); assert.equal(receipt.audioReady, false);
          assert(!("actions" in receipt)); assert(!("write" in receipt));
          answer = "CHAT_NATIVE_NARRATION_DONE " + receipt.candidateId;
        }
      }
      else if (/CHAT_NATIVE_FADE/.test(user)) {
        const read = row => typeof row.content === "string" ? row.content : row.content.map(part => part.text ?? "").join("");
        if (!payload.tools?.some(tool => tool.function?.name === "ppt_propose_page_fade")) {
          name = "ToolSearch"; args = { query: "ppt_propose_page_fade" };
        } else if (!resultFor("ppt_propose_page_fade")) {
          name = "ppt_propose_page_fade";
          args = { editGeneration: JSON.parse(read(resultFor("ppt_get_presentation_text"))).context.editGeneration };
        } else {
          const receipt = JSON.parse(read(resultFor("ppt_propose_page_fade")));
          assert.equal(receipt.applied, false); assert.equal(receipt.saved, false);
          assert.equal(receipt.reviewState, "needs-review"); assert.match(receipt.outputSha256, /^[a-f0-9]{64}$/);
          answer = `CHAT_NATIVE_FADE_DONE ${receipt.candidateId} ${receipt.outputSha256}`;
        }
      }
      else if (chatPlan && !payload.tools?.some(tool => tool.function?.name === "ppt_record_change_plan")) {
        name = "ToolSearch"; args = { query: "ppt_record_change_plan" };
      }
      else if (chatPlan && !resultFor("ppt_record_change_plan")) {
        const row = resultFor("ppt_get_presentation_text");
        const text = typeof row.content === "string" ? row.content : row.content.map(part => part.text ?? "").join("");
        name = "ppt_record_change_plan"; args = { editGeneration: JSON.parse(text).context.editGeneration, changes: [
          { label: "Add the requested page text", toolName: "ppt_add_slide_text" },
          { label: "Also rewrite this page narration", toolName: "ppt_propose_page_narration" },
        ] };
      }
      else if (!payload.tools?.some(tool => tool.function?.name === "ppt_add_slide_text")) {
        name = "ToolSearch"; args = { query: "ppt_add_slide_text" };
      }
      else if (!resultFor("ppt_add_slide_text")) {
        const row = resultFor("ppt_get_presentation_text");
        const text = typeof row.content === "string" ? row.content : row.content.map((part) => part.text ?? "").join("");
        const details = JSON.parse(text);
        name = "ppt_add_slide_text"; args = { text: "CHAT_ADDED_IN_OFFICE", editGeneration: details.context.editGeneration };
      } else answer = "CHAT_NATIVE_ADD_DONE";
    }
    const delta = name ? { role: "assistant", tool_calls: [{ index: 0, id: `fixture_call_${++sequence}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } : { role: "assistant", content: answer };
    const base = { id: `chatcmpl-${++sequence}`, object: "chat.completion.chunk", created: 1, model: payload.model };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: name ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  } catch (error) { logs.push("FIXTUREERROR " + error.stack); res.writeHead(500); res.end(String(error)); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
async function send(text) {
  const input = page.locator(".composer-input[contenteditable=true]").last();
  await input.fill(text); await input.press("Enter");
}
async function nativeText() {
  const context = await invoke("pptEditorGetContext");
  return (await invoke("pptEditorExecute", { projectId: context.projectId, documentId: context.documentId, sessionId: context.sessionId,
    editGeneration: context.editGeneration, requestId: randomUUID(), tool: "get_presentation_text", input: {} })).result.text;
}
async function readChatChanges() {
  const result = await runFile("python3", ["-c", `import json,sqlite3,sys
db=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
print(json.dumps([json.loads(r[0]) for r in db.execute('SELECT value_json FROM kv WHERE ns IN (?,?) ORDER BY key',('coursewareChatChanges.v1','coursewareChatPlannedChanges.v1'))]))`, join(temp, "data/pi.sqlite")]);
  return JSON.parse(result.stdout);
}
try {
  if (recovery) {
    report.resumedFrom = process.env.DECKWISE_E2E_RESUME_PLAYBACK_REPORT;
    report.mediaProviderFixture = recovery.mediaProviderFixture === true;
    report.continuousTts = recovery.continuousTts;
    await start(); await goToPage(0);
    let project = (await invoke("pptEditorTeachingOpen", { sessionId })).project;
    assert(project.pages.every((entry) => entry.reviewState === "ready"));
    assert.equal(hash(await readFile(file)), recovery.savedSha256);
    for (const entry of recovery.continuousTts) assert.equal(
      project.pages[entry.page - 1].actions.find((action) => action.id === entry.actionId)?.audioAssetId, entry.audioAssetId);
    await load().click(); await expect(load()).toBeEnabled({ timeout: 120_000 });
    if (nativeAudioSave) project = await testNativeAudioSave({ page, expect, invoke, sessionId, goToPage, project, file, out, step, report });
    await testAdoptedPlayback({ app, page, expect, project, out, step, report });
    await step("Complete restart restores the same paid narration and audio without another submission", async () => {
      await stop(); await start(); await goToPage(0);
      assert.deepEqual((await invoke("pptEditorTeachingOpen", { sessionId })).project, project);
      assert.equal(hash(await readFile(file)), project.source.sha256);
      if (nativeAudioSave) assert((await nativeText()).includes("EDIT_AFTER_AUDIO_ADOPTION"));
    });
    report.status = "PASS";
  } else {
  await step("Open actual Desktop Office with the existing main Chat", async () => { await start(); await goToPage(0); });
  if (chatChanges) await invoke("pptEditorTeachingOpen", { sessionId });
  await step("Chat activates ppt-edit and native tools under the existing Full auto policy", async () => {
    await send(chatPlan ? "CHAT_NATIVE_ADD 请给当前页添加一个文本框，并同步修改讲解。" : "CHAT_NATIVE_ADD 请给当前页添加一个文本框。");
    await expect(page.getByText("CHAT_NATIVE_ADD_DONE", { exact: true })).toBeVisible({ timeout: 90_000 });
    await expect(page.locator(".permission-card")).toHaveCount(0);
    assert((await nativeText()).includes("CHAT_ADDED_IN_OFFICE"));
    assert.equal(hash(await readFile(file)), originalHash, "Chat edit remains unsaved");
    if (chatChanges) {
      const changes = await readChatChanges();
      assert.equal(changes.length, 1);
      firstChatChange = changes[0];
      assert.equal(firstChatChange.baseline.source.sha256, originalHash);
      assert.equal(firstChatChange.sessionId, sessionId);
      assert.equal(firstChatChange.operations.length, 1);
      assert.equal(firstChatChange.operations[0].toolName, "ppt_add_slide_text");
      assert.equal(firstChatChange.operations[0].args.input.text, "CHAT_ADDED_IN_OFFICE");
      assert.equal(firstChatChange.operations[0].outcome.state, "acknowledged");
      assert.equal(firstChatChange.operations[0].outcome.saved, false);
      await writeFile(join(out, "chat-change-before-save.json"), JSON.stringify(firstChatChange, null, 2));
    }
    await page.screenshot({ path: join(out, "chat-native-edit.png") });
    const xwd = join(out, "chat-composite.xwd");
    await runFile("xwd", ["-root", "-silent", "-out", xwd]);
    await runFile("ffmpeg", ["-nostdin", "-v", "error", "-i", xwd, "-frames:v", "1", join(out, "chat-composite.png")]);
  });
  await step("Save, fully restart and read the Chat edit back from Office", async () => {
    await invoke("pptEditorSave");
    await expect(page.locator('.ppt-editor-document [role="status"]')).toContainText(/已保存|Saved/, { timeout: 120_000 });
    try {
      await invoke("pptEditorTeachingOpen", { sessionId });
    } catch (error) {
      if (!/COURSEWARE_CONFLICT.*reconcile/.test(String(error))) throw error;
      await button(/Review saved PPTX changes|审核已保存的 PPTX 变更/).click();
      const review = page.locator(".courseware-source-review");
      const choices = review.locator("select");
      const pageCount = await sdk.evaluate(() => window.Asc.editor.WordControl.m_oLogicDocument.Slides.length);
      await expect(choices).toHaveCount(pageCount, { timeout: 120_000 });
      // This edit only adds a text box; the existing page order is unchanged.
      for (let index = 0; index < pageCount; index++) await choices.nth(index).selectOption(String(index));
      const confirm = review.getByRole("button", { name: /Use these associations|采用这些关联/ });
      await expect(confirm).toBeDisabled();
      await review.locator('input[type="checkbox"]').check();
      await confirm.click();
      await expect(review).toHaveCount(0, { timeout: 120_000 });
    }
    report.savedSha256 = hash(await readFile(file)); assert.notEqual(report.savedSha256, originalHash);
    await stop(); await start();
    assert((await nativeText()).includes("CHAT_ADDED_IN_OFFICE"));
    await send("CHAT_NATIVE_READ 读取当前 PPT 的文字。");
    await expect(page.getByText("CHAT_NATIVE_READ_DONE", { exact: true })).toBeVisible({ timeout: 90_000 });
    const latest = requests.findLast((row) => row.messages.some((message) => plain(message.content).includes("CHAT_NATIVE_READ")));
    assert(plain(latest).includes("CHAT_ADDED_IN_OFFICE"));
  });
  if (assetLocks) {
    const locksPanel = () => page.locator(".courseware-asset-locks");
    const readLocks = async () => {
      await load().click(); await expect(load()).toBeEnabled({ timeout: 120_000 });
      await locksPanel().locator("summary").click();
      await locksPanel().getByRole("button", { name: /Read saved page images|读取已保存页的图片/ }).click();
      await expect(locksPanel().getByRole("checkbox")).toHaveCount(1, { timeout: 120_000 });
      return locksPanel().getByRole("checkbox");
    };
    const readPersisted = async () => {
      const result = await runFile("python3", ["-c", `import json,sqlite3,sys
db=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
rows=[json.loads(r[0]) for r in db.execute('SELECT value_json FROM kv WHERE ns=?',('coursewareAssetLocks.v1',))]
assert len(rows)==1,len(rows)
print(json.dumps(rows[0]))`, join(temp, "data/pi.sqlite")]);
      return JSON.parse(result.stdout);
    };
    let locked;
    await step("Saved-page sidebar explicitly locks an inspected image without changing PPTX or teaching", async () => {
      await goToPage(1); const before = (await invoke("pptEditorTeachingOpen", { sessionId })).project;
      const checkbox = await readLocks(); await expect(checkbox).toBeEnabled(); await expect(checkbox).not.toBeChecked();
      await checkbox.click(); await expect(checkbox).toBeChecked({ timeout: 120_000 }); await expect(checkbox).toBeEnabled({ timeout: 120_000 });
      locked = await readPersisted(); assert.equal(locked.images.length, 1);
      assert.equal(locked.images[0].pageId, before.pages[1].pageId); assert.equal(locked.images[0].sourceSha256, report.savedSha256);
      assert.equal(locked.images[0].image.zIndex, 1); assert.match(locked.images[0].image.assetSha256, /^[a-f0-9]{64}$/);
      assert.deepEqual((await invoke("pptEditorTeachingOpen", { sessionId })).project, before);
      assert.equal(hash(await readFile(file)), report.savedSha256);
      await page.screenshot({ path: join(out, "image-locked.png") });
    });
    await step("Full Desktop restart restores the exact saved image lock in the current page sidebar", async () => {
      await stop(); await start(); await goToPage(1);
      const checkbox = await readLocks(); await expect(checkbox).toBeChecked();
      assert.deepEqual(await readPersisted(), locked); assert.equal(hash(await readFile(file)), report.savedSha256);
      await page.screenshot({ path: join(out, "image-lock-reopened.png") });
    });
    await step("Explicit image unlock persists a new revision and retains the saved source", async () => {
      const checkbox = locksPanel().getByRole("checkbox"); await checkbox.click();
      await expect(checkbox).not.toBeChecked({ timeout: 120_000 }); await expect(checkbox).toBeEnabled({ timeout: 120_000 });
      const unlocked = await readPersisted(); assert.notEqual(unlocked.revision, locked.revision); assert.deepEqual(unlocked.images, []);
      assert.equal(hash(await readFile(file)), report.savedSha256);
      report.assetLocks = { locked, unlocked, actualUi: true, actualMainHost: true, fullRestart: true, sourceUnchanged: true };
    });
  }
  if (redo) {
    const identity = async (sha256) => {
      const result = await runFile("python3", ["-c", `import json,sqlite3,sys
db=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
values=[json.loads(r[0]) for r in db.execute('SELECT value_json FROM kv WHERE ns=?',('coursewareIdentities.v1',))]
matches=[v for v in values if v['sourceSha256']==sys.argv[2]]
assert len(matches)==1,len(matches)
print(json.dumps(matches[0]))`, join(temp, "data/pi.sqlite"), sha256]);
      return JSON.parse(result.stdout);
    };
    if (adoptRedo) await step("Saved-page teaching fixtures retain speech, pauses, confirmed peers and a peer lock", async () => {
      for (let index = 0; index < 3; index++) {
        await goToPage(index);
        let view = await invoke("pptEditorTeachingOpen", { sessionId });
        const target = redoAttention && (styleBatch || index < 2) ? (await identity(view.project.source.sha256)).pages[index].objects
          .find(object => ["text", "shape", "image"].includes(object.type)) : null;
        if (redoAttention && (styleBatch || index < 2)) assert(target, "Fixture requires a supported saved effect target");
        const visualCues = target ? [
          { id: `highlight-${index}`, atMs: 0, endMs: 800, effect: { type: "highlight", elementIds: [target.logicalId], color: "#336699" } },
          { id: `spotlight-${index}`, atMs: 800, endMs: 1900, effect: { type: "spotlight", elementId: target.logicalId, dimOpacity: 0.5 } },
        ] : undefined;
        view = await invoke("pptEditorTeachingWrite", { viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision,
          actions: [{ id: `redo-speech-${index}`, type: "speech", text: `Good! Page ${index + 1}.`, pauseAfterMs: 4000 }] });
        if (redoAttention) view = await attentionFixture.adoptAudio(invoke, view, sessionId);
        view = await invoke("pptEditorTeachingConfirm", { viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision });
        if (visualCues) {
          const actions = structuredClone(view.project.pages[index].actions);
          actions[0].visualCues = visualCues;
          view = await invoke("pptEditorTeachingWrite", { viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision, actions });
          view = await invoke("pptEditorTeachingConfirm", { viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision });
        }
        if (index === 1) await invoke("pptEditorTeachingLock", { viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision, locked: true });
      }
      if (redoAttention) { report.redoAudio = attentionFixture.result(); assert.equal(report.redoAudio.requests, 3); }
      await goToPage(0);
    });
    const before = (await invoke("pptEditorTeachingOpen", { sessionId })).project;
    let candidateId, outputSha256;
    const visualPanel = page.locator(".courseware-source-visuals");
    const approveVisuals = async () => {
      await visualPanel.getByRole("button", { name: /Prepare current page visuals|准备当前页底图/ }).click();
      await expect(visualPanel.locator("img")).toHaveCount(2, { timeout: 120_000 });
      const approve = visualPanel.getByRole("button", { name: /Approve this background|确认使用此背景/ });
      await expect(approve).toBeDisabled();
      await visualPanel.getByRole("checkbox").check();
      await approve.click();
      await expect(visualPanel.getByRole("status")).toBeVisible({ timeout: 30_000 });
    };
    const unchanged = async () => {
      assert.equal(hash(await readFile(file)), report.savedSha256);
      assert.deepEqual((await invoke("pptEditorTeachingOpen", { sessionId })).project, before);
    };
    if (styleBatch) await step("Batch Chat proposal is unavailable before actual representative and scope approval", async () => {
      await send("CHAT_NATIVE_STYLE_BATCH UNAPPROVED 请将风格应用到课件。");
      await expect(page.getByText("CHAT_NATIVE_STYLE_BATCH_UNAVAILABLE", { exact: true })).toBeVisible({ timeout: 120_000 });
      assert.equal(sceneRequests, 0); await unchanged();
    });
    await step("Main Chat cannot generate a rebuilt page before explicit current-page visual approval", async () => {
      await send("CHAT_NATIVE_REDO UNAPPROVED 请重做当前页。");
      await expect(page.getByText("CHAT_NATIVE_REDO_UNAVAILABLE", { exact: true })).toBeVisible({ timeout: 120_000 });
      assert.equal(sceneRequests, 0);
      await unchanged();
    });
    await step("Reviewed native images reach the current Chat vision model, compiler and actual Host candidate staging", async () => {
      await approveVisuals();
      await page.screenshot({ path: join(out, "chat-redo-approved-visuals.png") });
      await send("CHAT_NATIVE_REDO 请重做当前页，保留可编辑文字，添加蓝色装饰。");
      const reply = page.getByText(/^CHAT_NATIVE_REDO_DONE [\w.-]+ [a-f0-9]{64}$/, { exact: true });
      await expect(reply).toBeVisible({ timeout: 240_000 });
      [, candidateId, outputSha256] = (await reply.innerText()).split(" ");
      const archive = join(temp, "data/courseware-candidates", `${outputSha256}.pptx`);
      assert.equal(hash(await readFile(archive)), outputSha256);
      assert.notEqual(outputSha256, report.savedSha256);
      await copyFile(archive, join(out, "chat-redo-candidate.pptx"));
      await copyFile(file, join(out, "chat-redo-source.pptx"));
      assert.equal(sceneRequests, 1);
      await unchanged();
      const review = await invoke("pptEditorPptxCandidateReview", { sessionId, candidateId });
      assert.equal(review.kind, "page-pptx"); assert.equal(review.lineageVerified, true); assert.equal(review.stale, false);
      await writeFile(join(out, "chat-redo-review.json"), JSON.stringify(review, null, 2));
    });
    if (styleReview) await step("Actual generated representative renders in the existing sidebar and confirms only the explicitly selected unlocked pages", async () => {
      assert(before.pages.length >= 3);
      const panel = page.locator(".courseware-teaching");
      await panel.getByLabel(/Candidate ID|候选稿 ID/).fill(candidateId);
      await panel.getByRole("button", { name: /Review candidate|审阅候选稿/ }).click();
      const style = panel.getByRole("region", { name: /Use this page as a style reference|将此页用作风格参考/ });
      await style.getByRole("button", { name: /Review style and page range|审核风格与应用范围/ }).click();
      await expect(style.getByRole("img")).toBeVisible({ timeout: 120_000 });
      const approve = style.getByRole("button", { name: /Confirm style and pages|确认风格与页面/ });
      await expect(approve).toBeDisabled();
      const choices = style.getByRole("group").getByRole("checkbox");
      await expect(choices.nth(0)).toBeChecked(); await expect(choices.nth(0)).toBeDisabled();
      await expect(choices.nth(1)).toBeDisabled(); await choices.nth(2).check();
      if (styleBatch) for (let index = 3; index < before.pages.length; index++) if (!before.pages[index].locked) await choices.nth(index).check();
      await style.getByRole("checkbox", { name: /I reviewed this representative|我已检查代表页/ }).check();
      await approve.click(); await expect(style.getByRole("status")).toContainText(/Confirmed pages: 1, 3|已确认页面：1, 3/);
      await page.screenshot({ path: join(out, "chat-style-scope-confirmed.png") });
      await writeFile(join(out, "style-scope-state.json"), JSON.stringify({ candidateId, outputSha256,
        targetPageIds: styleBatch ? before.pages.filter(page => !page.locked).map(page => page.pageId) : [before.pages[0].pageId, before.pages[2].pageId], lockedPageId: before.pages[1].pageId,
        renderedActualCandidate: true, confirmed: true, sourceUnchanged: true, batchGenerated: false }, null, 2));
      assert.equal(sceneRequests, 1);
      await unchanged();
      await panel.getByRole("button", { name: /Close candidate review|关闭候选审阅/ }).click();
    });
    if (styleBatch) {
      const identity = async (sha256) => {
        const result = await runFile("python3", ["-c", `import json,sqlite3,sys
db=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
values=[json.loads(r[0]) for r in db.execute('SELECT value_json FROM kv WHERE ns=?',('coursewareIdentities.v1',))]
matches=[v for v in values if v['sourceSha256']==sys.argv[2]]
assert len(matches)==1,len(matches)
print(json.dumps(matches[0]))`, join(temp, "data/pi.sqlite"), sha256]);
        return JSON.parse(result.stdout);
      };
      const targetPageIds = before.pages.filter(page => !page.locked).map(page => page.pageId);
      const beforeIdentity = await identity(before.source.sha256);
      await step("Cancelling the owning Chat aborts a real batch completion and preserves original teaching", async () => {
        const count = cancelledCompletions; holdNextBatchScene = true;
        await send("CHAT_NATIVE_STYLE_BATCH 请使用已确认的风格和范围生成候选。");
        await expect.poll(() => heldCompletions.size, { timeout: 180_000 }).toBe(1);
        await invoke("agentAbort", { sessionId });
        await expect.poll(() => cancelledCompletions, { timeout: 15_000 }).toBe(count + 1);
        await expect.poll(async () => { try { return (await invoke("pptEditorTeachingOpen", { sessionId })).project; } catch { return null; } }, { timeout: 30_000 }).toEqual(before);
        await unchanged();
      });
      let batchId, batchHash, adopted, batchReview;
      await step("Actual main Chat uses confirmed scope, current-stage native rendering and verified batch staging", async () => {
        await send("CHAT_NATIVE_STYLE_BATCH 请按刚才确认的页面范围生成风格候选。");
        const reply = page.getByText(/^CHAT_NATIVE_STYLE_BATCH_DONE [\w.-]+ [a-f0-9]{64}$/, { exact: true });
        await expect(reply).toBeVisible({ timeout: 360_000 });
        [, batchId, batchHash] = (await reply.innerText()).split(" ");
        assert.notEqual(batchHash, outputSha256);
        const archive = join(temp, "data/courseware-candidates", `${batchHash}.pptx`);
        assert.equal(hash(await readFile(archive)), batchHash); await copyFile(archive, join(out, "chat-batch-candidate.pptx"));
        await unchanged();
        const review = await invoke("pptEditorPptxCandidateReview", { sessionId, candidateId: batchId });
        assert.equal(review.kind, "page-style-batch"); assert.equal(review.lineageVerified, true);
        assert.deepEqual(review.targetPageIds, targetPageIds);
        assert.deepEqual(review.targetPages, before.pages.flatMap((p, index) => p.locked ? [] : [{ pageId: p.pageId, pageNumber: index + 1 }]));
        batchReview = review;
        await writeFile(join(out, "batch-review.json"), JSON.stringify(review, null, 2));
      });
      await step("Existing sidebar lists every batch target and previews actual editable output read-only", async () => {
        const panel = page.locator(".courseware-teaching");
        await panel.getByLabel(/Candidate ID|候选稿 ID/).fill(batchId);
        await panel.getByRole("button", { name: /Review candidate|审阅候选稿/ }).click();
        await expect(panel.locator(".courseware-source-review > ul > li")).toHaveCount(targetPageIds.length);
        const adopt = panel.getByRole("button", { name: /Adopt and reopen|采纳并重新打开/ });
        await expect(adopt).toBeDisabled();
        const priorPages = new Set(app.context().pages()), opening = app.waitForEvent("window");
        await panel.getByRole("button", { name: /Open read-only preview|打开只读预览/ }).click();
        const preview = await opening;
        await expect.poll(async () => {
          for (const target of app.context().pages().filter(p => !priorPages.has(p) && p.url().startsWith("deckwise-editor:"))) for (const frame of target.frames()) {
            const text = await frame.evaluate(() => {
              const e = window.Asc?.editor; if (!e?.isDocumentLoadComplete) return "";
              return e.WordControl.m_oLogicDocument.Slides.flatMap(slide => slide.cSld.spTree.map(shape => shape.getDocContent?.()?.GetText({}) ?? "")).join("\n");
            }).catch(() => "");
            if (text.includes("CHAT_REDO_EDITABLE") && text.includes("CHAT_BATCH_EDITABLE")) return true;
          }
          return false;
        }, { timeout: 120_000 }).toBe(true);
        await preview.screenshot({ path: join(out, "chat-batch-readonly.png") }); await preview.close(); await unchanged();
        await page.screenshot({ path: join(out, "chat-batch-target-review.png") });
      });
      await step("Explicit batch adoption preserves peer locks, teaching and IDs and reopens writable primary Office", async () => {
        const panel = page.locator(".courseware-teaching");
        await panel.getByRole("checkbox", { name: /I reviewed this candidate|我已检查候选/ }).check();
        const adopt = panel.getByRole("button", { name: /Adopt and reopen|采纳并重新打开/ });
        if (redoAttention) {
          assert.equal(before.pages.length, 3, "Attention fixture has two target pages and one locked peer");
          assert.deepEqual(batchReview.effectTargets.map(target => target.pageIndex), [0, 2]);
          const selectors = panel.locator(".courseware-source-review select");
          await expect(selectors).toHaveCount(2); await expect(adopt).toBeDisabled();
          report.batchAttention = [];
          for (const [index, target] of batchReview.effectTargets.entries()) {
            const selector = selectors.nth(index);
            await expect(selector).toHaveValue("");
            const choice = await selector.locator('option:not([value=""])').first().getAttribute("value");
            assert(choice);
            await selector.selectOption(choice);
            await expect(adopt).toBeDisabled();
            await expect(panel.getByRole("checkbox", { name: /I reviewed this candidate|我已检查候选/ })).not.toBeChecked();
            report.batchAttention.push({ pageIndex: target.pageIndex, oldTarget: target.objectId,
              targetIndex: Number(choice), explicitObjectAndTimingConfirmation: true });
          }
          await panel.getByRole("checkbox", { name: /I reviewed every object association|我已逐项核对对象关联/ }).check();
          await expect(adopt).toBeDisabled();
          await panel.getByRole("checkbox", { name: /I reviewed this candidate|我已检查候选/ }).check();
          await page.screenshot({ path: join(out, "chat-batch-attention-review.png") });
        }
        await expect(adopt).toBeEnabled(); await adopt.click();
        await expect(adopt).toHaveCount(0, { timeout: 180_000 }); await waitForOffice();
        assert.equal(hash(await readFile(file)), batchHash); assert.equal((await invoke("pptEditorGetContext")).readOnly, false);
        const text = await nativeText(); assert(text.includes("CHAT_REDO_EDITABLE")); assert.equal((text.match(/CHAT_BATCH_EDITABLE/g) ?? []).length, targetPageIds.length - 1);
        adopted = (await invoke("pptEditorTeachingOpen", { sessionId })).project;
        const afterIdentity = await identity(batchHash), oldIds = new Set(beforeIdentity.pages.flatMap(p => p.objects.map(o => o.logicalId)));
        const expectedPages = structuredClone(before.pages);
        for (const entry of expectedPages) if (targetPageIds.includes(entry.pageId)) entry.reviewState = "review";
        if (redoAttention) for (const association of report.batchAttention) {
          const target = afterIdentity.pages[association.pageIndex].objects[association.targetIndex - 1].logicalId;
          assert(!oldIds.has(target)); association.newTarget = target;
          const cues = expectedPages[association.pageIndex].actions[0].visualCues;
          assert.deepEqual(cues[0].effect.elementIds, [association.oldTarget]);
          cues[0].effect.elementIds = [target]; cues[1].effect.elementId = target;
        }
        assert.deepEqual(adopted.pages, expectedPages);
        for (let i = 0; i < beforeIdentity.pages.length; i++) {
          assert.equal(afterIdentity.pages[i].logicalId, beforeIdentity.pages[i].logicalId);
          if (targetPageIds.includes(before.pages[i].pageId)) {
            assert(afterIdentity.pages[i].objects.length); for (const obj of afterIdentity.pages[i].objects) assert(!oldIds.has(obj.logicalId));
          } else assert.deepEqual(afterIdentity.pages[i], beforeIdentity.pages[i]);
        }
        const backup = (await (await import("node:fs/promises")).readdir(workspace)).find(name => name.startsWith(".lesson.pptx.adoption-"));
        assert(backup); assert.equal(hash(await readFile(join(workspace, backup, "original.pptx"))), report.savedSha256);
        await writeFile(join(out, "batch-adoption-state.json"), JSON.stringify({ before, adopted, beforeIdentity, afterIdentity, targetPageIds }, null, 2));
        await copyFile(file, join(out, "chat-batch-adopted.pptx"));
      });
      await step("Full Desktop restart restores batch content and teaching and revokes old in-memory style approval", async () => {
        await stop(); await start(); assert.equal(hash(await readFile(file)), batchHash);
        assert.deepEqual((await invoke("pptEditorTeachingOpen", { sessionId })).project, adopted);
        assert((await nativeText()).includes("CHAT_BATCH_EDITABLE"));
        const count = await page.getByText("CHAT_NATIVE_STYLE_BATCH_UNAVAILABLE", { exact: true }).count();
        const scenes = sceneRequests; await send("CHAT_NATIVE_STYLE_BATCH UNAPPROVED 请再次应用风格。");
        await expect(page.getByText("CHAT_NATIVE_STYLE_BATCH_UNAVAILABLE", { exact: true })).toHaveCount(count + 1, { timeout: 120_000 });
        assert.equal(sceneRequests, scenes); assert.equal(hash(await readFile(file)), batchHash);
        report.batchAdoption = { candidateId: batchId, outputSha256: batchHash, targetPageIds, applied: true, restartVerified: true, primaryOfficeWritable: true, oldScopeRevoked: true };
      });
      if (redoAttention) {
        for (const association of report.batchAttention) {
          await goToPage(association.pageIndex);
          const view = await invoke("pptEditorTeachingOpen", { sessionId });
          await invoke("pptEditorTeachingConfirm", { viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision });
        }
        await goToPage(0);
        const confirmed = (await invoke("pptEditorTeachingOpen", { sessionId })).project;
        await load().click(); await expect(load()).toBeEnabled({ timeout: 120_000 });
        const peerTarget = before.pages[1].actions[0].visualCues[0].effect.elementIds[0];
        report.batchPeerAttention = { pageIndex: 1, oldTarget: peerTarget, newTarget: peerTarget };
        await testAdoptedPlayback({ app, page, expect, project: confirmed, out, step, report,
          exercisePlayer: async player => {
            for (const association of [report.batchAttention[0], report.batchPeerAttention, report.batchAttention[1]]) {
              await expect(player.getByText(`${association.pageIndex + 1} / 3`, { exact: true })).toBeVisible({ timeout: 30_000 });
              await testRebuiltAttentionPlayback({ player, expect, report, out, association });
            }
          } });
        assert.deepEqual(attentionFixture.result(), report.redoAudio, "Batch adoption/playback must not regenerate speech");
      }
    } else {
    await step("Existing sidebar opens the generated copy in actual read-only Office and rejects it without source changes", async () => {
      const panel = page.locator(".courseware-teaching");
      await panel.getByLabel(/Candidate ID|候选稿 ID/).fill(candidateId);
      await panel.getByRole("button", { name: /Review candidate|审阅候选稿/ }).click();
      await expect(panel.getByText(/PPTX candidate review|PPTX 候选稿审阅/, { exact: true })).toBeVisible();
      const priorPages = new Set(app.context().pages());
      const windowOpened = app.waitForEvent("window");
      await panel.getByRole("button", { name: /Open read-only preview|打开只读预览/ }).click();
      const previewWindow = await windowOpened;
      await expect.poll(async () => {
        for (const target of app.context().pages().filter(target => !priorPages.has(target) && target.url().startsWith("deckwise-editor:"))) {
          for (const frame of target.frames()) {
            const text = await frame.evaluate(() => {
              const editor = window.Asc?.editor;
              if (!editor?.isDocumentLoadComplete) return "";
              return editor.WordControl.m_oLogicDocument.Slides.flatMap(slide => slide.cSld.spTree.map(shape => shape.getDocContent?.()?.GetText({}) ?? "")).join("\n");
            }).catch(() => "");
            if (text.includes("CHAT_REDO_EDITABLE")) return true;
          }
        }
        return false;
      }, { timeout: 120_000 }).toBe(true);
      await previewWindow.screenshot({ path: join(out, "chat-redo-readonly-preview.png") });
      await previewWindow.keyboard.press("Control+s");
      assert.equal(hash(await readFile(join(temp, "data/courseware-candidates", `${outputSha256}.pptx`))), outputSha256);
      await previewWindow.close();
      const adopt = panel.getByRole("button", { name: /Adopt and reopen|采纳并重新打开/ });
      await expect(adopt).toBeDisabled();
      await panel.getByRole("checkbox", { name: /I reviewed this candidate|我已检查候选/ }).check();
      if (redoAttention) await expect(adopt).toBeDisabled();
      else await expect(adopt).toBeEnabled();
      await panel.getByRole("button", { name: /Reject candidate|拒绝候选/ }).click();
      await expect(panel.getByRole("button", { name: /Reject candidate|拒绝候选/ })).toHaveCount(0, { timeout: 30_000 });
      await unchanged();
      assert((await nativeText()).includes("CHAT_ADDED_IN_OFFICE"));
    });
    await step("Stopping main Chat aborts its in-flight vision request without changing the source or teaching", async () => {
      await approveVisuals();
      const cancelledBefore = cancelledCompletions;
      await send("CHAT_NATIVE_REDO CANCEL_REDO 请重做当前页。");
      await expect.poll(() => heldCompletions.size, { timeout: 120_000 }).toBe(1);
      await invoke("agentAbort", { sessionId });
      await expect.poll(() => cancelledCompletions, { timeout: 15_000 }).toBe(cancelledBefore + 1);
      await expect.poll(async () => {
        try { return (await invoke("pptEditorTeachingOpen", { sessionId })).project; } catch { return null; }
      }, { timeout: 30_000 }).toEqual(before);
      await unchanged();
      report.redo = { candidateId, outputSha256, sceneRequests, applied: false, reviewState: "rejected",
        previewReadOnly: true, currentChatModel: true, approvedNativeImages: true, cancelledModelRequest: true };
    });
    if (adoptRedo) {
      let adopted;
      const beforeIdentity = await identity(before.source.sha256);
      await step("Explicit reviewed redo adoption installs the copy, preserves teaching and reopens the primary Office", async () => {
        await approveVisuals();
        const replies = page.getByText(/^CHAT_NATIVE_REDO_DONE [\w.-]+ [a-f0-9]{64}$/, { exact: true });
        const count = await replies.count();
        await send("CHAT_NATIVE_REDO 请重做当前页并提供审核候选。");
        await expect(replies).toHaveCount(count + 1, { timeout: 240_000 });
        [, candidateId, outputSha256] = (await replies.last().innerText()).split(" ");
        await unchanged();
        await copyFile(join(temp, "data/courseware-candidates", `${outputSha256}.pptx`), join(out, "chat-redo-adopted.pptx"));
        const panel = page.locator(".courseware-teaching");
        await panel.getByLabel(/Candidate ID|候选稿 ID/).fill(candidateId);
        await panel.getByRole("button", { name: /Review candidate|审阅候选稿/ }).click();
        const adopt = panel.getByRole("button", { name: /Adopt and reopen|采纳并重新打开/ });
        await expect(adopt).toBeDisabled();
        await panel.getByRole("checkbox", { name: /I reviewed this candidate|我已检查候选/ }).check();
        if (redoAttention) {
          await expect(adopt).toBeDisabled();
          const selectors = panel.locator(".courseware-source-review select");
          await expect(selectors).toHaveCount(1);
          await expect(selectors).toHaveValue("");
          const choice = await selectors.locator('option:not([value=""])').first().getAttribute("value");
          assert(choice);
          await selectors.selectOption(choice);
          await expect(panel.getByRole("checkbox", { name: /I reviewed this candidate|我已检查候选/ })).not.toBeChecked();
          await expect(adopt).toBeDisabled();
          await panel.getByRole("checkbox", { name: /I reviewed every object association|我已逐项核对对象关联/ }).check();
          await expect(adopt).toBeDisabled();
          await panel.getByRole("checkbox", { name: /I reviewed this candidate|我已检查候选/ }).check();
          report.redoAttention = { pageIndex: 0, oldTarget: before.pages[0].actions[0].visualCues[0].effect.elementIds[0],
            targetIndex: Number(choice), explicitObjectAndTimingConfirmation: true };
          await page.screenshot({ path: join(out, "chat-redo-attention-review.png") });
        }
        await expect(adopt).toBeEnabled(); await adopt.click();
        await expect(adopt).toHaveCount(0, { timeout: 180_000 });
        await waitForOffice(); await expect(load()).toBeEnabled({ timeout: 120_000 });
        assert.equal(hash(await readFile(file)), outputSha256);
        assert((await nativeText()).includes("CHAT_REDO_EDITABLE"));
        assert(!(await nativeText()).includes("CHAT_ADDED_IN_OFFICE"));
        assert.equal((await invoke("pptEditorGetContext")).readOnly, false);
        adopted = (await invoke("pptEditorTeachingOpen", { sessionId })).project;
        assert.equal(adopted.source.sha256, outputSha256);
        assert.notEqual(adopted.teachingRevision, before.teachingRevision);
        const afterIdentity = await identity(outputSha256);
        const expectedPages = structuredClone(before.pages);
        expectedPages[0].reviewState = "review";
        if (redoAttention) {
          const target = afterIdentity.pages[0].objects[report.redoAttention.targetIndex - 1].logicalId;
          expectedPages[0].actions[0].visualCues[0].effect.elementIds = [target];
          expectedPages[0].actions[0].visualCues[1].effect.elementId = target;
          report.redoAttention.newTarget = target;
          assert.notEqual(target, report.redoAttention.oldTarget);
        }
        assert.deepEqual(adopted.pages, expectedPages);
        assert.notEqual(afterIdentity.mappingRevision, beforeIdentity.mappingRevision);
        assert.deepEqual(afterIdentity.pages.slice(1), beforeIdentity.pages.slice(1));
        assert.equal(afterIdentity.pages[0].logicalId, beforeIdentity.pages[0].logicalId);
        const oldIds = new Set(beforeIdentity.pages.flatMap(entry => entry.objects.map(object => object.logicalId)));
        assert(afterIdentity.pages[0].objects.length > 0);
        for (const object of afterIdentity.pages[0].objects) assert(!oldIds.has(object.logicalId));
        const backups = await (await import("node:fs/promises")).readdir(workspace);
        const backup = backups.find(name => name.startsWith(".lesson.pptx.adoption-"));
        assert(backup); assert.equal(hash(await readFile(join(workspace, backup, "original.pptx"))), report.savedSha256);
        await writeFile(join(out, "redo-adoption-state.json"), JSON.stringify({ before, adopted, beforeIdentity, afterIdentity }, null, 2));
        await page.screenshot({ path: join(out, "chat-redo-adopted.png") });
      });
      await step("Full Desktop restart restores the adopted page, mapping and teaching; main Chat reads the new native text", async () => {
        await stop(); await start();
        assert.equal(hash(await readFile(file)), outputSha256);
        assert((await nativeText()).includes("CHAT_REDO_EDITABLE"));
        assert.deepEqual((await invoke("pptEditorTeachingOpen", { sessionId })).project, adopted);
        const replies = page.getByText("CHAT_NATIVE_READ_DONE", { exact: true }), count = await replies.count();
        await send("CHAT_NATIVE_READ 读取采纳后 PPT 的文字。");
        await expect(replies).toHaveCount(count + 1, { timeout: 90_000 });
        assert(plain(requests.at(-1)).includes("CHAT_REDO_EDITABLE"));
        const expected = JSON.parse(await readFile(join(out, "redo-adoption-state.json"), "utf8"));
        assert.deepEqual(await identity(outputSha256), expected.afterIdentity);
        report.redoAdoption = { candidateId, outputSha256, applied: true, restartVerified: true,
          primaryOfficeWritable: true, teachingAndPausesPreserved: true, targetObjectIdsReplaced: true,
          peerObjectIdsPreserved: true, backupSha256: report.savedSha256 };
      });
      if (redoAttention) {
        await goToPage(0);
        let view = await invoke("pptEditorTeachingOpen", { sessionId });
        view = await invoke("pptEditorTeachingConfirm", { viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision });
        await load().click(); await expect(load()).toBeEnabled({ timeout: 120_000 });
        await testAdoptedPlayback({ app, page, expect, project: view.project, out, step, report,
          exercisePlayer: player => testRebuiltAttentionPlayback({ player, expect, report, out }) });
        assert.deepEqual(attentionFixture.result(), report.redoAudio, "Adoption/playback must not regenerate speech");
      }
    }
    }
  }
  if (formatting) {
    const select = async () => {
      await goToPage(1);
      await sdk.evaluate(() => {
        const doc = window.Asc.editor.WordControl.m_oLogicDocument;
        const shape = doc.Slides[1].cSld.spTree.find(shape => shape.getDocContent?.()?.GetText({}).trim());
        if (!shape) throw new Error("Formatting fixture needs a plain text box on page 2");
        shape.Set_CurrentElement(); shape.getDocContent().SelectAll(); doc.Document_UpdateSelectionState();
      });
      const context = await invoke("pptEditorGetContext");
      assert(context.selectedText.includes("B33 PAGE 2"));
      for (const [, name] of formats) assert(context.capabilities.some(capability => capability.name === name));
      return context;
    };
    const inventory = () => sdk.evaluate(() => window.Asc.editor.WordControl.m_oLogicDocument.Slides.map(slide =>
      slide.cSld.spTree.map(shape => ({ text: shape.getDocContent?.()?.GetText({}) ?? "", type: shape.getObjectType(),
        geometry: Object.fromEntries(["offX", "offY", "extX", "extY", "rot", "flipH", "flipV"].map(key => [key, shape.spPr?.xfrm?.[key]])) }))));
    const properties = () => sdk.evaluate(() => {
      const api = window.Asc.editor, doc = api.WordControl.m_oLogicDocument;
      const fill = doc.GetCalculatedTextPr().Unifill;
      const rgba = fill?.fill?.color?.RGBA;
      return { fontSizePt: api.get_TextProps().get_TextPr().get_FontSize(),
        fontFamily: api.get_TextProps().get_TextPr().get_FontFamily().get_Name(),
        rgba: rgba ? { R: rgba.R, G: rgba.G, B: rgba.B, A: rgba.A } : null };
    });
    const initialContext = await select();
    let expectedFamily;
    if (fontFamily) {
      const initialFamily = (await properties()).fontFamily;
      const capability = initialContext.capabilities.find(item => item.name === "set_slide_font_family");
      expectedFamily = capability.inputSchema.properties.fontFamily.enum.find(name => name !== initialFamily);
      assert(expectedFamily, "Real Office must advertise a different already-loaded font");
      formats[0][2].fontFamily = expectedFamily;
    }
    const before = await inventory();
    await copyFile(file, join(out, "format-baseline.pptx"));
    for (const [marker, command, input] of formats) await step(`Main Chat ${command} changes real Office and leaves PPTX unsaved`, async () => {
      await select();
      await send(`CHAT_NATIVE_FORMAT_${marker} 修改当前选中内容：${JSON.stringify(input)}。不要保存。`);
      await expect(page.getByText(`CHAT_NATIVE_FORMAT_${marker}_DONE`, { exact: true })).toBeVisible({ timeout: 90_000 });
      assert.equal(hash(await readFile(file)), report.savedSha256);
      const actual = await properties();
      if (fontFamily) assert.equal(actual.fontFamily, expectedFamily);
      if (marker === "SIZE" || marker === "COLOR") assert.equal(actual.fontSizePt, 24.5);
      if (marker === "COLOR") assert.deepEqual(actual.rgba, { R: 51, G: 102, B: 153, A: 255 });
      const expected = structuredClone(before);
      if (marker === "POSITION") {
        const target = expected[1].find(shape => shape.text.includes("B33 PAGE 2"));
        target.geometry.offX = 25; target.geometry.offY = 35;
      }
      assert.deepEqual(await inventory(), expected, "No peer text, geometry or slide may change");
    });
    await step("Explicit save and full Desktop restart preserve Chat font, RGB, position and peer content", async () => {
      const expected = await inventory();
      await invoke("pptEditorSave");
      await expect(load()).toBeEnabled({ timeout: 240_000 });
      await assert.rejects(invoke("pptEditorTeachingOpen", { sessionId }), /COURSEWARE_CONFLICT.*reconcile/);
      await button(/Review saved PPTX changes|审核已保存的 PPTX 变更/).click();
      const review = page.locator(".courseware-source-review");
      await expect(review).toBeVisible({ timeout: 120_000 });
      const choices = review.locator("select");
      await expect(choices).toHaveCount(expected.length);
      for (let index = 0; index < expected.length; index++) {
        await expect(choices.nth(index)).toHaveValue("");
        await choices.nth(index).selectOption(String(index));
      }
      const confirm = review.getByRole("button", { name: /Use these associations|采用这些关联/ });
      await expect(confirm).toBeDisabled();
      await review.locator("input[type=checkbox]").check();
      await confirm.click();
      await expect(review).toHaveCount(0, { timeout: 120_000 });
      report.savedSha256 = hash(await readFile(file));
      await copyFile(file, join(out, "format-saved.pptx"));
      await stop(); await start(); await select();
      assert.deepEqual(await inventory(), expected);
      const actual = await properties();
      assert.equal(actual.fontSizePt, 24.5);
      assert.deepEqual(actual.rgba, { R: 51, G: 102, B: 153, A: 255 });
      if (fontFamily) assert.equal(actual.fontFamily, expectedFamily);
      report.formatting = { operations: formats.map(([, command, input]) => ({ command, input })),
        nativeSelectionSetup: true, injectedNativeTools: false, explicitSave: true, explicitSourceAssociation: true,
        completeRestart: true, peerContentPreserved: true };
      await page.screenshot({ path: join(out, "chat-format-reopened.png") });
      await goToPage(0);
    });
  }
  if (objectAnimation) {
    const effects = () => sdk.evaluate(() => {
      const doc = window.Asc.editor.WordControl.m_oLogicDocument;
      return doc.Slides.map(slide => (slide.timing?.getAllAnimEffects() ?? []).map(effect => ({
        targetIndex: slide.cSld.spTree.findIndex(shape => shape.Get_Id() === effect.getObjectId()),
        presetClass: effect.cTn.presetClass, preset: effect.cTn.presetID, subtype: effect.cTn.presetSubtype,
        nodeType: effect.cTn.nodeType, duration: effect.asc_getDuration(), delay: effect.asc_getDelay(),
      })));
    });
    const objects = () => sdk.evaluate(() => window.Asc.editor.WordControl.m_oLogicDocument.Slides.map(slide =>
      slide.cSld.spTree.map(shape => ({ text: shape.getDocContent?.()?.GetText?.({}) ?? "", image: !!shape.blipFill,
        geometry: Object.fromEntries(["offX", "offY", "extX", "extY", "rot", "flipH", "flipV"].map(key => [key, shape.spPr?.xfrm?.[key] ?? null])) }))));
    const select = kind => sdk.evaluate(kind => {
      const api = window.Asc.editor, doc = api.WordControl.m_oLogicDocument, slide = doc.Slides[kind === "image" ? 1 : 0];
      const shape = slide.cSld.spTree.find(shape => {
        const x = shape.spPr?.xfrm;
        return !shape.group && shape.isPlaceholder?.() === false && shape.spPr?.geometry?.preset === "rect" &&
          x && !x.rot && !x.flipH && !x.flipV && (kind === "image" ? !!shape.blipFill : !shape.blipFill && !!shape.getDocContent?.());
      });
      if (!shape) throw new Error(`Animation fixture has no ordinary ${kind}`);
      shape.Set_CurrentElement(); doc.Document_UpdateSelectionState();
      return slide.cSld.spTree.indexOf(shape);
    }, kind);
    let expected, baselineObjects;
    await step("Main Chat appends appear to a selected native text object without saving or changing content", async () => {
      await goToPage(0); const targetIndex = await select("text");
      assert((await invoke("pptEditorGetContext")).capabilities.some(item => item.name === "add_slide_object_animation"));
      baselineObjects = await objects(); const before = await effects();
      await copyFile(file, join(out, "object-animation-baseline.pptx"));
      await send("CHAT_NATIVE_OBJECT_ANIMATION_APPEAR 给当前选中的文本框追加一个单击出现动画，不要保存。");
      await expect(page.getByText("CHAT_NATIVE_OBJECT_ANIMATION_APPEAR_DONE", { exact: true })).toBeVisible({ timeout: 90_000 });
      expected = await effects();
      assert.deepEqual(expected[1], before[1]); assert.deepEqual(expected[2], before[2]);
      assert.deepEqual(expected[0].slice(0, -1), before[0]);
      assert.equal(expected[0].length, before[0].length + 1);
      assert.equal(expected[0].at(-1).targetIndex, targetIndex); assert.equal(expected[0].at(-1).preset, 1);
      assert.equal(expected[0].at(-1).presetClass, 1); assert.equal(expected[0].at(-1).nodeType, 2);
      assert.deepEqual(await objects(), baselineObjects); assert.equal(hash(await readFile(file)), report.savedSha256);
    });
    await step("Main Chat appends native picture fade and retains every existing effect and peer", async () => {
      await goToPage(1); const targetIndex = await select("image"), before = expected;
      await send("CHAT_NATIVE_OBJECT_ANIMATION_FADE 给当前选中的图片追加一个单击淡入动画，保留已有动画，不要保存。");
      await expect(page.getByText("CHAT_NATIVE_OBJECT_ANIMATION_FADE_DONE", { exact: true })).toBeVisible({ timeout: 90_000 });
      expected = await effects();
      assert.deepEqual(expected[0], before[0]); assert.deepEqual(expected[2], before[2]);
      assert.deepEqual(expected[1].slice(0, -1), before[1]); assert.equal(expected[1].length, before[1].length + 1);
      assert.equal(expected[1].at(-1).targetIndex, targetIndex); assert.equal(expected[1].at(-1).preset, 10);
      assert.equal(expected[1].at(-1).presetClass, 1); assert.equal(expected[1].at(-1).nodeType, 2);
      assert.deepEqual(await objects(), baselineObjects); assert.equal(hash(await readFile(file)), report.savedSha256);
    });
    await step("Explicit native save and full restart retain native object animation targets and contents", async () => {
      await invoke("pptEditorSave"); await expect(load()).toBeEnabled({ timeout: 240_000 });
      report.savedSha256 = hash(await readFile(file));
      await copyFile(file, join(out, "object-animation-saved.pptx"));
      await stop(); await start(); await goToPage(1);
      assert.deepEqual(await effects(), expected); assert.deepEqual(await objects(), baselineObjects);
      report.objectAnimation = { textPage: 1, imagePage: 2, effects: expected, explicitSave: true, completeRestart: true, unchangedContent: true };
      await page.screenshot({ path: join(out, "chat-object-animation-reopened.png") });
    });
  }
  if (imageSize || imagePosition) {
    const capability = imagePosition ? "set_slide_image_position" : "set_slide_image_size";
    const artifact = imagePosition ? "image-position" : "image-size";
    const inventory = () => sdk.evaluate(() => window.Asc.editor.WordControl.m_oLogicDocument.Slides.map(slide =>
      slide.cSld.spTree.map(shape => ({ text: shape.getDocContent?.()?.GetAllText?.() ?? "", image: !!shape.blipFill,
        geometry: Object.fromEntries(["offX", "offY", "extX", "extY", "rot", "flipH", "flipV"].map(key => [key, shape.spPr?.xfrm?.[key] ?? null])) }))));
    const selectImage = () => sdk.evaluate(() => {
      const api = window.Asc.editor, doc = api.WordControl.m_oLogicDocument;
      const picture = doc.Slides[1].cSld.spTree.find(shape => {
        const xfrm = shape.spPr?.xfrm;
        return shape.blipFill && !shape.group && shape.isPlaceholder?.() === false &&
          shape.spPr?.geometry?.preset === "rect" && xfrm && !xfrm.rot && !xfrm.flipH && !xfrm.flipV &&
          shape.blipFill.srcRect == null && shape.blipFill.tile == null && shape.blipFill.transparent == null;
      });
      if (!picture) throw new Error("Native geometry fixture requires one ordinary picture on page two");
      picture.Set_CurrentElement(); doc.Document_UpdateSelectionState();
      return { index: doc.Slides[1].cSld.spTree.indexOf(picture), raster: picture.blipFill.RasterImageId };
    });
    let expected, target, expectedText;
    await step("Rotated and flipped native pictures withhold the requested image geometry capability", async () => {
      await goToPage(1);
      await sdk.evaluate(() => {
        const doc = window.Asc.editor.WordControl.m_oLogicDocument;
        const picture = doc.Slides[1].cSld.spTree.find(shape => shape.blipFill &&
          (shape.spPr?.xfrm?.rot || shape.spPr?.xfrm?.flipH || shape.spPr?.xfrm?.flipV));
        if (!picture) throw new Error("Geometry rejection fixture requires a rotated/flipped picture");
        picture.Set_CurrentElement(); doc.Document_UpdateSelectionState();
      });
      assert(!(await invoke("pptEditorGetContext")).capabilities.some(item => item.name === capability));
    });
    await step("Main Chat changes one native image geometry without saving or changing peer content", async () => {
      await goToPage(1); target = await selectImage();
      const context = await invoke("pptEditorGetContext");
      assert(context.capabilities.some(item => item.name === capability));
      const before = await inventory(); expected = structuredClone(before);
      expectedText = await nativeText();
      if (imagePosition) { expected[1][target.index].geometry.offX = 25.5; expected[1][target.index].geometry.offY = 35; }
      else { expected[1][target.index].geometry.extX = 80.5; expected[1][target.index].geometry.extY = 30; }
      await copyFile(file, join(out, `${artifact}-baseline.pptx`));
      await send(imagePosition ? "CHAT_NATIVE_IMAGE_POSITION 将当前图片移动到左25.5毫米、上35毫米，保持大小，不要保存。"
        : "CHAT_NATIVE_IMAGE_SIZE 将当前图片改为宽80.5毫米、高30毫米，不要保存。");
      await expect(page.getByText(imagePosition ? "CHAT_NATIVE_IMAGE_POSITION_DONE" : "CHAT_NATIVE_IMAGE_SIZE_DONE", { exact: true })).toBeVisible({ timeout: 90_000 });
      assert.deepEqual(await inventory(), expected);
      assert.equal(await nativeText(), expectedText);
      assert.equal((await selectImage()).raster, target.raster);
      assert.equal(hash(await readFile(file)), report.savedSha256);
    });
    await step("Explicit native save and complete Desktop restart retain image geometry and peer content", async () => {
      await invoke("pptEditorSave"); await expect(load()).toBeEnabled({ timeout: 240_000 });
      report.savedSha256 = hash(await readFile(file));
      await copyFile(file, join(out, `${artifact}-saved.pptx`));
      await stop(); await start(); await goToPage(1); await selectImage();
      assert.deepEqual(await inventory(), expected);
      assert.equal(await nativeText(), expectedText);
      report[imagePosition ? "imagePosition" : "imageSize"] = { page: 2, targetIndex: target.index,
        ...(imagePosition ? { xMm: 25.5, yMm: 35 } : { widthMm: 80.5, heightMm: 30 }),
        explicitSave: true, completeRestart: true, unchangedPeers: true, nativeRasterRetainedBeforeSave: true };
      await page.screenshot({ path: join(out, `chat-${artifact}-reopened.png`) });
    });
  }
  if (imageReplacement) {
    if (canvasImage) {
      await testCanvasImageReplacement({ getPage: () => page, getSdk: () => sdk, invoke, expect, sessionId, otherSessionId,
        file, artifact: importedPath || "lesson.pptx", out, report, fixture: canvasImageFixture, goToPage, waitForOffice,
        step, send, stop, start, setAssetId: value => { replacementAssetId = value; }, runFile, getBytes: () => teamPng,
        operation: canvasImageInsert ? "insert" : "replace" });
    } else {
    await step("Explicit image preview/approval enables actual Main Chat replacement with fresh authorized bytes", async () => {
      await goToPage(1);
      await copyFile(file, join(out, "image-baseline.pptx"));
      const panel = page.locator(".courseware-image-assets");
      await panel.locator('input:not([type="checkbox"])').nth(0).fill(teamProjectId);
      await panel.locator('input:not([type="checkbox"])').nth(1).fill(teamAssetId);
      await panel.getByRole("button", { name: /Preview image|预览图片/ }).click();
      await expect(panel.locator("img")).toBeVisible();
      const selectImage = () => sdk.evaluate(() => {
        const doc = window.Asc.editor.WordControl.m_oLogicDocument;
        const picture = doc.Slides[1].cSld.spTree.find(shape => shape.blipFill);
        if (!picture) throw new Error("Image test needs an ordinary picture");
        picture.Set_CurrentElement(); doc.Document_UpdateSelectionState();
      });
      await selectImage();
      assert(!(await invoke("pptEditorGetContext")).capabilities.some(item => item.name === "replace_slide_image_from_asset"), "Preview alone grants no image tool");
      await expect(panel.getByRole("button", { name: /Use in this PPTX|用于当前 PPTX/ })).toBeDisabled();
      await panel.locator('input[type="checkbox"]').check();
      await panel.getByRole("button", { name: /Use in this PPTX|用于当前 PPTX/ }).click();
      await expect(panel.getByRole("status")).toContainText(teamAssetId);
      await selectImage();
      const context = await invoke("pptEditorGetContext");
      assert(context.capabilities.some(item => item.name === "replace_slide_image_from_asset"));
      const history = () => sdk.evaluate(() => window.AscCommon.History.Index);
      const beforeHistory = await history();
      revoked = true;
      try {
        await assert.rejects(invoke("pptEditorExecute", { projectId: context.projectId, documentId: context.documentId, sessionId: context.sessionId,
          editGeneration: context.editGeneration, requestId: randomUUID(), tool: "replace_slide_image_from_asset", input: { assetId: teamAssetId } }), /COURSEWARE_MEDIA_/);
      } finally { revoked = false; }
      assert.equal(await history(), beforeHistory, "Revoked team access must not reach native mutation");
      assert.equal(hash(await readFile(file)), report.savedSha256);
      const beforeReads = teamRequests.length;
      await send(`CHAT_NATIVE_IMAGE 将当前选中的图片替换为已确认的 ${teamAssetId}，不要保存。`);
      await expect(page.getByText("CHAT_NATIVE_IMAGE_DONE", { exact: true })).toBeVisible({ timeout: 90_000 });
      assert.equal(hash(await readFile(file)), report.savedSha256);
      assert(teamRequests.slice(beforeReads).some(item => item.path === `${teamPath}/content` && item.method === "GET"));
      await invoke("pptEditorSave");
      await expect(load()).toBeEnabled({ timeout: 240_000 });
      await copyFile(file, join(out, "image-saved.pptx"));
      report.savedSha256 = hash(await readFile(file));
      await stop(); await start(); await goToPage(0);
      assert(!(await invoke("pptEditorGetContext")).capabilities.some(item => item.name === "replace_slide_image_from_asset"), "Restart does not preserve image approval");
      report.image = { assetId: teamAssetId, sha256: hash(teamPng), localPlatform: true, actualAuthSession: true,
        previewWithoutApprovalDenied: true, revokedAccessRefusedBeforeMutation: true, restartRevokesReview: true, freshDownload: true };
      await page.screenshot({ path: join(out, "chat-image-reopened.png") });
    });
    }
  }
  if (narration) {
    let before, candidateId, adopted, reviewedActions;
    await step("Existing main Chat generates current-page narration through the actual Main completion and Host staging", async () => {
      before = (await invoke("pptEditorTeachingOpen", { sessionId })).project;
      await send("CHAT_NATIVE_NARRATION 请重新生成当前页讲解，短句并加一句简单英语鼓励。");
      const reply = page.getByText(/^CHAT_NATIVE_NARRATION_DONE [\w.-]+$/, { exact: true });
      await expect(reply).toBeVisible({ timeout: 240_000 });
      candidateId = (await reply.innerText()).split(" ").at(-1);
      const pendingView = await invoke("pptEditorTeachingOpen", { sessionId });
      const project = pendingView.project;
      if (chatChanges) assert.equal(pendingView.chatChanges.flatMap(change => change.candidates ?? [])
        .find(candidate => candidate.candidateId === candidateId)?.status, "needs-review");
      assert.deepEqual(project, before, "Generation must not change teaching");
      assert.equal(hash(await readFile(file)), report.savedSha256);
      const review = await invoke("pptEditorNarrationReview", { sessionId, candidateId });
      assert.equal(review.status, "needs-review"); assert.equal(review.audioReady, false);
      if (narrationCompletionUrl) {
        assert(review.actions.some(action => action.type === "speech" && /[\u4e00-\u9fff]/u.test(action.text)));
        assert(review.actions.some(action => action.pauseAfterMs === 4000));
        assert(review.actions.some(action => /Good job!/iu.test(action.text)));
      } else assert.equal(review.actions[0].pauseAfterMs, 4000);
      reviewedActions = structuredClone(review.actions);
      await writeFile(join(out, "chat-generated-review.json"), JSON.stringify(review, null, 2));
    });
    await step("Generated receipt opens existing sidebar review; explicit adoption updates only this logical page", async () => {
      const panel = page.locator(".courseware-narration-review");
      await panel.locator("input:not([type=checkbox])").fill(candidateId);
      await panel.getByRole("button", { name: /Review candidate|审阅候选/ }).click();
      await expect(panel.getByText(/Proposed narration|候选讲解/, { exact: true })).toBeVisible({ timeout: 120_000 });
      const adopt = panel.getByRole("button", { name: /Adopt narration|采用讲解/ });
      await expect(adopt).toBeDisabled(); await expect(panel).toContainText("4000");
      await panel.locator("input[type=checkbox]").check();
      const xwd = join(out, "chat-narration-composite.xwd");
      await runFile("xwd", ["-root", "-silent", "-out", xwd]);
      await runFile("ffmpeg", ["-nostdin", "-v", "error", "-i", xwd, "-frames:v", "1", join(out, "chat-narration-composite.png")]);
      await adopt.click();
      await expect(panel.getByText(/Proposed narration|候选讲解/, { exact: true })).toHaveCount(0, { timeout: 120_000 });
      const adoptedView = await invoke("pptEditorTeachingOpen", { sessionId });
      adopted = adoptedView.project;
      if (chatChanges) {
        const linked = adoptedView.chatChanges.flatMap(change => change.candidates ?? []).find(candidate => candidate.candidateId === candidateId);
        assert.equal(linked.status, "adopted"); assert.equal(linked.sourceSha256, adopted.source.sha256);
        assert.equal(linked.teachingRevision, adopted.teachingRevision); assert.deepEqual(linked.pageIds, [adopted.pages[0].pageId]);
        report.chatCandidateAdoption = { ...linked };
      }
      if (narrationCompletionUrl) assert.deepEqual(adopted.pages[0].actions, reviewedActions);
      else assert.deepEqual(adopted.pages[0].actions.map(({ type, text, pauseAfterMs, checkpointKind }) =>
        type === "interaction_checkpoint" ? { type, checkpointKind } : { type, text, ...(pauseAfterMs ? { pauseAfterMs } : {}) }), [
        { type: "speech", text: narrationBlocks[0].text, pauseAfterMs: 4000 },
        ...(teacherContinue ? [{ type: "interaction_checkpoint", checkpointKind: "teacher_continue" }] : []),
        { type: "speech", text: narrationBlocks.at(-1).text }]);
      assert.deepEqual(adopted.pages.slice(1), before.pages.slice(1)); assert.deepEqual(adopted.source, before.source);
      assert.equal(hash(await readFile(file)), report.savedSha256);
    });
    if (realPlatform && !loopbackTts && !realTts) await step("Chat-adopted narration uses real platform authentication and a visible quote without paid submission", async () => {
      await load().click();
      const tts = page.locator(".courseware-tts-tasks");
      await tts.getByRole("button", { name: /读取可用模型与音色|Load available models/ }).click();
      const model = process.env.DECKWISE_E2E_TTS_MODEL || "doubao-courseware";
      await expect(tts.locator("select").nth(1).locator("option").filter({ hasText: model })).toHaveCount(1, { timeout: 30_000 });
      await tts.locator("select").nth(0).selectOption(adopted.pages[0].actions[0].id);
      await tts.locator("select").nth(1).selectOption(model);
      const voice = await tts.locator("select").nth(2).evaluate((select) => [...select.options].map((entry) => entry.value).find(Boolean));
      assert(voice, "Platform offered no explicit voice");
      await tts.locator("select").nth(2).selectOption(voice);
      await tts.getByRole("button", { name: /查看报价|Get quote/ }).click();
      await expect(tts).toContainText(/最高 1 积分|Maximum 1 point/, { timeout: 30_000 });
      await expect(tts.getByRole("button", { name: /确认费用并生成配音|Confirm fee and generate/ })).toBeDisabled();
      assert.deepEqual((await invoke("pptEditorTeachingOpen", { sessionId })).project, adopted);
      await page.screenshot({ path: join(out, "real-platform-quote.png") });
      report.realPlatformQuote = { model, voice, maxPoints: 1, submitted: false };
    });
    if (loopbackTts || realTts) adopted = await testChatTtsPlayback({ app, page, expect, invoke,
      sessionId, goToPage, project: adopted, out, step, report });
    if (nativeAudioSave) {
      adopted = await testNativeAudioSave({ page, expect, invoke, sessionId, goToPage, project: adopted, file, out, step, report });
      await testAdoptedPlayback({ app, page, expect, project: adopted, out, step, report });
    }
    await step("Complete Desktop restart restores Chat-generated adopted narration and candidate status", async () => {
      await stop(); await start(); await goToPage(0);
      assert.deepEqual((await invoke("pptEditorTeachingOpen", { sessionId })).project, adopted);
      assert.equal((await invoke("pptEditorNarrationReview", { sessionId, candidateId })).status, "adopted");
      assert.equal(hash(await readFile(file)), report.savedSha256);
      if (nativeAudioSave) assert((await nativeText()).includes("EDIT_AFTER_AUDIO_ADOPTION"));
    });
    if (teacherContinue) await step("Chat regenerates teacher-continuation narration, explicitly adopts it and restores it after restart", async () => {
      const beforeRegeneration = structuredClone(adopted);
      const replies = page.getByText(/^CHAT_NATIVE_NARRATION_DONE [\w.-]+$/, { exact: true });
      const replyCount = await replies.count();
      await send("CHAT_NATIVE_NARRATION 请再改写本页讲解，保留等待教师继续。");
      await expect(replies).toHaveCount(replyCount + 1, { timeout: 120_000 });
      const nextCandidateId = (await replies.last().innerText()).split(" ").at(-1);
      assert.notEqual(nextCandidateId, candidateId);
      assert.deepEqual((await invoke("pptEditorTeachingOpen", { sessionId })).project, beforeRegeneration);
      const nextReview = await invoke("pptEditorNarrationReview", { sessionId, candidateId: nextCandidateId });
      assert(nextReview.actions.some(action => action.type === "interaction_checkpoint" && action.checkpointKind === "teacher_continue"));
      assert(nextReview.actions.every(action => !Object.hasOwn(action, "audioAssetId")));
      const panel = page.locator(".courseware-narration-review");
      await panel.locator("input:not([type=checkbox])").fill(nextCandidateId);
      await panel.getByRole("button", { name: /Review candidate|审阅候选/ }).click();
      const adopt = panel.getByRole("button", { name: /Adopt narration|采用讲解/ });
      await expect(adopt).toBeDisabled();
      await panel.locator("input[type=checkbox]").check();
      await adopt.click();
      await expect(panel.getByText(/Proposed narration|候选讲解/, { exact: true })).toHaveCount(0, { timeout: 120_000 });
      adopted = (await invoke("pptEditorTeachingOpen", { sessionId })).project;
      assert.deepEqual(adopted.pages[0].actions, nextReview.actions);
      assert.notEqual(adopted.teachingRevision, beforeRegeneration.teachingRevision);
      assert.deepEqual(adopted.pages.slice(1), beforeRegeneration.pages.slice(1));
      assert.deepEqual(adopted.source, beforeRegeneration.source);
      assert.equal(hash(await readFile(file)), report.savedSha256);
      await writeFile(join(out, "teacher-continue-regeneration.json"), JSON.stringify({ before: beforeRegeneration, after: adopted }, null, 2));
      await stop(); await start(); await goToPage(0);
      assert.deepEqual((await invoke("pptEditorTeachingOpen", { sessionId })).project, adopted);
      assert.equal((await invoke("pptEditorNarrationReview", { sessionId, candidateId: nextCandidateId })).status, "adopted");
      assert.equal((await invoke("pptEditorNarrationReview", { sessionId, candidateId })).status, "adopted");
      await page.screenshot({ path: join(out, "teacher-continue-reopened.png") });
      report.teacherContinue = { regenerated: true, explicitlyAdopted: true, restartVerified: true, sourceUnchanged: true };
    });
    await step("Stopping the real Chat aborts the in-flight Main completion without adopting narration", async () => {
      const beforeCancel = (await invoke("pptEditorTeachingOpen", { sessionId })).project;
      await send("CHAT_NATIVE_NARRATION CANCEL_NARRATION 请重新生成当前页讲解。");
      await expect.poll(() => heldCompletions.size, { timeout: 120_000 }).toBe(1);
      await invoke("agentAbort", { sessionId });
      await expect.poll(() => cancelledCompletions, { timeout: 15_000 }).toBe(1);
      await expect.poll(async () => {
        try { return (await invoke("pptEditorTeachingOpen", { sessionId })).project; } catch { return null; }
      }, { timeout: 30_000 }).toEqual(beforeCancel);
      assert.equal(hash(await readFile(file)), report.savedSha256);
      report.cancelledModelRequests = cancelledCompletions;
    });
    if (sourcePauses) {
      let associated;
      await step("Native PPTX save requires explicit source review and preserves Chat narration pauses", async () => {
        const context = await invoke("pptEditorGetContext");
        await invoke("pptEditorExecute", { projectId: context.projectId, documentId: context.documentId,
          sessionId: context.sessionId, editGeneration: context.editGeneration, requestId: randomUUID(),
          tool: "add_slide_text", input: { text: "EDIT_AFTER_CHAT_NARRATION" } });
        await assert.rejects(invoke("pptEditorTeachingOpen", { sessionId }), /Save or reopen/);
        await invoke("pptEditorSave");
        await expect(load()).toBeEnabled({ timeout: 240_000 });
        const savedHash = hash(await readFile(file));
        assert.notEqual(savedHash, adopted.source.sha256);
        await assert.rejects(invoke("pptEditorTeachingOpen", { sessionId }), /COURSEWARE_CONFLICT.*reconcile/);
        await button(/Review saved PPTX changes|审核已保存的 PPTX 变更/).click();
        const review = page.locator(".courseware-source-review");
        await expect(review).toBeVisible({ timeout: 120_000 });
        await expect(review).toContainText("4000");
        const choices = review.locator("select");
        await expect(choices).toHaveCount(adopted.pages.length);
        const confirm = review.getByRole("button", { name: /Use these associations|采用这些关联/ });
        await expect(confirm).toBeDisabled();
        for (let index = 0; index < adopted.pages.length; index++) {
          await expect(choices.nth(index)).toHaveValue("");
          await choices.nth(index).selectOption(String(index));
        }
        await expect(confirm).toBeDisabled();
        await review.locator("input[type=checkbox]").check();
        await page.screenshot({ path: join(out, "source-pause-associations.png") });
        await confirm.click();
        await expect(review).toHaveCount(0, { timeout: 120_000 });
        associated = (await invoke("pptEditorTeachingOpen", { sessionId })).project;
        assert.equal(associated.source.sha256, savedHash);
        assert.notEqual(associated.teachingRevision, adopted.teachingRevision);
        assert.deepEqual(associated.pages, adopted.pages.map((page) => ({ ...page, reviewState: "review" })));
        assert.equal(hash(await readFile(file)), savedHash, "Association must not rewrite PPTX");
        await writeFile(join(out, "source-pause-project.json"), JSON.stringify(associated, null, 2));
      });
      await step("Complete restart restores the edited PPTX and associated speech pauses", async () => {
        await stop(); await start(); await goToPage(0);
        assert((await nativeText()).includes("EDIT_AFTER_CHAT_NARRATION"));
        assert.deepEqual((await invoke("pptEditorTeachingOpen", { sessionId })).project, associated);
        assert.equal(associated.pages[0].actions[0].pauseAfterMs, 4000);
        assert.equal(hash(await readFile(file)), associated.source.sha256);
      });
    }
  }
  if (nativeAudioConcurrency) await testNativeAudioConcurrency({ getPage: () => page, getSdk: () => sdk, invoke,
    expect, sessionId, goToPage, fixture: raceFixture, file, out, report, step, stop, start,
    readRecords: async () => {
      const result = await runFile("python3", ["-c", `import json,sqlite3,sys
db=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
names=('coursewareProjects.v1','coursewareTtsIntents.v1','coursewareTtsAudio.v1','coursewareSourceChanges.v1')
print(json.dumps([{'ns':r[0],'key':r[1],'value':json.loads(r[2])} for r in db.execute('SELECT ns,key,value_json FROM kv') if r[0] in names]))`, join(temp, "data/pi.sqlite")]);
      return JSON.parse(result.stdout);
    } });
  if (fade) await step(adoptFade ? "Chat fade review, explicit source adoption and complete Office restart" : "Existing main Chat generates an archived fade copy without changing the saved PPTX or teaching", async () => {
    const before = (await invoke("pptEditorTeachingOpen", { sessionId })).project;
    const beforeHash = hash(await readFile(file));
    await send("CHAT_NATIVE_FADE 请给当前页添加淡入过渡，生成待审核副本。");
    const reply = page.getByText(/^(CHAT_NATIVE_FADE_DONE [\w.-]+ [a-f0-9]{64}|CHAT_NATIVE_TOOL_FAILED)$/, { exact: true });
    await expect(reply).toBeVisible({ timeout: 240_000 });
    assert.match(await reply.innerText(), /^CHAT_NATIVE_FADE_DONE /, "Active editor tools remain available after Chat cancellation");
    const [, candidateId, outputSha256] = (await reply.innerText()).split(" ");
    assert.notEqual(outputSha256, beforeHash);
    assert.equal(hash(await readFile(join(temp, "data/courseware-candidates", `${outputSha256}.pptx`))), outputSha256);
    assert.equal(hash(await readFile(file)), beforeHash);
    assert.deepEqual((await invoke("pptEditorTeachingOpen", { sessionId })).project, before);
    if (chatChanges) assert.equal((await invoke("pptEditorTeachingOpen", { sessionId })).chatChanges
      .flatMap(change => change.candidates ?? []).find(candidate => candidate.candidateId === candidateId)?.status, "needs-review");
    const panel = page.locator(".courseware-teaching");
    await panel.getByLabel(/Candidate ID|候选稿 ID/).fill(candidateId);
    await panel.getByRole("button", { name: /Review candidate|审阅候选稿/ }).click();
    await expect(panel.getByText(/PPTX candidate review|PPTX 候选稿审阅/, { exact: true })).toBeVisible();
    const priorPages = new Set(app.context().pages());
    const candidateWindow = app.waitForEvent("window");
    await panel.getByRole("button", { name: /Open read-only preview|打开只读预览/ }).click();
    const previewWindow = await candidateWindow;
    await previewWindow.waitForLoadState("domcontentloaded");
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => window.getTitle()).find((title) => title.includes("PPTX candidate")))).toBeTruthy();
    await expect.poll(async () => {
      const candidates = app.context().pages().filter((target) => !priorPages.has(target) && target.url().startsWith("deckwise-editor:"));
      for (const target of candidates) {
        for (const frame of target.frames()) {
          if (await frame.evaluate(() => Boolean(window.Asc?.editor?.isLoadFullApi && window.Asc.editor.isDocumentLoadComplete)).catch(() => false)) {
            return true;
          }
        }
      }
      return false;
    }, { timeout: 120_000 }).toBe(true);
    await expect(panel.getByRole("button", { name: /Reject candidate|拒绝候选/ })).toBeEnabled({ timeout: 120_000 });
    await previewWindow.keyboard.press("Control+s");
    assert.equal(hash(await readFile(join(temp, "data/courseware-candidates", `${outputSha256}.pptx`))), outputSha256);
    await previewWindow.close();
    if (adoptFade) {
      const adopt = panel.getByRole("button", { name: /Adopt and reopen|采纳并重新打开/ });
      await expect(adopt).toBeDisabled();
      await panel.getByRole("checkbox", { name: /I reviewed this candidate|我已检查候选/ }).check();
      await expect(adopt).toBeEnabled();
      await adopt.click();
      await expect(adopt).toHaveCount(0, { timeout: 180_000 });
      await waitForOffice();
      await expect(load()).toBeEnabled({ timeout: 180_000 });
      assert.equal(hash(await readFile(file)), outputSha256);
      const adopted = (await invoke("pptEditorTeachingOpen", { sessionId })).project;
      assert.equal(adopted.source.sha256, outputSha256);
      assert.notEqual(adopted.teachingRevision, before.teachingRevision);
      assert.deepEqual(adopted.pages.map(row => [row.pageId, row.actions, row.locked]), before.pages.map(row => [row.pageId, row.actions, row.locked]));
      const backups = await (await import("node:fs/promises")).readdir(workspace);
      const backup = backups.find(name => name.startsWith(".lesson.pptx.adoption-"));
      assert(backup); assert.equal(hash(await readFile(join(workspace, backup, "original.pptx"))), beforeHash);
      const reads = page.getByText("CHAT_NATIVE_READ_DONE", { exact: true });
      const priorReads = await reads.count();
      await send("CHAT_NATIVE_READ 读取采纳后 PPT 的文字。");
      await expect(reads).toHaveCount(priorReads + 1, { timeout: 90_000 });
      await stop(); await start();
      assert((await nativeText()).includes("CHAT_ADDED_IN_OFFICE"));
      assert.deepEqual((await invoke("pptEditorTeachingOpen", { sessionId })).project, adopted);
      assert.equal(hash(await readFile(file)), outputSha256);
      if (chatChanges) {
        const linked = (await invoke("pptEditorTeachingOpen", { sessionId })).chatChanges
          .flatMap(change => change.candidates ?? []).find(candidate => candidate.candidateId === candidateId);
        assert.deepEqual(linked, { candidateId, sourceSha256: outputSha256, teachingRevision: adopted.teachingRevision,
          pageIds: [adopted.pages[0].pageId], status: "adopted" });
        const records = await runFile("python3", ["-c", `import json,sqlite3,sys
db=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
print(json.dumps([json.loads(r[0]) for r in db.execute('SELECT value_json FROM kv WHERE ns=?',('coursewareChatCandidateAdoptions.v1',))]))`, join(temp, "data/pi.sqlite")]);
        await writeFile(join(out, "chat-source-adoption-linked.json"), JSON.stringify({ before, after: adopted,
          reference: linked, records: JSON.parse(records.stdout) }, null, 2));
        await copyFile(file, join(out, "chat-source-adopted.pptx"));
      }
      report.fade = { candidateId, outputSha256, applied: true, reviewState: "adopted", previewReadOnly: true, backupSha256: beforeHash, restartVerified: true, reopenedChatVerified: true };
    } else {
      await panel.getByRole("button", { name: /Reject candidate|拒绝候选/ }).click();
      await expect(panel.getByRole("button", { name: /Reject candidate|拒绝候选/ })).toHaveCount(0, { timeout: 120_000 });
      const rejected = await invoke("pptEditorTeachingOpen", { sessionId });
      assert.deepEqual(rejected.project, before);
      assert.equal(hash(await readFile(file)), beforeHash);
      if (chatChanges) assert.equal(rejected.chatChanges.flatMap(change => change.candidates ?? [])
        .find(candidate => candidate.candidateId === candidateId)?.status, "rejected");
      report.fade = { candidateId, outputSha256, applied: false, reviewState: "rejected", previewReadOnly: true };
    }
    await page.screenshot({ path: join(out, "chat-fade-candidate.png") });
  });
  if (chatChanges) await step("Pre-save Chat receipts survive native Save and full restart without claiming teaching was adopted", async () => {
    const changes = await readChatChanges();
    assert.deepEqual(changes.find(change => change.changeGroupId === firstChatChange.changeGroupId), firstChatChange);
    const operations = changes.flatMap(change => change.operations);
    if (narration) {
      assert(operations.some(op => op.toolName === "ppt_propose_page_narration" && op.outcome?.candidateId));
      assert(operations.some(op => op.toolName === "ppt_propose_page_narration" && op.outcome?.state === "uncertain"));
    }
    assert(operations.every(op => op.outcome?.saved === false || op.outcome === null));
    await load().click();
    const history = page.locator(".courseware-chat-changes");
    await expect(history).toBeVisible({ timeout: 120_000 });
    await history.locator("summary").click();
    await expect(history).toContainText(firstChatChange.changeGroupId.slice(0, 8));
    await expect(history).toContainText(/不会自动重放|no operation is replayed automatically/);
    if (chatPlan) {
      const view = await invoke("pptEditorTeachingOpen", { sessionId });
      const declared = view.chatChanges.find(change => change.changeGroupId === firstChatChange.changeGroupId).plan;
      assert.deepEqual(declared.items.map(item => item.status), ["native-unsaved", "not-recorded"]);
      assert.equal(declared.items[1].toolName, "ppt_propose_page_narration");
      await expect(history).toContainText("Also rewrite this page narration");
      await expect(history).toContainText(/尚无对应执行记录|No matching execution recorded/);
      await writeFile(join(out, "declared-plan-after-restart.json"), JSON.stringify({ plan: declared, project: view.project }, null, 2));
    }
    if (narration) await expect(history).toContainText(/已采用，结果仍匹配|Adopted; result still matches/);
    if (fade && adoptFade) await expect(history).toContainText(/已采用，结果仍匹配|Adopted; result still matches/);
    await page.screenshot({ path: join(out, "chat-change-history.png") });
    report.chatChangeGroups = changes.map(change => ({ changeGroupId: change.changeGroupId, turnId: change.turnId,
      toolNames: change.operations.map(op => op.toolName), states: change.operations.map(op => op.outcome?.state ?? "unknown") }));
    await writeFile(join(out, "chat-changes-final.json"), JSON.stringify(changes, null, 2));
    await copyFile(file, join(out, "chat-changes-final.pptx"));
  });
  if (chatChanges && narration) await step("Later narration edits retain the original adopted revision and visibly mark its result changed after restart", async () => {
    const before = await invoke("pptEditorTeachingOpen", { sessionId });
    await load().click(); await expect(load()).toBeEnabled({ timeout: 120_000 });
    const teaching = page.locator(".courseware-teaching");
    await teaching.getByRole("spinbutton", { name: /段后停顿（毫秒）|Pause after segment/, exact: false }).first().fill("1250");
    await teaching.getByRole("button", { name: /保存讲解|Save narration/, exact: true }).click();
    await expect(load()).toBeEnabled({ timeout: 120_000 });
    const changed = await invoke("pptEditorTeachingOpen", { sessionId });
    const expected = structuredClone(before.project.pages); expected[0].actions[0].pauseAfterMs = 1250;
    assert.deepEqual(changed.project.pages, expected); assert.deepEqual(changed.project.source, before.project.source);
    const readLinked = view => view.chatChanges.flatMap(change => change.candidates ?? [])
      .find(candidate => candidate.candidateId === report.chatCandidateAdoption.candidateId);
    assert.deepEqual(readLinked(changed), { ...report.chatCandidateAdoption, status: "superseded" });
    await stop(); await start(); await goToPage(0); await load().click();
    await expect(load()).toBeEnabled({ timeout: 120_000 });
    const restored = await invoke("pptEditorTeachingOpen", { sessionId });
    assert.deepEqual(restored.project, changed.project); assert.deepEqual(readLinked(restored), readLinked(changed));
    const history = page.locator(".courseware-chat-changes");
    if (await history.getAttribute("open") === null) await history.locator("summary").click();
    await expect(history).toContainText(/曾采用，相关内容后来又有修改|Adopted earlier; related content has since changed/);
    await page.screenshot({ path: join(out, "chat-adoption-later-change.png") });
    const records = await runFile("python3", ["-c", `import json,sqlite3,sys
db=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
print(json.dumps([json.loads(r[0]) for r in db.execute('SELECT value_json FROM kv WHERE ns=?',('coursewareChatCandidateAdoptions.v1',))]))`, join(temp, "data/pi.sqlite")]);
    await writeFile(join(out, "chat-adoption-linked.json"), JSON.stringify({ before: before.project, after: restored.project,
      reference: readLinked(restored), records: JSON.parse(records.stdout) }, null, 2));
    assert.equal(hash(await readFile(file)), report.savedSha256);
  });
  if (chatResolution) await step("Explicit disposition retains later teaching and missing steps across full restart", async () => {
    await load().click(); await expect(load()).toBeEnabled({ timeout: 120_000 });
    const before = await invoke("pptEditorTeachingOpen", { sessionId });
    const original = before.chatChanges.find(change => change.changeGroupId === firstChatChange.changeGroupId);
    assert(original.receiptSha256 && !original.resolution);
    const normal = await invoke("pptEditorTeachingConfirm", { viewId: before.viewId, expectedTeachingRevision: before.project.teachingRevision });
    assert(!normal.chatChanges.find(change => change.changeGroupId === firstChatChange.changeGroupId).resolution);
    await load().click(); await expect(load()).toBeEnabled({ timeout: 120_000 });
    const history = page.locator(".courseware-chat-changes");
    if (await history.getAttribute("open") === null) await history.locator("summary").click();
    await history.getByRole("button", { name: /核对这组修改|Review this request/, exact: true }).click();
    const close = history.getByRole("button", { name: /保留当前结果并结束这组修改|Keep current result and close request/, exact: true });
    await expect(close).toBeDisabled();
    await history.getByRole("textbox", { name: /处理说明|Disposition/ }).fill("Reviewed saved page and later narration; cancel remaining original narration request.");
    await expect(close).toBeDisabled(); await history.getByRole("checkbox").check();
    await expect(close).toBeEnabled(); await close.click();
    await expect(history).toContainText(/已人工核对并结束|Explicitly closed after review/, { timeout: 120_000 });
    const after = await invoke("pptEditorTeachingOpen", { sessionId });
    assert.deepEqual(after.project.pages.map(page => page.actions), before.project.pages.map(page => page.actions));
    assert.notEqual(after.project.teachingRevision, before.project.teachingRevision);
    assert.equal(after.chatChanges.find(change => change.changeGroupId === firstChatChange.changeGroupId).plan.items[1].status, "not-recorded");
    await assert.rejects(invoke("pptEditorTeachingConfirm", { viewId: after.viewId, expectedTeachingRevision: after.project.teachingRevision,
      resolution: { changeGroupId: firstChatChange.changeGroupId, receiptSha256: original.receiptSha256, note: "Duplicate close" } }), /Chat request or target changed/);
    await stop(); await start(); await goToPage(0); await load().click();
    await expect(load()).toBeEnabled({ timeout: 120_000 });
    const restored = await invoke("pptEditorTeachingOpen", { sessionId }); assert.deepEqual(restored.project, after.project);
    const change = restored.chatChanges.find(change => change.changeGroupId === firstChatChange.changeGroupId);
    assert.deepEqual(change.resolution, after.chatChanges.find(change => change.changeGroupId === firstChatChange.changeGroupId).resolution);
    assert.equal(hash(await readFile(file)), report.savedSha256);
    const records = await runFile("python3", ["-c", `import json,sqlite3,sys
db=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
print(json.dumps({ns:[json.loads(r[0]) for r in db.execute('SELECT value_json FROM kv WHERE ns=?',(ns,))] for ns in ['coursewareChatResolutions.v1','coursewareHistory.v1']}))`, join(temp, "data/pi.sqlite")]);
    await writeFile(join(out, "chat-resolution.json"), JSON.stringify({ before: before.project, normal: normal.project,
      after: after.project, restored: restored.project, change, records: JSON.parse(records.stdout) }, null, 2));
    const restoredHistory = page.locator(".courseware-chat-changes");
    if (await restoredHistory.getAttribute("open") === null) await restoredHistory.locator("summary").click();
    await expect(restoredHistory).toContainText(/已人工核对并结束|Explicitly closed after review/);
    await page.screenshot({ path: join(out, "chat-resolution-restored.png") });
  });
  await step("Another Chat cannot discover or borrow the owning Chat's native editor tools", async () => {
    await page.evaluate(async (id) => window.__PI_DESKTOP__.selectSession(id), otherSessionId);
    await send("CHAT_NATIVE_OTHER 请修改另一个会话的 PPT。");
    await expect(page.getByText("CHAT_NATIVE_UNAVAILABLE", { exact: true })).toBeVisible({ timeout: 90_000 });
  });
  assert(requests.length < requestLimit, "No unbounded retry");
  report.modelRequests = requests.length; report.status = "PASS";
  }
} catch (error) {
  report.status = "FAIL"; report.error = error.stack || String(error); process.exitCode = 1;
  if (page) { await page.screenshot({ path: join(out, "failure.png") }).catch(() => {}); report.screen = await page.locator("body").innerText().catch(() => "unavailable"); }
} finally {
  const retain = (canvasImage || nativeAudioConcurrency) && report.status !== "PASS" || retainCoursewareWorkspace({ recovery: Boolean(recovery), mediaEnabled: loopbackTts || realTts, passed: report.status === "PASS" });
  if (retain) report.recovery = { directory: temp, sessionId };
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(join(out, "desktop.log"), logs.join(""));
  await writeFile(join(out, "fixture-requests.json"), JSON.stringify(requests, null, 2));
  if (imageReplacement || nativeAudioConcurrency) await writeFile(join(out, "team-requests.json"), JSON.stringify(teamRequests, null, 2));
  await stop(); for (const response of heldCompletions) response.destroy(); await new Promise((resolve) => server.close(resolve));
  if (!retain) await rm(temp, { recursive: true, force: true });
}
console.log(report.status, out);
