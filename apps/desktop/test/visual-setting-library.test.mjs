import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { IPC } from "@pi-desktop/shared";

const source = await readFile(new URL("../electron/main/ipc/visual-settings-ipc.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const base = { sessionId: "my-chat", libraryId: 1, revision: 4, itemId: 3, imageId: 7 };
function fixture() {
  let revision = 4;
  const calls = [], handlers = new Map(), saved = [];
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  const rows = [{ id: 3, type: "OBJECT", name: "Lamp", description: "Blue", images: [{ id: 7, name: "Front", fileUrl: "https://images.example.org/img" }] }];
  const dependencies = { "@pi-desktop/shared": { IPC }, electron: { net: { fetch: async (url, init) => {
    calls.push({ url, init }); return new Response(png);
  } } }, "../public-https-fetch": { createPublicHttpsClient: () => ({ assertPublicUrl: async () => {} }) },
    "../composer-paste": { saveComposerPasteFiles: async (dir, owner, files) => { saved.push({ dir, owner, files }); return files; } } };
  const exports = {};
  new Function("require", "exports", code)(id => dependencies[id], exports);
  const host = { call: async () => ({ session: { id: base.sessionId } }) };
  exports.registerVisualSettings({ handleWithEvent: (name, fn) => handlers.set(name, fn),
    assertMainWindowSender: event => assert.equal(event, "main") }, {
    visualSettings: async id => id === undefined ? [{ id: 1, name: "World", revision }] : rows,
    getCoursewarePrincipal: () => ({ assertCurrent() {} }),
  }, "/fixture", () => host);
  return { call: (name, value) => handlers.get(name)("main", value), saved, calls, png, revise: () => revision++ };
}
test("library selection archives the exact versioned image in the originating chat without forwarding credentials", async () => {
  const f = fixture();
  assert.equal((await f.call(IPC.invoke.visualSettingLibrary))[0].revision, 4);
  assert.equal((await f.call(IPC.invoke.visualSettingImages, 1))[0].images[0].id, 7);
  await f.call(IPC.invoke.visualSettingAttach, base);
  assert.equal(f.saved[0].owner, base.sessionId);
  assert.match(f.saved[0].files[0].name, /setting_1_v4_3_7_Lamp/);
  assert.deepEqual(Buffer.from(f.saved[0].files[0].data), f.png);
  assert.equal(f.calls[0].init.credentials, "omit");
});
test("stale catalog and foreign image IDs fail before a picture is fetched", async () => {
  const f = fixture();
  await assert.rejects(f.call(IPC.invoke.visualSettingAttach, { ...base, imageId: 99 }), /no longer/);
  f.revise();
  await assert.rejects(f.call(IPC.invoke.visualSettingAttach, base), /library changed/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.saved.length, 0);
});
