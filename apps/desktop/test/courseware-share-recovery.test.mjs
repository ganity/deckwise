import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { loadCoursewareMedia } from "./fixtures/courseware-media-loader.mjs";

const media = await loadCoursewareMedia();

const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const blobs = { "manifest.json": Buffer.from("manifest"), "package.json": Buffer.from("package"),
  "report.json": Buffer.from("report"), "source.pptx": Buffer.from("pptx") };
const selection = { projectId: "office-1", teamProjectId: projectId, channel: "formal", snapshotId: "snapshot-1",
  buildId: sha(blobs["package.json"]), manifestSha256: sha(blobs["manifest.json"]) };
const intentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const upload = { manifestHash: selection.manifestSha256, manifestBytes: blobs["manifest.json"],
  files: Object.entries(blobs).filter(([path]) => path !== "manifest.json").map(([path, bytes]) => ({ path, bytes, sha256: sha(bytes) })) };

async function fixture(t) {
  const requests = [], state = { published: false, revoked: false, competing: false, drop: true };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const path = new URL(req.url, "http://fixture").pathname;
    const body = req.method === "POST" && path.endsWith("/publish") ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    requests.push({ method: req.method, path, ...(body ? { body } : {}) });
    assert.equal(req.headers.authorization, "Bearer isolated-fixture-access");
    const json = (data, code = 200) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ code, data })); };
    const build = { buildId: selection.buildId, snapshotId: selection.snapshotId, packageSha256: selection.buildId };
    const pointer = state.published ? { projectId, channel: "formal", ...build, version: 1 } :
      { projectId, channel: "formal", buildId: null, snapshotId: null, packageSha256: null, version: 0 };
    if (state.competing) Object.assign(pointer, { buildId: "f".repeat(64), packageSha256: "f".repeat(64), snapshotId: "other-snapshot", version: 2 });
    if (state.revoked) { json(null, 46100); return; }
    if (req.method === "POST" && path.endsWith("/fixed-builds")) { json(build); return; }
    if (req.method === "POST" && path.endsWith("/publish")) {
      state.published = true;
      if (body.intentId) state.receipt = { intentId: body.intentId, expectedVersion: body.expectedVersion,
        pointer: { ...pointer, ...build, version: body.expectedVersion + 1 } };
      if (state.drop) { req.socket.destroy(); return; }
      json({ ...pointer, ...build, version: body.expectedVersion + 1 }); return;
    }
    if (path.endsWith("/publish/receipts/" + intentId)) {
      if (state.receipt404) { res.writeHead(404); res.end(); return; }
      json(state.receipt ?? null, state.receiptCode ?? (state.receipt ? 200 : 46108)); return;
    }
    if (path.endsWith("/publish/formal")) { json(pointer); return; }
    if (path.endsWith("/fixed-builds/" + selection.buildId)) {
      json({ build, manifestSha256: selection.manifestSha256, expiresAt: new Date(Date.now() + 60_000).toISOString(),
        files: Object.entries(blobs).map(([path, bytes]) => ({ file: { path, sha256: sha(bytes), byteLength: bytes.length,
          mimeType: path === "source.pptx" ? "application/vnd.openxmlformats-officedocument.presentationml.presentation" : "application/json" },
        downloadUrl: `https://fixture.oss-cn-hangzhou.aliyuncs.com/${path}?fixture=1` })) }); return;
    }
    res.writeHead(404); res.end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  let principal = {};
  const client = () => new media.CoursewareMediaClient({ baseUrl: `http://127.0.0.1:${server.address().port}`,
    fetch, resolveAccessToken: async () => "isolated-fixture-access", getPrincipal: () => principal });
  return { client, state, requests, changePrincipal() { principal = {}; } };
}

test("real HTTP loses a successful formal publication response; a fresh client recovers with exactly two GETs", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.client().uploadAndPublishFixedBuild(projectId, selection.snapshotId, selection.buildId, upload, "formal"), /TRANSPORT_FAILED/);
  assert.equal(f.state.published, true);
  const before = f.requests.length;
  await f.client().queryFixedBuildPublication(selection);
  assert.deepEqual(f.requests.slice(before), [
    { method: "GET", path: `/courseware/team/projects/${projectId}/fixed-builds/${selection.buildId}` },
    { method: "GET", path: `/courseware/team/projects/${projectId}/publish/formal` },
  ]);
  assert.equal(f.requests.filter((req) => req.method === "POST").length, 2);
  assert.deepEqual(f.requests.find((req) => req.path.endsWith("/publish")).body,
    { channel: "formal", buildId: selection.buildId, expectedVersion: 0 });
});

test("real HTTP lost publication response recovers its original receipt after another version replaces the pointer", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.client().uploadAndPublishFixedBuild(projectId, selection.snapshotId, selection.buildId, upload,
    "formal", undefined, intentId), /TRANSPORT_FAILED/);
  assert.deepEqual(f.requests.find((req) => req.path.endsWith("/publish")).body,
    { channel: "formal", buildId: selection.buildId, expectedVersion: 0, intentId });
  f.state.competing = true;
  const before = f.requests.length;
  await f.client().queryFixedBuildPublication(selection, undefined, intentId);
  assert.deepEqual(f.requests.slice(before), [
    { method: "GET", path: `/courseware/team/projects/${projectId}/fixed-builds/${selection.buildId}` },
    { method: "GET", path: `/courseware/team/projects/${projectId}/publish/receipts/${intentId}` },
  ]);
  assert.equal(f.state.competing, true);
  assert.equal(f.requests.filter((req) => req.method === "POST").length, 2);
});

test("real HTTP absent, actor-hidden, revoked and unsupported receipt results never fall back to a matching pointer", async (t) => {
  const f = await fixture(t); f.state.published = true;
  for (const code of [46108, 46100, 46102, 404]) {
    f.state.receiptCode = code; f.state.receipt404 = code === 404;
    const before = f.requests.length;
    await assert.rejects(f.client().queryFixedBuildPublication(selection, undefined, intentId),
      new RegExp(code === 404 ? "HTTP_404" : `PLATFORM_${code}`));
    assert.deepEqual(f.requests.slice(before).map((request) => request.path), [
      `/courseware/team/projects/${projectId}/fixed-builds/${selection.buildId}`,
      `/courseware/team/projects/${projectId}/publish/receipts/${intentId}`,
    ]);
  }
  assert(f.requests.every((req) => req.method === "GET"));
});

test("an already matching pointer still records a new intent receipt, while a legacy no-intent publication stays a no-op", async (t) => {
  const legacy = await fixture(t); legacy.state.published = true;
  await legacy.client().uploadAndPublishFixedBuild(projectId, selection.snapshotId, selection.buildId, upload, "formal");
  assert(!legacy.requests.some((request) => request.method === "POST" && request.path.endsWith("/publish")));
  const f = await fixture(t); f.state.published = true;
  await assert.rejects(f.client().uploadAndPublishFixedBuild(projectId, selection.snapshotId, selection.buildId, upload,
    "formal", undefined, intentId), /TRANSPORT_FAILED/);
  assert.deepEqual(f.requests.find((request) => request.path.endsWith("/publish")).body,
    { channel: "formal", buildId: selection.buildId, expectedVersion: 1, intentId });
  assert.equal(f.state.receipt.pointer.version, 2);
  const before = f.requests.length;
  await f.client().queryFixedBuildPublication(selection, undefined, intentId);
  assert(f.requests.slice(before).every((request) => request.method === "GET"));
  assert.equal(f.requests.filter((request) => request.method === "POST" && request.path.endsWith("/publish")).length, 1);
});

test("real HTTP receipt tampering and frozen manifest mismatch cannot complete a share or trigger pointer fallback", async (t) => {
  const f = await fixture(t); f.state.published = true;
  const receipt = { intentId, expectedVersion: 2, pointer: { projectId, channel: "formal", buildId: selection.buildId,
    snapshotId: selection.snapshotId, packageSha256: selection.buildId, version: 3 } };
  for (const alter of [
    (value) => { value.intentId = projectId; },
    (value) => { value.expectedVersion = -1; },
    (value) => { value.pointer.projectId = intentId; },
    (value) => { value.pointer.channel = "shared"; },
    (value) => { value.pointer.buildId = "f".repeat(64); },
    (value) => { value.pointer.snapshotId = "other-snapshot"; },
    (value) => { value.pointer.packageSha256 = "f".repeat(64); },
    (value) => { value.pointer.version = 4; },
  ]) {
    f.state.receipt = structuredClone(receipt); alter(f.state.receipt);
    const before = f.requests.length;
    await assert.rejects(f.client().queryFixedBuildPublication(selection, undefined, intentId), /SHARE_NOT_CONFIRMED/);
    assert.equal(f.requests.length, before + 2);
  }
  f.state.receipt = receipt;
  const before = f.requests.length;
  await assert.rejects(f.client().queryFixedBuildPublication({ ...selection, manifestSha256: "e".repeat(64) }, undefined, intentId), /SHARE_NOT_CONFIRMED/);
  assert.equal(f.requests.length, before + 1);
  assert(f.requests.every((req) => req.method === "GET"));
  assert(!f.requests.some((req) => req.path.endsWith("/publish/formal")));
});

test("real HTTP competing pointer and mismatched manifest remain unconfirmed without any publication", async (t) => {
  const f = await fixture(t); f.state.published = true; f.state.competing = true;
  await assert.rejects(f.client().queryFixedBuildPublication(selection), /SHARE_NOT_CONFIRMED/);
  f.state.competing = false;
  await assert.rejects(f.client().queryFixedBuildPublication({ ...selection, manifestSha256: "e".repeat(64) }), /SHARE_NOT_CONFIRMED/);
  assert(f.requests.every((req) => req.method === "GET"));
});

test("real HTTP reauthorizes every recovery; revocation rejects before pointer lookup and never uses prior success", async (t) => {
  const f = await fixture(t); f.state.published = true;
  const client = f.client();
  await client.queryFixedBuildPublication(selection);
  f.state.revoked = true;
  const before = f.requests.length;
  await assert.rejects(client.queryFixedBuildPublication(selection), /PLATFORM_46100/);
  assert.equal(f.requests.length, before + 1);
  assert(f.requests.every((req) => req.method === "GET"));
});
