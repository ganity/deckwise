import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
const exports = {};
new Function("require", "exports", ts.transpileModule(await readFile(new URL("../electron/main/courseware-delivery.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(id => { if (id === "node:crypto") return { randomUUID }; throw Error(id); }, exports);
const { CoursewareDelivery } = exports;
function setup() {
  let journal = null, source = { documentId: "doc", fingerprint: "local-1" }, principal = "account-1", local = principal;
  let remote = { synced: false }, syncReplyLost = false, publishReplyLost = false;
  const calls = [], receipts = new Map();
  const host = { async call(method, payload) {
    if (method === "courseware.delivery.read") return structuredClone(journal);
    assert.deepEqual(payload.expected, journal); journal = structuredClone(payload.value); return structuredClone(journal);
  } };
  const input = {
    principal() { const captured = principal; return { key: captured, assertCurrent() { if (principal !== captured) throw Error("account changed"); } }; },
    host: () => host, current: async () => ({ ...source }),
    archive: async () => ({ bytes: Buffer.from(source.fingerprint), source: { ...source } }),
    upload: async () => ({ fileUrl: "https://assets/upload.zip", packageHash: source.fingerprint }),
    async request(action, payload) {
      calls.push({ action, payload: structuredClone(payload) });
      if (action === "state") return structuredClone(remote);
      if (receipts.has(payload.operationId)) return structuredClone(receipts.get(payload.operationId));
      if (action === "sync") {
        if ((remote.cloudRevisionId ?? null) !== payload.expectedRevisionId) throw Object.assign(Error("CONFLICT"), { code: 409 });
        remote = { ...remote, synced: true, courseId: 100, revisionId: payload.packageHash, cloudRevisionId: payload.packageHash, version: remote.version ?? 0, releaseSequence: remote.releaseSequence ?? 0 };
        receipts.set(payload.operationId, structuredClone(remote));
        if (syncReplyLost) { syncReplyLost = false; throw Error("response lost"); }
        return structuredClone(remote);
      }
      assert.equal(payload.expectedVersion, remote.version);
      remote = { ...remote, publishedRevisionId: payload.expectedRevisionId, version: remote.version + 1, releaseSequence: remote.releaseSequence + 1 };
      receipts.set(payload.operationId, structuredClone(remote));
      if (publishReplyLost) { publishReplyLost = false; throw Error("response lost"); }
      return structuredClone(remote);
    },
  };
  const instance = () => new CoursewareDelivery(input);
  const request = (action, extra = {}) => ({ sessionId: "session", action, ...(action === "sync" ? { title: "Course" } : {}), ...extra });
  return { instance, request, calls, input, get journal() { return journal; }, get remote() { return remote; }, set source(value) { source = { ...source, fingerprint: value }; },
    cloudEdit(value) { remote.cloudRevisionId = value; }, loseSync() { syncReplyLost = true; }, losePublish() { publishReplyLost = true; }, changeAccount() { principal = "account-2"; } };
}
test("never-synced or edited local drafts cannot publish from Main", async () => {
  const s = setup(), d = s.instance();
  await assert.rejects(d.execute(s.request("publish")), /SYNC_REQUIRED/);
  await d.execute(s.request("sync")); s.source = "local-2";
  await assert.rejects(d.execute(s.request("publish")), /SYNC_REQUIRED/);
  assert.equal(s.calls.filter(c => c.action === "publish").length, 0);
});
test("sync creates a draft; a second sync preserves the previously published revision", async () => {
  const s = setup(), d = s.instance();
  await d.execute(s.request("sync")); assert.equal(s.remote.publishedRevisionId, undefined);
  await d.execute(s.request("publish")); s.source = "local-2";
  await d.execute(s.request("sync")); assert.equal(s.remote.publishedRevisionId, "local-1"); assert.equal(s.remote.version, 1);
  await d.execute(s.request("publish")); assert.equal(s.remote.publishedRevisionId, "local-2");
});
test("restart after lost sync response recovers the same intent before synchronizing newer edits", async () => {
  const s = setup(); s.loseSync();
  await assert.rejects(s.instance().execute(s.request("sync")), /response lost/);
  const id = s.journal.pending.operationId; s.source = "local-2";
  await s.instance().execute(s.request("sync"));
  const syncs = s.calls.filter(c => c.action === "sync");
  assert.equal(syncs[1].payload.operationId, id); assert.equal(syncs[1].payload.packageHash, "local-1");
  assert.equal(s.journal.syncedFingerprint, "local-2");
});
test("restart after lost publish response repairs it before newer local edits are synchronized", async () => {
  const s = setup(); await s.instance().execute(s.request("sync")); s.losePublish();
  await assert.rejects(s.instance().execute(s.request("publish")), /response lost/);
  const id = s.journal.publish.operationId; s.source = "local-2";
  await s.instance().execute(s.request("sync"));
  assert.equal(s.calls.filter(c => c.action === "publish")[1].payload.operationId, id);
  assert.equal(s.remote.version, 1); assert.equal(s.remote.publishedRevisionId, "local-1"); assert.equal(s.remote.revisionId, "local-2");
});
test("cloud changes require explicit replacement of the displayed cloud revision", async () => {
  const s = setup(), d = s.instance(); await d.execute(s.request("sync")); s.cloudEdit("web-1");
  await assert.rejects(d.execute(s.request("sync")), /CONFLICT/);
  await assert.rejects(d.execute(s.request("publish")), /SYNC_REQUIRED/);
  await d.execute(s.request("sync", { expectedCloudRevisionId: "web-1" }));
  assert.equal(s.remote.cloudRevisionId, "local-1");
});
test("edits during export and account changes never submit a stale package", async () => {
  const s = setup();
  s.input.archive = async () => { s.source = "local-2"; return { bytes: Buffer.from("new"), source: { documentId: "doc", fingerprint: "local-2" } }; };
  await assert.rejects(s.instance().execute(s.request("sync")), /changed during export/);
  assert.equal(s.calls.filter(c => c.action === "sync").length, 0);
  s.input.archive = async () => { s.changeAccount(); return { bytes: Buffer.from("new"), source: { documentId: "doc", fingerprint: "local-2" } }; };
  await assert.rejects(s.instance().execute(s.request("sync")), /account changed/);
});
test("conversion warnings require explicit approval for the same source; edits expire approval", async () => {
  const s = setup(), d = s.instance(); let approved;
  s.input.archive = async (_, codes) => {
    approved = codes;
    if (!codes.includes("FONT_FALLBACK")) throw Object.assign(Error("review"), { code: "CONTENT_REVIEW_REQUIRED", diagnostics: [{ code: "FONT_FALLBACK", severity: "warning", message: "Font fallback" }] });
    return { bytes: Buffer.from("local-1"), source: { documentId: "doc", fingerprint: "local-1" } };
  };
  const review = await d.execute(s.request("sync"));
  assert.equal(s.calls.some(c => c.action === "sync"), false);
  assert.equal(review.review.diagnostics[0].code, "FONT_FALLBACK");
  await d.execute(s.request("sync", { reviewId: review.review.id })); assert.deepEqual(approved, ["FONT_FALLBACK"]);
  const other = setup(), e = other.instance(); other.input.archive = s.input.archive;
  const next = await e.execute(other.request("sync")); other.source = "local-2";
  await assert.rejects(e.execute(other.request("sync", { reviewId: next.review.id })), /review expired/);
});
test("definitive sync rejection discards intent while transport failure keeps recovery state", async () => {
  const s = setup(), d = s.instance(), request = s.input.request;
  s.input.request = async (action, payload) => {
    if (action === "sync") throw Object.assign(Error("invalid archive"), { code: 400 });
    return request(action, payload);
  };
  await assert.rejects(d.execute(s.request("sync")), /invalid archive/);
  assert.equal(s.journal.pending, undefined);
});
