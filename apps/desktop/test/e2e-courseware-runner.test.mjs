import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const runner = fileURLToPath(new URL("../../../scripts/e2e-courseware.mjs", import.meta.url));
const canvas = fileURLToPath(new URL("../../../scripts/e2e-courseware-media-canvas.mjs", import.meta.url));
const canvasImages = fileURLToPath(new URL("../../../scripts/e2e-courseware-canvas-images.mjs", import.meta.url));
const env = { ...process.env };
for (const name of ["DECKWISE_E2E_OFFICE_ROOT", "DECKWISE_E2E_PPTX", "DECKWISE_EDITOR_URL", "DECKWISE_E2E_PACKAGE_ROOT", "PI_DESKTOP_HOST_BIN"]) delete env[name];

// Exercise the public CLI while replacing only the expensive Electron child.
function command(args, fixture, executable = process.execPath) {
  const preload = `import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const spawn = cp.spawn;
cp.spawn = (executable, args, options) => {
  process.stdout.write(JSON.stringify({ executable, args, stdio: options.stdio }) + '\\n');
  return spawn(${JSON.stringify(executable)}, ['-e', ${JSON.stringify(fixture)}], options);
};
syncBuiltinESMExports();`;
  return ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, runner, ...args];
}

test("a canvas child launch failure fails the public runner", () => {
  const result = spawnSync(process.execPath, command(["--case", "W15.1"], "", join(canvas, "missing-executable")), { env, encoding: "utf8", timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ENOTDIR|ENOENT/);
  assert.equal(result.signal, null);
});

for (const [testCase, script] of [["W15.1", canvas], ["W15.2", canvasImages]]) {
 for (const code of [0, 23]) {
  test(`${testCase} delegates to its canvas script and preserves exit ${code}`, () => {
    const result = spawnSync(process.execPath, command(["--case", testCase], `console.log('CANVAS_CHILD'); process.exit(${code});`), { env, encoding: "utf8", timeout: 5000 });
    assert.ifError(result.error);
    assert.equal(result.status, code, result.stderr);
    const [dispatch, marker] = result.stdout.trim().split("\n");
    assert.deepEqual(JSON.parse(dispatch), { executable: process.execPath, args: [script], stdio: "inherit" });
    assert.equal(marker, "CANVAS_CHILD");
    assert.equal(result.signal, null);
  });
 }
}

test("unknown or malformed cases are rejected before a child starts", () => {
  for (const args of [["--case", "W15.5"], ["W15.1"], ["--case", "W15.1", "extra"]]) {
    const result = spawnSync(process.execPath, command(args, "process.exit(0)"), { env, encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Supported invocation/);
    assert.equal(result.stdout, "");
  }
});

test("W03.3 selects independent native-undo and restart-recovery sessions", () => {
  for (const sourceChange of ["0", "1"]) {
    const result = spawnSync(process.execPath, command(["--case", "W03.3"],
      "console.log(JSON.stringify([process.env.DECKWISE_E2E_REASSOCIATE,process.env.DECKWISE_E2E_OFFICE_UNDO,process.env.DECKWISE_E2E_SOURCE_CHANGE]));"),
    { env: { ...env, DECKWISE_E2E_SOURCE_CHANGE: sourceChange }, encoding: "utf8", timeout: 5000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim().split("\n")[1]), ["1", sourceChange === "1" ? "0" : "1", sourceChange]);
  }
});

test("native W01.2 and W01.3 retain their Office environment validation", () => {
  for (const name of ["W01.2", "W01.3"]) {
    const result = spawnSync(process.execPath, command(["--case", name], "process.exit(0)"), { env, encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Missing DECKWISE_E2E_OFFICE_ROOT/);
    assert.equal(result.stdout, "");
  }
});

test("a signalled canvas child gives the runner the same signal", { skip: process.platform === "win32" }, () => {
  const result = spawnSync(process.execPath, command(["--case", "W15.1"], "process.kill(process.pid, 'SIGTERM')"), { env, encoding: "utf8", timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.status, null);
  assert.equal(result.signal, "SIGTERM", result.stderr);
});

test("runner termination is forwarded to the live canvas child", { skip: process.platform === "win32", timeout: 5000 }, async () => {
  const child = spawn(process.execPath, command(["--case", "W15.1"], "process.on('SIGTERM', () => { console.log('FORWARDED'); process.exit(41); }); console.log('READY'); setInterval(() => {}, 1000);"), { env, stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  let stdout = "";
  try {
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.stdout.on("data", bytes => { stdout += bytes; if (stdout.includes("READY")) resolve(); });
      child.once("exit", () => reject(new Error("Runner exited before its child was ready")));
    });
    child.kill("SIGTERM");
    const [code, signal] = await exited;
    assert.equal(code, 41);
    assert.equal(signal, null);
    assert.match(stdout, /FORWARDED/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});
