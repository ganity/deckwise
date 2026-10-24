import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { coursewareLaunch } from "../../../scripts/e2e/boot.mjs";

test("packaged courseware validation never supplies a source entry or accepts runtime overrides", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "courseware-launch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { DECKWISE_E2E_PACKAGE_ROOT: root };
  assert.throws(() => coursewareLaunch("/missing-source", env), /missing/);
  await mkdir(join(root, "resources"));
  await writeFile(join(root, "resources/app.asar"), "package fixture");
  await writeFile(join(root, "deckwise"), "binary fixture");
  assert.deepEqual(coursewareLaunch("/missing-source", env), {
    executablePath: join(root, "deckwise"), cwd: root, args: [], packaged: true,
  });
  for (const key of ["ELECTRON_EXECUTABLE", "PI_DESKTOP_HOST_BIN", "DECKWISE_PPTX_WORKER", "DECKWISE_PPTX_NODE", "DECKWISE_PYTHON_RUNTIME_DIR", "PI_DESKTOP_DEV", "ELECTRON_RENDERER_URL", "ELECTRON_RUN_AS_NODE"]) {
    assert.throws(() => coursewareLaunch(root, { ...env, [key]: "/source-override" }), /must not override/);
  }
});

test("source courseware validation retains its explicit host and Electron launch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "courseware-source-launch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appDir = join(root, "apps/desktop");
  for (const file of ["main/index.js", "renderer/index.html"]) {
    const dir = join(appDir, "out", file.split("/")[0]);
    await mkdir(dir, { recursive: true });
    await writeFile(join(appDir, "out", file), "source fixture");
  }
  assert.deepEqual(coursewareLaunch(root, { ELECTRON_EXECUTABLE: "/explicit-electron", PI_DESKTOP_HOST_BIN: "/explicit-host" }), {
    executablePath: "/explicit-electron", cwd: appDir, args: [appDir], packaged: false,
  });
});


test("music adoption CLI rejects source overrides before opening a packaged application", () => {
  const runner = fileURLToPath(new URL("../../../scripts/e2e-courseware-music-adoption.mjs", import.meta.url));
  const env = { ...process.env, DECKWISE_E2E_PACKAGE_ROOT: "/missing-package-music-gate" };
  for (const key of ["ELECTRON_EXECUTABLE", "PI_DESKTOP_HOST_BIN", "DECKWISE_PPTX_WORKER", "DECKWISE_PPTX_NODE", "DECKWISE_PYTHON_RUNTIME_DIR", "PI_DESKTOP_DEV", "ELECTRON_RENDERER_URL", "ELECTRON_RUN_AS_NODE"]) delete env[key];
  for (const option of ["--app", "--host"]) {
    const result = spawnSync(process.execPath, [runner, option, "/source-override"], { env, encoding: "utf8", timeout: 5000 });
    assert.ifError(result.error); assert.equal(result.status, 1);
    assert.match(result.stderr, /Packaged validation must not override --app or --host/);
  }
  for (const key of ["ELECTRON_EXECUTABLE", "PI_DESKTOP_HOST_BIN", "DECKWISE_PPTX_WORKER"]) {
    const result = spawnSync(process.execPath, [runner], { env: { ...env, [key]: "/source-override" }, encoding: "utf8", timeout: 5000 });
    assert.ifError(result.error); assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`Packaged validation must not override ${key}`));
  }
});
