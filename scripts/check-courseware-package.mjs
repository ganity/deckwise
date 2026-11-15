import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { digest, fileDigest, fingerprintDirectory, sourceIdentity, verifyInventory } from "./courseware-release-inputs.mjs";
import { scanPackage } from "./check-courseware-package-credentials.mjs";

export async function checkCoursewarePackage(directory, expectedCommit) {
  const candidate = JSON.parse(await readFile(join(directory, "courseware-candidate.json"), "utf8"));
  const { candidateId, ...content } = candidate;
  assert.equal(candidate.schemaVersion, "deckwise-courseware-candidate/1");
  assert.equal(candidateId, digest(JSON.stringify(content)), "Invalid candidate receipt");
  assert.equal(candidate.source.commit, expectedCommit, "Package contains a different Desktop commit");
  assert.equal(candidate.source.dirty, false, "Package must contain committed source");
  const app = (await readdir(directory)).filter(name => name.endsWith(".app"));
  assert(app.length <= 1, "Ambiguous macOS application");
  const resources = app.length ? join(directory, app[0], "Contents/Resources") : join(directory, "resources");
  const signed = await readFile(join(directory, "courseware-post-sign.json"), "utf8").then(JSON.parse, error => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (signed) {
    assert.equal(signed.schemaVersion, "deckwise-courseware-post-sign/1");
    assert.equal(signed.candidateId, candidateId, "Signed payload belongs to a different candidate");
    assert.equal(await fingerprintDirectory(resources), signed.resourcesSha256, "Signed payload changed after signing");
  } else {
    for (const [file, key] of [["app.asar", "appAsarSha256"], ["agent-runtime/sidecar.js", "agentSha256"],
      [candidate.inputs.platform === "win32" ? "bin/pi-desktop-host-core.exe" : "bin/pi-desktop-host-core", "hostSha256"]])
      assert.equal(await fileDigest(join(resources, file)), candidate[key], `Packaged ${file} changed`);
    for (const [bundle, manifest, key] of [["wiseoffice", "deckwise-bundle.json", "wiseofficeSha256"], ["pptx-worker", "manifest.json", "workerSha256"]])
      assert.equal((await verifyInventory(join(resources, bundle), manifest)).sha256, candidate.inputs[key]);
  }
  const credentials = await scanPackage(resources);
  assert(credentials.passed, `Packaged credentials/state detected: ${JSON.stringify(credentials.findings)}`);
  return { status: "PASS", candidateId, source: candidate.source, inputs: candidate.inputs,
    resourcesSha256: await fingerprintDirectory(resources), credentials, signedPayload: Boolean(signed),
    runtimeAcceptance: "SEPARATE_ELECTRON_GATE" };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url)), release = join(root, "apps/desktop/release");
  let directory = process.argv[2];
  if (!directory) {
    const entries = (await readdir(release)).filter(name => /^(?:linux.*-unpacked|win.*-unpacked|mac(?:-.*)?)$/.test(name));
    assert.equal(entries.length, 1, "Expected one native package output");
    directory = join(release, entries[0]);
  }
  const report = await checkCoursewarePackage(resolve(directory), sourceIdentity(root).commit);
  await writeFile(join(release, `courseware-package-${process.platform}-${process.arch}.json`), JSON.stringify(report, null, 2) + "\n");
  console.log(`PASS packaged courseware ${report.candidateId}`);
}
