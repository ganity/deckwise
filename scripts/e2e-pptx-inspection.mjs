#!/usr/bin/env node
/** W02.4 saved-PPTX inspection subcase, not full courseware/publish acceptance. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { coursewareLaunch } from "./e2e/boot.mjs";

for (const key of ["DECKWISE_E2E_OFFICE_ROOT", "DECKWISE_E2E_PPTX", "DECKWISE_EDITOR_URL", "DECKWISE_E2E_OUTPUT", ...(process.env.DECKWISE_E2E_PACKAGE_ROOT ? [] : ["PI_DESKTOP_HOST_BIN", "DECKWISE_PPTX_WORKER"])]) assert(process.env[key], `Missing ${key}`);
const editorUrl = new URL(process.env.DECKWISE_EDITOR_URL);
assert(["127.0.0.1", "localhost", "[::1]"].includes(editorUrl.hostname), "Use a local Office server");
const launch = coursewareLaunch();
const require = createRequire(join(resolve(process.env.DECKWISE_E2E_OFFICE_ROOT), "package.json"));
const { _electron, expect } = require("@playwright/test");
const out = resolve(process.env.DECKWISE_E2E_OUTPUT);
await mkdir(out); // Preserve previous evidence rather than overwriting it.
const temp = await mkdtemp(join(tmpdir(), "deckwise-inspection-"));
const workspace = join(temp, "workspace");
await mkdir(workspace);
const file = join(workspace, "lesson.pptx");
await copyFile(process.env.DECKWISE_E2E_PPTX, file);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourceHash = digest(await readFile(file));
const result = { case: "W02.4-INSPECTION", status: "RUNNING", sourceHash, checks: [], sandbox: "--no-sandbox (user-authorized local validation)" };
const logs = [];
let app;
async function step(name, action) {
  console.log("START", name);
  await action();
  result.checks.push(name);
  console.log("PASS", name);
}
try {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/api.?key|secret|token|password|proxy/i.test(key)));
  app = await _electron.launch({
    executablePath: launch.executablePath, args: ["--no-sandbox", "--user-data-dir=" + join(temp, "profile"), ...launch.args], cwd: launch.cwd,
    env: { ...env, ELECTRON_RUN_AS_NODE: "", ELECTRON_RENDERER_URL: "", PI_DESKTOP_DATA_DIR: join(temp, "data"),
      PI_DESKTOP_START_MAXIMIZED: "0", DECKWISE_PLATFORM_BASE_URL: "http://127.0.0.1:9/test-platform" }, timeout: 60_000,
  });
  for (const stream of [app.process().stdout, app.process().stderr]) stream.on("data", (bytes) => logs.push(String(bytes)));
  const page = await app.firstWindow({ timeout: 120_000 });
  result.runtime = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, executable: process.execPath, appPath: app.getAppPath(), resourcesPath: process.resourcesPath }));
  assert.equal(result.runtime.packaged, launch.packaged);
  if (launch.packaged) {
    assert.equal(result.runtime.executable, launch.executablePath);
    assert.equal(result.runtime.appPath, join(launch.cwd, "resources/app.asar"));
  }
  await app.evaluate(({ session }) => {
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url);
      callback({ cancel: /^https?:$/.test(url.protocol) && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) });
    });
  });
  page.on("pageerror", (error) => logs.push("PAGEERROR " + error.stack));
  await page.waitForFunction(() => !!window.piDesktop);
  await page.locator(".auth-refresh").waitFor({ state: "visible", timeout: 60_000 });
  const channels = await page.evaluate(() => window.piDesktop.channels);
  await app.evaluate(({ ipcMain, BrowserWindow }, channels) => {
    const state = { status: "authenticated", profile: { userId: 1, userName: "Local inspection verification", edition: "EDUCATION", role: "TEACHER", pcAllowed: true } };
    for (const name of ["authRestore", "authStartQr"]) {
      ipcMain.removeHandler(channels.invoke[name]);
      ipcMain.handle(channels.invoke[name], () => ({ ok: true, data: state }));
    }
    const window = BrowserWindow.getAllWindows()[0];
    window.setBounds({ x: 0, y: 0, width: 1500, height: 950 });
    const send = window.webContents.send.bind(window.webContents);
    window.webContents.send = (channel, ...args) => send(channel, ...(channel === channels.event.authChanged ? [state] : args));
    send(channels.event.authChanged, state);
  }, channels);
  // Discard pending real-login replies before restoring the local auth fixture.
  await page.reload();
  await page.waitForFunction(() => !!window.__PI_DESKTOP__);
  const invoke = (name, ...args) => page.evaluate(async ({ name, args }) => {
    const response = await window.piDesktop.invoke(window.piDesktop.channels.invoke[name], ...args);
    if (!response.ok) throw new Error(JSON.stringify(response));
    return response.data;
  }, { name, args });
  await invoke("projectSet", workspace);
  const { session } = await invoke("sessionCreate", { title: "Saved PPTX inspection", projectPath: workspace });
  await page.evaluate(async (id) => window.__PI_DESKTOP__.selectSession(id), session.id);
  await page.evaluate(() => {
    window.__editorStates = [];
    window.piDesktop.on(window.piDesktop.channels.event.pptEditorState, (state) => window.__editorStates.push(state));
  });
  await assert.rejects(invoke("pptEditorInspectStart"), /Open a writable PPTX/);
  await page.evaluate(async () => { window.__PI_CAPTURE__ = true; await window.__PI_DESKTOP__.openWorkPanelArtifact("file", "lesson.pptx"); });
  let host, sdk;
  await expect.poll(async () => {
    host = app.context().pages().find((target) => target.url().startsWith("deckwise-editor:"));
    if (!host) return false;
    for (const frame of host.frames()) {
      if (await frame.evaluate(() => Boolean(window.Asc?.editor?.isLoadFullApi && window.Asc.editor.isDocumentLoadComplete)).catch(() => false)) { sdk = frame; return true; }
    }
    return false;
  }, { timeout: 120_000 }).toBe(true);
  const panel = page.locator(".pptx-inspection");
  const startButton = panel.locator("button").first();
  const waitCheck = async (checkId) => {
    let state;
    await expect.poll(async () => {
      state = await invoke("pptEditorInspectStatus", { checkId });
      return state.status;
    }, { timeout: 120_000 }).not.toBe("RUNNING");
    return state;
  };
  const clean = async () => assert.deepEqual(await readdir(join(temp, "data/cache/courseware")), []);
  await step("visible editor inspection uses real preload, Main, Rust and native worker", async () => {
    await expect(startButton).toBeEnabled();
    await startButton.click();
    await expect(panel.locator("details")).toBeVisible({ timeout: 120_000 });
    await panel.locator("summary").click();
    await expect(panel.locator("code")).toContainText(sourceHash);
    result.initialReport = await panel.innerText();
    await expect(panel.getByRole("alert")).toHaveCount(0);
    await expect(panel).toContainText(/未检出内容错误|No content errors detected/);
    assert.equal(digest(await readFile(file)), sourceHash);
    await clean();
    await page.screenshot({ path: join(out, "desktop-inspection.png") });
    await host.screenshot({ path: join(out, "wiseoffice.png") });
  });
  await step("inspection requests cannot select paths, executable or output", async () => {
    await assert.rejects(invoke("pptEditorInspectStart", { path: "/etc/passwd", worker: "/bin/sh" }), /does not accept parameters/);
    await assert.rejects(invoke("pptEditorInspectStatus", { checkId: "unknown" }), /Unknown inspection/);
  });
  await step("real worker cancellation releases the slot and permits retry", async () => {
    const started = await invoke("pptEditorInspectStart");
    await invoke("pptEditorInspectCancel", { checkId: started.checkId });
    result.cancellation = await waitCheck(started.checkId);
    assert.equal(result.cancellation.status, "CANCELED");
    await clean();
    await startButton.click();
    await expect(panel.locator("details")).toBeVisible({ timeout: 120_000 });
    await clean();
  });
  await step("unsaved native edits are excluded; saving selects a new exact revision", async () => {
    await sdk.evaluate(() => {
      const api = window.Asc.editor;
      const doc = api.WordControl.m_oLogicDocument;
      const shape = doc.Slides[api.getCurrentPage()].cSld.spTree[0];
      shape.Set_CurrentElement(); shape.getDocContent().SelectAll(); doc.Document_UpdateSelectionState();
    });
    await sdk.locator("#area_id").focus();
    await host.keyboard.insertText("Unsaved inspection edit");
    await expect.poll(() => sdk.evaluate(() => {
      const api = window.Asc.editor;
      const shape = api.WordControl.m_oLogicDocument.Slides[api.getCurrentPage()].cSld.spTree[0];
      const text = (items) => items.map((node) => node.Content ? text(node.Content) :
        typeof node.GetCodePoint === "function" ? String.fromCodePoint(node.GetCodePoint()) : "").join("");
      return text(shape.getDocContent().Content);
    })).toContain("Unsaved inspection edit");
    assert.equal(digest(await readFile(file)), sourceHash);
    const beforeSave = await invoke("pptEditorInspectStart");
    const old = await waitCheck(beforeSave.checkId);
    assert.equal(old.status, "SUCCEEDED");
    assert.equal(old.sourceSha256, sourceHash);
    assert.equal(old.errorCount, 0);
    await page.locator(".ppt-editor-toolbar button").nth(1).click();
    await expect.poll(() => page.evaluate(() => window.__editorStates.at(-1)?.status), { timeout: 120_000 }).toBe("saved");
    const savedHash = digest(await readFile(file));
    assert.notEqual(savedHash, sourceHash);
    const saved = await invoke("pptEditorInspectStart");
    result.saved = await waitCheck(saved.checkId);
    assert.equal(result.saved.status, "SUCCEEDED");
    assert.equal(result.saved.sourceSha256, savedHash);
    assert.equal(result.saved.errorCount, 0);
    assert(result.saved.revision > old.revision);
    await copyFile(file, join(out, "saved.pptx"));
    await clean();
  });
  await step("closing the editor cancels an admitted inspection and cleans its outputs", async () => {
    const started = await invoke("pptEditorInspectStart");
    await invoke("pptEditorClose");
    const closed = await waitCheck(started.checkId);
    assert.equal(closed.status, "CANCELED");
    await clean();
    await assert.rejects(invoke("pptEditorInspectStart"), /Open a writable PPTX/);
  });
  result.status = "PASS";
} catch (error) {
  result.status = "FAIL"; result.error = error.stack;
  console.error(error); process.exitCode = 1;
  await writeFile(join(out, "electron.log"), logs.join(""));
  await writeFile(join(out, "result.json"), JSON.stringify(result, null, 2) + "\n");
  if (app) for (const [index, page] of app.context().pages().entries()) await page.screenshot({ path: join(out, `failure-${index}.png`), timeout: 5000 }).catch(() => {});
} finally {
  if (app) {
    const closed = new Promise((resolve) => app.process().once("exit", resolve));
    await app.evaluate(({ app }) => { app.exit(0); }).catch(() => {});
    if (app.process().exitCode === null && app.process().signalCode === null) {
      app.process().kill("SIGTERM");
      await closed;
    }
  }
  await writeFile(join(out, "result.json"), JSON.stringify(result, null, 2) + "\n");
  await writeFile(join(out, "electron.log"), logs.join(""));
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  console.log(result.status, out);
}
