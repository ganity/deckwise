import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { asar, scanPackage, checkFixedBuild, contentCategories, scanPptxExport } from "./check-courseware-package-credentials.mjs";

const JSZip = createRequire(new URL("../packages/courseware-runtime/package.json", import.meta.url))("jszip");
const pptxFixture = async (extra = {}) => {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("ppt/presentation.xml", "<presentation/>");
  for (const [name, bytes] of Object.entries(extra)) zip.file(name, bytes);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
};

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fakeToken = () => "sk-proj-" + "gateFixtureA91b2C3d4E5f6G7h8I9j0K".repeat(2);
const fixture = async (run) => { const root = await mkdtemp(join(tmpdir(), "credential-gate-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); } };

test("actual ASAR entries and resources pass benign templates and block implanted credential/state files", () => fixture(async (root) => {
  const resources = join(root, "resources"), source = join(root, "source");
  await mkdir(resources); await mkdir(source);
  await writeFile(join(source, "main.js"), "const apiKey = undefined; // no account state");
  await writeFile(join(resources, ".env.example"), "OPENAI_API_KEY=replace_me\n");
  await writeFile(join(resources, "cacert.pem"), "-----BEGIN CERTIFICATE-----\npublic fixture\n-----END CERTIFICATE-----");
  await asar.createPackage(source, join(resources, "app.asar"));
  assert.equal((await scanPackage(resources)).passed, true);
  const token = fakeToken();
  await writeFile(join(source, "runtime.js"), `const value = '${token}';`);
  await writeFile(join(source, "auth.json"), '{"fixture":true}');
  await asar.createPackage(source, join(resources, "app.asar"));
  await writeFile(join(resources, ".env.local"), "fixture-only");
  await writeFile(join(resources, "state.sqlite"), "SQLite format 3\0fixture");
  await writeFile(join(resources, "boundary.bin"), Buffer.concat([Buffer.alloc(65530, 0), Buffer.from(token)]));
  const report = await scanPackage(resources);
  assert.equal(report.passed, false);
  for (const category of ["credential-file", "provider-token", "environment-state", "database-state", "sqlite-content"])
    assert.ok(report.findings.some((finding) => finding.category === category), category);
  assert.ok(report.findings.some((finding) => finding.path === "boundary.bin" && finding.category === "provider-token"));
  assert.equal(JSON.stringify(report).includes(token), false, "reports must never emit credential values");
}));

test("package scanner rejects links outside the package without reading their target", () => fixture(async (root) => {
  const resources = join(root, "resources"); await mkdir(resources);
  await symlink(join(root, "nonexistent-profile"), join(resources, "escape"));
  const report = await scanPackage(resources);
  assert.deepEqual(report.findings, [{ path: "escape", category: "external-or-broken-link", blocking: true }]);
}));

test("internal links cannot hide credential or environment paths", () => fixture(async (root) => {
  const resources = join(root, "resources"); await mkdir(resources);
  await writeFile(join(resources, "public.txt"), "benign fixture");
  await symlink("public.txt", join(resources, "auth.json"));
  await symlink("public.txt", join(resources, ".env.local"));
  const report = await scanPackage(resources);
  assert.equal(report.passed, false);
  assert.ok(report.links.every((link) => link.inside));
  assert.deepEqual(report.findings.map(({ path, category }) => ({ path, category })).sort((a, b) => a.path.localeCompare(b.path)), [
    { path: ".env.local", category: "environment-state" },
    { path: "auth.json", category: "credential-file" },
  ]);
}));

test("content scanning catches provider tokens and private key/database signatures", () => {
  assert.ok(contentCategories(Buffer.from(fakeToken())).includes("provider-token"));
  assert.ok(contentCategories(Buffer.from("-----BEGIN PRIVATE KEY-----\n" + "A".repeat(60) + "\n-----END PRIVATE KEY-----")).includes("private-key-material"));
  assert.ok(contentCategories(Buffer.from("SQLite format 3\0fixture")).includes("sqlite-content"));
});

test("real team export reader ignores local extras, rejects forbidden manifest members and symlink escapes", () => fixture(async (root) => {
  const payload = Buffer.from('{"assets":[]}'), report = Buffer.from('{}'), source = await pptxFixture();
  const buildId = hash(payload);
  const entries = [{ path: "package.json", sha256: buildId }, { path: "report.json", sha256: hash(report) }, { path: "source.pptx", sha256: hash(source) }];
  const manifest = (files) => writeFile(join(root, "manifest.json"), JSON.stringify({ schemaVersion: "deckwise-build-manifest/1", buildId, packageHash: buildId, files }));
  await writeFile(join(root, "package.json"), payload); await writeFile(join(root, "report.json"), report); await writeFile(join(root, "source.pptx"), source);
  await mkdir(join(root, "auth"));
  for (const path of [".env", "auth/session.token", "state.sqlite"]) await writeFile(join(root, path), "fixture-only");
  await manifest(entries);
  const clean = await checkFixedBuild(root);
  assert.equal(clean.passed, true);
  assert.deepEqual(clean.files.map((file) => file.path), ["manifest.json", "package.json", "report.json", "source.pptx"]);
  for (const path of [".env", "auth/session.token", "state.sqlite", "../outside"] ) {
    await manifest([...entries, { path, sha256: hash("fixture-only") }]);
    await assert.rejects(checkFixedBuild(root));
  }
  const token = Buffer.from(fakeToken()), tokenPath = `assets/${hash(token)}.bin`;
  await mkdir(join(root, "assets")); await writeFile(join(root, tokenPath), token);
  await manifest([...entries, { path: tokenPath, sha256: hash(token) }]);
  const contaminated = await checkFixedBuild(root);
  assert.equal(contaminated.passed, false);
  assert.ok(contaminated.findings.some((finding) => finding.path === tokenPath && finding.category === "provider-token"));
  const secretSource = await pptxFixture({ "ppt/notesSlides/notesSlide1.xml": fakeToken() });
  await writeFile(join(root, "source.pptx"), secretSource);
  await manifest(entries.map((entry) => entry.path === "source.pptx" ? { ...entry, sha256: hash(secretSource) } : entry));
  const compressed = await checkFixedBuild(root);
  assert.equal(compressed.passed, false);
  assert.ok(compressed.findings.some((finding) => finding.path === "source.pptx!/ppt/notesSlides/notesSlide1.xml" && finding.category === "provider-token"));
  await writeFile(join(root, "source.pptx"), source);
  await manifest(entries);
  await rm(join(root, "source.pptx"));
  await writeFile(join(root, "outside.pptx"), source);
  await symlink(join(root, "outside.pptx"), join(root, "source.pptx"));
  await assert.rejects(checkFixedBuild(root), /escaped/u);
}));

test("PPTX export scanning decodes notes, metadata and embedded bytes without emitting secrets", async () => {
  const clean = await scanPptxExport(await pptxFixture(), "lesson.pptx");
  assert.equal(clean.passed, true);
  assert.equal(clean.files.length, 2);
  const token = fakeToken();
  const bytes = await pptxFixture({
    "ppt/notesSlides/notesSlide1.xml": `<notes>${token}</notes>`,
    "docProps/custom.xml": token,
    "ppt/embeddings/object.bin": Buffer.from(token),
    "auth.json": "fixture-only",
  });
  const report = await scanPptxExport(bytes, "lesson.pptx");
  assert.equal(report.passed, false);
  assert.equal(report.findings.filter((finding) => finding.category === "provider-token").length, 3);
  assert.ok(report.findings.some((finding) => finding.category === "credential-file"));
  assert.equal(JSON.stringify(report).includes(token), false);
});

test("PPTX export scanning refuses malformed, escaping and symlink archives", async () => {
  assert.equal((await scanPptxExport(Buffer.from("not a zip"), "bad.pptx")).passed, false);
  const zip = new JSZip(); zip.file("public.txt", "fixture");
  assert.equal((await scanPptxExport(await zip.generateAsync({ type: "nodebuffer" }), "not-pptx.pptx")).passed, false);
  zip.file("[Content_Types].xml", "<Types/>"); zip.file("ppt/presentation.xml", "<presentation/>");
  zip.file("../outside.txt", "fixture");
  assert.equal((await scanPptxExport(await zip.generateAsync({ type: "nodebuffer" }), "escape.pptx")).passed, false);
  zip.remove("../");
  zip.file("link", "outside", { unixPermissions: 0o120777 });
  const linked = await scanPptxExport(await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" }), "link.pptx");
  assert.ok(linked.findings.some((finding) => finding.category === "archive-link"));
});

test("PPTX export scanning bounds decompressed members and entry count", async () => {
  const large = await pptxFixture({ "ppt/media/oversize.bin": Buffer.alloc(64 * 1024 * 1024 + 1, 0) });
  const report = await scanPptxExport(large, "large.pptx");
  assert.ok(report.findings.some((finding) => finding.category === "archive-size-limit"));
  const zip = new JSZip();
  for (let index = 0; index < 4097; index++) zip.file(`file-${index}`, "");
  const crowded = await scanPptxExport(await zip.generateAsync({ type: "nodebuffer" }), "crowded.pptx");
  assert.ok(crowded.findings.some((finding) => finding.category === "archive-entry-limit"));
});
