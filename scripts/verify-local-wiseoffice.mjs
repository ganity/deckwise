// Run with Electron, not Node; the source document is opened in memory only.
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as electron from "electron";

const { app, BrowserWindow, ipcMain, session } = electron;
const desktop = fileURLToPath(new URL("../apps/desktop", import.meta.url));
const require = createRequire(join(desktop, "package.json"));
const ts = require("typescript");
const cache = new Map();
function load(file) {
  const source = readFileSync(file, "utf8");
  const imports = [...source.matchAll(/from "(\.\/[^"]+)"/g)];
  for (const [, path] of imports) load(resolve(dirname(file), path + ".ts"));
  const module = { exports: {} };
  new Function(
    "require",
    "exports",
    "module",
    ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
  )(
    (id) => {
      if (id === "electron")
        return {
          ...electron,
          app: { isPackaged: false, getAppPath: () => desktop },
        };
      if (id.startsWith("."))
        return cache.get(resolve(dirname(file), id + ".ts"));
      return require(id);
    },
    module.exports,
    module,
  );
  cache.set(file, module.exports);
  return module.exports;
}
const host = load(join(desktop, "electron/main/editor-host-protocol.ts"));
host.registerEditorHostScheme();
async function main() {
  const input = process.argv[2];
  assert(input, "Supply a local PPTX fixture");
  const profile = await mkdtemp(join(tmpdir(), "deckwise-local-editor-"));
  app.setPath("userData", profile);
  await app.whenReady();
  const preload = join(profile, "preload.cjs");
  await writeFile(
    preload,
    `const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('deckwiseEditorHost', {
 sendEvent: event => ipcRenderer.send('probe', event),
 onCommand: callback => ipcRenderer.on('command', (_event, command) => callback(command))
});`,
  );
  const editorSession = session.fromPartition("local-editor-probe");
  host.installEditorHostProtocol(editorSession.protocol);
  const remote = [];
  editorSession.webRequest.onCompleted((details) => {
    if (details.statusCode >= 400)
      console.error("RESOURCE_FAILED", details.statusCode, details.url);
  });
  editorSession.webRequest.onBeforeRequest((details, callback) => {
    const network = /^https?:/.test(details.url);
    if (network) remote.push(details.url.split("?")[0]);
    callback({ cancel: network });
  });
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      preload,
      session: editorSession,
      backgroundThrottling: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.webContents.on("render-process-gone", (_event, details) =>
    console.error("RENDER_PROCESS_GONE", details),
  );
  window.webContents.on("did-fail-load", (_event, code, description, url) =>
    console.error("LOAD_FAILED", code, description, url),
  );
  const timeout = setTimeout(() => {
    console.error("Local editor probe timed out", remote);
    app.exit(1);
  }, 90_000);
  window.webContents.on("console-message", (event) => {
    if (event.level >= 2 || event.level === "error")
      console.error(event.message);
  });
  const request = (type, payload, id) =>
    new Promise((resolve, reject) => {
      const listener = (_event, event) => {
        const message = event.message;
        if (message?.id !== id && event.id !== id) return;
        if (
          event.type === "saved" ||
          message?.type === "document:error" ||
          message?.type === "document:opened" ||
          message?.type === "document:save-committed"
        ) {
          ipcMain.removeListener("probe", listener);
          if (message?.type === "document:error")
            reject(new Error(message.payload?.message));
          else resolve(event.type === "saved" ? event : message.payload);
        }
      };
      ipcMain.on("probe", listener);
      window.webContents.send("command", { type, payload, id });
    });
  const nativeReady = async () => {
    const editorFrame = window.webContents.mainFrame.frames.find((frame) =>
      frame.url.startsWith("deckwise-editor://wiseoffice/"),
    );
    assert(editorFrame, "Local editor frame missing");
    return editorFrame.executeJavaScript(`new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      const frame = document.querySelector('iframe[name="frameEditor"]');
      const api = frame?.contentWindow?.Asc?.editor;
      if (api?.isDocumentLoadComplete && api?.isLoadFullApi) resolve({pages: api.WordControl.m_oLogicDocument.Slides.length, origin: frame.contentWindow.location.origin, isolated: frame.contentWindow.crossOriginIsolated});
      else if (Date.now() - started > 60000) reject(new Error('Native SDK did not become ready'));
      else setTimeout(check, 100);
    }; check();
  })`);
  };
  try {
    const ready = new Promise((resolve) => {
      const listener = (_event, event) => {
        if (event.message?.type !== "document:ready") return;
        ipcMain.removeListener("probe", listener);
        resolve();
      };
      ipcMain.on("probe", listener);
    });
    await window.loadURL(
      "deckwise-editor://host/index.html?deckwise=1&editor=deckwise-editor%3A%2F%2Fwiseoffice&editorOrigin=deckwise-editor%3A%2F%2Fwiseoffice",
    );
    await ready;
    const original = new Uint8Array(await readFile(input));
    const binding = {
      projectId: "probe",
      documentId: "probe",
      sessionId: "probe",
    };
    await request(
      "document:open-buffer",
      {
        fileName: "offline-probe.pptx",
        buffer: original.buffer,
        editorBinding: binding,
      },
      "open",
    );
    const opened = await nativeReady();
    assert(opened.pages > 0);
    assert.equal(opened.origin, "deckwise-editor://wiseoffice");
    assert.equal(opened.isolated, true);
    const exported = await request(
      "document:save",
      { targetExt: "PPTX", requireHostCommit: true },
      "save",
    );
    const saved = new Uint8Array(exported.bytes);
    assert(saved.length > 1000);
    assert.equal(saved[0], 0x50);
    assert.equal(saved[1], 0x4b);
    await writeFile(join(profile, "saved-probe.pptx"), saved);
    await request("document:commit-save", { success: true }, "save");
    await request(
      "document:open-buffer",
      {
        fileName: "reopened.pptx",
        buffer: saved.buffer,
        editorBinding: { ...binding, sessionId: "reopened" },
      },
      "reopen",
    );
    const reopened = await nativeReady();
    assert.equal(reopened.pages, opened.pages);
    assert.equal(reopened.isolated, true);
    assert.deepEqual(
      new Uint8Array(await readFile(input)),
      original,
      "Probe changed its source",
    );
    assert.equal(remote.length, 0, `Remote requests: ${remote.join(", ")}`);
    console.log(
      JSON.stringify({
        status: "LOCAL_EDITOR_ROUNDTRIP",
        ...reopened,
        savedBytes: saved.length,
        remoteRequests: remote.length,
      }),
    );
  } finally {
    clearTimeout(timeout);
    window.destroy();
    await rm(profile, { recursive: true, force: true });
  }
  app.quit();
}
void main().catch((error) => {
  console.error(error);
  app.exit(1);
});
