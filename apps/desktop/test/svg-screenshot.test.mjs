import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { screenshotSvg } = await import("../electron/main/svg-screenshot.ts");
const { BrowserHost } = await import("../electron/main/browser-host.ts");

const markup = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 9"><rect width="16" height="9"/></svg>';
const png = { mimeType: "image/png", data: "cG5n" };

function windowFor(steps) {
  const calls = [];
  return {
    calls,
    webContents: {
      async executeJavaScript(script) {
        calls.push(script);
        return steps.shift()(script);
      },
    },
  };
}

test("active SVG renders without a browser guest or visible panel dimensions", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "deckwise-svg-shot-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const project = join(workspace, ".deckwise-ppt", "projects", "lesson");
  await mkdir(project, { recursive: true });
  const window = windowFor([
    () => ({ markup, projectPath: project, sessionId: "task-1" }),
    () => [],
    () => png,
  ]);
  let nativeCaptures = 0;
  const host = new BrowserHost({
    pane: { getWebContents: () => ({ isDestroyed: () => false }), capturePage: async () => { nativeCaptures++; }, invalidateNavigation: () => {}, setVisible: () => {} },
    isPluginLoaded: () => true,
    getFileRoot: async () => workspace,
    getMainWindow: () => window,
    onState: () => {},
  });
  host.cdp.screenshot = async (_wc, _input, native) => { await native(); return { mimeType: "image/jpeg", data: "anBn" }; };
  assert.deepEqual(await host.screenshot({}, "task-1"), png);
  assert.equal(nativeCaptures, 0);
  assert.equal(window.calls.length, 3);
  assert.match(window.calls[2], /1920/);
});

test("explicit SVG path works with preview closed and local images stay in workspace", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "deckwise-svg-shot-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const slides = join(workspace, ".deckwise-ppt", "projects", "lesson", "svg_output");
  const images = join(workspace, ".deckwise-ppt", "projects", "lesson", "images");
  await mkdir(slides, { recursive: true });
  await mkdir(images, { recursive: true });
  await writeFile(join(images, "photo.png"), "png-bytes");
  await writeFile(join(slides, "01.svg"), '<svg viewBox="0 0 16 9"><image href="../images/photo.png"/></svg>');
  const window = windowFor([
    () => ["../images/photo.png"],
    (script) => {
      assert.match(script, /data:image\/png;base64,cG5nLWJ5dGVz/);
      return png;
    },
  ]);
  assert.deepEqual(await screenshotSvg(window, workspace, join(slides, "01.svg")), png);
  assert.equal(window.calls.length, 2);

  const host = new BrowserHost({
    pane: { getWebContents: () => assert.fail("explicit SVG rendering must never open the browser guest") },
    isPluginLoaded: () => true,
    getFileRoot: async sessionId => { assert.equal(sessionId, "task-1"); return workspace; },
    getMainWindow: () => windowFor([() => ["../images/photo.png"], () => png]),
    onState: () => {},
  });
  assert.deepEqual(await host.screenshot({ path: join(slides, "01.svg") }, "task-1"), png);
  await assert.rejects(host.screenshot({ path: join(slides, "missing.svg") }, "task-1"), { code: "ENOENT" });

  const outside = await mkdtemp(join(tmpdir(), "deckwise-svg-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "foreign.svg"), markup);
  await symlink(join(outside, "foreign.svg"), join(slides, "foreign.svg"));
  await assert.rejects(screenshotSvg(window, workspace, join(slides, "foreign.svg")), /inside the workspace/);
});

test("active SVG is not captured for another session", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "deckwise-svg-shot-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const window = windowFor([() => ({ markup, projectPath: workspace, sessionId: "visible-task" })]);
  assert.equal(await screenshotSvg(window, workspace, undefined, "background-task"), null);
  assert.equal(window.calls.length, 1);
});

test("PPT Master browser preview captures its current SVG before CDP or native screenshot", async () => {
  let nativeCaptures = 0;
  const scripts = [];
  const guest = {
    isDestroyed: () => false,
    getURL: () => "http://127.0.0.1:6061/",
    async executeJavaScript(script) {
      scripts.push(script);
      if (scripts.length !== 1) return png;
      const svg = { cloneNode: () => ({ outerHTML: markup, querySelectorAll: () => [] }) };
      return runInNewContext(script, {
        document: {
          getElementById: () => ({ style: { display: "block" }, querySelector: () => svg }),
          querySelector: () => ({}),
        },
      });
    },
  };
  const host = new BrowserHost({
    pane: { getWebContents: () => guest, capturePage: async () => { nativeCaptures++; }, invalidateNavigation: () => {}, setVisible: () => {} },
    isPluginLoaded: () => true,
    getFileRoot: async () => null,
    onState: () => {},
  });
  host.setChromeSession("task-1");
  host.cdp.screenshot = async (_wc, _input, native) => { await native(); return { mimeType: "image/jpeg", data: "anBn" }; };
  assert.deepEqual(await host.screenshot({}, "task-1"), png);
  assert.equal(nativeCaptures, 0);
  assert.match(scripts[0], /getElementById\("svg-content"\)/);
  assert.match(scripts[1], /1920/);
});

test("failed SVG render falls back to the existing CDP screenshot", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "deckwise-svg-shot-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const host = new BrowserHost({
    pane: { getWebContents: () => ({ isDestroyed: () => false }), capturePage: async () => {}, invalidateNavigation: () => {}, setVisible: () => {} },
    isPluginLoaded: () => true,
    getFileRoot: async () => workspace,
    getMainWindow: () => windowFor([() => { throw new Error("render failed"); }]),
    onState: () => {},
  });
  host.setChromeSession("task-1");
  let called = false;
  host.cdp.screenshot = async () => { called = true; return { mimeType: "image/jpeg", data: "anBn" }; };
  assert.deepEqual(await host.screenshot({}, "task-1"), { mimeType: "image/jpeg", data: "anBn" });
  assert.equal(called, true);
});
