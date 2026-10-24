/** Actual Electron/Main/Host/Chat/file tools; model and account are local fixtures. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { coursewareLaunch } from "./e2e/boot.mjs";

assert(process.env.DECKWISE_E2E_OUTPUT && process.env.PI_DESKTOP_HOST_BIN);
const out = resolve(process.env.DECKWISE_E2E_OUTPUT);
await mkdir(dirname(out), { recursive: true });
await mkdir(out, { recursive: false });
const directory = await mkdtemp(join(tmpdir(), "deckwise-scene-plan-"));
const workspace = join(directory, "workspace"); await mkdir(workspace);
const launch = coursewareLaunch();
const { _electron, expect } = createRequire(new URL("../packages/courseware-runtime/package.json", import.meta.url))("@playwright/test");
const report = { status: "RUNNING", checks: [], directory, paidCalls: false, modelFixture: true, identityFixture: true, sandbox: "--no-sandbox" };
const logs = [], requests = [];
let app, page, sessionId, providerId, sequence = 0;
const raw = { title: "Garden shapes", pages: [
  { title: "Hello, circle", visibleText: ["Circle"], visualIntent: "An independently editable round flower and title", narration: "Look! A circle. Good!" },
  { title: "Find a square", visibleText: ["Square"], visualIntent: "An independently editable square garden bed and title", narration: "Can you find a square? Good job!" },
  { title: "Try together", visibleText: ["Let's try"], visualIntent: "Separate circle and square objects for a matching activity", narration: "Point to a circle. Now a square. Well done!" },
] };
const plain = value => typeof value === "string" ? value : Array.isArray(value) ? value.map(part => part.text ?? "").join("\n") : JSON.stringify(value);
const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ data: [{ id: "scene-plan-fixture" }] })); }
    let body = ""; for await (const bytes of req) body += bytes;
    const payload = JSON.parse(body); requests.push(payload); assert(requests.length <= 24);
    const last = payload.messages.findLastIndex(row => row.role === "user");
    const user = plain(payload.messages[last]?.content);
    if (!user.includes("SCENE_PLAN_")) {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ id: "title", choices: [{ message: { role: "assistant", content: "Garden shapes" }, finish_reason: "stop" }] }));
    }
    const match = user.match(/Host-selected scene planning file is ("[^"]+")/);
    assert(match, "Main must load the scene planning policy into the actual Chat");
    const path = JSON.parse(match[1]); assert.equal(path, `.deckwise-ppt/scenes/${sessionId}/plan.json`);
    assert(user.includes("scene-generation-draft") && user.includes("kindergarten") && user.includes("english"));
    assert(user.includes("0–2 short English expressions") && user.includes("# Skill: scene-courseware"));
    const rows = payload.messages.slice(last + 1), calls = rows.flatMap(row => row.tool_calls ?? []);
    const result = call => rows.find(row => row.role === "tool" && row.tool_call_id === call?.id);
    const write = calls.find(call => call.function?.name === "Write");
    const revise = user.includes("SCENE_PLAN_REVISE");
    let name, args;
    if (!["Read", "Write"].every(name => payload.tools?.some(tool => tool.function.name === name))) {
      name = "ToolSearch"; args = { query: "Read Write" };
    } else if (revise && !calls.some(call => call.function.name === "Read")) {
      name = "Read"; args = { path };
    } else if (!write) {
      const plan = structuredClone(raw);
      if (revise) { assert(user.includes("第 2 页《Find a square》")); plan.pages[1].narration = "Find a square. Good!"; }
      name = "Write"; args = { path, content: JSON.stringify(plan, null, 2) + "\n" };
    } else if (!calls.slice(calls.indexOf(write) + 1).some(call => call.function.name === "Read")) {
      assert(result(write), "File write must complete before readback"); name = "Read"; args = { path };
    } else {
      assert(plain(result(calls.at(-1))?.content).includes("Garden shapes"), "Readback must contain the saved file");
    }
    const delta = name ? { role: "assistant", tool_calls: [{ index: 0, id: `scene_${++sequence}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }
      : { role: "assistant", content: revise ? "SCENE_PLAN_REVISED" : "SCENE_PLAN_CREATED" };
    const base = { id: `scene_completion_${++sequence}`, object: "chat.completion.chunk", created: 1, model: payload.model };
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
const panel = () => page.locator(".ppt-master-scene-plan");
async function start() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/api.?key|secret|token|password|proxy/i.test(key)));
  app = await _electron.launch({ executablePath: launch.executablePath, cwd: launch.cwd,
    args: ["--no-sandbox", `--user-data-dir=${join(directory, "profile")}`, ...launch.args],
    env: { ...env, ELECTRON_RUN_AS_NODE: "", ELECTRON_RENDERER_URL: "", PI_DESKTOP_DATA_DIR: join(directory, "data"),
      DECKWISE_PLATFORM_BASE_URL: "http://127.0.0.1:9/fixture", PI_DESKTOP_START_MAXIMIZED: "0" }, timeout: 60_000 });
  for (const stream of [app.process().stdout, app.process().stderr]) stream.on("data", bytes => logs.push(String(bytes)));
  page = await app.firstWindow({ timeout: 60_000 });
  page.on("pageerror", error => logs.push(`PAGEERROR ${error.stack}`));
  await page.waitForFunction(() => !!window.piDesktop);
  await app.evaluate(({ session }) => session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    callback({ cancel: /^https?:$/.test(url.protocol) && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) });
  }));
  const channels = await page.evaluate(() => window.piDesktop.channels);
  await app.evaluate(({ ipcMain, BrowserWindow }, channels) => {
    const state = { status: "authenticated", profile: { userId: 1, userName: "Scene test account", edition: "EDUCATION", role: "TEACHER", pcAllowed: true } };
    for (const name of ["authRestore", "authStartQr"]) { ipcMain.removeHandler(channels.invoke[name]); ipcMain.handle(channels.invoke[name], () => ({ ok: true, data: state })); }
    const window = BrowserWindow.getAllWindows()[0]; window.setBounds({ x: 0, y: 0, width: 1500, height: 1000 });
    const send = window.webContents.send.bind(window.webContents);
    window.webContents.send = (channel, ...args) => send(channel, ...(channel === channels.event.authChanged ? [state] : args));
    send(channels.event.authChanged, state);
  }, channels);
  await page.reload(); await page.waitForFunction(() => !!window.__PI_DESKTOP__);
  await invoke("projectSet", workspace);
  if (!sessionId) {
    const { provider } = await invoke("providersCreate", { name: "Scene planning fixture", vendorKey: "custom", type: "openai_compatible", protocol: "openai_compatible",
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, authKind: "none", apiStyle: "chat_completions", defaultModelId: "scene-plan-fixture" });
    providerId = provider.id;
    sessionId = (await invoke("sessionCreate", { title: "Scene lesson planning", projectPath: workspace, providerId, modelId: "scene-plan-fixture", mode: "agent" })).session.id;
  }
  await page.evaluate(async id => { await window.__PI_DESKTOP__.refreshProviders(); await window.__PI_DESKTOP__.selectSession(id);
    window.__PI_CAPTURE__ = true; window.__PI_DESKTOP__.openNewWorkPanelTab(); }, sessionId);
  await page.locator('[data-work-panel-launcher-item="ppt-master"]').click();
}
async function stop() {
  if (!app) return;
  const child = app.process();
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once("exit", resolve));
    await app.evaluate(({ app }) => app.exit(0)); await exited;
  }
  app = null;
}
const step = async (name, run) => { console.log("START", name); await run(); report.checks.push(name); console.log("PASS", name); };
try {
  await step("The actual task selector saves a scene task and its teaching settings", async () => {
    await start(); await page.getByRole("button", { name: "场景式课件生成", exact: true }).click();
    await expect(panel()).toBeVisible();
    await page.getByRole("combobox", { name: /^学段/ }).selectOption("kindergarten");
    await page.getByRole("combobox", { name: /^学科/ }).selectOption("english");
    await expect(panel().getByRole("button", { name: "在主 Chat 制定规划", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "保存教学设置", exact: true }).click();
    await expect.poll(async () => (await invoke("coursewareTaskGet", { sessionId })).task?.educationContext?.subject).toBe("english");
    assert.equal((await invoke("coursewareTaskGet", { sessionId })).task.taskType, "scene");
  });
  let first;
  await step("Main Chat discovers real file tools and saves a validated three-page planning draft", async () => {
    await panel().getByRole("textbox", { name: "课程要求", exact: true }).fill("SCENE_PLAN_CREATE 为幼儿园英语制定三页花园形状课件规划。");
    await panel().getByRole("button", { name: "在主 Chat 制定规划", exact: true }).click();
    await expect(page.getByText("SCENE_PLAN_CREATED", { exact: true })).toBeVisible({ timeout: 90_000 });
    await expect(page.getByRole("article", { name: "用户消息" })).not.toContainText(/Host|JSON|plan\.json|sha256/);
    await expect(panel().getByRole("heading", { name: raw.title })).toBeVisible();
    first = (await invoke("coursewareScenePlanRead", { sessionId })).plan;
    assert.equal(first.pages.length, 3); assert.equal(first.relativePath, `.deckwise-ppt/scenes/${sessionId}/plan.json`);
    assert.deepEqual(JSON.parse(await readFile(join(workspace, first.relativePath), "utf8")), raw);
  });
  await step("Explicit visible approval pins the reviewed plan without creating media", async () => {
    assert.equal(first.approvedSha256, null);
    await assert.rejects(invoke("coursewareScenePlanApprove", { sessionId, sha256: "0".repeat(64) }), /review it again/);
    await assert.rejects(invoke("coursewareScenePlanApprove", { sessionId, sha256: first.sha256, path: "/other" }), /Invalid scene plan approval/);
    assert.equal((await invoke("coursewareScenePlanRead", { sessionId })).plan.approvedSha256, null);
    await panel().getByRole("button", { name: "确认当前规划", exact: true }).click();
    await expect(panel().getByText("当前规划已确认", { exact: true })).toBeVisible();
    await expect(panel().getByRole("button", { name: "确认当前规划", exact: true })).toBeDisabled();
    assert.equal((await invoke("coursewareScenePlanRead", { sessionId })).plan.approvedSha256, first.sha256);
  });
  await step("A page instruction uses the same Main Chat and changes only that page's narration", async () => {
    const entry = panel().locator("details").nth(1); await entry.locator("summary").click();
    await entry.getByRole("textbox").fill("SCENE_PLAN_REVISE 将这一页的讲解缩短为两句。");
    await entry.getByRole("button").click();
    await expect(page.getByText("SCENE_PLAN_REVISED", { exact: true })).toBeVisible({ timeout: 90_000 });
    await expect(page.getByRole("article", { name: "用户消息" }).last()).not.toContainText(/Host|JSON|plan\.json|sha256/);
    await expect(entry.locator("dd").last()).toHaveText("Find a square. Good!");
    const next = (await invoke("coursewareScenePlanRead", { sessionId })).plan;
    assert.notEqual(next.sha256, first.sha256); assert.deepEqual(next.pages[0], first.pages[0]); assert.deepEqual(next.pages[2], first.pages[2]);
    assert.notEqual(next.pages[1].sourceHash, first.pages[1].sourceHash); report.plan = next;
  });
  await step("A Chat revision invalidates approval until the revised plan is explicitly reviewed", async () => {
    await expect(panel().getByText("规划已修改，请重新审核并确认。", { exact: true })).toBeVisible();
    await assert.rejects(invoke("coursewareScenePlanApprove", { sessionId, sha256: first.sha256 }), /review it again/);
    assert.equal((await invoke("coursewareScenePlanRead", { sessionId })).plan.approvedSha256, first.sha256);
    await panel().getByRole("button", { name: "确认当前规划", exact: true }).click();
    await expect(panel().getByText("当前规划已确认", { exact: true })).toBeVisible();
    report.plan = (await invoke("coursewareScenePlanRead", { sessionId })).plan;
    assert.equal(report.plan.approvedSha256, report.plan.sha256);
  });
  await step("Other Chats cannot inherit this draft and invalid files show a visible error", async () => {
    const other = (await invoke("sessionCreate", { title: "Isolated scene", projectPath: workspace, providerId, modelId: "scene-plan-fixture", mode: "agent" })).session.id;
    await invoke("coursewareTaskSet", { sessionId: other, taskType: "scene", educationContext: {} });
    assert.deepEqual(await invoke("coursewareScenePlanRead", { sessionId: other }), { plan: null });
    const path = join(workspace, first.relativePath), bytes = await readFile(path);
    try {
      await writeFile(path, '{"title":"Invalid","pages":[]}');
      await panel().getByRole("button", { name: "刷新教学规划", exact: true }).click();
      await expect(panel().getByRole("alert")).toContainText("Invalid scene course plan");
      await expect(panel().getByRole("heading")).toHaveCount(0);
    } finally { await writeFile(path, bytes); }
    await panel().getByRole("button", { name: "刷新教学规划", exact: true }).click();
    await expect(panel().getByRole("heading", { name: raw.title })).toBeVisible();
  });
  await step("Full Desktop and Host restart restores the same draft without claiming a generated PPTX", async () => {
    await stop(); await start();
    await expect(panel().getByRole("heading", { name: raw.title })).toBeVisible();
    assert.deepEqual((await invoke("coursewareScenePlanRead", { sessionId })).plan, report.plan);
    await expect(panel().getByText("当前规划已确认", { exact: true })).toBeVisible();
    const { task } = await invoke("coursewareTaskGet", { sessionId }); assert.equal(task.taskType, "scene"); assert(!task.generatedPath);
    await panel().locator("summary").nth(1).click();
    await expect(panel().locator("details").nth(1).locator("dd").last()).toHaveText("Find a square. Good!");
    await page.screenshot({ path: join(out, "scene-plan-desktop.png") });
  });
  assert(!logs.some(line => /PAGEERROR|FIXTUREERROR/.test(line)));
  report.status = "PASS_SCENE_PLAN_APPROVAL_MAIN_CHAT";
} catch (error) {
  report.status = "FAIL"; report.error = String(error.stack); console.error(error); process.exitCode = 1;
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(out, "failure.png") }).catch(() => {});
    await writeFile(join(out, "failure-aria.txt"), await page.locator("body").ariaSnapshot()).catch(() => {});
  }
}
finally {
  await stop(); await new Promise(resolve => server.close(resolve));
  report.modelRequests = requests.length;
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(join(out, "main.log"), logs.join("\n"));
  await writeFile(join(out, "requests.json"), JSON.stringify(requests, null, 2) + "\n");
}
