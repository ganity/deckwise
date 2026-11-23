#!/usr/bin/env node
/** Real native IPC/edit/export/reopen coverage; only Host storage and paid services are controlled. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, writeFile, copyFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";

assert(process.env.DECKWISE_E2E_NATIVE_PPTX, "Set DECKWISE_E2E_NATIVE_PPTX to a disposable native-teaching PPTX fixture");
const root = repositoryRoot(), desktop = join(root, "apps/desktop");
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const temp = await mkdtemp(join(tmpdir(), "deckwise-background-editing-"));
const workspace = join(temp, "workspace");
const output = process.env.DECKWISE_E2E_OUTPUT;
if (output) await mkdir(output);
await mkdir(workspace);
const fixtures = { a: process.env.DECKWISE_E2E_NATIVE_PPTX, b: process.env.DECKWISE_E2E_SCENE_PPTX || process.env.DECKWISE_E2E_NATIVE_PPTX,
  c: process.env.DECKWISE_E2E_IMPORT_PPTX || process.env.DECKWISE_E2E_NATIVE_PPTX };
const originals = new Map();
for (const [id, file] of Object.entries(fixtures)) {
  originals.set(file, await readFile(file));
  await copyFile(file, join(workspace, id + ".pptx"));
}
let passed = false;
let log = "";
try {
  await writeFile(join(temp, "entry.ts"), `
import { app, BrowserWindow, ipcMain } from "electron";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { registerPptEditorIpc } from ${JSON.stringify(join(desktop, "electron/main/ipc/ppt-editor-ipc.ts"))};
import { registerEditorHostScheme } from ${JSON.stringify(join(desktop, "electron/main/editor-host-protocol.ts"))};
import { readNativeTeachingPackage } from ${JSON.stringify(join(desktop, "electron/main/courseware-native-package.ts"))};
import { IPC } from "@pi-desktop/shared";
registerEditorHostScheme();
app.setPath("userData", ${JSON.stringify(join(temp, "profile"))});
app.setAppPath(${JSON.stringify(desktop)});
app.whenReady().then(async () => {
  const workspace = ${JSON.stringify(workspace)}, report = [];
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  let viewing = "a", tools;
  const handlers = new Map(), states = [], requests = [];
  const suppliedScripts = new Map();
  const host = { async call(method, args) {
    requests.push(method);
    if (method === "session.get") return { session: { projectPath: workspace, mode: "agent" } };
    if (method === "courseware.task.get") return { task: { taskType: args.sessionId === "a" ? "plain" : args.sessionId === "b" ? "scene" : "import",
      ...(args.sessionId === "c" ? { importPath: "c.pptx" } : { generatedPath: args.sessionId + ".pptx" }) } };
    if (method === "courseware.nativeRepairs.read") return { revision: 0, failures: {} };
    if (method === "courseware.nativeSave.forPath") return { save: null };
    if (method === "courseware.sourceAdoption.forPath") return { adoption: null };
    if (method === "courseware.material.list") return { sources: [] };
    if (method === "courseware.material.verifyInline") return { supplied: suppliedScripts.get(args.sessionId) === args.text };
    if (method === "courseware.material.record") return { sourceId: createHash("sha256").update(args.text).digest("hex") };
    if (method === "courseware.project.context") return { teachingRequirements: [] };
    throw Error("Unexpected Host call: " + method);
  } };
  const forbidden = () => { throw Error("Paid/model calls are forbidden in this test"); };
  registerPptEditorIpc({ registrar: { ipcMain, handleWithEvent(channel, handler) { handlers.set(channel, handler); },
      assertMainWindowSender(event) { assert.equal(event.sender, window.webContents); } },
    getMainWindow: () => window, getHost: () => host, getWorkspaceRoot: async () => workspace,
    getViewingSessionId: () => viewing, getExtraRoots: async () => [], sendToRenderer(_channel, state) { states.push(state); },
    onChatBridgeReady() {}, onNativeTeachingReady(value) { tools = value; }, activeTurns: new Map(),
    completeNarration: forbidden, completeScene: forbidden, authSession: new Proxy({}, { get: () => forbidden }) });
  const invoke = (name, ...args) => handlers.get(IPC.invoke[name])({ sender: window.webContents }, ...args);
  const read = async id => { const value = await readNativeTeachingPackage(await readFile(join(workspace, id + ".pptx"))); assert(value); return value; };
  const hash = async id => createHash("sha256").update(await readFile(join(workspace, id + ".pptx"))).digest("hex");
  const pageIds = new Map();
  const snapshots = new Map();
  const adopt = async (id, text) => {
    suppliedScripts.set(id, "第1页\\n" + text);
    const context = await tools.execute(id, "courseware_narration_context", {}, () => true);
    pageIds.set(id, context.value.pages.map(page => page.pageId));
    snapshots.set(id, await read(id));
    await assert.rejects(tools.execute(id, "courseware_narration_import", {
      sourceSha256: context.value.sourceSha256, apply: true, script: { text: "Agent-authored lesson draft", policy: "preserve" }
    }, () => true), /quote text supplied by the user/);
    assert.deepEqual(await read(id), snapshots.get(id));
    return tools.execute(id, "courseware_narration_import", {
      sourceSha256: context.value.sourceSha256, apply: true, script: { text: "第1页\\n" + text, policy: "preserve" } }, () => true);
  };
  try {
    console.log("START foreground open");
    await invoke("pptEditorConfigureUi", { teachingOpen: false });
    await invoke("pptEditorSetBounds", { x: 0, y: 0, width: 1280, height: 720 });
    await invoke("pptEditorSetVisible", { visible: true });
    await invoke("pptEditorOpen", { path: "a.pptx" });
    console.log("START foreground edit after Chat switch");
    viewing = "unrelated-chat";
    await invoke("pptEditorSetVisible", { visible: false });
    const live = await adopt("a", "Foreground document remains bound after switching Chat.");
    assert.equal(live.value.saved, true);
    assert.equal(states.filter(s => s.status === "opening").length, 1);
    report.push("open target edits and saves through its existing editor after Chat switch");
    const aHash = await hash("a");
    console.log("START background scene/import edits");
    const b = adopt("b", "Background scene narration.");
    const c = adopt("c", "Background import narration.");
    assert.equal((await b).value.saved, true); assert.equal((await c).value.saved, true);
    assert.equal(await hash("a"), aHash);
    assert.equal(states.filter(s => s.status === "opening").length, 1);
    report.push("closed scene/import targets edit in the hidden engine without replacing foreground");
    for (const [id, text] of [["b", "Background scene narration."], ["c", "Background import narration."]]) {
      const saved = await read(id);
      assert.deepEqual(saved.pages.map(page => page.pageId), pageIds.get(id));
      assert.deepEqual(saved.pages.slice(1).map(page => page.actions), snapshots.get(id).pages.slice(1).map(page => page.actions));
      assert.deepEqual(saved.pages[0].actions.filter(action => action.type !== "speech"), snapshots.get(id).pages[0].actions.filter(action => action.type !== "speech"));
      assert(saved.pages[0].actions.some(action => action.type === "speech" && action.text === text));
    }
    viewing = "b";
    await invoke("pptEditorOpen", { path: "b.pptx" });
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    const reopened = await invoke("pptEditorTeachingOpen", { sessionId: "b" });
    assert(reopened.project.pages[0].actions.some(action => action.text === "Background scene narration."));
    assert.equal((await adopt("b", "Foreground handoff retains the saved background document.")).value.saved, true);
    report.push("opening hands off the latest saved native document and subsequent edits use the live editor");
    await invoke("pptEditorClose");
    viewing = "unrelated-chat";
    assert.equal((await adopt("b", "Closed again; background editing still works.")).value.saved, true);
    assert.equal((await read("b")).pages.length, snapshots.get("b").pages.length);
    await invoke("pptEditorClose");
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    assert(!requests.some(method => /Submit|quote|generate/i.test(method)));
    report.push("close/reopen preserves mutations, page identities and causes no paid submissions");
    await writeFile(${JSON.stringify(join(temp, "report.json"))}, JSON.stringify({ passed: true, checks: report }, null, 2));
    for (const check of report) console.log("PASS " + check);
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
}).catch(error => { console.error(error); app.exit(1); });
`);
  const plugin = { name: "workspace-runtime", setup(build) {
    build.onResolve({ filter: /^@pi-desktop\/courseware-runtime\/node$/ }, () => ({ path: join(root, "packages/courseware-runtime/dist/node.mjs"), external: true }));
    build.onResolve({ filter: /^@pi-desktop\/shared$/ }, () => ({ path: join(root, "packages/shared/dist/index.js") }));
  } };
  await build({ entryPoints: [join(temp, "entry.ts")], outfile: join(temp, "main/index.cjs"), bundle: true, platform: "node", format: "cjs", external: ["electron"],
    nodePaths: [join(desktop, "node_modules"), join(root, "packages/agent-runtime/node_modules")], plugins: [plugin], logLevel: "warning" });
  await build({ entryPoints: [join(desktop, "electron/preload/editor-host.ts")], outfile: join(temp, "preload/editor-host.js"), bundle: true, platform: "node", format: "cjs", external: ["electron"] });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/api.?key|secret|token|password|proxy|ELECTRON_RUN_AS_NODE|DECKWISE_EDITOR_URL/i.test(key)));
  const child = spawn(resolveElectronBinary(root).electronBinary, ["--no-sandbox", join(temp, "main/index.cjs")], { cwd: desktop, env, stdio: ["ignore", "pipe", "pipe"] });
  const timer = setTimeout(() => child.kill("SIGKILL"), 240_000);
  child.stdout.on("data", bytes => { log += bytes; process.stdout.write(bytes); });
  child.stderr.on("data", bytes => { log += bytes; process.stderr.write(bytes); });
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); }).finally(() => clearTimeout(timer));
  assert.equal(code, 0, "Native editor regression failed; evidence: " + temp);
  for (const [file, before] of originals) assert.deepEqual(await readFile(file), before, "Input fixture must remain unchanged: " + file);
  if (output) await copyFile(join(temp, "report.json"), join(output, "report.json"));
  passed = true;
} finally {
  if (output) await writeFile(join(output, "electron.log"), log);
  if (passed) await rm(temp, { recursive: true, force: true });
  else console.error("Retained failure evidence:", temp);
}
