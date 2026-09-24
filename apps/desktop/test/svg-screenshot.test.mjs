import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
import test from "node:test";

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
    () => ({ markup, projectPath: project }),
    () => [],
    () => png,
  ]);
  const host = new BrowserHost({
    pane: { getWebContents: () => null, invalidateNavigation: () => {}, setVisible: () => {} },
    isPluginLoaded: () => true,
    getFileRoot: async () => workspace,
    getMainWindow: () => window,
    onState: () => {},
  });
  host.setChromeSession("task-1");
  assert.deepEqual(await host.screenshot({}, "task-1"), png);
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

  const outside = await mkdtemp(join(tmpdir(), "deckwise-svg-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "foreign.svg"), markup);
  await symlink(join(outside, "foreign.svg"), join(slides, "foreign.svg"));
  await assert.rejects(screenshotSvg(window, workspace, join(slides, "foreign.svg")), /inside the workspace/);
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
