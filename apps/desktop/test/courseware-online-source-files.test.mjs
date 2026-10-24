import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import ts from "typescript";
import * as shared from "@pi-desktop/shared";

const require = createRequire(import.meta.url);
const load = (path, dependencies = {}, clock = Date) => {
  const exports = {};
  new Function("require", "exports", "Date", ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText)(id => Object.hasOwn(dependencies, id) ? dependencies[id] : require(id), exports, clock);
  return exports;
};
const office = load("../electron/main/office-file.ts", { "@pi-desktop/shared": shared });
const { stageOnlineSourceFiles } = load("../electron/main/courseware-online-source-files.ts", { "./office-file": office });
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const bytes = text => Buffer.from(`PK[Content_Types].xmlppt/presentation.xml${text}`);
const source = text => { const value = bytes(text); return { source: { revision: randomUUID(), sha256: digest(value) }, bytes: value }; };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

async function fixture(t, options = {}) {
  const workspace = await fs.mkdtemp(join(tmpdir(), "online-source-files-test-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const calls = [], jobs = new Map(), original = source("original"), target = source("target");
  let allowed = true, activeHost;
  const host = { async call(method, params) {
    calls.push([method, structuredClone(params)]);
    if (options.call) { const custom = await options.call(method, params, { workspace, jobs }); if (custom !== undefined) return custom; }
    if (method === "courseware.parseStart") {
      assert.equal(jobs.size, 0, "Host retains only one parsing job");
      const actual = await fs.readFile(params.path), jobId = randomUUID();
      jobs.set(jobId, { sha256: digest(actual), path: params.path, cancelled: false });
      return { jobId, status: "RUNNING" };
    }
    const job = jobs.get(params.jobId); assert(job, "the helper uses its captured job ID");
    if (method === "courseware.parseStatus") return job.cancelled ? { status: "FAILED" }
      : { status: "SUCCEEDED", summary: { sourceSha256: job.sha256 } };
    if (method === "courseware.parseCancel") { job.cancelled = true; return { status: "RUNNING" }; }
    if (method === "courseware.parseRelease") { jobs.delete(params.jobId); return { released: true }; }
    if (method === "baseline" || method === "review") return { accepted: true };
    throw new Error(`Unexpected ${method}`);
  } };
  activeHost = host;
  const signal = new AbortController();
  const input = { workspace, sessionId: "session-fixture", original, target, signal: signal.signal,
    getHost: () => activeHost, assertCurrent() { if (!allowed) throw new Error("selection changed"); } };
  return { workspace, original, target, calls, jobs, host, input, signal, revoke() { allowed = false; }, replaceHost() { activeHost = {}; } };
}

test("real private files feed sequential original/baseline and target/review jobs without changing live files", async t => {
  const f = await fixture(t), live = join(f.workspace, "live.pptx"), sibling = join(f.workspace, "unrelated");
  await fs.writeFile(live, "live untouched"); await fs.mkdir(sibling); await fs.writeFile(join(sibling, "keep"), "keep");
  const context = await stageOnlineSourceFiles(f.input); t.after(() => context.dispose());
  const preview = await context.preview("original", 1, async input => {
    assert.equal(input.workspace, f.workspace); assert.equal(input.page, 1);
    assert.equal(digest(await fs.readFile(input.snapshot.sourcePath)), f.original.source.sha256);
    assert.equal(input.snapshot.sha256, f.original.source.sha256);
    await input.assertCurrent(); return input.snapshot.sourcePath;
  });
  const directory = dirname(preview);
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(preview)).mode & 0o777, 0o600);
  await context.withParsed("original", async (host, jobId) => host.call("baseline", { jobId }));
  await context.withParsed("target", async (host, jobId) => host.call("review", { jobId }));
  assert.deepEqual(f.calls.map(([method]) => method), ["courseware.parseStart", "courseware.parseStatus", "baseline", "courseware.parseRelease",
    "courseware.parseStart", "courseware.parseStatus", "review", "courseware.parseRelease"]);
  assert.equal(f.jobs.size, 0);
  await context.dispose(); await context.dispose();
  await assert.rejects(fs.stat(directory), { code: "ENOENT" });
  assert.equal(await fs.readFile(live, "utf8"), "live untouched"); assert.equal(await fs.readFile(join(sibling, "keep"), "utf8"), "keep");
});

test("input buffers are captured before asynchronous staging and malformed source tuples write nothing", async t => {
  const f = await fixture(t), expected = f.target.source.sha256;
  const pending = stageOnlineSourceFiles(f.input); f.target.bytes.fill(0);
  const context = await pending;
  await context.withParsed("target", async (_host, jobId) => assert.equal(f.jobs.get(jobId).sha256, expected));
  await context.dispose();
  const bad = await fixture(t); bad.original.source.sha256 = "0".repeat(64);
  await assert.rejects(stageOnlineSourceFiles(bad.input), /SOURCE_INVALID/);
  assert.deepEqual(await fs.readdir(bad.workspace), []); assert.equal(bad.calls.length, 0);
});

test("parse hash mismatch releases its own job and removes only its private copies", async t => {
  const f = await fixture(t, { call(method) {
    if (method === "courseware.parseStatus") return { status: "SUCCEEDED", summary: { sourceSha256: "0".repeat(64) } };
  } });
  const context = await stageOnlineSourceFiles(f.input);
  await assert.rejects(context.withParsed("target", async () => assert.fail("no unverified parse callback")), /SOURCE_INVALID/);
  assert.equal(f.jobs.size, 0); assert.deepEqual(await fs.readdir(f.workspace), []);
  await context.dispose();
});

test("cancellation after a late parseStart waits for cancel, terminal status and release before deleting files", async t => {
  const started = deferred(), returned = deferred();
  const f = await fixture(t, { async call(method, params, { jobs }) {
    if (method !== "courseware.parseStart") return;
    const jobId = randomUUID(); jobs.set(jobId, { sha256: digest(await fs.readFile(params.path)), path: params.path, cancelled: false });
    started.resolve(params.path); await returned.promise; return { jobId, status: "RUNNING" };
  } });
  const context = await stageOnlineSourceFiles(f.input);
  const parsed = context.withParsed("original", async () => assert.fail("late parse cannot acquire authority"));
  const rejected = assert.rejects(parsed, /abort/i);
  const path = await started.promise; f.signal.abort();
  const disposed = context.dispose();
  assert.equal((await fs.stat(path)).isFile(), true, "pending parse still owns its input");
  returned.resolve(); await rejected; await disposed;
  assert.deepEqual(f.calls.map(([method]) => method), ["courseware.parseStart", "courseware.parseCancel", "courseware.parseStatus", "courseware.parseRelease"]);
  assert.equal(f.jobs.size, 0); assert.deepEqual(await fs.readdir(f.workspace), []);
});

test("account or Host changes after parser await suppress callbacks but still release the captured Host job", async t => {
  for (const action of ["revoke", "replaceHost"]) {
    let f;
    f = await fixture(t, { call(method) {
      if (method === "courseware.parseStatus") { f[action](); return { status: "RUNNING" }; }
    } });
    // Make cleanup status terminal instead of invoking the mutation indefinitely.
    const originalCall = f.host.call; let statusCalls = 0;
    f.host.call = async (method, params) => {
      if (method === "courseware.parseStatus" && ++statusCalls > 1) return { status: "FAILED" };
      return originalCall(method, params);
    };
    const context = await stageOnlineSourceFiles(f.input);
    await assert.rejects(context.withParsed("target", async () => assert.fail("foreign selection callback")), /changed|CONTEXT_CHANGED/);
    assert.equal(f.jobs.size, 0); assert.deepEqual(await fs.readdir(f.workspace), []);
  }
});

test("concurrent parse or preview is refused and dispose waits for an in-use preview", async t => {
  const f = await fixture(t), context = await stageOnlineSourceFiles(f.input), entered = deferred(), complete = deferred();
  const preview = context.preview("target", 1, async input => { entered.resolve(input.snapshot.sourcePath); await complete.promise; return "result"; });
  const failed = assert.rejects(preview, /abort/i), path = await entered.promise;
  await assert.rejects(context.withParsed("original", async () => {}), /SOURCE_BUSY/);
  const disposing = context.dispose(); assert.equal((await fs.stat(path)).isFile(), true);
  complete.resolve(); await failed; await disposing; await assert.rejects(fs.stat(path), { code: "ENOENT" });
});

test("unknown parser admission and failed release retain private copies rather than deleting an unaccounted parser input", async t => {
  for (const failure of ["courseware.parseStart", "courseware.parseRelease"]) {
    const f = await fixture(t, { call(method) { if (method === failure) throw new Error("transport lost"); } });
    const context = await stageOnlineSourceFiles(f.input);
    await assert.rejects(context.withParsed("original", async () => {}), /CLEANUP_FAILED|transport lost/);
    await assert.rejects(context.dispose(), /CLEANUP_FAILED|transport lost/);
    assert.equal((await fs.readdir(f.workspace)).length, 1);
  }
});

test("replacement directories are never recursively deleted during cleanup", async t => {
  const f = await fixture(t), context = await stageOnlineSourceFiles(f.input);
  const path = await context.preview("target", 1, async input => input.snapshot.sourcePath), directory = dirname(path);
  await fs.rename(directory, `${directory}-original`); await fs.mkdir(directory); await fs.writeFile(join(directory, "keep"), "different directory");
  await assert.rejects(context.dispose(), /CONTEXT_CHANGED/);
  assert.equal(await fs.readFile(join(directory, "keep"), "utf8"), "different directory");
  assert.equal(digest(await fs.readFile(join(`${directory}-original`, "target.pptx"))), f.target.source.sha256);
});


test("controlled cleanup deadline rejects a parser that keeps reporting RUNNING and retains its private inputs", async t => {
  let ticks = 0;
  class Clock extends Date { static now() { return ticks++ * 2000; } }
  const { stageOnlineSourceFiles: stageWithClock } = load("../electron/main/courseware-online-source-files.ts", { "./office-file": office }, Clock);
  let f;
  f = await fixture(t, { call(method) {
    if (method === "courseware.parseStatus") { f.signal.abort(); return { status: "RUNNING" }; }
  } });
  const context = await stageWithClock(f.input);
  await assert.rejects(context.withParsed("target", async () => assert.fail("cancelled parser callback")), /CLEANUP_FAILED/);
  await assert.rejects(context.dispose(), /CLEANUP_FAILED/);
  assert(f.calls.filter(([name]) => name === "courseware.parseStatus").length < 10);
  assert.equal(f.calls.some(([name]) => name === "courseware.parseRelease"), false);
  assert.equal((await fs.readdir(f.workspace)).length, 1);
});
