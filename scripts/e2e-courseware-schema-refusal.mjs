/** Actual packaged fatal-schema notice; disposable DB/profile and local identity only. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { coursewareLaunch } from "./e2e/boot.mjs";

assert(process.env.DECKWISE_E2E_PACKAGE_ROOT && process.env.DECKWISE_E2E_OUTPUT);
const launch = coursewareLaunch();
const require = createRequire(new URL("../packages/courseware-runtime/package.json", import.meta.url));
const { _electron, expect } = require("@playwright/test");
const run = promisify(execFile);
const out = resolve(process.env.DECKWISE_E2E_OUTPUT);
await mkdir(out, { recursive: false });
const temp = await mkdtemp(join(tmpdir(), "deckwise-schema-refusal-"));
await mkdir(join(temp, "data"));
const database = join(temp, "data/pi.sqlite");
await run("python3", ["-c", "import sqlite3,sys; d=sqlite3.connect(sys.argv[1]); d.execute('PRAGMA journal_mode=WAL'); d.execute('CREATE TABLE retained(value TEXT)'); d.execute(\"INSERT INTO retained VALUES ('keep')\"); d.execute('PRAGMA user_version=25'); d.commit(); d.close()", database]);
const hash = async () => createHash("sha256").update(await readFile(database)).digest("hex");
const before = await hash();
const report = { status: "RUNNING", packaged: true, paidCalls: false, identityFixture: true, sandbox: "--no-sandbox", checks: [] };
const logs = [];
let app;
try {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/api.?key|secret|token|password|proxy/i.test(key) && !key.startsWith("PI_DESKTOP_") && !key.startsWith("DECKWISE_")));
  app = await _electron.launch({ executablePath: launch.executablePath, cwd: launch.cwd,
    args: ["--no-sandbox", `--user-data-dir=${join(temp, "profile")}`, ...launch.args],
    env: { ...env, ELECTRON_RUN_AS_NODE: "", ELECTRON_RENDERER_URL: "", PI_DESKTOP_DATA_DIR: join(temp, "data"),
      DECKWISE_PLATFORM_BASE_URL: "http://127.0.0.1:9/test-platform", PI_DESKTOP_PLUGIN_MARKET_URL: "http://127.0.0.1:9/catalog.json" }, timeout: 60_000 });
  for (const stream of [app.process().stdout, app.process().stderr]) stream.on("data", bytes => logs.push(String(bytes)));
  const page = await app.firstWindow({ timeout: 60_000 });
  await page.waitForFunction(() => !!window.piDesktop);
  report.runtime = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, appPath: app.getAppPath(), executablePath: process.execPath }));
  assert.equal(report.runtime.appPath, join(launch.cwd, "resources/app.asar"));
  await app.evaluate(({ session }) => session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    callback({ cancel: /^https?:$/.test(url.protocol) && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) });
  }));
  const channels = await page.evaluate(() => window.piDesktop.channels);
  await expect.poll(() => page.evaluate(async () => {
    const { channels, invoke } = window.piDesktop;
    const result = await invoke(channels.invoke.appHostStatus);
    return result.ok ? result.data : null;
  }), { timeout: 15_000 }).toMatchObject({ ok: false, fatal: true,
    message: "DB_SCHEMA_TOO_NEW", schema: { found: 25, supported: 24 } });
  await expect(page.locator(".backend-banner.fatal")).toHaveCount(0);
  report.checks.push("Boot refusal is retained before the authenticated shell mounts");
  await app.evaluate(({ ipcMain, BrowserWindow }, channels) => {
    const state = { status: "authenticated", profile: { userId: 1, userName: "Schema refusal fixture", edition: "EDUCATION", role: "TEACHER", pcAllowed: true } };
    for (const key of ["authRestore", "authStartQr"]) {
      ipcMain.removeHandler(channels.invoke[key]); ipcMain.handle(channels.invoke[key], () => ({ ok: true, data: state }));
    }
    const window = BrowserWindow.getAllWindows()[0];
    const send = window.webContents.send.bind(window.webContents);
    window.webContents.send = (channel, ...args) => send(channel, ...(channel === channels.event.authChanged ? [state] : args));
  }, channels);
  await page.reload();
  const banner = page.locator(".backend-banner.fatal");
  await expect(banner).toContainText("数据库 schema 25，此版本仅支持 24", { timeout: 30_000 });
  await expect(banner).toContainText("请安装上次打开这些数据的更新版本");
  await expect(banner.getByRole("button")).toBeVisible();
  report.banner = await banner.innerText();
  await page.screenshot({ path: join(out, "schema-refusal.png") });
  report.checks.push("Actual packaged fatal banner shows schema25/support24 and tells the teacher to install the newer build");
  await page.reload();
  await expect(banner).toContainText("数据库 schema 25，此版本仅支持 24", { timeout: 15_000 });
  report.checks.push("Renderer reload retains the same specific fatal notice");
  assert.equal(await hash(), before);
  report.checks.push("Rejected future database bytes remain unchanged");
  report.status = "PASS_PACKAGED_SCHEMA_NOTICE";
} catch (error) {
  report.status = "FAIL"; report.error = String(error.stack || error); process.exitCode = 1;
  if (app) {
    const page = await app.firstWindow().catch(() => null);
    report.body = await page?.locator("body").innerText().catch(() => "unavailable");
    await page?.screenshot({ path: join(out, "failure.png") }).catch(() => {});
  }
} finally {
  if (app) {
    const child = app.process();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once("exit", resolve));
      await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await exited;
    }
  }
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(join(out, "desktop.log"), logs.join(""));
  await rm(temp, { recursive: true, force: true });
}
console.log(report.status);
