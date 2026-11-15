import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assertCoursewareLock, digest, fileDigest, fingerprintDirectory, inspectCoursewareInputs, sourceIdentity, verifyInventory } from "../../../scripts/courseware-release-inputs.mjs";

function target(context) {
  const arch = ["ia32", "x64", "armv7l", "arm64", "universal"][context.arch];
  assert(arch, "Unknown package target architecture");
  return { platform: context.electronPlatformName, arch };
}

async function verifiedInputs(context) {
  const root = resolve(context.packager.projectDir, "../..");
  const inputs = await inspectCoursewareInputs(root, target(context));
  if (process.env.DECKWISE_COURSEWARE_RELEASE === "1") {
    assert(process.env.DECKWISE_COURSEWARE_LOCK, "Stage the pinned courseware input lock before release packaging");
    const lock = JSON.parse(await readFile(process.env.DECKWISE_COURSEWARE_LOCK, "utf8"));
    assertCoursewareLock(lock, inputs);
    const source = sourceIdentity(root);
    assert.equal(lock.source?.commit, source.commit, "Desktop commit differs from frozen release inputs");
    assert(!source.dirty && lock.source.dirty === false && !inputs.documentDirty && !inputs.integratedDesktopDirty,
      "Release requires committed Desktop and Document sources; development snapshots are not release candidates");
    assert.equal(inputs.integratedDesktopCommit, source.commit, "WiseOffice embeds a different Desktop integration revision");
  }
  return inputs;
}

export async function beforePack(context) { await verifiedInputs(context); }

export async function afterPack(context) {
  const root = resolve(context.packager.projectDir, "../..");
  const inputs = await verifiedInputs(context);
  const resources = context.electronPlatformName === "darwin"
    ? join(context.appOutDir, context.packager.appInfo.productFilename + ".app/Contents/Resources") : join(context.appOutDir, "resources");
  const wise = await verifyInventory(join(resources, "wiseoffice"), "deckwise-bundle.json");
  const worker = await verifyInventory(join(resources, "pptx-worker"), "manifest.json");
  assert.equal(wise.sha256, inputs.wiseofficeSha256, "Packaged WiseOffice differs from verified inputs");
  assert.equal(worker.sha256, inputs.workerSha256, "Packaged worker differs from verified inputs");
  const content = { schemaVersion: "deckwise-courseware-candidate/1", source: sourceIdentity(root), inputs,
    appSha256: await fingerprintDirectory(context.appOutDir),
    resourcesSha256: await fingerprintDirectory(resources),
    appAsarSha256: await fileDigest(join(resources, "app.asar")),
    hostSha256: await fileDigest(join(resources, "bin", context.electronPlatformName === "win32" ? "pi-desktop-host-core.exe" : "pi-desktop-host-core")),
    agentSha256: await fileDigest(join(resources, "agent-runtime/sidecar.js")),
    acceptance: "NOT_RUN" };
  assert.deepEqual(await verifiedInputs(context), inputs, "Courseware inputs changed during packaging");
  await writeFile(join(context.appOutDir, "courseware-candidate.json"), JSON.stringify({
    ...content, candidateId: digest(JSON.stringify(content)),
  }, null, 2) + "\n", { flag: "wx" });
}

// Native signing changes binary bytes; keep that identity outside the signed app.
export async function afterSign(context) {
  if (context.electronPlatformName === "win32") return;
  const resources = context.electronPlatformName === "darwin"
    ? join(context.appOutDir, context.packager.appInfo.productFilename + ".app/Contents/Resources") : join(context.appOutDir, "resources");
  await sealResources(context.appOutDir, resources);
}

export async function afterAllArtifactBuild(context) {
  if ([...context.platformToTargets.keys()].some(platform => platform.nodeName === "win32")) {
    // NSIS adds and signs resources/elevate.exe after afterSign.
    const directories = (await readdir(context.outDir)).filter(name => /^win.*-unpacked$/.test(name));
    assert(directories.length > 0, "Windows package output is missing");
    for (const name of directories) {
      const directory = join(context.outDir, name);
      await sealResources(directory, join(directory, "resources"));
    }
  }
  return [];
}

async function sealResources(directory, resources) {
  const candidate = JSON.parse(await readFile(join(directory, "courseware-candidate.json"), "utf8"));
  await writeFile(join(directory, "courseware-post-sign.json"), JSON.stringify({
    schemaVersion: "deckwise-courseware-post-sign/1", candidateId: candidate.candidateId,
    resourcesSha256: await fingerprintDirectory(resources),
  }, null, 2) + "\n", { flag: "wx" });
}
