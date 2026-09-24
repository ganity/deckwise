import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { BrowserHost } = await import("../electron/main/browser-host.ts");

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const settled = () => new Promise(setImmediate);

test("switching tasks hides the old preview until the new page loads", async () => {
  let state = null;
  let visible = false;
  const roots = [];
  const loads = [];
  const pane = {
    getState: () => state,
    getWebContents: () => null,
    invalidateNavigation: () => {},
    setBounds: () => {},
    setVisible: (value) => { visible = value; },
    navigateAndWait(target) {
      const result = deferred();
      loads.push({ target, finish: () => {
        state = { url: target, title: target, isLoading: false };
        result.resolve(state);
      } });
      return result.promise;
    },
    dispose: () => { state = null; visible = false; },
  };
  const host = new BrowserHost({
    pane,
    isPluginLoaded: () => true,
    getFileRoot(sessionId) {
      const result = deferred();
      roots.push({ sessionId, ...result });
      return result.promise;
    },
    onState: () => {},
  });
  host.setChromeSurface({
    pluginId: "pi.browser", viewId: "browser", visible: true,
    bounds: { x: 0, y: 0, width: 400, height: 500 },
  });
  host.setGuestHole("pi.browser", { x: 0, y: 0, width: 400, height: 500 });

  host.setChromeSession("A");
  const first = host.navigate({ url: "https://example.test/a" }, "A");
  roots.at(-1).resolve(null);
  await settled();
  loads.at(-1).finish();
  await first;
  assert.equal(visible, true);

  host.rememberLocation("B", "https://example.test/b");
  host.setChromeSession("B");
  assert.equal(visible, false);
  roots.at(-1).resolve(null);
  await settled();
  assert.equal(visible, false);
  loads.at(-1).finish();
  await settled();
  assert.equal(visible, true);
  assert.equal(state.url, "https://example.test/b");
});
