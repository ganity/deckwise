import { readMainSourceSync } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const cdpSource = readFileSync(
  resolve("electron/main/browser-cdp.ts"),
  "utf8",
);
const { BrowserCdp } = await import("../electron/main/browser-cdp.ts");
const hostSource = readFileSync(
  resolve("electron/main/browser-host.ts"),
  "utf8",
);

function clampGuestBounds(view, hole) {
  const x = Math.max(view.x, view.x + hole.x);
  const y = Math.max(view.y, view.y + hole.y);
  const right = Math.min(view.x + view.width, view.x + hole.x + hole.width);
  const bottom = Math.min(view.y + view.height, view.y + hole.y + hole.height);
  const width = Math.floor(right - x);
  const height = Math.floor(bottom - y);
  if (width < 1 || height < 1) return null;
  return { x: Math.floor(x), y: Math.floor(y), width, height };
}

function flattenAxTree(nodes) {
  const byId = new Map();
  for (const node of nodes) {
    if (typeof node.nodeId === "string") byId.set(node.nodeId, node);
  }
  const childIds = new Set();
  for (const node of nodes) {
    for (const id of node.childIds ?? []) childIds.add(id);
  }
  const roots = nodes.filter(
    (node) => typeof node.nodeId === "string" && !childIds.has(node.nodeId),
  );
  const uids = new Map();
  const lines = [];
  let next = 1;
  const walk = (node, depth) => {
    if (!node.ignored) {
      const role = node.role?.value?.trim() || "Generic";
      const name = node.name?.value?.trim() ?? "";
      const uid = `e${next}`;
      next += 1;
      if (typeof node.backendDOMNodeId === "number") uids.set(uid, node.backendDOMNodeId);
      const label = name ? `${role} ${JSON.stringify(name)}` : role;
      lines.push(`${"  ".repeat(depth)}- ${uid} ${label}`);
    }
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId);
      if (child) walk(child, node.ignored ? depth : depth + 1);
    }
  };
  for (const root of roots) walk(root, 0);
  return { tree: lines.join("\n") || "(empty)", uids };
}

test("CDP allowlist denies cookies, storage, and target methods", () => {
  assert.match(cdpSource, /Page\.captureScreenshot/);
  assert.match(cdpSource, /Accessibility\.getFullAXTree/);
  assert.doesNotMatch(cdpSource, /Network\.getAllCookies/);
  assert.doesNotMatch(cdpSource, /Network\.setCookie/);
  assert.doesNotMatch(cdpSource, /Storage\./);
  assert.doesNotMatch(cdpSource, /"Target\./);
  assert.doesNotMatch(cdpSource, /Fetch\./);
  assert.doesNotMatch(cdpSource, /["']Page\.navigate["']/);
  assert.match(cdpSource, /CDP method not allowed/);
  assert.match(cdpSource, /this\.detach\(wc\);/);
});

test("normal screenshots use CDP before native capture fallback", () => {
  assert.match(hostSource, /const wc = this\.requireWebContents\(\);/);
  assert.match(hostSource, /shot = await this\.cdp\.screenshot\(wc, input, \(\) => this\.pane\.capturePage\(\)\);/);
  assert.match(hostSource, /const wc = await this\.waitForWebContents\(\);/);
  assert.doesNotMatch(hostSource, /this\.pane\.isCaptureReady\(\)/);
  assert.doesNotMatch(hostSource, /browser preview is not visible yet/);
  assert.match(cdpSource, /Page\.captureScreenshot/);
  assert.match(cdpSource, /browser\.screenshot\.native\.fallback/);
  assert.match(cdpSource, /nativeScreenshot/);
  assert.match(cdpSource, /capturePage\(undefined, \{ stayHidden: true, stayAwake: true \}\)/);
  assert.match(cdpSource, /SCREENSHOT_TIMEOUT_MS/);
});

test("normal screenshot does not invoke native capture when CDP succeeds", async () => {
  class Debugger extends EventEmitter {
    attached = false;
    calls = [];
    isAttached() { return this.attached; }
    attach() { this.attached = true; }
    detach() { this.attached = false; this.emit("detach"); }
    async sendCommand(method) {
      this.calls.push(method);
      return method === "Page.captureScreenshot" ? { data: "c2hvdA==" } : {};
    }
  }

  const debuggerApi = new Debugger();
  const wc = {
    id: 3,
    debugger: debuggerApi,
    isDestroyed: () => false,
  };
  const shot = await new BrowserCdp().screenshot(wc, {}, async () => {
    throw new Error("native capture should be fallback only");
  });

  assert.deepEqual(shot, { mimeType: "image/jpeg", data: "c2hvdA==" });
  assert.ok(debuggerApi.calls.includes("Page.captureScreenshot"));
});

test("guest bounds are clamped to the plugin view rect", () => {
  assert.match(hostSource, /export function clampGuestBounds/);
  const view = { x: 400, y: 40, width: 360, height: 600 };
  const hole = { x: 0, y: 36, width: 360, height: 564 };
  assert.deepEqual(clampGuestBounds(view, hole), {
    x: 400,
    y: 76,
    width: 360,
    height: 564,
  });
  assert.equal(
    clampGuestBounds(view, { x: -80, y: -10, width: 900, height: 20 })?.x,
    400,
  );
  assert.equal(clampGuestBounds(view, { x: 0, y: 700, width: 10, height: 10 }), null);
});

test("snapshot uids are stable eN handles mapped to backend nodes", () => {
  assert.match(cdpSource, /unknown or stale uid/);
  const { tree, uids } = flattenAxTree([
    {
      nodeId: "1",
      role: { value: "WebArea" },
      childIds: ["2"],
    },
    {
      nodeId: "2",
      role: { value: "button" },
      name: { value: "Submit" },
      backendDOMNodeId: 42,
    },
  ]);
  assert.match(tree, /- e1 WebArea/);
  assert.match(tree, /- e2 button "Submit"/);
  assert.equal(uids.get("e2"), 42);
});

test("browser selectors target elements without weakening uid validation", () => {
  assert.match(cdpSource, /async clickSelector\(wc: WebContents, selector: string\)/);
  assert.match(cdpSource, /async fillSelector\(wc: WebContents, selector: string, text: string\)/);
  assert.match(cdpSource, /"DOM\.querySelector"/);
  assert.match(cdpSource, /Page\.frameNavigated.*Page\.navigatedWithinDocument/s);
  assert.match(hostSource, /provide exactly one of uid or selector/);
  assert.match(cdpSource, /BROWSER_TARGET_CLOSED/);
  assert.match(hostSource, /async click\(target: string \| BrowserElementTarget\)/);
  assert.match(hostSource, /async fill\(target: string \| BrowserElementTarget, text: string\)/);
});

test("browser tool distinguishes CSS selectors and warns about closed targets", () => {
  const pluginSource = readFileSync(
    resolve("resources/plugins/pi.browser/main.js"),
    "utf8",
  );
  assert.match(pluginSource, /selector: \{/);
  assert.match(pluginSource, /Uids expire as soon as navigation starts/);
  assert.match(pluginSource, /selector: args\?\.selector/);
  assert.match(runtimeSource, /selector: payload\?\.selector/);
});

test("selector clicks work and navigation invalidates snapshot uids", async () => {
  class Debugger extends EventEmitter {
    attached = false;
    calls = [];

    isAttached() {
      return this.attached;
    }

    attach() {
      this.attached = true;
    }

    detach() {
      this.attached = false;
      this.emit("detach");
    }

    async sendCommand(method, params = {}) {
      this.calls.push({ method, params });
      if (method === "Accessibility.getFullAXTree") {
        return {
          nodes: [
            { nodeId: "1", role: { value: "WebArea" }, childIds: ["2"] },
            { nodeId: "2", role: { value: "button" }, name: { value: "Confirm" }, backendDOMNodeId: 42 },
          ],
        };
      }
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") return { nodeId: 2 };
      if (method === "DOM.resolveNode") return { object: { objectId: "input-1" } };
      if (method === "DOM.getBoxModel") {
        return { model: { content: [0, 0, 20, 0, 20, 10, 0, 10] } };
      }
      return {};
    }
  }

  const debuggerApi = new Debugger();
  const wc = {
    id: 1,
    debugger: debuggerApi,
    isDestroyed: () => false,
    getURL: () => "http://127.0.0.1/",
    getTitle: () => "Test",
  };
  const cdp = new BrowserCdp();

  const snapshot = await cdp.snapshot(wc);
  assert.match(snapshot.tree, /e2 button "Confirm"/);
  await cdp.clickSelector(wc, "#btn-confirm");
  assert.equal(
    debuggerApi.calls.filter(({ method }) => method === "Input.dispatchMouseEvent").length,
    2,
  );
  await cdp.fillSelector(wc, "#name", "lesson plan");
  assert.deepEqual(
    debuggerApi.calls.find(({ method }) => method === "Runtime.callFunctionOn").params.arguments,
    [{ value: "lesson plan" }],
  );

  debuggerApi.emit("message", {}, "Page.frameStartedNavigating", { frameId: "main" });
  await assert.rejects(cdp.click(wc, "e2"), /unknown or stale uid/);
  cdp.detach();
});

test("target closure has a stable browser error code", async () => {
  class Debugger extends EventEmitter {
    attached = false;
    isAttached() { return this.attached; }
    attach() { this.attached = true; }
    detach() { this.attached = false; this.emit("detach"); }
    async sendCommand(method) {
      if (method === "Runtime.evaluate") throw new Error("target closed while handling command");
      return {};
    }
  }
  const wc = {
    id: 2,
    debugger: new Debugger(),
    isDestroyed: () => false,
    getURL: () => "http://127.0.0.1/",
    getTitle: () => "Test",
  };

  await assert.rejects(new BrowserCdp().evaluate(wc, "1 + 1"), (error) => {
    assert.equal(error.code, "BROWSER_TARGET_CLOSED");
    assert.match(error.message, /action may have completed/);
    return true;
  });
});

const runtimeSource = readFileSync(
  resolve("electron/main/plugin-runtime.ts"),
  "utf8",
);
const mainSource = readMainSourceSync();

test("in-flight tool.execute session survives the child host-api round trip", () => {
  assert.match(runtimeSource, /private readonly toolInvocations = new PluginToolInvocations/);
  assert.match(runtimeSource, /toolInvocations\.begin\(target/);
  assert.match(runtimeSource, /invocationId: invocation\.id/);
  assert.match(runtimeSource, /this\.browserSessionId\(pluginId\)/);
});

test("legacy renderer browser IPC cannot place an unclamped guest", () => {
  const bounds = mainSource.slice(mainSource.indexOf("IPC.invoke.browserSetBounds"));
  const body = bounds.slice(0, bounds.indexOf("\n  handle("));
  assert.doesNotMatch(body, /browserPane\.setBounds/);
  assert.match(body, /Plugin chrome owns the clamped hole/);
  const visible = mainSource.slice(mainSource.indexOf("IPC.invoke.browserSetVisible"));
  const visibleBody = visible.slice(0, visible.indexOf("\n  handle("));
  assert.match(visibleBody, /plugins\.getLoaded\(BROWSER_PLUGIN_ID\)/);
  assert.doesNotMatch(visibleBody, /browserPane\.setVisible/);
});
