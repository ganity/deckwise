/** Continue a real generated scene through the shared teaching/TTS/player UI; HTTP identity/audio are fixtures. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { coursewareLaunch } from "./e2e/boot.mjs";
import { authorSceneEffects, reassociateSceneEffects } from "./e2e/scene-effects.mjs";

assert(process.env.DECKWISE_E2E_OUTPUT && process.env.DECKWISE_E2E_SCENE_SOURCE_REPORT);
assert(process.env.DECKWISE_EDITOR_URL);
if (!process.env.DECKWISE_E2E_PACKAGE_ROOT) assert(process.env.PI_DESKTOP_HOST_BIN && process.env.DECKWISE_PPTX_WORKER);
const reassociate = process.env.DECKWISE_E2E_SCENE_REASSOCIATE === "1";
const input = JSON.parse(await readFile(process.env.DECKWISE_E2E_SCENE_SOURCE_REPORT, "utf8"));
const effects = reassociate || process.env.DECKWISE_E2E_SCENE_EFFECTS === "1";
assert.equal(input.status, effects ? "PASS_SCENE_REVIEW_COMPILE_INITIAL_SOURCE" : "PASS_SCENE_REVIEW_COMPILE_NATIVE_EDIT_SAVE_RESTART");
const out = resolve(process.env.DECKWISE_E2E_OUTPUT);
await mkdir(dirname(out), { recursive: true }); await mkdir(out);
const launch = coursewareLaunch();
assert.equal(input.packaged, launch.packaged, "Continue with the same source or packaged runtime mode");
const { _electron, expect } = createRequire(new URL("../packages/courseware-runtime/package.json", import.meta.url))("@playwright/test");
const workspace = join(input.directory, "workspace");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
let sourceHash = hash(await readFile(input.generatedPath));
assert.equal(sourceHash, input.savedSha256);
const report = { status: "RUNNING", checks: [], sourceReport: resolve(process.env.DECKWISE_E2E_SCENE_SOURCE_REPORT),
  paidCalls: false, identityFixture: true, platformFixture: true, audioFixture: "native PCM/WAV tones, not matching synthesized speech",
  packaged: launch.packaged, sandbox: "--no-sandbox", directory: input.directory, sourceSha256: sourceHash,
  reassociate };
const logs = [], http = [], tasks = new Map(), audio = new Map();
let app, page, sdk, player, sessionId, submitted = 0;
const token = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
function wav(frequency) {
  const rate = 8000, samples = effects ? 16000 : 2400, bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(5000 * Math.sin(i * frequency * 2 * Math.PI / rate)), 44 + i * 2);
  return bytes;
}
const requestHash = request => createHash("sha256").update("courseware-media-v1" +
  [request.kind, request.model, request.input, request.voice ?? null].map(v => `:${v === null ? -1 : v.length}:${v ?? ""}`).join("")).digest("hex");
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    http.push({ method: req.method, path: url.pathname });
    const send = data => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ code: 200, data })); };
    if (url.pathname === "/auth/desktop/wx/qrcode") return send({ ticket: "scene-playback", entryUrl: "https://fixture.test/qr" });
    if (["/auth/desktop/refresh", "/auth/refresh", "/auth/wx/poll/scene-playback"].includes(url.pathname))
      return send({ status: "SUCCESS", accessToken: token, refreshToken: "scene-playback-refresh" });
    if (url.pathname === "/auth/me") return send({ edition: "EDUCATION", pcAllowed: true, role: "ADMIN", tenantId: 8, userId: 7 });
    if (url.pathname === "/auth/logout") return send({});
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    if (url.pathname === "/courseware/team/projects") return send([]);
    if (url.pathname === "/courseware/media/models") {
      assert.equal(url.searchParams.get("kind"), "tts");
      return send([{ model: "scene-speech", voices: ["classroom"], providerDefaultVoice: false }]);
    }
    if (url.pathname === "/courseware/media/models/scene-speech/quote") {
      const expiry = Math.floor(Date.now() / 1000) + 300;
      return send({ version: "courseware-media-quote-v1", kind: "tts", model: "scene-speech", priceVersion: "scene-speech-v1",
        maxPoints: 1, maxChars: 2500, expiresAt: new Date(expiry * 1000).toISOString(), quoteToken: `${expiry}.${"a".repeat(43)}` });
    }
    if (url.pathname === "/courseware/media/tasks/confirmed" && req.method === "POST") {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw), request = body.request;
      assert.equal(request.kind, "tts"); assert.equal(request.model, "scene-speech"); assert.equal(request.voice, "classroom");
      assert.equal(body.confirmation.maxPoints, 1); assert.equal(body.confirmation.priceVersion, "scene-speech-v1");
      assert(!/teacher_continue|checkpoint|等待|停顿/u.test(request.input), "Wait instructions must not be synthesized");
      const key = req.headers["idempotency-key"];
      assert(!tasks.has(key), "No duplicate submit is allowed"); assert(++submitted <= 2, "Only one explicit request per page");
      const taskId = `scene-speech-${submitted}`, bytes = wav(submitted * 220);
      audio.set(taskId, bytes);
      const task = { version: "courseware-media-v1", kind: "tts", taskId, idempotencyKey: key, requestHash: requestHash(request),
        model: request.model, state: "ready", feeState: "settled", reservedPoints: 1, actualPoints: 1, errorCode: null,
        receiptId: `courseware-media:${taskId}`, assetRef: { assetId: `asset-${taskId}`, sha256: hash(bytes), mime: "audio/wav",
          byteLength: bytes.length, durationMs: effects ? 2000 : 300, downloadPath: `/courseware/media/tasks/${taskId}/asset` } };
      tasks.set(key, { task, input: request.input }); return send(task);
    }
    if (url.pathname === "/courseware/media/tasks/by-idempotency") {
      const entry = tasks.get(url.searchParams.get("key")); assert(entry); return send(entry.task);
    }
    const match = /^\/courseware\/media\/tasks\/(scene-speech-[12])(\/asset)?$/u.exec(url.pathname);
    if (match) {
      const task = [...tasks.values()].find(entry => entry.task.taskId === match[1])?.task;
      assert(task);
      if (match[2]) { res.setHeader("content-type", "audio/wav"); return res.end(audio.get(match[1])); }
      return send(task);
    }
    throw new Error(`Unexpected fixture request: ${req.method} ${url.pathname}`);
  } catch (error) { logs.push(`FIXTUREERROR ${error.stack}`); res.statusCode = 500; res.end("Fixture error"); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
report.fixturePlatformOrigin = `http://127.0.0.1:${server.address().port}`;
const invoke = (name, ...args) => page.evaluate(async ({ name, args }) => {
  const result = await window.piDesktop.invoke(window.piDesktop.channels.invoke[name], ...args);
  if (!result.ok) throw new Error(JSON.stringify(result.error)); return result.data;
}, { name, args });
const teaching = () => page.locator(".courseware-teaching");
async function start() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/api.?key|secret|token|password|proxy/i.test(key)));
  app = await _electron.launch({ executablePath: launch.executablePath, cwd: launch.cwd,
    args: ["--no-sandbox", `--user-data-dir=${join(input.directory, "profile")}`, ...launch.args],
    env: { ...env, ELECTRON_RUN_AS_NODE: "", ELECTRON_RENDERER_URL: "", PI_DESKTOP_DATA_DIR: join(input.directory, "data"),
      DECKWISE_PLATFORM_BASE_URL: `http://127.0.0.1:${server.address().port}`, PI_DESKTOP_START_MAXIMIZED: "0" }, timeout: 60_000 });
  for (const stream of [app.process().stdout, app.process().stderr]) stream.on("data", bytes => logs.push(String(bytes)));
  page = await app.firstWindow({ timeout: 60_000 });
  page.on("pageerror", error => logs.push(`PAGEERROR ${error.stack}`));
  await page.waitForFunction(() => !!window.piDesktop);
  report.runtime = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, appPath: app.getAppPath() }));
  assert.equal(report.runtime.packaged, launch.packaged);
  await app.evaluate(({ session, BrowserWindow }) => {
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url);
      callback({ cancel: /^https?:$/.test(url.protocol) && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) });
    });
    BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1500, height: 1050 });
  });
  await page.waitForFunction(() => !!window.__PI_DESKTOP__ && !document.querySelector(".auth-shell"), null, { timeout: 60_000 });
  await invoke("projectSet", workspace);
  if (!sessionId) {
    for (const session of (await invoke("sessionList")).sessions) {
      const result = await invoke("coursewareTaskGet", { sessionId: session.id });
      if (result.task?.generatedPath === input.generatedPath) { sessionId = session.id; break; }
    }
    assert(sessionId, "The generated scene must retain its owning Chat task");
  }
  await page.evaluate(async ({ id, path }) => {
    window.__PI_CAPTURE__ = true; await window.__PI_DESKTOP__.selectSession(id);
    await window.__PI_DESKTOP__.openWorkPanelArtifact("file", path);
  }, { id: sessionId, path: input.generatedPath });
  await expect(teaching()).toBeVisible({ timeout: 120_000 });
  await expect.poll(async () => {
    const editor = app.context().pages().find(target => target.url().startsWith("deckwise-editor:"));
    if (!editor) return false;
    for (const frame of editor.frames())
      if (await frame.evaluate(() => !!window.Asc?.editor?.isDocumentLoadComplete).catch(() => false)) { sdk = frame; return true; }
    return false;
  }, { timeout: 120_000 }).toBe(true);
  await teaching().getByRole("button", { name: "读取当前页讲解", exact: true }).click();
  await teachingReady();
}
async function teachingReady() {
  await expect(teaching().getByRole("button", { name: "读取当前页讲解", exact: true })).toBeEnabled({ timeout: 120_000 });
  const errors = await teaching().getByRole("alert").allTextContents(); assert.deepEqual(errors, []);
  await expect(teaching().getByRole("spinbutton", { name: "段后停顿（毫秒）", exact: true })).toBeEnabled();
}
async function readTeaching() {
  await teachingReady();
  const view = await invoke("pptEditorTeachingOpen", { sessionId });
  // A direct inspection creates a fresh coordinator view; reload the UI before its next write.
  await teaching().getByRole("button", { name: "读取当前页讲解", exact: true }).click();
  await teachingReady();
  return view;
}
async function stop() {
  if (!app) return;
  const process = app.process();
  if (process.exitCode === null && process.signalCode === null) {
    const exited = new Promise(resolve => process.once("exit", resolve));
    await app.evaluate(({ app }) => app.exit(0)); await exited;
  }
  app = null;
}
async function pageNumber(number) {
  await sdk.evaluate(number => window.Asc.editor.goToPage(number - 1), number);
  await expect(teaching().getByText(`第 ${number} 页讲解`, { exact: true })).toBeVisible({ timeout: 30_000 });
  await teachingReady();
}
async function saveTeaching() {
  const button = teaching().getByRole("button", { name: "保存讲解", exact: true });
  await expect(button).toBeEnabled(); await button.click();
  await expect(button).toBeDisabled();
  await teachingReady();
  const errors = await teaching().getByRole("alert").allTextContents(); assert.deepEqual(errors, []);
}
async function ttsPage(number) {
  await pageNumber(number);
  const tts = teaching().locator(".courseware-tts-tasks");
  await tts.getByRole("button", { name: "读取可用模型与音色", exact: true }).click();
  const select = tts.locator("select");
  const value = await select.nth(0).locator("option").nth(1).getAttribute("value"); assert(value);
  await select.nth(0).selectOption(value); await select.nth(1).selectOption("scene-speech"); await select.nth(2).selectOption("classroom");
  await tts.getByRole("button", { name: "查看报价（不扣费）", exact: true }).click();
  const submit = tts.getByRole("button", { name: "确认费用并生成配音", exact: true });
  await expect(submit).toBeDisabled();
  await tts.getByRole("checkbox", { name: /确认按此费用上限/ }).check(); await submit.click();
  const task = tts.locator("article").filter({ hasText: "scene-speech" });
  await expect(task).toHaveCount(1); await expect(task).toContainText("音频可获取");
  await task.getByRole("button", { name: "获取并校验音频", exact: true }).click();
  await expect(task).toContainText("音频已校验并保存");
  await task.getByRole("checkbox", { name: /将这份音频应用/ }).check();
  await task.getByRole("button", { name: "采用配音", exact: true }).click();
  await expect(teaching().getByRole("button", { name: "确认本页教学内容", exact: true })).toBeEnabled();
}
async function step(name, action) {
  console.log("START", name); await action(); report.checks.push(name); console.log("PASS", name);
}
try {
  await step("Reopen the same generated scene in the existing WiseOffice teaching surface", async () => {
    await start();
    const view = await readTeaching();
    assert.equal(view.project.taskType, "scene"); assert.equal(view.project.source.sha256, sourceHash);
    assert.equal(view.project.pages.length, 2); report.baseline = view.project;
    assert.deepEqual(view.project.pages.map(p => p.actions.filter(a => a.type === "speech").map(a => a.text)),
      input.associatedTeaching.pages.map(p => p.actions.filter(a => a.type === "speech").map(a => a.text)));
  });
  await step("Visible timing controls add a silent pause and an explicit teacher-continue checkpoint", async () => {
    while (await teaching().getByRole("button", { name: "删除等待", exact: true }).count())
      await teaching().getByRole("button", { name: "删除等待", exact: true }).first().click();
    await teaching().getByRole("spinbutton", { name: "段后停顿（毫秒）", exact: true }).fill("2000");
    await teaching().getByRole("button", { name: "添加等待教师继续", exact: true }).click();
    await saveTeaching();
    const view = await readTeaching();
    assert.equal(view.project.pages[0].actions[0].pauseAfterMs, 2000);
    assert.equal(view.project.pages[0].actions[1].checkpointKind, "teacher_continue");
    assert.deepEqual(view.project.pages[1], report.baseline.pages[1]);
  });
  await step("Both generated pages use the existing quoted TTS, explicit archive and audio-adoption controls", async () => {
    await ttsPage(1);
    // Editing only silence must preserve already-adopted audio bytes.
    const before = await readTeaching();
    await teaching().getByRole("spinbutton", { name: "段后停顿（毫秒）", exact: true }).fill("2200");
    await saveTeaching();
    const after = await readTeaching();
    assert.equal(after.project.pages[0].actions[0].audioAssetId, before.project.pages[0].actions[0].audioAssetId);
    await teaching().getByRole("button", { name: "确认本页教学内容", exact: true }).click();
    await teachingReady();
    await ttsPage(2);
    await teaching().getByRole("button", { name: "确认本页教学内容", exact: true }).click();
    report.adopted = (await readTeaching()).project;
    assert(report.adopted.pages.every(p => p.reviewState === "ready"));
    assert.equal(submitted, 2);
    assert.deepEqual([...tasks.values()].map(entry => entry.input), report.adopted.pages.map(p => p.actions[0].text));
  });
  if (effects) await step("Visible mapped-object highlight and spotlight controls preserve adopted audio and peer teaching", async () => {
    report.adopted = await authorSceneEffects({ page, expect, readTeaching, saveTeaching, teachingReady, pageNumber, report });
    await page.screenshot({ path: join(out, "scene-authored-effects.png") });
  });
  if (reassociate) await step("Native scene edit requires explicit page and effect-target review while preserving teaching and adopted audio", async () => {
    assert.equal(submitted, 2);
    report.adopted = await reassociateSceneEffects({ page, getSdk: () => sdk, invoke, sessionId, expect, input, out, report,
      readTeaching, teachingReady, pageNumber });
    sourceHash = report.savedSha256;
    assert.equal(submitted, 2, "Source review must reuse adopted audio without submitting media");
  });
  await step("Complete Desktop/Host/Office restart preserves scene narration, timing and adopted audio without resubmission", async () => {
    await stop(); await start();
    assert.deepEqual((await readTeaching()).project, report.adopted);
    assert.equal(submitted, 2); assert.equal(hash(await readFile(input.generatedPath)), sourceHash);
  });
  await step("Visible preview freezes the scene's exact two-page teaching and verified audio into the shared local build", async () => {
    const preview = teaching().locator(".courseware-playback");
    await preview.getByRole("button", { name: "构建预览", exact: true }).click();
    const play = preview.getByRole("button", { name: "播放预览", exact: true });
    const approve = preview.getByRole("button", { name: "确认并继续构建", exact: true });
    await expect.poll(async () => {
      const errors = await preview.getByRole("alert").allTextContents(); if (errors.length) throw new Error(errors.join("; "));
      return await play.isVisible() || await approve.isVisible();
    }, { timeout: 120_000 }).toBe(true);
    if (await approve.isVisible()) {
      report.warningReview = await preview.innerText();
      for (const checkbox of await preview.getByRole("checkbox").all()) await checkbox.check(); await approve.click();
    }
    await expect(play).toBeEnabled({ timeout: 120_000 });
    await app.context().addInitScript(() => {
      window.__sceneAudioEvents = [];
      const original = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function (...args) {
        if (!this.__sceneObserved) {
          this.__sceneObserved = true;
          for (const type of ["playing", "ended", "error"]) this.addEventListener(type, () =>
            window.__sceneAudioEvents.push({ type, at: performance.now() }));
        }
        return original.apply(this, args);
      };
    });
    const opened = app.waitForEvent("window"); await play.click(); player = await opened;
    await expect(player.locator("header")).toContainText("1 / 2");
    const frozen = await player.evaluate(async () => {
      const selected = await window.deckwiseFixedPlayer.readPackage();
      const pkg = JSON.parse(new TextDecoder().decode(selected.bytes));
      const audios = [];
      for (const asset of pkg.assets.filter(a => a.mimeType === "audio/wav"))
        audios.push({ id: asset.id, bytes: Array.from(await window.deckwiseFixedPlayer.readAsset(asset.id)) });
      return { pkg, audios };
    });
    report.package = frozen.pkg;
    assert.deepEqual(frozen.pkg.pages.map(p => p.pageId), report.adopted.pages.map(p => p.pageId));
    for (const [index, fixed] of frozen.pkg.pages.entries()) {
      const expected = report.adopted.pages[index].actions.filter(a => a.type === "speech");
      const speeches = fixed.actions.filter(a => a.type === "speech");
      assert.equal(speeches.length, expected.length);
      for (const [position, speech] of speeches.entries()) {
        for (const key of ["text", "audioAssetId", "pauseAfterMs", "visualCues"])
          assert.deepEqual(speech[key], expected[position][key]);
      }
    }
    if (effects) {
      const target = frozen.pkg.pages[0].objects.find(object => object.objectId === report.effects.objectId);
      assert(target, "Published effects must target the reviewed saved object");
      assert(frozen.pkg.pages[0].slide.elements.some(element => element.id === target.importElementId &&
        element.text?.content.includes("Circle")));
      if (reassociate) assert(!frozen.pkg.pages[0].objects.some(object => object.objectId === report.reassociation.oldTarget.objectId));
    }
    assert.equal(frozen.audios.length, 2);
    for (const asset of frozen.audios) assert.equal(hash(Buffer.from(asset.bytes)), asset.id.slice(4));
    assert.equal((await player.evaluate(() => typeof window.piDesktop)), "undefined");
    await page.screenshot({ path: join(out, "scene-build-ready.png") });
  });
  await step("Native audio pauses silently, waits for teacher input, then advances to the second page and completes", async () => {
    await player.getByRole("button", { name: "播放", exact: true }).click();
    if (effects) {
      await expect(player.locator('[data-fixed-effect="highlight"]').first()).toBeVisible({ timeout: 10_000 });
      await player.screenshot({ path: join(out, "scene-playing-highlight.png") });
      await expect(player.locator('[data-fixed-effect="spotlight"]').first()).toBeVisible({ timeout: 10_000 });
      await expect(player.locator('[data-fixed-effect="highlight"]')).toHaveCount(0);
      await player.screenshot({ path: join(out, "scene-playing-spotlight.png") });
    }
    await expect.poll(() => player.evaluate(() => window.__sceneAudioEvents.some(e => e.type === "ended")), { timeout: 15_000 }).toBe(true);
    await expect(player.getByRole("button", { name: "教师继续", exact: true })).toBeVisible({ timeout: 15_000 });
    const timing = await player.evaluate(() => ({ events: window.__sceneAudioEvents, now: performance.now() }));
    assert(timing.now - timing.events.find(e => e.type === "ended").at >= 2000, "Configured silence must precede teacher wait");
    assert.equal(timing.events.filter(e => e.type === "playing").length, 1);
    await expect(player.locator("header")).toContainText("1 / 2");
    await player.screenshot({ path: join(out, "scene-waiting-for-teacher.png") });
    await player.getByRole("button", { name: "教师继续", exact: true }).click();
    await expect(player.getByRole("status")).toContainText("播放完成", { timeout: 30_000 });
    report.audioEvents = await player.evaluate(() => window.__sceneAudioEvents);
    assert.equal(report.audioEvents.filter(e => e.type === "playing").length, 2);
    assert.equal(report.audioEvents.filter(e => e.type === "ended").length, 2);
    assert(!report.audioEvents.some(e => e.type === "error"));
    assert.equal(submitted, 2); assert.equal(hash(await readFile(input.generatedPath)), sourceHash);
    await player.screenshot({ path: join(out, "scene-playback-complete.png") });
  });
  report.status = reassociate ? "PASS_SCENE_SOURCE_EFFECT_REASSOCIATION_REAL_DESKTOP_PLAYER"
    : effects ? "PASS_SCENE_AUTHORED_EFFECTS_TTS_RESTART_PLAYBACK" : "PASS_SCENE_SHARED_TEACHING_TTS_WAIT_BUILD_PLAYBACK";
} catch (error) {
  report.status = "FAIL"; report.error = error.stack; console.error(error.stack); process.exitCode = 1;
  if (page) {
    await page.screenshot({ path: join(out, "failure.png") }).catch(() => {});
    await writeFile(join(out, "failure-aria.txt"), await page.locator("body").ariaSnapshot()).catch(() => {});
  }
} finally {
  await stop().catch(error => { report.cleanupError = error.message; process.exitCode = 1; });
  await new Promise(resolve => server.close(resolve));
  report.submitted = submitted;
  report.tasks = [...tasks.values()].map(({ task, input }) => ({ ...task, narration: input }));
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(join(out, "http.json"), JSON.stringify(http, null, 2) + "\n");
  await writeFile(join(out, "main.log"), logs.join("\n"));
}
