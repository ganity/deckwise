import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as runtime from "../../../packages/agent-runtime/dist/index.js";
import * as shared from "../../../packages/shared/dist/index.js";

const require = createRequire(import.meta.url), exports = {};
const source = await readFile(new URL("../electron/main/courseware-style-review.ts", import.meta.url), "utf8");
new Function("require", "exports", ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(id => id === "@pi-desktop/agent-runtime" ? runtime : id === "@pi-desktop/shared" ? shared : require(id), exports);
const fixture = JSON.parse(await readFile(new URL("../../../packages/shared/src/courseware-contract.fixtures/accepted.json", import.meta.url), "utf8"));

function setup() {
  const project = structuredClone(fixture.project);
  project.pages.push({ pageId: "unlocked-third", actions: [], locked: false, reviewState: "ready" });
  let owner = true, workspace = "/work", dirty = false, duringGet = async () => {}, duringRender = async () => {};
  const snapshot = { projectId: "local", documentId: "document", sessionId: "office", path: "/work/source.pptx", sha256: project.source.sha256, revision: 3 };
  const context = { ...snapshot, page: 1, editGeneration: 5, readOnly: false };
  const bytes = Buffer.from("retained compiler PPTX fixture"), hash = runtime.candidateHash(bytes);
  const pageId = project.pages[0].pageId;
  const candidate = { candidateId: "host-archive", projectId: project.projectId, kind: "page-pptx", status: "needs-review",
    outputSha256: hash.slice(7), targetPageIds: [pageId], stale: false, lineageVerified: true, applied: false };
  const generated = { candidateId: "compiler-media-id", kind: "page-pptx", pptx: bytes, hash,
    baseline: { projectId: project.projectId, documentId: context.documentId, pageId, sourceRevision: project.source.revision,
      sourceHash: `sha256:${project.source.sha256}`, teachingRevision: project.teachingRevision },
    reference: { candidateId: "compiler-media-id", outputSha256: hash.slice(7) } };
  const calls = [];
  const host = { async call(method) {
    calls.push(method); await duringGet(method);
    if (method === "courseware.project.get") return { project: structuredClone(project) };
    if (method === "courseware.sourceCandidate.get") return structuredClone(candidate);
    if (method === "courseware.sourceCandidate.preview") return { candidate: structuredClone(candidate), path: "/work/candidate.pptx" };
    assert.fail(method);
  } };
  const teaching = { async assertCurrent(_snapshot, _context, _sessionId, currentHost, mode) {
    assert.equal(currentHost, host); assert.equal(mode, "saved-page");
    if (dirty || context.readOnly || context.page !== 1 || snapshot.sha256 !== project.source.sha256) throw new Error("Native source changed");
  } };
  const service = new exports.CoursewareStyleReviewCoordinator(teaching, async () => workspace,
    () => { if (!owner) throw new Error("Owner changed"); }, async input => {
      calls.push("render"); assert.deepEqual(input.snapshot, { sourcePath: "/work/candidate.pptx", sha256: hash.slice(7) });
      await input.assertCurrent(); await duringRender(); input.signal.throwIfAborted();
      return { pageCount: project.pages.length, normal: { sourceSha256: hash.slice(7), page: 1, nativeTextOmitted: false,
        image: { bytes: Buffer.from("actual candidate PNG fixture"), width: 1600, height: 1000, sha256: "b".repeat(64), assetIds: ["review"] } } };
    });
  const input = { candidateId: candidate.candidateId, generated, mapping: { revision: "mapping" }, instruction: "Use a blue style",
    host, sessionId: "chat", project, snapshot, context };
  return { service, input, project, candidate, calls,
    retain: () => service.retain(input), prepare: () => service.prepare({ sessionId: "chat", candidateId: candidate.candidateId }),
    duringGet(fn) { duringGet = fn; }, duringRender(fn) { duringRender = fn; },
    change(kind) {
      if (kind === "owner") owner = false; if (kind === "workspace") workspace = "/other"; if (kind === "dirty") dirty = true;
      if (kind === "page") context.page = 2; if (kind === "readonly") context.readOnly = true;
      if (kind === "teaching") project.teachingRevision = "T9"; if (kind === "locked") project.pages[2].locked = true;
      if (kind === "rejected") candidate.status = "rejected"; if (kind === "output") candidate.outputSha256 = "a".repeat(64);
      if (kind === "unverified") candidate.lineageVerified = false; if (kind === "stale") candidate.stale = true;
      if (kind === "selection") context.editGeneration++;
    },
  };
}

test("actual retained representative is required; malformed renderer fields cannot create review authority", async () => {
  const f = setup(); await assert.rejects(f.prepare(), /Generate the representative/);
  for (const payload of [null, {}, { sessionId: "chat", candidateId: "host-archive", approved: true }, { sessionId: "chat", path: "/etc/passwd" }])
    await assert.rejects(f.service.prepare(payload));
  assert.deepEqual(f.calls, []);
  await f.retain();
  await assert.rejects(f.service.prepare({ sessionId: "other-chat", candidateId: "host-archive" }));
  await assert.rejects(f.service.prepare({ sessionId: "chat", candidateId: "other-candidate" }));
});

test("preview binds the actual candidate, then explicit scope alone grants private confirmed inputs", async () => {
  const f = setup(); await f.retain(); const view = await f.prepare();
  assert.equal(view.outputSha256, f.candidate.outputSha256); assert.equal(view.instruction, f.input.instruction);
  assert.deepEqual(view.pages.map(page => page.locked), [false, true, false]);
  await assert.rejects(f.service.loadConfirmed("chat"), /confirm/);
  const ids = [f.project.pages[2].pageId, f.project.pages[0].pageId];
  const result = await f.service.approve({ reviewId: view.reviewId, pageIds: ids });
  assert.deepEqual(result.pageIds, [...ids].reverse());
  const loaded = await f.service.loadConfirmed("chat");
  assert.equal(loaded.candidateId, "host-archive"); assert.equal(loaded.confirmation.representativeCandidateId, "compiler-media-id");
  assert.equal(loaded.confirmation.instructionHash, runtime.candidateHash(f.input.instruction));
  assert(loaded.representativeImage.bytes.length); assert.equal(loaded.host, f.input.host);
  loaded.generated.pptx.fill(0); loaded.pageIds.pop(); loaded.representativeImage.bytes.fill(0);
  const again = await f.service.loadConfirmed("chat");
  assert.equal(runtime.candidateHash(again.generated.pptx), f.input.generated.hash); assert.equal(again.pageIds.length, 2);
  assert.equal(Buffer.from(again.representativeImage.bytes).toString(), "actual candidate PNG fixture");
  assert(f.calls.every(method => ["courseware.project.get", "courseware.sourceCandidate.get", "courseware.sourceCandidate.preview", "render"].includes(method)));
});

test("renderer cannot confirm locked, duplicate, missing, oversized or foreign scope", async () => {
  const f = setup(); await f.retain(); const view = await f.prepare(); const [first, locked, third] = f.project.pages.map(page => page.pageId);
  for (const ids of [[], [first], [first, first], [first, locked], [third, "foreign"], [first, 2], Array(21).fill(first)]) {
    await assert.rejects(f.service.approve({ reviewId: view.reviewId, pageIds: ids }), /2-20/);
    await assert.rejects(f.service.loadConfirmed("chat"));
  }
  for (const payload of [{ reviewId: view.reviewId, pageIds: [first, third], approved: true }, { reviewId: "expired", pageIds: [first, third] }])
    await assert.rejects(f.service.approve(payload), /expired/);
});

test("source, owner, policy and candidate changes invalidate confirmation across awaited checks", async () => {
  for (const kind of ["owner", "workspace", "dirty", "page", "readonly", "teaching", "locked", "rejected", "output", "unverified", "stale"]) {
    const f = setup(); await f.retain(); const view = await f.prepare();
    await f.service.approve({ reviewId: view.reviewId, pageIds: [f.project.pages[0].pageId, f.project.pages[2].pageId] });
    f.change(kind); await assert.rejects(f.service.loadConfirmed("chat"), undefined, kind);
  }
  const f = setup(); await f.retain(); const view = await f.prepare();
  f.duringGet(async () => f.service.clearReview());
  await assert.rejects(f.service.approve({ reviewId: view.reviewId, pageIds: [f.project.pages[0].pageId, f.project.pages[2].pageId] }), /expired/);
});

test("clear, replacement, render cancellation and restart revoke approval without dropping durable Host candidates", async () => {
  const f = setup(); await f.retain(); let view = await f.prepare();
  await f.service.approve({ reviewId: view.reviewId, pageIds: [f.project.pages[0].pageId, f.project.pages[2].pageId] });
  f.service.clearReview(); await assert.rejects(f.service.loadConfirmed("chat"));
  view = await f.prepare(); f.change("selection");
  await f.service.approve({ reviewId: view.reviewId, pageIds: [f.project.pages[0].pageId, f.project.pages[2].pageId] });
  await f.service.loadConfirmed("chat");
  await f.retain(); await assert.rejects(f.service.loadConfirmed("chat"));
  f.duringRender(async () => f.service.clearReview()); await assert.rejects(f.prepare(), /cleared|expired/);
  await assert.rejects(setup().service.loadConfirmed("chat"));
  assert.equal(f.candidate.status, "needs-review");
});

test("batch confirmation pins the exact selected scope even when the same review is approved again", async () => {
  const f = setup(); f.project.pages.push({ pageId: "fourth", actions: [], locked: false, reviewState: "ready" });
  await f.retain(); const view = await f.prepare();
  const oldIds = [f.project.pages[0].pageId, f.project.pages[2].pageId], newIds = [f.project.pages[0].pageId, "fourth"];
  await f.service.approve({ reviewId: view.reviewId, pageIds: oldIds });
  await f.service.assertConfirmed("chat", view.reviewId, oldIds);
  await assert.rejects(f.service.assertConfirmed("other", view.reviewId, oldIds));
  f.duringGet(async () => {
    f.duringGet(async () => {});
    await f.service.approve({ reviewId: view.reviewId, pageIds: newIds });
  });
  await assert.rejects(f.service.assertConfirmed("chat", view.reviewId, oldIds), /expired/);
  await f.service.assertConfirmed("chat", view.reviewId, newIds);
  assert.deepEqual((await f.service.loadConfirmed("chat")).pageIds, newIds);
});
