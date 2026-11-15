/** Provider-free regression evidence. A pass is not installer or production-model qualification. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { digest, fileDigest, fingerprintDirectory, inspectCoursewareInputs, sourceIdentity } from "./courseware-release-inputs.mjs";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
assert(process.argv.length === 2 && process.env.DECKWISE_E2E_OUTPUT, "Set DECKWISE_E2E_OUTPUT to a new evidence directory");
assert(!process.env.DECKWISE_E2E_PACKAGE_ROOT, "This source regression is not packaged installer acceptance");
const output = resolve(process.env.DECKWISE_E2E_OUTPUT);
await mkdir(output);
const JSZip = createRequire(new URL("../packages/courseware-runtime/package.json", import.meta.url))("jszip");
const report = { schemaVersion: "deckwise-courseware-regression/1", status: "RUNNING", releaseReady: false, paidCalls: false,
  startedAt: new Date().toISOString(), fixtures: {}, checks: [], limitations: [
    "Existing fixture replay; no fresh production-provider generation or billing validation.",
    "Source Electron execution; no installer, signing or other-platform qualification.",
    "Background editing controls Host responses; MAIC parity separately exercises the real Host.",
  ] };
const fixtureVars = { master: "DECKWISE_E2E_NATIVE_PPTX", scene: "DECKWISE_E2E_SCENE_PPTX", import: "DECKWISE_E2E_IMPORT_PPTX" };
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/api.?key|secret|token|password|proxy|paid|^DECKWISE_E2E_|^DECKWISE_PPTX_|^DECKWISE_EDITOR_URL$|^DECKWISE_PYTHON_RUNTIME_DIR$|^PI_DESKTOP_(HOST_BIN|DEV|DATA_DIR)$|^ELECTRON_(RUN_AS_NODE|EXECUTABLE|RENDERER_URL)$/i.test(key)));
async function identity() {
  const paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--",
    "apps/desktop/electron", "apps/desktop/src", "apps/desktop/build", "apps/desktop/test", "apps/desktop/resources/editor-host",
    "apps/desktop/package.json", "apps/desktop/electron.vite.config.ts", "packages", "crates", "scripts", ".github/workflows",
    "Cargo.toml", "Cargo.lock", "package.json", "pnpm-lock.yaml"],
    { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean).sort();
  const files = [];
  for (const path of paths) {
    try { files.push({ path, sha256: await fileDigest(join(root, path)) }); }
    catch (error) { if (error.code !== "ENOENT") throw error; files.push({ path, deleted: true }); }
  }
  const builds = {};
  for (const path of ["apps/desktop/out", "packages/shared/dist", "packages/courseware-runtime/dist", "packages/agent-runtime/dist"])
    builds[path] = await fingerprintDirectory(join(root, path));
  builds.host = await fileDigest(join(root, "target/debug", process.platform === "win32" ? "pi-desktop-host-core.exe" : "pi-desktop-host-core"));
  builds.electron = await fileDigest(resolveElectronBinary(root).electronBinary);
  return { source: sourceIdentity(root), codeSha256: digest(JSON.stringify(files)), builds, inputs: await inspectCoursewareInputs(root) };
}
async function run(name, script, env, readReport, args = []) {
  console.log("START", name);
  let log = "";
  const child = spawn(process.execPath, [join(root, "scripts", script), ...args], { cwd: root, env: { ...environment, ...env },
    timeout: 360_000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", bytes => { log += bytes; });
  let code;
  try { code = await new Promise((done, reject) => { child.once("error", reject); child.once("exit", done); }); }
  finally { await writeFile(join(output, `${name}.log`), log); }
  assert.equal(code, 0, `${name} failed; inspect ${join(output, `${name}.log`)}\n${log.slice(-2000)}`);
  await readReport();
  report.checks.push(name);
  console.log("PASS", name);
}
try {
  for (const [name, variable] of Object.entries(fixtureVars)) {
    assert(process.env[variable], `Missing ${variable}; all three distinct fixtures are required`);
    const path = resolve(process.env[variable]), bytes = await readFile(path), zip = await JSZip.loadAsync(bytes);
    const pages = Object.keys(zip.files).filter(path => /^ppt\/slides\/slide\d+\.xml$/.test(path)).length;
    assert(pages > 0 && pages <= 6, `${name} fixture must have 1–6 pages`);
    report.fixtures[name] = { path, pages, sha256: digest(bytes) };
  }
  assert.equal(new Set(Object.values(report.fixtures).map(file => file.sha256)).size, 3, "Use three different courseware fixtures");
  await run("reference-prerequisites", "check-maic-courseware-parity.mjs", {}, async () => {}, ["--preflight"]);
  report.identity = await identity();
  const scene = join(output, "scene"), background = join(output, "background"), parity = join(output, "parity");
  await run("scene-transport", "e2e-courseware-scene-completion.mjs", { DECKWISE_E2E_OUTPUT: scene }, async () => {
    const result = JSON.parse(await readFile(join(scene, "report.json"), "utf8"));
    assert.equal(result.status, "PASS"); assert.equal(result.passed, 17); assert.equal(result.realProvider, false);
  });
  await run("native-background", "e2e-courseware-background-editing.mjs", {
    DECKWISE_E2E_OUTPUT: background, ...Object.fromEntries(Object.entries(fixtureVars).map(([name, key]) => [key, report.fixtures[name].path])),
  }, async () => {
    const result = JSON.parse(await readFile(join(background, "report.json"), "utf8"));
    assert.equal(result.passed, true); assert.equal(result.checks.length, 4);
  });
  await run("maic-quiz-parity", "check-maic-courseware-parity.mjs", { DECKWISE_E2E_OUTPUT: parity }, async () => {
    const result = JSON.parse(await readFile(join(parity, "parity-report.json"), "utf8"));
    assert.equal(result.status, "PASS"); assert.equal(result.electron?.status, "PASS"); assert(result.checks.length >= 5);
  });
  assert.deepEqual(await identity(), report.identity, "Source, builds or paired inputs changed during regression; run again");
  for (const file of Object.values(report.fixtures)) assert.equal(await fileDigest(file.path), file.sha256, "Input fixture changed during regression");
  report.status = "LOCAL_REGRESSION_PASS";
} catch (error) { report.status = "FAIL"; report.error = error.stack; process.exitCode = 1; console.error(error.message); }
finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`${report.status}: ${join(output, "report.json")}`);
}
