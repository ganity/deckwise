import assert from "node:assert/strict";
import test from "node:test";
import { recoverRendererAfterGone } from "../electron/main/renderer-recovery.ts";

test("reloads only an unexpectedly exited live renderer", () => {
  for (const [details, overrides, expected] of [
    [{ reason: "crashed", exitCode: 1 }, {}, true],
    [{ reason: "clean-exit", exitCode: 0 }, {}, false],
    [{ reason: "crashed", exitCode: 1 }, { quitting: true }, false],
    [{ reason: "crashed", exitCode: 1 }, { windowCloseAccepted: true }, false],
    [{ reason: "crashed", exitCode: 1 }, { isCurrentWindow: false }, false],
    [{ reason: "crashed", exitCode: 1 }, { windowDestroyed: true }, false],
    [{ reason: "crashed", exitCode: 1 }, { webContentsDestroyed: true }, false],
  ]) {
    let reloads = 0;
    const logs = [];
    assert.equal(recoverRendererAfterGone(details, {
      isCurrentWindow: true,
      quitting: false,
      windowCloseAccepted: false,
      windowDestroyed: false,
      webContentsDestroyed: false,
      ...overrides,
      reload: () => { reloads++; },
      log: (entry, reloaded) => logs.push({ entry, reloaded }),
    }), expected);
    assert.equal(reloads, Number(expected));
    assert.deepEqual(logs, [{ entry: details, reloaded: expected }]);
  }
});
