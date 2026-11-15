import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { app, BrowserWindow, ipcMain } from "electron";
import { PptEditorController } from "../electron/main/ppt-editor";
import { registerEditorHostScheme } from "../electron/main/editor-host-protocol";

const root = process.env.DECKWISE_E2E_TEMP!;
const output = process.env.DECKWISE_E2E_OUTPUT!;
assert(root && output && process.env.DECKWISE_EDITOR_URL);
app.setPath("userData", join(root, "profile"));
app.setAppPath(process.env.DECKWISE_E2E_APP!);
registerEditorHostScheme();
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const operations: string[] = [];
async function main() {
  await app.whenReady();
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const editor = new PptEditorController(ipcMain, () => {}, process.env.DECKWISE_EDITOR_URL);
  try {
    const source = await readFile(process.env.DECKWISE_E2E_PPTX!);
    const sourcePath = join(root, "source.pptx"), workspace = join(root, "workspace");
    await mkdir(workspace); await writeFile(sourcePath, source, { flag: "wx" });
    const state = await editor.open(window, workspace, sourcePath, undefined, [root]);
    assert.equal(state.readOnly, true); assert.equal(state.canSave, false); assert.equal(state.sha256, sha(source));
    let ready = false;
    for (let attempt = 0; attempt < 240; attempt++) {
      try { if ((await editor.getContext(workspace)).page) { ready = true; break; } } catch {}
      await delay(250);
    }
    assert(ready, "Native Office did not become ready");
    operations.push("real Main controller opens separate readonly source with private lineage");
    const before = await editor.getContext(workspace);
    assert.equal(before.page, 1);
    const normal = await editor.renderSavedPagePreview(workspace, 1);
    const textless = await editor.renderSavedPagePreview(workspace, 1, true);
    assert.equal(normal.sourceSha256, sha(source)); assert.equal(textless.sourceSha256, sha(source));
    assert.equal(normal.pageToken, textless.pageToken); assert.equal(textless.nativeTextOmitted, true);
    assert.equal(normal.image.width, 1600); assert.equal(normal.image.height, 1000);
    assert.notEqual(normal.image.sha256, textless.image.sha256);
    await writeFile(join(output, "normal.png"), normal.image.bytes);
    await writeFile(join(output, "native-textless.png"), textless.image.bytes);
    operations.push("actual normal and native-textless 1600px source-bound PNGs");
    const second = await editor.renderSavedPagePreview(workspace, 2);
    assert.equal(second.page, 2); assert.notEqual(second.pageToken, normal.pageToken);
    await writeFile(join(output, "page-two.png"), second.image.bytes);
    const after = await editor.getContext(workspace);
    assert.equal(after.page, 1); assert.equal(after.editGeneration, before.editGeneration);
    assert.deepEqual(await readFile(sourcePath), source);
    assert.deepEqual(await readFile(process.env.DECKWISE_E2E_PPTX!), source);
    assert.deepEqual(await readFile(sourcePath), await readFile(process.env.DECKWISE_E2E_PPTX!));
    assert.deepEqual(await editor.renderSavedPagePreview(workspace, 1), normal);
    operations.push("offscreen page two without navigation, edits, source changes or normal-render regression");
    for (const page of [0, -1, 1.2, 4, 5001]) await assert.rejects(editor.renderSavedPagePreview(workspace, page));
    await assert.rejects(editor.renderSavedPagePreview(workspace, 1, false, AbortSignal.abort()));
    const listenerCount = ipcMain.listenerCount("deckwise-editor:event");
    const controller = new AbortController();
    const pending = editor.renderSavedPagePreview(workspace, 1, false, controller.signal);
    queueMicrotask(() => controller.abort());
    await assert.rejects(pending);
    assert.equal(ipcMain.listenerCount("deckwise-editor:event"), listenerCount);
    assert.throws(() => editor.save(), /read-only/);
    operations.push("invalid pages, cancellation and save denied");
    editor.close();
    await assert.rejects(editor.renderSavedPagePreview(workspace, 1));
    const writablePath = join(workspace, "writable.pptx"); await writeFile(writablePath, source);
    await editor.open(window, workspace, writablePath);
    await assert.rejects(editor.renderSavedPagePreview(workspace, 1), /readonly/);
    operations.push("closed and writable sessions denied");
    await writeFile(join(output, "report.json"), JSON.stringify({ status: "PASS", operations, sourceSha256: sha(source),
      dimensions: [normal.image.width, normal.image.height], readonlyCopy: true, realMainController: true, realOffice: true,
      fullDesktopApplication: false, packaged: false, cleanPlateApproved: false, modelCalled: false, sandbox: "--no-sandbox" }, null, 2));
  } finally { editor.dispose(); window.destroy(); }
}
main().then(() => { console.log(`PASS ${operations.length} actual Main/Office source-preview groups`); app.exit(0); }).catch(async error => {
  console.error(error);
  await writeFile(join(output, "failure.json"), JSON.stringify({ status: "FAIL", operations, error: String(error.stack ?? error) }, null, 2));
  app.exit(1);
});
