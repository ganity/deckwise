#!/usr/bin/env node
/** Courseware case runner. Native W01 cases require local WiseOffice and PPTX;
 * W03.3 covers native undo/review; W15.1/W15.2 cover canvas with local fixtures.
 * No case calls a paid provider.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { coursewareLaunch } from "./e2e/boot.mjs";

assert(process.argv.length === 4 && process.argv[2] === "--case" && ["W01.2", "W01.3", "W03.3", "W15.1", "W15.2"].includes(process.argv[3]), "Supported invocation: --case W01.2, W01.3, W03.3, W15.1 or W15.2");
const testCase = process.argv[3];
if (["W03.3", "W15.1", "W15.2"].includes(testCase)) {
  const script = testCase === "W03.3" ? "./e2e-courseware-ordinary-effects.mjs"
    : testCase === "W15.1" ? "./e2e-courseware-media-canvas.mjs" : "./e2e-courseware-canvas-images.mjs";
  const env = testCase === "W03.3" ? { ...process.env, DECKWISE_E2E_REASSOCIATE: "1",
    DECKWISE_E2E_OFFICE_UNDO: process.env.DECKWISE_E2E_SOURCE_CHANGE === "1" ? "0" : "1" } : process.env;
  const child = spawn(process.execPath, [fileURLToPath(new URL(script, import.meta.url))], { stdio: "inherit", env });
  const forward = signal => child.kill(signal);
  const onInterrupt = () => forward("SIGINT"), onTerminate = () => forward("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  const { code, signal } = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  }).finally(() => {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  });
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
}
for (const key of ["DECKWISE_E2E_OFFICE_ROOT", "DECKWISE_E2E_PPTX", "DECKWISE_EDITOR_URL", ...(process.env.DECKWISE_E2E_PACKAGE_ROOT ? [] : ["PI_DESKTOP_HOST_BIN"])]) {
  assert(process.env[key], `Missing ${key}`);
}
const editorUrl = new URL(process.env.DECKWISE_EDITOR_URL);
assert(["127.0.0.1", "localhost", "[::1]"].includes(editorUrl.hostname), "Use a local editor server");
const launch = coursewareLaunch();
const require = createRequire(join(resolve(process.env.DECKWISE_E2E_OFFICE_ROOT), "package.json"));
const { _electron, expect } = require("@playwright/test");
const temp = await mkdtemp(join(tmpdir(), "deckwise-courseware-"));
const out = resolve(process.env.DECKWISE_E2E_OUTPUT || join(temp, "evidence"));
const workspace = join(temp, "workspace");
await mkdir(out, { recursive: true });
await mkdir(workspace);
const path = join(workspace, "lesson.pptx");
await copyFile(process.env.DECKWISE_E2E_PPTX, path);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const result = { case: testCase, status: "RUNNING", temp, sourceHash: hash(await readFile(path)), checks: [] };
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
    executablePath: launch.executablePath,
    args: ["--no-sandbox", "--user-data-dir=" + join(temp, "profile"), ...launch.args],
    cwd: launch.cwd,
    env: { ...env, ELECTRON_RUN_AS_NODE: "", ELECTRON_RENDERER_URL: "",
      PI_DESKTOP_DATA_DIR: join(temp, "data"), PI_DESKTOP_START_MAXIMIZED: "0",
      DECKWISE_PLATFORM_BASE_URL: new URL("/test-platform", editorUrl).href,
    }, timeout: 60_000,
  });
  for (const stream of [app.process().stdout, app.process().stderr]) stream.on("data", (data) => logs.push(String(data)));
  const page = await app.firstWindow({ timeout: 120_000 });
  result.runtime = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, executable: process.execPath, appPath: app.getAppPath(), resourcesPath: process.resourcesPath }));
  assert.equal(result.runtime.packaged, launch.packaged);
  if (launch.packaged) {
    assert.equal(result.runtime.executable, launch.executablePath);
    assert.equal(result.runtime.appPath, join(launch.cwd, "resources/app.asar"));
  }
  // Prevent renderer background discovery from using external services.
  await app.evaluate(({ session }) => {
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url);
      callback({ cancel: /^https?:$/.test(url.protocol) && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) });
    });
  });
  page.on("pageerror", (error) => logs.push("PAGEERROR " + error.stack));
  await page.waitForFunction(() => !!window.piDesktop);
  await page.locator(".auth-refresh").waitFor({ state: "visible", timeout: 60_000 });
  const channels = await page.evaluate(() => ({
    restore: window.piDesktop.channels.invoke.authRestore,
    start: window.piDesktop.channels.invoke.authStartQr,
    event: window.piDesktop.channels.event.authChanged,
  }));
  await app.evaluate(({ ipcMain, BrowserWindow }, channels) => {
    const state = { status: "authenticated", profile: {
      userId: 1, userName: "Editor verification", edition: "EDUCATION", role: "TEACHER", pcAllowed: true,
    } };
    for (const channel of [channels.restore, channels.start]) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, () => ({ ok: true, data: state }));
    }
    const window = BrowserWindow.getAllWindows()[0];
    window.setBounds({ x: 0, y: 0, width: 1500, height: 950 });
    const contents = window.webContents;
    const send = contents.send.bind(contents);
    // Keep late auth discovery on the fixture; editor messages are unmodified.
    contents.send = (channel, ...args) => send(channel, ...(channel === channels.event ? [state] : args));
    contents.send(channels.event, state);
  }, channels);
  // Discard pending real-login replies before restoring the local auth fixture.
  await page.reload();
  await page.waitForFunction(() => !!window.__PI_DESKTOP__);
  const invoke = (name, ...args) => page.evaluate(async ({ name, args }) => {
    const response = await window.piDesktop.invoke(window.piDesktop.channels.invoke[name], ...args);
    if (!response.ok) throw new Error(JSON.stringify(response));
    return response.data;
  }, { name, args });
  await step("real preload and Rust workspace/session", async () => {
    await invoke("projectSet", workspace);
    const { session } = await invoke("sessionCreate", { title: "Courseware text bridge", projectPath: workspace });
    await page.evaluate(async (id) => window.__PI_DESKTOP__.selectSession(id), session.id);
    await page.evaluate(() => {
      window.__editorStates = [];
      window.piDesktop.on(window.piDesktop.channels.event.pptEditorState, (state) => window.__editorStates.push(state));
    });
  });
  const open = () => page.evaluate(async () => {
    window.__PI_CAPTURE__ = true;
    await window.__PI_DESKTOP__.openWorkPanelArtifact("file", "lesson.pptx");
  });
  const findEditor = async () => {
    let host, sdk;
    await expect.poll(async () => {
      host = app.context().pages().find((target) => target.url().startsWith("deckwise-editor:"));
      if (!host) return false;
      for (const frame of host.frames()) {
        if (await frame.evaluate(() => Boolean(window.Asc?.editor?.isLoadFullApi && window.Asc.editor.isDocumentLoadComplete)).catch(() => false)) {
          sdk = frame;
          return true;
        }
      }
      return false;
    }, { timeout: 120_000 }).toBe(true);
    return { host, sdk };
  };
  if (testCase === "W01.3") await app.context().addInitScript(() => {
    if (location.protocol !== "deckwise-editor:") return;
    const add = window.addEventListener;
    window.addEventListener = function (type, listener, options) {
      if (type !== "message" || typeof listener !== "function") return add.call(this, type, listener, options);
      return add.call(this, type, function (event) {
        const gate = window.__saveGate;
        if (gate && event.source === document.querySelector("iframe")?.contentWindow) {
          if (event.data?.type === "document:saved" && gate.holdExport) { gate.saved = event.data; return; }
          if (event.data?.type === "document:save-committed" && gate.holdCommit) { gate.commit = event.data; return; }
        }
        return listener.call(this, event);
      }, options);
    };
    window.__gateInstalled = true;
  });
  await open();
  let { host, sdk } = await findEditor();
  const readNative = () => sdk.evaluate(() => {
    const doc = window.Asc.editor.WordControl.m_oLogicDocument;
    const decode = (items) => items.map((node) => {
      if (node.Type === 39 || node.Type === 48) return decode(node.Content);
      if (node.Type === 1 || node.Type === 2) return String.fromCodePoint(node.GetCodePoint());
      if (node.Type === 4 || node.Type === 16) return "\n";
      if (node.Type === 21) return "\t";
      if (node.Type === 71) return "";
      throw new Error("Unknown text item " + node.Type);
    }).join("");
    return { width: doc.GetWidthMM(), height: doc.GetHeightMM(),
      slides: doc.Slides.map((slide) => slide.cSld.spTree.map((shape) => ({
        text: shape.getDocContent?.()?.Content.map((paragraph) => decode(paragraph.Content)).join("") ?? null,
        x: shape.x, y: shape.y, width: shape.extX, height: shape.extY,
      }))),
    };
  });
  const selectTitle = () => sdk.evaluate(() => {
    const api = window.Asc.editor;
    const doc = api.WordControl.m_oLogicDocument;
    const shape = doc.Slides[api.getCurrentPage()].cSld.spTree[0];
    shape.Set_CurrentElement();
    shape.getDocContent().SelectAll();
    doc.Document_UpdateSelectionState();
  });
  const context = () => invoke("pptEditorGetContext");
  let request = 0;
  const command = (target, tool, input) => ({
    projectId: target.projectId, documentId: target.documentId, sessionId: target.sessionId,
    editGeneration: target.editGeneration, requestId: "w012-" + ++request, tool, input,
  });
  const execute = (command) => invoke("pptEditorExecute", command);
  await step("bound native read in the complete desktop", async () => {
    result.before = await readNative();
    const target = await context();
    assert.equal(target.page, 1);
    result.initialRead = await execute(command(target, "get_presentation_text", { maxChars: 8000 }));
    assert(result.initialRead.result.text.includes(result.before.slides[0][0].text.trim()));
  });
  const title = "Good! 很棒 😀\n再试一次\n";
  await step("replace selected text through IPC and verify exact native readback", async () => {
    await selectTitle();
    const target = await context();
    assert(target.capabilities.some((tool) => tool.name === "replace_selection"));
    const edit = command(target, "replace_selection", { text: title });
    result.replacement = await execute(edit);
    assert.equal(result.replacement.status, "verified");
    result.afterReplace = await readNative();
    assert.equal(result.afterReplace.slides[0][0].text, title + "\n");
    assert.deepEqual(result.afterReplace.slides[0].slice(1), result.before.slides[0].slice(1));
    assert.deepEqual(result.afterReplace.slides.slice(1), result.before.slides.slice(1));
    for (const key of ["x", "y", "width", "height"]) assert.equal(result.afterReplace.slides[0][0][key], result.before.slides[0][0][key]);
    await assert.rejects(execute(edit), /consumed/);
    await assert.rejects(execute(command(target, "add_slide_text", { text: "stale" })), /changed/);
    result.readback = await execute(command(await context(), "get_presentation_text", { maxChars: 8000 }));
    assert(result.readback.result.text.includes(title.trim()));
  });
  const added = "New text box 新增文本 😀\n第二行\n";
  await step("add a text box through the existing native executor", async () => {
    result.addition = await execute(command(await context(), "add_slide_text", { text: added }));
    assert.equal(result.addition.status, "verified");
    result.after = await readNative();
    assert.equal(result.after.slides[0].length, result.afterReplace.slides[0].length + 1);
    assert.equal(result.after.slides[0].at(-1).text, added + "\n");
    assert.deepEqual(result.after.slides[0].slice(0, -1), result.afterReplace.slides[0]);
    assert.deepEqual(result.after.slides.slice(1), result.before.slides.slice(1));
    assert.equal(result.after.width, result.before.width);
    assert.equal(result.after.height, result.before.height);
  });
  await step("manual interaction invalidates a captured write", async () => {
    const target = await context();
    await host.keyboard.press("Escape");
    await assert.rejects(execute(command(target, "add_slide_text", { text: "must not appear" })), /changed/);
    assert.deepEqual(await readNative(), result.after);
  });
  await step("visible native editor alongside the desktop shell", async () => {
    result.nativeViews = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.map((view) => ({
      bounds: view.getBounds(), url: view.webContents?.getURL(),
    })));
    assert(result.nativeViews.some((view) => view.url?.startsWith("deckwise-editor:") && view.bounds.width > 100 && view.bounds.height > 100));
    await host.screenshot({ path: join(out, "wiseoffice-edited.png") });
    await page.screenshot({ path: join(out, "desktop-shell.png") });
  });
  if (testCase === "W01.3") {
    result.exportSnapshot = result.after;
    // Delay real host messages at the browser/IPC boundary; exports and SDK edits remain real.
    const installGate = async () => host.evaluate(() => {
      if (!window.__gateInstalled) throw new Error("Save gate was not installed before host listeners");
      if (window.__saveGate?.saved) window.__oldExport = window.__saveGate.saved;
      window.__saveGate = { saved: null, commit: null, holdExport: true, holdCommit: true, remove() { window.__saveGate = null; } };
    });
    const release = async (field) => host.evaluate((field) => {
      const gate = window.__saveGate;
      const message = gate[field];
      if (!message) throw new Error("No held " + field);
      gate[field === "saved" ? "holdExport" : "holdCommit"] = false;
      const iframe = document.querySelector("iframe");
      window.dispatchEvent(new MessageEvent("message", { data: message, source: iframe.contentWindow, origin: new URL(iframe.src).origin }));
    }, field);
    const awaitHeld = (field) => expect.poll(() => host.evaluate((field) => Boolean(window.__saveGate[field]), field), { timeout: 120_000 }).toBe(true);
    const lastState = () => page.evaluate(() => window.__editorStates.at(-1));
    const saveButton = () => page.locator(".ppt-editor-toolbar").getByRole("button", { name: /^(Save|保存)/ });
    const dirtyInOffice = () => host.evaluate(() => new Promise((resolve, reject) => {
      const iframe = document.querySelector("iframe"), origin = new URL(iframe.src).origin;
      const id = crypto.randomUUID();
      const finish = () => { clearTimeout(timer); window.removeEventListener("message", listener); };
      const listener = (event) => {
        if (event.source !== iframe.contentWindow || event.origin !== origin || event.data?.id !== id || event.data?.type !== "document:state") return;
        finish();
        if (typeof event.data.payload?.dirty !== "boolean") reject(new Error("Invalid Office dirty state"));
        else resolve(event.data.payload.dirty);
      };
      const timer = setTimeout(() => { finish(); reject(new Error("Office state query timed out")); }, 10_000);
      window.addEventListener("message", listener);
      iframe.contentWindow.postMessage({ type: "document:get-state", id }, origin);
    }));

    let oldExport;
    await step("export snapshot plus later keyboard edit stays dirty until a second save", async () => {
      await installGate();
      await saveButton().click();
      await awaitHeld("saved");
      await expect(saveButton()).toBeDisabled();
      await expect(page.locator(".ppt-editor-toolbar button[aria-label]")).toBeDisabled();
      assert.equal((await lastState()).status, "saving");
      assert.equal(await dirtyInOffice(), true);
      assert.equal(hash(await readFile(path)), result.sourceHash);
      await assert.rejects(invoke("pptEditorClose"), /Finish the current save/);
      await assert.rejects(context(), /save is in progress/);
      await assert.rejects(invoke("pptEditorInspectStart"), /finish saving/);
      await expect(page.locator(".pptx-inspection button").first()).toBeDisabled();
      await selectTitle();
      const textInput = sdk.locator("#area_id");
      await textInput.focus();
      await host.keyboard.insertText("Edited during export 😀");
      await expect.poll(async () => (await readNative()).slides[0][0].text).toContain("Edited during export");
      result.duringExport = await readNative();
      result.after = result.duringExport;
      oldExport = await host.evaluate(() => ({ id: window.__saveGate.saved.id }));
      await release("saved");
      await awaitHeld("commit");
      assert.equal((await lastState()).status, "saving");
      await assert.rejects(invoke("pptEditorInspectStart"), /finish saving/);
      assert.equal(await dirtyInOffice(), true);
      await release("commit");
      await expect.poll(lastState).toMatchObject({ status: "ready", dirty: true });
      await expect(page.locator(".ppt-editor-toolbar [role=status]")).toHaveText(/未保存|Unsaved/);
      await page.screenshot({ path: join(out, "desktop-dirty-after-export.png") });
      assert.equal(await dirtyInOffice(), true);
      await copyFile(path, join(out, "export-snapshot.pptx"));
      result.race = { state: await lastState(), snapshotHash: hash(await readFile(path)), live: result.duringExport };
    });

    await step("old export and commit replies cannot finish a newer save", async () => {
      await installGate();
      await saveButton().click();
      await awaitHeld("saved");
      result.retryId = await host.evaluate(() => window.__saveGate.saved.id);
      assert.notEqual(result.retryId, oldExport.id);
      const oldHash = hash(await readFile(path));
      await host.evaluate(async (old) => {
        window.deckwiseEditorHost.sendEvent({ type: "saved", id: old.id, bytes: await window.__oldExport.payload.file.arrayBuffer() });
        window.deckwiseEditorHost.sendEvent({ type: "message", message: { id: old.id, type: "document:save-committed", payload: { dirty: false, success: true } } });
      }, oldExport);
      assert.equal((await lastState()).status, "saving");
      assert.equal(hash(await readFile(path)), oldHash);
      await release("saved");
      await awaitHeld("commit");
      assert.equal((await lastState()).status, "saving");
      await release("commit");
      await expect.poll(lastState).toMatchObject({ status: "saved", dirty: false });
      assert.equal(await dirtyInOffice(), false);
      await host.evaluate(() => window.__saveGate.remove());
    });

    await step("real source-write failure leaves edits dirty and toolbar retry saves them", async () => {
      result.afterFailureEdit = await execute(command(await context(), "add_slide_text", { text: "Retry survives 保存失败后重试" }));
      result.after = await readNative();
      const beforeFailureHash = hash(await readFile(path));
      // Inject one OS write error at the filesystem boundary, restricted to the throwaway source.
      await app.evaluate(async (_electron, path) => {
        const fs = process.getBuiltinModule("fs");
        const rename = fs.promises.rename;
        fs.promises.rename = async (from, to) => {
          if (to === path) {
            fs.promises.rename = rename;
            const error = new Error("EACCES: simulated source rename failure");
            error.code = "EACCES";
            throw error;
          }
          return rename(from, to);
        };
      }, path);
      await saveButton().click();
      await expect.poll(lastState, { timeout: 120_000 }).toMatchObject({ status: "error", dirty: true, canSave: true });
      assert.match((await lastState()).message, /EACCES/);
      assert.equal(hash(await readFile(path)), beforeFailureHash);
      assert.equal(await dirtyInOffice(), true);
      result.failedSave = await lastState();
      await expect(page.locator(".ppt-editor-toolbar [role=status]")).toContainText("EACCES");
      await page.screenshot({ path: join(out, "desktop-write-error.png") });
      await expect(saveButton()).toBeEnabled();
      await saveButton().click();
      await expect.poll(lastState, { timeout: 120_000 }).toMatchObject({ status: "saved", dirty: false });
      assert.equal(await dirtyInOffice(), false);
      assert.notEqual(hash(await readFile(path)), beforeFailureHash);
    });
  }
  await step("save actual source PPTX and reopen exact native contents", async () => {
    await page.locator(".ppt-editor-toolbar").getByRole("button", { name: /^(Save|保存)/ }).click();
    await expect.poll(() => page.evaluate(() => window.__editorStates.at(-1)?.status), { timeout: 90_000 }).toBe("saved");
    result.savedHash = hash(await readFile(path));
    assert.notEqual(result.savedHash, result.sourceHash);
    await copyFile(path, join(out, "saved.pptx"));
    result.states = await page.evaluate(() => window.__editorStates);
    const state = result.states.at(-1);
    assert.equal(state.sha256, result.savedHash);
    assert.equal(hash(await readFile(join(workspace, state.revisionPath))), result.savedHash);
    const old = await context();
    await page.locator(".ppt-editor-toolbar button[aria-label]").click();
    await expect(page.locator(".ppt-editor-toolbar")).toHaveCount(0);
    await open();
    ({ host, sdk } = await findEditor());
    result.reopened = await readNative();
    assert.equal(result.reopened.width, result.after.width);
    assert.equal(result.reopened.height, result.after.height);
    assert.equal(result.reopened.slides.length, result.after.slides.length);
    result.reopenGeometryToleranceMm = 1 / 36000;
    for (const [page, shapes] of result.after.slides.entries()) {
      assert.equal(result.reopened.slides[page].length, shapes.length);
      for (const [index, shape] of shapes.entries()) {
        const reopened = result.reopened.slides[page][index];
        assert.equal(reopened.text, shape.text);
        // PPTX coordinates are integer EMUs; the SDK reports millimetres.
        for (const key of ["x", "y", "width", "height"]) {
          assert(Math.abs(reopened[key] - shape[key]) <= result.reopenGeometryToleranceMm + 1e-12,
            `Saved geometry changed: slide ${page + 1}, shape ${index + 1}, ${key}`);
        }
      }
    }
    await assert.rejects(execute(command(old, "add_slide_text", { text: "expired session" })), /another session/);
    await host.screenshot({ path: join(out, "wiseoffice-reopened.png") });
  });
  result.status = "PASS";
} catch (error) {
  result.status = "FAIL";
  result.error = error.stack;
  console.error(error);
  process.exitCode = 1;
  if (app) for (const [index, page] of app.context().pages().entries()) {
    await page.screenshot({ path: join(out, `failure-${index}.png`) }).catch(() => {});
  }
} finally {
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    app.process().kill("SIGTERM");
  }
  await writeFile(join(out, "result.json"), JSON.stringify(result, null, 2) + "\n");
  await writeFile(join(out, "electron.log"), logs.join(""));
  console.log(result.status, out);
}
