import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
      async pptEditorConfigureUi(ui) { window.fixture.calls.push(["ui", ui]); },
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
          calls: [], listeners: new Set(), pending: null, blocked: false,
          store: { activeSessionId: "chat", workPanelTabs: [{ id: "ppt" }], closeWorkPanelTab() {}, showToast() {} },
          render() { flushSync(() => root.render(<StrictMode><PptEditorTab path="uploaded.pptx" tabId="ppt" blocked={this.blocked} onToggleMaximize={() => this.calls.push(["focus"])} /></StrictMode>)); },
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
  await page.waitForFunction(() => window.fixture.calls.some(([name, visible]) => name === "visible" && visible));
  assert.equal(await page.evaluate(() => window.fixture.calls.some(([name, visible]) => name === "visible" && visible)), true, "a ready uploaded PPT must be displayed");
  assert.deepEqual(await page.evaluate(() => window.fixture.calls.filter(([name]) => name === "open")), [["open", "uploaded.pptx"]]);
  assert.equal(await page.locator('[role="status"]').textContent(), "panel.pptEditor.opened");
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

test("PPTX editing has one native teaching sidebar and no project-copy or advanced-panel entry", async t => {
  const page = await fixture(t);
  await page.evaluate(() => window.fixture.finish());
  for (const nativeTeaching of [false, true]) {
    await page.evaluate(nativeTeaching => {
      for (const listener of window.fixture.listeners) listener({ status: "ready", path: "uploaded.pptx", nativeTeaching, canSave: true });
    }, nativeTeaching);
    await page.waitForTimeout(20);
    assert.equal(await page.getByRole("button", { name: /高级教学工具|复制完整课件|打开课件副本目录/ }).count(), 0);
    assert.equal(await page.locator(".courseware-teaching-panel").count(), 0);
    assert.equal(await page.locator(".ppt-editor-surface").count(), 1);
    assert.equal(await page.getByRole("button", { name: "panel.pptEditor.save", exact: true }).count(), 1);
  }
});

test("native teaching progress appears in the toolbar without another teaching view or editor open", async t => {
  const page = await fixture(t);
  await page.evaluate(() => window.fixture.finish());
  await page.evaluate(() => {
    for (const listener of window.fixture.listeners) listener({ status: "ready", path: "uploaded.pptx", nativeTeaching: true,
      canSave: true, teachingProgress: { total: 6, audio: 3, ready: 2 } });
  });
  await page.waitForSelector(".courseware-teaching-progress");
  assert.equal(await page.locator(".courseware-teaching-progress").textContent(), "coursewareWorkflow.teachingProgress");
  assert.equal(await page.locator(".courseware-teaching").count(), 0);
  assert.equal(await page.evaluate(() => window.fixture.calls.filter(([name]) => name === "open").length), 1);
});

test("module controls keep focus and inspection local and send teaching visibility to the isolated view", async t => {
  const page = await fixture(t);
  await page.addStyleTag({ content: (await readFile(new URL("../src/styles/work-panel.css", import.meta.url), "utf8")) + "\nhtml,body,#root{height:100%;margin:0}" });
  await page.evaluate(() => window.fixture.finish());
  await page.evaluate(() => {
    for (const listener of window.fixture.listeners) listener({ status: "ready", path: "uploaded.pptx", module: true,
      nativeTeaching: true, teachingOpen: true, canSave: true });
  });
  const focus = page.getByRole("button", { name: "panel.pptEditor.focus", exact: true });
  await focus.click();
  assert.equal(await page.evaluate(() => window.fixture.calls.some(([name]) => name === "focus")), true);
  await page.getByRole("button", { name: "panel.pptEditor.inspection", exact: true }).click();
  assert.equal(await page.locator(".ppt-editor-review").count(), 1);
  assert.equal(await page.locator(".ppt-editor-document strong").count(), 0, "WiseOffice owns the document title");
  const review = await page.locator(".ppt-editor-review").boundingBox();
  const editor = await page.locator(".ppt-editor-body").boundingBox();
  assert.ok(review && editor && review.x >= editor.x + editor.width - 1, "review belongs beside the editor");
  await page.getByRole("button", { name: "common.close", exact: true }).click();
  assert.equal(await page.locator(".ppt-editor-review").count(), 0);
  await page.getByRole("button", { name: "panel.pptEditor.inspection", exact: true }).click();
  await page.getByRole("button", { name: "panel.pptEditor.teachingFlow", exact: true }).click();
  assert.deepEqual((await page.evaluate(() => window.fixture.calls.filter(([name]) => name === "ui"))).at(-1),
    ["ui", { teachingOpen: false }]);
});

test("blocking dialogs hide Office without closing or reopening the document", async t => {
  const page = await fixture(t);
  await page.evaluate(() => window.fixture.finish());
  await page.waitForFunction(() => window.fixture.calls.some(([name, visible]) => name === "visible" && visible));
  await page.evaluate(() => { window.fixture.blocked = true; window.fixture.render(); });
  assert.deepEqual(await page.evaluate(() => window.fixture.calls.filter(([name]) => name === "visible").at(-1)), ["visible", false]);
  await page.evaluate(() => { window.fixture.blocked = false; window.fixture.render(); });
  assert.deepEqual(await page.evaluate(() => window.fixture.calls.filter(([name]) => name === "visible").at(-1)), ["visible", true]);
  assert.equal(await page.evaluate(() => window.fixture.calls.filter(([name]) => name === "open").length), 1);
  assert.equal(await page.evaluate(() => window.fixture.calls.filter(([name]) => name === "close").length), 0);
});

test("Office becoming ready behind a dialog stays hidden until the dialog closes", async t => {
  const page = await fixture(t);
  await page.evaluate(() => { window.fixture.blocked = true; window.fixture.render(); window.fixture.finish(); });
  await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent === "panel.pptEditor.opened");
  assert.equal(await page.evaluate(() => window.fixture.calls.some(([name, visible]) => name === "visible" && visible)), false);
  await page.evaluate(() => { window.fixture.blocked = false; window.fixture.render(); });
  assert.deepEqual(await page.evaluate(() => window.fixture.calls.filter(([name]) => name === "visible").at(-1)), ["visible", true]);
});

test("the task dialog blocks Office through both workflow and direct-file work panel routes", async () => {
  const read = path => readFile(new URL(path, import.meta.url), "utf8");
  const shell = await read("../src/features/app/AppShell.tsx");
  const panel = await read("../src/components/workpanel/WorkPanel.tsx");
  const workflow = await read("../src/components/courseware/CoursewareChatWorkflow.tsx");
  assert.match(shell, /useAppStore\(state => state.newTaskDialog !== null\)/);
  assert.match(shell, /panelBlocked=\{searchOpen \|\| newTaskDialogOpen\}/);
  assert.match(panel, /<CoursewareChatWorkflow panelBlocked=\{exiting \|\| panelBlocked\}/);
  assert.match(panel, /<PptEditorTab\s+blocked=\{exiting \|\| panelBlocked\}/);
  assert.match(workflow, /<PptEditorTab[^>]+blocked=\{panelBlocked \|\| importOpen\}/);
});
