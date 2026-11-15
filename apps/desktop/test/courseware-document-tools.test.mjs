import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url), exports = {};
new Function("require", "exports", ts.transpileModule(readFileSync(new URL("../electron/main/courseware-document-tools.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(id => id === "./fs-panel" ? { resolveRealOpenablePath: async (path, workspace) => {
    const full = await realpath(join(workspace, path));
    return full.startsWith(workspace + "/") ? full : null;
  } } : require(id), exports);

async function setup(t) {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "courseware-documents-")));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  for (const name of ["a", "b"]) await writeFile(join(workspace, name + ".pptx"), "native");
  const calls = []; let alive = true, target, failSave = false, release, canonical = false, backgroundTarget, sourceOverride, mode = "agent";
  const gate = new Promise(resolve => { release = resolve; });
  const host = { async call(method, args) {
    if (method === "session.get") return { session: { projectPath: workspace, mode } };
    assert.equal(method, "courseware.task.get");
    return { task: { generatedPath: sourceOverride ?? args.sessionId + ".pptx", ...(canonical ? { canonicalProjectId: "canonical" } : {}) } };
  } };
  const makeEditor = kind => ({
    documentTarget: () => kind === "live" ? target : backgroundTarget,
    async waitForOpen() {}, async waitForTeachingReady(_workspace, check) { check(); },
    async ensureSaved() { calls.push(kind + ":save"); if (failSave) throw Error("save uncertain"); },
    async open(_window, root, path) { calls.push("background:open:" + path); backgroundTarget = { workspaceRoot: root, sourcePath: path }; },
  });
  const live = makeEditor("live");
  const router = new exports.CoursewareDocumentTools({ getHost: () => host, editor: live,
    createBackground: () => { calls.push("background:create"); return { editor: makeEditor("background"), window: {}, dispose() { calls.push("background:dispose"); } }; },
    createTools(editor, scope) { return { async execute(session, name, args, check) {
      await scope.assertCurrent(); assert.equal(session, scope.sessionId); assert.equal(check(), true);
      calls.push((editor === live ? "live:" : "background:") + session);
      if (args.wait) await gate;
      if (args.fail) throw Error("native write failed");
      if (!check()) throw Error("turn ended");
      return { value: { applied: true, path: scope.path, saved: true } };
    } }; },
  });
  return { router, calls, workspace, release, canonical() { canonical = true; }, active: () => alive, cancel() { alive = false; },
    source(value) { sourceOverride = value; }, mode(value) { mode = value; },
    open(name, root = workspace) { target = { workspaceRoot: root, sourcePath: join(workspace, name + ".pptx") }; }, failSave(value) { failSave = value; } };
}

test("a background Chat edits its exact closed document without touching the foreground document", async t => {
  const f = await setup(t); f.open("a");
  const result = await f.router.execute("b", "courseware_narration_context", {}, f.active);
  assert.equal(result.value.path, join(f.workspace, "b.pptx"));
  assert(f.calls.includes("background:b")); assert(!f.calls.includes("live:b"));
});

test("the target's open editor is authoritative even after switching Chat, including unsaved edits", async t => {
  const f = await setup(t); f.open("a");
  await f.router.execute("a", "courseware_narration_propose", {}, f.active);
  assert(f.calls.indexOf("live:save") < f.calls.indexOf("live:a"));
  assert(!f.calls.includes("background:create"));
});

test("opening or closing waits for the running native operation and flushes the hidden editor", async t => {
  const f = await setup(t);
  const running = f.router.execute("b", "courseware_narration_propose", { wait: true }, f.active);
  while (!f.calls.includes("background:b")) await new Promise(resolve => setImmediate(resolve));
  const opening = f.router.transition(async () => { f.calls.push("ui:open"); f.open("b"); });
  await new Promise(resolve => setImmediate(resolve)); assert(!f.calls.includes("ui:open"));
  f.release(); await running; await opening;
  assert(f.calls.indexOf("background:dispose") < f.calls.indexOf("ui:open"));
  await f.router.execute("b", "courseware_media_context", {}, f.active);
  assert(f.calls.includes("live:b"));
});

test("cancelled queued tasks do not open or mutate a document", async t => {
  const f = await setup(t); f.open("a");
  const first = f.router.execute("a", "courseware_narration_propose", { wait: true }, () => true);
  while (!f.calls.includes("live:a")) await new Promise(resolve => setImmediate(resolve));
  const second = f.router.execute("b", "courseware_media_prepare", {}, f.active);
  f.cancel(); f.release(); await first;
  await assert.rejects(second, /turn ended/); assert(!f.calls.includes("background:create"));
});

test("native failures never replay on another executor; failed saves block handoff without discarding the hidden document", async t => {
  const f = await setup(t); f.open("a");
  await assert.rejects(f.router.execute("a", "courseware_narration_propose", { fail: true }, f.active), /native write failed/);
  assert(!f.calls.includes("background:create"));
  f.failSave(true);
  await assert.rejects(f.router.execute("b", "courseware_media_refresh", {}, f.active), /save uncertain/);
  await assert.rejects(f.router.transition(async () => { f.calls.push("ui:open"); }), /save uncertain/);
  assert(!f.calls.includes("background:dispose")); assert(!f.calls.includes("ui:open"));
  f.failSave(false); await f.router.transition(async () => {});
  assert(f.calls.includes("background:dispose"));
});

test("unrelated generation tools and canonical classrooms retain the existing workflow", async t => {
  const f = await setup(t);
  assert.equal(await f.router.execute("b", "courseware_scene_image_prepare", {}, f.active), undefined);
  f.canonical();
  assert.equal(await f.router.execute("b", "courseware_media_context", {}, f.active), undefined);
  assert.deepEqual(f.calls, []);
});

test("changing the task target during a native call rejects without replaying on the replacement", async t => {
  const f = await setup(t); f.open("a");
  const running = f.router.execute("a", "courseware_narration_propose", { wait: true }, f.active);
  while (!f.calls.includes("live:a")) await new Promise(resolve => setImmediate(resolve));
  f.source("b.pptx"); f.release();
  await assert.rejects(running, /document target changed/);
  assert(!f.calls.includes("background:create"));
});

test("an already open real file in another workspace never gets a second writable engine", async t => {
  const f = await setup(t); f.open("a", "/different-workspace");
  await assert.rejects(f.router.execute("a", "courseware_narration_context", {}, f.active), /different workspace/);
  assert.deepEqual(f.calls, []);
});

test("changing to Plan mode while queued prevents native access", async t => {
  const f = await setup(t); f.mode("plan");
  await assert.rejects(f.router.execute("b", "courseware_narration_context", {}, f.active), /owning Agent workspace/);
  assert.deepEqual(f.calls, []);
});
