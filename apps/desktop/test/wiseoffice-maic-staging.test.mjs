import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../../../scripts/stage-wiseoffice.mjs", import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "maic-native-stage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source"), output = join(root, "output");
  for (const path of ["module.html", "sdkjs/slide/sdk-all-min.js", "web-apps/apps/presentationeditor/main/index.html", "sdkjs/common/wasm/x2t/x2t.wasm.br"]) {
    await mkdir(dirname(join(source, path)), { recursive: true }); await writeFile(join(source, path), "fixture");
  }
  return { source, output, stage: () => execFileSync(process.execPath, [script, source, output], { encoding: "utf8", stdio: "pipe" }) };
}
test("plain upstream builds cannot bring back the legacy checkpoint form", async t => {
  const f = await fixture(t);
  assert.throws(f.stage, /Build the MAIC editor integration/);
  await assert.rejects(access(f.output), { code: "ENOENT" });
});
test("MAIC staging pins the transformed editor provenance and every bundled file", async t => {
  const f = await fixture(t);
  const marker = { version: 1, contentEditor: "maic", nativeCheckpointEditor: "native-teaching", commit: "a".repeat(40), dirty: false };
  await writeFile(join(f.source, "deckwise-maic-integration.json"), JSON.stringify(marker));
  f.stage();
  const receipt = JSON.parse(await readFile(join(f.output, "deckwise-bundle.json"), "utf8"));
  assert.equal(receipt.contentEditor, "maic"); assert.equal(receipt.commit, marker.commit); assert.equal(receipt.dirty, false);
  assert(receipt.files.some(file => file.path === ".deckwise/teaching-preview.mjs"));
  for (const file of receipt.files) {
    const bytes = await readFile(join(f.output, file.path));
    assert.equal(bytes.length, file.bytes); assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
  }
  assert.throws(f.stage, /Destination already exists/, "Never overwrite an existing bundle");
});
