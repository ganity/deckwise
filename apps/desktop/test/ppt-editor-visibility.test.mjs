import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

const { build } = createRequire(new URL("../../../packages/agent-runtime/package.json", import.meta.url))("esbuild");
const { chromium } = createRequire(new URL("../../../packages/courseware-runtime/package.json", import.meta.url))("@playwright/test");
let browser, server, address;

before(async () => {
  const mocks = {
    "../../lib/api": `export const api = {
      pptEditorOpen(path) {
        const f = window.fixture; f.calls.push(["open", path]);
        if (f.pending) return Promise.reject(new Error("Finish source adoption before opening, saving or closing Office"));
        return new Promise((resolve, reject) => { f.pending = { resolve, reject, path }; });
      },
      async pptEditorSetVisible(visible) { window.fixture.calls.push(["visible", visible]); },
      async pptEditorSetBounds() {},
      async pptEditorClose() { window.fixture.calls.push(["close"]); },
      onPptEditorState(listener) { window.fixture.listeners.add(listener); return () => window.fixture.listeners.delete(listener); }
    };`,
    "../../stores/app-store": `export const useAppStore = selector => selector(window.fixture.store);
      useAppStore.getState = () => window.fixture.store;`,
    "react-i18next": `export const useTranslation = () => ({ t: key => key });`,
    "./PptxInspectionPanel": "export const PptxInspectionPanel = () => null;",
    "./CoursewareTeachingPanel": "export const CoursewareTeachingPanel = () => null;",
  };
  const bundle = await build({
    stdin: {
      contents: `import { StrictMode } from "react";
        import { createRoot } from "react-dom/client";
        import { flushSync } from "react-dom";
        import { PptEditorTab } from "./src/components/workpanel/PptEditorTab";
        let root;
        const f = window.fixture = {
          calls: [], listeners: new Set(), pending: null,
          store: { activeSessionId: "chat", workPanelTabs: [{ id: "ppt" }], closeWorkPanelTab() {}, showToast() {} },
          render() { flushSync(() => root.render(<StrictMode><PptEditorTab path="uploaded.pptx" tabId="ppt" /></StrictMode>)); },
          mount() { root = createRoot(document.getElementById("root")); this.render(); },
          unmount() { this.store.workPanelTabs = []; flushSync(() => root.unmount()); },
          finish(error) {
            const pending = this.pending; this.pending = null;
            if (error) { pending.reject(new Error(error)); return; }
            const state = { status: "ready", path: pending.path, revision: 1, canSave: true };
            for (const listener of this.listeners) listener(state);
            pending.resolve(state);
          }
        };`,
      resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "tsx",
    },
    bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [{ name: "editor-fixture", setup(build) {
      build.onResolve({ filter: /.*/ }, args => Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: "fixture" } : undefined);
      build.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: mocks[args.path], loader: "js" }));
    } }],
  });
  server = createServer((request, response) => {
    response.setHeader("content-type", request.url === "/fixture.js" ? "application/javascript" : "text/html");
    response.end(request.url === "/fixture.js" ? bundle.outputFiles[0].text : '<div id="root"></div><script src="/fixture.js"></script>');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  address = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

async function fixture(t) {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(address);
  await page.evaluate(() => window.fixture.mount());
  await page.waitForFunction(() => window.fixture.calls.some(([name]) => name === "open"));
  return page;
}

test("StrictMode opens the uploaded PPT once and displays it after native readiness", async t => {
  const page = await fixture(t);
  await page.evaluate(() => window.fixture.finish());
  assert.equal(await page.evaluate(() => window.fixture.calls.some(([name, visible]) => name === "visible" && visible)), true, "a ready uploaded PPT must be displayed");
  assert.deepEqual(await page.evaluate(() => window.fixture.calls.filter(([name]) => name === "open")), [["open", "uploaded.pptx"]]);
  assert.equal(await page.locator('[role="status"]').textContent(), "panel.pptEditor.revision");
  await page.evaluate(() => window.fixture.unmount());
  await page.waitForFunction(() => window.fixture.calls.some(([name]) => name === "close"));
  assert.deepEqual((await page.evaluate(() => window.fixture.calls.filter(([name]) => name === "visible"))).at(-1), ["visible", false]);
});

test("unmounting before opening starts cancels the native request", async t => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(address);
  await page.evaluate(() => { window.fixture.mount(); window.fixture.unmount(); });
  await page.waitForFunction(() => window.fixture.calls.some(([name]) => name === "close"));
  assert.equal(await page.evaluate(() => window.fixture.calls.some(([name]) => name === "open")), false);
});

test("a late open cannot redisplay an unmounted editor", async t => {
  const page = await fixture(t);
  await page.evaluate(() => { window.fixture.unmount(); window.fixture.finish(); });
  await page.waitForFunction(() => window.fixture.calls.some(([name]) => name === "close"));
  assert.equal(await page.evaluate(() => window.fixture.calls.some(([name, visible]) => name === "visible" && visible)), false);
});

test("failed opening can be retried and a ready editor rebinds when Chat changes", async t => {
  const page = await fixture(t);
  await page.evaluate(() => window.fixture.finish("conversion failed"));
  await page.getByRole("button", { name: "panel.pptEditor.retry", exact: true }).click();
  await page.evaluate(() => window.fixture.finish());
  await page.waitForFunction(() => window.fixture.calls.some(([name, visible]) => name === "visible" && visible));
  await page.evaluate(() => { window.fixture.store.activeSessionId = "another-chat"; window.fixture.render(); });
  await page.waitForFunction(() => window.fixture.pending !== null);
  await page.evaluate(() => window.fixture.finish());
  await page.waitForFunction(() => window.fixture.calls.filter(([name, visible]) => name === "visible" && visible).length === 2);
  assert.equal(await page.evaluate(() => window.fixture.calls.filter(([name]) => name === "open").length), 3);
});
