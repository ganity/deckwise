import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(process.argv.length, 5, "Supply Office root, AppImage and unpacked root");
const require = createRequire(join(resolve(process.argv[2]), "package.json"));
const { _electron, expect } = require("@playwright/test");
const executablePath = resolve(process.argv[3]);
const unpacked = resolve(process.argv[4]);
const output = fileURLToPath(new URL("./", import.meta.url));
const temp = await mkdtemp(join(tmpdir(), "deckwise-appimage-smoke-"));
const paths = ["app.asar", "bin/pi-desktop-host-core", "agent-runtime/sidecar.js",
  "pptx-worker/pptx-worker.mjs", "pptx-worker/authoring.mjs"];
const expected = Object.fromEntries(await Promise.all(paths.map(async (name) =>
  [name, createHash("sha256").update(await readFile(join(unpacked, "resources", name))).digest("hex")])));
const report = { status: "RUNNING", executablePath, paidCalls: false,
  scope: "AppImage launcher, packaged Main UI and five runtime payload hashes",
  sandbox: "--no-sandbox", temporaryData: temp };
let app;
try {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/api.?key|secret|token|password|proxy|^PI_DESKTOP_HOST_BIN$|^DECKWISE_PPTX_/i.test(key)));
  app = await _electron.launch({ executablePath,
    args: ["--no-sandbox", `--user-data-dir=${join(temp, "profile")}`],
    env: { ...env, APPIMAGE_EXTRACT_AND_RUN: "1", ELECTRON_RUN_AS_NODE: "",
      ELECTRON_RENDERER_URL: "", PI_DESKTOP_DATA_DIR: join(temp, "data"),
      DECKWISE_PLATFORM_BASE_URL: "http://127.0.0.1:9/appimage-smoke" }, timeout: 120_000 });
  const page = await app.firstWindow({ timeout: 120_000 });
  await page.waitForFunction(() => !!window.piDesktop, {}, { timeout: 30_000 });
  await expect(page.locator(".auth-refresh")).toBeVisible({ timeout: 60_000 });
  report.runtime = await app.evaluate(({ app }, names) => {
    const fs = process.getBuiltinModule("node:module")
      .createRequire(`${app.getAppPath()}/package.json`)("original-fs");
    const crypto = process.getBuiltinModule("node:crypto");
    const path = process.getBuiltinModule("node:path");
    return { packaged: app.isPackaged, appPath: app.getAppPath(), mainPid: process.pid,
      resourcesPath: process.resourcesPath, executablePath: process.execPath,
      hashes: Object.fromEntries(names.map((name) => [name,
        crypto.createHash("sha256").update(fs.readFileSync(path.join(process.resourcesPath, name))).digest("hex")])) };
  }, paths);
  assert.equal(report.runtime.packaged, true);
  assert.deepEqual(report.runtime.hashes, expected);
  await page.screenshot({ path: join(output, "appimage-window.png") });
  report.status = "PASS_APPIMAGE_LAUNCH_AND_PAYLOAD";
} catch (error) {
  report.status = "FAIL";
  report.error = String(error.stack || error);
} finally {
  if (app) {
    let timer;
    try {
      await Promise.race([
        app.evaluate(({ app }) => { setImmediate(() => app.exit(0)); }).catch(() => {})
          .then(() => app.close()),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Disposable AppImage exit timed out")), 15_000); }),
      ]);
      report.cleanup = "Disposable AppImage exited";
    } catch (error) {
      report.status = "FAIL";
      report.cleanupError = String(error);
      app.process().kill("SIGTERM");
    } finally { clearTimeout(timer); }
  }
  await writeFile(join(output, "appimage-smoke.json"), JSON.stringify(report, null, 2) + "\n");
}
console.log(report.status);
if (!report.status.startsWith("PASS")) process.exitCode = 1;
