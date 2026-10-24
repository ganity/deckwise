/** Actual Electron/Main/Host/Chat canvas flow; identity and model are local fixtures. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, readdir, stat, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { coursewareLaunch } from "./e2e/boot.mjs";

assert(process.env.DECKWISE_E2E_OUTPUT && process.env.PI_DESKTOP_HOST_BIN);
const out = resolve(process.env.DECKWISE_E2E_OUTPUT);
await mkdir(dirname(out), { recursive: true }); await mkdir(out);
const root = dirname(new URL(import.meta.url).pathname);
const launch = coursewareLaunch();
const appDir = process.env.DECKWISE_E2E_APP_DIR ? resolve(process.env.DECKWISE_E2E_APP_DIR) : launch.cwd;
if (process.env.DECKWISE_E2E_APP_DIR) {
  assert(!launch.packaged, "The isolated source app override is unavailable in packaged validation");
  launch.cwd = appDir; launch.args = [appDir];
}
const artifacts = await Promise.all([
  resolve(appDir, "out/main/index.js"),
  ...((await readdir(resolve(appDir, "out/renderer/assets"))).filter(name => /^index-.*\.js$/.test(name)).map(name => resolve(appDir, "out/renderer/assets", name))),
  resolve(process.env.PI_DESKTOP_HOST_BIN),
  resolve(root, "../packages/agent-runtime/dist/sidecar.js"),
  resolve(root, "../packages/agent-runtime/dist/runtime.js"),
  resolve(root, "../packages/agent-runtime/dist/courseware-media-canvas-tools.js"),
].map(async path => {
  const [info, contents] = await Promise.all([stat(path), readFile(path)]);
  return { path, bytes: info.size, modifiedAt: info.mtime.toISOString(), sha256: createHash("sha256").update(contents).digest("hex") };
}));
const directory = await mkdtemp(join(tmpdir(), "deckwise-media-canvas-"));
const workspace = join(directory, "workspace"); await mkdir(workspace);
const { _electron, expect } = createRequire(new URL("../packages/courseware-runtime/package.json", import.meta.url))("@playwright/test");
const report = { status: "RUNNING", checks: [], directory, artifacts, paidCalls: false, modelFixture: true, identityFixture: true, sandbox: "--no-sandbox" };
const logs = [], requests = [];
let app, page, sessionId, providerId, sequence = 0, draftId;
const plain = value => typeof value === "string" ? value : Array.isArray(value) ? value.map(part => part.text ?? "").join("\n") : JSON.stringify(value);
const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ data: [{ id: "canvas-fixture" }] })); }
    let body = ""; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body); requests.push(payload); assert(requests.length <= 20);
    const lastUser = payload.messages.findLastIndex(row => row.role === "user");
    const user = plain(payload.messages[lastUser]?.content);
    if (!user.includes("CANVAS_CHAT_EDIT")) {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ id: "title", choices: [{ message: { role: "assistant", content: "Canvas draft" }, finish_reason: "stop" }] }));
    }
    const rows = payload.messages.slice(lastUser + 1), calls = rows.flatMap(row => row.tool_calls ?? []);
    const resultFor = name => {
      const call = calls.findLast(call => call.function?.name === name);
      return rows.find(row => row.role === "tool" && row.tool_call_id === call?.id);
    };
    let name, args;
    if (!["courseware_canvas_get", "courseware_canvas_edit"].every(name => payload.tools?.some(tool => tool.function.name === name))) {
      name = "ToolSearch"; args = { query: "courseware_canvas_get courseware_canvas_edit" };
    } else if (!resultFor("courseware_canvas_get")) {
      name = "courseware_canvas_get"; args = {};
    } else if (!resultFor("courseware_canvas_edit")) {
      const saved = JSON.parse(plain(resultFor("courseware_canvas_get").content));
      const target = saved.document.drafts.find(draft => draft.id === draftId);
      assert(target && target.prompt === "A friendly rabbit");
      name = "courseware_canvas_edit";
      args = { draftId, expectedRevision: target.revision, patch: { prompt: "A cheerful rabbit in a sunny garden" } };
    } else {
      const saved = JSON.parse(plain(resultFor("courseware_canvas_edit").content));
      assert.equal(saved.document.drafts.find(draft => draft.id === draftId).prompt, "A cheerful rabbit in a sunny garden");
    }
    const delta = name ? { role: "assistant", tool_calls: [{ index: 0, id: `canvas_${++sequence}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }
      : { role: "assistant", content: "CANVAS_CHAT_EDIT_DONE" };
    const base = { id: `canvas_completion_${++sequence}`, object: "chat.completion.chunk", created: 1, model: payload.model };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: name ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  } catch (error) { logs.push(`FIXTUREERROR ${error.stack}`); res.writeHead(500); res.end(String(error)); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const invoke = (name, ...args) => page.evaluate(async ({ name, args }) => {
  const response = await window.piDesktop.invoke(window.piDesktop.channels.invoke[name], ...args);
  if (!response.ok) throw new Error(JSON.stringify(response.error)); return response.data;
}, { name, args });
const canvas = () => page.locator(".courseware-media-canvas");
const properties = () => canvas().locator(".courseware-media-canvas-properties");
const read = () => invoke("coursewareMediaCanvasGet", { sessionId });
async function openCanvas() {
  await page.evaluate(() => { window.__PI_CAPTURE__ = true; window.__PI_DESKTOP__.openNewWorkPanelTab(); });
  await page.locator('[data-work-panel-launcher-item="media-canvas"]').click();
  await expect(canvas()).toBeVisible();
  await expect(canvas().getByRole("button", { name: "Add image", exact: true })).toBeEnabled();
}
async function start() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/api.?key|secret|token|password|proxy/i.test(key)));
  app = await _electron.launch({ executablePath: launch.executablePath, cwd: launch.cwd,
    args: ["--no-sandbox", `--user-data-dir=${join(directory, "profile")}`, ...launch.args],
    env: { ...env, ELECTRON_RUN_AS_NODE: "", ELECTRON_RENDERER_URL: "", PI_DESKTOP_DATA_DIR: join(directory, "data"),
      DECKWISE_PLATFORM_BASE_URL: "http://127.0.0.1:9/fixture", PI_DESKTOP_START_MAXIMIZED: "0" }, timeout: 60_000 });
  for (const stream of [app.process().stdout, app.process().stderr]) stream.on("data", bytes => logs.push(String(bytes)));
  page = await app.firstWindow({ timeout: 60_000 }); page.on("pageerror", error => logs.push(`PAGEERROR ${error.stack}`));
  await page.waitForFunction(() => !!window.piDesktop);
  await app.evaluate(({ session }) => session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    callback({ cancel: /^https?:$/.test(url.protocol) && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) });
  }));
  const channels = await page.evaluate(() => window.piDesktop.channels);
  await app.evaluate(({ ipcMain, BrowserWindow }, channels) => {
    const state = { status: "authenticated", profile: { userId: 1, userName: "Canvas fixture", edition: "EDUCATION", role: "TEACHER", pcAllowed: true } };
    for (const name of ["authRestore", "authStartQr"]) { ipcMain.removeHandler(channels.invoke[name]); ipcMain.handle(channels.invoke[name], () => ({ ok: true, data: state })); }
    const window = BrowserWindow.getAllWindows()[0]; window.setBounds({ x: 0, y: 0, width: 1550, height: 1000 });
    const send = window.webContents.send.bind(window.webContents);
    window.webContents.send = (channel, ...args) => send(channel, ...(channel === channels.event.authChanged ? [state] : args));
    send(channels.event.authChanged, state);
  }, channels);
  await page.reload(); await page.waitForFunction(() => !!window.__PI_DESKTOP__);
  const { defaultCommandShell: _shell, ...settings } = await invoke("settingsGet");
  await invoke("settingsSet", { ...settings, language: "en", defaultPermissionMode: "auto" });
  await invoke("projectSet", workspace);
  if (!sessionId) {
    const { provider } = await invoke("providersCreate", { name: "Canvas fixture", vendorKey: "custom", type: "openai_compatible", protocol: "openai_compatible",
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, authKind: "none", apiStyle: "chat_completions", defaultModelId: "canvas-fixture" });
    providerId = provider.id;
    sessionId = (await invoke("sessionCreate", { title: "Media canvas", projectPath: workspace, providerId, modelId: "canvas-fixture", mode: "agent" })).session.id;
  }
  await page.evaluate(async id => { await window.__PI_DESKTOP__.refreshProviders(); await window.__PI_DESKTOP__.selectSession(id); }, sessionId);
}
async function stop() {
  if (!app) return;
  const child = app.process();
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once("exit", resolve)); await app.evaluate(({ app }) => app.exit(0)); await exited;
  }
  app = null;
}
const step = async (name, run) => { console.log("START", name); await run(); report.checks.push(name); console.log("PASS", name); };
try {
  await step("Actual courseware selector creates a scene task before any PPTX exists", async () => {
    await start();
    await page.evaluate(() => { window.__PI_CAPTURE__ = true; window.__PI_DESKTOP__.openNewWorkPanelTab(); });
    await page.locator('[data-work-panel-launcher-item="ppt-master"]').click();
    await page.getByRole("button", { name: "场景式课件生成", exact: true }).click();
    await expect.poll(async () => (await invoke("coursewareTaskGet", { sessionId })).task?.taskType).toBe("scene");
    await openCanvas(); assert.equal((await read()).document, null);
  });
  let saved;
  await step("Create, edit, drag and zoom a real canvas draft and save it through Main to Host", async () => {
    await canvas().getByRole("button", { name: "Add image", exact: true }).click();
    await properties().getByRole("textbox", { name: "Prompt", exact: true }).fill("A friendly rabbit");
    await expect.poll(async () => (await read()).document?.drafts[0]?.prompt).toBe("A friendly rabbit");
    draftId = (await read()).document.drafts[0].id;
    const card = canvas().locator(".courseware-media-canvas-draft");
    const before = (await read()).document.drafts[0], bounds = await card.boundingBox(); assert(bounds);
    await page.mouse.move(bounds.x + 110, bounds.y + 70); await page.mouse.down();
    await page.mouse.move(bounds.x + 210, bounds.y + 150, { steps: 5 }); await page.mouse.up();
    await expect.poll(async () => (await read()).document.drafts[0].x).toBe(before.x + 100);
    await canvas().getByRole("button", { name: "Zoom in", exact: true }).click();
    await expect.poll(async () => (await read()).document.viewport.zoom).toBe(1.2);
    const board = canvas().locator(".courseware-media-canvas-viewport"), area = await board.boundingBox(); assert(area);
    await page.mouse.move(area.x + area.width - 25, area.y + area.height - 25); await page.mouse.down();
    await page.mouse.move(area.x + area.width - 65, area.y + area.height - 45, { steps: 3 }); await page.mouse.up();
    await expect.poll(async () => (await read()).document.viewport.x).not.toBe(28.8);
    saved = await read(); assert.equal(saved.document.drafts[0].prompt, "A friendly rabbit");
    await page.screenshot({ path: join(out, "canvas-draft.png") });
  });
  await step("Main Chat reads and changes the same saved draft without generating media", async () => {
    await canvas().locator(".courseware-media-canvas-draft").click();
    await properties().getByRole("textbox", { name: "Requested change", exact: true }).fill("CANVAS_CHAT_EDIT Make the rabbit cheerful.");
    await properties().getByRole("button", { name: "Send to Chat", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Media canvas", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(canvas()).toBeVisible();
    await expect(page.getByText("CANVAS_CHAT_EDIT_DONE", { exact: true })).toBeVisible({ timeout: 90_000 });
    await expect(page.getByRole("tab", { name: "Media canvas", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(canvas()).toBeVisible();
    await canvas().locator(".courseware-media-canvas-draft").click();
    await expect(properties().getByRole("textbox", { name: "Prompt", exact: true })).toHaveValue("A cheerful rabbit in a sunny garden", { timeout: 20_000 });
    const next = await read();
    assert.equal(next.document.drafts[0].id, draftId);
    assert.equal(next.document.drafts[0].revision, saved.document.drafts[0].revision + 1);
    assert.deepEqual(next.document.viewport, saved.document.viewport);
    assert.equal(next.document.drafts[0].x, saved.document.drafts[0].x);
    saved = next;
  });
  await step("Full Desktop and Host restart restores prompt, layout and zoom without PPTX generation", async () => {
    await stop(); await start(); await openCanvas();
    assert.deepEqual(await read(), saved);
    await canvas().locator(".courseware-media-canvas-draft").click();
    await expect(properties().getByRole("textbox", { name: "Prompt", exact: true })).toHaveValue("A cheerful rabbit in a sunny garden");
    const task = (await invoke("coursewareTaskGet", { sessionId })).task; assert(!task.generatedPath && !task.importPath);
    assert(!(await readdir(workspace, { recursive: true })).some(path => path.endsWith(".pptx")));
  });
  await step("Stale CAS and foreign conversation requests are rejected without changing the saved canvas", async () => {
    await assert.rejects(invoke("coursewareMediaCanvasSet", { sessionId, expectedRevision: "stale", document: saved.document }), /CONFLICT|reload/i);
    const other = (await invoke("sessionCreate", { title: "Other canvas", projectPath: workspace, providerId, modelId: "canvas-fixture", mode: "agent" })).session.id;
    await invoke("coursewareTaskSet", { sessionId: other, taskType: "plain", educationContext: {} });
    await assert.rejects(invoke("coursewareMediaCanvasGet", { sessionId: other }), /changed/i);
    await page.evaluate(async id => window.__PI_DESKTOP__.selectSession(id), other);
    assert.equal((await invoke("coursewareMediaCanvasGet", { sessionId: other })).document, null);
    await assert.rejects(invoke("coursewareMediaCanvasSet", { sessionId: other, expectedRevision: null, document: saved.document }), /INVALID|conversation/i);
    await page.evaluate(async id => window.__PI_DESKTOP__.selectSession(id), sessionId);
    assert.deepEqual(await read(), saved);
    await openCanvas(); await page.screenshot({ path: join(out, "canvas-restarted.png") });
  });
  await step("Non-Agent mode can read but cannot overwrite the saved canvas", async () => {
    await invoke("sessionConfigure", sessionId, { mode: "plan" });
    assert.deepEqual(await read(), saved);
    await assert.rejects(invoke("coursewareMediaCanvasSet", { sessionId, expectedRevision: saved.revision, document: saved.document }), /PERMISSION_DENIED|Agent mode|mode changed/i);
    await invoke("sessionConfigure", sessionId, { mode: "agent" });
    assert.deepEqual(await read(), saved);
  });
  assert(!logs.some(line => /PAGEERROR|FIXTUREERROR/.test(line)));
  report.saved = saved; report.status = "PASS_MEDIA_CANVAS_MAIN_CHAT_RESTART";
} catch (error) {
  report.status = "FAIL"; report.error = String(error.stack); console.error(error); process.exitCode = 1;
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(out, "failure.png") }).catch(() => {});
    await writeFile(join(out, "failure-aria.txt"), await page.locator("body").ariaSnapshot()).catch(() => {});
  }
} finally {
  await stop(); await new Promise(resolve => server.close(resolve)); report.modelRequests = requests.length;
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(join(out, "main.log"), logs.join("\n"));
  await writeFile(join(out, "requests.json"), JSON.stringify(requests, null, 2) + "\n");
}
