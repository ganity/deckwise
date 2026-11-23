import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../../../scripts/dev-electron.mjs", import.meta.url), "utf8");

test("development launcher repairs an unavailable Linux DISPLAY", () => {
  assert.match(source, /resolveLinuxDisplayEnvironment/);
  assert.match(source, /xdpyinfo/);
  assert.match(source, /XDG_RUNTIME_DIR/);
  assert.match(source, /gdm.*Xauthority/);
});

test("standard development launch stages the current worker while honoring explicit workers", () => {
  const launcher = fileURLToPath(new URL("../../../scripts/dev-electron.mjs", import.meta.url));
  const env = { ...process.env };
  delete env.DECKWISE_PPTX_WORKER;
  const launch = env => execFileSync(process.execPath, [launcher, "--help"], { env, encoding: "utf8" });
  assert.match(launch(env), /"files":\d+,"bytes":\d+/);
  assert.doesNotMatch(launch({ ...env, DECKWISE_PPTX_WORKER: "explicit-worker" }), /"files":/);
});
