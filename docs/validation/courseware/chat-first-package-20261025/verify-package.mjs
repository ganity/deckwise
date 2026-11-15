import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { lstat, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

assert.equal(process.argv.length, 4, "Supply worktree and unpacked package roots");
const root = resolve(process.argv[2]);
const app = join(root, "apps/desktop");
const pkg = resolve(process.argv[3]);
const resources = join(pkg, "resources");
const output = fileURLToPath(new URL("./", import.meta.url));
const require = createRequire(join(app, "package.json"));
const asar = createRequire(require.resolve("electron-builder"))("@electron/asar");
const run = promisify(execFile);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function listFiles(dir, prefix = "") {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(join(dir, entry.name), name));
    else files.push(name);
  }
  return files.sort();
}

const report = { status: "RUNNING", package: pkg, asarFiles: 0, resources: {},
  scope: "Current ASAR and changed Host/Agent/worker/resources; unchanged Python and PPT Master dependency acceptance is inherited, not rerun" };
try {
  for (const name of await listFiles(join(app, "out"))) {
    if (name.endsWith(".map")) continue;
    assert.deepEqual(asar.extractFile(join(resources, "app.asar"), `out/${name}`),
      await readFile(join(app, "out", name)), name);
    report.asarFiles++;
  }
  assert(asar.extractFile(join(resources, "app.asar"), "out/renderer/courseware-player.html"));
  const sources = [
    ["target/release/pi-desktop-host-core", "bin/pi-desktop-host-core"],
    ["packages/agent-runtime/dist-bundle", "agent-runtime"],
    ["apps/desktop/resources/skills", "skills"],
    ["apps/desktop/resources/plugins", "plugins"],
    ["apps/desktop/resources/editor-host", "editor-host"],
    ["apps/desktop/resources/pptx-worker", "pptx-worker"],
    ["apps/desktop/resources/models.dev", "models.dev"],
    ["apps/desktop/build/tray-icon.png", "tray-icon.png"],
  ];
  for (const [source, destination] of sources) {
    const from = join(root, source), to = join(resources, destination);
    const entries = (await lstat(from)).isDirectory() ? await listFiles(from) : [""];
    for (const name of entries) {
      if (destination === "pptx-worker" && name === "authoring.mjs") continue;
      const a = join(from, name), b = join(to, name);
      if ((await lstat(a)).isSymbolicLink())
        assert.equal(await readlink(b), await readlink(a), `${source}/${name}`);
      else assert.equal(sha256(await readFile(b)), sha256(await readFile(a)), `${source}/${name}`);
    }
    report.resources[destination] = { files: entries.length, bytesMatched: true };
  }
  const authoringHash = sha256(await readFile(join(root, "packages/courseware-runtime/dist/authoring.mjs")));
  assert.equal(sha256(await readFile(join(resources, "pptx-worker/authoring.mjs"))), authoringHash);
  report.resources["pptx-worker/authoring.mjs"] = { sha256: authoringHash, bytesMatched: true };
  report.worker = JSON.parse((await run(process.execPath,
    [join(root, "scripts/stage-pptx-worker.mjs"), "--check", join(resources, "pptx-worker")])).stdout);
  assert.equal(report.worker.status, "VERIFIED");
  for (const relative of ["runtime/python/bin/python3", "skills/ppt-master/SKILL.md"]) {
    const metadata = await lstat(join(resources, relative));
    assert(metadata.isFile() || metadata.isSymbolicLink(), relative);
  }
  report.inheritedDependencies = "Python and PPT Master files present; no repeated inventory or dependency test";
  report.status = "PASS_EXACT_CHANGED_PACKAGE_RESOURCES";
} catch (error) {
  report.status = "FAIL";
  report.error = String(error.stack || error);
}
await writeFile(join(output, "package-check.json"), JSON.stringify(report, null, 2) + "\n");
console.log(report.status);
if (report.status !== "PASS_EXACT_CHANGED_PACKAGE_RESOURCES") process.exitCode = 1;
