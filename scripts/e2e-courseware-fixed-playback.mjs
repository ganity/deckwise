/** Real Host export -> Main build IPC -> sandboxed compiled player. No provider calls. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { coursewareLaunch } from "./e2e/boot.mjs";

for (const key of ["DECKWISE_E2E_PPTX", "DECKWISE_E2E_OUTPUT",
  ...(process.env.DECKWISE_E2E_PACKAGE_ROOT ? [] : ["PI_DESKTOP_HOST_BIN", "DECKWISE_PPTX_WORKER"])])
  assert(process.env[key], `Missing ${key}`);
const out = resolve(process.env.DECKWISE_E2E_OUTPUT);
assert(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === "--tts-audio"));
const ttsAudio = process.argv[2] === "--tts-audio";
const paidUi = process.env.DECKWISE_E2E_PAID_TTS_UI === "1";
const resumePaid = process.env.DECKWISE_E2E_RESUME_PAID_FROM;
const uiPlayback = process.env.DECKWISE_E2E_PLAYBACK_UI === "1" || paidUi;
if (uiPlayback) assert(ttsAudio && process.env.DECKWISE_EDITOR_URL, "UI playback needs TTS and WiseOffice");
if (paidUi) assert(process.env.DECKWISE_E2E_PLATFORM_TOKEN_FILE && process.env.DECKWISE_E2E_PAID_MARKER && !process.env.DECKWISE_TTS_REAL_AUDIO_PATH);
if (resumePaid) assert(paidUi && resolve(resumePaid) !== out, "Resume needs the prior paid UI output");
await mkdir(out);
const run = promisify(execFile);
const require = createRequire(new URL("../packages/courseware-runtime/package.json", import.meta.url));
const { _electron, expect } = require("@playwright/test");
const launch = coursewareLaunch();
const fixtureEnv = launch.packaged ? { ...process.env,
  PI_DESKTOP_HOST_BIN: join(launch.cwd, "resources/bin/pi-desktop-host-core"),
  DECKWISE_PPTX_WORKER: join(launch.cwd, "resources/pptx-worker/pptx-worker.mjs"),
  DECKWISE_PPTX_NODE: launch.executablePath } : process.env;
const report = { status: "RUNNING", checks: [], paidCalls: false, audioFixtureOnly: !process.env.DECKWISE_TTS_REAL_AUDIO_PATH,
  realProviderAudio: Boolean(process.env.DECKWISE_TTS_REAL_AUDIO_PATH), authFixtureOnly: true,
  adoptedTtsSnapshot: ttsAudio && !paidUi, packaged: launch.packaged, sandbox: "--no-sandbox", userVisibleBuildButton: false };
const logs = [];
let app, page, invoke, fixture, selected, build, player, workspace, authServer, paidPosts = 0;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function step(name, action) {
  console.log("START", name); await action(); report.checks.push(name); console.log("PASS", name);
}
async function approvedBuild() {
  const result = await invoke("coursewareFixedBuild", selected);
  assert.equal(result.snapshot.source.sha256, hash(await readFile(process.env.DECKWISE_E2E_PPTX)));
  if (result.status === "ready") return result;
  assert.equal(result.status, "review");
  const codes = [...new Set(result.diagnostics.map((entry) => entry.code))];
  // Exact fixture-only notes review is recorded in A16/fixture-notes-review.json.
  if (!process.env.DECKWISE_E2E_SOURCE_VARIANT && !process.env.DECKWISE_E2E_GENERATED_SOURCE)
    assert.deepEqual(codes, ["PPTX_NOTES_MASTER_UNVERIFIED"]);
  assert(!result.diagnostics.some((entry) => entry.severity === "error"));
  await assert.rejects(invoke("coursewareFixedApprove", { reviewId: result.reviewId, codes: [] }), /exactly/);
  const ready = await invoke("coursewareFixedApprove", { reviewId: result.reviewId, codes });
  assert.equal(ready.status, "ready");
  assert(!JSON.stringify(ready).includes(fixture.temp));
  await assert.rejects(invoke("coursewareFixedApprove", { reviewId: result.reviewId, codes }), /expired/);
  return ready;
}
async function openPlayer() {
  const opened = app.waitForEvent("window");
  await invoke("coursewareFixedPlay", { previewId: build.previewId, locale: "zh-CN" });
  player = await opened;
  player.on("pageerror", (error) => logs.push("PLAYERERROR " + error.stack));
  await expect(player.locator("[data-player-mode]")).toBeVisible({ timeout: 30_000 });
  await expect(player.locator("#error")).toBeEmpty();
}
try {
  await step("Real Host captures and revalidates an immutable snapshot", async () => {
    const fixtureOutput = join(resumePaid ? resolve(resumePaid) : out, "host");
    const args = ttsAudio ? [new URL("./e2e-courseware-media.mjs", import.meta.url).pathname, "--tts-audio"]
      : [new URL("./e2e-courseware-snapshots.mjs", import.meta.url).pathname,
        fixtureEnv.DECKWISE_PPTX_WORKER, process.env.DECKWISE_E2E_PPTX, fixtureOutput];
    if (!resumePaid) {
      const result = await run(process.execPath, args, { timeout: 180_000, env: { ...fixtureEnv,
        DECKWISE_E2E_OUTPUT: fixtureOutput, DECKWISE_TTS_TEST_SOURCE: process.env.DECKWISE_E2E_PPTX,
        DECKWISE_E2E_REAL_OFFICE_IDENTITY: uiPlayback ? "1" : "0", DECKWISE_E2E_PAID_TTS_UI: paidUi ? "1" : "0" } });
      logs.push(result.stdout, result.stderr);
    }
    fixture = JSON.parse(await readFile(join(fixtureOutput, ttsAudio ? "tts-integration.json" : "report.json"), "utf8"));
    if (resumePaid) report.paidTaskId = JSON.parse(await readFile(join(resolve(resumePaid), "report.json"), "utf8")).paidTaskId;
    assert.equal(fixture.status, paidUi ? "PASS_PAID_UI_PREPARED" : ttsAudio ? "PASS_MAIN_DECODED_AUDIO_ADOPTION_ONLY" : "PASS_HOST_SNAPSHOTS_ONLY");
    const frozen = paidUi ? null : JSON.parse(await readFile(join(out, "host/fixed-export.json"), "utf8"));
    selected = paidUi ? { projectId: fixture.projectId } : { projectId: frozen.snapshot.projectId, snapshotId: frozen.snapshot.snapshotId };
    report.pageCount = paidUi ? fixture.pageCount : frozen.project.pages.length;
    workspace = ttsAudio ? fixture.workspace : join(fixture.temp, "workspace");
    if (uiPlayback) {
      const url = new URL(fixture.platformBaseUrl);
      assert.equal(url.hostname, "127.0.0.1");
      const upstreamToken = paidUi ? JSON.parse(await readFile(process.env.DECKWISE_E2E_PLATFORM_TOKEN_FILE, "utf8")).token : null;
      authServer = createServer(async (request, response) => {
        const send = (data) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ code: 200, data })); };
        if (request.url === "/auth/desktop/refresh" && request.method === "POST")
          return send({ accessToken: `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`, refreshToken: "fixture-refresh" });
        if (request.url === "/auth/me") return send({ edition: "EDUCATION", pcAllowed: true, role: "ADMIN", tenantId: 8, userId: 7 });
        if (paidUi && request.url?.startsWith("/courseware/media/")) {
          if (request.url === "/courseware/media/tasks/confirmed" && request.method === "POST" && ++paidPosts !== 1) {
            response.writeHead(409); response.end(); return;
          }
          try {
            const body = request.method === "POST" ? Buffer.concat(await Array.fromAsync(request)) : undefined;
            assert(!body || body.length <= 64_000);
            const upstream = await fetch(`http://127.0.0.1:18122${request.url}`, { method: request.method,
              headers: { authorization: `Bearer ${upstreamToken}`, ...(request.headers["content-type"] ? { "content-type": request.headers["content-type"] } : {}),
                ...(request.headers["idempotency-key"] ? { "idempotency-key": request.headers["idempotency-key"] } : {}) }, body });
            const bytes = Buffer.from(await upstream.arrayBuffer());
            if (upstream.ok && request.url === "/courseware/media/tasks/confirmed") report.paidTaskId = JSON.parse(bytes).data?.taskId;
            if (upstream.ok && request.url?.endsWith("/asset")) report.audioHash = hash(bytes);
            if (upstream.ok && /^\/courseware\/media\/tasks\/[^/]+$/u.test(request.url || "")) {
              const task = JSON.parse(bytes).data;
              report.remoteTask = { taskId: task.taskId, state: task.state, feeState: task.feeState, actualPoints: task.actualPoints };
            }
            response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") || "application/json" });
            response.end(bytes);
          } catch { response.writeHead(502); response.end(); }
          return;
        }
        response.writeHead(404); response.end();
      });
      await new Promise((resolve, reject) => authServer.once("error", reject).listen(Number(url.port), url.hostname, resolve));
    }
    if (ttsAudio && !paidUi) {
      assert.deepEqual(frozen.snapshot.assetIds, [`tts-${fixture.audioHash}`]);
      assert.equal(frozen.project.pages[0].actions[0].text, process.env.DECKWISE_TTS_REAL_AUDIO_TEXT || "Good! 小朋友😀");
      report.audioHash = fixture.audioHash;
      report.frozenTeachingRevision = frozen.project.teachingRevision;
    }
  });
  await step("Real Desktop starts with the same persisted Host data and owning Chat", async () => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/api.?key|secret|token|password|proxy/i.test(key)));
    app = await _electron.launch({ executablePath: launch.executablePath,
      args: ["--no-sandbox", "--user-data-dir=" + join(fixture.temp, "profile"), ...launch.args], cwd: launch.cwd,
      env: { ...env, ELECTRON_RUN_AS_NODE: "", ELECTRON_RENDERER_URL: "", PI_DESKTOP_DATA_DIR: join(fixture.temp, "data"),
        PI_DESKTOP_START_MAXIMIZED: "0", DECKWISE_PLATFORM_BASE_URL: uiPlayback ? fixture.platformBaseUrl : "http://127.0.0.1:9/test-platform" }, timeout: 60_000 });
    for (const stream of [app.process().stdout, app.process().stderr]) stream.on("data", (bytes) => logs.push(String(bytes)));
    page = await app.firstWindow({ timeout: 120_000 });
    report.runtime = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath, executablePath: process.execPath }));
    assert.equal(report.runtime.packaged, launch.packaged);
    if (launch.packaged) {
      assert.equal(report.runtime.appPath, join(launch.cwd, "resources/app.asar"));
      assert.equal(report.runtime.resourcesPath, join(launch.cwd, "resources"));
      assert.equal(report.runtime.executablePath, launch.executablePath);
    }
    await app.evaluate(({ session }) => session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: /^https?:/.test(details.url) && !["127.0.0.1", "localhost", "[::1]"].includes(new URL(details.url).hostname) });
    }));
    if (uiPlayback) {
      await page.waitForFunction(() => !!window.piDesktop);
      await expect.poll(async () => page.evaluate(async () => {
        const result = await window.piDesktop.invoke(window.piDesktop.channels.invoke.authRestore);
        return result.data?.status;
      }), { timeout: 30_000 }).toBe("authenticated");
    } else await page.locator(".auth-refresh").waitFor({ state: "visible", timeout: 60_000 });
    const channels = await page.evaluate(() => window.piDesktop.channels);
    if (!uiPlayback) await app.evaluate(({ ipcMain, BrowserWindow }, channels) => {
      const state = { status: "authenticated", profile: { userId: 1, userName: "Local fixed build verification", edition: "EDUCATION", role: "TEACHER", pcAllowed: true } };
      for (const name of ["authRestore", "authStartQr"]) { ipcMain.removeHandler(channels.invoke[name]); ipcMain.handle(channels.invoke[name], () => ({ ok: true, data: state })); }
      const main = BrowserWindow.getAllWindows()[0];
      const send = main.webContents.send.bind(main.webContents);
      main.webContents.send = (channel, ...args) => send(channel, ...(channel === channels.event.authChanged ? [state] : args));
      send(channels.event.authChanged, state);
    }, channels);
    if (!uiPlayback) await page.reload();
    await page.waitForFunction(() => !!window.__PI_DESKTOP__);
    invoke = (name, ...args) => page.evaluate(async ({ name, args }) => {
      const response = await window.piDesktop.invoke(window.piDesktop.channels.invoke[name], ...args);
      if (!response.ok) throw new Error(JSON.stringify(response));
      return response.data;
    }, { name, args });
    await invoke("projectSet", workspace);
    const sessions = (await invoke("sessionList")).sessions;
    const owning = sessions.find((session) => session.projectPath === workspace);
    assert(owning, JSON.stringify(sessions)); selected.sessionId = owning.id;
    await page.evaluate((id) => window.__PI_DESKTOP__.selectSession(id), owning.id);
    await invoke("notificationSetViewingSession", { sessionId: owning.id });
    report.selection = selected;
    if (ttsAudio && !paidUi) {
      assert.equal(owning.id, fixture.fixedSnapshot.sessionId);
      await invoke("sessionCreate", { title: "Playback isolation check", projectPath: workspace });
    } else if (paidUi) assert.equal(owning.id, fixture.sessionId);
  });
  if (paidUi) {
    await step(resumePaid ? "Visible narration panel resumes the existing paid platform TTS task" : "Visible narration panel quotes and submits one paid platform TTS task", async () => {
      const source = join(workspace, ".deckwise-ppt/revisions/tts-main/r0001/document.pptx");
      await page.evaluate(async (path) => { window.__PI_CAPTURE__ = true; await window.__PI_DESKTOP__.openWorkPanelArtifact("file", path); }, source);
      const teaching = page.locator(".courseware-teaching");
      await expect(teaching).toBeVisible({ timeout: 120_000 });
      await expect.poll(async () => {
        const office = app.context().pages().find((target) => target.url().startsWith("deckwise-editor:"));
        if (!office) return false;
        for (const frame of office.frames())
          if (await frame.evaluate(() => Boolean(window.Asc?.editor?.isLoadFullApi && window.Asc.editor.isDocumentLoadComplete)).catch(() => false)) return true;
        return false;
      }, { timeout: 120_000 }).toBe(true);
      await teaching.getByRole("button", { name: /Load current page|读取当前页讲解/ }).click();
      const tts = teaching.locator(".courseware-tts-tasks");
      if (resumePaid) await tts.getByRole("button", { name: /读取本页配音任务|Load this page's audio tasks/ }).click();
      else {
        await tts.getByRole("button", { name: /读取可用模型与音色|Load available models/ }).click();
        await tts.locator("select").nth(0).selectOption("speech-1");
        await tts.locator("select").nth(1).selectOption("doubao-courseware");
        const voice = await tts.locator("select").nth(2).evaluate((select) => [...select.options].map((entry) => entry.value).find(Boolean));
        assert(voice, "Platform offered no voice");
        await tts.locator("select").nth(2).selectOption(voice);
        await tts.getByRole("button", { name: /查看报价|Get quote/ }).click();
        await expect(tts).toContainText(/最高 1 积分|Maximum 1 point/);
        report.quotedVoice = voice;
        await tts.getByRole("checkbox", { name: /确认按此费用上限|Confirm this fee/ }).check();
        const marker = await open(process.env.DECKWISE_E2E_PAID_MARKER, "wx", 0o600);
        await marker.writeFile(JSON.stringify({ sourceSha256: hash(await readFile(source)), model: "doubao-courseware", voice }));
        await marker.close();
        await tts.getByRole("button", { name: /确认费用并生成配音|Confirm fee and generate/ }).click();
      }
      const article = tts.locator("article").filter({ hasText: "doubao-courseware" });
      await expect(article).toHaveCount(1, { timeout: 30_000 });
      for (let attempt = 0; attempt < 180 && !await article.getByText(/音频可获取|Audio available/).isVisible(); attempt++) {
        if (await article.getByText(/生成失败|Generation failed/).isVisible()) throw new Error("Platform TTS failed");
        await article.getByRole("button", { name: /查询状态|Check status/ }).click();
        await page.waitForTimeout(1000);
      }
      await expect(article).toContainText(/音频可获取|Audio available/);
      await article.getByRole("button", { name: /获取并校验音频|Retrieve and verify audio/ }).click();
      await expect(article).toContainText(/音频已校验并保存|Audio verified/);
      await article.getByRole("checkbox", { name: /将这份音频应用|Apply this audio/ }).check();
      await article.getByRole("button", { name: /采用配音|Adopt audio/ }).click();
      await teaching.getByRole("button", { name: /确认本页教学内容|Confirm this page/ }).click();
      assert.equal(paidPosts, resumePaid ? 0 : 1);
      assert(report.audioHash && report.paidTaskId && report.remoteTask?.feeState === "settled");
      report.paidCalls = !resumePaid; report.audioFixtureOnly = false; report.realProviderAudio = true;
      report.adoptedTtsSnapshot = true;
    });
  }
  if (uiPlayback) {
    await step("WiseOffice teaching panel builds and plays the same project's provider audio", async () => {
      const source = join(workspace, ".deckwise-ppt/revisions/tts-main/r0001/document.pptx");
      if (!paidUi) await page.evaluate(async (path) => { window.__PI_CAPTURE__ = true; await window.__PI_DESKTOP__.openWorkPanelArtifact("file", path); }, source);
      await expect(page.locator(".courseware-teaching")).toBeVisible({ timeout: 120_000 });
      await expect.poll(async () => {
        const office = app.context().pages().find((target) => target.url().startsWith("deckwise-editor:"));
        if (!office) return false;
        for (const frame of office.frames())
          if (await frame.evaluate(() => Boolean(window.Asc?.editor?.isLoadFullApi && window.Asc.editor.isDocumentLoadComplete)).catch(() => false)) return true;
        return false;
      }, { timeout: 120_000 }).toBe(true);
      await page.locator(".courseware-teaching").getByRole("button", { name: /Load current page|读取当前页讲解/ }).click();
      const preview = page.locator(".courseware-playback");
      const buildButton = preview.getByRole("button", { name: /Build preview|构建预览/, exact: true });
      try { await expect(buildButton).toBeEnabled({ timeout: 20_000 }); }
      catch (failure) {
        report.teachingPanel = await page.locator(".courseware-teaching").innerText();
        await page.screenshot({ path: join(out, "teaching-panel-failure.png") });
        throw failure;
      }
      await buildButton.click();
      const continueButton = preview.getByRole("button", { name: /Continue building|确认并继续构建/ });
      const playButton = preview.getByRole("button", { name: /Play preview|播放预览/ });
      await expect.poll(async () => {
        const error = await preview.getByRole("alert").textContent().catch(() => "");
        if (error) throw new Error(error);
        if (await playButton.isVisible()) return "ready";
        if (await continueButton.isVisible()) return "review";
        return "pending";
      }, { timeout: 60_000 }).not.toBe("pending");
      if (await continueButton.isVisible()) {
        for (const checkbox of await preview.getByRole("checkbox").all()) await checkbox.check();
        await continueButton.click();
      }
      await expect(playButton).toBeEnabled({ timeout: 60_000 });
      await page.screenshot({ path: join(out, "visible-build-ready.png") });
      await app.context().addInitScript(() => {
        window.__nativeAudioEvents = [];
        const original = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function (...args) {
          for (const type of ["playing", "ended", "error"])
            this.addEventListener(type, () => window.__nativeAudioEvents.push(type), { once: true });
          return original.apply(this, args);
        };
      });
      const opened = app.waitForEvent("window");
      await playButton.click();
      player = await opened;
      await expect(player.locator("header")).toContainText(`1 / ${report.pageCount}`);
      const asset = await player.evaluate(async () => {
        const selected = await window.deckwiseFixedPlayer.readPackage();
        const pkg = JSON.parse(new TextDecoder().decode(selected.bytes));
        const audio = pkg.assets.find((entry) => entry.mimeType === "audio/mpeg");
        return audio && Array.from(await window.deckwiseFixedPlayer.readAsset(audio.id));
      });
      assert(asset && hash(Buffer.from(asset)) === report.audioHash);
      await player.getByRole("button", { name: /播放|Play/, exact: true }).click();
      await expect(player.getByRole("status")).toContainText(/播放完成|Playback complete/, { timeout: 30_000 });
      report.audioEvents = await player.evaluate(() => window.__nativeAudioEvents);
      assert.deepEqual(report.audioEvents, ["playing", "ended"]);
      await player.screenshot({ path: join(out, "visible-player-complete.png") });
      report.userVisibleBuildButton = true;
    });
    report.status = "PASS_DESKTOP_VISIBLE_PROVIDER_AUDIO_PLAYBACK";
  } else if (process.env.DECKWISE_E2E_EXPECT_BLOCK_CODE) {
    await step("Actual Desktop IPC names the blocking page and refuses a playable build", async () => {
      await assert.rejects(invoke("coursewareFixedBuild", selected),
        new RegExp(`CONTENT_ERROR.*${process.env.DECKWISE_E2E_EXPECT_BLOCK_CODE}.*第 9 页`));
      await assert.rejects(invoke("coursewareFixedPlay", { previewId: "blocked", locale: "zh-CN" }), /expired/);
    });
    report.status = "PASS_DESKTOP_CONTENT_BLOCKED";
  } else {
  await step("Finite Main IPC reviews exact warnings and builds using the real offline converter", async () => {
    await assert.rejects(invoke("coursewareFixedBuild", { ...selected, sourcePath: "/etc/passwd" }), /Invalid immutable/);
    build = await approvedBuild();
    const pkg = await readFile(join(fixture.temp, "data/courseware-builds", build.buildRef.buildId, "package.json"));
    assert.equal(hash(pkg), build.buildRef.buildId);
    assert.equal(build.buildRef.packageSha256, hash(pkg));
    if (ttsAudio) {
      const value = JSON.parse(pkg);
      const audio = value.assets.find((asset) => asset.id === `tts-${fixture.audioHash}`);
      assert(audio); assert.equal(hash(await readFile(join(fixture.temp, "data/courseware-builds", build.buildRef.buildId, audio.path))), fixture.audioHash);
      assert(!pkg.toString().includes("Edited after dispatch"));
      assert(pkg.toString().includes(process.env.DECKWISE_TTS_REAL_AUDIO_TEXT || "Good! 小朋友😀"));
    }
    report.build = build;
    await writeFile(join(out, "ready.json"), JSON.stringify(build, null, 2));
  });
  await step("Dedicated sandboxed player mounts the compiled package with local fonts and finite assets", async () => {
    await app.context().addInitScript(() => {
      window.__nativeAudioEvents = [];
      const original = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function (...args) {
        if (!this.__observed) {
          this.__observed = true;
          for (const type of ["playing", "ended", "error"]) this.addEventListener(type, () => window.__nativeAudioEvents.push({ type, time: this.currentTime, src: this.currentSrc }));
        }
        return original.apply(this, args);
      };
    });
    await openPlayer();
    const isolation = await player.evaluate(() => ({ require: typeof window.require, desktop: typeof window.piDesktop,
      bridge: Object.keys(window.deckwiseFixedPlayer), fonts: [...document.querySelectorAll('link[href*="courseware-fonts"]')].length }));
    assert.equal(isolation.require, "undefined");
    assert.equal(isolation.desktop, "undefined");
    assert.equal(isolation.fonts, 11);
    assert(isolation.bridge.includes("readPackage"));
    assert(isolation.bridge.includes("readAsset"));
    const preferences = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith("courseware-player.html")).webContents.getLastWebPreferences());
    assert.equal(preferences.sandbox, true); assert.equal(preferences.contextIsolation, true); assert.equal(preferences.nodeIntegration, false);
    await assert.rejects(player.evaluate(() => window.deckwiseFixedPlayer.readAsset("../../etc/passwd")), /not in the selected/);
    assert.equal(await player.evaluate(() => fetch("https://example.invalid/denied").then(() => false, () => true)), true);
    await expect(player.locator("header")).toContainText(`1 / ${report.pageCount}`);
    await player.screenshot({ path: join(out, "player-ready.png") });
    report.isolation = isolation;
  });
  await step("A user gesture plays adopted audio bytes and page navigation stays functional", async () => {
    await player.getByRole("button", { name: "播放", exact: true }).click();
    await expect.poll(() => player.evaluate(() => window.__nativeAudioEvents.some((event) => event.type === "ended")), { timeout: 15_000 }).toBe(true);
    report.audioEvents = await player.evaluate(() => window.__nativeAudioEvents);
    assert(report.audioEvents.some((event) => event.type === "playing"));
    assert(!report.audioEvents.some((event) => event.type === "error"));
    await expect(player.getByRole("status")).toContainText("播放完成");
    await player.getByRole("button", { name: "下一页", exact: true }).click();
    await expect(player.locator("header")).toContainText(`2 / ${report.pageCount}`);
    await player.getByRole("button", { name: "上一页", exact: true }).click();
    await expect(player.locator("header")).toContainText(`1 / ${report.pageCount}`);
  });
  await step("Changed asset bytes reject on read; no live-file fallback", async () => {
    const pkg = JSON.parse(await readFile(join(fixture.temp, "data/courseware-builds", build.buildRef.buildId, "package.json"), "utf8"));
    const asset = pkg.assets.find((entry) => entry.mimeType === (process.env.DECKWISE_TTS_REAL_AUDIO_PATH ? "audio/mpeg" : "audio/wav")); assert(asset);
    const path = join(fixture.temp, "data/courseware-builds", build.buildRef.buildId, asset.path);
    const original = await readFile(path);
    try {
      await writeFile(path, "corrupt fixture audio");
      await assert.rejects(player.evaluate((id) => window.deckwiseFixedPlayer.readAsset(id), asset.id), /hash changed/);
    } finally { await writeFile(path, original); }
  });
  await step("Chat changes close playback and expire old preview selections", async () => {
    const other = (await invoke("sessionList")).sessions.find((session) => session.id !== selected.sessionId); assert(other);
    const closed = player.waitForEvent("close");
    await page.evaluate((id) => window.__PI_DESKTOP__.selectSession(id), other.id);
    await invoke("notificationSetViewingSession", { sessionId: other.id });
    await closed;
    await assert.rejects(invoke("coursewareFixedPlay", { previewId: build.previewId, locale: "zh-CN" }), /expired/);
    await assert.rejects(invoke("coursewareFixedBuild", selected), /owner changed/);
  });
  await step("Renderer reload closes the independent playback window", async () => {
    await page.evaluate((id) => window.__PI_DESKTOP__.selectSession(id), selected.sessionId);
    await invoke("notificationSetViewingSession", { sessionId: selected.sessionId });
    build = await approvedBuild(); await openPlayer();
    const closed = player.waitForEvent("close"); await page.reload(); await closed;
  });
  await step("Host process exit immediately closes playback and invalidates its selection", async () => {
    await page.waitForFunction(() => !!window.__PI_DESKTOP__);
    await invoke("projectSet", workspace);
    await page.evaluate((id) => window.__PI_DESKTOP__.selectSession(id), selected.sessionId);
    await invoke("notificationSetViewingSession", { sessionId: selected.sessionId });
    build = await approvedBuild(); await openPlayer();
    const { stdout } = await run("ps", ["--ppid", String(app.process().pid), "-o", "pid=,args="]);
    const children = stdout.trim().split("\n").map((line) => line.trim().match(/^(\d+)\s+(.*)$/)).filter(Boolean)
      .filter((match) => match[2] === fixtureEnv.PI_DESKTOP_HOST_BIN);
    assert.equal(children.length, 1, "Terminate only this test Electron's exact Host child");
    const closed = player.waitForEvent("close"); process.kill(Number(children[0][1]), "SIGTERM"); await closed;
    await assert.rejects(invoke("coursewareFixedPlay", { previewId: build.previewId, locale: "zh-CN" }), /expired/);
  });
  report.status = ttsAudio ? "PASS_DESKTOP_ADOPTED_TTS_PLAYBACK_FIXTURE" : "PASS_DESKTOP_FIXED_PLAYBACK_FIXTURE";
  }
} catch (error) {
  report.status = "FAIL"; report.error = error.stack; process.exitCode = 1;
} finally {
  report.paidCalls = paidPosts > 0;
  if (app) {
    const exited = new Promise((resolve) => app.process().once("exit", resolve));
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await exited;
  }
  if (authServer) await new Promise((resolve) => authServer.close(resolve));
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(join(out, "desktop.log"), logs.join(""));
}
