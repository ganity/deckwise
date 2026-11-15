import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fingerprintDirectory, sourceIdentity, verifyInventory, inspectCoursewareInputs, assertCoursewareLock } from "../../../scripts/courseware-release-inputs.mjs";
import { beforePack, afterPack } from "../build/courseware-release.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
test("electron-builder resolves both configured named hooks", async () => {
  const require = createRequire(import.meta.url);
  const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
  const { resolveFunction } = builderRequire("app-builder-lib/out/util/resolve.js");
  const module = fileURLToPath(new URL("../build/courseware-release.mjs", import.meta.url));
  assert.equal(await resolveFunction("beforePack", module, "beforePack", process.cwd()), beforePack);
  assert.equal(await resolveFunction("afterPack", module, "afterPack", process.cwd()), afterPack);
});
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "courseware-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function file(path, value) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), value); }
  async function bundle(path, name, metadata, values) {
    const files = [];
    for (const [fileName, value] of Object.entries(values)) {
      await file(`${path}/${fileName}`, value);
      files.push({ path: fileName, bytes: Buffer.byteLength(value), sha256: hash(value) });
    }
    await file(`${path}/${name}`, JSON.stringify({ ...metadata, files }));
  }
  const integration = { version: 1, contentEditor: "maic", nativeCheckpointEditor: "native-teaching", commit: "a".repeat(40), dirty: false,
    desktopCommit: "b".repeat(40), desktopDirty: false };
  await bundle("apps/desktop/resources/wiseoffice", "deckwise-bundle.json", integration, {
    "module.html": "editor", "sdkjs/slide/sdk-all-min.js": "sdk", "web-apps/apps/presentationeditor/main/index.html": "presentation",
    "sdkjs/common/wasm/x2t/x2t.wasm.br": "wasm", ".deckwise/teaching-preview.mjs": "preview",
    "deckwise-maic-integration.json": JSON.stringify(integration),
  });
  await bundle("apps/desktop/resources/pptx-worker", "manifest.json", {
    status: "LOCAL_LINUX_WORKER_BUNDLE", platform: "linux", arch: "x64",
  }, { "pptx-worker.mjs": "worker", "authoring.mjs": "compiler" });
  await file("packages/courseware-runtime/dist/pptx-worker.mjs", "worker");
  await file("packages/courseware-runtime/dist/authoring.mjs", "compiler");
  return { root, file, wise: join(root, "apps/desktop/resources/wiseoffice") };
}

test("verified bundle rejects changed, missing, added and unsafe files", async t => {
  const f = await fixture(t);
  await verifyInventory(f.wise, "deckwise-bundle.json");
  await f.file("apps/desktop/resources/wiseoffice/module.html", "changed");
  await assert.rejects(verifyInventory(f.wise, "deckwise-bundle.json"), /mismatch/);
  await f.file("apps/desktop/resources/wiseoffice/module.html", "editor");
  await f.file("apps/desktop/resources/wiseoffice/extra.js", "unexpected");
  await assert.rejects(verifyInventory(f.wise, "deckwise-bundle.json"), /Unlisted/);
  await rm(join(f.wise, "extra.js"));
  await rm(join(f.wise, "module.html"));
  await assert.rejects(verifyInventory(f.wise, "deckwise-bundle.json"), /missing/i);
  await f.file("apps/desktop/resources/wiseoffice/module.html", "editor");
  const path = join(f.wise, "deckwise-bundle.json"), manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.files[0].path = "../outside";
  await writeFile(path, JSON.stringify(manifest));
  await assert.rejects(verifyInventory(f.wise, "deckwise-bundle.json"), /Invalid bundle path/);
});

test("bundle symlinks and duplicate entries are rejected", async t => {
  const f = await fixture(t);
  await symlink(join(f.wise, "module.html"), join(f.wise, "linked.html"));
  await assert.rejects(verifyInventory(f.wise, "deckwise-bundle.json"), /Symlink/);
  await rm(join(f.wise, "linked.html"));
  const path = join(f.wise, "deckwise-bundle.json"), manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.files.push(manifest.files[0]);
  await writeFile(path, JSON.stringify(manifest));
  await assert.rejects(verifyInventory(f.wise, "deckwise-bundle.json"), /Duplicate/);
});

test("paired lock rejects stale compiler, wrong architecture and another bundle", async t => {
  const f = await fixture(t), options = { platform: "linux", arch: "x64" };
  const inputs = await inspectCoursewareInputs(f.root, options);
  assertCoursewareLock({ schemaVersion: "deckwise-courseware-inputs/1", inputs }, inputs);
  assert.throws(() => assertCoursewareLock({ schemaVersion: "deckwise-courseware-inputs/1", inputs: { ...inputs, documentCommit: "b".repeat(40) } }, inputs), /differ/);
  await assert.rejects(inspectCoursewareInputs(f.root, { ...options, arch: "arm64" }), /architecture/);
  await f.file("packages/courseware-runtime/dist/authoring.mjs", "new compiler");
  await assert.rejects(inspectCoursewareInputs(f.root, options), /compiler.*differ/i);
});

test("packaging checks actual resources and records an unaccepted artifact identity", async t => {
  const f = await fixture(t);
  execFileSync("git", ["init", "--quiet", f.root]);
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "--quiet", "-m", "Fixture"], { cwd: f.root });
  const context = { arch: 1, electronPlatformName: "linux", appOutDir: join(f.root, "package"),
    packager: { projectDir: join(f.root, "apps/desktop") } };
  await beforePack(context);
  await cp(join(f.root, "apps/desktop/resources"), join(context.appOutDir, "resources"), { recursive: true });
  for (const path of ["app.asar", "bin/pi-desktop-host-core", "agent-runtime/sidecar.js"]) await f.file(`package/resources/${path}`, path);
  await afterPack(context);
  const report = JSON.parse(await readFile(join(context.appOutDir, "courseware-candidate.json"), "utf8"));
  assert.equal(report.acceptance, "NOT_RUN");
  assert.equal(report.appAsarSha256, hash("app.asar"));
  assert.match(report.resourcesSha256, /^[a-f0-9]{64}$/);
  assert.match(report.appSha256, /^[a-f0-9]{64}$/);
  const { candidateId, ...content } = report;
  assert.equal(candidateId, hash(JSON.stringify(content)));
  await f.file("package/resources/wiseoffice/module.html", "tampered");
  await assert.rejects(afterPack(context), /mismatch/);
  const prior = process.env.DECKWISE_COURSEWARE_RELEASE, lock = process.env.DECKWISE_COURSEWARE_LOCK;
  t.after(() => {
    if (prior === undefined) delete process.env.DECKWISE_COURSEWARE_RELEASE; else process.env.DECKWISE_COURSEWARE_RELEASE = prior;
    if (lock === undefined) delete process.env.DECKWISE_COURSEWARE_LOCK; else process.env.DECKWISE_COURSEWARE_LOCK = lock;
  });
  process.env.DECKWISE_COURSEWARE_RELEASE = "1";
  delete process.env.DECKWISE_COURSEWARE_LOCK;
  await assert.rejects(beforePack(context), /pinned courseware input lock/);
  const lockFile = join(f.root, "inputs.json"), inputs = await inspectCoursewareInputs(f.root, { platform: "linux", arch: "x64" });
  process.env.DECKWISE_COURSEWARE_LOCK = lockFile;
  await writeFile(lockFile, JSON.stringify({ schemaVersion: "deckwise-courseware-inputs/1", inputs, source: sourceIdentity(f.root) }));
  await assert.rejects(beforePack(context), /committed Desktop and Document/);
  await assert.rejects(afterPack(context), /committed Desktop and Document/);
  await writeFile(lockFile, JSON.stringify({ schemaVersion: "deckwise-courseware-inputs/1", inputs: { ...inputs, workerSha256: "0".repeat(64) } }));
  await assert.rejects(beforePack(context), /Frozen courseware inputs differ/);
  await f.file(".gitignore", "*\n");
  execFileSync("git", ["add", "--force", ".gitignore"], { cwd: f.root });
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Ignore generated fixture inputs"], { cwd: f.root });
  const source = sourceIdentity(f.root);
  assert.equal(source.dirty, false);
  const freeze = async () => writeFile(lockFile, JSON.stringify({ schemaVersion: "deckwise-courseware-inputs/1", source,
    inputs: await inspectCoursewareInputs(f.root, { platform: "linux", arch: "x64" }) }));
  await freeze();
  await assert.rejects(beforePack(context), /different Desktop integration revision/);
  const markerFile = join(f.wise, "deckwise-maic-integration.json"), receiptFile = join(f.wise, "deckwise-bundle.json");
  const marker = JSON.parse(await readFile(markerFile, "utf8")), receipt = JSON.parse(await readFile(receiptFile, "utf8"));
  marker.desktopCommit = receipt.desktopCommit = source.commit;
  const contentBytes = JSON.stringify(marker), markerEntry = receipt.files.find(file => file.path === "deckwise-maic-integration.json");
  Object.assign(markerEntry, { bytes: Buffer.byteLength(contentBytes), sha256: hash(contentBytes) });
  await writeFile(markerFile, contentBytes); await writeFile(receiptFile, JSON.stringify(receipt));
  await freeze();
  await beforePack(context);
});

test("resource identity covers ancillary files and rejects escaping symlinks", async t => {
  const f = await fixture(t), before = await fingerprintDirectory(f.wise);
  await f.file("apps/desktop/resources/wiseoffice/module.html", "changed");
  assert.notEqual(await fingerprintDirectory(f.wise), before);
  await symlink(join(f.root, "packages"), join(f.wise, "outside"));
  await assert.rejects(fingerprintDirectory(f.wise), /symlink leaves/);
});
