import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { PptxInspector } from "../electron/main/pptx-inspection.ts";

const snapshot = { path: "/workspace/revision/document.pptx", revision: 3, sha256: "a".repeat(64) };
const summary = { sourceSha256: snapshot.sha256, pages: 3, warningCount: 1, errorCount: 1,
  warnings: [{ code: "PPTX_NATIVE_MATH_UNVERIFIED", message: "Formula content unverified", severity: "error", pageIndex: 1 }] };
async function done(inspector, checkId) {
  const deadline = Date.now() + 3000;
  while (inspector.status({ checkId }).status === "RUNNING") {
    assert(Date.now() < deadline, "Inspection did not finish");
    await delay(5);
  }
  return inspector.status({ checkId });
}

test("saved revision inspection returns a bounded summary only after releasing temporary results", async () => {
  const calls = [];
  const host = { async call(method, params) {
    calls.push([method, params]);
    if (method.endsWith("Start")) return { jobId: "host-job" };
    if (method.endsWith("Status")) return { status: "SUCCEEDED", summary, outputDirectory: "/private/cache" };
    if (method.endsWith("Release")) return { released: true };
    throw new Error("Unexpected method " + method);
  } };
  const inspector = new PptxInspector();
  const { checkId } = inspector.start(host, snapshot);
  assert.throws(() => inspector.start(host, snapshot), /already running/);
  const result = await done(inspector, checkId);
  assert.equal(result.status, "SUCCEEDED");
  assert.equal(result.pages, 3);
  assert.equal(result.revision, 3);
  assert.equal(result.warningCount, 1);
  assert.equal(result.errorCount, 1);
  assert.deepEqual(result.warnings, summary.warnings);
  assert(!JSON.stringify(result).includes("/private/"));
  assert.deepEqual(calls[0], ["courseware.parseStart", { path: snapshot.path }]);
  assert.equal(calls.at(-1)[0], "courseware.parseRelease");
  for (const payload of [null, {}, [], { checkId: "other" }, { checkId, path: "/etc/passwd" }]) {
    assert.throws(() => inspector.status(payload), /Unknown inspection/);
  }
});

test("missing, negative or inconsistent diagnostic counts cannot be reported as no errors", async () => {
  for (const errorCount of [undefined, -1, 2, 0.5]) {
    let released = false;
    const host = { async call(method) {
      if (method.endsWith("Start")) return { jobId: "host-job" };
      if (method.endsWith("Status")) return { status: "SUCCEEDED", summary: { ...summary, errorCount } };
      if (method.endsWith("Release")) { released = true; return {}; }
      throw new Error(method);
    } };
    const inspector = new PptxInspector();
    const { checkId } = inspector.start(host, snapshot);
    const result = await done(inspector, checkId);
    assert.equal(result.status, "FAILED");
    assert.match(result.message, /Invalid inspection diagnostic counts/);
    assert(released);
  }
});

test("closing while admission is pending still cancels, waits for exit and releases", async () => {
  let admit;
  let canceled = false;
  let released = false;
  const host = { async call(method) {
    if (method.endsWith("Start")) return new Promise((resolve) => { admit = resolve; });
    if (method.endsWith("Cancel")) { canceled = true; return {}; }
    if (method.endsWith("Status")) return canceled ? { status: "FAILED", message: "PPTX parsing canceled" } : { status: "RUNNING" };
    if (method.endsWith("Release")) { released = true; return {}; }
    throw new Error(method);
  } };
  const inspector = new PptxInspector();
  const { checkId } = inspector.start(host, snapshot);
  inspector.stop();
  admit({ jobId: "host-job" });
  assert.equal((await done(inspector, checkId)).status, "CANCELED");
  assert(canceled && released);
});

test("stale source hashes, parser failures and release failures cannot appear successful", async () => {
  for (const failure of ["hash", "worker", "cleanup"]) {
    let released = false;
    const host = { async call(method) {
      if (method.endsWith("Start")) return { jobId: "host-job" };
      if (method.endsWith("Status")) return failure === "worker" ? { status: "FAILED", message: "Invalid PPTX" } : { status: "SUCCEEDED", summary: { ...summary, sourceSha256: failure === "hash" ? "b".repeat(64) : snapshot.sha256 } };
      if (method.endsWith("Release")) { released = true; if (failure === "cleanup") throw new Error("EACCES"); return {}; }
      throw new Error(method);
    } };
    const inspector = new PptxInspector();
    const { checkId } = inspector.start(host, snapshot);
    const result = await done(inspector, checkId);
    assert.equal(result.status, "FAILED");
    assert.match(result.message, failure === "hash" ? /hash changed/ : failure === "worker" ? /Invalid PPTX/ : /cleanup failed/);
    assert(released);
  }
});
