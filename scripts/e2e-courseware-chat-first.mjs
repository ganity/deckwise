/** Actual Desktop/Host/Agent and compilation; identity, model and media use loopback fixtures. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { coursewareLaunch } from "./e2e/boot.mjs";
import { chatFirstEditResponse, chatFirstNarrationResponse, chatFirstRedoSceneResponse, testChatFirstEditing } from "./e2e/chat-first-edit.mjs";

const launch = coursewareLaunch();
assert(process.env.DECKWISE_E2E_OUTPUT && (launch.packaged || process.env.PI_DESKTOP_HOST_BIN));
assert(process.env.DECKWISE_EDITOR_URL, "Use an isolated local WiseOffice preview");
const out = resolve(process.env.DECKWISE_E2E_OUTPUT);
await mkdir(out, { recursive: false });
const directory = await mkdtemp(join(tmpdir(), "deckwise-chat-first-"));
const workspace = join(directory, "workspace");
await mkdir(workspace);
await mkdir(join(directory, "data/auth"), { recursive: true });
await writeFile(join(directory, "data/auth/session.token"), "chat-first-fixture-refresh", { mode: 0o600 });
const require = createRequire(new URL("../packages/courseware-runtime/package.json", import.meta.url));
const { _electron, expect } = require("@playwright/test");
const sharp = require("sharp"), JSZip = require("jszip");
const visualMaster = await sharp({ create: { width: 640, height: 400, channels: 4, background: "#40a060" } }).png().toBuffer();
const cleanPlate = await sharp({ create: { width: 640, height: 400, channels: 4, background: "#e8f4ff" } }).png().toBuffer();
const layer = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: await sharp({ create: { width: 32, height: 40, channels: 4, background: "#e05050" } }).png().toBuffer(), left: 16, top: 12 }]).png().toBuffer();
const imageBytes = [visualMaster, cleanPlate, layer], mediaTasks = new Map();
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const hashRequest = r => hash("courseware-media-v1" + [r.kind, r.model, r.input, null,
  ...(r.referenceImage ? [r.referenceImage.sha256, r.referenceImage.mimeType, String(r.referenceImage.byteLength)] : [])]
  .map(value => `:${value === null ? -1 : value.length}:${value ?? ""}`).join(""));
const report = { status: "RUNNING", packaged: launch.packaged, checks: [], directory, paidCalls: false, identityFixture: true, modelFixture: true, mediaFixture: true, sandbox: "--no-sandbox" };
const logs = [], requests = [], mediaRequests = [];
const token = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
const plan = { title: "Garden shapes", pages: [{ title: "Circle", visibleText: ["Circle"], visualIntent: "A round flower with a separate title", narration: "Look! A circle. Good!" }] };
const ordinaryProject = ".deckwise-ppt/projects/chat-first-circle_ppt169_20261025";
const ordinaryFiles = await Promise.all(["design_spec.md", "spec_lock.md", "notes/total.md", "svg_output/01_circle.svg"]
  .map(async path => ({ path, content: await readFile(new URL(`./e2e/fixtures/ordinary-courseware/${path}`, import.meta.url), "utf8") })));
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const runFile = promisify(execFile);
let ordinaryRuntime;
let app, page, sessionId, sequence = 0, compiledPages = 0;
const plain = value => typeof value === "string" ? value : Array.isArray(value) ? value.map(item => item.text ?? "").join("\n") : JSON.stringify(value);
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    const send = data => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ code: 200, data })); };
    if (["/auth/desktop/refresh", "/auth/refresh"].includes(url.pathname))
      return send({ status: "SUCCESS", accessToken: token, refreshToken: "chat-first-fixture-refresh" });
    if (url.pathname === "/auth/me") return send({ edition: "EDUCATION", pcAllowed: true, role: "ADMIN", tenantId: 8, userId: 7 });
    if (url.pathname === "/auth/logout") return send({});
    if (url.pathname.startsWith("/courseware/media/")) {
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      mediaRequests.push({ path: url.pathname, method: req.method });
      if (url.pathname === "/courseware/media/models") return send([{ model: "scene-image", voices: [], providerDefaultVoice: false, supportsReferenceImage: true }]);
      if (url.pathname === "/courseware/media/models/scene-image/quote") {
        const expires = Math.floor(Date.now() / 1000) + 300;
        return send({ version: "courseware-media-quote-v1", kind: "image", model: "scene-image", priceVersion: "fixture-v1", maxPoints: 3, maxChars: 4000,
          expiresAt: new Date(expires * 1000).toISOString(), quoteToken: `${expires}.${"a".repeat(43)}` });
      }
      if (url.pathname === "/courseware/media/tasks/confirmed" && req.method === "POST") {
        assert(mediaTasks.size < 3, "Only three explicitly confirmed fixture submissions are allowed");
        let raw = ""; for await (const chunk of req) raw += chunk;
        const { request, confirmation } = JSON.parse(raw), index = mediaTasks.size;
        assert.equal(confirmation.maxPoints, 3); assert.equal(confirmation.priceVersion, "fixture-v1");
        assert.equal(request.kind, "image"); assert.equal(request.model, "scene-image");
        if (index) {
          assert.equal(request.referenceImage.sha256, hash(visualMaster));
          assert.deepEqual(Buffer.from(request.referenceImage.bytesBase64, "base64"), visualMaster);
        } else assert.equal(request.referenceImage, undefined);
        const bytes = imageBytes[index], metadata = await sharp(bytes).metadata();
        const task = { version: "courseware-media-v1", kind: "image", taskId: `chat-first-image-${index + 1}`,
          idempotencyKey: req.headers["idempotency-key"], requestHash: hashRequest(request), model: request.model,
          state: "ready", feeState: "settled", reservedPoints: 3, actualPoints: 3, errorCode: null,
          receiptId: `courseware-media:chat-first-image-${index + 1}`,
          assetRef: { assetId: `chat-first-asset-${index + 1}`, sha256: hash(bytes), mime: "image/png", byteLength: bytes.length,
            width: metadata.width, height: metadata.height, downloadPath: `/courseware/media/tasks/chat-first-image-${index + 1}/asset` } };
        mediaTasks.set(task.idempotencyKey, task); return send(task);
      }
      const task = [...mediaTasks.values()].find(item => url.pathname === `/courseware/media/tasks/${item.taskId}` || url.pathname === item.assetRef.downloadPath);
      if (task) {
        if (url.pathname === task.assetRef.downloadPath) { res.setHeader("content-type", "image/png"); return res.end(imageBytes[Number(task.taskId.at(-1)) - 1]); }
        return send(task);
      }
      if (url.pathname === "/courseware/media/tasks/by-idempotency") {
        const task = mediaTasks.get(url.searchParams.get("key")); assert(task);
        assert.equal(url.searchParams.get("requestHash"), task.requestHash); return send(task);
      }
      assert.fail(`Unexpected media request: ${req.method} ${url.pathname}`);
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ data: [{ id: "chat-first-fixture" }] }));
    }
    assert.equal(url.pathname, "/v1/chat/completions");
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (!body.stream) { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ id: "title", choices: [{ message: { role: "assistant", content: "Garden shapes" }, finish_reason: "stop" }] })); }
    requests.push(body); assert(requests.length <= 128, "Bound the fixture model loop");
    const last = body.messages.findLastIndex(item => item.role === "user"), user = plain(body.messages[last]?.content);
    const rows = body.messages.slice(last + 1), calls = rows.flatMap(item => item.tool_calls ?? []);
    const lastCall = name => calls.findLast(call => call.function?.name === name);
    const result = name => rows.find(item => item.role === "tool" && item.tool_call_id === lastCall(name)?.id);
    const has = name => body.tools?.some(tool => tool.function?.name === name);
    let name, args, content;
    let scene;
    try { scene = JSON.parse(Array.isArray(body.messages[last]?.content) ? body.messages[last].content.find(item => item.type === "text")?.text : user); } catch {}
    if (scene?.canvas && Array.isArray(scene.availableAssets) && scene.availableAssets.length === 2) {
      content = chatFirstRedoSceneResponse(scene, report.ordinary.visuals, report.ordinary.pptxReview.installedSha256);
    } else if (scene?.canvas && Array.isArray(scene.availableAssets)) {
      compiledPages++;
      const layers = scene.availableAssets.filter(asset => ![scene.visualMasterAssetId, scene.cleanPlateAssetId].includes(asset.assetId));
      assert.equal(layers.length, 1);
      content = JSON.stringify({ version: 1, slideId: scene.pageId, sourceHash: scene.sourceHash, canvas: scene.canvas,
        visualMasterAssetId: scene.visualMasterAssetId, cleanPlateAssetId: scene.cleanPlateAssetId,
        elements: [{ id: "title", type: "native_text", bboxPx: [70, 55, 900, 110], zIndex: 1, content: "Circle",
          style: { fontFace: "Arial", fontSizePt: 36, color: "#173B65" } },
          { id: "flower", type: "image_layer", layerRoute: "A1", assetId: layers[0].assetId, bboxPx: [280, 240, 240, 240], zIndex: 2,
            semanticRole: "Circle flower", spokenAliases: ["Circle"], objectKind: "prop", animationPolicy: "static" }] });
    } else if (body.messages.some(row => row.role === "system" && plain(row.content).includes("Rewrite only this page."))) {
      content = chatFirstNarrationResponse(body, plain);
    } else if (/CHAT_FIRST_(EDIT|REWRITE|FADE|REDO)\b/.test(user)) {
      assert(user.includes("The Host bound this Chat to the active Office PPTX"), "Use the native editing route after generation");
      ({ name, args, content } = chatFirstEditResponse({ body, user, has, result, plain }));
    } else if (user.includes("# Skill:") && user.includes("(deckwise/ppt-master)")) {
      const exporting = user.endsWith("页面内容已确认，请完成最终检查并生成可编辑的 PPT 文件，无需再次确认。");
      const repairing = user.includes("User request:\n请继续修复当前课件生成结果");
      assert(exporting || repairing || user.includes("CHAT_FIRST_ORDINARY"), "Unexpected ordinary request");
      const skill = user.match(/absolute PPT Master skill directory is `([^`]+)`/)?.[1];
      const python = user.match(/bundled Python executable is `([^`]+)`/)?.[1];
      assert(skill && python, "Use the actual Host-selected skill and Python distribution");
      ordinaryRuntime = { skill, python };
      const browserTool = body.tools?.find(tool => tool.function?.name.endsWith("_Browser"))?.function.name;
      const files = exporting ? [] : repairing ? ordinaryFiles.filter(file => file.path.endsWith(".svg")) : ordinaryFiles;
      const next = files.find(file => !calls.some(call => call.function?.name === "Write" && JSON.parse(call.function.arguments).path === `${ordinaryProject}/${file.path}`));
      const commands = [
        ["project_manager.py", "validate", join(workspace, ordinaryProject)],
        ["svg_quality_checker.py", join(workspace, ordinaryProject), "--canonical-authoring", "--stage", "final", "--json"],
        ...(exporting ? [["total_md_split.py", join(workspace, ordinaryProject)],
          ["finalize_svg.py", join(workspace, ordinaryProject)], ["svg_to_pptx.py", join(workspace, ordinaryProject)]] :
          [["svg_editor/server.py", join(workspace, ordinaryProject), "--live", "--daemon", "--no-browser"]]),
      ].map(([script, ...argv], index) => [python, join(skill, "scripts", script), ...argv].map(shellQuote).join(" ") + ` && printf '__ORDINARY_STEP_${index}_OK__\\n'`);
      const command = commands.find((_, index) => !rows.some(row => row.role === "tool" && plain(row.content).includes(`__ORDINARY_STEP_${index}_OK__`)));
      if (next) {
        if (!has("Write")) { name = "ToolSearch"; args = { query: "Write" }; }
        else { name = "Write"; args = { path: `${ordinaryProject}/${next.path}`, content: next.content }; }
      } else if (command) {
        if (!has("Bash")) { name = "ToolSearch"; args = { query: "Bash" }; }
        else { assert(!calls.some(call => call.function?.name === "Bash" && JSON.parse(call.function.arguments).command === command),
          `An official command failed: ${plain(result("Bash")?.content)}`); name = "Bash"; args = { command, timeout: 120 }; }
      } else if (!exporting && !(browserTool && lastCall(browserTool))) {
        if (!browserTool) { assert(!calls.some(call => call.function?.name === "ToolSearch" && JSON.parse(call.function.arguments).query === "browser"), "Browser activation failed");
          name = "ToolSearch"; args = { query: "browser" }; }
        else { const lock = JSON.parse(await readFile(join(workspace, ordinaryProject, "live_preview/lock.json"), "utf8"));
          name = browserTool; args = { action: "navigate", url: `http://127.0.0.1:${lock.port}` }; }
      } else {
        content = exporting ? `CHAT_FIRST_ORDINARY_EXPORTED：${ordinaryProject}/exports` :
          `CHAT_FIRST_ORDINARY_${repairing ? "REPAIRED" : "PREVIEW"}：${ordinaryProject}/svg_output/01_circle.svg`;
      }
    } else if (!has("courseware_workflow_get")) { name = "ToolSearch"; args = { query: "courseware_workflow_get courseware_scene_image_prepare courseware_scene_compile Write" }; }
    else if (!lastCall("courseware_workflow_get")) { name = "courseware_workflow_get"; args = {}; }
    else if (user.includes("No Office editing binding is active")) {
      assert(plain(result("courseware_workflow_get")?.content).includes('"imported":false'));
      content = "IMPORT_REQUIREMENTS_READY：可以先说明讲解要求，再点击下方选择已有 PPT。";
    } else {
      const path = JSON.parse(user.match(/Host-selected scene planning file is ("[^"]+")/)?.[1] ?? "null");
      assert.equal(path, `.deckwise-ppt/scenes/${sessionId}/plan.json`);
      if (user.includes("CHAT_FIRST_SCENE")) {
        if (!has("Write")) { name = "ToolSearch"; args = { query: "Write" }; }
        else if (!lastCall("Write")) { name = "Write"; args = { path, content: JSON.stringify(plan, null, 2) }; }
        else { assert(result("Write")); content = "CHAT_FIRST_PLAN_READY：已保存逐页规划，请查看并确认。"; }
      } else {
        const state = plain(result("courseware_workflow_get")?.content);
        const hash = state.match(/"approvedSha256":"([a-f0-9]{64})"/)?.[1];
        assert(hash, "The continuation must read a real approved plan");
        const selected = JSON.parse(state).images.filter(image => image.current && image.selected);
        if (selected.length === 3) {
          if (!has("courseware_scene_compile")) { name = "ToolSearch"; args = { query: "courseware_scene_compile" }; }
          else if (!lastCall("courseware_scene_compile")) { name = "courseware_scene_compile"; args = { planSha256: hash }; }
          else { const output = plain(result("courseware_scene_compile")?.content);
            content = output.includes('"generated":true') ? "CHAT_FIRST_COMPILED：已保存可编辑 PPT 和逐页讲解。" : `CHAT_FIRST_COMPILE_FAILED：${output}`; }
        } else if (!has("courseware_scene_image_prepare")) { name = "ToolSearch"; args = { query: "courseware_scene_image_prepare" }; }
        else if (!lastCall("courseware_scene_image_prepare")) {
          name = "courseware_scene_image_prepare";
          const target = selected.length === 0 ? { kind: "visualMaster" } : selected.length === 1 ? { kind: "cleanPlate" } : { kind: "layer", name: "Flower" };
          args = { planSha256: hash, pageId: "scene-001", model: "scene-image", target,
            ...(selected.length ? { referenceIntentId: selected.find(image => image.target.kind === "visualMaster").intentId } : {}) };
        } else { assert(result("courseware_scene_image_prepare")); content = "CHAT_FIRST_ASSET_PREPARED：请查看下方报价，确认后才会生成图片。"; }
      }
    }
    const delta = name ? { role: "assistant", tool_calls: [{ index: 0, id: `chat_first_${++sequence}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }
      : { role: "assistant", content };
    const base = { id: `completion_${++sequence}`, object: "chat.completion.chunk", created: 1, model: body.model };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: name ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  } catch (error) { logs.push(`FIXTUREERROR ${error.stack}`); res.statusCode = 500; res.end("Fixture error"); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const invoke = (name, ...args) => page.evaluate(async ({ name, args }) => {
  const response = await window.piDesktop.invoke(window.piDesktop.channels.invoke[name], ...args);
  if (!response.ok) throw new Error(JSON.stringify(response.error)); return response.data;
}, { name, args });
const workflow = () => page.locator(".courseware-chat-workflow");
const composer = () => page.locator('.composer-input[contenteditable="true"]');
async function stop() {
  if (!app) return;
  const child = app.process();
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once("exit", resolve));
    await app.evaluate(({ app }) => app.exit(0)); await exited;
  }
  app = null;
}
async function start() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/api.?key|secret|token|password|proxy/i.test(key)));
  app = await _electron.launch({ executablePath: launch.executablePath, cwd: launch.cwd, args: ["--no-sandbox", `--user-data-dir=${join(directory, "profile")}`, ...launch.args],
    env: { ...env, ELECTRON_RUN_AS_NODE: "", ELECTRON_RENDERER_URL: "", PI_DESKTOP_DATA_DIR: join(directory, "data"),
      DECKWISE_PLATFORM_BASE_URL: `http://127.0.0.1:${server.address().port}`, PI_DESKTOP_START_MAXIMIZED: "0" }, timeout: 60_000 });
  for (const stream of [app.process().stdout, app.process().stderr]) stream.on("data", bytes => logs.push(String(bytes)));
  page = await app.firstWindow({ timeout: 60_000 });
  const runtime = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, appPath: app.getAppPath(), executablePath: process.execPath }));
  assert.equal(runtime.packaged, launch.packaged);
  report.runtime = runtime;
  page.on("pageerror", error => logs.push(`PAGEERROR ${error.stack}`));
  await app.evaluate(({ session, BrowserWindow }) => {
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url); callback({ cancel: /^https?:$/.test(url.protocol) && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) });
    });
    BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1440, height: 1000 });
  });
  await page.waitForFunction(() => !!window.__PI_DESKTOP__ && !document.querySelector(".auth-shell"), null, { timeout: 60_000 });
  await expect(page.locator(".startup-splash")).toHaveCount(0, { timeout: 60_000 });
}
const step = async (name, run) => { console.log("START", name); await run(); report.checks.push(name); console.log("PASS", name); };
try {
  await start();
  await invoke("projectSet", workspace);
  const { provider } = await invoke("providersCreate", { name: "Chat-first model fixture", vendorKey: "custom", type: "openai_compatible", protocol: "openai_compatible",
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, authKind: "none", apiStyle: "chat_completions", defaultModelId: "chat-first-fixture",
    models: [{ id: "chat-first-fixture", contextWindow: 128000, maxTokens: 8192, thinkingLevels: [], defaultThinkingLevel: null, supportsImages: true }] });
  const { defaultCommandShell: _shell, ...settings } = await invoke("settingsGet");
  await invoke("settingsSet", { ...settings, language: "zh-CN", defaultProviderId: provider.id, defaultModelId: "chat-first-fixture" });
  await page.reload(); await page.waitForFunction(() => !!window.__PI_DESKTOP__);
  await step("The actual new-task dialog transfers a reviewed brief to Chat without sending or opening a workbench", async () => {
    await page.getByRole("toolbar", { name: "对话", exact: true }).getByRole("button", { name: "新建任务", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新建课件任务" });
    await expect(dialog.getByRole("radio")).toHaveCount(3);
    const create = dialog.getByRole("button", { name: "创建任务", exact: true });
    await create.focus(); await create.press("Tab");
    await expect(dialog.getByRole("button", { name: "关闭", exact: true })).toBeFocused();
    await dialog.getByRole("button", { name: "关闭", exact: true }).press("Shift+Tab");
    await expect(create).toBeFocused();
    await dialog.getByRole("radio", { name: /场景式课件生成/ }).check();
    await dialog.getByRole("textbox", { name: "课件需求（选填）" }).fill("CHAT_FIRST_SCENE 为幼儿园英语制作一页花园形状课件，含逐页讲解。");
    await dialog.getByRole("textbox", { name: "年级", exact: true }).fill("大班");
    await dialog.getByRole("combobox", { name: "学段", exact: true }).selectOption("kindergarten");
    await expect(dialog.getByRole("textbox", { name: "年级", exact: true })).toHaveValue("大班");
    await dialog.getByRole("combobox", { name: "学科", exact: true }).selectOption("english");
    await create.click();
    await expect(dialog).toHaveCount(0);
    await expect(composer()).toContainText("CHAT_FIRST_SCENE");
    assert.equal(requests.length, 0, "Creating a task must not dispatch the model");
    const tasks = (await invoke("sessionList")).sessions;
    sessionId = tasks[0].id;
    const { task } = await invoke("coursewareTaskGet", { sessionId });
    assert.equal(task.taskType, "scene"); assert.equal(task.educationContext.grade, "大班");
    await expect(page.locator(".ppt-master-tab")).toHaveCount(0);
    await page.screenshot({ path: join(out, "chat-before-send.png") });
  });
  await step("The main Chat saves and reviews a real plan without mounting the secondary controls", async () => {
    await composer().press("Enter");
    await expect(page.getByText(/CHAT_FIRST_PLAN_READY：/)).toBeVisible({ timeout: 90_000 });
    await expect(workflow().getByText("Garden shapes", { exact: false })).toBeVisible();
    assert.deepEqual(JSON.parse(await readFile(join(workspace, `.deckwise-ppt/scenes/${sessionId}/plan.json`), "utf8")), plan);
    await expect(page.locator(".ppt-master-scene-plan")).toHaveCount(0);
    const card = await workflow().boundingBox(), input = await composer().boundingBox();
    assert(card && input && card.y + card.height <= input.y, "The floating composer must not cover workflow actions");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1080, height: 760 }));
  });
  await step("Plan approval actually advances Agent tools to a prepared image and an unchecked quote", async () => {
    await workflow().getByRole("button", { name: "确认规划并继续", exact: true }).click();
    await expect(page.getByText(/CHAT_FIRST_ASSET_PREPARED：/)).toBeVisible({ timeout: 90_000 });
    const saved = (await invoke("coursewareScenePlanRead", { sessionId })).plan;
    assert.equal(saved.sha256, saved.approvedSha256);
    await workflow().getByRole("button", { name: "查看费用", exact: true }).click();
    await expect(workflow().getByRole("checkbox", { name: /我确认本次生成费用/ })).not.toBeChecked();
    await expect(workflow().getByRole("button", { name: "确认费用并生成图片", exact: true })).toBeDisabled();
    assert.equal(mediaRequests.filter(row => row.method === "POST").length, 0);
    const card = await workflow().boundingBox(), input = await composer().boundingBox();
    assert(card && input && card.y >= 0 && card.y + card.height <= input.y,
      "The workflow dock must remain above the composer at 1080x760");
    await page.screenshot({ path: join(out, "chat-plan-and-quote.png") });
  });
  await step("A full Desktop restart restores approval and the prepared intent without replay or spend", async () => {
    const requestCount = requests.length;
    await stop(); await start();
    await page.evaluate(id => window.__PI_DESKTOP__.selectSession(id), sessionId);
    await expect(workflow().getByRole("button", { name: "查看费用", exact: true })).toBeVisible();
    assert.equal(requests.length, requestCount);
    assert.equal((await invoke("coursewareSceneImageList", { sessionId })).length, 1);
    assert.equal(mediaRequests.filter(row => row.method === "POST").length, 0);
  });
  await step("Each explicit image review advances the same Chat until the actual compiler saves an editable PPTX", async () => {
    for (let index = 0; index < 3; index++) {
      await expect(workflow().getByRole("button", { name: "查看费用", exact: true })).toHaveCount(1);
      await workflow().getByRole("button", { name: "查看费用", exact: true }).click();
      const confirm = workflow().getByRole("checkbox", { name: /我确认本次生成费用/ });
      await expect(confirm).not.toBeChecked();
      const submit = workflow().getByRole("button", { name: "确认费用并生成图片", exact: true });
      await expect(submit).toBeDisabled();
      assert.equal(mediaTasks.size, index);
      if (index) await expect(workflow().getByRole("img", { name: "将发给图片服务的已选参考图", exact: true })).toBeVisible();
      await confirm.check(); await submit.click();
      const row = workflow().locator(".courseware-chat-image-row").last();
      await row.getByRole("button", { name: "查询状态 / 预览", exact: true }).click();
      await expect(workflow().getByRole("img", { name: "生成的课件图片", exact: true })).toBeVisible();
      const adopt = workflow().getByRole("button", { name: "选用图片并继续", exact: true });
      await expect(adopt).toBeDisabled();
      await workflow().getByRole("checkbox", { name: "我已查看这张图片，确认在课件中使用。", exact: true }).check();
      await adopt.click();
      if (index < 2) await expect(workflow().locator(".courseware-chat-image-row")).toHaveCount(index + 2, { timeout: 90_000 });
    }
    await expect(page.getByText(/CHAT_FIRST_COMPILED：|CHAT_FIRST_COMPILE_FAILED：/)).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText(/CHAT_FIRST_COMPILE_FAILED：/)).toHaveCount(0);
    await expect(workflow().getByRole("button", { name: "打开 PPT 编辑", exact: true })).toBeVisible();
    const { task } = await invoke("coursewareTaskGet", { sessionId });
    assert(task.generatedPath?.startsWith(join(workspace, ".deckwise-ppt/generated/")));
    const bytes = await readFile(task.generatedPath), zip = await JSZip.loadAsync(bytes);
    const slide = await zip.file("ppt/slides/slide1.xml").async("string");
    assert.match(slide, /<a:t>Circle<\/a:t>/); assert.match(slide, /<p:sp>/); assert.match(slide, /<p:pic>/);
    assert(!slide.includes(plan.pages[0].narration), "Narration must not leak into slide text");
    assert.equal(compiledPages, 1); assert.equal(mediaTasks.size, 3);
    await expect(page.locator(".ppt-master-tab")).toHaveCount(0);
    report.generated = { path: task.generatedPath, sha256: hash(bytes), compiledPages, fixtureSubmissions: mediaTasks.size };
    await page.screenshot({ path: join(out, "chat-compiled.png") });
  });
  await step("The Chat artifact action opens real WiseOffice with separate objects and the planned narration", async () => {
    await workflow().getByRole("button", { name: "打开 PPT 编辑", exact: true }).click();
    let nativePage, sdk;
    await expect.poll(async () => {
      nativePage = app.context().pages().find(target => target.url().startsWith("deckwise-editor:"));
      if (!nativePage) return false;
      for (const frame of nativePage.frames()) {
        if (await frame.evaluate(() => !!window.Asc?.editor?.isDocumentLoadComplete).catch(() => false)) { sdk = frame; return true; }
      }
      return false;
    }, { timeout: 120_000 }).toBe(true);
    const native = await sdk.evaluate(() => {
      const document = window.Asc.editor.WordControl.m_oLogicDocument;
      return document.Slides.map(slide => slide.cSld.spTree.map(shape => ({ text: !!shape.getDocContent?.(), width: shape.extX, height: shape.extY })));
    });
    assert.equal(native.length, 1); assert.equal(native[0].length, 2);
    assert(native[0].some(shape => shape.text)); assert(native[0].some(shape => !shape.text));
    const teaching = await invoke("pptEditorTeachingOpen", { sessionId });
    assert.deepEqual(teaching.project.pages.map(p => p.actions.filter(a => a.type === "speech").map(a => a.text).join("")), [plan.pages[0].narration]);
    assert(teaching.teachingObjects.every(object => object.status === "mapped"));
    report.generated.projectId = teaching.project.projectId;
    await nativePage.screenshot({ path: join(out, "chat-generated-office.png") });
    await expect(page.locator(".ppt-master-tab")).toHaveCount(0);
  });
  await step("An import task can discuss requirements in Chat before file selection", async () => {
    await page.getByRole("toolbar", { name: "对话", exact: true }).getByRole("button", { name: "新建任务", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新建课件任务" });
    await dialog.getByRole("radio", { name: /已有 PPT 导入/ }).check();
    await dialog.getByRole("textbox", { name: "课件需求（选填）" }).fill("请先记住：导入后将讲解改为适合三年级的短句。");
    await dialog.getByRole("button", { name: "创建任务", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(composer()).toContainText("导入后");
    await composer().press("Enter");
    await expect(page.getByText(/IMPORT_REQUIREMENTS_READY：/)).toBeVisible({ timeout: 90_000 });
    await expect(workflow().getByRole("button", { name: "选择已有 PPT", exact: true })).toBeVisible();
    await expect(page.locator(".ppt-master-tab")).toHaveCount(0);
    await page.screenshot({ path: join(out, "chat-import-requirements.png") });
  });
  await step("The Chat picker can cancel and then import the original PPTX into WiseOffice without the generation form", async () => {
    const { sessions } = await invoke("sessionList"), importedSession = sessions[0].id;
    await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
    await workflow().getByRole("button", { name: "选择已有 PPT", exact: true }).click();
    await expect(workflow().getByRole("button", { name: "选择已有 PPT", exact: true })).toBeEnabled();
    assert.equal((await invoke("coursewareTaskGet", { sessionId: importedSession })).task.importPath, undefined);
    assert.equal((await invoke("sessionList")).sessions.length, sessions.length);
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, report.generated.path);
    await workflow().getByRole("button", { name: "选择已有 PPT", exact: true }).click();
    await expect(workflow().getByRole("button", { name: "打开 PPT 编辑", exact: true })).toBeVisible({ timeout: 30_000 });
    const { task } = await invoke("coursewareTaskGet", { sessionId: importedSession });
    assert(task.importPath && task.importPath !== report.generated.path);
    assert.equal(hash(await readFile(task.importPath)), report.generated.sha256);
    let teaching;
    await expect.poll(async () => {
      try { teaching = await invoke("pptEditorTeachingOpen", { sessionId: importedSession }); return teaching.project.pages.length; }
      catch { return 0; }
    }, { timeout: 90_000 }).toBe(1);
    assert.equal(teaching.project.source.sha256, report.generated.sha256);
    assert.equal((await invoke("coursewareTaskGet", { sessionId })).task.generatedPath, report.generated.path);
    await expect(page.locator(".ppt-master-tab")).toHaveCount(0);
    assert.equal(mediaTasks.size, 3);
    report.imported = { sessionId: importedSession, sourceSha256: teaching.project.source.sha256, pickerFixture: true };
    await page.screenshot({ path: join(out, "chat-imported-office.png") });
  });
  await step("Ordinary PPT creation uses the same dialog and does not submit an unsent brief", async () => {
    const before = requests.length;
    await page.getByRole("toolbar", { name: "对话", exact: true }).getByRole("button", { name: "新建任务", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新建课件任务" });
    await expect(dialog.getByRole("radio", { name: /普通 PPT 生成/ })).toBeChecked();
    await dialog.getByRole("textbox", { name: "课件需求（选填）" }).fill("CHAT_FIRST_ORDINARY 给三年级制作一页英文圆形课件。正文：Circle / A circle has no corners. 附简短讲解词，不需要图片生成、动画或语音。");
    await dialog.getByRole("button", { name: "创建任务", exact: true }).click();
    await expect(dialog).toHaveCount(0); await expect(composer()).toContainText("CHAT_FIRST_ORDINARY");
    assert.equal(requests.length, before);
    const { sessions } = await invoke("sessionList");
    assert.equal((await invoke("coursewareTaskGet", { sessionId: sessions[0].id })).task.taskType, "plain");
    await expect(workflow().getByRole("status")).toHaveText("确认需求");
    report.ordinary = { sessionId: sessions[0].id, projectPath: ordinaryProject };
  });
  await step("Ordinary Chat authors saved pages and narration, passes official checks and opens the actual SVG preview", async () => {
    await composer().press("Enter");
    await expect(page.getByText(/CHAT_FIRST_ORDINARY_PREVIEW：/)).toBeVisible({ timeout: 120_000 });
    await expect(workflow().getByRole("button", { name: "预览与修改页面", exact: true })).toBeVisible();
    await expect(workflow().getByRole("button", { name: "生成可编辑 PPT", exact: true })).toBeEnabled();
    await expect(workflow().getByRole("status")).toHaveText("页面可预览");
    await expect(workflow().getByText("直接在 Chat 中说明主题和授课对象，也可以继续修改规划和讲解词。", { exact: true })).toHaveCount(0);
    const quality = JSON.parse(await readFile(join(workspace, ordinaryProject, "validation/svg_quality_report.json"), "utf8"));
    assert.equal(quality.stage, "final"); assert.equal(quality.summary.errors, 0);
    assert.equal(await readFile(join(workspace, ordinaryProject, "notes/total.md"), "utf8"), ordinaryFiles.find(file => file.path === "notes/total.md").content);
    const lock = JSON.parse(await readFile(join(workspace, ordinaryProject, "live_preview/lock.json"), "utf8"));
    const browser = await invoke("browserGetState");
    assert.equal(new URL(browser.url).port, String(lock.port), "The native browser must open this project's preview");
    await expect(page.locator(".ppt-master-tab")).toHaveCount(0);
    await page.screenshot({ path: join(out, "ordinary-preview.png") });
  });
  await step("Idle refresh rejects a changed ordinary page and Chat repairs it through both official gates", async () => {
    const source = ordinaryFiles.find(file => file.path.endsWith(".svg"));
    await writeFile(join(workspace, ordinaryProject, source.path), source.content.replace('font-size="40"', 'font-size="0"'));
    await workflow().getByRole("button", { name: "刷新状态", exact: true }).click();
    await expect(workflow().getByRole("button", { name: "生成可编辑 PPT", exact: true })).toBeDisabled();
    await expect(workflow().getByRole("status")).toHaveText("页面待修复");
    await workflow().getByRole("button", { name: "在 Chat 中修复当前页面", exact: true }).click();
    await expect(page.getByText(/CHAT_FIRST_ORDINARY_REPAIRED：/)).toBeVisible({ timeout: 120_000 });
    await expect(workflow().getByRole("button", { name: "生成可编辑 PPT", exact: true })).toBeEnabled();
    await expect(workflow().getByRole("status")).toHaveText("页面可预览");
    assert.equal(await readFile(join(workspace, ordinaryProject, source.path), "utf8"), source.content);
    await expect(workflow().getByRole("button", { name: "在 Chat 中修复当前页面", exact: true })).toHaveCount(0);
  });
  await step("An explicit ordinary export runs the official notes, finalize and PPTX tools then opens WiseOffice", async () => {
    await workflow().getByRole("button", { name: "生成可编辑 PPT", exact: true }).click();
    await expect(page.getByText(/CHAT_FIRST_ORDINARY_EXPORTED：/)).toBeVisible({ timeout: 120_000 });
    await expect(workflow().getByRole("button", { name: "打开 PPT 编辑", exact: true })).toBeEnabled();
    await expect(workflow().getByRole("status")).toHaveText("可以编辑");
    await workflow().getByRole("button", { name: "打开 PPT 编辑", exact: true }).click();
    let teaching;
    await expect.poll(async () => {
      try { teaching = await invoke("pptEditorTeachingOpen", { sessionId: report.ordinary.sessionId }); return teaching.project.pages.length; }
      catch { return 0; }
    }, { timeout: 90_000 }).toBe(1);
    const speech = teaching.project.pages[0].actions.filter(action => action.type === "speech").map(action => action.text).join("");
    assert.equal(speech, "Look at this circle. Trace its round edge. It has no corners. Good!");
    const exported = (await readdir(join(workspace, ordinaryProject, "exports"))).filter(file => file.endsWith(".pptx"));
    assert.equal(exported.length, 1);
    const bytes = await readFile(join(workspace, ordinaryProject, "exports", exported[0]));
    assert.equal(hash(bytes), teaching.project.source.sha256);
    const zip = await JSZip.loadAsync(bytes), slide = await zip.file("ppt/slides/slide1.xml").async("string");
    assert(slide.includes("Circle") && slide.includes("A circle has no corners."));
    assert(!slide.includes("<p:pic>"), "Ordinary text and geometry must stay native editable objects");
    assert((await zip.file("ppt/notesSlides/notesSlide1.xml").async("string")).includes(speech));
    let nativePage;
    await expect.poll(async () => {
      for (const target of app.context().pages().filter(target => target.url().startsWith("deckwise-editor:"))) {
        for (const frame of target.frames()) {
          const count = await frame.evaluate(() => {
            const slides = window.Asc?.editor?.WordControl?.m_oLogicDocument?.Slides;
            if (!window.Asc?.editor?.isDocumentLoadComplete || slides?.length !== 1) return 0;
            const leaves = objects => objects.flatMap(shape => Array.isArray(shape.spTree) ? leaves(shape.spTree) : [shape]);
            const objects = leaves(slides[0].cSld.spTree);
            return objects.some(shape => shape.getDocContent?.()?.GetText?.({}).includes("A circle has no corners.")) ? objects.length : 0;
          }).catch(() => 0);
          if (count === 3) { nativePage = target; return true; }
        }
      }
      return false;
    }, { timeout: 90_000 }).toBe(true);
    await nativePage.screenshot({ path: join(out, "ordinary-native-office.png") });
    assert.equal(mediaTasks.size, 3, "Ordinary generation must not submit paid media");
    report.ordinary.sourceSha256 = teaching.project.source.sha256;
    report.ordinary.nativeObjects = 3;
    await expect(page.locator(".ppt-master-tab")).toHaveCount(0);
    await page.screenshot({ path: join(out, "ordinary-wiseoffice.png") });
  });
  await testChatFirstEditing({ getPage: () => page, getApp: () => app, invoke, expect, workflow, composer, step, start, stop, workspace, report, hash, out,
    requestCount: () => requests.length });
  assert(!logs.some(line => /PAGEERROR|FIXTUREERROR/.test(line)), "Unexpected renderer or fixture failure");
  report.status = "PASS_CHAT_FIRST_PLAN_ASSETS_COMPILE_AND_WISEOFFICE";
} catch (error) {
  report.status = "FAIL"; report.error = String(error.stack); process.exitCode = 1; console.error(error);
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(out, "failure.png") }).catch(() => {});
    await writeFile(join(out, "failure-aria.txt"), await page.locator("body").ariaSnapshot()).catch(() => {});
  }
} finally {
  await stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (ordinaryRuntime) await runFile(ordinaryRuntime.python, [join(ordinaryRuntime.skill, "scripts/svg_editor/server.py"), join(workspace, ordinaryProject), "--shutdown"])
    .catch(error => { logs.push(`PREVIEW_CLEANUP_FAILED ${error}`); process.exitCode = 1; });
  report.modelRequests = requests.length; report.mediaRequests = mediaRequests;
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(join(out, "main.log"), logs.join("\n"));
}
