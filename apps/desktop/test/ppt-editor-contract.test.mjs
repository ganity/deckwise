import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const files = await read("../electron/main/ppt-editor-files.ts");
const [controller, host, component, protocol, vite, packageJson, hostProtocol] = await Promise.all([
  read("../electron/main/ppt-editor.ts"),
  read("../resources/editor-host/index.html"),
  read("../src/components/workpanel/PptEditorTab.tsx"),
  read("../../../packages/shared/src/protocol.ts"),
  read("../electron.vite.config.ts"),
  read("../package.json").then(JSON.parse),
  read("../electron/main/editor-host-protocol.ts"),
]);
const editorPreload = await read("../electron/preload/editor-host.ts");
const stageScript = await read("../../../scripts/stage-wiseoffice.mjs");

test("a refused close preserves the conversation binding and review state", async () => {
  const ipc = await read("../electron/main/ipc/ppt-editor-ipc.ts");
  const start = ipc.indexOf("registrar.handleWithEvent(IPC.invoke.pptEditorClose,");
  const end = ipc.indexOf("\n  });", start) + "\n  });".length;
  for (const saving of [true, false]) {
    const calls = [];
    let close;
    const clear = name => ({ clear() { calls.push(name); } });
    new Function("registrar", "IPC", "assertSender", "adoption", "input", "chat", "images", "visuals", "style", "candidatePreview", "editor", ipc.slice(start, end))(
      { handleWithEvent(_channel, handler) { close = handler; } }, { invoke: { pptEditorClose: "close" } }, () => {},
      { assertIdle() {} }, { onDeactivate() { calls.push("deactivate"); } }, clear("chat"), clear("images"), clear("visuals"), clear("style"),
      { close() { calls.push("preview"); } }, { close() { if (saving) throw Error("Finish the current save"); calls.push("editor"); } },
    );
    if (saving) {
      await assert.rejects(close({}), /Finish the current save/);
      assert.deepEqual(calls, []);
    } else {
      await close({});
      assert.deepEqual(calls, ["editor", "deactivate", "chat", "images", "visuals", "style", "preview"]);
    }
  }
});

test("PPTX editor is embedded and all normal escape routes are denied", () => {
  assert.match(controller, /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/);
  assert.match(controller, /will-download/);
  assert.match(controller, /setPermissionRequestHandler/);
  assert.match(controller, /will-navigate/);
  assert.match(controller, /installEditorHostProtocol\(editorSession\.protocol\)/);
  assert.match(component, /pptEditorSetBounds/);
  assert.match(component, /pptEditorSetVisible/);
  assert.doesNotMatch(component, /edit\.chaxus\.com/);
});

test("editor host accepts messages only from the configured top-level editor frame", () => {
  assert.match(host, /event\.origin !== expectedOrigin/);
  assert.match(host, /event\.source !== editor\.contentWindow/);
  assert.doesNotMatch(host, /targetExt !== "PPTX"/);
  assert.match(host, /deckwise=1/);
  assert.match(host, /document:save-requested/);
  assert.match(host, /document:saved/);
  assert.match(controller, /message\.type === "save-requested"/);
  assert.match(controller, /this\.save\(\)/);
});

test("iframe load cannot mark the editor ready and startup failures offer retry", () => {
  assert.doesNotMatch(host, /addEventListener\("load",\s*flush\)/);
  assert.match(host, /message\.type === "document:ready"\) flush\(\)/);
  assert.match(controller, /await openPptEditorDocument\(/);
  assert.match(controller, /this\.ready &&/);
  assert.match(controller, /visible && this\.ready/);
  assert.match(controller, /canRetry: true/);
  assert.match(component, /state\.canRetry/);
  assert.match(component, /panel\.pptEditor\.loading/);
  assert.match(component, /panel\.pptEditor\.retry/);
});

test("editor host protocol delegates HTML loading to Electron's network stack", () => {
  assert.match(hostProtocol, /net\.fetch\(/);
  assert.match(hostProtocol, /pathToFileURL/);
  assert.doesNotMatch(hostProtocol, /new Response\(new Uint8Array\(html\)/);
});

test("editor archives revisions and replaces the original PPTX with stale-write protection", () => {
  assert.match(files, /Revision conflict: expected/);
  assert.match(controller, /expectedRevision: current\.revision\.revision/);
  assert.match(controller, /\.deckwise-ppt\/revisions/);
  assert.match(controller, /sha256/);
  assert.match(controller, /replaceSourceFile/);
  assert.match(controller, /current\.sourcePath/);
  assert.match(files, /fs\.rename\(temporaryPath, sourcePath\)/);
});

test("editor preload and host page are both shipped", () => {
  assert.match(vite, /"editor-host".*electron\/preload\/editor-host\.ts/s);
  assert.match(protocol, /pptEditorOpen/);
  assert.match(protocol, /pptEditorState/);
  assert.ok(
    packageJson.build.extraResources.some(
      (entry) => entry.from === "resources/editor-host" && entry.to === "editor-host",
    ),
  );
});

test("bundled Office boots the isolated React module directly and retains its narrow preload", () => {
  assert.match(controller, /deckwise-editor:\/\/wiseoffice\/module\.html/);
  assert.match(controller, /nodeIntegrationInSubFrames: false/);
  assert.match(controller, /senderFrame !== viewContents\.mainFrame/);
  assert.match(editorPreload, /if \(!process\.isMainFrame\)/);
  assert.match(stageScript, /module\.html/);
  assert.match(protocol, /pptEditorConfigureUi/);
  assert.match(component, /pptEditorConfigureUi/);
  assert.match(component, /panel\.pptEditor\.focus/);
  assert.match(component, /panel\.pptEditor\.inspection/);
  assert.match(component, /state\.teachingOpen/);
});

test('native auto-open waits for the entire explicit open request including source recovery', async () => {
  const ipc = await read('../electron/main/ipc/ppt-editor-ipc.ts');
  const ensure = ipc.slice(ipc.indexOf('input.onNativeTeachingReady?.('), ipc.indexOf('}, async (sessionId, canDispatch) => {', ipc.indexOf('input.onNativeTeachingReady?.(')));
  assert(ensure.indexOf('await openingRequest') < ensure.indexOf('await editor.waitForOpen'));
  const opening = ipc.slice(ipc.indexOf('IPC.invoke.pptEditorOpen,'), ipc.indexOf('registrar.handleWithEvent(IPC.invoke.pptEditorSave'));
  const calls = []; let finishRecovery;
  const recovery = new Promise(resolve => { finishRecovery = resolve; });
  // Exercise the production request fence with recovery still pending.
  const snippet = opening.slice(opening.indexOf('      const pending'), opening.indexOf('\n    },'));
  const run = new Function('editor','nativeSave','adoption','getWorkspaceRoot','getMainWindow','getExtraRoots','input','chat','images','visuals','style','candidatePreview',
    `let openingRequest,calls;return {run:async()=>{const payload={path:'lesson.pptx'};${snippet}},wait:async()=>{await openingRequest;calls.push('read')},setCalls(v){calls=v}};`);
  const noop = {clear(){},setOwner(){}};
  const fence = run({open:async()=>{calls.push('open');return{}}},{recover:async()=>{await recovery}}, {assertIdle(){},beforeOpen:async()=>{}},async()=>'/workspace',()=>({}),async()=>[],{getViewingSessionId:()=> 'chat'},noop,noop,noop,noop,{close(){}});
  fence.setCalls(calls);
  const opened=fence.run(); await new Promise(resolve=>setImmediate(resolve));
  const reading=fence.wait(); await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(calls,[]);
  finishRecovery();await opened;await reading;assert.deepEqual(calls,['open','read']);
});
