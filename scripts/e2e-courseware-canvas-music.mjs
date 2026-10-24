#!/usr/bin/env node
/** Source Electron/Main/auth/Host music lifecycle; Platform and suppliers are loopback fixtures. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index], value = process.argv[index + 1];
  assert(["--app", "--host", "--evidence-dir"].includes(key) && value && !Object.hasOwn(options, key),
    "Usage: --app <source-app-directory> --host <host-binary> --evidence-dir <new-directory>"); options[key] = value;
}
assert(!process.env.DECKWISE_E2E_PACKAGE_ROOT, "This source gate does not certify a packaged application");
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = resolve(options["--app"] ?? join(repository, "apps/desktop"));
const hostPath = options["--host"] ?? process.env.PI_DESKTOP_HOST_BIN;
assert(hostPath, "Provide --host or PI_DESKTOP_HOST_BIN");
const directory = await mkdtemp(join(tmpdir(), "deckwise-canvas-music-"));
const out = resolve(options["--evidence-dir"] ?? join(directory, "evidence"));
await mkdir(dirname(out), { recursive: true }); await mkdir(out);
const workspace = join(directory, "workspace"); await mkdir(workspace);
const { _electron, expect } = createRequire(new URL("../packages/courseware-runtime/package.json", import.meta.url))("@playwright/test");
const bytes = await readFile(join(repository, "apps/desktop/test/fixtures/courseware-tts-tone.mp3"));
const digest = value => createHash("sha256").update(value).digest("hex");
const artifacts = await Promise.all([join(appDir, "out/main/index.js"), join(appDir, "out/preload/index.cjs"),
  join(appDir, "out/renderer/index.html"), resolve(hostPath),
  ...(await readdir(join(appDir, "out/renderer/assets"))).filter(name => /^index-.*\.js$/u.test(name)).map(name => join(appDir, "out/renderer/assets", name)),
].map(async path => { const value = await readFile(path); return { path, bytes: value.length, sha256: digest(value) }; }));
const report = { status: "RUNNING", checks: [], directory, artifacts, paidCalls: false, identityFixture: true,
  platformFixture: true, supplierFixture: true, realSpringPlatform: false, modelCalls: false, packaged: false, sandbox: "--no-sandbox" };
const http = [], logs = [], tasks = new Map(), posted = [];
const token = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
const candidateIds = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
const lyrics = "One, two, three!\nCount together with me.";
let app, page, sessionId, providerId, draftId, original, exported, saved;
let generationPosts = 0, exportPosts = 0, previewReads = 0, assetReads = 0, refuseMedia = false;
const requestHash = request => {
  const fields = [request.kind, request.model, request.input, null];
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
    assert(!refuseMedia, "After restart, archived music must not access Platform media routes");
    if (url.pathname === "/courseware/media/models") {
      assert.equal(request.method, "GET"); const kind = url.searchParams.get("kind"); assert(["music", "music-export"].includes(kind));
      return send([{ model: kind === "music" ? "canvas-music" : "canvas-mp3", voices: [], providerDefaultVoice: false }]);
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
  app = await _electron.launch({ executablePath: process.env.ELECTRON_EXECUTABLE ?? resolveElectronBinary(repository).electronBinary,
    cwd: appDir, args: ["--no-sandbox", `--user-data-dir=${join(directory, "profile")}`, appDir],
    env: { ...env, ELECTRON_RUN_AS_NODE: "", ELECTRON_RENDERER_URL: "", PI_DESKTOP_DATA_DIR: join(directory, "data"),
      PI_DESKTOP_HOST_BIN: resolve(hostPath), DECKWISE_PLATFORM_BASE_URL: `http://127.0.0.1:${server.address().port}`, PI_DESKTOP_START_MAXIMIZED: "0" }, timeout: 60_000 });
  for (const stream of [app.process().stdout, app.process().stderr]) stream.on("data", value => logs.push(String(value)));
  page = await app.firstWindow({ timeout: 60_000 }); page.on("pageerror", failure => logs.push(`PAGEERROR ${failure.stack}`));
  await page.waitForFunction(() => !!window.piDesktop);
  await app.evaluate(({ session, BrowserWindow }) => {
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url); callback({ cancel: /^https?:$/u.test(url.protocol) && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) });
    }); BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1600, height: 1100 });
  });
  await page.waitForFunction(() => !!window.__PI_DESKTOP__ && !document.querySelector(".auth-shell"), null, { timeout: 60_000 });
  assert.equal((await invoke("authRestore")).status, "authenticated");
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
try {
  await step("Actual login and courseware selector save a music title and lyrics through Main and Host", async () => {
    await start(); await page.evaluate(() => window.__PI_DESKTOP__.openNewWorkPanelTab());
    await page.locator('[data-work-panel-launcher-item="ppt-master"]').click();
    await page.getByRole("button", { name: "普通 PPT 生成", exact: true }).click();
    await expect.poll(async () => (await invoke("coursewareTaskGet", { sessionId })).task?.taskType).toBe("plain");
    await openCanvas(); await canvas().getByRole("button", { name: "Add music", exact: true }).click();
    await properties().getByRole("textbox", { name: "Name", exact: true }).fill("Counting song");
    await properties().getByRole("textbox", { name: "Lyrics", exact: true }).fill(lyrics);
    await expect.poll(async () => (await invoke("coursewareMediaCanvasGet", { sessionId })).document?.drafts[0]?.prompt).toBe(lyrics);
    draftId = (await invoke("coursewareMediaCanvasGet", { sessionId })).document.drafts[0].id;
  });
  await step("Visible styles and quote make no POST until exact generation cost consent", async () => {
    await music().getByRole("button", { name: "Load music models", exact: true }).click();
    await music().getByRole("combobox", { name: "Saved music draft", exact: true }).selectOption(draftId);
    await music().getByRole("combobox", { name: "Music generation model", exact: true }).selectOption("canvas-music");
    await music().getByRole("combobox", { name: "MP3 export model", exact: true }).selectOption("canvas-mp3");
    await music().getByRole("textbox", { name: "Style / tags", exact: true }).fill("playful piano");
    await music().getByRole("textbox", { name: "Styles to avoid", exact: true }).fill("heavy metal");
    await music().getByRole("button", { name: "Prepare music and get quote", exact: true }).click();
    await expect(music().getByText(/Maximum: 5 points/u)).toBeVisible();
    await expect(music().getByRole("button", { name: "Confirm and generate music", exact: true })).toBeDisabled();
    assert.equal(generationPosts, 0); assert.equal(exportPosts, 0);
    original = (await read()).find(value => value.operation === "music"); assert(original); assert.equal(original.draft.prompt, lyrics);
    await music().screenshot({ path: join(out, "music-generation-quote.png") });
    await music().getByRole("checkbox", { name: "I approve this maximum cost and sending the exact saved lyrics, title and styles to the music provider.", exact: true }).check();
    await music().getByRole("button", { name: "Confirm and generate music", exact: true }).click();
    await expect(row()).toContainText("Task: queued"); assert.equal(generationPosts, 1); assert.equal(exportPosts, 0);
  });
  await step("Both original candidates listen through actual MP3 decoder without export or another charge", async () => {
    ready("music"); await row().getByRole("button", { name: "Check original task status", exact: true }).click();
    await expect(row().locator("[data-music-candidate]")).toHaveCount(2);
    for (let index = 0; index < 2; index++) {
      await candidate(index).getByRole("button", { name: "Listen to original candidate", exact: true }).click();
      await verifyAudio(candidate(index).locator("audio"));
    }
    assert.equal(previewReads, 2); assert.equal(assetReads, 0); assert.equal(generationPosts, 1); assert.equal(exportPosts, 0);
    await row().screenshot({ path: join(out, "two-original-candidates.png") });
  });
  await step("Only the selected candidate receives a separate MP3 quote, confirmation and archived export", async () => {
    await candidate(1).getByRole("button", { name: "Get separate MP3 export quote", exact: true }).click();
    await expect(music().getByText(/Maximum: 2 points/u)).toBeVisible();
    await expect(music().getByRole("button", { name: "Confirm and export MP3", exact: true })).toBeDisabled();
    exported = (await read()).find(value => value.operation === "music-export"); assert(exported); assert.equal(exported.candidateId, candidateIds[1]);
    assert.equal(exportPosts, 0); await music().screenshot({ path: join(out, "separate-export-quote.png") });
    await music().getByRole("checkbox", { name: "I approve this separate maximum cost for exporting only the displayed candidate as MP3.", exact: true }).check();
    await music().getByRole("button", { name: "Confirm and export MP3", exact: true }).click();
    await expect(exportRow()).toContainText("queued"); assert.equal(exportPosts, 1); ready("music-export");
    await exportRow().getByRole("button", { name: "Check original task status", exact: true }).click();
    await exportRow().getByRole("button", { name: "Download and archive exported MP3", exact: true }).click();
    await verifyAudio(exportRow().locator("audio")); assert.equal(assetReads, 1); assert.equal(previewReads, 2);
    saved = await read(); assert.equal(saved.length, 2); assert.equal(saved.find(value => value.operation === "music").previews.length, 2);
    assert.equal(saved.find(value => value.operation === "music-export").asset.sha256, digest(bytes));
    await row().screenshot({ path: join(out, "archived-selected-export.png") });
  });
  await step("Full Electron and Host restart plays all three local archives with zero remote media requests", async () => {
    refuseMedia = true; const before = http.length; await stop(); await start(); await openCanvas();
    await music().getByRole("button", { name: "Refresh music attempts", exact: true }).click(); assert.deepEqual(await read(), saved);
    for (let index = 0; index < 2; index++) {
      await candidate(index).getByRole("button", { name: "Listen to original candidate", exact: true }).click(); await verifyAudio(candidate(index).locator("audio"));
    }
    await exportRow().getByRole("button", { name: "Download and archive exported MP3", exact: true }).click(); await verifyAudio(exportRow().locator("audio"));
    assert.equal(previewReads, 2); assert.equal(assetReads, 1); assert.equal(generationPosts, 1); assert.equal(exportPosts, 1);
    assert(!http.slice(before).some(value => value.path.startsWith("/courseware/media/")));
    await row().screenshot({ path: join(out, "restarted-local-music.png") });
  });
  await step("A historical exportable candidate can obtain a new explicit export quote after List-only recovery", async () => {
    refuseMedia = false; const before = http.length;
    await music().getByRole("button", { name: "Load music models", exact: true }).click();
    await music().getByRole("combobox", { name: "MP3 export model", exact: true }).selectOption("canvas-mp3");
    await candidate(0).getByRole("button", { name: "Get separate MP3 export quote", exact: true }).click();
    await expect(music().getByText(/Maximum: 2 points/u)).toBeVisible();
    await expect(music().getByRole("button", { name: "Confirm and export MP3", exact: true })).toBeDisabled();
    assert.equal(exportPosts, 1); assert.equal(generationPosts, 1);
    assert(!http.slice(before).some(value => value.path.startsWith("/courseware/media/tasks/")), "Historical export preparation does not require remote status");
    saved = await read(); assert.equal(saved.length, 3);
    assert(saved.some(value => value.operation === "music-export" && value.candidateId === candidateIds[0] && value.phase === "prepared"));
    await music().screenshot({ path: join(out, "historical-export-quote-unconfirmed.png") });
  });
  assert(!(await readdir(workspace, { recursive: true })).some(path => path.endsWith(".pptx")), "Music candidates never mutate slides");
  assert(!logs.some(value => /PAGEERROR|FIXTUREERROR/u.test(value)), "No renderer or fixture errors");
  report.status = "PASS_MUSIC_CANVAS_MAIN_HOST_LOCAL_RESTART"; report.sessionId = sessionId; report.intents = saved;
} catch (failure) {
  report.status = "FAIL"; report.error = String(failure.stack); console.error(failure); process.exitCode = 1;
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(out, "failure.png") }).catch(() => {});
    await writeFile(join(out, "failure-aria.txt"), await page.locator("body").ariaSnapshot()).catch(() => {});
  }
} finally {
  await stop(); await new Promise(resolve => server.close(resolve));
  Object.assign(report, { generationPosts, exportPosts, previewReads, assetReads, posted });
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(join(out, "http.json"), JSON.stringify(http, null, 2) + "\n");
  await writeFile(join(out, "main.log"), logs.join("\n"));
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, out, directory, generationPosts, exportPosts, previewReads, assetReads }));
}
