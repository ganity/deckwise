import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { asar } from "../../../scripts/check-courseware-package-credentials.mjs";
import { digest, fileDigest, fingerprintDirectory } from "../../../scripts/courseware-release-inputs.mjs";
import { checkCoursewarePackage } from "../../../scripts/check-courseware-package.mjs";
import { artifactChecksums } from "../../../scripts/courseware-artifact-checksums.mjs";
import { afterSign } from "../build/courseware-release.mjs";

async function fixture(t, mac = false) {
  const root = await mkdtemp(join(tmpdir(), "courseware-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "package"), resources = join(directory, mac ? "DeckWise.app/Contents/Resources" : "resources");
  const file = async (name, bytes) => { const path = join(resources, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); };
  await file("bin/pi-desktop-host-core", "host"); await file("agent-runtime/sidecar.js", "agent");
  const source = join(root, "asar-source"); await mkdir(source); await writeFile(join(source, "main.js"), "// public code");
  await asar.createPackage(source, join(resources, "app.asar"));
  const inputs = { platform: mac ? "darwin" : "linux" };
  for (const [bundle, manifest, key] of [["wiseoffice", "deckwise-bundle.json", "wiseofficeSha256"], ["pptx-worker", "manifest.json", "workerSha256"]]) {
    await file(`${bundle}/public.js`, "// bundled code");
    const value = { files: [{ path: "public.js", bytes: 15, sha256: digest("// bundled code") }] };
    await file(`${bundle}/${manifest}`, JSON.stringify(value)); inputs[key] = await fileDigest(join(resources, bundle, manifest));
  }
  const candidate = { schemaVersion: "deckwise-courseware-candidate/1", source: { commit: "a".repeat(40), dirty: false }, inputs,
    appAsarSha256: await fileDigest(join(resources, "app.asar")), hostSha256: digest("host"), agentSha256: digest("agent") };
  const receipt = { ...candidate, candidateId: digest(JSON.stringify(candidate)) };
  await writeFile(join(directory, "courseware-candidate.json"), JSON.stringify(receipt));
  return { root, directory, resources, file, receipt, check: () => checkCoursewarePackage(directory, "a".repeat(40)) };
}

test("actual packaged resources reject missing dependencies, changed binaries, source drift and private state", async t => {
  const f = await fixture(t);
  assert.equal((await f.check()).status, "PASS");
  await assert.rejects(checkCoursewarePackage(f.directory, "b".repeat(40)), /different Desktop commit/);
  await rm(join(f.resources, "pptx-worker/public.js")); await assert.rejects(f.check(), /missing/);
  await f.file("pptx-worker/public.js", "// bundled code");
  await f.file("bin/pi-desktop-host-core", "modified"); await assert.rejects(f.check(), /changed/);
  await f.file("bin/pi-desktop-host-core", "host");
  await f.file(".deckwise/profile.json", "private fixture"); await assert.rejects(f.check(), /credentials\/state/);
});

test("signed native resources use the actual post-sign identity and reject subsequent changes", async t => {
  const f = await fixture(t, true);
  await f.file("bin/pi-desktop-host-core", "signed host");
  await afterSign({ appOutDir: f.directory, electronPlatformName: "darwin", packager: { appInfo: { productFilename: "DeckWise" } } });
  const report = await f.check(); assert.equal(report.status, "PASS"); assert.equal(report.signedPayload, true);
  const signed = JSON.parse(await readFile(join(f.directory, "courseware-post-sign.json"), "utf8"));
  assert.equal(signed.resourcesSha256, await fingerprintDirectory(f.resources));
  await f.file("bin/pi-desktop-host-core", "changed after signing"); await assert.rejects(f.check(), /changed after signing/);
});

test("artifact checksums cover distributable bytes and exclude build logs", async t => {
  const root = await mkdtemp(join(tmpdir(), "courseware-artifacts-")); t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(artifactChecksums(root), /No installer/);
  await writeFile(join(root, "DeckWise.AppImage"), "installer"); await writeFile(join(root, "latest-linux.yml"), "feed");
  await writeFile(join(root, "builder-debug.yml"), "private build log");
  assert.equal(await artifactChecksums(root), `${digest("installer")}  DeckWise.AppImage\n${digest("feed")}  latest-linux.yml\n`);
});
