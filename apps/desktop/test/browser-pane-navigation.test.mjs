import assert from "node:assert/strict";
import { register, registerHooks } from "node:module";
import test from "node:test";

const electron = `data:text/javascript,${encodeURIComponent(`
  import { EventEmitter } from "node:events";
  export const shell = {};
  export class WebContentsView {
    static instances = [];
    constructor() {
      this.bounds = { x: 0, y: 0, width: 0, height: 0 };
      this.visible = true;
      this.wasVisibleWhileAttached = false;
      this.webContents = Object.assign(new EventEmitter(), {
        url: "https://fixture.invalid/previous",
        mainFrame: { processId: 7, routingId: 11 },
        pendingLoads: [],
        loadURL(url) {
          return new Promise((resolve, reject) => {
            this.pendingLoads.push({ url, resolve, reject });
          });
        },
        getURL() { return this.url; },
        getTitle: () => "fixture",
        isLoading: () => false,
        isDestroyed: () => false,
        navigationHistory: { canGoBack: () => false, canGoForward: () => false },
        setWindowOpenHandler: () => {},
        session: { setPermissionRequestHandler: () => {} },
        capturePage: async () => {
          const empty = this.bounds.width === 0 || this.bounds.height === 0;
          return { isEmpty: () => empty };
        },
      });
      WebContentsView.instances.push(this);
    }
    setBounds(bounds) { this.bounds = bounds; }
    setVisible(visible) {
      this.visible = visible;
      if (visible && this.attached) this.wasVisibleWhileAttached = true;
    }
  }
`)}`;
registerHooks({ resolve(specifier, context, next) {
  return specifier === "electron" ? { url: electron, shortCircuit: true } : next(specifier, context);
} });
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { BrowserPane } = await import("../electron/main/browser-view.ts");
const { WebContentsView } = await import("electron");

function harness(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pane = new BrowserPane(() => {});
  const request = pane.navigateAndWait("https://fixture.invalid/new", null, 100);
  const wc = WebContentsView.instances.at(-1).webContents;
  return { pane, wc, request };
}

test("a timed-out preview does not return the previous page as ready", async (t) => {
  const { request } = harness(t);
  t.mock.timers.tick(100);
  assert.equal(await request, null);
});

test("an invalidated native view is recreated before navigation", async (t) => {
  const { pane, request } = harness(t);
  t.mock.timers.tick(100);
  await request;
  pane.view = { webContents: undefined };
  const next = pane.navigateAndWait("https://fixture.invalid/recreated");
  const wc = WebContentsView.instances.at(-1).webContents;
  wc.url = "https://fixture.invalid/recreated";
  wc.pendingLoads.shift().resolve();
  assert.equal((await next)?.url, "https://fixture.invalid/recreated");
});

test("a failed or invalid navigation does not return the previous page", async (t) => {
  const { pane, wc, request } = harness(t);
  t.mock.timers.tick(100);
  await request;
  wc.loadURL = async () => { throw new Error("load failure"); };
  assert.equal(await pane.navigateAndWait("https://fixture.invalid/failed"), null);
  assert.equal(await pane.navigateAndWait("javascript:alert(1)"), null);
});

test("late events cannot publish a page from the previous session", async () => {
  const published = [];
  const pane = new BrowserPane((state) => published.push(state));
  const first = pane.navigateAndWait("https://fixture.invalid/first");
  const wc = WebContentsView.instances.at(-1).webContents;
  wc.url = "https://fixture.invalid/first";
  wc.pendingLoads.shift().resolve();
  await first;
  pane.invalidateNavigation();
  const second = pane.navigateAndWait("https://fixture.invalid/second");
  wc.url = "https://fixture.invalid/second";
  wc.pendingLoads.shift().resolve();
  await second;
  wc.emit("did-navigate", {}, "https://fixture.invalid/first");
  wc.emit("did-fail-load", {}, -3, "aborted", "https://fixture.invalid/first", true);
  assert.deepEqual(published, []);
  wc.emit("did-navigate", {}, "https://fixture.invalid/second");
  assert.equal(published.at(-1)?.url, "https://fixture.invalid/second");
});

test("same-document navigation publishes only from the active main frame", async () => {
  const published = [];
  const pane = new BrowserPane((state) => published.push(state));
  const request = pane.navigateAndWait("https://fixture.invalid/page");
  const wc = WebContentsView.instances.at(-1).webContents;
  wc.url = "https://fixture.invalid/page";
  wc.pendingLoads.shift().resolve();
  await request;
  wc.emit("did-navigate-in-page", {}, wc.url, false, 7, 11);
  wc.emit("did-navigate-in-page", {}, wc.url, true, 8, 11);
  assert.deepEqual(published, []);
  wc.url += "#details";
  wc.emit("did-navigate-in-page", {}, wc.url, true, 7, 11);
  assert.equal(published.at(-1)?.url, wc.url);
  pane.invalidateNavigation();
  wc.emit("did-stop-loading");
  assert.equal(published.length, 1);
});

test("captures a detached zero-size preview and restores its hidden state", async () => {
  const pane = new BrowserPane(() => {});
  const view = new WebContentsView();
  const children = [];
  pane.view = view;
  pane.window = {
    isDestroyed: () => false,
    getContentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    contentView: {
      children,
      addChildView(child) { children.push(child); child.attached = true; },
      removeChildView(child) { children.splice(children.indexOf(child), 1); child.attached = false; },
    },
  };

  const image = await pane.capturePage();
  assert.equal(image.isEmpty(), false);
  assert.deepEqual(children, []);
  assert.deepEqual(view.bounds, { x: 0, y: 0, width: 0, height: 0 });
  assert.equal(view.visible, false);
  assert.equal(view.wasVisibleWhileAttached, true);
});

test("retries a compositor capture error before failing", async () => {
  const pane = new BrowserPane(() => {});
  const view = new WebContentsView();
  const children = [];
  let attempts = 0;
  view.webContents.capturePage = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("UnknownVizError");
    return { isEmpty: () => false };
  };
  pane.view = view;
  pane.window = {
    isDestroyed: () => false,
    getContentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    contentView: {
      children,
      addChildView(child) { children.push(child); child.attached = true; },
      removeChildView(child) { children.splice(children.indexOf(child), 1); child.attached = false; },
    },
  };

  await pane.capturePage();
  assert.equal(attempts, 2);
});
