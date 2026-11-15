#!/usr/bin/env node
/** Source Electron/Main/auth/Host canvas image lifecycle; only HTTP suppliers and identity are fixtures. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index], value = process.argv[index + 1];
  assert(["--app", "--host", "--evidence-dir"].includes(key) && value && !Object.hasOwn(options, key),
    "Usage: --app <source-app-directory> --host <host-binary> --evidence-dir <new-directory>");
  options[key] = value;
}
assert(!process.env.DECKWISE_E2E_PACKAGE_ROOT, "This gate validates source Electron; it does not certify a package");
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = resolve(options["--app"] ?? process.env.DECKWISE_E2E_APP_DIR ?? join(repository, "apps/desktop"));
const hostPath = options["--host"] ?? process.env.PI_DESKTOP_HOST_BIN;
assert(hostPath, "Provide --host or PI_DESKTOP_HOST_BIN");
const directory = await mkdtemp(join(tmpdir(), "deckwise-canvas-images-"));
const out = resolve(options["--evidence-dir"] ?? process.env.DECKWISE_E2E_OUTPUT ?? join(directory, "evidence"));
await mkdir(dirname(out), { recursive: true }); await mkdir(out);
const workspace = join(directory, "workspace"); await mkdir(workspace);
const require = createRequire(new URL("../packages/courseware-runtime/package.json", import.meta.url));
const { _electron, expect } = require("@playwright/test");
const sharp = require("sharp");
const bytes = await Promise.all(["#40a060", "#d99d32", "#4599bd"].map(background => sharp({ create: {
  width: 320, height: 180, channels: 4, background,
} }).png().toBuffer()));
const digest = value => createHash("sha256").update(value).digest("hex");
const artifacts = await Promise.all([
  join(appDir, "out/main/index.js"), join(appDir, "out/preload/index.cjs"),
  join(appDir, "out/renderer/index.html"), resolve(hostPath),
  ...(await readdir(join(appDir, "out/renderer/assets"))).filter(name => /^index-.*\.js$/u.test(name))
    .map(name => join(appDir, "out/renderer/assets", name)),
].map(async path => { const data = await readFile(path); return { path, bytes: data.length, sha256: digest(data) }; }));
const report = { status: "RUNNING", checks: [], directory, artifacts, paidCalls: false, identityFixture: true,
  platformFixture: true, supplierFixture: true, modelCalls: false, packaged: false, sandbox: "--no-sandbox" };
const http = [], logs = [], tasks = new Map(), posted = [];
const token = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
let submissions = 0, assetReads = 0, refuseAssets = false, loseResponse = false, app, page, sessionId, providerId, draftId;
const prompts = ["A friendly rabbit in a garden", "A cheerful rabbit in a sunny garden", "The original rabbit waving hello"];
const requestHash = request => {
  const fields = [request.kind, request.model, request.input, null];
  if (request.referenceImage) fields.push(request.referenceImage.sha256, request.referenceImage.mimeType, String(request.referenceImage.byteLength));
  return digest("courseware-media-v1" + fields.map(value => `:${value === null ? -1 : value.length}:${value ?? ""}`).join(""));
};
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    http.push({ method: request.method, path: url.pathname });
    const send = (data, code = 200) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ code, data })); };
    if (url.pathname === "/auth/desktop/wx/qrcode") return send({ ticket: "canvas-images-ticket", entryUrl: "https://fixture.test/qr" });
    if (["/auth/wx/poll/canvas-images-ticket", "/auth/desktop/refresh", "/auth/refresh"].includes(url.pathname))
      return send({ status: "SUCCESS", accessToken: token, refreshToken: "canvas-images-fixture-refresh" });
    if (url.pathname === "/auth/me") return send({ edition: "EDUCATION", pcAllowed: true, role: "ADMIN", tenantId: 8, userId: 7 });
    if (url.pathname === "/auth/logout") return send({});
    if (url.pathname === "/v1/models" && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      return response.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
    }
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    if (url.pathname === "/courseware/media/models") {
      assert.equal(request.method, "GET"); assert.equal(url.searchParams.get("kind"), "image");
      return send([{ model: "canvas-image", voices: [], providerDefaultVoice: false, supportsReferenceImage: true }]);
    }
    if (url.pathname === "/courseware/media/models/canvas-image/quote") {
      assert.equal(request.method, "GET");
      const expiry = Math.floor(Date.now() / 1000) + 300;
      return send({ version: "courseware-media-quote-v1", kind: "image", model: "canvas-image", priceVersion: "image-v1",
        maxPoints: 3, maxChars: 4000, expiresAt: new Date(expiry * 1000).toISOString(), quoteToken: `${expiry}.${"a".repeat(43)}` });
    }
    if (url.pathname === "/courseware/media/tasks/confirmed" && request.method === "POST") {
      assert(submissions < 3, "Only the three visible explicit confirmations may dispatch");
      let raw = ""; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw), key = request.headers["idempotency-key"];
      assert.match(key, /^[a-f0-9-]{36}$/u); assert(!tasks.has(key), "An original media key must never POST again");
      assert.deepEqual(body.request, { kind: "image", model: "canvas-image", input: prompts[submissions],
        ...(submissions === 2 ? { referenceImage: { sha256: digest(bytes[0]), mimeType: "image/png",
          byteLength: bytes[0].length, bytesBase64: bytes[0].toString("base64") } } : {}) });
      assert.equal(body.confirmation.maxPoints, 3); assert.equal(body.confirmation.priceVersion, "image-v1");
      const task = { version: "courseware-media-v1", kind: "image", taskId: `canvas-image-task-${++submissions}`,
        idempotencyKey: key, requestHash: requestHash(body.request), model: "canvas-image", state: "queued", feeState: "reserved",
        reservedPoints: 3, actualPoints: null, errorCode: null, receiptId: null, assetRef: null };
      tasks.set(key, task); posted.push({ key, requestHash: task.requestHash, prompt: body.request.input,
        ...(body.request.referenceImage ? { referenceImage: { ...body.request.referenceImage, bytesBase64: undefined } } : {}) });
      if (loseResponse) {
        loseResponse = false; response.writeHead(200, { "content-type": "application/json", "content-length": "10000" });
        response.flushHeaders(); return response.destroy();
      }
      return send(task);
    }
    if (url.pathname === "/courseware/media/tasks/by-idempotency") {
      assert.equal(request.method, "GET");
      const task = tasks.get(url.searchParams.get("key"));
      if (!task) return send(null, 46006);
      assert.equal(url.searchParams.get("requestHash"), task.requestHash); return send(task);
    }
    const match = /^\/courseware\/media\/tasks\/(canvas-image-task-[123])(\/asset)?$/u.exec(url.pathname);
    if (match) {
      assert.equal(request.method, "GET");
      const task = [...tasks.values()].find(value => value.taskId === match[1]); assert(task);
      if (!match[2]) return send(task);
      assert(!refuseAssets, "Archived candidates must preview locally after full restart");
      assert.equal(task.state, "ready"); assetReads++;
      response.setHeader("content-type", "image/png"); return response.end(bytes[Number(match[1].at(-1)) - 1]);
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
const images = () => page.getByRole("region", { name: "Generate canvas images", exact: true });
const row = intent => images().locator(`[data-canvas-image-intent="${intent}"]`);
const read = () => invoke("coursewareCanvasImageList", { sessionId });
async function openCanvas() {
  await page.evaluate(() => { window.__PI_CAPTURE__ = true; window.__PI_DESKTOP__.openNewWorkPanelTab(); });
  await page.locator('[data-work-panel-launcher-item="media-canvas"]').click();
  await expect(canvas()).toBeVisible(); await expect(images()).toBeVisible();
}
async function start() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/api.?key|secret|token|password|proxy/iu.test(key)));
  app = await _electron.launch({ executablePath: process.env.ELECTRON_EXECUTABLE ?? resolveElectronBinary(repository).electronBinary,
    cwd: appDir, args: ["--no-sandbox", `--user-data-dir=${join(directory, "profile")}`, appDir],
    env: { ...env, ELECTRON_RUN_AS_NODE: "", ELECTRON_RENDERER_URL: "", PI_DESKTOP_DATA_DIR: join(directory, "data"),
      PI_DESKTOP_HOST_BIN: resolve(hostPath), DECKWISE_PLATFORM_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      PI_DESKTOP_START_MAXIMIZED: "0" }, timeout: 60_000 });
  for (const stream of [app.process().stdout, app.process().stderr]) stream.on("data", value => logs.push(String(value)));
  page = await app.firstWindow({ timeout: 60_000 }); page.on("pageerror", failure => logs.push(`PAGEERROR ${failure.stack}`));
  await page.waitForFunction(() => !!window.piDesktop);
  await app.evaluate(({ session, BrowserWindow }) => {
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url);
      callback({ cancel: /^https?:$/u.test(url.protocol) && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) });
    });
    BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1600, height: 1100 });
  });
  await page.waitForFunction(() => !!window.__PI_DESKTOP__ && !document.querySelector(".auth-shell"), null, { timeout: 60_000 });
  assert.equal((await invoke("authRestore")).status, "authenticated", "Main holds the actual loopback-auth principal");
  const { defaultCommandShell: _shell, ...settings } = await invoke("settingsGet");
  await invoke("settingsSet", { ...settings, language: "en", defaultPermissionMode: "auto" });
  await invoke("projectSet", workspace);
  if (!sessionId) {
    providerId = (await invoke("providersCreate", { name: "Unused fixture LLM", vendorKey: "custom", type: "openai_compatible",
      protocol: "openai_compatible", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, authKind: "none", apiStyle: "chat_completions",
      models: [{ id: "fixture-model", contextWindow: 128000, maxTokens: 8192, thinkingLevels: [], defaultThinkingLevel: null, supportsImages: true }] })).provider.id;
    sessionId = (await invoke("sessionCreate", { title: "Canvas image candidates", projectPath: workspace,
      providerId, modelId: "fixture-model", mode: "agent" })).session.id;
  }
  await page.evaluate(async id => { window.__PI_CAPTURE__ = true; await window.__PI_DESKTOP__.refreshProviders();
    await window.__PI_DESKTOP__.selectSession(id); }, sessionId);
}
async function stop() {
  if (!app) return;
  const child = app.process();
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once("exit", resolve)); await app.evaluate(({ app }) => app.exit(0)); await exited;
  }
  app = null;
}
const step = async (name, action) => { console.log("START", name); await action(); report.checks.push(name); console.log("PASS", name); };
async function quote(expectedPrompt, expectedPosts) {
  await images().getByRole("button", { name: "Load image models", exact: true }).click();
  await expect(images().getByRole("combobox", { name: "Image model", exact: true }).locator('option[value="canvas-image"]')).toHaveCount(1);
  await images().getByRole("combobox", { name: "Saved image draft", exact: true }).selectOption(draftId);
  await images().getByRole("combobox", { name: "Image model", exact: true }).selectOption("canvas-image");
  await images().getByRole("button", { name: "Prepare and get quote", exact: true }).click();
  await expect(images().getByText(/Maximum: 3 points/u)).toBeVisible();
  await expect(images().getByRole("button", { name: "Confirm and generate", exact: true })).toBeDisabled();
  const values = await read(), intent = values.findLast(value => value.current && value.phase === "prepared");
  assert(intent); assert.equal(intent.draft.prompt, expectedPrompt); assert.equal(submissions, expectedPosts);
  return intent;
}
async function submit(intent, expectedPosts, uncertain = false) {
  const consent = intent.draft.references.length
    ? "I approve the displayed maximum cost and sending the exact saved prompt and pinned reference image to the image provider."
    : "I approve the displayed maximum cost for this exact saved prompt.";
  await images().getByRole("checkbox", { name: consent, exact: true }).check();
  await images().getByRole("button", { name: "Confirm and generate", exact: true }).click();
  await expect(row(intent.intentId)).toContainText(uncertain ? "Submission uncertain" : "Task: queued");
  assert.equal(submissions, expectedPosts);
  if (uncertain) {
    await row(intent.intentId).getByRole("button", { name: "Check original task status", exact: true }).click();
    await expect(row(intent.intentId)).toContainText("Task: queued");
    assert.equal(submissions, expectedPosts, "Lost receipt recovery must only GET the original key");
  }
}
async function archive(intent, index) {
  const task = [...tasks.values()][index], data = bytes[index];
  Object.assign(task, { state: "ready", feeState: "settled", actualPoints: 3, receiptId: `courseware-media:${task.taskId}`,
    assetRef: { assetId: `asset-${task.taskId}`, sha256: digest(data), mime: "image/png", byteLength: data.length,
      width: 320, height: 180, downloadPath: `/courseware/media/tasks/${task.taskId}/asset` } });
  await row(intent.intentId).getByRole("button", { name: "Check original task status", exact: true }).click();
  await expect(row(intent.intentId)).toContainText("Task: ready");
  await row(intent.intentId).getByRole("button", { name: "Download and archive candidate", exact: true }).click();
  await expect.poll(() => row(intent.intentId).getByRole("img").evaluate(image => image.complete && image.naturalWidth === 320 && image.naturalHeight === 180)).toBe(true);
  const saved = (await read()).find(value => value.intentId === intent.intentId);
  assert.equal(saved.asset.sha256, digest(data)); assert.equal(saved.asset.byteLength, data.length);
  const preview = await invoke("coursewareCanvasImagePreview", { sessionId, intentId: intent.intentId });
  assert.equal(preview.dataUrl, `data:image/png;base64,${data.toString("base64")}`);
  return saved;
}
let first, second, variation, saved;
try {
  await step("Actual loopback login and courseware selector create a persisted ordinary canvas image draft", async () => {
    await start();
    assert(http.some(value => value.path === "/auth/me"));
    await page.evaluate(() => { window.__PI_DESKTOP__.openNewWorkPanelTab(); });
    await page.locator('[data-work-panel-launcher-item="ppt-master"]').click();
    await page.getByRole("button", { name: "普通 PPT 生成", exact: true }).click();
    await expect.poll(async () => (await invoke("coursewareTaskGet", { sessionId })).task?.taskType).toBe("plain");
    await openCanvas(); await canvas().getByRole("button", { name: "Add image", exact: true }).click();
    await properties().getByRole("textbox", { name: "Prompt", exact: true }).fill(prompts[0]);
    await expect.poll(async () => (await invoke("coursewareMediaCanvasGet", { sessionId })).document?.drafts[0]?.prompt).toBe(prompts[0]);
    draftId = (await invoke("coursewareMediaCanvasGet", { sessionId })).document.drafts[0].id;
  });
  await step("Model catalogue and visible quote perform zero media POSTs until explicit cost confirmation", async () => {
    first = await quote(prompts[0], 0);
    await page.screenshot({ path: join(out, "quoted-no-post.png") });
    await submit(first, 1);
  });
  await step("Ready settled task downloads through actual Main codec verification into private Host archive and preview", async () => {
    first = await archive(first, 0); assert.equal(assetReads, 1); assert.equal(submissions, 1);
    await page.screenshot({ path: join(out, "first-archived.png") });
  });
  await step("Editing the saved prompt creates a distinct candidate; a lost receipt recovers by GET without resubmission", async () => {
    await canvas().locator(".courseware-media-canvas-draft").click();
    await properties().getByRole("textbox", { name: "Prompt", exact: true }).fill(prompts[1]);
    await expect.poll(async () => (await invoke("coursewareMediaCanvasGet", { sessionId })).document.drafts[0].prompt).toBe(prompts[1]);
    second = await quote(prompts[1], 1); assert.notEqual(second.intentId, first.intentId);
    loseResponse = true; await submit(second, 2, true); second = await archive(second, 1);
    saved = await read(); assert.equal(saved.length, 2);
    assert.equal(saved.find(value => value.intentId === first.intentId).draft.prompt, prompts[0]);
    assert.equal(saved.find(value => value.intentId === first.intentId).asset.sha256, first.asset.sha256);
    assert.notEqual(posted[0].key, posted[1].key); assert.notEqual(posted[0].requestHash, posted[1].requestHash);
  });
  await step("Visible comparison displays both archived originals with their pinned prompt revisions", async () => {
    for (const candidate of [first, second]) await row(candidate.intentId).getByRole("checkbox", { name: `Compare ${candidate.draft.title}`, exact: true }).check();
    const comparison = images().getByRole("region", { name: "Compare archived candidates", exact: true });
    await expect(comparison.getByRole("img")).toHaveCount(2);
    for (const candidate of [first, second]) {
      const card = comparison.locator(`[data-canvas-image-comparison="${candidate.intentId}"]`);
      await expect(card.getByRole("textbox", { name: "Exact saved prompt", exact: true })).toHaveValue(candidate.draft.prompt);
      await expect.poll(() => card.getByRole("img").evaluate(image => image.complete && image.naturalWidth)).toBe(320);
    }
    assert.equal(assetReads, 2); assert.equal(submissions, 2);
    await comparison.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(out, "candidate-comparison.png") });
  });
  await step("Historical canvas image is selected as a reference, previewed locally and sent only after a fresh quote and explicit consent", async () => {
    await canvas().getByRole("button", { name: "Add image", exact: true }).click();
    await properties().getByRole("textbox", { name: "Prompt", exact: true }).fill(prompts[2]);
    await expect.poll(async () => (await invoke("coursewareMediaCanvasGet", { sessionId })).document.drafts.at(-1).prompt).toBe(prompts[2]);
    draftId = (await invoke("coursewareMediaCanvasGet", { sessionId })).document.drafts.at(-1).id;
    await page.getByRole("button", { name: "Load available image references", exact: true }).click();
    const referenceId = `canvas-image:${first.intentId}`;
    const references = properties().getByRole("combobox", { name: "Reference", exact: true });
    await expect(references.locator(`option[value="${referenceId}"]`)).toHaveCount(1);
    await references.selectOption(referenceId);
    await expect.poll(async () => (await invoke("coursewareMediaCanvasGet", { sessionId })).document.drafts.at(-1).references[0]?.assetId).toBe(referenceId);
    assert.equal(submissions, 2); assert.equal(assetReads, 2);
    variation = await quote(prompts[2], 2);
    assert.deepEqual(variation.draft.references, [{ assetId: referenceId, revision: first.asset.sha256,
      label: `${first.draft.title} · ${first.asset.sha256.slice(0, 12)}` }]);
    const preview = images().getByRole("img", { name: "Original pinned reference image", exact: true });
    await expect(preview).toHaveAttribute("src", `data:image/png;base64,${bytes[0].toString("base64")}`);
    await expect.poll(() => preview.evaluate(image => image.complete && image.naturalWidth)).toBe(320);
    assert.equal(submissions, 2); assert.equal(assetReads, 2, "Reference preview reads the original local archive");
    await preview.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(out, "reference-preview-unconfirmed.png") });
    await submit(variation, 3); variation = await archive(variation, 2);
    saved = await read(); assert.equal(saved.length, 3);
    for (const original of [first, second]) assert.deepEqual(saved.find(value => value.intentId === original.intentId).asset, original.asset);
    assert.equal(posted[2].referenceImage.sha256, first.asset.sha256);
    assert.equal(new Set(posted.map(value => value.key)).size, 3);
    assert.equal(new Set(posted.map(value => value.requestHash)).size, 3);
  });
  await step("Full Electron and Host restart retains old and new candidate bytes with no provider download or POST", async () => {
    refuseAssets = true; await stop(); await start(); await openCanvas();
    await images().getByRole("button", { name: "Refresh candidates", exact: true }).click();
    await expect(images().locator("[data-canvas-image-intent]")).toHaveCount(3);
    assert.deepEqual(await read(), saved);
    for (const candidate of [first, second, variation]) {
      await row(candidate.intentId).getByRole("button", { name: "Preview archived image", exact: true }).click();
      await expect.poll(() => row(candidate.intentId).getByRole("img").evaluate(image => image.complete && image.naturalWidth)).toBe(320);
    }
    assert.equal(assetReads, 3); assert.equal(submissions, 3);
    await page.getByRole("button", { name: "Load available image references", exact: true }).click();
    await canvas().locator(".courseware-media-canvas-draft").last().click();
    await expect(properties().getByRole("listitem")).toContainText(first.draft.title);
    assert.equal(assetReads, 3); assert.equal(submissions, 3);
    await page.screenshot({ path: join(out, "restarted-private-candidates.png") });
  });
  await step("Missing and corrupt local images are retrieved explicitly from their original tasks without another quote or generation", async () => {
    const quoteReads = http.filter(value => value.path.endsWith("/quote")).length;
    const restored = [];
    for (const [index, candidate] of [first, second].entries()) {
      const path = join(directory, "data", "courseware-assets", `${candidate.asset.sha256}.bin`);
      if (index === 0) await rm(path);
      else await writeFile(path, Buffer.alloc(candidate.asset.byteLength));
      await row(candidate.intentId).getByRole("button", { name: "Preview archived image", exact: true }).click();
      await expect(images().getByRole("alert")).toBeVisible();
      assert.equal(assetReads, 3 + index, "A failed preview must not silently fetch the remote result");
      assert.equal(submissions, 3);
      refuseAssets = false;
      await row(candidate.intentId).getByRole("button", { name: "Retrieve original image (no regeneration)", exact: true }).click();
      await expect(row(candidate.intentId).getByRole("img")).toHaveAttribute("src", `data:image/png;base64,${bytes[index].toString("base64")}`);
      await expect.poll(() => row(candidate.intentId).getByRole("img").evaluate(image => image.complete && image.naturalWidth)).toBe(320);
      assert.deepEqual(await readFile(path), bytes[index]);
      assert.equal(assetReads, 4 + index); assert.equal(submissions, 3);
      assert.equal(http.filter(value => value.path.endsWith("/quote")).length, quoteReads);
      restored.push({ intentId: candidate.intentId, damage: index === 0 ? "missing" : "corrupt", sha256: candidate.asset.sha256 });
      refuseAssets = true;
    }
    assert.deepEqual(await read(), saved, "Repair cannot change original requests, references, receipts or metadata");
    report.restoredArchives = restored;
    await row(second.intentId).getByRole("img").scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(out, "restored-original.png") });
  });
  await step("A second complete restart previews repaired originals locally with the same immutable candidate journal", async () => {
    await stop(); await start(); await openCanvas();
    await images().getByRole("button", { name: "Refresh candidates", exact: true }).click();
    await expect(images().locator("[data-canvas-image-intent]")).toHaveCount(3);
    assert.deepEqual(await read(), saved);
    for (const candidate of [first, second]) {
      await row(candidate.intentId).getByRole("button", { name: "Preview archived image", exact: true }).click();
      await expect.poll(() => row(candidate.intentId).getByRole("img").evaluate(image => image.complete && image.naturalWidth)).toBe(320);
    }
    assert.equal(assetReads, 5); assert.equal(submissions, 3);
  });
  await step("Another persisted Chat cannot read or preview the original candidates and returning restores the same archive", async () => {
    const original = sessionId;
    const other = (await invoke("sessionCreate", { title: "Foreign canvas", projectPath: workspace, providerId,
      modelId: "fixture-model", mode: "agent" })).session.id;
    await page.evaluate(async id => window.__PI_DESKTOP__.selectSession(id), other);
    await invoke("coursewareTaskSet", { sessionId: other, taskType: "plain", educationContext: {} });
    await openCanvas();
    await images().getByRole("button", { name: "Refresh candidates", exact: true }).click();
    await expect(images().locator("[data-canvas-image-intent]")).toHaveCount(0);
    assert.deepEqual(await invoke("coursewareCanvasImageList", { sessionId: other }), []);
    await page.getByRole("button", { name: "Load available image references", exact: true }).click();
    await expect(page.getByText("No archived PNG or JPEG images are available in this conversation.", { exact: true })).toBeVisible();
    await assert.rejects(invoke("coursewareCanvasImagePreview", { sessionId: other, intentId: first.intentId }), /not found|MISSING|NOT_FOUND|not exist|不存在/iu);
    await assert.rejects(invoke("coursewareCanvasImageList", { sessionId: original }), /CONTEXT_CHANGED|context.*changed/iu);
    await page.evaluate(async id => window.__PI_DESKTOP__.selectSession(id), original);
    await openCanvas(); await images().getByRole("button", { name: "Refresh candidates", exact: true }).click();
    await expect(images().locator("[data-canvas-image-intent]")).toHaveCount(3); assert.deepEqual(await read(), saved);
    assert.equal(assetReads, 5); assert.equal(submissions, 3);
  });
  assert(!(await readdir(workspace, { recursive: true })).some(path => path.endsWith(".pptx")), "Generating and comparing candidates never mutates a slide");
  assert(!logs.some(value => /PAGEERROR|FIXTUREERROR/u.test(value)), "No renderer or fixture errors");
  report.status = "PASS_CANVAS_IMAGE_MAIN_HOST_ARCHIVE_RESTART"; report.sessionId = sessionId; report.candidates = saved;
} catch (failure) {
  report.status = "FAIL"; report.error = String(failure.stack); console.error(failure); process.exitCode = 1;
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(out, "failure.png") }).catch(() => {});
    await writeFile(join(out, "failure-aria.txt"), await page.locator("body").ariaSnapshot()).catch(() => {});
  }
} finally {
  await stop(); await new Promise(resolve => server.close(resolve));
  report.submissions = submissions; report.assetReads = assetReads; report.requests = posted;
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(join(out, "http.json"), JSON.stringify(http, null, 2) + "\n");
  await writeFile(join(out, "main.log"), logs.join("\n"));
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, out, directory, submissions, assetReads }));
}
