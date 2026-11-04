import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import * as shared from "../../../packages/shared/dist/index.js";

const source = await readFile(new URL("../electron/main/courseware-fixed-build.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
class FixedBuildError extends Error {
  constructor(code, diagnostics = []) { super(code); this.code = code; this.diagnostics = diagnostics; }
}
function setup() {
  const snapshot = { snapshotId: "snap-1", projectId: "project-1", source: { revision: "R1", sha256: "a".repeat(64) },
    teachingRevision: "T1", mappingRevision: "M1", assetIds: [] };
  let session = "chat-1", workspace = "/workspace", host, resolveWorkspace = async () => workspace;
  const calls = [], builds = [], canonicalBuilds = [];
  let canonical = { projectId: "project-1", revision: null, sourceRevision: "R1", classroom: null };
  let convert = async () => ({ buildId: "b".repeat(64), packageHash: "b".repeat(64), directory: "/private/build",
    report: { ready: true, diagnostics: [], sourceRevision: "R1", teachingRevision: "T1" } });
  host = { async call(method, params) {
    calls.push([method, params]);
    if (method === "courseware.classroom.get") return structuredClone(canonical);
    return { snapshot: structuredClone(snapshot), project: { private: "frozen" }, mapping: {}, sourcePath: "/private/archive.pptx", assets: [] };
  } };
  const module = { exports: {} };
  new Function("require", "exports", outputText)((id) => {
    if (id === "@pi-desktop/shared") return shared;
    if (id === "node:crypto") return { randomUUID: () => crypto.randomUUID(), createHash: () => ({ update: () => ({ digest: () => "c".repeat(64) }) }) };
    if (id === "node:fs/promises") return { readFile: async () => Buffer.from("worker manifest") };
    if (id === "node:path") return { join: (...parts) => parts.join("/") };
    if (id === "@pi-desktop/courseware-runtime/node") return { FixedBuildError,
      adaptCanonicalSnapshot: (project, saved, files) => ({ project, snapshot: saved, ...files }),
      buildFixedCourseware: async (input, options) => { builds.push({ input, options }); return convert(input, options); } };
    if (id === "./courseware-classroom-build") return { buildMaicCourseware: async input => {
      canonicalBuilds.push(input); await input.assertCurrent();
      return { buildId: "d".repeat(64), packageHash: "d".repeat(64), directory: "/private/maic-build" };
    } };
    throw new Error(id);
  }, module.exports);
  const coordinator = new module.exports.CoursewareFixedBuildCoordinator(() => host, () => resolveWorkspace(), () => session, "/trusted/worker", "/private/builds");
  return { coordinator, snapshot, calls, builds, canonicalBuilds, canonical: value => { canonical = value; }, select: { sessionId: "chat-1", projectId: "project-1", snapshotId: "snap-1" },
    convert: (fn) => { convert = fn; }, session: (value) => { session = value; }, workspace: (value) => { workspace = value; },
    host: (value) => { host = value; }, resolveWorkspace: (fn) => { resolveWorkspace = fn; } };
}

test("only a finite Host snapshot selection reaches the builder; paths stay Main-private", async () => {
  const f = setup();
  await assert.rejects(f.coordinator.build({ ...f.select, sourcePath: "/attacker/file" }), /Invalid immutable/);
  assert.equal(f.calls.length, 0);
  const ready = await f.coordinator.build(f.select);
  assert.equal(ready.status, "ready");
  assert.deepEqual(f.calls, [["courseware.snapshot.get", f.select], ["courseware.classroom.get", { sessionId: "chat-1", projectId: "project-1" }]]);
  assert.deepEqual(f.builds[0].input.reviewedWarningCodes, []);
  assert(!JSON.stringify(ready).includes("/private"));
  assert.equal((await f.coordinator.selected(ready.previewId)).build.directory, "/private/build");
  await assert.rejects(f.coordinator.selected("forged"), /expired/);
  f.workspace("/different");
  await assert.rejects(f.coordinator.selected(ready.previewId), /owner changed/);
});
test("default build uses saved MAIC classroom and invalidates preview after canonical edits", async () => {
  const f = setup();
  const canonical = { projectId: "project-1", revision: "canonical-1", sourceRevision: "R1", classroom: { id: "maic", scenes: [{ type: "quiz" }] } };
  f.canonical(canonical);
  const ready = await f.coordinator.build(f.select);
  assert.equal(ready.status, "ready");
  assert.equal(f.builds.length, 0, "canonical does not pass through legacy fixed action mapping");
  assert.deepEqual(f.canonicalBuilds[0].classroom, canonical.classroom);
  const selected = await f.coordinator.selected(ready.previewId);
  assert.equal(selected.canonical.revision, "canonical-1");
  assert.equal(selected.build.directory, "/private/maic-build");
  f.canonical({ ...canonical, revision: "canonical-2" });
  await assert.rejects(f.coordinator.selected(ready.previewId), /Canonical classroom changed/);
});

test("conversion warnings require exact retained approval and re-read the same immutable Host snapshot", async () => {
  const f = setup();
  f.convert(async (input) => {
    if (!input.reviewedWarningCodes.length) throw new FixedBuildError("CONTENT_REVIEW_REQUIRED", [{ code: "NOTES", message: "Review notes", severity: "warning" }]);
    return { buildId: "b".repeat(64), packageHash: "b".repeat(64), directory: "/private/build", report: { diagnostics: [] } };
  });
  const review = await f.coordinator.build(f.select);
  assert.equal(review.status, "review");
  await assert.rejects(f.coordinator.approveWarnings({ reviewId: review.reviewId, codes: ["OTHER"] }), /exactly/);
  await assert.rejects(f.coordinator.approveWarnings({ reviewId: review.reviewId, codes: ["NOTES", "NOTES"] }), /exactly/);
  await assert.rejects(f.coordinator.approveWarnings({ reviewId: "forged", codes: ["NOTES"] }), /expired/);
  review.snapshot.source.revision = "mutated renderer copy";
  review.diagnostics[0].code = "OTHER";
  const ready = await f.coordinator.approveWarnings({ reviewId: review.reviewId, codes: ["NOTES"] });
  assert.equal(ready.status, "ready");
  assert.equal(f.calls.length, 4);
  assert.deepEqual(f.builds[1].input.reviewedWarningCodes, ["NOTES"]);
  await assert.rejects(f.coordinator.approveWarnings({ reviewId: review.reviewId, codes: ["NOTES"] }), /expired/);
});

test("changed snapshot and content errors cannot acquire warning approval", async () => {
  const f = setup();
  f.convert(async () => { throw new FixedBuildError("CONTENT_REVIEW_REQUIRED", [{ code: "NOTES", message: "Review notes" }]); });
  const review = await f.coordinator.build(f.select);
  f.snapshot.teachingRevision = "T2";
  await assert.rejects(f.coordinator.approveWarnings({ reviewId: review.reviewId, codes: ["NOTES"] }), /differs/);
  assert.equal(f.builds.length, 1);
  f.convert(async () => { throw new FixedBuildError("CONTENT_ERROR", [{ code: "PPTX_NATIVE_MATH_UNVERIFIED",
    message: "PPTX 第 9 页包含尚未验证还原的原生 Office 公式", severity: "error", pageIndex: 8 }]); });
  await assert.rejects(f.coordinator.build(f.select), /CONTENT_ERROR: PPTX_NATIVE_MATH_UNVERIFIED: PPTX 第 9 页/);
  await assert.rejects(f.coordinator.approveWarnings({ reviewId: review.reviewId, codes: ["NOTES"] }), /expired/);
});

test("cancellation, another Chat, workspace or Host never adopts a late completed build", async () => {
  for (const change of [(f) => f.coordinator.cancel(), (f) => f.session("chat-2"), (f) => f.workspace("/other"), (f) => f.host(null)]) {
    const f = setup();
    let finish, began;
    const started = new Promise((resolve) => { began = resolve; });
    f.convert(async (_input, options) => { began(options.signal); return new Promise((resolve) => { finish = resolve; }); });
    const pending = f.coordinator.build(f.select);
    const signal = await started;
    await assert.rejects(f.coordinator.build(f.select), /already running/);
    change(f);
    finish({ buildId: "b".repeat(64), packageHash: "b".repeat(64), directory: "/private/build", report: {} });
    await assert.rejects(pending, /canceled|owner changed/);
    await assert.rejects(f.coordinator.selected("any"), /expired/);
    if (signal.aborted) assert.match(String(signal.reason), /canceled/);
  }
});

test("wrong or extra-key Host exports reject before conversion", async () => {
  const f = setup();
  f.snapshot.snapshotId = "different";
  await assert.rejects(f.coordinator.build(f.select), /differs/);
  f.host({ async call() { return { snapshot: f.snapshot, project: {}, mapping: {}, sourcePath: "/private", assets: [], extra: "forged" }; } });
  await assert.rejects(f.coordinator.build(f.select), /Invalid Host/);
  assert.equal(f.builds.length, 0);
});

test("cancel during workspace lookup prevents a late build from starting", async () => {
  const f = setup();
  let finish;
  f.resolveWorkspace(() => new Promise((resolve) => { finish = resolve; }));
  const pending = f.coordinator.build(f.select);
  f.coordinator.cancel();
  finish("/workspace");
  await assert.rejects(pending, /canceled/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.builds.length, 0);
});
