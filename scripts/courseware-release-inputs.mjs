import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, readFile, readdir, readlink, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const digest = bytes => createHash("sha256").update(bytes).digest("hex");
export const fileDigest = async path => digest(await readFile(path));

export async function fingerprintDirectory(directory) {
  const root = await realpath(directory), files = [];
  async function walk(path, prefix = "") {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name, file = join(path, entry.name);
      if (entry.isSymbolicLink()) {
        const target = relative(root, await realpath(file));
        assert(target.split(/[\\/]/)[0] !== ".." && !isAbsolute(target), "Packaged symlink leaves its resources");
        files.push({ path: name, link: await readlink(file) });
      } else if (entry.isDirectory()) await walk(file, name);
      else { assert(entry.isFile(), "Invalid packaged entry"); files.push({ path: name, sha256: await fileDigest(file) }); }
    }
  }
  await walk(root);
  return digest(JSON.stringify(files));
}

/** Check the actual inventory, not just the presence of a receipt. */
export async function verifyInventory(directory, manifestName) {
  assert((await lstat(directory)).isDirectory(), "Bundle directory must not be a symlink");
  const manifestPath = join(directory, manifestName);
  assert((await lstat(manifestPath)).isFile(), "Bundle manifest must be a regular file");
  const bytes = await readFile(manifestPath);
  assert(bytes.length <= 10 * 1024 * 1024, "Bundle manifest is too large");
  const manifest = JSON.parse(bytes), expected = new Map();
  assert(Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= 20000, "Invalid bundle inventory");
  for (const file of manifest.files) {
    assert(typeof file.path === "string" && !file.path.includes("\\") && !file.path.includes(":") &&
      file.path !== manifestName && file.path.split("/").every(part => part && part !== "." && part !== ".."), "Invalid bundle path");
    assert(!expected.has(file.path), "Duplicate bundle path");
    assert(Number.isSafeInteger(file.bytes) && file.bytes >= 0 && /^[a-f0-9]{64}$/.test(file.sha256), "Invalid file identity");
    expected.set(file.path, file);
  }
  let count = 0;
  async function walk(path, prefix = "") {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      assert(!entry.isSymbolicLink(), `Symlink in bundle: ${entry.name}`);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(path, entry.name), relative);
      else {
        assert(entry.isFile(), `Invalid bundle entry: ${relative}`);
        if (relative === manifestName) continue;
        const file = expected.get(relative);
        assert(file, `Unlisted bundle file: ${relative}`);
        const content = await readFile(join(path, entry.name));
        assert.equal(content.length, file.bytes, `Size mismatch: ${relative}`);
        assert.equal(digest(content), file.sha256, `Hash mismatch: ${relative}`);
        count++;
      }
    }
  }
  await walk(directory);
  assert.equal(count, expected.size, "Bundle files are missing");
  return { manifest, sha256: digest(bytes) };
}

export async function inspectCoursewareInputs(root, { platform = process.platform, arch = process.arch } = {}) {
  const resources = join(root, "apps/desktop/resources");
  const wise = await verifyInventory(join(resources, "wiseoffice"), "deckwise-bundle.json");
  const marker = JSON.parse(await readFile(join(resources, "wiseoffice/deckwise-maic-integration.json"), "utf8"));
  assert(wise.manifest.version === 1 && wise.manifest.contentEditor === "maic" && marker.contentEditor === "maic" &&
    marker.nativeCheckpointEditor === "native-teaching" && /^[a-f0-9]{40}$/.test(wise.manifest.commit) &&
    typeof wise.manifest.dirty === "boolean" && marker.commit === wise.manifest.commit && marker.dirty === wise.manifest.dirty,
    "Invalid paired WiseOffice provenance");
  assert(/^[a-f0-9]{40}$/.test(marker.desktopCommit) && typeof marker.desktopDirty === "boolean" &&
    marker.desktopCommit === wise.manifest.desktopCommit && marker.desktopDirty === wise.manifest.desktopDirty,
    "Rebuild WiseOffice with Desktop integration provenance before packaging");
  for (const path of ["module.html", "sdkjs/slide/sdk-all-min.js", "web-apps/apps/presentationeditor/main/index.html",
    "sdkjs/common/wasm/x2t/x2t.wasm.br", "deckwise-runtime/teaching-preview.mjs"])
    assert(wise.manifest.files.some(file => file.path === path), `Missing WiseOffice resource: ${path}`);
  const worker = await verifyInventory(join(resources, "pptx-worker"), "manifest.json");
  assert(["LOCAL_LINUX_WORKER_BUNDLE", "LOCAL_NATIVE_WORKER_BUNDLE"].includes(worker.manifest.status), "Invalid worker status");
  assert.equal(worker.manifest.platform, platform, "Worker platform differs from package target");
  assert.equal(worker.manifest.arch, arch, "Worker architecture differs from package target");
  for (const name of ["pptx-worker.mjs", "authoring.mjs"]) {
    assert(worker.manifest.files.some(file => file.path === name), `Missing worker resource: ${name}`);
    assert.equal(await fileDigest(join(resources, "pptx-worker", name)),
      await fileDigest(join(root, "packages/courseware-runtime/dist", name)), `Staged compiler and current build differ: ${name}`);
  }
  return { platform, arch, documentCommit: wise.manifest.commit, documentDirty: wise.manifest.dirty,
    integratedDesktopCommit: marker.desktopCommit, integratedDesktopDirty: marker.desktopDirty,
    wiseofficeSha256: wise.sha256, workerSha256: worker.sha256,
    nativeSdkSha256: wise.manifest.files.find(file => file.path === "sdkjs/slide/sdk-all-min.js").sha256 };
}

export function assertCoursewareLock(lock, inputs) {
  assert.equal(lock.schemaVersion, "deckwise-courseware-inputs/1", "Unsupported courseware input lock");
  assert.deepEqual(lock.inputs, inputs, "Frozen courseware inputs differ from package inputs");
}

export function sourceIdentity(root) {
  const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  return { commit: git(["rev-parse", "HEAD"]), dirty: git(["status", "--porcelain", "--untracked-files=normal"]).length > 0 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, path] = process.argv.slice(2);
  assert(["--freeze", "--check"].includes(operation) && path && process.argv.length === 4,
    "Usage: courseware-release-inputs.mjs --freeze <new lock.json> | --check <lock.json>");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const inputs = await inspectCoursewareInputs(root), source = sourceIdentity(root);
  if (operation === "--freeze") {
    await writeFile(resolve(path), JSON.stringify({ schemaVersion: "deckwise-courseware-inputs/1", source, inputs }, null, 2) + "\n", { flag: "wx" });
    console.log(JSON.stringify({ status: "INPUTS_PINNED_NOT_ACCEPTED", source, inputs }));
  } else {
    const lock = JSON.parse(await readFile(resolve(path), "utf8"));
    assertCoursewareLock(lock, inputs);
    assert.equal(lock.source.commit, source.commit, "Desktop commit differs from input lock");
    console.log(JSON.stringify({ status: "VERIFIED_INPUTS_NOT_ACCEPTED", source, inputs }));
  }
}
