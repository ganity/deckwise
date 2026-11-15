import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../../../scripts/check-courseware-regression.mjs", import.meta.url));
const JSZip = createRequire(new URL("../../../packages/courseware-runtime/package.json", import.meta.url))("jszip");
test("MAIC preflight reports missing reference dependencies before starting Electron or creating evidence", async t => {
  const root = await mkdtemp(join(tmpdir(), "courseware-reference-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "evidence");
  const parity = fileURLToPath(new URL("../../../scripts/check-maic-courseware-parity.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [parity, "--preflight"], {
    env: { ...process.env, MAIC_SERVER_ROOT: root, MAIC_CLOUD_WEB_ROOT: root, DECKWISE_E2E_OUTPUT: output }, encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Install the locked dependencies.*missing jszip/);
  assert.doesNotMatch(result.stdout, /START/);
  await assert.rejects(access(output), { code: "ENOENT" });
});
test("regression rejects missing, duplicate and oversized fixtures and preserves existing evidence", async t => {
  const root = await mkdtemp(join(tmpdir(), "courseware-regression-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, DECKWISE_E2E_NATIVE_PPTX: "", DECKWISE_E2E_SCENE_PPTX: "", DECKWISE_E2E_IMPORT_PPTX: "", DECKWISE_E2E_PACKAGE_ROOT: "" };
  const run = output => spawnSync(process.execPath, [script], { env: { ...env, DECKWISE_E2E_OUTPUT: output }, encoding: "utf8" });
  const output = join(root, "missing");
  assert.equal(run(output).status, 1);
  const original = await readFile(join(output, "report.json"), "utf8"), report = JSON.parse(original);
  assert.equal(report.status, "FAIL"); assert.equal(report.releaseReady, false); assert.deepEqual(report.checks, []);
  assert.match(report.error, /Missing DECKWISE_E2E_NATIVE_PPTX/);
  assert.equal(run(output).status, 1);
  assert.equal(await readFile(join(output, "report.json"), "utf8"), original);
  const fixture = join(root, "fixture.pptx"), zip = new JSZip();
  zip.file("ppt/slides/slide1.xml", "<slide/>");
  await writeFile(fixture, await zip.generateAsync({ type: "nodebuffer" }));
  for (const key of ["DECKWISE_E2E_NATIVE_PPTX", "DECKWISE_E2E_SCENE_PPTX", "DECKWISE_E2E_IMPORT_PPTX"]) env[key] = fixture;
  const duplicate = join(root, "duplicate");
  assert.equal(run(duplicate).status, 1);
  assert.match(JSON.parse(await readFile(join(duplicate, "report.json"), "utf8")).error, /three different/);
  for (let i = 2; i <= 7; i++) zip.file(`ppt/slides/slide${i}.xml`, "<slide/>");
  await writeFile(fixture, await zip.generateAsync({ type: "nodebuffer" }));
  const oversized = join(root, "oversized");
  assert.equal(run(oversized).status, 1);
  assert.match(JSON.parse(await readFile(join(oversized, "report.json"), "utf8")).error, /1–6 pages/);
});
