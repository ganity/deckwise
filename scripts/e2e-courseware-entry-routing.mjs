#!/usr/bin/env node
/** Packaged three-entry/teaching/restore/native-edit routing; local identity and LLM fixtures only. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { coursewareLaunch } from "./e2e/boot.mjs";

for (const key of ["DECKWISE_E2E_PACKAGE_ROOT", "DECKWISE_E2E_PPTX", "DECKWISE_E2E_OUTPUT"])
  assert(process.env[key], `Missing ${key}`);
const launch = coursewareLaunch();
assert(launch.packaged, "Use the existing packaged candidate; do not rebuild or override bundled resources");
const output = resolve(process.env.DECKWISE_E2E_OUTPUT);
await mkdir(dirname(output), { recursive: true }); await mkdir(output);
const directory = await mkdtemp(join(tmpdir(), "deckwise-three-entry-"));
const workspace = join(directory, "workspace"); await mkdir(workspace);
const { _electron, expect } = createRequire(new URL("../packages/courseware-runtime/package.json", import.meta.url))("@playwright/test");
const digest = value => createHash("sha256").update(value).digest("hex");
const report = { status: "RUNNING", checks: [], cases: [], directory, packaged: true, paidCalls: false,
  identityFixture: true, modelFixture: true, nativeOffice: true, sandbox: "--no-sandbox" };
const logs = [], requests = [], startedPids = [];
const plain = value => typeof value === "string" ? value : Array.isArray(value) ? value.map(part => part.text ?? "").join("\n") : JSON.stringify(value);
let app, page, model, providerId, sequence = 0;
const invoke = (name, ...args) => page.evaluate(async ({ name, args }) => {
  const response = await window.piDesktop.invoke(window.piDesktop.channels.invoke[name], ...args);
  if (!response.ok) throw new Error(JSON.stringify(response.error)); return response.data;
}, { name, args });
const step = async (name, run) => { console.log("START", name); await run(); report.checks.push(name); console.log("PASS", name); };
const select = async sessionId => page.evaluate(async id => {
  await window.__PI_DESKTOP__.refreshProviders(); await window.__PI_DESKTOP__.selectSession(id);
}, sessionId);
const openPanel = async sessionId => {
  await select(sessionId);
  await expect(page.getByRole("tabpanel", { name: "课件工作区" })).toBeVisible();
};
const send = async text => { const input = page.locator(".composer-input[contenteditable=true]").last(); await input.fill(text); await input.press("Enter"); };
async function waitForOffice() {
  await expect.poll(async () => {
    const native = app.context().pages().find(target => target.url().startsWith("deckwise-editor:"));
    if (!native) return false;
    for (const frame of native.frames()) if (await frame.evaluate(() => Boolean(window.Asc?.editor?.isLoadFullApi && window.Asc.editor.isDocumentLoadComplete)).catch(() => false)) {
      const context = await invoke("pptEditorGetContext").catch(() => null);
      return !!context && context.page > 0 && Number.isInteger(context.editGeneration);
    }
    return false;
  }, { timeout: 90_000 }).toBe(true);
}
async function start() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/api.?key|secret|token|password|proxy/i.test(key)));
  app = await _electron.launch({ executablePath: launch.executablePath, cwd: launch.cwd,
    args: ["--no-sandbox", `--user-data-dir=${join(directory, "profile")}`],
    env: { ...env, ELECTRON_RUN_AS_NODE: "", ELECTRON_RENDERER_URL: "", PI_DESKTOP_DATA_DIR: join(directory, "data"),
      PI_DESKTOP_START_MAXIMIZED: "0", DECKWISE_PLATFORM_BASE_URL: "http://127.0.0.1:9/fixture",
      DECKWISE_EDITOR_URL: "" }, timeout: 60_000 });
  startedPids.push(app.process().pid);
  for (const stream of [app.process().stdout, app.process().stderr]) stream.on("data", value => logs.push(String(value)));
  page = await app.firstWindow({ timeout: 60_000 });
  page.on("pageerror", error => logs.push(`PAGEERROR ${error.stack}`));
  await app.evaluate(({ session }) => session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url); callback({ cancel: /^https?:$/.test(url.protocol) && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) });
  }));
  await page.waitForFunction(() => Boolean(window.piDesktop));
  const channels = await page.evaluate(() => window.piDesktop.channels);
  await app.evaluate(({ ipcMain, BrowserWindow }, channels) => {
    const state = { status: "authenticated", profile: { userId: 1, userName: "Routing fixture", edition: "EDUCATION", role: "TEACHER", pcAllowed: true } };
    for (const name of ["authRestore", "authStartQr"]) { ipcMain.removeHandler(channels.invoke[name]); ipcMain.handle(channels.invoke[name], () => ({ ok: true, data: state })); }
    const window = BrowserWindow.getAllWindows()[0]; window.setBounds({ x: 0, y: 0, width: 1500, height: 1050 });
    const send = window.webContents.send.bind(window.webContents);
    window.webContents.send = (channel, ...args) => send(channel, ...(channel === channels.event.authChanged ? [state] : args));
    send(channels.event.authChanged, state);
  }, channels);
  await page.reload(); await page.waitForFunction(() => Boolean(window.__PI_DESKTOP__));
  const runtime = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, executable: process.execPath,
    appPath: app.getAppPath(), resourcesPath: process.resourcesPath }));
  assert.equal(runtime.packaged, true); assert.equal(runtime.executable, launch.executablePath);
  assert.equal(runtime.appPath, join(launch.cwd, "resources/app.asar")); report.runtime = runtime;
  await invoke("projectSet", workspace);
}
async function stop() {
  if (!app) return;
  const current = app; app = undefined;
  if (current.process().exitCode === null && current.process().signalCode === null) {
    const exited = new Promise(resolve => current.process().once("exit", resolve));
    await current.evaluate(({ app }) => app.exit(0)); await exited;
  }
}
try {
  model = createServer(async (request, response) => {
    try {
      if (request.method === "GET") { response.setHeader("content-type", "application/json"); return response.end(JSON.stringify({ data: [{ id: "routing-fixture" }] })); }
      let raw = ""; for await (const bytes of request) raw += bytes;
      const payload = JSON.parse(raw), last = payload.messages.findLastIndex(row => row.role === "user");
      const user = plain(payload.messages[last]?.content), marker = user.match(/W05_(?:GENERATE|EDIT)_([a-z_]+)/u)?.[0];
      if (!marker || !user.startsWith("DeckWise turn policy:")) { response.setHeader("content-type", "application/json"); return response.end(JSON.stringify({ id: "title", choices: [{ message: { role: "assistant", content: "Courseware routing" }, finish_reason: "stop" }] })); }
      requests.push({ marker, payload }); assert(requests.length <= 60);
      const entry = report.cases.find(item => marker.endsWith(item.key)); assert(entry);
      const teaching = user.match(/Teaching settings: (\{[^\n]+\})\. Treat age/u);
      assert(teaching, "The saved teaching config must reach the actual model request");
      assert.deepEqual(JSON.parse(teaching[1]), entry.education);
      let name, args;
      if (marker.startsWith("W05_GENERATE_")) {
        assert(entry.type === "plain" ? /# Skill: [^\n]+ \(deckwise\/ppt-master\)/u.test(user) : entry.type === "scene"
          ? user.includes("# Skill: scene-courseware (deckwise/scene-courseware)") : user.includes('id "deckwise/ppt-import"'));
        assert(user.includes(entry.type === "plain" ? "generation-candidate" : entry.type === "scene"
          ? "scene-generation-draft" : "direct the user to the file picker in the main Chat"));
        if (entry.type === "scene") assert(!/# Skill: [^\n]+ \(deckwise\/ppt-master\)/u.test(user), "Scene must never silently use ordinary generation");
      } else {
        assert(user.includes('id "deckwise/ppt-edit"')); assert(user.includes("latest-clean-pptx-and-teaching"));
        assert(!/# Skill: [^\n]+ \(deckwise\/ppt-master\)/u.test(user) && !user.includes("# Skill: scene-courseware"));
        const rows = payload.messages.slice(last + 1), calls = rows.flatMap(row => row.tool_calls ?? []);
        const result = tool => rows.find(row => row.role === "tool" && row.tool_call_id === calls.find(call => call.function?.name === tool)?.id);
        if (!result("Skill")) { name = "Skill"; args = { id: "deckwise/ppt-edit" }; }
        else if (!payload.tools?.some(tool => tool.function.name === "ppt_get_presentation_text")) { name = "ToolSearch"; args = { query: "ppt_get_presentation_text" }; }
        else if (!result("ppt_get_presentation_text")) { name = "ppt_get_presentation_text"; args = {}; }
        else assert(plain(result("ppt_get_presentation_text").content).includes('"editGeneration"'), "Actual native read must complete");
      }
      const delta = name ? { role: "assistant", tool_calls: [{ index: 0, id: `routing_${++sequence}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }
        : { role: "assistant", content: `${marker}_DONE` };
      const base = { id: `route_completion_${++sequence}`, object: "chat.completion.chunk", created: 1, model: payload.model };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: name ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
      response.end("data: [DONE]\n\n");
    } catch (error) { logs.push(`FIXTUREERROR ${error.stack}`); response.writeHead(500); response.end(String(error)); }
  });
  await new Promise(resolve => model.listen(0, "127.0.0.1", resolve));
  await step("The exact package contains the complete four route skills and their authority resources", async () => {
    const resources = ["ppt-master/SKILL.md", "ppt-master/workflows/routing.md", "ppt-master/workflows/generate-pptx.md",
      "ppt-master/templates/design_spec_reference.md", "ppt-master/templates/spec_lock_reference.md", "ppt-master/scripts/attribution_guard.py",
      "scene-courseware/SKILL.md", "ppt-import/SKILL.md", "ppt-edit/SKILL.md"];
    report.skills = await Promise.all(resources.map(async relative => { const bytes = await readFile(join(launch.cwd, "resources/skills", relative)); assert(bytes.length); return { relative, bytes: bytes.length, sha256: digest(bytes) }; }));
    const bytes = await readFile(join(launch.cwd, "resources/app.asar")); report.asar = { bytes: bytes.length, sha256: digest(bytes) };
    await start();
    providerId = (await invoke("providersCreate", { name: "W05 routing fixture", vendorKey: "custom", type: "openai_compatible", protocol: "openai_compatible",
      baseUrl: `http://127.0.0.1:${model.address().port}/v1`, authKind: "none", apiStyle: "chat_completions", defaultModelId: "routing-fixture" })).provider.id;
    const seed = (await invoke("sessionCreate", { title: "Routing fixture", projectPath: workspace,
      providerId, modelId: "routing-fixture", mode: "agent" })).session.id;
    await select(seed);
  });
  for (const type of ["plain", "scene", "import"]) for (const stage of ["kindergarten", "primary"]) {
    const key = `${type}_${stage}`, education = { schoolStage: stage, grade: stage === "kindergarten" ? "大班" : "三年级",
      subject: stage === "kindergarten" ? "english" : "math", textbookVersion: "Routing fixture edition", chapter: "Shapes", lessonType: "New lesson", fullEnglishTeaching: type === "scene" && stage === "kindergarten" };
    const entry = { key, type, education }; report.cases.push(entry);
    await step(`Visible ${key} entry saves independent teaching settings and the selected route`, async () => {
      const before = new Set((await invoke("sessionList")).sessions.map(session => session.id));
      await page.getByRole("button", { name: "新建任务", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "新建课件任务" });
      await dialog.locator(`input[name="courseware-task-type"][value="${type}"]`).check();
      await dialog.getByRole("combobox", { name: "学段" }).selectOption(stage);
      await dialog.getByRole("textbox", { name: "年级" }).fill(education.grade);
      await dialog.getByRole("combobox", { name: "学科" }).selectOption(education.subject);
      await dialog.getByText("更多教学信息（选填）").click();
      for (const [label, field] of [["教材版本", "textbookVersion"], ["章节或主题", "chapter"], ["课型", "lessonType"]]) await dialog.getByRole("textbox", { name: label }).fill(education[field]);
      if (education.fullEnglishTeaching) await dialog.getByRole("checkbox", { name: "全英文教学" }).check();
      await dialog.getByRole("button", { name: "创建任务" }).click();
      await expect(dialog).toBeHidden();
      await expect.poll(async () => (await invoke("sessionList")).sessions.find(session => !before.has(session.id))?.id).not.toBeUndefined();
      entry.sessionId = (await invoke("sessionList")).sessions.find(session => !before.has(session.id)).id;
      await invoke("sessionConfigure", entry.sessionId, { mode: "agent", providerId, modelId: "routing-fixture" });
      await openPanel(entry.sessionId);
      await expect.poll(async () => (await invoke("coursewareTaskGet", { sessionId: entry.sessionId })).task?.educationContext).toEqual(education);
      const task = (await invoke("coursewareTaskGet", { sessionId: entry.sessionId })).task; assert.equal(task.taskType, type);
      entry.source = join(workspace, `${key}.pptx`); await copyFile(process.env.DECKWISE_E2E_PPTX, entry.source);
      if (type === "import") {
        const marker = `W05_GENERATE_${key}`; await send(`${marker} 请确认导入课件的教学要求。`);
        await expect(page.getByText(`${marker}_DONE`, { exact: true })).toBeVisible({ timeout: 45_000 });
        assert.equal((await invoke("coursewareTaskGet", { sessionId: entry.sessionId })).task.importPath, undefined);
        await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, entry.source);
        await page.getByRole("button", { name: "选择已有 PPT", exact: true }).click();
        await waitForOffice();
        entry.source = (await invoke("coursewareTaskGet", { sessionId: entry.sessionId })).task.importPath;
        assert(entry.source); assert.equal(digest(await readFile(entry.source)), digest(await readFile(process.env.DECKWISE_E2E_PPTX)));
        entry.sourceDocumentId = (await invoke("pptEditorGetContext")).documentId;
      } else {
        const marker = `W05_GENERATE_${key}`; await send(`${marker} 请确认当前生成课件的教学要求。`);
        await expect(page.getByText(`${marker}_DONE`, { exact: true })).toBeVisible({ timeout: 45_000 });
      }
      await assert.rejects(invoke("coursewareTaskSet", { sessionId: entry.sessionId, taskType: type === "plain" ? "scene" : "plain", educationContext: education }), /Started task|source is already attached/);
      await assert.rejects(invoke("coursewareTaskSet", { sessionId: entry.sessionId, taskType: type, educationContext: { ...education, grade: "Changed" } }), /Started task|source is already attached/);
      entry.saved = (await invoke("coursewareTaskGet", { sessionId: entry.sessionId })).task;
    });
  }
  await step("Saved team association survives task access and cannot silently change teams", async () => {
    const teamProjectId = "11111111-1111-4111-8111-111111111111";
    for (const entry of report.cases.filter(item => item.education.schoolStage === "primary")) {
      const bound = await invoke("coursewareTaskBindTeam", { sessionId: entry.sessionId, teamProjectId });
      assert.equal(bound.task.teamProjectId, teamProjectId);
      await assert.rejects(invoke("coursewareTaskBindTeam", { sessionId: entry.sessionId, teamProjectId: "22222222-2222-4222-8222-222222222222" }), /another team project/);
      entry.saved = (await invoke("coursewareTaskGet", { sessionId: entry.sessionId })).task;
    }
  });
  await step("A full packaged Electron and Host restart restores all six entry/configuration records", async () => {
    await page.screenshot({ path: join(output, "before-restart.png") }); await stop(); await start();
    assert.notEqual(startedPids[0], startedPids[1]);
    for (const entry of report.cases) assert.deepEqual((await invoke("coursewareTaskGet", { sessionId: entry.sessionId })).task, entry.saved);
  });
  for (const entry of report.cases) await step(`Restored ${entry.key} uses the latest native PPTX and actually loads the editing skill`, async () => {
    await openPanel(entry.sessionId);
    const saved = (await invoke("coursewareTaskGet", { sessionId: entry.sessionId })).task;
    assert.equal(saved.taskType, entry.type); assert.deepEqual(saved.educationContext, entry.education);
    if (entry.type !== "import") await page.evaluate(async file => {
      window.__PI_CAPTURE__ = true; await window.__PI_DESKTOP__.openWorkPanelArtifact("file", file);
    }, entry.source);
    await waitForOffice();
    if (entry.type === "import") await expect(page.getByRole("tabpanel", { name: "课件工作区" })
      .getByRole("button", { name: "保存", exact: true })).toBeVisible({ timeout: 90_000 });
    const marker = `W05_EDIT_${entry.key}`; await send(`${marker} 请读取当前课件页面。`);
    await expect(page.getByText(`${marker}_DONE`, { exact: true })).toBeVisible({ timeout: 60_000 });
    const task = (await invoke("coursewareTaskGet", { sessionId: entry.sessionId })).task;
    assert.equal(task.taskType, entry.type); assert.deepEqual(task.educationContext, entry.education);
    entry.nativeContext = await invoke("pptEditorGetContext");
    if (entry.type === "import") assert.equal(entry.nativeContext.documentId, entry.sourceDocumentId);
    else assert(entry.nativeContext.documentId.includes(entry.key));
  });
  await page.screenshot({ path: join(output, "restored-native-edit.png") });
  report.startedPids = startedPids; report.modelRequests = requests.length;
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL"; report.error = error.stack; process.exitCode = 1;
  if (page) {
    await page.screenshot({ path: join(output, "failure.png") }).catch(() => {});
    await writeFile(join(output, "failure-aria.txt"), await page.locator("body").ariaSnapshot()).catch(() => {});
  }
}
finally {
  await stop().catch(error => { report.cleanupError = error.stack; process.exitCode = 1; });
  if (model) await new Promise(resolve => model.close(resolve));
  await writeFile(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(output, "model-requests.json"), `${JSON.stringify(requests, null, 2)}\n`);
  await writeFile(join(output, "electron.log"), logs.join(""));
  console.log(JSON.stringify({ status: report.status, groups: report.checks.length, output, error: report.error }));
}
