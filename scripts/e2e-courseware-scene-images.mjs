/** Actual Electron/Main/auth/Host and controls; platform identity/media are loopback fixtures. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { crc32 } from "node:zlib";
import { coursewareLaunch } from "./e2e/boot.mjs";

assert(process.env.DECKWISE_E2E_OUTPUT);
if (!process.env.DECKWISE_E2E_PACKAGE_ROOT) assert(process.env.PI_DESKTOP_HOST_BIN);
assert(process.env.DECKWISE_EDITOR_URL, "Use an isolated local WiseOffice source preview");
assert(!new URL(process.env.DECKWISE_EDITOR_URL).pathname.replace(/\/$/u, "").endsWith("/editor"),
  "DECKWISE_EDITOR_URL must be the WiseOffice application base; the controller appends /editor");
const out = resolve(process.env.DECKWISE_E2E_OUTPUT);
await mkdir(dirname(out), { recursive: true }); await mkdir(out);
const reopen = process.env.DECKWISE_E2E_SCENE_REOPEN_REPORT
  ? JSON.parse(await readFile(process.env.DECKWISE_E2E_SCENE_REOPEN_REPORT, "utf8")) : null;
const keepInitial = process.env.DECKWISE_E2E_SCENE_KEEP_INITIAL === "1";
assert(!keepInitial || !reopen, "Initial-source fixture generation cannot reuse a saved-source reopen report");
const directory = reopen?.directory ?? await mkdtemp(join(tmpdir(), "deckwise-scene-images-ui-"));
const workspace = join(directory, "workspace"); await mkdir(workspace, { recursive: true });
const launch = coursewareLaunch();
const { _electron, expect } = createRequire(new URL("../packages/courseware-runtime/package.json", import.meta.url))("@playwright/test");
const sharp = createRequire(new URL("../packages/courseware-runtime/package.json", import.meta.url))("sharp");
const png = await sharp({ create: { width: 640, height: 360, channels: 4, background: "#40a060" } }).png().toBuffer();
const jpeg = await sharp(png).jpeg().toBuffer();
const background = await sharp({ create: { width: 640, height: 400, channels: 4, background: "#e8f4ff" } }).png().toBuffer();
const isolated = async color => sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: await sharp({ create: { width: 32, height: 40, channels: 4, background: color } }).png().toBuffer(), left: 16, top: 12 }]).png().toBuffer();
const imageBytes = new Map([["image-task-1", png], ["image-task-2", jpeg]]);
imageBytes.set("image-task-3", background);
imageBytes.set("image-task-4", png);
imageBytes.set("image-task-5", await isolated("#e05050"));
imageBytes.set("image-task-6", await isolated("#e0b030"));
imageBytes.set("image-task-7", await isolated("#8060d0"));
imageBytes.set("image-task-8", background);
imageBytes.set("image-task-9", await isolated("#30a0e0"));
let assetReads = 0, refuseAssets = false;
const report = { status: "RUNNING", checks: [], directory, paidCalls: false, identityFixture: true, platformFixture: true,
  modelCall: true, modelFixture: true, planFixture: true, packaged: launch.packaged, sandbox: "--no-sandbox" };
const token = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
const plan = { title: "Garden shapes", pages: [
  { title: "Circle", visibleText: ["Circle"], visualIntent: "A bright round flower", narration: "A circle. Good!" },
  { title: "Square", visibleText: ["Square"], visualIntent: "A square garden bed", narration: "Find a square. Good job!" },
] };
const tasks = new Map(), http = [], logs = [], referenceRequests = [];
let submissions = 0, hideRecovery = false, loseResponse = false, app, page, sessionId, providerId;
const modelRequests = [];
let holdModel = false, releaseModel;
const hashRequest = r => createHash("sha256").update("courseware-media-v1" + [r.kind, r.model, r.input, null,
  ...(r.referenceImage ? [r.referenceImage.sha256, r.referenceImage.mimeType, String(r.referenceImage.byteLength)] : [])]
  .map(v => `:${v === null ? -1 : v.length}:${v ?? ""}`).join("")).digest("hex");
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    http.push({ method: req.method, path: url.pathname });
    const send = (data, code = 200) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ code, data })); };
    if (url.pathname === "/auth/desktop/wx/qrcode") return send({ ticket: "scene-ticket", entryUrl: "https://fixture.test/qr" });
    if (["/auth/wx/poll/scene-ticket", "/auth/desktop/refresh", "/auth/refresh"].includes(url.pathname))
      return send({ status: "SUCCESS", accessToken: token, refreshToken: "scene-fixture-refresh" });
    if (url.pathname === "/auth/me") return send({ edition: "EDUCATION", pcAllowed: true, role: "ADMIN", tenantId: 8, userId: 7 });
    if (url.pathname === "/auth/logout") return send({});
    if (url.pathname === "/v1/chat/completions") {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw), prompt = JSON.parse(body.messages.find(message => message.role === "user").content[0].text);
      assert.equal(body.model, "scene-vision");
      assert.equal(prompt.canvas.width, 1280); assert.equal(prompt.canvas.height, 800);
      const layers = prompt.availableAssets.filter(asset => ![prompt.visualMasterAssetId, prompt.cleanPlateAssetId].includes(asset.assetId));
      assert(layers.length > 0);
      modelRequests.push({ pageId: prompt.pageId, sourceHash: prompt.sourceHash, assets: prompt.availableAssets, held: holdModel });
      if (holdModel) await new Promise(resolve => { releaseModel = resolve; });
      if (res.destroyed) return;
      const title = plan.pages[Number(prompt.pageId.slice(-3)) - 1].title;
      const scene = { version: 1, slideId: prompt.pageId, sourceHash: prompt.sourceHash, canvas: prompt.canvas,
        visualMasterAssetId: prompt.visualMasterAssetId, cleanPlateAssetId: prompt.cleanPlateAssetId,
        elements: [{ id: "title", type: "native_text", bboxPx: [70, 55, 900, 110], zIndex: 1, content: title,
          style: { fontFace: "Arial", fontSizePt: 36, color: "#173B65" } },
        ...layers.map((asset, index) => ({ id: `foreground-${index}`, type: "image_layer", layerRoute: "A1", assetId: asset.assetId,
          bboxPx: [280 + index * 320, 240, 240, 240], zIndex: index + 2,
          semanticRole: `${title} foreground ${index}`, spokenAliases: [title], objectKind: "prop", animationPolicy: "static" }))] };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ id: "scene-fixture", choices: [{ index: 0, delta: { role: "assistant", content: JSON.stringify(scene) }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "scene-fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      return res.end("data: [DONE]\n\n");
    }
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    if (url.pathname === "/courseware/media/models") {
      assert.equal(url.searchParams.get("kind"), "image");
      return send([{ model: "scene-image", voices: [], providerDefaultVoice: false, supportsReferenceImage: true }]);
    }
    if (url.pathname === "/courseware/media/models/scene-image/quote") {
      const expiry = Math.floor(Date.now() / 1000) + 300;
      return send({ version: "courseware-media-quote-v1", kind: "image", model: "scene-image", priceVersion: "image-v1",
        maxPoints: 3, maxChars: 4000, expiresAt: new Date(expiry * 1000).toISOString(), quoteToken: `${expiry}.${"a".repeat(43)}` });
    }
    if (url.pathname === "/courseware/media/tasks/confirmed" && req.method === "POST") {
      submissions++;
      assert(submissions <= 9, "Only the nine explicit fixture submissions are allowed");
      let raw = ""; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw), key = req.headers["idempotency-key"];
      assert.equal(body.request.kind, "image"); assert.equal(body.request.model, "scene-image");
      assert.equal(body.request.voice, undefined); assert.equal(body.confirmation.maxPoints, 3);
      assert.equal(body.confirmation.priceVersion, "image-v1"); assert.match(body.request.input, /No text|Remove all teaching objects|Transparent PNG/u);
      if (submissions <= 2) assert.equal(body.request.referenceImage, undefined, "Initial visual references stay text-to-image");
      else {
        const reference = body.request.referenceImage, expected = submissions <= 7 ? png : jpeg;
        assert(reference, "Backgrounds and foregrounds must condition on the reviewed page reference");
        assert.deepEqual(Object.keys(reference).sort(), ["byteLength", "bytesBase64", "mimeType", "sha256"]);
        assert.deepEqual(Buffer.from(reference.bytesBase64, "base64"), expected);
        assert.equal(reference.sha256, createHash("sha256").update(expected).digest("hex"));
        assert.equal(reference.byteLength, expected.length);
        assert.equal(reference.mimeType, submissions <= 7 ? "image/png" : "image/jpeg");
        referenceRequests.push({ submission: submissions, sha256: reference.sha256, mimeType: reference.mimeType, byteLength: reference.byteLength });
      }
      const task = { version: "courseware-media-v1", kind: "image", taskId: `image-task-${submissions}`,
        idempotencyKey: key, requestHash: hashRequest(body.request), model: "scene-image", state: "queued", feeState: "reserved",
        reservedPoints: 3, actualPoints: null, errorCode: null, receiptId: null, assetRef: null };
      tasks.set(key, task);
      if (loseResponse) {
        loseResponse = false;
        res.writeHead(200, { "content-type": "application/json", "content-length": "10000" });
        res.flushHeaders(); return res.destroy();
      }
      return send(task);
    }
    if (url.pathname === "/courseware/media/tasks/by-idempotency") {
      const task = tasks.get(url.searchParams.get("key"));
      if (hideRecovery || !task) return send(null, 46006);
      assert.equal(url.searchParams.get("requestHash"), task.requestHash); return send(task);
    }
    if (/^\/courseware\/media\/tasks\/image-task-[1-9]\/asset$/u.test(url.pathname)) {
      assert(!refuseAssets, "Archived previews must not redownload");
      const id = url.pathname.split("/").at(-2), bytes = imageBytes.get(id);
      assert(bytes); assetReads++;
      res.setHeader("content-type", id === "image-task-2" ? "image/jpeg" : "image/png");
      return res.end(bytes);
    }
    if (/^\/courseware\/media\/tasks\/image-task-[1-9]$/u.test(url.pathname)) {
      const task = [...tasks.values()].find(t => url.pathname.endsWith(`/${t.taskId}`)); assert(task); return send(task);
    }
    throw new Error(`Unexpected ${req.method} ${url.pathname}`);
  } catch (error) { logs.push(`FIXTUREERROR ${error.stack}`); res.statusCode = 500; res.end("Fixture error"); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const invoke = (name, ...args) => page.evaluate(async ({ name, args }) => {
  const result = await window.piDesktop.invoke(window.piDesktop.channels.invoke[name], ...args);
  if (!result.ok) throw new Error(JSON.stringify(result.error)); return result.data;
}, { name, args });
const images = () => page.getByRole("region", { name: "逐页场景素材", exact: true });
const assetRow = intentId => images().locator(`[data-scene-image-intent="${intentId}"]`);
const planning = () => page.locator(".ppt-master-scene-plan");
const savedPath = () => join(workspace, `.deckwise-ppt/scenes/${sessionId}/plan.json`);
async function start() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/api.?key|secret|token|password|proxy/i.test(key)));
  app = await _electron.launch({ executablePath: launch.executablePath, cwd: launch.cwd,
    args: ["--no-sandbox", `--user-data-dir=${join(directory, "profile")}`, ...launch.args],
    env: { ...env, ELECTRON_RUN_AS_NODE: "", ELECTRON_RENDERER_URL: "", PI_DESKTOP_DATA_DIR: join(directory, "data"),
      DECKWISE_PLATFORM_BASE_URL: `http://127.0.0.1:${server.address().port}`, PI_DESKTOP_START_MAXIMIZED: "0" }, timeout: 60_000 });
  for (const stream of [app.process().stdout, app.process().stderr]) stream.on("data", b => logs.push(String(b)));
  page = await app.firstWindow({ timeout: 60_000 });
  page.on("pageerror", e => logs.push(`PAGEERROR ${e.stack}`));
  await page.waitForFunction(() => !!window.piDesktop);
  report.runtime = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, appPath: app.getAppPath() }));
  assert.equal(report.runtime.packaged, launch.packaged);
  await app.evaluate(({ session, BrowserWindow }) => {
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const u = new URL(details.url); callback({ cancel: /^https?:$/.test(u.protocol) && !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) });
    });
    BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1500, height: 1050 });
  });
  await page.waitForFunction(() => !!window.__PI_DESKTOP__ && !document.querySelector(".auth-shell"), null, { timeout: 60_000 });
  assert.equal((await invoke("authRestore")).status, "authenticated");
  await invoke("projectSet", workspace);
  if (!sessionId) {
    providerId = (await invoke("providersCreate", { name: "Local scene model", vendorKey: "custom", type: "openai_compatible",
      protocol: "openai_compatible", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, authKind: "none",
      models: [{ id: "scene-vision", contextWindow: 128000, maxTokens: 8192, thinkingLevels: [], defaultThinkingLevel: null, supportsImages: true }] })).provider.id;
    sessionId = (await invoke("sessionCreate", { title: "Scene image tasks", projectPath: workspace, providerId, modelId: "scene-vision", mode: "agent" })).session.id;
  }
  await page.evaluate(async id => { window.__PI_CAPTURE__ = true; await window.__PI_DESKTOP__.refreshProviders(); await window.__PI_DESKTOP__.selectSession(id);
    window.__PI_DESKTOP__.openNewWorkPanelTab(); }, sessionId);
  await page.locator('[data-work-panel-launcher-item="ppt-master"]').click();
}
async function stop() {
  if (!app) return;
  const child = app.process();
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once("exit", resolve)); await app.evaluate(({ app }) => app.exit(0)); await exited;
  }
  app = null;
}
const step = async (name, fn) => { console.log("START", name); await fn(); report.checks.push(name); console.log("PASS", name); };
async function price(pageId, kind = "visualMaster", name = "", instructions = "") {
  await images().getByRole("button", { name: "读取生图模型", exact: true }).click();
  await expect(images().getByRole("combobox", { name: "生图模型", exact: true }).locator('option[value="scene-image"]')).toHaveCount(1);
  await images().getByRole("combobox", { name: "目标页面", exact: true }).selectOption(pageId);
  await images().getByRole("combobox", { name: "生图模型", exact: true }).selectOption("scene-image");
  await images().getByRole("combobox", { name: "素材用途", exact: true }).selectOption(kind);
  if (kind === "layer") await images().getByRole("textbox", { name: "图层名称", exact: true }).fill(name);
  await images().getByRole("textbox", { name: "补充要求（修改后可重新生成）", exact: true }).fill(instructions);
  await images().getByRole("button", { name: "准备本页请求并获取报价", exact: true }).click();
  await expect(images().getByText(/最高 3 积分/)).toBeVisible();
  await expect(images().getByRole("button", { name: "确认费用并生成图片", exact: true })).toBeDisabled();
  if (kind !== "visualMaster") {
    const intent = (await invoke("coursewareSceneImageList", { sessionId })).findLast(row =>
      row.pageId === pageId && row.phase === "prepared" && row.target.kind === kind && (kind !== "layer" || row.target.name === name));
    assert(intent?.referenceImage);
    await expect(images().getByRole("img", { name: "已审核的参考图", exact: true })).toBeVisible();
    await expect(images().getByText(/确认后将此私有图片发送给图像供应商/)).toContainText(intent.referenceImage.sha256);
    assert.equal(referenceRequests.length, Math.max(0, submissions - 2), "Preparing and quoting sends no reference bytes");
  }
}
async function generateAsset(kind, name = "", instructions = "", pageId = "scene-001") {
  await price(pageId, kind, name, instructions);
  const quoted = await invoke("coursewareSceneImageList", { sessionId });
  const intent = quoted.findLast(row => row.current && row.pageId === pageId && row.phase === "prepared" && row.target.kind === kind && (kind !== "layer" || row.target.name === name));
  assert(intent);
  if (instructions) assert(intent.prompt.includes(instructions));
  const lostReference = kind !== "visualMaster" && submissions === 2;
  if (lostReference) loseResponse = true;
  await images().getByRole("checkbox", { name: kind === "visualMaster" ? "我确认目标页、模型和最高费用" :
    "我确认页面、模型、费用上限，并同意将此已审核参考图发送给图像供应商", exact: true }).check();
  await images().getByRole("button", { name: "确认费用并生成图片", exact: true }).click();
  if (lostReference) {
    await expect(assetRow(intent.intentId)).toContainText("提交回执未知");
    const beforeRecovery = submissions;
    await assetRow(intent.intentId).getByRole("button", { name: "查询原任务", exact: true }).click();
    await expect(assetRow(intent.intentId).getByText(/状态 queued/)).toBeVisible();
    assert.equal(submissions, beforeRecovery, "Reference-conditioned unknown recovery must not resubmit");
    report.referenceReceiptRecovery = { intentId: intent.intentId, submissions: beforeRecovery, noResubmit: true };
  }
  await expect(assetRow(intent.intentId).getByText(/状态 queued/)).toBeVisible();
  const task = [...tasks.values()].at(-1), bytes = imageBytes.get(task.taskId), metadata = await sharp(bytes).metadata();
  Object.assign(task, { state: "ready", feeState: "settled", actualPoints: 3, receiptId: `courseware-media:${task.taskId}`,
    assetRef: { assetId: `asset-${task.taskId}`, sha256: createHash("sha256").update(bytes).digest("hex"),
      mime: "image/png", byteLength: bytes.length, width: metadata.width, height: metadata.height,
      downloadPath: `/courseware/media/tasks/${task.taskId}/asset` } });
  await assetRow(intent.intentId).getByRole("button", { name: "查询原任务", exact: true }).click();
  await expect(assetRow(intent.intentId).getByText(/状态 ready/)).toBeVisible();
  return intent;
}
async function reviewAsset(intent) {
  const row = assetRow(intent.intentId);
  await row.getByRole("button", { name: "归档并预览图片", exact: true }).click();
  await expect(row.getByRole("img")).toBeVisible();
  const adopt = row.getByRole("button", { name: "采用为本页此用途素材", exact: true });
  await expect(adopt).toBeDisabled();
  await row.getByRole("checkbox", { name: "我已检查图片及其对应页面", exact: true }).check();
  await adopt.click();
  await expect(row.getByText("已采用为本页此用途素材", { exact: true })).toBeVisible();
}
async function nativeEditor() {
  let host, sdk, failure;
  await expect.poll(async () => {
    const status = await page.locator(".ppt-editor-document [role=status]").allTextContents();
    if (status.some(text => /Error:|failed|失败/u.test(text))) {
      failure = new Error(`Native editor failed visibly: ${status.join("; ")}`); return true;
    }
    host = app.context().pages().find(target => target.url().startsWith("deckwise-editor:"));
    if (!host) {
      const errors = await page.getByRole("alert").allTextContents();
      if (errors.some(text => text.trim())) throw new Error(`Generation failed visibly: ${errors.join("; ")}`);
      return false;
    }
    for (const frame of host.frames()) if (await frame.evaluate(() => !!window.Asc?.editor?.isDocumentLoadComplete).catch(() => false)) { sdk = frame; return true; }
    return false;
  }, { timeout: 120_000 }).toBe(true);
  if (failure) throw failure;
  return { host, sdk };
}
async function nativeState(sdk) {
  return sdk.evaluate(() => {
    const doc = window.Asc.editor.WordControl.m_oLogicDocument;
    const decode = items => items.map(node => {
      if ([39, 48].includes(node.Type)) return decode(node.Content);
      if ([1, 2].includes(node.Type)) return String.fromCodePoint(node.GetCodePoint());
      if ([4, 16].includes(node.Type)) return "\n";
      if (node.Type === 21) return "\t";
      if (node.Type === 71) return "";
      throw new Error(`Unknown text item ${node.Type}`);
    }).join("");
    return { width: doc.GetWidthMM(), height: doc.GetHeightMM(), slides: doc.Slides.map(slide => slide.cSld.spTree.map(shape => ({
      text: shape.getDocContent?.()?.Content.map(paragraph => decode(paragraph.Content)).join("") ?? null,
      x: shape.x, y: shape.y, width: shape.extX, height: shape.extY,
    }))) };
  });
}
try {
  if (reopen) {
    for (let attempt = 1; attempt <= 3; attempt++) await step(`Previously saved scene reopens with unchanged native objects and teaching (${attempt})`, async () => {
      const sessions = await readdir(join(workspace, ".deckwise-ppt/scenes"));
      assert.equal(sessions.length, 1); sessionId = sessions[0];
      await start();
      await page.getByRole("button", { name: "打开场景课件 PPT", exact: true }).click();
      const editor = await nativeEditor();
      assert.deepEqual(await nativeState(editor.sdk), reopen.afterEdit);
      assert.deepEqual((await invoke("pptEditorTeachingOpen", { sessionId })).project, reopen.associatedTeaching);
      assert.equal(submissions, 0); assert.equal(assetReads, 0); assert.equal(modelRequests.length, 0);
      await stop();
    });
    report.status = "PASS_SAVED_SCENE_REOPEN";
  } else {
  await step("Visible approval enables image preparation, but model and quote reads do not submit", async () => {
    await start(); await page.getByRole("button", { name: "场景式课件生成", exact: true }).click();
    await mkdir(dirname(savedPath()), { recursive: true }); await writeFile(savedPath(), JSON.stringify(plan));
    await planning().getByRole("button", { name: "刷新教学规划", exact: true }).click();
    await expect(images()).toBeVisible();
    await expect(images().getByRole("button", { name: "读取生图模型", exact: true })).toBeDisabled();
    await planning().getByRole("button", { name: "确认当前规划", exact: true }).click();
    await price("scene-001"); assert.equal(submissions, 0);
    await images().getByText("查看生成提示词", { exact: true }).click();
    await expect(images().getByText(/A bright round flower/)).toBeVisible();
    const quote = await invoke("coursewareSceneImageQuote", { sessionId, intentId: (await invoke("coursewareSceneImageList", { sessionId }))[0].intentId });
    assert(!JSON.stringify(quote).includes("quoteToken"));
    // A second quote invalidates the first one, so refresh the displayed quote explicitly.
    await images().getByRole("button", { name: "准备本页请求并获取报价", exact: true }).click();
    await expect(images().getByText(/最高 3 积分/)).toBeVisible();
  });
  await step("Explicit page/model/cost confirmation dispatches one private image task", async () => {
    await images().getByRole("checkbox", { name: "我确认目标页、模型和最高费用", exact: true }).check();
    await images().getByRole("button", { name: "确认费用并生成图片", exact: true }).click();
    await expect(images().getByText(/状态 queued/)).toBeVisible(); assert.equal(submissions, 1);
    await images().getByRole("button", { name: "查询原任务", exact: true }).first().click();
    await expect(images().getByText(/状态 queued/)).toBeVisible(); assert.equal(submissions, 1);
  });
  await step("Lost HTTP receipt stays unknown and the UI offers original-task recovery", async () => {
    await price("scene-002"); loseResponse = true;
    await images().getByRole("checkbox").check();
    await images().getByRole("button", { name: "确认费用并生成图片", exact: true }).click();
    await expect(images().getByRole("alert")).toBeVisible();
    await expect(images().getByText(/提交回执未知/)).toBeVisible();
    assert.equal(submissions, 2);
    report.beforeRestart = await invoke("coursewareSceneImageList", { sessionId });
    assert.equal(report.beforeRestart.length, 2);
    await page.screenshot({ path: join(out, "unknown-receipt.png") });
  });
  await step("Full Desktop/Host restart retains both tasks; missing lookup never resubmits, then recovery binds the original", async () => {
    await stop(); await start(); await images().getByRole("button", { name: "刷新已保存任务", exact: true }).click();
    await expect(images().getByText(/提交回执未知/)).toBeVisible();
    assert.deepEqual(await invoke("coursewareSceneImageList", { sessionId }), report.beforeRestart.map(row => ({ ...row, task: null })));
    hideRecovery = true;
    const unknown = images().locator(".ppt-master-scene-page").filter({ hasText: "提交回执未知" });
    await unknown.getByRole("button", { name: "查询原任务", exact: true }).click();
    await expect(unknown).toBeVisible(); assert.equal(submissions, 2);
    hideRecovery = false;
    await unknown.getByRole("button", { name: "查询原任务", exact: true }).click();
    await expect(images().getByText(/提交回执未知/)).toHaveCount(0);
    await expect(images().getByText(/状态 queued/)).toBeVisible();
    assert.equal((await invoke("coursewareSceneImageList", { sessionId })).filter(row => row.phase === "submitted").length, 2);
    assert.equal(submissions, 2);
  });
  await step("Ready PNG/JPEG results archive and render through actual Main codecs; selection requires explicit review", async () => {
    const before = await readFile(savedPath());
    for (const task of tasks.values()) {
      const bytes = imageBytes.get(task.taskId);
      Object.assign(task, { state: "ready", feeState: "settled", actualPoints: 3, receiptId: `courseware-media:${task.taskId}`,
        assetRef: { assetId: `asset-${task.taskId}`, sha256: createHash("sha256").update(bytes).digest("hex"),
          mime: task.taskId === "image-task-1" ? "image/png" : "image/jpeg", byteLength: bytes.length,
          width: 640, height: 360, downloadPath: `/courseware/media/tasks/${task.taskId}/asset` } });
    }
    const firstTask = [...tasks.values()].find(task => task.taskId === "image-task-1"), invalidPng = Buffer.from(png);
    for (let offset = 8; offset + 12 <= invalidPng.length;) {
      const length = invalidPng.readUInt32BE(offset), end = offset + length + 12;
      if (invalidPng.toString("ascii", offset + 4, offset + 8) === "IDAT") {
        invalidPng[offset + 8] = 0;
        invalidPng.writeUInt32BE(crc32(invalidPng.subarray(offset + 4, end - 4)), end - 4);
        break;
      }
      offset = end;
    }
    imageBytes.set("image-task-1", invalidPng);
    firstTask.assetRef.sha256 = createHash("sha256").update(invalidPng).digest("hex");
    const firstRow = images().locator(".ppt-master-scene-page").filter({ hasText: "Circle" });
    await firstRow.getByRole("button", { name: "查询原任务", exact: true }).click();
    await expect(firstRow.getByText(/状态 ready/)).toBeVisible();
    await firstRow.getByRole("button", { name: "归档并预览图片", exact: true }).click();
    await expect(images().getByRole("alert")).toBeVisible();
    assert.equal((await invoke("coursewareSceneImageList", { sessionId }))[0].asset, null, "Invalid native codec bytes cannot be archived");
    imageBytes.set("image-task-1", png);
    firstTask.assetRef.sha256 = createHash("sha256").update(png).digest("hex");
    for (const title of ["Circle", "Square"]) {
      const row = images().locator(".ppt-master-scene-page").filter({ hasText: title });
      await row.getByRole("button", { name: "查询原任务", exact: true }).click();
      await expect(row.getByText(/状态 ready/)).toBeVisible();
      await row.getByRole("button", { name: "归档并预览图片", exact: true }).click();
      const image = row.getByRole("img");
      await expect(image).toBeVisible();
      await expect.poll(() => image.evaluate(node => node.complete && node.naturalWidth === 640 && node.naturalHeight === 360)).toBe(true);
      const adopt = row.getByRole("button", { name: "采用为本页画面参考", exact: true });
      await expect(adopt).toBeDisabled();
      await row.getByRole("checkbox", { name: "我已检查图片及其对应页面", exact: true }).check();
      await adopt.click();
      await expect(row.getByText("已采用为本页画面参考", { exact: true })).toBeVisible();
    }
    report.archived = await invoke("coursewareSceneImageList", { sessionId });
    assert(report.archived.every(row => row.selected && row.asset && row.current));
    assert.deepEqual(await readFile(savedPath()), before, "Image selection must not rewrite the lesson plan");
    assert.equal(assetReads, 3); assert.equal(submissions, 2);
  });
  await step("Private archived images and page choices survive full restart without another HTTP download", async () => {
    refuseAssets = true;
    await stop(); await start();
    await images().getByRole("button", { name: "刷新已保存任务", exact: true }).click();
    await expect(images().getByText("已采用为本页画面参考", { exact: true })).toHaveCount(2);
    assert.deepEqual(await invoke("coursewareSceneImageList", { sessionId }), report.archived);
    for (const title of ["Circle", "Square"]) {
      const row = images().locator(".ppt-master-scene-page").filter({ hasText: title });
      await row.getByRole("button", { name: "预览已归档图片", exact: true }).click();
      await expect.poll(() => row.getByRole("img").evaluate(node => node.complete && node.naturalWidth)).toBe(640);
      const [query, preview] = await Promise.all([
        row.getByRole("button", { name: "查询原任务", exact: true }).boundingBox(),
        row.getByRole("button", { name: "预览已归档图片", exact: true }).boundingBox(),
      ]);
      assert(query && preview && (query.x + query.width <= preview.x || query.y + query.height <= preview.y), "Task controls must not overlap");
    }
    await images().getByRole("img").scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(out, "archived-reference-restarted.png") });
    assert.equal(assetReads, 3); assert.equal(submissions, 2);
  });
  await step("A separately generated clean background preserves both reference choices; changing requirements invalidates the quote", async () => {
    refuseAssets = false;
    await price("scene-001", "cleanPlate");
    await images().getByRole("textbox", { name: "补充要求（修改后可重新生成）", exact: true }).fill("An empty sky background");
    await expect(images().getByText(/最高 3 积分/)).toHaveCount(0);
    assert.equal(submissions, 2);
    const clean = await generateAsset("cleanPlate", "", "An empty sky background");
    await reviewAsset(clean);
    const selected = (await invoke("coursewareSceneImageList", { sessionId })).filter(row => row.selected);
    assert.equal(selected.length, 3);
    assert.equal(selected.filter(row => row.target.kind === "visualMaster").length, 2);
    assert.equal(submissions, 3);
  });
  await step("Opaque layer refuses native archival; explicit prompt regeneration permits transparent named layers and replaces only its own slot", async () => {
    const opaque = await generateAsset("layer", "小兔");
    await assetRow(opaque.intentId).getByRole("button", { name: "归档并预览图片", exact: true }).click();
    await expect(images().getByRole("alert")).toContainText("REQUIRES_TRANSPARENT_PNG");
    assert.equal((await invoke("coursewareSceneImageList", { sessionId })).find(row => row.intentId === opaque.intentId).asset, null);
    const rabbit = await generateAsset("layer", "小兔", "Isolate the rabbit on a transparent background");
    await reviewAsset(rabbit);
    const apple = await generateAsset("layer", "苹果");
    await reviewAsset(apple);
    const revised = await generateAsset("layer", "小兔", "Keep transparency and make the rabbit smile");
    await reviewAsset(revised);
    const rows = await invoke("coursewareSceneImageList", { sessionId });
    assert.equal(rows.find(row => row.intentId === rabbit.intentId).selected, false);
    assert.equal(rows.find(row => row.intentId === revised.intentId).selected, true);
    assert.equal(rows.find(row => row.intentId === apple.intentId).selected, true);
    assert.equal(rows.filter(row => row.selected).length, 5);
    report.roleSelections = rows;
    assert.equal(submissions, 7); assert.equal(assetReads, 8);
    await page.screenshot({ path: join(out, "independent-layer-review.png") });
  });
  await step("All role-specific choices and transparent layer previews survive a complete restart with downloads disabled", async () => {
    refuseAssets = true;
    await stop(); await start();
    await images().getByRole("button", { name: "刷新已保存任务", exact: true }).click();
    const rows = await invoke("coursewareSceneImageList", { sessionId });
    assert.deepEqual(rows, report.roleSelections);
    await expect(images().getByText("已采用为本页此用途素材", { exact: true })).toHaveCount(3);
    for (const intent of rows.filter(row => row.selected && row.target.kind !== "visualMaster")) {
      const row = assetRow(intent.intentId);
      await row.getByRole("button", { name: "预览已归档图片", exact: true }).click();
      await expect.poll(() => row.getByRole("img").evaluate(node => node.complete && node.naturalWidth)).toBe(intent.asset.width);
    }
    assert.equal(submissions, 7); assert.equal(assetReads, 8);
    await page.screenshot({ path: join(out, "role-selections-restarted.png") });
  });
  await step("Plan revision retains old tasks as stale and requires reapproval before a new quote", async () => {
    const revised = structuredClone(plan); revised.pages[0].visualIntent = "A red circle flower";
    await writeFile(savedPath(), JSON.stringify(revised));
    await planning().getByRole("button", { name: "刷新教学规划", exact: true }).click();
    await expect(planning().getByText("规划已修改，请重新审核并确认。", { exact: true })).toBeVisible();
    await expect(images().getByRole("button", { name: "读取生图模型", exact: true })).toBeDisabled();
    await images().getByRole("button", { name: "刷新已保存任务", exact: true }).click();
    await expect(images().getByText("此任务属于旧版规划，结果不会自动应用到新版。", { exact: true })).toHaveCount(8);
    const old = assetRow(report.archived[0].intentId);
    await old.getByRole("button", { name: "预览已归档图片", exact: true }).click();
    await expect(old.getByRole("img")).toBeVisible();
    await expect(images().getByRole("button", { name: "采用为本页画面参考", exact: true })).toHaveCount(0);
    const oldIntent = (await invoke("coursewareSceneImageList", { sessionId }))[0];
    await assert.rejects(invoke("coursewareSceneImageAdopt", { sessionId, intentId: oldIntent.intentId, expectedSelectedIntentId: oldIntent.intentId }), /PLAN_CHANGED/);
    await planning().getByRole("button", { name: "确认当前规划", exact: true }).click();
    await price("scene-001");
    assert.equal((await invoke("coursewareSceneImageList", { sessionId })).length, 9);
    assert.equal(submissions, 7);
    await images().getByRole("checkbox").scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(out, "revised-plan-quote.png") });
  });
  await step("Foreign Chat reads and extra payload fields cannot borrow original intents or submit", async () => {
    const other = (await invoke("sessionCreate", { title: "Other Chat", projectPath: workspace, providerId, modelId: "unused", mode: "agent" })).session.id;
    await invoke("coursewareTaskSet", { sessionId: other, taskType: "scene", educationContext: {} });
    await assert.rejects(invoke("coursewareSceneImageList", { sessionId: other }), /CONTEXT_CHANGED/);
    await assert.rejects(invoke("coursewareSceneImagePrepare", { sessionId, planSha256: "a".repeat(64), pageId: "scene-001", model: "scene-image", input: "forged" }), /INVALID_REQUEST/);
    assert.equal(submissions, 7);
  });
  await step("Restored approved plan reuses old private choices; every page must have reviewed background and layers before compilation", async () => {
    await writeFile(savedPath(), JSON.stringify(plan));
    await planning().getByRole("button", { name: "刷新教学规划", exact: true }).click();
    await planning().getByRole("button", { name: "确认当前规划", exact: true }).click();
    await images().getByRole("button", { name: "刷新已保存任务", exact: true }).click();
    await expect(images().getByRole("button", { name: "生成可编辑 PPTX", exact: true })).toBeDisabled();
    refuseAssets = false;
    await reviewAsset(await generateAsset("cleanPlate", "", "An empty garden", "scene-002"));
    await reviewAsset(await generateAsset("layer", "Square", "A separate square", "scene-002"));
    await expect(images().getByRole("button", { name: "生成可编辑 PPTX", exact: true })).toBeEnabled();
    report.compilationInputs = await invoke("coursewareSceneImageList", { sessionId });
    assert.equal(submissions, 9); assert.equal(assetReads, 10); refuseAssets = true;
    assert.equal(referenceRequests.length, 7); report.referenceRequests = referenceRequests;
  });
  await step("Visible cancel stops the actual model request and never attaches a PPTX or repeats image generation", async () => {
    holdModel = true;
    await images().getByRole("button", { name: "生成可编辑 PPTX", exact: true }).click();
    await expect.poll(() => modelRequests.length, { timeout: 30_000 }).toBe(1);
    await images().getByRole("button", { name: "取消生成", exact: true }).click();
    holdModel = false; releaseModel?.();
    await expect(images().getByRole("alert")).toBeVisible();
    await expect(images().getByRole("button", { name: "生成可编辑 PPTX", exact: true })).toBeEnabled();
    assert.equal((await invoke("coursewareTaskGet", { sessionId })).task.generatedPath, undefined);
    assert.equal(submissions, 9); assert.equal(assetReads, 10);
  });
  await step("Public generation compiles both pages, attaches planned narration and opens independently editable WiseOffice objects", async () => {
    await images().getByRole("button", { name: "生成可编辑 PPTX", exact: true }).click();
    const { host, sdk } = await nativeEditor();
    const task = (await invoke("coursewareTaskGet", { sessionId })).task;
    assert(task.generatedPath); report.generatedPath = task.generatedPath;
    report.beforeEdit = await nativeState(sdk);
    assert.equal(report.beforeEdit.slides.length, 2);
    assert.deepEqual(report.beforeEdit.slides.map(slide => slide.length), [3, 2]);
    assert(report.beforeEdit.slides[0][0].text.includes("Circle"));
    assert(report.beforeEdit.slides[1][0].text.includes("Square"));
    assert(Math.abs(report.beforeEdit.width / report.beforeEdit.height - 1.6) < 0.0001);
    const view = await invoke("pptEditorTeachingOpen", { sessionId });
    assert.deepEqual(view.project.pages.map(p => p.actions.filter(a => a.type === "speech").map(a => a.text).join("")), plan.pages.map(p => p.narration));
    assert.equal(view.teachingObjects.length, 3);
    assert(view.teachingObjects.every(object => object.status === "mapped"));
    assert.deepEqual(view.teachingObjects.filter(object => object.role).map(object => object.aliases), [["Circle"], ["Circle"]]);
    assert(view.teachingObjects.every(object => Object.keys(object).every(key => ["objectId", "name", "role", "aliases", "status", "effectTargetEligible"].includes(key))));
    report.generatedObjects = view.teachingObjects;
    await page.locator(".courseware-teaching").getByRole("button", { name: "读取当前页讲解", exact: true }).click();
    await page.locator(".courseware-teaching .courseware-scene-objects summary").click();
    await expect(page.locator(".courseware-scene-objects li")).toHaveCount(3);
    await page.screenshot({ path: join(out, "generated-teaching-objects.png") });
    report.generatedTeaching = view.project;
    await host.screenshot({ path: join(out, "generated-editable-scene.png") });
    assert.equal(modelRequests.length, 3); assert.equal(submissions, 9); assert.equal(assetReads, 10);
  });
  if (!keepInitial) await step("Native text editing saves the real generated PPTX; peers and independent layers survive full Desktop/Host/Office restart", async () => {
    const { sdk } = await nativeEditor();
    await sdk.evaluate(() => { const api = window.Asc.editor, shape = api.WordControl.m_oLogicDocument.Slides[0].cSld.spTree[0];
      shape.Set_CurrentElement(); shape.getDocContent().SelectAll(); api.WordControl.m_oLogicDocument.Document_UpdateSelectionState(); });
    const target = await invoke("pptEditorGetContext");
    const result = await invoke("pptEditorExecute", { projectId: target.projectId, documentId: target.documentId, sessionId: target.sessionId,
      editGeneration: target.editGeneration, requestId: "scene-generated-edit", tool: "replace_selection", input: { text: "Edited circle" } });
    assert.equal(result.status, "verified");
    report.afterEdit = await nativeState(sdk);
    assert(report.afterEdit.slides[0][0].text.includes("Edited circle"));
    assert.deepEqual(report.afterEdit.slides[0].slice(1), report.beforeEdit.slides[0].slice(1));
    assert.deepEqual(report.afterEdit.slides[1], report.beforeEdit.slides[1]);
    await page.locator(".ppt-editor-toolbar").getByRole("button", { name: "保存到原文件", exact: true }).click();
    const teaching = page.locator(".courseware-teaching");
    const reviewStart = teaching.getByRole("button", { name: "审核已保存的 PPTX 变更", exact: true });
    await expect(reviewStart).toBeEnabled({ timeout: 120_000 });
    report.savedSha256 = createHash("sha256").update(await readFile(report.generatedPath)).digest("hex");
    assert.notEqual(report.savedSha256, report.generatedTeaching.source.sha256);
    await assert.rejects(invoke("pptEditorTeachingOpen", { sessionId }), /COURSEWARE_CONFLICT.*reconcile/);
    await reviewStart.click();
    const review = page.locator(".courseware-source-review"), choices = review.locator("select");
    await expect(choices).toHaveCount(2, { timeout: 120_000 });
    const adopt = review.getByRole("button", { name: "采用这些关联", exact: true });
    for (let index = 0; index < 2; index++) {
      await expect(choices.nth(index)).toHaveValue("");
      await choices.nth(index).selectOption(String(index));
    }
    await expect(adopt).toBeDisabled();
    await review.getByRole("checkbox").check();
    await adopt.click();
    await expect(review).toHaveCount(0, { timeout: 120_000 });
    const associatedView = await invoke("pptEditorTeachingOpen", { sessionId });
    report.associatedTeaching = associatedView.project;
    report.associatedObjects = associatedView.teachingObjects;
    assert.equal(report.associatedObjects.length, 3);
    assert(["missing", "content_changed"].includes(report.associatedObjects[0].status));
    assert(report.associatedObjects.slice(1).every(object => ["mapped", "missing"].includes(object.status)));
    assert.deepEqual(report.associatedObjects.map(object => object.objectId), report.generatedObjects.map(object => object.objectId));
    assert.equal(report.associatedTeaching.source.sha256, report.savedSha256);
    assert.equal(report.associatedTeaching.projectId, report.generatedTeaching.projectId);
    assert.deepEqual(report.associatedTeaching.pages.map(({ pageId, actions }) => ({ pageId, actions })),
      report.generatedTeaching.pages.map(({ pageId, actions }) => ({ pageId, actions })));
    await stop(); await start();
    await page.getByRole("button", { name: "打开场景课件 PPT", exact: true }).click();
    const reopened = await nativeEditor();
    assert.deepEqual(await nativeState(reopened.sdk), report.afterEdit);
    assert.deepEqual((await invoke("pptEditorTeachingOpen", { sessionId })).project, report.associatedTeaching);
    assert.deepEqual((await invoke("pptEditorTeachingOpen", { sessionId })).teachingObjects, report.associatedObjects);
    assert.equal(createHash("sha256").update(await readFile(report.generatedPath)).digest("hex"), report.savedSha256);
    await reopened.host.screenshot({ path: join(out, "edited-scene-reopened.png") });
    assert.equal(modelRequests.length, 3); assert.equal(submissions, 9); assert.equal(assetReads, 10);
  });
  if (keepInitial) {
    report.savedSha256 = createHash("sha256").update(await readFile(report.generatedPath)).digest("hex");
    report.associatedTeaching = report.generatedTeaching;
    assert.equal(report.savedSha256, report.generatedTeaching.source.sha256);
  }
  assert(!logs.some(line => /PAGEERROR|FIXTUREERROR/.test(line)), logs.filter(line => /PAGEERROR|FIXTUREERROR/.test(line)).join("\n"));
  report.status = keepInitial ? "PASS_SCENE_REVIEW_COMPILE_INITIAL_SOURCE" : "PASS_SCENE_REVIEW_COMPILE_NATIVE_EDIT_SAVE_RESTART";
  }
} catch (error) {
  report.status = "FAIL"; report.error = String(error.stack); console.error(error); process.exitCode = 1;
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(out, "failure.png") }).catch(() => {});
    await writeFile(join(out, "failure-aria.txt"), await page.locator("body").ariaSnapshot()).catch(() => {});
  }
} finally {
  await stop(); await new Promise(resolve => server.close(resolve));
  report.submissions = submissions;
  report.assetReads = assetReads;
  report.modelRequests = modelRequests;
  report.tasks = [...tasks.values()].map(({ idempotencyKey: _key, requestHash: _hash, ...task }) => task);
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(join(out, "http.json"), JSON.stringify(http, null, 2) + "\n");
  await writeFile(join(out, "main.log"), logs.join("\n"));
}
