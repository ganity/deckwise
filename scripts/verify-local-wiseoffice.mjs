// Run with Electron, not Node; the source document is opened in memory only.
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
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
  const input = process.argv.at(-1);
  assert(input?.toLowerCase().endsWith(".pptx"), "Supply a local PPTX fixture");
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
    if (event.message.includes("[OO] open conversion failed")) app.exit(1);
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
          message?.type === "document:ui-configured" ||
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
    const editorFrame = window.webContents.mainFrame;
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
      "deckwise-editor://wiseoffice/module.html?deckwise=1",
    );
    await ready;
    await request("document:configure-ui", { theme: "light" }, "initial-theme");
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
    console.log("LOCAL_EDITOR_OPENED", JSON.stringify(opened));
    assert(opened.pages > 0);
    assert.equal(opened.origin, "deckwise-editor://wiseoffice");
    assert.equal(opened.isolated, true);
    const previewFrame = window.webContents.mainFrame;
    for (const theme of ["light", "dark", "light"]) {
      await request("document:configure-ui", { theme }, "theme-" + theme);
      const expected = theme === "dark" ? "theme-dark" : "theme-white";
      await previewFrame.executeJavaScript(`new Promise((resolve, reject) => {
        const started = Date.now();
        const check = () => {
          const themes = document.querySelector('iframe[name="frameEditor"]')?.contentWindow?.Common?.UI?.Themes;
          if (themes?.currentThemeId?.() === '${expected}') resolve(true);
          else if (Date.now() - started > 10000) reject(new Error('Host theme did not reach the native editor'));
          else setTimeout(check, 50);
        }; check();
      })`);
    }
    console.log("LOCAL_EDITOR_THEME_SYNCED", JSON.stringify({ light: "theme-white", dark: "theme-dark" }));
    const previewPrimitives = await previewFrame.executeJavaScript(`import('/.deckwise/teaching-preview.mjs').then(m =>
      typeof m.SpeechCueScheduler === 'function' && typeof m.createTeachingTimelinePreview === 'function' && m.buildEvenOddPath([{x:1,y:2,w:3,h:4}]).includes('M 1 2'))`);
    assert.equal(previewPrimitives, true, "Local shared teaching preview primitives did not load");
    const audioFixture = readFileSync(join(desktop, "test/fixtures/courseware-tts-tone.mp3")).toString("base64");
    const mediaPreview = await previewFrame.executeJavaScript(`(async () => {
      const { createTeachingTimelinePreview } = await import('/.deckwise/teaching-preview.mjs');
      const url = URL.createObjectURL(new Blob([Uint8Array.from(atob('${audioFixture}'), c => c.charCodeAt(0))], { type: 'audio/mpeg' }));
      let preview, timer;
      try {
        return await new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Local teaching audio timed out')), 15000);
          preview = createTeachingTimelinePreview({ pageId: 'media-probe',
            nodes: [{id:'speech',type:'speech',text:'Local audio',audioUrl:url}, {id:'music',type:'audio_clip',audioUrl:url}],
            onMode() {}, onProgress() {}, onNode() {}, onError: reject, onComplete: () => resolve(true) });
          preview.start();
        });
      } finally { clearTimeout(timer); preview?.dispose(); URL.revokeObjectURL(url); }
    })()`, true);
    assert.equal(mediaPreview, true, "Production editor CSP blocked local teaching media");
    console.log("LOCAL_TEACHING_MEDIA_PLAYED", JSON.stringify({ speech: true, music: true }));
    let teachingRequests = 0;
    let voiceModelReads = 0;
    let voiceModelRecovered = false;
    const teachingListener = (_event, event) => {
      const message = event.message;
      if (message?.type !== "document:teaching-request") return;
      teachingRequests++;
      const operation = message.payload?.operation;
      if (operation === "tts:models" && ++voiceModelReads === 1) {
        window.webContents.send("command", { type: "document:teaching-response", id: message.id,
          payload: { error: "Teaching view changed; reload current page" } });
        return;
      }
      if (operation === "media:list" && voiceModelReads === 2) voiceModelRecovered = true;
      const result = operation === "open" ? {
        viewId: "probe-teaching", pageId: "probe-page", pageNumber: 1,
        project: { teachingRevision: "probe-revision", pages: [{ pageId: "probe-page", locked: false,
          actions: [{ id: "probe-speech", type: "speech", text: "Local teaching probe" }] }] },
      } : operation === "draft:get" ? { draft: null } : [];
      assert(["open", "draft:get", "tts:models", "tts:list", "media:list"].includes(operation), "Probe must not create paid tasks");
      window.webContents.send("command", { type: "document:teaching-response", id: message.id, payload: { result } });
    };
    ipcMain.on("probe", teachingListener);
    window.webContents.send("command", { type: "document:teaching-enable", payload: { binding } });
    const localFrame = window.webContents.mainFrame;
    await localFrame.executeJavaScript(`new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        const doc = document.querySelector('iframe[name="frameEditor"]')?.contentDocument;
        const panel = doc?.querySelector('.deckwise-teaching-sidebar');
        if (panel && panel.getBoundingClientRect().width > 0 && panel.querySelector('textarea')?.value === 'Local teaching probe') {
          if (panel.getBoundingClientRect().width < 350 || !panel.querySelector('.teaching-flow article[data-selected] .teaching-inspector'))
            reject(new Error('The redesigned native teaching layout did not load'));
          else resolve(true);
        }
        else if (Date.now() - started > 15000) reject(new Error('Local native teaching sidebar did not load'));
        else setTimeout(check, 50);
      }; check();
    })`);
    console.log("LOCAL_TEACHING_LAYOUT_READY");
    const recoveryDeadline = Date.now() + 15000;
    while (!voiceModelRecovered && Date.now() < recoveryDeadline) await delay(50);
    assert.equal(voiceModelRecovered, true, "Failed voice reads must recover without a paid request");
    assert.equal(voiceModelReads, 2, "Recovery must be bounded to one retry");
    assert.equal(await localFrame.executeJavaScript(`new Promise(resolve => setTimeout(() => {
      const panel = document.querySelector('iframe[name="frameEditor"]')?.contentDocument?.querySelector('.deckwise-teaching-sidebar');
      resolve(!!panel && !panel.querySelector('[role=alert]'));
    }, 100))`), true, "A recovered read must not leave a service-unavailable warning");
    console.log("LOCAL_TEACHING_VOICE_READ_RECOVERED");
    const exported = await request(
      "document:save",
      { targetExt: "PPTX", requireHostCommit: true },
      "save",
    );
    const saved = new Uint8Array(exported.bytes);
    console.log("LOCAL_EDITOR_EXPORTED", saved.length);
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
    ipcMain.removeListener("probe", teachingListener);
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
        nativeTeaching: teachingRequests >= 2,
        previewPrimitives,
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
