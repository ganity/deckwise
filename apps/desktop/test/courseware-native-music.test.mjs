import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
const require = createRequire(import.meta.url);
function setup() {
  const bytes = Buffer.from("verified archived music"), sha = createHash("sha256").update(bytes).digest("hex"), calls = [];
  const view = { viewId: "doc.page", pageId: "page", project: { projectId: "doc", teachingRevision: "rev", source: { revision: "rev", sha256: "a".repeat(64) },
    pages: [{ pageId: "page", locked: false, actions: [{ id: "music.slot", type: "music_slot", prompt: "Family song" }] }] } };
  let current = structuredClone(view), adopted;
  const requestHash = () => "b".repeat(64), rows = [];
  const task = { state: "ready", feeState: "settled" };
  class Music {
    constructor(_host, _session, _running, _auth, adoption) { this.adoption = adoption; }
    async list() { return rows; }
    async prepare(args) { const row = { intentId: "music-intent", operation: "music", draft: { id: args.draftId, prompt: "Family song" }, phase: "prepared", candidates: [{ exportable: true, state: "completed", candidateId: "candidate" }], task }; rows.push(row); return row; }
    async quote() { return { quoteId: "quote" }; }
    async submitConfirmed() { rows[0].phase = "submitted"; return rows[0]; }
    async status() { return rows[0]; }
    async models() { return { export: [{ model: "export-model" }] }; }
    async exportPrepare(args) { const row = { intentId: "export-intent", sourceIntentId: "music-intent", operation: "music-export", phase: "prepared", draft: rows[0].draft, task }; rows.push(row); return row; }
    async exportQuote() { return { quoteId: "export-quote" }; }
    async exportSubmitConfirmed() { rows[1].phase = "submitted"; return rows[1]; }
    async exportStatus() { return rows[1]; }
    async exportArchive() {}
    async adopt(args) { const target = await this.adoption.teaching.musicAdoptionContext(args); return target.adoptMusic({ principalKey: "principal", intentId: "export-intent", assetId: "music-" + sha, durationMs: 1500, bytes, sha256: sha }); }
  }
  const exports = {};
  new Function("require", "exports", ts.transpileModule(readFileSync(new URL("../electron/main/courseware-native-music.ts", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText)(id => id === "./courseware-canvas-music" ? { CoursewareCanvasMusic: Music } : id === "./courseware-music-request" ? { musicRequestHash: requestHash } : require(id), exports);
  const host = { async call(method, args) {
    calls.push(method);
    if (method === "courseware.mediaCanvas.get") return { revision: null, document: null };
    assert.equal(method, "courseware.mediaCanvas.set"); return { revision: "canvas-rev" };
  } };
  const route = async (op, args) => { if (op === "open") return { value: structuredClone(current) }; assert.equal(op, "adopt-audio"); adopted = args.command; return { value: view }; };
  const music = new exports.CoursewareNativeMusic({ getCoursewarePrincipal: () => ({ assertCurrent() {} }) }, () => host, () => "chat", route, async () => 1500);
  return { music, view, calls, bytes, adopted: () => adopted, readOnly: () => { view.readOnly = true; current.readOnly = true; }, stale: () => { current.project.teachingRevision = "changed"; } };
}
test("native music generation/export adopts verified bytes into the intended slot without a Host teaching mirror", async () => {
  const f = setup();
  const result = await f.music.execute({ actionId: "music.slot", model: "model", prompt: "Family song", music: { title: "Family" } }, true, 1, f.view, () => true);
  assert.equal(result.audioReady, true); assert.equal(f.adopted().actionId, "music.slot"); assert.equal(f.adopted().bytes.byteLength, f.bytes.length);
  assert.equal(f.adopted().kind, "music"); assert(f.calls.every(call => call.startsWith("courseware.mediaCanvas.")));
  f.stale(); await assert.rejects(f.music.execute({ intentId: result.job.intentId }, false, 1, f.view, () => true), /changed/);
});

test("native music rejects a changed approved prompt before creating or submitting a paid task", async () => {
  const f = setup();
  await assert.rejects(f.music.execute({ actionId: "music.slot", model: "model", prompt: "Different song", music: { title: "Family" } }, true, 1, f.view, () => true), /prompt changed/);
  assert.deepEqual(f.calls, []);
});

test("native music rejects a read-only document before media storage or dispatch", async () => {
  const f = setup(); f.readOnly();
  await assert.rejects(f.music.execute({ actionId: "music.slot", model: "model", prompt: "Family song", music: { title: "Family" } }, true, 1, f.view, () => true), /locked/);
  assert.deepEqual(f.calls, []);
});
