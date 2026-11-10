import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import { openCoursewareBuildFiles } from "../electron/main/courseware-build-files.ts";

const source = await readFile(new URL("../electron/main/courseware-player-preview.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
class Window extends EventEmitter {
  static windows = [];
  destroyed = false;
  webContents = Object.assign(new EventEmitter(), { mainFrame: { url: "" },
    setWindowOpenHandler() {}, session: { setPermissionRequestHandler() {}, webRequest: { onBeforeRequest() {} } } });
  constructor(options) { super(); this.options = options; Window.windows.push(this); }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; this.emit("closed"); }
  async loadURL(url) { this.url = url; this.webContents.mainFrame.url = url; }
  show() {}
}

test("preview admits only its own top frame, finite reads and a still-selected build", async () => {
  const temp = await mkdtemp(join(tmpdir(), "courseware-preview-"));
  try {
    const audio = Buffer.from("fixture-only");
    const hash = createHash("sha256").update(audio).digest("hex");
    await mkdir(join(temp, "assets"));
    await writeFile(join(temp, `assets/${hash}.wav`), audio);
    const bytes = Buffer.from(JSON.stringify({ assets: [{ id: "voice", path: `assets/${hash}.wav`, sha256: hash }] }));
    const buildId = createHash("sha256").update(bytes).digest("hex");
    await writeFile(join(temp, "package.json"), bytes);
    const parent = new Window({});
    const handlers = new Map();
    const module = { exports: {} };
    new Function("require", "exports", "__dirname", outputText)((id) => {
      if (id === "electron") return { BrowserWindow: Window };
      if (id === "node:path") return { join };
      if (id === "node:url") return { pathToFileURL: (path) => new URL("file://" + path) };
      if (id === "./courseware-build-files") return { openCoursewareBuildFiles };
      throw new Error(id);
    }, module.exports, "/fixture/main");
    let selected = async (id) => {
      assert.equal(id, "ready"); return { build: { directory: temp, buildId } };
    };
    const preview = new module.exports.CoursewarePlayerPreview({ handle: (channel, handler) => handlers.set(channel, handler) }, () => parent,
      { selected: (id) => selected(id) });
    const read = handlers.get(module.exports.COURSEWARE_PLAYER_READ);
    await assert.rejects(preview.open("ready", "forged"), /Invalid/);
    await preview.open("ready", "en");
    const child = Window.windows.at(-1);
    assert.equal(child.options.webPreferences.sandbox, true);
    assert.equal(child.options.webPreferences.autoplayPolicy, "document-user-activation-required");
    const event = { sender: child.webContents, senderFrame: child.webContents.mainFrame };
    await assert.rejects(read({ ...event, sender: parent.webContents }, { kind: "package" }), /sender denied/);
    await assert.rejects(read({ ...event, senderFrame: { url: event.senderFrame.url } }, { kind: "package" }), /sender denied/);
    const url = event.senderFrame.url; event.senderFrame.url = "file:///forged";
    await assert.rejects(read(event, { kind: "package" }), /sender denied/); event.senderFrame.url = url;
    for (const payload of [{ kind: "package", path: "/etc/passwd" }, { kind: "asset" }, { kind: "other" }, []])
      await assert.rejects(read(event, payload), /Invalid/);
    await assert.rejects(read(event, { kind: "package" }, "extra"), /Invalid/);
    const pkg = await read(event, { kind: "package" });
    assert.equal(pkg.buildId, buildId); assert.deepEqual(Buffer.from(pkg.bytes), bytes);
    pkg.bytes[0] = 0;
    assert.deepEqual(Buffer.from((await read(event, { kind: "package" })).bytes), bytes);
    assert.deepEqual(Buffer.from(await read(event, { kind: "asset", id: "voice" })), audio);
    await assert.rejects(read(event, { kind: "asset", id: "../../etc/passwd" }), /not in the selected/);
    let finish;
    selected = () => new Promise((resolve) => { finish = resolve; });
    const pending = read(event, { kind: "package" });
    await assert.rejects(read(event, { kind: "package" }), /already running/);
    selected = async () => ({ build: { directory: temp, buildId } });
    preview.close(); finish({});
    await assert.rejects(pending, /preview changed/);
    assert.equal(child.isDestroyed(), true);
    await assert.rejects(read(event, { kind: "package" }), /sender denied/);
    await preview.open("ready", "zh-CN");
    const replacement = Window.windows.at(-1);
    parent.webContents.emit("did-start-navigation");
    assert.equal(replacement.isDestroyed(), true);
    assert.equal(parent.webContents.listenerCount("did-start-navigation"), 0);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
test("canonical preview serves selected classroom and finite resources with revision checks", async () => {
  const parent = new Window({}), handlers = new Map(), module = { exports: {} };
  new Function("require", "exports", "__dirname", outputText)(id => {
    if (id === "electron") return { BrowserWindow: Window };
    if (id === "node:path") return { join };
    if (id === "node:url") return { pathToFileURL: path => new URL("file://" + path) };
    if (id === "./courseware-build-files") return { openCoursewareBuildFiles };
    throw new Error(id);
  }, module.exports, "/fixture/main");
  let current = true;
  const preview = new module.exports.CoursewarePlayerPreview({ handle: (key, handler) => handlers.set(key, handler) }, () => parent,
    { selected: () => assert.fail("canonical preview never selects native fixed package") });
  await preview.openClassroom({ classroom: { id: "classroom", scenes: [{ type: "quiz" }] }, buildId: "revision", locale: "zh-CN",
    assertCurrent: async () => { if (!current) throw new Error("canonical revision changed"); },
    readAsset: async id => { if (id !== "image") throw new Error("not in manifest"); return new Uint8Array([1, 2]); } });
  const child = Window.windows.at(-1), event = { sender: child.webContents, senderFrame: child.webContents.mainFrame };
  const read = handlers.get(module.exports.COURSEWARE_PLAYER_READ);
  assert.equal((await read(event, { kind: "package" })).classroom.id, "classroom");
  assert.deepEqual(await read(event, { kind: "asset", id: "image" }), new Uint8Array([1, 2]));
  await assert.rejects(read(event, { kind: "asset", id: "forged" }), /not in manifest/);
  current = false;
  await assert.rejects(read(event, { kind: "package" }), /revision changed/);
  preview.close();
});

test("team preview exposes file metadata but never signed URLs to the sandbox renderer", async () => {
  const parent = new Window({});
  const handlers = new Map();
  const module = { exports: {} };
  new Function("require", "exports", "__dirname", outputText)((id) => {
    if (id === "electron") return { BrowserWindow: Window };
    if (id === "node:path") return { join };
    if (id === "node:url") return { pathToFileURL: (path) => new URL("file://" + path) };
    if (id === "./courseware-build-files") return { openCoursewareBuildFiles };
    throw new Error(id);
  }, module.exports, "/fixture/main");
  const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const playback = { pointer: { projectId, channel: "shared", buildId: "a".repeat(64), snapshotId: "snapshot-1", packageSha256: "a".repeat(64), version: 1 },
    fixedBuild: { build: { buildId: "a".repeat(64), snapshotId: "snapshot-1", packageSha256: "a".repeat(64) },
      manifestSha256: "b".repeat(64), expiresAt: "2099-01-01T00:00:00Z", files: [
        { file: { path: "package.json", sha256: "a".repeat(64), mimeType: "application/json", byteLength: 1 }, downloadUrl: "https://bucket.oss-cn-hangzhou.aliyuncs.com/package?signature=secret" },
      ] } };
  const media = {
    getTeamFixedPlayback: async (id, channel) => { assert.equal(id, projectId); assert.equal(channel, "shared"); return playback; },
    downloadTeamFixedFile: async (_selection, path) => { assert.equal(path, "package.json"); return Buffer.from("x"); },
  };
  const preview = new module.exports.CoursewarePlayerPreview({ handle: (channel, handler) => handlers.set(channel, handler) }, () => parent,
    { selected: async () => assert.fail("team playback must not use a local build") }, media);
  await preview.openTeam(projectId, "shared", "zh-CN");
  const child = Window.windows.at(-1);
  assert.equal(new URL(child.url).searchParams.get("team"), "1");
  const event = { sender: child.webContents, senderFrame: child.webContents.mainFrame };
  const read = handlers.get(module.exports.COURSEWARE_PLAYER_READ);
  const selected = await read(event, { kind: "team-selection" });
  assert.deepEqual(selected.expected, { buildId: "a".repeat(64), snapshotId: "snapshot-1", packageSha256: "a".repeat(64) });
  assert.equal(selected.selection.files[0].downloadUrl, "");
  assert(!JSON.stringify(selected).includes("signature=secret"));
  assert.deepEqual(Buffer.from(await read(event, { kind: "team-file", path: "package.json" })), Buffer.from("x"));
  preview.close();
  assert.equal(child.isDestroyed(), true);
});
