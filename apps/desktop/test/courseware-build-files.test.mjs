import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openCoursewareBuildFiles, openCoursewareBuildUpload } from "../electron/main/courseware-build-files.ts";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
test("selected package and finite assets are bounded, owned and hash checked", async () => {
  const root = await mkdtemp(join(tmpdir(), "fixed-build-files-"));
  try {
    await mkdir(join(root, "assets"));
    const bytes = Buffer.from("audio fixture");
    const digest = hash(bytes);
    const asset = { id: "voice", path: `assets/${digest}.wav`, sha256: digest, mimeType: "audio/wav" };
    const pkg = Buffer.from(JSON.stringify({ assets: [asset] }));
    await writeFile(join(root, "package.json"), pkg);
    await writeFile(join(root, asset.path), bytes);
    const files = await openCoursewareBuildFiles(root, hash(pkg));
    assert.deepEqual(Buffer.from(files.packageBytes()), pkg);
    files.packageBytes().fill(0);
    assert.deepEqual(Buffer.from(files.packageBytes()), pkg);
    assert.deepEqual(Buffer.from(await files.assetBytes("voice")), bytes);
    for (const id of ["../package.json", asset.path, null, "other"]) await assert.rejects(files.assetBytes(id), /not in/);
    await assert.rejects(openCoursewareBuildFiles(root, "a".repeat(64)), /hash changed/);
    await writeFile(join(root, asset.path), "changed");
    await assert.rejects(files.assetBytes("voice"), /hash changed/);
    await rm(join(root, asset.path));
    await writeFile(join(root, "outside.wav"), bytes);
    await symlink(join(root, "outside.wav"), join(root, asset.path));
    await assert.rejects(files.assetBytes("voice"), /escaped/);
    for (const assets of [[{ ...asset, path: "../outside.wav" }], [asset, asset], [{ ...asset, sha256: "a".repeat(64) }]]) {
      const bad = Buffer.from(JSON.stringify({ assets }));
      await writeFile(join(root, "package.json"), bad);
      await assert.rejects(openCoursewareBuildFiles(root, hash(bad)), /Invalid fixed/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("team upload reads only the selected fixed build members and verifies its manifest hashes", async () => {
  const root = await mkdtemp(join(tmpdir(), "fixed-build-upload-"));
  try {
    const payload = Buffer.from("package");
    const report = Buffer.from("report");
    const source = Buffer.from("pptx");
    const buildId = hash(payload);
    const entries = [
      { path: "package.json", sha256: hash(payload) },
      { path: "report.json", sha256: hash(report) },
      { path: "source.pptx", sha256: hash(source) },
    ];
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: "deckwise-build-manifest/1", buildId, packageHash: buildId, files: entries }));
    await writeFile(join(root, "manifest.json"), manifest);
    await writeFile(join(root, "package.json"), payload);
    await writeFile(join(root, "report.json"), report);
    await writeFile(join(root, "source.pptx"), source);
    const upload = await openCoursewareBuildUpload(root, buildId);
    assert.equal(upload.manifestHash, hash(manifest));
    assert.deepEqual(upload.files.map((file) => file.path).sort(), ["package.json", "report.json", "source.pptx"]);
    assert.deepEqual(Buffer.from(upload.files.find((file) => file.path === "source.pptx").bytes), source);
    await writeFile(join(root, "report.json"), "changed");
    await assert.rejects(openCoursewareBuildUpload(root, buildId), /hash changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
