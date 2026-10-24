/** Real Desktop/Office/Host teaching flow; local auth fixture, no model/provider calls. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { stageNarrationFixtures } from "./e2e/narration-candidates.mjs";
import { coursewareLaunch } from "./e2e/boot.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

for (const key of ["DECKWISE_E2E_OFFICE_ROOT", "DECKWISE_E2E_PPTX", "DECKWISE_EDITOR_URL", "DECKWISE_E2E_OUTPUT",
  ...(process.env.DECKWISE_E2E_PACKAGE_ROOT ? [] : ["PI_DESKTOP_HOST_BIN", "DECKWISE_PPTX_WORKER"])]) assert(process.env[key], `Missing ${key}`);
assert(["127.0.0.1", "localhost"].includes(new URL(process.env.DECKWISE_EDITOR_URL).hostname));
const launch = coursewareLaunch();
const require = createRequire(join(resolve(process.env.DECKWISE_E2E_OFFICE_ROOT), "package.json"));
const { _electron, expect } = require("@playwright/test");
const runFile = promisify(execFile);
const out = resolve(process.env.DECKWISE_E2E_OUTPUT);
await mkdir(dirname(out), { recursive: true });
await mkdir(out);
const temp = await mkdtemp(join(tmpdir(), "deckwise-teaching-"));
const workspace = join(temp, "workspace");
await mkdir(workspace);
const file = join(workspace, "lesson.pptx");
await copyFile(process.env.DECKWISE_E2E_PPTX, file);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const originalHash = hash(await readFile(file));
const report = { case: "A1B-TEACHING", status: "RUNNING", packaged: launch.packaged, checks: [], originalHash, sandbox: "--no-sandbox", paidCalls: false };
const logs = [];
let app;
let page;
let sessionId;
let invoke;
let sdk;
let identityBaseline;
let importedPath;
async function persistedIdentities() {
  const { stdout } = await runFile("python3", ["-c", "import sqlite3,json,sys; db=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); print(json.dumps([json.loads(row[0]) for row in db.execute(\"SELECT value_json FROM kv WHERE ns='coursewareIdentities.v1'\")]))", join(temp, "data/pi.sqlite")]);
  return JSON.parse(stdout);
}
const button = (name) => page.locator(".courseware-teaching").getByRole("button", { name });
const load = () => button(/Load current page|读取当前页讲解/);
const save = () => button(/Save narration|保存讲解/);
const lock = () => page.locator(".courseware-teaching input[type=checkbox]");
async function step(name, action) {
  console.log("START", name);
  await action(); report.checks.push(name); console.log("PASS", name);
}
async function start() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/api.?key|secret|token|password|proxy/i.test(key)));
  app = await _electron.launch({ executablePath: launch.executablePath, args: ["--no-sandbox", "--user-data-dir=" + join(temp, "profile"), ...launch.args], cwd: launch.cwd,
    env: { ...env, ELECTRON_RUN_AS_NODE: "", ELECTRON_RENDERER_URL: "", PI_DESKTOP_DATA_DIR: join(temp, "data"), PI_DESKTOP_START_MAXIMIZED: "0", DECKWISE_PLATFORM_BASE_URL: "http://127.0.0.1:9/test-platform" }, timeout: 60_000 });
  for (const stream of [app.process().stdout, app.process().stderr]) stream.on("data", (bytes) => logs.push(String(bytes)));
  page = await app.firstWindow({ timeout: 120_000 });
  const runtime = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath, executablePath: process.execPath }));
  assert.equal(runtime.packaged, launch.packaged);
  if (launch.packaged) {
    assert.equal(runtime.appPath, join(launch.cwd, "resources/app.asar"));
    assert.equal(runtime.resourcesPath, join(launch.cwd, "resources"));
    assert.equal(runtime.executablePath, launch.executablePath);
  }
  report.runtime = runtime;
  page.on("pageerror", (error) => logs.push("PAGEERROR " + error.stack));
  await app.evaluate(({ session }) => session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    callback({ cancel: /^https?:$/.test(url.protocol) && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) });
  }));
  await page.waitForFunction(() => !!window.piDesktop);
  await page.locator(".auth-refresh").waitFor({ state: "visible", timeout: 60_000 });
  const channels = await page.evaluate(() => window.piDesktop.channels);
  await app.evaluate(({ ipcMain, BrowserWindow }, channels) => {
    const state = { status: "authenticated", profile: { userId: 1, userName: "Local teaching verification", edition: "EDUCATION", role: "TEACHER", pcAllowed: true } };
    for (const name of ["authRestore", "authStartQr"]) { ipcMain.removeHandler(channels.invoke[name]); ipcMain.handle(channels.invoke[name], () => ({ ok: true, data: state })); }
    const window = BrowserWindow.getAllWindows()[0];
    window.setBounds({ x: 0, y: 0, width: 1500, height: 950 });
    const send = window.webContents.send.bind(window.webContents);
    window.webContents.send = (channel, ...args) => send(channel, ...(channel === channels.event.authChanged ? [state] : args));
    send(channels.event.authChanged, state);
  }, channels);
  await page.reload();
  await page.waitForFunction(() => !!window.__PI_DESKTOP__);
  invoke = (name, ...args) => page.evaluate(async ({ name, args }) => {
    const response = await window.piDesktop.invoke(window.piDesktop.channels.invoke[name], ...args);
    if (!response.ok) throw new Error(JSON.stringify(response));
    return response.data;
  }, { name, args });
  await invoke("projectSet", workspace);
  if (!sessionId) sessionId = (await invoke("sessionCreate", { title: "Teaching persistence verification", projectPath: workspace })).session.id;
  if (process.env.DECKWISE_E2E_NOTES_SMOKE === "import-picker" && !importedPath) {
    await page.reload();
    await page.waitForFunction(() => !!window.__PI_DESKTOP__);
  }
  await page.evaluate(async (id) => window.__PI_DESKTOP__.selectSession(id), sessionId);
  if (process.env.DECKWISE_E2E_NOTES_SMOKE === "import-picker" && !importedPath) {
    await page.evaluate(() => { window.__PI_CAPTURE__ = true; window.__PI_DESKTOP__.openNewWorkPanelTab(); });
    await page.locator('[data-work-panel-launcher-item="ppt-master"]').click();
    await page.getByRole("button", { name: "已有 PPT 导入" }).click();
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, file);
    await page.getByRole("button", { name: "选择 PPTX 并导入" }).click();
    await expect.poll(async () => (await invoke("coursewareTaskGet", { sessionId })).task?.importPath, { timeout: 30_000 }).toMatch(/\.deckwise-ppt\/imports\//);
    importedPath = (await invoke("coursewareTaskGet", { sessionId })).task.importPath;
    assert(importedPath?.includes(".deckwise-ppt/imports/"));
    assert.deepEqual(await readFile(importedPath), await readFile(file));
  } else await page.evaluate(async (path) => { window.__PI_CAPTURE__ = true; await window.__PI_DESKTOP__.openWorkPanelArtifact("file", path); }, importedPath || "lesson.pptx");
  sdk = undefined;
  await expect.poll(async () => {
    const host = app.context().pages().find((target) => target.url().startsWith("deckwise-editor:"));
    if (!host) return false;
    for (const frame of host.frames()) {
      if (await frame.evaluate(() => Boolean(window.Asc?.editor?.isLoadFullApi && window.Asc.editor.isDocumentLoadComplete)).catch(() => false)) { sdk = frame; return true; }
    }
    return false;
  }, { timeout: 120_000 }).toBe(true);
  await expect(load()).toBeEnabled();
  await expect.poll(async () => page.locator(".ppt-editor-surface").evaluate((surface) => {
    const r = surface.getBoundingClientRect();
    return r.width > 250 && r.height > 200;
  })).toBe(true);
  await page.getByRole("button", { name: /全屏编辑|Edit full screen/, exact: false }).click();
  await expect.poll(async () => page.locator(".ppt-editor-surface").evaluate((surface) => surface.getBoundingClientRect().width > 600)).toBe(true);
}
async function goToPage(index) {
  await sdk.evaluate((index) => window.Asc.editor.goToPage(index), index);
  await expect.poll(async () => (await invoke("pptEditorGetContext")).page, { timeout: 15_000 }).toBe(index + 1);
}
async function captureComposite(name) {
  const xwd = join(out, `${name}.xwd`);
  await runFile("xwd", ["-root", "-silent", "-out", xwd]);
  await runFile("ffmpeg", ["-nostdin", "-v", "error", "-i", xwd, "-frames:v", "1", join(out, `${name}.png`)]);
}
async function stop() {
  const current = app;
  app = undefined;
  if (current) {
    const exited = new Promise((resolve) => current.process().once("exit", resolve));
    await current.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await exited;
  }
}
async function loadPage() {
  await load().click();
  await expect(page.locator(".courseware-teaching input[type=checkbox]")).toBeVisible({ timeout: 120_000 });
  await expect(load()).toBeEnabled({ timeout: 120_000 });
  await expect(page.locator(".courseware-teaching [role=alert]")).toHaveCount(0);
}
async function saveText(text) {
  const field = page.locator(".courseware-teaching textarea").first();
  if (!await field.count()) await button(/Add speech|添加讲解段/).click();
  await field.fill(text);
  await expect(load()).toBeDisabled();
  await save().click();
  await expect(save()).toBeDisabled();
  await expect(load()).toBeEnabled();
  await expect(page.locator(".courseware-teaching [role=alert]")).toHaveCount(0);
}
try {
  const notesSmoke = process.env.DECKWISE_E2E_NOTES_SMOKE;
  const followPage = process.argv.includes("--follow-page");
  const draftRestart = process.argv.includes("--draft-restart");
  const copyReorder = process.argv.includes("--copy-reorder");
  await step("Open real Desktop, native Office and saved-source teaching", async () => {
    await start(); await goToPage(0);
    if (followPage || draftRestart || (copyReorder && !notesSmoke)) await invoke("coursewareTaskSet", { sessionId, taskType: "plain", educationContext: {} });
    if (!notesSmoke || copyReorder) await loadPage();
  });
  if (copyReorder) {
    report.case = notesSmoke === "import-picker" ? "W06.1-IMPORT-NATIVE-COPY-REORDER" : "W06.1-NATIVE-COPY-REORDER";
    const sourceFile = importedPath || file;
    const narration = () => page.locator(".courseware-teaching label textarea").nth(1);
    const stored = () => page.locator(".courseware-teaching").getByText(/Draft stored locally for recovery|草稿已保留在本机/);
    const localText = "Unfinished narration belongs only to the original second logical page.";
    let baseline;
    let adopted;
    let savedHash;
    await step("Lock an original page and retain a different page's unfinished narration", async () => {
      if (notesSmoke === "import-picker") {
        for (const index of [0, 1, 2]) {
          await goToPage(index); await loadPage();
          await button("读取原 PPT 备注（预览后保存）").click();
          await expect(narration()).toBeVisible();
          await save().click(); await expect(save()).toBeDisabled(); await expect(load()).toBeEnabled();
        }
      }
      await goToPage(2); await loadPage();
      await lock().click(); await expect(lock()).toBeChecked();
      await expect(narration()).toBeDisabled(); await expect(load()).toBeEnabled();
      await goToPage(1); await loadPage();
      baseline = structuredClone((await invoke("pptEditorTeachingOpen", { sessionId })).project);
      assert.equal(baseline.pages.length, 3);
      assert(baseline.pages.every(entry => entry.actions.some(action => action.type === "speech")));
      if (importedPath) assert(baseline.pages.every(entry => entry.actions[0].source === "notes"));
      assert.equal(baseline.pages[2].locked, true);
      await narration().fill(localText); await expect(stored()).toBeVisible();
      const current = await invoke("pptEditorTeachingOpen", { sessionId });
      const { draft } = await invoke("pptEditorTeachingDraftGet", { viewId: current.viewId });
      assert.equal(draft.pageId, baseline.pages[1].pageId); assert.equal(draft.actions[0].text, localText);
      assert.deepEqual(current.project, baseline);
      await writeFile(join(out, "teaching-before.json"), JSON.stringify(baseline, null, 2));
      await writeFile(join(out, "draft-before.json"), JSON.stringify(draft, null, 2));
    });
    await step("Native copy and reorder save without silently reassigning teaching or losing the draft", async () => {
      const native = await sdk.evaluate(() => {
        const api = window.Asc.editor;
        const doc = api.WordControl.m_oLogicDocument;
        const before = doc.Slides.map(slide => slide.Get_Id());
        api.DublicateSlide();
        const copied = doc.Slides.map(slide => slide.Get_Id());
        doc.shiftSlides(0, [3], false);
        return { before, copied, after: doc.Slides.map(slide => slide.Get_Id()) };
      });
      assert.equal(native.copied.length, 4);
      assert.deepEqual(native.copied.filter(id => native.before.includes(id)), native.before);
      assert(!native.before.includes(native.copied[2]));
      assert.deepEqual(native.after, [native.before[2], native.before[0], native.before[1], native.copied[2]]);
      report.nativeSlides = native;
      await expect(load()).toBeDisabled();
      await assert.rejects(invoke("pptEditorTeachingOpen", { sessionId }), /Save or reopen/);
      await invoke("pptEditorSave");
      await expect.poll(async () => hash(await readFile(sourceFile)), { timeout: 240_000 }).not.toBe(originalHash);
      savedHash = hash(await readFile(sourceFile)); assert.notEqual(savedHash, originalHash);
      await assert.rejects(invoke("pptEditorTeachingOpen", { sessionId }), /COURSEWARE_CONFLICT.*reconcile/);
      await expect(narration()).toHaveValue(localText);
      await expect(button(/Review saved PPTX changes|审核已保存的 PPTX 变更/)).toBeEnabled();
      await copyFile(sourceFile, join(out, "native-copy-reordered.pptx"));
    });
    await step("Explicit associations retain original logical pages and give the copy empty teaching", async () => {
      await goToPage(3);
      await button(/Review saved PPTX changes|审核已保存的 PPTX 变更/).click();
      const review = page.locator(".courseware-source-review");
      const choices = review.locator("select");
      const confirm = review.locator("input[type=checkbox]");
      const adopt = review.getByRole("button", { name: /Use these associations|采用这些关联/ });
      await expect(choices).toHaveCount(4, { timeout: 120_000 });
      for (let index = 0; index < 4; index++) await choices.nth(index).selectOption(["2", "0", "1", "new"][index]);
      await expect(adopt).toBeDisabled();
      await choices.nth(0).selectOption("new"); await expect(confirm).toBeDisabled();
      await choices.nth(0).selectOption("0"); await expect(confirm).toBeDisabled();
      await choices.nth(0).selectOption("2"); await confirm.check();
      await captureComposite("copy-associations-composite");
      await adopt.click(); await expect(review).toHaveCount(0, { timeout: 120_000 });
      await expect(load()).toBeEnabled({ timeout: 120_000 });
      const current = await invoke("pptEditorTeachingOpen", { sessionId });
      adopted = structuredClone(current.project);
      assert.equal(current.pageNumber, 4);
      assert.deepEqual(adopted.pages.slice(0, 3).map(entry => entry.pageId), [2, 0, 1].map(index => baseline.pages[index].pageId));
      for (const [index, original] of [2, 0, 1].entries()) {
        assert.deepEqual(adopted.pages[index].actions, baseline.pages[original].actions);
        assert.equal(adopted.pages[index].locked, baseline.pages[original].locked);
      }
      assert(!baseline.pages.some(entry => entry.pageId === adopted.pages[3].pageId));
      assert.deepEqual(adopted.pages[3].actions, []); assert.equal(adopted.pages[3].locked, false);
      assert.equal((await invoke("pptEditorTeachingDraftGet", { viewId: current.viewId })).draft, null);
      await expect(narration()).toHaveCount(0);
      await writeFile(join(out, "teaching-adopted.json"), JSON.stringify(adopted, null, 2));
    });
    await step("The original page retains a copyable stale draft; explicit discard enables a new edit", async () => {
      await goToPage(2); await load().click(); await expect(load()).toBeEnabled({ timeout: 120_000 });
      const previous = page.getByRole("textbox", { name: /Previous recovery draft|旧版本恢复草稿/ });
      await expect(previous).toHaveValue(localText);
      await expect(narration()).toHaveValue(baseline.pages[1].actions[0].text);
      await expect(narration()).toBeDisabled(); await expect(save()).toBeDisabled();
      await captureComposite("original-stale-draft-composite");
      await button(/Discard draft|放弃草稿/).click(); await expect(previous).toHaveCount(0);
      await narration().fill("Teacher revision after explicitly reassociating the original page.");
      await expect(stored()).toBeVisible(); await save().click(); await expect(load()).toBeEnabled();
      await expect(save()).toBeDisabled();
      const current = await invoke("pptEditorTeachingOpen", { sessionId });
      assert.deepEqual(current.project.pages.slice(0, 2), adopted.pages.slice(0, 2));
      assert.deepEqual(current.project.pages[3], adopted.pages[3]);
      assert.equal(current.project.pages[2].pageId, baseline.pages[1].pageId);
      assert.equal(current.project.pages[2].actions[0].text, "Teacher revision after explicitly reassociating the original page.");
      adopted = structuredClone(current.project);
    });
    await step("Full Desktop and Host restart retain copied-page isolation, reordered narration and lock", async () => {
      await stop(); await start();
      for (const index of [0, 1, 2, 3]) {
        await goToPage(index); await loadPage();
        const current = await invoke("pptEditorTeachingOpen", { sessionId });
        assert.deepEqual(current.project, adopted);
        assert.equal(current.pageId, adopted.pages[index].pageId);
        assert.equal((await invoke("pptEditorTeachingDraftGet", { viewId: current.viewId })).draft, null);
        if (index === 3) await expect(narration()).toHaveCount(0);
        else await expect(narration()).toHaveValue(adopted.pages[index].actions[0].text);
      }
      assert.equal(hash(await readFile(sourceFile)), savedHash);
      if (importedPath) assert.equal(hash(await readFile(file)), originalHash);
      report.savedSourceSha256 = savedHash;
      await writeFile(join(out, "teaching-after-restart.json"), JSON.stringify(adopted, null, 2));
      await writeFile(join(out, "identities-after-restart.json"), JSON.stringify(await persistedIdentities(), null, 2));
    });
  } else if (draftRestart) {
    report.case = "W06.1-NATIVE-DRAFT-RESTART";
    const baseline = structuredClone((await invoke("pptEditorTeachingOpen", { sessionId })).project);
    await loadPage();
    const narration = () => page.locator(".courseware-teaching label textarea").nth(1);
    const instruction = () => page.locator(".courseware-teaching label textarea").first();
    const localText = "Unfinished teacher narration retained across a full restart.";
    const localInstruction = "Keep the short bilingual explanation.";
    const stored = () => page.locator(".courseware-teaching").getByText(/Draft stored locally for recovery|草稿已保留在本机/);
    await step("Local narration and page instruction are retained by actual Host without applying teaching", async () => {
      await instruction().fill(localInstruction); await narration().fill(localText); await expect(stored()).toBeVisible();
      const current = await invoke("pptEditorTeachingOpen", { sessionId });
      assert.deepEqual(current.project, baseline);
      const { draft } = await invoke("pptEditorTeachingDraftGet", { viewId: current.viewId });
      assert.equal(draft.actions[0].text, localText); assert.equal(draft.instruction, localInstruction);
      report.draftRevision = draft.revision;
      await writeFile(join(out, "teaching-before.json"), JSON.stringify(baseline, null, 2));
      await writeFile(join(out, "draft-before-restart.json"), JSON.stringify(draft, null, 2));
    });
    await step("Full Electron and Host restart restores narration and instruction on their original page", async () => {
      await stop(); await start(); await goToPage(0); await load().click();
      await expect(narration()).toHaveValue(localText); await expect(instruction()).toHaveValue(localInstruction);
      await expect(page.locator(".courseware-teaching").getByText(/Recovered local draft|已恢复本页草稿/)).toBeVisible();
      await goToPage(1); await page.waitForTimeout(1200); await expect(narration()).toHaveValue(localText);
      await goToPage(0); await captureComposite("recovered-draft-composite");
    });
    await step("Explicit save applies only its page and a second restart cannot restore the obsolete draft", async () => {
      await instruction().fill(""); await save().click(); await expect(load()).toBeEnabled({ timeout: 120_000 });
      await expect(save()).toBeDisabled();
      const saved = await invoke("pptEditorTeachingOpen", { sessionId });
      assert.equal(saved.project.pages[0].actions[0].text, localText);
      assert.deepEqual(saved.project.pages.slice(1), baseline.pages.slice(1));
      assert.equal((await invoke("pptEditorTeachingDraftGet", { viewId: saved.viewId })).draft, null);
      await stop(); await start(); await goToPage(0); await loadPage(); await expect(narration()).toHaveValue(localText);
      await expect(page.locator(".courseware-teaching").getByText(/Recovered local draft|已恢复本页草稿/)).toHaveCount(0);
    });
    await step("A locked newer teaching revision preserves the prior recovery text until explicit discard", async () => {
      await narration().fill("Stale teacher draft; do not apply to the locked version."); await expect(stored()).toBeVisible();
      const current = await invoke("pptEditorTeachingOpen", { sessionId });
      const locked = await invoke("pptEditorTeachingLock", { viewId: current.viewId, expectedTeachingRevision: current.project.teachingRevision, locked: true });
      await stop(); await start(); await goToPage(0); await load().click(); await expect(load()).toBeEnabled({ timeout: 120_000 });
      await expect(narration()).toHaveValue(localText); await expect(narration()).toBeDisabled();
      const copy = page.getByRole("textbox", { name: /Previous recovery draft|旧版本恢复草稿/ });
      await expect(copy).toHaveValue("Stale teacher draft; do not apply to the locked version.");
      await expect(save()).toBeDisabled();
      await button(/Discard draft|放弃草稿/).click(); await expect(copy).toHaveCount(0);
      const final = await invoke("pptEditorTeachingOpen", { sessionId });
      assert.deepEqual(final.project, locked.project);
      assert.equal((await invoke("pptEditorTeachingDraftGet", { viewId: final.viewId })).draft, null);
      assert.equal(hash(await readFile(file)), originalHash);
      await writeFile(join(out, "teaching-after.json"), JSON.stringify(final.project, null, 2));
      await captureComposite("stale-draft-discarded-composite");
    });
  } else if (followPage) {
    report.case = "W06.1-NATIVE-PAGE-FOLLOW";
    const baseline = structuredClone((await invoke("pptEditorTeachingOpen", { sessionId })).project);
    assert(baseline.pages.length >= 3 && baseline.pages.every(entry => entry.actions.some(action => action.type === "speech")));
    await loadPage();
    const narration = () => page.locator(".courseware-teaching label textarea").nth(1);
    const expectedText = index => baseline.pages[index].actions.find(action => action.type === "speech").text;
    const expectPage = async index => {
      await expect(page.locator(".courseware-teaching").getByText(new RegExp(`^(Narration for page ${index + 1}|第 ${index + 1} 页讲解)$`))).toBeVisible({ timeout: 30_000 });
      await expect(narration()).toHaveValue(expectedText(index));
      await expect(load()).toBeEnabled();
    };
    await step("Native Office navigation automatically loads the matching logical page narration", async () => {
      await goToPage(1); await expectPage(1);
      await goToPage(2); await expectPage(2);
      await goToPage(0); await expectPage(0);
    });
    await step("Unsaved narration survives real navigation; explicit discard resumes following", async () => {
      await narration().fill("Unsubmitted teacher draft; keep it on page one.");
      await goToPage(1); await page.waitForTimeout(1300);
      await expect(narration()).toHaveValue("Unsubmitted teacher draft; keep it on page one.");
      await expect(load()).toBeDisabled();
      await button(/Discard draft|放弃草稿/).click();
      await expectPage(1);
    });
    await step("Returning to the draft page permits a safe save; peer teaching and PPTX bytes are preserved", async () => {
      const text = `${expectedText(1)}\nTeacher revision after native navigation.`;
      await narration().fill(text);
      await goToPage(2); await page.waitForTimeout(1300);
      await expect(narration()).toHaveValue(text);
      await goToPage(1); await save().click();
      await expect(save()).toBeDisabled(); await expect(load()).toBeEnabled();
      await expect(page.locator(".courseware-teaching [role=alert]")).toHaveCount(0);
      await goToPage(0); await expectPage(0);
      await goToPage(1);
      await expect(page.locator(".courseware-teaching").getByText(/^(Narration for page 2|第 2 页讲解)$/)).toBeVisible({ timeout: 30_000 });
      await expect(narration()).toHaveValue(text);
      const current = (await invoke("pptEditorTeachingOpen", { sessionId })).project;
      assert.deepEqual(current.pages[0], baseline.pages[0]);
      assert.deepEqual(current.pages.slice(2), baseline.pages.slice(2));
      assert.equal(current.pages[1].actions[0].text, text);
      assert.equal(hash(await readFile(file)), originalHash);
      report.projectId = current.projectId;
      report.pageIds = current.pages.map(entry => entry.pageId);
      await writeFile(join(out, "teaching-before.json"), JSON.stringify(baseline, null, 2));
      await writeFile(join(out, "teaching-after.json"), JSON.stringify(current, null, 2));
      await captureComposite("native-follow-composite");
    });
  } else if (notesSmoke) {
    assert(["plain", "plain-empty", "import", "import-external", "import-picker"].includes(notesSmoke));
    await step("Prepare current-page narration through the visible teaching panel", async () => {
      if (notesSmoke !== "import-picker") await invoke("coursewareTaskSet", { sessionId, taskType: notesSmoke.startsWith("plain") ? "plain" : "import", educationContext: {} });
      await loadPage();
      const instruction = page.locator(".courseware-teaching label textarea").first();
      const field = page.locator(".courseware-teaching label textarea").nth(1);
      if (notesSmoke === "import" || notesSmoke === "import-picker") {
        await expect(instruction).toHaveCount(1);
        await expect(page.locator(".courseware-teaching label textarea")).toHaveCount(1);
        await button("读取原 PPT 备注（预览后保存）").click();
        await expect(field).toBeVisible();
      } else if (notesSmoke === "import-external") {
        await expect(instruction).toHaveCount(1);
        await expect(page.locator(".courseware-teaching label textarea")).toHaveCount(1);
        await button("粘贴外部讲解稿").click();
        await expect(field).toBeVisible();
        await expect(save()).toBeDisabled();
      } else if (notesSmoke === "plain-empty") {
        await expect(instruction).toHaveCount(1);
        await expect(page.locator(".courseware-teaching label textarea")).toHaveCount(1);
        await button(/Add speech|添加讲解段/).click();
        await expect(field).toBeVisible();
      } else await expect(field).toBeVisible();
      const text = notesSmoke.endsWith("empty") || notesSmoke.endsWith("external") ? "这是一段外部准备的逐页讲解稿。" : await field.inputValue();
      if (["plain", "import", "import-picker"].includes(notesSmoke)) assert(text.length > 20 && !text.includes("<p"));
      report.notesText = text.slice(0, 80);
      await field.fill(`${text}\n教师补充讲解。`);
      await save().click();
      await expect(field).toHaveValue(`${text}\n教师补充讲解。`);
      const project = (await invoke("pptEditorTeachingOpen", { sessionId })).project;
      const expectedSource = notesSmoke === "import" || notesSmoke === "import-picker" ? "notes" :
        notesSmoke === "import-external" ? "external" : undefined;
      if (expectedSource) {
        assert.equal(project.pages[0].actions[0].source, expectedSource);
        report.narrationSourceAfterSave = project.pages[0].actions[0].source;
      }
    });
    await step("Restart restores the edited narration", async () => {
      await stop(); await start(); await goToPage(0); await loadPage();
      await expect(page.locator(".courseware-teaching label textarea").nth(1)).toHaveValue(/教师补充讲解。/);
      const project = (await invoke("pptEditorTeachingOpen", { sessionId })).project;
      const expectedSource = notesSmoke === "import" || notesSmoke === "import-picker" ? "notes" :
        notesSmoke === "import-external" ? "external" : undefined;
      if (expectedSource) {
        assert.equal(project.pages[0].actions[0].source, expectedSource);
        report.narrationSourceAfterRestart = project.pages[0].actions[0].source;
      }
    });
  } else {
  if (process.env.DECKWISE_E2E_EXPECT_PLAYBACK_UI === "1") {
    await step("Confirm all pages, capture through UI and explicitly review actual conversion warnings", async () => {
      const baseline = await invoke("pptEditorTeachingOpen", { sessionId });
      assert(baseline.project.pages.every((entry) => entry.actions.length === 0));
      report.previewPages = baseline.project.pages.length;
      await goToPage(0); await loadPage();
      const preview = page.locator(".courseware-playback");
      const build = () => preview.getByRole("button", { name: /Build preview|构建预览/, exact: true });
      await expect(build()).toBeDisabled();
      for (let index = 0; index < report.previewPages; index++) {
        await goToPage(index); await loadPage();
        await button(/Confirm this page|确认本页/).click();
        await expect(button(/Page confirmed|本页已确认/)).toBeDisabled();
        await expect(load()).toBeEnabled();
      }
      await expect(build()).toBeEnabled();
      await build().click();
      const proceed = preview.getByRole("button", { name: /Continue building|确认并继续构建/ });
      await expect(proceed).toBeVisible({ timeout: 120_000 });
      await expect(proceed).toBeDisabled();
      await expect(load()).toBeDisabled();
      await expect(preview).toContainText("PPTX_NOTES_MASTER_UNVERIFIED");
      await preview.getByRole("button", { name: /Close preview|关闭预览/ }).click();
      await expect(load()).toBeEnabled();
      await build().click();
      await expect(proceed).toBeVisible({ timeout: 120_000 });
      await expect(proceed).toBeDisabled();
      for (const checkbox of await preview.getByRole("checkbox").all()) await expect(checkbox).not.toBeChecked();
      for (const checkbox of await preview.getByRole("checkbox").all()) await checkbox.check();
      await expect(proceed).toBeEnabled();
      await captureComposite("preview-warning-composite");
      await proceed.click();
      await expect(preview.getByRole("button", { name: /Play preview|播放预览/ })).toBeEnabled({ timeout: 120_000 });
      await expect(preview).toContainText(/Visual fidelity is unverified|画面保真度尚未验证/);
      assert.equal(hash(await readFile(file)), originalHash);
    });
    await step("Play and navigate the actual converted deck; closing preview unlocks teaching", async () => {
      const preview = page.locator(".courseware-playback");
      await preview.getByRole("button", { name: /Play preview|播放预览/ }).click();
      let player;
      await expect.poll(() => {
        player = app.context().pages().find((target) => target.url().endsWith("courseware-player.html"));
        return !!player;
      }).toBe(true);
      await expect(player.locator("header")).toContainText(`1 / ${report.previewPages}`, { timeout: 120_000 });
      const fixed = await player.evaluate(async () => {
        const selected = await window.deckwiseFixedPlayer.readPackage();
        return { buildId: selected.buildId, bytes: Array.from(selected.bytes) };
      });
      assert.equal(hash(Buffer.from(fixed.bytes)), fixed.buildId);
      await preview.locator("summary").click();
      await expect(preview.locator("details")).toContainText(fixed.buildId);
      await player.getByRole("button", { name: /^(下一页|Next page)$/ }).click();
      await expect(player.locator("header")).toContainText(`2 / ${report.previewPages}`);
      await player.screenshot({ path: join(out, "preview-player.png") });
      await player.close();
      await expect(preview.getByRole("button", { name: /Play preview|播放预览/ })).toBeEnabled();
      await preview.getByRole("button", { name: /Play preview|播放预览/ }).click();
      await expect.poll(() => {
        player = app.context().pages().find((target) => target.url().endsWith("courseware-player.html"));
        return !!player;
      }).toBe(true);
      await expect(player.locator("header")).toContainText(`1 / ${report.previewPages}`, { timeout: 120_000 });
      const replay = await player.evaluate(async () => {
        const selected = await window.deckwiseFixedPlayer.readPackage();
        return { buildId: selected.buildId, bytes: Array.from(selected.bytes) };
      });
      assert.deepEqual(replay, fixed);
      report.replayedBuildId = fixed.buildId;
      const closed = player.waitForEvent("close");
      await preview.getByRole("button", { name: /Close preview|关闭预览/ }).click();
      await closed;
      await expect(load()).toBeEnabled();
      await expect(preview.getByRole("button", { name: /Build preview|构建预览/, exact: true })).toBeEnabled();
      await goToPage(0); await loadPage();
      report.visibleStaticPreview = true;
    });
  }
  await step("Save page one and page two independently through UI", async () => {
    await saveText("Good! Look at the square.");
    if (process.env.DECKWISE_E2E_EXPECT_PLAYBACK_UI === "1") {
      const preview = page.locator(".courseware-playback");
      await expect(preview).toContainText(/matching adopted audio|匹配的已采用配音/);
      await expect(preview.getByRole("button", { name: /Build preview|构建预览/, exact: true })).toBeDisabled();
      await captureComposite("preview-missing-audio-composite");
      report.speechPreviewExplicitlyBlocked = true;
    }
    await goToPage(1); await loadPage();
    await saveText("Count the four sides. Well done!");
    await lock().check(); await expect(lock()).toBeChecked();
    await expect(page.locator(".courseware-teaching textarea").first()).toBeDisabled();
    const teaching = await invoke("pptEditorTeachingOpen", { sessionId });
    report.projectId = teaching.project.projectId;
    report.pageIds = teaching.project.pages.map((entry) => entry.pageId);
    if (process.env.DECKWISE_E2E_EXPECT_IDENTITY === "1") {
      identityBaseline = await persistedIdentities();
      assert.equal(identityBaseline.length, 1);
      assert.equal(identityBaseline[0].sourceSha256, originalHash);
      assert.deepEqual(identityBaseline[0].pages.map((entry) => entry.logicalId), report.pageIds);
      assert(identityBaseline[0].mappingRevision);
      await writeFile(join(out, "persisted-identity.json"), JSON.stringify(identityBaseline[0], null, 2));
    }
    await assert.rejects(invoke("pptEditorTeachingWrite", { viewId: teaching.viewId, expectedTeachingRevision: teaching.project.teachingRevision, actions: [] }), /LOCKED|locked/);
    await page.screenshot({ path: join(out, "two-pages-saved.png") });
  });
  if (process.env.DECKWISE_E2E_EXPECT_CONFIRM === "1") {
    await step("Explicit UI confirmation preserves narration and locks on both pages", async () => {
      for (const index of [0, 1]) {
        await goToPage(index); await loadPage();
        const before = await page.locator(".courseware-teaching textarea").first().inputValue();
        await button(/Confirm this page|确认本页教学内容/).click();
        await expect(button(/Page confirmed|本页已确认/)).toBeDisabled();
        await expect(page.locator(".courseware-teaching textarea").first()).toHaveValue(before);
        const view = await invoke("pptEditorTeachingOpen", { sessionId });
        assert.equal(view.project.pages[index].reviewState, "ready");
        assert.equal(view.project.pages[index].locked, index === 1);
      }
      report.explicitConfirmation = true;
      report.confirmedPageIds = report.pageIds.slice(0, 2);
      await page.screenshot({ path: join(out, "teaching-confirmed.png") });
    });
  }
  await step("Full Desktop and Host restart restores both pages and lock", async () => {
    await stop();
    await start(); await goToPage(0); await loadPage();
    await expect(page.locator(".courseware-teaching textarea").first()).toHaveValue("Good! Look at the square.");
    await expect(lock()).not.toBeChecked();
    await goToPage(1); await loadPage();
    await expect(page.locator(".courseware-teaching textarea").first()).toHaveValue("Count the four sides. Well done!");
    await expect(lock()).toBeChecked();
    const restored = await invoke("pptEditorTeachingOpen", { sessionId });
    assert.equal(restored.project.projectId, report.projectId);
    assert.deepEqual(restored.project.pages.map((entry) => entry.pageId), report.pageIds);
    if (report.explicitConfirmation) {
      for (const entry of restored.project.pages) {
        assert.equal(entry.reviewState, report.confirmedPageIds.includes(entry.pageId) ? "ready" : "review");
      }
      report.confirmationSurvivedDesktopRestart = true;
    }
    if (identityBaseline) {
      assert.deepEqual(await persistedIdentities(), identityBaseline);
      report.persistedIdentitySurvivedDesktopRestart = true;
    }
    await writeFile(join(out, "restored-project.json"), JSON.stringify(restored.project, null, 2));
    await page.screenshot({ path: join(out, "restart-restored.png") });
    const office = app.context().pages().find((target) => target.url().startsWith("deckwise-editor:"));
    await office.screenshot({ path: join(out, "wiseoffice-restored.png") });
    await captureComposite("desktop-composite");
  });
  await step("Current-page changes and forged targets cannot write the old view", async () => {
    const view = await invoke("pptEditorTeachingOpen", { sessionId });
    await assert.rejects(invoke("pptEditorTeachingWrite", { viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision, actions: [], pageId: report.pageIds[0] }), /changed/);
    await assert.rejects(invoke("pptEditorTeachingOpen", { sessionId, path: "/etc/passwd" }), /Invalid teaching/);
    await goToPage(0);
    await assert.rejects(invoke("pptEditorTeachingWrite", { viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision, actions: [] }), /current page changed/);
    assert.equal(hash(await readFile(file)), originalHash);
    report.narrationWritesPreservedSource = true;
  });
  await step("Dirty and then changed saved PPTX block teaching without remapping by page number", async () => {
    const view = await invoke("pptEditorTeachingOpen", { sessionId });
    const context = await invoke("pptEditorGetContext");
    const { projectId, documentId, sessionId: nativeSessionId, editGeneration } = context;
    await invoke("pptEditorExecute", { projectId, documentId, sessionId: nativeSessionId, editGeneration,
      requestId: randomUUID(), tool: "add_slide_text", input: { text: "A teaching identity guard validation" } });
    await expect(load()).toBeDisabled();
    await assert.rejects(invoke("pptEditorTeachingOpen", { sessionId }), /Save or reopen/);
    await assert.rejects(invoke("pptEditorTeachingWrite", { viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision, actions: [] }), /Save or reopen|Open current-page/);
    await invoke("pptEditorSave");
    await expect(load()).toBeEnabled({ timeout: 240_000 });
    report.nativeEditSha256 = hash(await readFile(file));
    assert.notEqual(report.nativeEditSha256, originalHash);
    await assert.rejects(invoke("pptEditorTeachingOpen", { sessionId }), /COURSEWARE_CONFLICT.*reconcile/);
    report.changedSourceRequiresReconciliation = true;
  });
  if (process.env.DECKWISE_E2E_EXPECT_REVIEW === "1") {
    await step("Explicit UI review associates saved pages and preserves locked narration", async () => {
      const currentHash = hash(await readFile(file));
      await button(/Review saved PPTX changes|审核已保存的 PPTX 变更/).click();
      const review = page.locator(".courseware-source-review");
      await expect(review).toBeVisible({ timeout: 120_000 });
      const choices = review.locator("select");
      await expect(choices).toHaveCount(report.pageIds.length);
      const adopt = review.getByRole("button", { name: /Use these associations|采用这些关联/ });
      await expect(adopt).toBeDisabled();
      for (let index = 0; index < report.pageIds.length; index++) {
        await expect(choices.nth(index)).toHaveValue("");
        await choices.nth(index).selectOption(String(index));
      }
      await goToPage(1);
      await choices.nth(1).selectOption("0");
      await expect(review.locator("input[type=checkbox]")).toBeDisabled();
      await choices.nth(1).selectOption("new");
      await expect(review.locator("input[type=checkbox]")).toBeDisabled();
      await choices.nth(1).selectOption("1");
      await expect(adopt).toBeDisabled();
      await review.locator("input[type=checkbox]").check();
      await page.screenshot({ path: join(out, "review-associations.png") });
      await captureComposite("review-composite");
      await adopt.click();
      await expect(review).toHaveCount(0, { timeout: 120_000 });
      await expect(page.locator(".courseware-teaching textarea").first()).toHaveValue("Count the four sides. Well done!");
      assert.equal(hash(await readFile(file)), currentHash);
      await goToPage(1); await loadPage();
      await expect(page.locator(".courseware-teaching textarea").first()).toHaveValue("Count the four sides. Well done!");
      await expect(lock()).toBeChecked();
      const adopted = await invoke("pptEditorTeachingOpen", { sessionId });
      assert.equal(adopted.project.source.sha256, currentHash);
      assert.deepEqual(adopted.project.pages.map((entry) => entry.pageId), report.pageIds);
      report.adoptedSourceSha256 = currentHash;
      const identities = await persistedIdentities();
      assert.equal(identities.length, 2);
      assert.deepEqual(identities.find((entry) => entry.sourceSha256 === originalHash), identityBaseline[0]);
      await writeFile(join(out, "adopted-project.json"), JSON.stringify(adopted.project, null, 2));
      await writeFile(join(out, "adopted-identities.json"), JSON.stringify(identities, null, 2));
    });
    await step("Complete Desktop restart restores adopted source, narration and lock", async () => {
      await stop(); await start(); await goToPage(0); await loadPage();
      await expect(page.locator(".courseware-teaching textarea").first()).toHaveValue("Good! Look at the square.");
      await goToPage(1); await loadPage();
      await expect(lock()).toBeChecked();
      await expect(page.locator(".courseware-teaching textarea").first()).toHaveValue("Count the four sides. Well done!");
      const restored = await invoke("pptEditorTeachingOpen", { sessionId });
      assert.equal(restored.project.source.sha256, report.adoptedSourceSha256);
      assert.deepEqual(restored.project.pages.map((entry) => entry.pageId), report.pageIds);
      await page.screenshot({ path: join(out, "adopted-restart.png") });
      await captureComposite("adopted-restart-composite");
      report.reviewAdoptionSurvivedRestart = true;
    });
  }
  if (process.env.DECKWISE_E2E_EXPECT_NARRATION_REVIEW === "1") {
    let baseline;
    const fixture = JSON.parse(await readFile(process.env.DECKWISE_NARRATION_FIXTURE, "utf8"));
    await step("Stage frozen B narration through actual Host; restart Desktop with pending proposals", async () => {
      await goToPage(0); await loadPage();
      baseline = (await invoke("pptEditorTeachingOpen", { sessionId })).project;
      await stop();
      const revisionRoot = join(workspace, ".deckwise-ppt/revisions");
      const archives = [];
      for (const entry of await readdir(revisionRoot, { recursive: true })) {
        if (entry.endsWith("document.pptx")) {
          const archive = join(revisionRoot, entry);
          if (hash(await readFile(archive)) === baseline.source.sha256) archives.push(archive);
        }
      }
      assert(archives.length > 0);
      const candidates = await stageNarrationFixtures({ data: join(temp, "data"), sessionId, archive: archives.at(-1), project: baseline, fixture, log: logs });
      await writeFile(join(out, "staged-candidates.json"), JSON.stringify(candidates, null, 2));
      report.candidateProducer = "Frozen B2 output actions rebound to actual Host IDs; no generator/model call";
      await start(); await goToPage(0);
    });
    const candidatePanel = () => page.locator(".courseware-narration-review");
    const reviewCandidate = async (id) => {
      await candidatePanel().locator("input:not([type=checkbox])").fill(id);
      await candidatePanel().getByRole("button", { name: /Review candidate|审阅候选/ }).click();
      await expect(candidatePanel().getByText(/Proposed narration|候选讲解/, { exact: true })).toBeVisible({ timeout: 120_000 });
    };
    await step("UI compares pending narration and pauses; page change prevents adoption; explicit confirmation adopts only target", async () => {
      await reviewCandidate("a6-adopt");
      const adopt = () => candidatePanel().getByRole("button", { name: /Adopt narration|采用讲解/ });
      await expect(adopt()).toBeDisabled();
      await expect(candidatePanel()).toContainText(fixture.write.actions[0].text);
      await expect(candidatePanel()).toContainText("4000");
      const pinned = await invoke("pptEditorNarrationReview", { sessionId, candidateId: "a6-adopt" });
      await assert.rejects(invoke("pptEditorNarrationDecide", { reviewId: pinned.reviewId, decision: "adopt", actions: [] }), /review changed/);
      await goToPage(1);
      await assert.rejects(invoke("pptEditorNarrationDecide", { reviewId: pinned.reviewId, decision: "adopt" }), /current page changed/);
      await goToPage(0);
      const liveBytes = await readFile(file);
      try {
        await writeFile(file, Buffer.concat([liveBytes, Buffer.from("external-write-check")]));
        await assert.rejects(invoke("pptEditorNarrationReview", { sessionId, candidateId: "a6-adopt" }), /changed outside/);
      } finally { await writeFile(file, liveBytes); }
      await candidatePanel().getByRole("button", { name: /Close candidate review|关闭候选审阅/ }).click();
      await reviewCandidate("a6-adopt");
      await candidatePanel().locator("input[type=checkbox]").check();
      await expect(adopt()).toBeEnabled();
      await captureComposite("narration-candidate-composite");
      await adopt().click();
      await expect(candidatePanel().getByText(/Proposed narration|候选讲解/, { exact: true })).toHaveCount(0, { timeout: 120_000 });
      await expect(page.locator(".courseware-teaching textarea").first()).toHaveValue(fixture.write.actions[0].text);
      const result = (await invoke("pptEditorTeachingOpen", { sessionId })).project;
      assert.deepEqual(result.pages[0].actions, fixture.write.actions);
      assert.deepEqual(result.pages.slice(1), baseline.pages.slice(1));
      assert.deepEqual(result.source, baseline.source);
      assert.equal(hash(await readFile(file)), baseline.source.sha256);
      await writeFile(join(out, "narration-adopted-project.json"), JSON.stringify(result, null, 2));
    });
    await step("UI disables stale candidate adoption and allows explicit rejection", async () => {
      await reviewCandidate("a6-stale");
      await expect(candidatePanel().getByRole("button", { name: /Adopt narration|采用讲解/ })).toBeDisabled();
      await expect(candidatePanel().locator("input[type=checkbox]")).toBeDisabled();
      await expect(candidatePanel().getByRole("alert")).toBeVisible();
      await candidatePanel().getByRole("button", { name: /Reject candidate|拒绝候选/ }).click();
      await expect(candidatePanel().getByText(/Proposed narration|候选讲解/, { exact: true })).toHaveCount(0, { timeout: 120_000 });
    });
    await step("Full Desktop restart restores adopted narration, pause, lock and terminal candidate status", async () => {
      await stop(); await start(); await goToPage(0); await loadPage();
      await expect(page.locator(".courseware-teaching textarea").first()).toHaveValue(fixture.write.actions[0].text);
      const project = (await invoke("pptEditorTeachingOpen", { sessionId })).project;
      assert.deepEqual(project.pages[0].actions, fixture.write.actions);
      assert.deepEqual(project.pages.slice(1), baseline.pages.slice(1));
      await reviewCandidate("a6-adopt");
      await expect(candidatePanel().getByText(/Already adopted|已采用/, { exact: true })).toBeVisible();
      await expect(candidatePanel().getByRole("button", { name: /Adopt narration|采用讲解/ })).toHaveCount(0);
      await candidatePanel().getByRole("button", { name: /Close candidate review|关闭候选审阅/ }).click();
      await reviewCandidate("a6-stale");
      await expect(candidatePanel().getByText(/Rejected|已拒绝/, { exact: true })).toBeVisible();
      await captureComposite("narration-restart-composite");
      assert.equal(hash(await readFile(file)), baseline.source.sha256);
    });
  }
  }
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL"; report.error = error.stack || String(error);
  if (page) {
    await page.screenshot({ path: join(out, "failure.png") }).catch(() => {});
    report.panel = await page.locator(".courseware-teaching").innerText().catch(() => "unavailable");
  }
  process.exitCode = 1;
} finally {
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(join(out, "desktop.log"), logs.join(""));
  await stop();
  await rm(temp, { recursive: true, force: true });
}
console.log(report.status, out);
