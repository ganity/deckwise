import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import test from "node:test";
import { loadCoursewareMedia } from "./fixtures/courseware-media-loader.mjs";

const media = await loadCoursewareMedia();

const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const platformUrl = `https://platform.test/api/backend/courseware/team/projects/${projectId}/publish/shared/fixed-playback`;
const blobs = { "manifest.json": Buffer.from("manifest"), "package.json": Buffer.from("package"),
  "report.json": Buffer.from("report"), "source.pptx": Buffer.from("pptx") };
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const json = (data, code = 200) => new Response(JSON.stringify({ code, data }), {
  headers: { "content-type": "application/json" },
});

function setup(t, handler) {
  let now = Date.now(), principal = {}, token = 0, selections = 0, released = 0;
  t.mock.method(Date, "now", () => now);
  const calls = [];
  const controller = new AbortController();
  const playback = (signature, lifetime = 60_000) => ({
    pointer: { projectId, channel: "shared", buildId: sha(blobs["package.json"]), snapshotId: "snapshot-1",
      packageSha256: sha(blobs["package.json"]), version: 1 },
    fixedBuild: { build: { buildId: sha(blobs["package.json"]), snapshotId: "snapshot-1",
      packageSha256: sha(blobs["package.json"]) }, manifestSha256: sha(blobs["manifest.json"]),
      expiresAt: new Date(now + lifetime).toISOString(),
      files: Object.entries(blobs).map(([path, bytes]) => ({ file: { path, sha256: sha(bytes),
        byteLength: bytes.length, mimeType: path === "source.pptx"
          ? "application/vnd.openxmlformats-officedocument.presentationml.presentation" : "application/json" },
        downloadUrl: `https://bucket.oss-cn-hangzhou.aliyuncs.com/${path}?signature=${signature}` })),
    },
  });
  const f = {
    calls, controller, playback,
    advance(ms) { now += ms; },
    changePrincipal() { principal = {}; },
    get selections() { return selections; },
    get released() { return released; },
    expired(status = 403) {
      now += 6001;
      return new Response(new ReadableStream({ cancel() { released++; } }), { status });
    },
    file(url, bytes) {
      const path = new URL(url).pathname.slice(1);
      return new Response(bytes ?? blobs[path], { headers: { "content-type": path === "source.pptx"
        ? "application/vnd.openxmlformats-officedocument.presentationml.presentation" : "application/json" } });
    },
  };
  f.client = new media.CoursewareMediaClient({ baseUrl: "https://platform.test/api/backend",
    getPrincipal: () => principal, resolveAccessToken: async () => `renewal-token-${++token}`,
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (url === platformUrl) selections++;
      return handler(f, url, init);
    },
  });
  return f;
}

for (const status of [401, 403]) {
  test(`expiry during signed HTTP ${status} reauthorizes once and retains the original immutable selection`, async (t) => {
    const f = setup(t, (f, url) => {
      if (url === platformUrl) {
        if (f.selections === 2) assert.equal(f.released, 1, "release the rejected OSS body before renewal");
        return json(f.playback(f.selections, f.selections === 1 ? 6000 : 60_000));
      }
      if (url.endsWith("signature=1")) return f.expired(status);
      assert(url.endsWith("signature=2"));
      return f.file(url);
    });
    const selected = await f.client.getTeamFixedPlayback(projectId);
    const pinned = structuredClone(selected);
    assert.deepEqual(await f.client.downloadTeamFixedFile(selected, "source.pptx"), blobs["source.pptx"]);
    assert.deepEqual(await f.client.downloadTeamFixedFile(selected, "report.json"), blobs["report.json"]);
    assert.deepEqual(selected, pinned, "renewed URLs stay private to the original selection");
    assert.equal(f.selections, 2);
    assert.equal(f.calls.length, 5);
    for (const { url, init } of f.calls) {
      const headers = new Headers(init.headers);
      assert.equal(init.method ?? "GET", "GET");
      assert.equal(init.body, undefined);
      assert.equal(init.cache, "no-store");
      assert.equal(init.credentials, "omit");
      assert.equal(init.redirect, "error");
      if (url === platformUrl) assert.match(headers.get("Authorization"), /^Bearer renewal-token-[12]$/u);
      else assert.equal(headers.has("Authorization"), false);
    }
    assert.notEqual(new Headers(f.calls[0].init.headers).get("Authorization"),
      new Headers(f.calls[2].init.headers).get("Authorization"));
  });
}

for (const mode of ["account", "cancel"]) {
  test(`${mode} during expired resource response prevents a renewal request`, async (t) => {
    const f = setup(t, (f, url) => {
      if (url === platformUrl) return json(f.playback(1, 6000));
      if (mode === "account") f.changePrincipal();
      else f.controller.abort();
      return f.expired();
    });
    const selected = await f.client.getTeamFixedPlayback(projectId);
    await assert.rejects(f.client.downloadTeamFixedFile(selected, "source.pptx", f.controller.signal),
      mode === "account" ? /AUTH_CHANGED/ : /Abort|CANCELLED/i);
    assert.equal(f.calls.length, 2);
    assert.equal(f.released, 1);
  });
}

for (const mode of ["revoked", "session-expired", "pointer", "files", "account", "cancel", "untrusted-url"]) {
  test(`expired signed URLs cannot renew across ${mode}`, async (t) => {
    const f = setup(t, (f, url) => {
      if (url !== platformUrl) return f.expired();
      if (f.selections === 1) return json(f.playback(1, 6000));
      if (mode === "revoked") return json(null, 46100);
      if (mode === "session-expired") return new Response("", { status: 401 });
      const next = f.playback(2);
      if (mode === "pointer") next.pointer.version++;
      if (mode === "files") next.fixedBuild.files[0].file.byteLength++;
      if (mode === "account") f.changePrincipal();
      if (mode === "cancel") f.controller.abort();
      if (mode === "untrusted-url") next.fixedBuild.files[0].downloadUrl = "https://127.0.0.1/private?signature=forged";
      return json(next);
    });
    const selected = await f.client.getTeamFixedPlayback(projectId);
    const error = mode === "revoked" ? /PLATFORM_46100/ : mode === "session-expired" ? /HTTP_401/
      : mode === "account" ? /AUTH_CHANGED/ : mode === "cancel" ? /Abort|CANCELLED/i
        : mode === "untrusted-url" ? /INVALID_RESPONSE/ : /TEAM_PLAYBACK_CHANGED/;
    await assert.rejects(f.client.downloadTeamFixedFile(selected, "source.pptx", f.controller.signal), error);
    assert.equal(f.calls.length, 3);
    assert.equal(f.released, 1);
  });
}

for (const status of [403, 404, 500]) {
  test(`HTTP ${status} without known expiry fails without renewal`, async (t) => {
    const f = setup(t, (f, url) => url === platformUrl ? json(f.playback(1)) : new Response("", { status }));
    const selected = await f.client.getTeamFixedPlayback(projectId);
    await assert.rejects(f.client.downloadTeamFixedFile(selected, "source.pptx"), new RegExp(`HTTP_${status}$`));
    assert.equal(f.calls.length, 2);
  });
}

test("renewed file denial cannot cause a second renewal", async (t) => {
  const f = setup(t, (f, url) => {
    if (url === platformUrl) return json(f.playback(f.selections, 6000));
    return f.expired();
  });
  const selected = await f.client.getTeamFixedPlayback(projectId);
  await assert.rejects(f.client.downloadTeamFixedFile(selected, "source.pptx"), /HTTP_403/);
  assert.equal(f.selections, 2);
  assert.equal(f.calls.length, 4);
});

test("renewed bytes still have to match the original hash", async (t) => {
  const f = setup(t, (f, url) => url === platformUrl
    ? json(f.playback(f.selections, f.selections === 1 ? 6000 : 60_000))
    : url.endsWith("signature=1") ? f.expired() : f.file(url, Buffer.from("PPTX")));
  const selected = await f.client.getTeamFixedPlayback(projectId);
  await assert.rejects(f.client.downloadTeamFixedFile(selected, "source.pptx"), /INTEGRITY_ERROR/);
  assert.equal(f.calls.length, 4);
});
