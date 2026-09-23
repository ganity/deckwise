import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../../../scripts/dev-electron.mjs", import.meta.url), "utf8");

test("development launcher repairs an unavailable Linux DISPLAY", () => {
  assert.match(source, /resolveLinuxDisplayEnvironment/);
  assert.match(source, /xdpyinfo/);
  assert.match(source, /XDG_RUNTIME_DIR/);
  assert.match(source, /gdm.*Xauthority/);
});
