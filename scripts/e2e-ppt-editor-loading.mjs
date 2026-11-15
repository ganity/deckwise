#!/usr/bin/env node
/** Exercise the real Electron editor host/controller with a controlled embed peer. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const { electronBinary } = resolveElectronBinary(root);
const temp = await mkdtemp(join(tmpdir(), "deckwise-editor-loading-"));
try {
  const desktop = join(root, "apps/desktop");
  await build({
    entryPoints: [join(desktop, "electron/main/ppt-editor.ts")],
    outfile: join(temp, "main/controller.cjs"), bundle: true, platform: "node", format: "cjs",
    external: ["electron"],
    plugins: [{ name: "shorten-test-deadline", setup(build) {
      build.onResolve({ filter: /^@pi-desktop\/courseware-runtime\/node$/ }, () => ({
        path: join(root, "packages/courseware-runtime/dist/node.mjs"), external: true,
      }));
      build.onLoad({ filter: /ppt-editor-handshake\.ts$/ }, async args => ({
        contents: (await readFile(args.path, "utf8")).replace("60_000", "2_000").replace("180_000", "2_000"),
        loader: "ts",
      }));
    } }],
  });
  await build({
    entryPoints: [join(desktop, "electron/main/editor-host-protocol.ts")],
    outfile: join(temp, "protocol.cjs"), bundle: true, platform: "node", format: "cjs", external: ["electron"],
  });
  await build({
    entryPoints: [join(desktop, "electron/preload/editor-host.ts")],
    outfile: join(temp, "preload/editor-host.js"), bundle: true, platform: "node", format: "cjs", external: ["electron"],
  });
  await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { readFile, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { PptEditorController } = require("./main/controller.cjs");
require("./protocol.cjs").registerEditorHostScheme();
app.setPath("userData", path.join(__dirname, "profile"));
app.setAppPath(${JSON.stringify(desktop)});
app.whenReady().then(async () => {
  let mode = "silent";
  let outputBytes = Buffer.from("PK[Content_Types].xmlword/document.xml edited");
  const server = createServer((_request, response) => {
    if (mode === "network") { response.destroy(); return; }
    response.setHeader("Content-Type", "text/html");
    response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    if (mode === "office") {
      response.end('<!doctype html><script>window.addEventListener("message", event => {' +
        'const command=event.data; if(command.type==="document:open-buffer") parent.postMessage({type:"document:opened",id:command.id,payload:{fileName:command.payload.fileName,readonly:command.payload.readonly,deckwise:new URLSearchParams(location.search).get("deckwise")}},event.origin);' +
        'if(command.type==="document:save") parent.postMessage({type:"document:saved",id:command.id,payload:{file:new Blob([new Uint8Array(' + JSON.stringify([...outputBytes]) + ')]),fileName:"edited."+command.payload.targetExt.toLowerCase()}},event.origin);' +
        'if(command.type==="document:commit-save") parent.postMessage({type:"document:save-committed",id:command.id,payload:{success:command.payload.success,dirty:false}},event.origin);' +
        '});parent.postMessage({type:"document:ready"},"*");</script>');
      return;
    }
    const readyDelay = mode === "slow-shell" || mode === "slow-native" ? 1300 : 0;
    const openDelay = mode === "slow-shell" ? 1000 : 150;
    response.end('<!doctype html><style>body{background:white}</style><script>' +
      (mode === "silent" ? '' :
        'let sdkReadyAt=0;window.addEventListener("message", event => { const command=event.data;' +
        'if(command.type === "document:get-context") {const loading=Date.now()<sdkReadyAt; parent.postMessage({type:loading?"document:error":"document:context",id:command.id,payload:loading?{message:"Editor is still loading"}:{...command.payload,kind:"slide",editGeneration:1,page:1,readOnly:false,selectedText:"",selectionCharacters:0,capabilities:[]}},event.origin);return;}' +
        'if(command.type !== "document:open-buffer") return; sdkReadyAt=Date.now()+' + (mode === "slow-native" ? 1000 : 0) + ';' +
        (mode === "document-silent" ? 'return;' : '') +
        'setTimeout(() => parent.postMessage({type:' +
        JSON.stringify(mode === "error" ? "document:error" : "document:opened") +
        ',id:command.id,payload:{message:"conversion failed"}},event.origin),' + openDelay + '); });setTimeout(()=>parent.postMessage({type:"document:ready"},"*"),' + readyDelay + ');') +
      '</script>');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const window = new BrowserWindow({ show: false, width: 800, height: 600 });
  const states = [];
  const controller = new PptEditorController(ipcMain, state => states.push(state), "http://127.0.0.1:" + server.address().port);
  const source = Buffer.from("PK[Content_Types].xmlppt/presentation.xml");
  await writeFile(path.join(__dirname, "document.pptx"), source);
  controller.setBounds({x:0,y:0,width:800,height:600});
  controller.setVisible(true);
  try {
    await assert.rejects(controller.open(window, __dirname, "document.pptx"), /timed out/);
    assert.equal(states.at(-1).status, "error");
    assert.equal(states.at(-1).canRetry, true);
    assert.equal(window.contentView.children.length, 0);
    assert(!states.some(state => state.status === "ready"));

    mode = "network";
    await assert.rejects(controller.open(window, __dirname, "document.pptx"), /failed to load/);
    assert.equal(states.at(-1).canRetry, true);
    assert.equal(window.contentView.children.length, 0);

    mode = "error";
    await assert.rejects(controller.open(window, __dirname, "document.pptx"), /conversion failed/);
    assert.equal(states.at(-1).canRetry, true);
    assert.equal(window.contentView.children.length, 0);

    mode = "success";
    const pending = controller.open(window, __dirname, "document.pptx");
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(states.at(-1).status, "opening");
    assert.equal(window.contentView.children.length, 0);
    const opened = await pending;
    assert.equal(opened.status, "ready");
    assert.equal(window.contentView.children.length, 1);
    const view = window.contentView.children[0];
    assert.equal((await controller.open(window, __dirname, "document.pptx")).status, "ready");
    assert.equal(window.contentView.children[0], view);
    assert.deepEqual(await readFile(path.join(__dirname, "document.pptx")), source);

    for (const delayedMode of ["slow-shell", "slow-native"]) {
      controller.close();
      mode = delayedMode;
      assert.equal((await controller.open(window, __dirname, "document.pptx")).status, "ready");
      assert.deepEqual(await readFile(path.join(__dirname, "document.pptx")), source);
    }
    controller.close();
    mode = "document-silent";
    await assert.rejects(controller.open(window, __dirname, "document.pptx"), /timed out/);
    assert.equal(states.at(-1).status, "error");
    assert.equal(window.contentView.children.length, 0);

    controller.close();
    mode = "office";
    const waitState = status => new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("State timeout: " + status)), 3000);
      const poll = setInterval(() => { if(states.at(-1).status !== status) return; clearInterval(poll); clearTimeout(deadline); resolve(states.at(-1)); }, 10);
    });
    await writeFile(path.join(__dirname, "word.docx"), Buffer.from("PK[Content_Types].xmlword/document.xml original"));
    assert.equal((await controller.open(window, __dirname, "word.docx")).readOnly, false);
    controller.save();
    await waitState("saved");
    assert.deepEqual(await readFile(path.join(__dirname, "word.docx")), outputBytes);
    assert.equal(states.at(-1).revision, 2);
    const legacy = Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]);
    await writeFile(path.join(__dirname, "legacy.doc"), legacy);
    await controller.open(window, __dirname, "legacy.doc");
    controller.save();
    await waitState("saved");
    assert.deepEqual(await readFile(path.join(__dirname, "legacy.doc")), legacy);
    assert.deepEqual(await readFile(path.join(__dirname, "legacy-edited-r2.docx")), outputBytes);
    assert.equal(states.at(-1).savedPath, "legacy-edited-r2.docx");
    await writeFile(path.join(__dirname, "document.pdf"), Buffer.from("%PDF-1.7"));
    assert.equal((await controller.open(window, __dirname, "document.pdf")).readOnly, true);
    assert.throws(() => controller.save(), /read-only/);
    const attachment = path.join(__dirname, "..", "attachment-" + process.pid);
    await writeFile(attachment, Buffer.from("PK[Content_Types].xmlword/document.xml"));
    try {
      await assert.rejects(controller.open(window, __dirname, attachment, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), /outside allowed/);
      assert.equal((await controller.open(window, __dirname, attachment, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", [path.dirname(attachment)])).readOnly, true);
      assert.throws(() => controller.save(), /read-only/);
    } finally { await require("node:fs/promises").unlink(attachment); }
    controller.close();
    mode = "silent";
    const cancelled = controller.open(window, __dirname, "document.pptx");
    await new Promise(resolve => setTimeout(resolve, 100));
    controller.close();
    await assert.rejects(cancelled, /cancelled|ERR_ABORTED/);
    assert.equal(states.at(-1).status, "closed");
    assert.equal(window.contentView.children.length, 0);
    console.log("PPT_EDITOR_LOADING_OK");
  } finally {
    controller.dispose();
    window.destroy();
    server.close();
    app.quit();
  }
}).catch(error => { console.error(error); app.exit(1); });
`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [...process.argv.slice(2), join(temp, "main.cjs")], {
    env, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { output += data; });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } finally { clearTimeout(timeout); }
  assert.equal(code, 0, output.slice(-4000));
  assert.match(output, /PPT_EDITOR_LOADING_OK/);
  console.log("PPT_EDITOR_LOADING_OK: startup/document deadlines, slow shell/native readiness, retry, save and close cancellation");
} finally { await rm(temp, { recursive: true, force: true }); }
