import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import test from "node:test";
import ts from "typescript";
import * as shared from "../../../packages/shared/dist/index.js";
const source = await readFile(new URL("../electron/main/courseware-visual-review.ts", import.meta.url), "utf8");
const module = { exports: {} };
new Function("require", "exports", ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText)(id => {
  if (id === "node:crypto") return { randomUUID };
  assert.equal(id, "@pi-desktop/shared"); return shared;
}, module.exports);
const { CoursewareVisualReview } = module.exports;
const fixture = JSON.parse(await readFile(new URL("../../../packages/shared/src/courseware-contract.fixtures/accepted.json", import.meta.url), "utf8"));
function setup() {
  const project = structuredClone(fixture.project);
  project.pages[1].locked = false;
  let owner = true, workspace = "/work", dirty = false, duringRender = async () => {}, duringGet = async () => {};
  const snapshot = { projectId: "local", documentId: "doc", sessionId: "office", sourcePath: "/work/lesson.pptx", path: "/work/revision.pptx", revision: 1, sha256: project.source.sha256 };
  const context = { ...snapshot, page: 2, editGeneration: 1, readOnly: false };
  const calls = [];
  const assertCurrent = async (_snapshot, _context, _session, _host, mode) => {
    assert.equal(mode, "saved-page");
    if (dirty) throw new Error("dirty source"); if (context.page !== 2) throw new Error("page changed");
  };
  const host = { async call(method) { calls.push(method); await duringGet(); return { project: structuredClone(project) }; } };
  const teaching = { assertCurrent, async withSaved(_session, run, signal) { signal.throwIfAborted(); return run(host, "parse", { ...snapshot }, { ...context }); } };
  const editor = { sourceAdoptionSnapshot() { return { ...snapshot }; } };
  const service = new CoursewareVisualReview(teaching, editor, async () => workspace, () => { if (!owner) throw new Error("owner changed"); }, async input => {
    calls.push("render"); await input.assertCurrent(); await duringRender(input.signal); input.signal.throwIfAborted();
    const image = { width: 1600, height: 900, bytes: Buffer.from("fixture"), sha256: "c".repeat(64), assetIds: ["visual"] };
    return { pageCount: project.pages.length, normal: { sourceSha256: snapshot.sha256, page: 2, pageToken: "native-two", nativeTextOmitted: false, image },
      textless: { sourceSha256: snapshot.sha256, page: 2, pageToken: "native-two", nativeTextOmitted: true, image: { ...image, bytes: Buffer.from("clean"), assetIds: ["clean"] } } };
  });
  return { service, calls, project, duringRender(fn) { duringRender = fn; }, duringGet(fn) { duringGet = fn; },
    change(kind) { if (kind === "owner") owner = false; if (kind === "workspace") workspace = "/else"; if (kind === "dirty") dirty = true;
      if (kind === "source") snapshot.sha256 = "b".repeat(64); if (kind === "path") snapshot.sourcePath = "/work/other.pptx";
      if (kind === "page") context.page = 1; if (kind === "generation") context.editGeneration++;
      if (kind === "teaching") project.teachingRevision = "T9"; if (kind === "locked") project.pages[1].locked = true; },
  };
}
test("only explicit approval releases owned visual copies; clear revokes retained authority", async () => {
  const f = setup(), view = await f.service.prepare({ sessionId: "chat" });
  assert.equal(view.pageId, f.project.pages[1].pageId); assert.equal(view.pageNumber, 2);
  assert.match(view.original.preview, /^data:image\/png;base64,/);
  await assert.rejects(f.service.load(view.reviewId), /not been approved/);
  await assert.rejects(f.service.approve({ reviewId: view.reviewId, approved: true }), /expired/);
  await f.service.approve({ reviewId: view.reviewId });
  const loaded = await f.service.load(view.reviewId); loaded.visuals.normal.image.bytes.fill(0);
  assert.equal(Buffer.from((await f.service.load(view.reviewId)).visuals.normal.image.bytes).toString(), "fixture");
  f.service.clear(); await assert.rejects(loaded.assertCurrent(), /expired/);
  await assert.rejects(f.service.load(view.reviewId));
  assert(f.calls.every(call => ["render", "courseware.project.openSaved", "courseware.project.get"].includes(call)));
});
test("source/page/teaching/workspace/owner changes reject approval and late loads", async () => {
  for (const kind of ["source", "path", "page", "teaching", "locked", "workspace", "owner", "dirty"]) {
    const f = setup(), view = await f.service.prepare({ sessionId: "chat" });
    await f.service.approve({ reviewId: view.reviewId }); f.change(kind);
    await assert.rejects(f.service.load(view.reviewId), undefined, kind);
    await assert.rejects(f.service.approve({ reviewId: view.reviewId }), undefined, kind);
  }
});
test("saved-page approval survives native selection generation changes", async () => {
  const f = setup(), view = await f.service.prepare({ sessionId: "chat" });
  await f.service.approve({ reviewId: view.reviewId }); f.change("generation");
  assert.equal((await f.service.approved()).view.reviewId, view.reviewId);
  f.change("page"); assert.equal(await f.service.approved(), null);
});
test("cancelled/replaced render and locked page never leave approvable inputs", async () => {
  const f = setup();
  for (const payload of [{}, null, { sessionId: "chat", path: "/etc/passwd" }, { sessionId: 1 }]) await assert.rejects(f.service.prepare(payload));
  assert.equal(f.calls.length, 0);
  f.change("locked"); await assert.rejects(f.service.prepare({ sessionId: "chat" }), /locked/); assert(!f.calls.includes("render"));
  const g = setup(); g.duringRender(async signal => { g.service.clear(); assert(signal.aborted); });
  await assert.rejects(g.service.prepare({ sessionId: "chat" }), /cleared|expired/);
  await assert.rejects(g.service.approve({ reviewId: "unknown" }));
});
test("state changes while awaiting Host responses reject stale inputs", async () => {
  const f = setup(), view = await f.service.prepare({ sessionId: "chat" });
  f.duringGet(async () => f.change("page"));
  await assert.rejects(f.service.approve({ reviewId: view.reviewId }), /page changed/);
});
