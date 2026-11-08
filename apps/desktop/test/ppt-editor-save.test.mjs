import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import ts from "typescript";
import * as shared from "../../../packages/shared/dist/index.js";

const require = createRequire(import.meta.url);
// Package signature only: native PPTX roundtrips are covered by the desktop E2E.
const fixtureBytes = Buffer.from("PK\x03\x04ppt/presentation.xml[Content_Types].xml");

async function fixture(t, { contextErrors = [], contextPatch = {}, onContext = () => {}, nativeTeaching } = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), "ppt-save-test-"));
  const source = join(root, "lesson.pptx");
  await fs.writeFile(source, fixtureBytes);
  const ipc = new EventEmitter();
  const commands = [];
  const throttling = [];
  const sent = new EventEmitter();
  let view, viewOptions;
  const reply = (message, sender = view.webContents.id) => ipc.emit("deckwise-editor:event", { sender: { id: sender } }, message);
  const editorSession = Object.assign(new EventEmitter(), { protocol: { handle() {} }, setPermissionRequestHandler() {} });
  class View {
    constructor(options) {
      viewOptions = options;
      view = this;
      this.webContents = Object.assign(new EventEmitter(), {
        id: 42, session: editorSession, isDestroyed: () => false, close() {}, setWindowOpenHandler() {},
        setBackgroundThrottling(value) { throttling.push(value); },
        loadURL: async () => { reply({ type: "message", message: { type: "document:ready" } }); },
        send: (_channel, command) => {
          commands.push(command);
          sent.emit(command.type, command);
          if (command.type === "document:open-buffer") queueMicrotask(() => reply({ type: "message", message: { type: "document:opened", id: command.id } }));
          if (command.type === "document:get-context") {
            onContext(controller, states);
            const error = contextErrors.shift();
            const payload = error ? { message: error } : { ...command.payload, kind: "slide", page: 1,
              editGeneration: 1, selectedText: "", selectionCharacters: 0, readOnly: false, capabilities: [], ...contextPatch };
            queueMicrotask(() => reply({ type: "message", message: { type: error ? "document:error" : "document:context", id: command.id, payload } }));
          }
        },
      });
    }
    setBounds() {}
  }
  const electron = { WebContentsView: View, session: { fromPartition: () => editorSession }, app: { isPackaged: false, getAppPath: () => root } };
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const module = { exports: {} };
    cache.set(file, module.exports);
    const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
    new Function("require", "exports", "module", "__dirname", outputText)((id) => {
      if (id === "electron") return electron;
      if (id === "@pi-desktop/shared") return shared;
      if (id.startsWith(".")) return load(join(dirname(file), id + ".ts"));
      return require(id);
    }, module.exports, module, dirname(file));
    return module.exports;
  }
  const { PptEditorController } = load(new URL("../electron/main/ppt-editor.ts", import.meta.url).pathname);
  const states = [];
  if (nativeTeaching) {
    await fs.mkdir(join(root, "resources/wiseoffice"), { recursive: true });
    await fs.writeFile(join(root, "resources/wiseoffice/editor.html"), "fixture");
  }
  const controller = new PptEditorController(ipc, (state) => states.push(state), nativeTeaching ? "deckwise-editor://wiseoffice" : "http://127.0.0.1:4221");
  controller.nativeTeaching = nativeTeaching;
  const window = { isDestroyed: () => false, contentView: { children: [], addChildView() {}, removeChildView() {} } };
  t.after(async () => { controller.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  await controller.open(window, root, "lesson.pptx");
  const dirty = () => reply({ type: "message", message: { type: "document:dirty-changed", payload: { dirty: true } } });
  const start = () => { dirty(); controller.save(); return commands.at(-1); };
  const exported = async (save, bytes = fixtureBytes) => {
    const committed = new Promise((resolve) => sent.once("document:commit-save", resolve));
    reply({ type: "saved", id: save.id, bytes: Uint8Array.from(bytes).buffer });
    return committed;
  };
  const ack = (save, dirty, success = true) => reply({ type: "message", message: { type: "document:save-committed", id: save.id, payload: { dirty, success } } });
  return { root, source, controller, commands, states, reply, start, exported, ack, dirty, window, viewOptions, throttling, sent };
}

test("detached Office initialization runs without background timer throttling", async t => {
  const f = await fixture(t);
  assert.equal(f.window.contentView.children.length, 0);
  assert.equal(f.viewOptions.webPreferences.backgroundThrottling, false);
  assert.deepEqual(f.throttling, [true], "normal background scheduling resumes after native readiness");
});

test("PPTX stays opening until the loaded native editor answers, even after document:opened", async t => {
  let reads = 0;
  const f = await fixture(t, { contextErrors: ["OnlyOffice editor is not ready", "Editor is still loading"],
    onContext(controller, states) {
      reads++;
      assert.equal(states.at(-1).status, "opening");
      assert.throws(() => controller.teachingSnapshot(null), /No ready PPTX/);
    } });
  assert.equal(reads, 3);
  assert.equal(f.states.at(-1).status, "ready");
  assert(f.controller.teachingSnapshot(f.root));
});

test("a definite native startup error does not become ready or retry", async t => {
  let reads = 0;
  await assert.rejects(fixture(t, { contextErrors: ["Document conversion failed"], onContext() { reads++; } }), /Document conversion failed/);
  assert.equal(reads, 1);
});

test("closing during native startup cannot publish a late ready editor", async t => {
  let states;
  await assert.rejects(fixture(t, { onContext(controller, current) { states = current; controller.close(); } }), /cancel|changed|closed/i);
  assert(!states.some(state => state.status === "ready"));
});

test("native startup rejects a foreign binding, access mode or malformed context", async t => {
  for (const contextPatch of [{ sessionId: "foreign" }, { readOnly: true }, { editGeneration: -1 }])
    await assert.rejects(fixture(t, { contextPatch }));
});

test("exports are correlated, published once, and stay saving until host commit is acknowledged", async (t) => {
  const f = await fixture(t);
  const save = f.start();
  f.reply({ type: "saved", id: "old", bytes: Uint8Array.from(fixtureBytes).buffer });
  f.reply({ type: "saved", id: save.id, bytes: Uint8Array.from(fixtureBytes).buffer }, 999);
  assert.equal(f.states.at(-1).status, "saving");
  await assert.rejects(f.controller.open(f.window, f.root, "lesson.pptx"), /Finish the current save/);
  const committed = f.exported(save);
  f.reply({ type: "saved", id: save.id, bytes: Uint8Array.from(fixtureBytes).buffer });
  assert.throws(() => f.controller.close(), /Finish the current save/);
  const commit = await committed;
  assert.equal(commit.id, save.id);
  assert.equal(commit.payload.success, true);
  assert.equal(f.states.at(-1).status, "saving");
  f.ack({ id: "old" }, false);
  assert.equal(f.states.at(-1).status, "saving");
  f.ack(save, false);
  assert.equal(f.states.at(-1).status, "saved");
  assert.equal(f.states.at(-1).revision, 2);
  assert.deepEqual(await fs.readFile(f.source), fixtureBytes);
  f.dirty();
  assert.equal(f.states.at(-1).dirty, true);
  assert.equal(f.states.at(-1).status, "ready");
});

test("teaching snapshot is unavailable for dirty or saving native state", async (t) => {
  const f = await fixture(t);
  assert.equal(f.controller.teachingSnapshot(f.root).revision, 1);
  assert.throws(() => f.controller.teachingSnapshot("/other"), /No ready PPTX/);
  f.dirty();
  assert.throws(() => f.controller.teachingSnapshot(f.root), /Save or reopen/);
  f.controller.save();
  assert.throws(() => f.controller.teachingSnapshot(f.root), /No ready PPTX/);
});

test("ignores editor events without a sender during preview teardown", async (t) => {
  const f = await fixture(t);
  assert.doesNotThrow(() => f.controller["onEditorEvent"](undefined, { type: "message" }));
  assert.doesNotThrow(() => f.controller["onEditorEvent"]({ sender: {} }, { type: "message" }));
  const view = f.controller["view"];
  f.controller["view"] = { webContents: undefined };
  assert.doesNotThrow(() => f.controller["onEditorEvent"]({ sender: { id: 42 } }, { type: "message" }));
  f.controller["view"] = view;
  view.webContents = undefined;
  assert.doesNotThrow(() => f.controller.dispose());
});

test("edits made during export remain dirty; the next save and reopen restore the actual saved source", async (t) => {
  const f = await fixture(t);
  const first = f.start();
  await f.exported(first);
  f.ack(first, true);
  assert.equal(f.states.at(-1).status, "ready");
  assert.equal(f.states.at(-1).dirty, true);
  const second = f.start();
  f.ack(first, false);
  assert.equal(f.states.at(-1).status, "saving");
  await f.exported(second);
  f.ack(second, false);
  assert.equal(f.states.at(-1).revision, 3);
  f.controller.close();
  await f.controller.open(f.window, f.root, "lesson.pptx");
  assert.equal(f.states.at(-1).dirty, false);
  assert.equal(f.states.at(-1).revision, 3);
});

test("external source changes are preserved and a disk failure is retryable without clearing dirty", async (t) => {
  const f = await fixture(t);
  const save = f.start();
  const external = Buffer.concat([fixtureBytes, Buffer.from("external edit")]);
  await fs.writeFile(f.source, external);
  const commit = await f.exported(save);
  assert.equal(commit.payload.success, false);
  f.ack(save, true, false);
  assert.equal(f.states.at(-1).status, "error");
  assert.equal(f.states.at(-1).canSave, true);
  assert.equal(f.states.at(-1).dirty, true);
  assert.equal(f.states.at(-1).revision, 1);
  assert.deepEqual(await fs.readFile(f.source), external);
  await fs.writeFile(f.source, fixtureBytes);
  const retry = f.start();
  await f.exported(retry);
  f.ack(save, false);
  assert.equal(f.states.at(-1).status, "saving");
  f.ack(retry, false);
  assert.equal(f.states.at(-1).status, "saved");
});

test("a conversion error belongs to its save ID and blocks blind retry of an uncertain SDK export", async (t) => {
  const f = await fixture(t);
  const save = f.start();
  const error = (id) => f.reply({ type: "message", message: { type: "document:error", id, payload: { message: "Export timed out" } } });
  error("old");
  assert.equal(f.states.at(-1).status, "saving");
  error(save.id);
  assert.equal(f.states.at(-1).canSave, false);
  assert.equal(f.states.at(-1).dirty, true);
  assert.throws(() => f.controller.save(), /uncertain/);
  f.reply({ type: "saved", id: save.id, bytes: Uint8Array.from(fixtureBytes).buffer });
  assert.equal(f.states.at(-1).revision, 1);
});

test("a missing export or commit confirmation expires without advertising a saved document", async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const save = f.start();
  t.mock.timers.tick(210_001);
  assert.equal(f.states.at(-1).status, "error");
  assert.equal(f.states.at(-1).canSave, false);
  assert.equal(f.states.at(-1).dirty, true);
  f.ack(save, false);
  assert.equal(f.states.at(-1).status, "error");
});


test("missing commit acknowledgement cannot clear dirty after the disk write", async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const save = f.start();
  await f.exported(save);
  t.mock.timers.tick(15_001);
  assert.equal(f.states.at(-1).status, "error");
  assert.equal(f.states.at(-1).dirty, true);
  assert.equal(f.states.at(-1).canSave, false);
  f.ack(save, false);
  assert.equal(f.states.at(-1).status, "error");
});

test("reopen uses actual source bytes rather than an archived export left by a failed source write", async (t) => {
  const f = await fixture(t);
  const save = f.start();
  await f.exported(save);
  f.ack(save, false);
  f.controller.close();
  const manual = Buffer.concat([fixtureBytes, Buffer.from("new manual version")]);
  await fs.writeFile(f.source, manual);
  await f.controller.open(f.window, f.root, "lesson.pptx");
  const opened = f.commands.findLast((command) => command.type === "document:open-buffer");
  assert.deepEqual(Buffer.from(opened.payload.buffer), manual);
  assert.equal(f.states.at(-1).revision, 3);
  assert.equal(f.states.at(-1).dirty, false);
});


test("host failure during export reports uncertainty instead of remaining in saving", async (t) => {
  const f = await fixture(t);
  f.start();
  f.reply({ type: "error", message: "Host failed" });
  assert.equal(f.states.at(-1).status, "error");
  assert.equal(f.states.at(-1).canSave, false);
  assert.equal(f.states.at(-1).dirty, true);
});

test("inspection uses only saved bytes and is fenced through export, write and commit acknowledgement", async (t) => {
  const f = await fixture(t);
  const initial = f.controller.savedPptxSnapshot();
  f.dirty();
  assert.deepEqual(f.controller.savedPptxSnapshot(), initial);
  const save = f.start();
  assert.throws(() => f.controller.savedPptxSnapshot(), /finish saving/);
  const committed = f.exported(save, Buffer.concat([fixtureBytes, Buffer.from("saved edit")]));
  assert.throws(() => f.controller.savedPptxSnapshot(), /finish saving/);
  await committed;
  assert.throws(() => f.controller.savedPptxSnapshot(), /finish saving/);
  f.ack(save, true);
  const saved = f.controller.savedPptxSnapshot();
  assert.equal(saved.revision, 2);
  assert.notEqual(saved.sha256, initial.sha256);
  assert.equal(f.states.at(-1).dirty, true);
  f.controller.close();
  assert.throws(() => f.controller.savedPptxSnapshot(), /finish saving/);
});

test("inspection excludes an archived export when replacing the source fails", async (t) => {
  const f = await fixture(t);
  const initial = f.controller.savedPptxSnapshot();
  const save = f.start();
  // The archive is written before the source replacement; fail only the latter.
  const rename = fs.rename;
  t.mock.method(fs, "rename", async (from, to) => {
    if (to === f.source) throw new Error("EACCES: source replacement");
    return rename(from, to);
  });
  const commit = await f.exported(save, Buffer.concat([fixtureBytes, Buffer.from("unsaved export")]));
  assert.equal(commit.payload.success, false);
  f.ack(save, true, false);
  assert.equal(f.states.at(-1).revision, 2);
  assert.deepEqual(f.controller.savedPptxSnapshot(), initial);
  assert.deepEqual(await fs.readFile(f.source), fixtureBytes);
});

test("inspection rejects an uncertain save after acknowledgement timeout", async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const save = f.start();
  await f.exported(save);
  t.mock.timers.tick(15_001);
  assert.throws(() => f.controller.savedPptxSnapshot(), /finish saving/);
});


test("unchanged teaching reads reuse the verified digest instead of hashing the whole source again", async (t) => {
  const f = await fixture(t);
  const crypto = require("node:crypto");
  const hashing = t.mock.method(crypto, "createHash", crypto.createHash);
  for (let i = 0; i < 5; i++) await f.controller.verifyTeachingSource(f.root);
  assert.equal(hashing.mock.callCount(), process.platform === "linux" ? 1 : 5);
});

test("source verification invalidates cached bytes after same-size edits even with restored mtime", async (t) => {
  const f = await fixture(t);
  await f.controller.verifyTeachingSource(f.root);
  const before = await fs.stat(f.source);
  const changed = Buffer.from(fixtureBytes);
  changed[changed.length - 1] ^= 1;
  await fs.writeFile(f.source, changed);
  await fs.utimes(f.source, before.atime, before.mtime);
  await assert.rejects(f.controller.verifyTeachingSource(f.root), /changed outside/);
});

test("source verification rehashes replacement files and rejects changes during a cached read", async (t) => {
  const f = await fixture(t);
  const crypto = require("node:crypto");
  const hashing = t.mock.method(crypto, "createHash", crypto.createHash);
  await f.controller.verifyTeachingSource(f.root);
  const replacement = join(f.root, "replacement.pptx");
  await fs.writeFile(replacement, fixtureBytes);
  await fs.rename(replacement, f.source);
  await f.controller.verifyTeachingSource(f.root);
  assert.equal(hashing.mock.callCount(), 2, "a new inode cannot reuse the old digest");
  const open = fs.open;
  t.mock.method(fs, "open", async (...args) => {
    const handle = await open(...args);
    const stat = handle.stat.bind(handle);
    let reads = 0;
    t.mock.method(handle, "stat", async (...options) => {
      if (++reads === 2) await fs.writeFile(f.source, Buffer.concat([fixtureBytes, Buffer.from("external")]));
      return stat(...options);
    });
    return handle;
  });
  await assert.rejects(f.controller.verifyTeachingSource(f.root), /changed outside/);
});

test("a cached digest never bypasses native dirty-state checks", async (t) => {
  const f = await fixture(t);
  await f.controller.verifyTeachingSource(f.root);
  const checking = f.controller.verifyTeachingSource(f.root);
  f.dirty();
  await assert.rejects(checking, /Save or reopen/);
});

test("teaching verifies actual live source bytes and workspace before trusting an archived revision", async (t) => {
  const f = await fixture(t);
  await f.controller.verifyTeachingSource(f.root);
  await fs.writeFile(f.source, Buffer.concat([fixtureBytes, Buffer.from("external change")]));
  await assert.rejects(f.controller.verifyTeachingSource(f.root), /changed outside/);
  await fs.writeFile(f.source, fixtureBytes);
  await f.controller.verifyTeachingSource(f.root);
  const outside = await fs.mkdtemp(join(tmpdir(), "ppt-source-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const other = join(outside, "other.pptx");
  await fs.writeFile(other, fixtureBytes);
  await fs.unlink(f.source); await fs.symlink(other, f.source);
  await assert.rejects(f.controller.verifyTeachingSource(f.root), /outside the current workspace/);
});


test("source verification cannot authorize teaching after native state changes during file I/O", async (t) => {
  const f = await fixture(t);
  const checking = f.controller.verifyTeachingSource(f.root);
  f.dirty();
  await assert.rejects(checking, /Save or reopen/);
});

test("native fade ordinary execution refuses even a valid finite command", async t => {
  const f=await fixture(t),snapshot=f.controller.teachingSnapshot(f.root);
  await assert.rejects(f.controller.execute({projectId:snapshot.projectId,documentId:snapshot.documentId,sessionId:snapshot.sessionId,requestId:"fade",editGeneration:1,tool:"set_slide_fade",input:{}},f.root),/retained Main inspection/);
  assert.equal(f.commands.filter(c=>c.type==="document:execute-fade").length,0);
});

test("native fade uses dedicated transport, consumes request and verifies correlated receipt", async t => {
  const f=await fixture(t),snapshot=f.controller.teachingSnapshot(f.root);
  const command={projectId:snapshot.projectId,documentId:snapshot.documentId,sessionId:snapshot.sessionId,requestId:"fade",editGeneration:1,tool:"set_slide_fade",input:{}};
  const authorization={editGeneration:1,page:1,sourceHash:`sha256:${snapshot.sha256}`,slideHash:"sha256:"+"a".repeat(64)};
  let check=0;
  f.controller.bridgeRequest=async(type,response,payload,id)=>{
    assert.equal(type,"document:execute-fade");assert.equal(response,"document:command-result");assert.equal(id,"fade");assert.deepEqual(payload,{command,authorization});
    return {...command,status:"verified",result:{page:1,transition:"fade",durationMs:750,verified:true,saved:false}};
  };
  const result=await f.controller.executeFade(command,authorization,f.root,async()=>{check++;},()=>true);
  assert.equal(result.result.saved,false);assert.equal(check,1);
  await assert.rejects(f.controller.executeFade(command,authorization,f.root,async()=>{},()=>true),/consumed/);
});

test("canvas image target approval uses distinct transport and execution retains its exact command", async t => {
  const f = await fixture(t), snapshot = f.controller.teachingSnapshot(f.root);
  const binding = { projectId: snapshot.projectId, documentId: snapshot.documentId, sessionId: snapshot.sessionId };
  const asset = { assetId: "canvas-reviewed", sha256: "a".repeat(64), mime: "image/png", byteLength: 68, width: 1, height: 1 };
  const target = { page: 1, editGeneration: 1, operation: "replace" };
  const context = { ...binding, editGeneration: 2, kind: "slide", page: 1, selectedText: "", selectionCharacters: 0, readOnly: false,
    capabilities: [{ name: "replace_slide_image_from_asset", description: "Reviewed image", readOnly: false,
      inputSchema: { type: "object", properties: { assetId: { type: "string", enum: [asset.assetId] } }, required: ["assetId"], additionalProperties: false } }] };
  f.controller.bridgeRequest = async (type, responseType, payload) => {
    assert.equal(type, "document:review-image-target"); assert.equal(responseType, "document:image-target-reviewed");
    assert.deepEqual(payload, { binding, asset, target }); return structuredClone(context);
  };
  assert.deepEqual(await f.controller.reviewImageTarget(asset, target, f.root), context);
  const command = { ...binding, requestId: "canvas-image", editGeneration: 2, tool: "replace_slide_image_from_asset", input: { assetId: asset.assetId } };
  let checked = 0;
  f.controller.imageAssets = { async metadata() { return asset; }, async load(assetId, workspace, received) {
    assert.equal(assetId, asset.assetId); assert.equal(workspace, f.root); assert.equal(received, command);
    return { asset, bytes: Buffer.alloc(68), assertCurrent() { checked++; } };
  } };
  f.controller.bridgeRequest = async (type, responseType, payload, requestId) => {
    assert.equal(type, "document:execute-image"); assert.equal(responseType, "document:command-result"); assert.equal(requestId, command.requestId);
    assert.equal(payload.command, command); assert(payload.bytes instanceof Uint8Array);
    return { ...command, status: "verified", result: { assetId: asset.assetId, sha256: asset.sha256, page: 1, verified: true } };
  };
  await f.controller.execute(command, f.root);
  assert.equal(checked, 1);
  assert.equal(f.states.at(-1).revision, 1, "approval and command dispatch never save automatically");
});

test("canvas target review rejects foreign/read-only/page replies and never refreshes stale metadata", async t => {
  for (const change of ["page", "binding", "readOnly", "dirty"]) {
    const f = await fixture(t), snapshot = f.controller.teachingSnapshot(f.root);
    const asset = { assetId: "canvas-reviewed", sha256: "a".repeat(64), mime: "image/png", byteLength: 68, width: 1, height: 1 };
    f.controller.bridgeRequest = async () => {
      if (change === "dirty") f.dirty();
      return { ...snapshot, sessionId: change === "binding" ? "foreign" : snapshot.sessionId,
        editGeneration: 2, kind: "slide", page: change === "page" ? 2 : 1,
        selectedText: "", selectionCharacters: 0, readOnly: change === "readOnly", capabilities: [] };
    };
    await assert.rejects(f.controller.reviewImageTarget(asset, { page: 1, editGeneration: 1, operation: "replace" }, f.root));
    assert.equal(f.controller.imageMetadata, "null", change);
  }
});

for(const change of ["dirty","cancelled","source","proof","receipt"])
  test(`native fade refuses ${change} at the controller boundary`,async t=>{
    const f=await fixture(t),snapshot=f.controller.teachingSnapshot(f.root);
    const command={projectId:snapshot.projectId,documentId:snapshot.documentId,sessionId:snapshot.sessionId,requestId:"fade",editGeneration:1,tool:"set_slide_fade",input:{}};
    const proof={editGeneration:1,page:1,sourceHash:`sha256:${snapshot.sha256}`,slideHash:"sha256:"+"a".repeat(64)};
    if(change==="dirty")f.dirty();
    if(change==="source")await fs.writeFile(f.source,Buffer.from("externally changed source"));
    if(change==="proof")proof.sourceHash="sha256:"+"b".repeat(64);
    let sent=0;f.controller.bridgeRequest=async()=>{sent++;return {...command,requestId:"foreign",status:"verified",result:{page:1,transition:"fade",durationMs:750,verified:true,saved:false}};};
    await assert.rejects(f.controller.executeFade(command,proof,f.root,async()=>{},()=>change!=="cancelled"));
    assert.equal(sent,change==="receipt"?1:0);
  });


test("native teaching acknowledges only its own view and drops duplicate and late replies", async t => {
  let calls = 0, finish;
  const f = await fixture(t, { nativeTeaching: async () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  assert.equal(f.commands.at(-1).type, "document:teaching-enable");
  const ready = { type: "message", message: { type: "document:teaching-ready" } };
  f.reply(ready, 999); assert.equal(f.states.at(-1).nativeTeaching, false);
  f.reply(ready); assert.equal(f.states.at(-1).nativeTeaching, true);
  const request = { type: "message", message: { type: "document:teaching-request", id: "native-request", payload: { operation: "open" } } };
  f.reply(request, 999); assert.equal(calls, 0);
  f.reply(request); f.reply(request); assert.equal(calls, 1);
  f.controller.close(); finish({ viewId: "old" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.commands.some(command => command.type === "document:teaching-response"), false);
});

test("native PPT save prepares teaching bindings before replacing source and commits them before acknowledging", async t => {
  const f = await fixture(t);
  const edited = Buffer.concat([fixtureBytes, Buffer.from("changed")]);
  const order = [];
  f.controller.nativeSave = async input => {
    order.push("prepare");
    assert.deepEqual(await fs.readFile(f.source), fixtureBytes);
    assert.match(input.sourceSha256, /^[a-f0-9]{64}$/);
    return {
      async commit() { order.push("commit"); assert.deepEqual(await fs.readFile(f.source), edited); },
      async cancel() { order.push("cancel"); },
    };
  };
  const save = f.start();
  const result = await f.exported(save, edited);
  assert.equal(result.payload.success, true);
  assert.deepEqual(order, ["prepare", "commit"]);
});

test("workspace progress reuses a validated native teaching response for the saved source", async t => {
  let response;
  const f = await fixture(t, { nativeTeaching: async () => response });
  f.reply({ type: "message", message: { type: "document:teaching-ready" } });
  const project = JSON.parse(readFileSync(new URL("../../../packages/shared/src/courseware-contract.fixtures/accepted.json", import.meta.url), "utf8")).project;
  project.source.sha256 = f.states.at(-1).sha256;
  project.pages[0].actions[0].audioAssetId = "audio-1";
  response = { project };
  assert(shared.isCoursewareProject(project));
  f.reply({ type: "message", message: { type: "document:teaching-request", id: "progress", payload: { operation: "open" } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.states.at(-1).teachingProgress, { total: 2, audio: 1, ready: 1 });
  const previousCount = f.states.length;
  response = { project: { ...project, source: { ...project.source, sha256: "f".repeat(64) } } };
  f.reply({ type: "message", message: { type: "document:teaching-request", id: "foreign-source", payload: { operation: "open" } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.states.length, previousCount, "Foreign source must not publish progress");
  f.dirty(); assert.equal(f.states.at(-1).teachingProgress, undefined);
  f.controller.close(); assert.equal(f.states.at(-1).teachingProgress, undefined);
});

test("late native progress cannot replace a newer response", async t => {
  const pending = [];
  const f = await fixture(t, { nativeTeaching: () => new Promise(resolve => pending.push(resolve)) });
  f.reply({ type: "message", message: { type: "document:teaching-ready" } });
  const project = JSON.parse(readFileSync(new URL("../../../packages/shared/src/courseware-contract.fixtures/accepted.json", import.meta.url), "utf8")).project;
  project.source.sha256 = f.states.at(-1).sha256;
  for (const id of ["older", "newer"]) f.reply({ type: "message", message: { type: "document:teaching-request", id, payload: { operation: "open" } } });
  const newer = structuredClone(project); newer.pages[0].actions[0].audioAssetId = "audio-1";
  pending[1]({ project: newer }); await new Promise(resolve => setImmediate(resolve));
  pending[0]({ project }); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.states.at(-1).teachingProgress, { total: 2, audio: 1, ready: 1 });
});


test("live Quiz edit keeps the editor open and retains its canonical draft across a failed save retry", async t => {
  const f = await fixture(t);
  const snapshot = f.controller.teachingSnapshot(f.root);
  const binding = {projectId:snapshot.projectId,documentId:snapshot.documentId,sessionId:snapshot.sessionId};
  const draft = {expectedRevision:'classroom-r1',classroom:{id:'course'}};
  const received=[];
  f.controller.nativeSave = async input => {
    received.push(input.classroomSave);
    if(received.length===1) throw Error('Host unavailable before source replacement');
    return {commit:async()=>{},cancel:async()=>{}};
  };
  f.sent.on('document:apply-quiz-page',command=>queueMicrotask(()=>f.reply({type:'message',message:{type:'document:command-result',
    id:command.id,payload:{...binding,page:1,editGeneration:1,applied:true}}})));
  const saving = new Promise(resolve=>f.sent.once('document:save',resolve));
  const applying = f.controller.applyClassroomPage(f.root,snapshot,{binding,page:1,editGeneration:1},draft);
  const failed = assert.rejects(applying,/Host unavailable/);
  const first = await saving;
  assert.throws(()=>f.controller.close(),/Finish the current save/);
  assert.equal((await f.exported(first)).payload.success,false);
  f.ack(first,true,false); await failed;
  const retry=f.start(); assert.equal((await f.exported(retry)).payload.success,true); f.ack(retry,false);
  assert.deepEqual(received,[draft,draft]);
  assert.equal(f.commands.filter(c=>c.type==='document:open-buffer').length,1,'saving Quiz must not reopen the document');
  assert(!f.states.some(s=>s.status==='closed'));
  const ordinary=f.start();await f.exported(ordinary);f.ack(ordinary,false);
  assert.equal(received[2],undefined,'canonical draft cannot leak to later ordinary saves');
});
