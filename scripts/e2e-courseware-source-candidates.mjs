/** Actual Host/worker/archive gate; optional local generator test adapter, no model or UI. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const [worker, source, candidateFile, kind, out] = process.argv.slice(2);
const hostBin = process.env.PI_DESKTOP_HOST_BIN;
const generatorModule = process.env.DECKWISE_CANDIDATE_GENERATOR_MODULE;
assert(!generatorModule || isAbsolute(generatorModule), "Generator test module must be absolute");
assert([worker, source, candidateFile, out, hostBin].every((path) => path && isAbsolute(path)), "Supply absolute worker, source PPTX, candidate PPTX, kind, new evidence directory and PI_DESKTOP_HOST_BIN");
assert(["page-pptx", "page-fade"].includes(kind), "Supply the candidate kind");
await mkdir(out);
const temp = await mkdtemp(join(tmpdir(), "deckwise-source-candidate-"));
const data = join(temp, "data");
const workspace = join(temp, "workspace");
const otherWorkspace = join(temp, "other");
const archive = join(workspace, ".deckwise-ppt/revisions/identity-e2e/r0001/document.pptx");
await mkdir(join(data, "plugins/market"), { recursive: true });
await writeFile(join(data, "plugins/market/catalog.json"), JSON.stringify({ schemaVersion: 2, providerId: "official", plugins: [] }));
await mkdir(otherWorkspace);
await mkdir(join(archive, ".."), { recursive: true });
await copyFile(source, archive);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourceHash = hash(await readFile(source));
const report = { status: "RUNNING", checks: [], temp, sourceHash, paidCalls: false, electronUi: false, referenceApi: false, generatedFixtureOnly: !generatorModule, localGeneration: !!generatorModule, kind, lineageVerified: false };
const logs = [];
let host;
let sequence = 0;

async function start(workerPath = worker) {
  const child = spawn(hostBin, [], { stdio: ["pipe", "pipe", "pipe"], env: {
    PATH: process.env.PATH, LANG: "C.UTF-8", PI_DESKTOP_DATA_DIR: data,
    PI_DESKTOP_PLUGIN_MARKET_URL: "http://127.0.0.1:9/catalog.json",
    DECKWISE_PPTX_NODE: process.execPath, DECKWISE_PPTX_WORKER: workerPath,
  } });
  const pending = new Map();
  const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(`Host exited ${code}/${signal}`)); }
    pending.clear(); resolve({ code, signal });
  }); });
  child.stderr.on("data", (bytes) => logs.push(String(bytes)));
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const response = JSON.parse(line);
    const waiter = pending.get(response.id);
    if (!waiter) return;
    pending.delete(response.id); clearTimeout(waiter.timer);
    if (response.error) waiter.reject(new Error(JSON.stringify(response.error)));
    else waiter.resolve(response.result);
  });
  host = { child, exited, call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, 100_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  } };
  await host.call("app.handshake", { protocolVersion: 11 });
}

async function stop() {
  if (!host) return;
  const current = host; host = undefined;
  current.child.stdin.end();
  const timer = setTimeout(() => current.child.kill("SIGKILL"), 10_000);
  try { assert.equal((await current.exited).code, 0); } finally { clearTimeout(timer); }
}

async function step(name, action) {
  console.log("START", name); await action(); report.checks.push(name); console.log("PASS", name);
}

async function parse(sessionId, path = archive) {
  const job = await host.call("courseware.parseStart", { sessionId, path });
  const deadline = Date.now() + 95_000;
  while (Date.now() < deadline) {
    const result = await host.call("courseware.parseStatus", { jobId: job.jobId });
    if (result.status !== "RUNNING") { assert.equal(result.status, "SUCCEEDED", JSON.stringify(result)); return { ...result, jobId: job.jobId }; }
    await delay(20);
  }
  throw new Error("Parser did not finish");
}

const candidatePath = join(workspace, "candidate.pptx");
await copyFile(candidateFile, candidatePath);
let outputHash = hash(await readFile(candidateFile));
let archivePath = join(data, "courseware-candidates", `${outputHash}.pptx`);
const baselinePath = join(data, "courseware-candidates", `${sourceHash}.pptx`);
let sessionId, otherSessionId, project, prepared, staged;
const read = (id = "candidate-1", session = sessionId) => ({ sessionId: session, projectId: project.projectId, candidateId: id });
const request = (candidateId = "candidate-1", current = project) => ({ candidateId, kind, pageId: current.pages[1].pageId,
 expectedSourceRevision: current.source.revision, expectedTeachingRevision: current.teachingRevision });
let job;
async function release() {
 await host.call("courseware.parseRelease", { jobId: job.jobId }); job = undefined;
}
try {
 await step("Prepare from actual saved-source identity without changing authoritative teaching", async () => {
  await start();
  sessionId = (await host.call("session.create", { projectPath: workspace })).session.id;
  otherSessionId = (await host.call("session.create", { projectPath: otherWorkspace })).session.id;
  job = await parse(sessionId);
  project = (await host.call("courseware.project.openSaved", { sessionId, jobId: job.jobId })).project;
  prepared = await host.call("courseware.sourceCandidate.prepare", { sessionId, jobId: job.jobId, request: request() });
  assert.equal(prepared.status, "preparing"); assert.equal(prepared.applied, false);
  const context = await host.call("courseware.sourceCandidate.context", read());
  assert.deepEqual(context.candidate, prepared); assert.equal(context.mapping.sourceSha256, sourceHash);
  assert.equal(context.mapping.revision, prepared.mappingRevision);
  assert.deepEqual(context.mapping.pages.map((page) => page.pageId), project.pages.map((page) => page.pageId));
  assert.equal(hash(await readFile(baselinePath)), sourceHash);
  await writeFile(join(out, "generation-context.json"), JSON.stringify(context, null, 2) + "\n");
  if (generatorModule) {
   const { text } = await host.call("courseware.pageText", { sessionId, jobId: job.jobId, pageNumber: 2 });
   const { generate } = await import(pathToFileURL(generatorModule).href);
   const generated = await generate({ context, sourcePptx: await readFile(baselinePath), pageText: text, kind, out,
    getContext: () => host.call("courseware.sourceCandidate.context", read()) });
   await writeFile(candidatePath, generated.pptx);
   outputHash = hash(generated.pptx); archivePath = join(data, "courseware-candidates", `${outputHash}.pptx`);
   report.generation = generated.report;
   report.referenceApi = true;
  }
  await assert.rejects(host.call("courseware.sourceCandidate.prepare", { sessionId, jobId: job.jobId, request: request(), workspace }), /1002/);
  await assert.rejects(host.call("courseware.sourceCandidate.prepare", { sessionId: otherSessionId, jobId: job.jobId, request: request() }), /another workspace/);
  await release(); await stop(); await start();
  assert.deepEqual(await host.call("courseware.sourceCandidate.get", read()), prepared);
  assert.deepEqual(await host.call("courseware.sourceCandidate.context", read()), context);
  await assert.rejects(host.call("courseware.sourceCandidate.context", { ...read(), mapping: context.mapping }), /1002/);
  await assert.rejects(host.call("courseware.sourceCandidate.context", read("candidate-1", otherSessionId)), /not found/);
 });
 await step("Stage actual B PPTX bytes via real D2f parse and immutable Host archive", async () => {
  job = await parse(sessionId, candidatePath);
  const base = { ...read(), jobId: job.jobId, outputSha256: outputHash };
  await assert.rejects(host.call("courseware.sourceCandidate.stage", { ...base, outputSha256: "0".repeat(64) }), /differs from generated bytes/);
  await assert.rejects(host.call("courseware.sourceCandidate.stage", { ...base, sessionId: otherSessionId }), /not found/);
  await assert.rejects(host.call("courseware.sourceCandidate.stage", { ...base, lineage: {} }), /1002/);
  const original = await readFile(candidatePath);
  await writeFile(candidatePath, "altered after parse");
  await assert.rejects(host.call("courseware.sourceCandidate.stage", base), /changed after parsing/);
  await writeFile(candidatePath, original);
  staged = await host.call("courseware.sourceCandidate.stage", base);
  assert.equal(staged.status, "needs-review"); assert.equal(staged.outputSha256, outputHash);
  assert.equal(staged.lineageVerified, false); assert.equal(staged.applied, false); assert.equal(staged.stale, false);
  assert.deepEqual(await host.call("courseware.sourceCandidate.stage", base), staged);
  assert.equal(hash(await readFile(archivePath)), outputHash);
  assert.deepEqual((await host.call("courseware.project.get", { sessionId, projectId: project.projectId })).project, project);
  await release(); await rm(candidatePath); await stop(); await start();
  assert.deepEqual(await host.call("courseware.sourceCandidate.get", read()), staged);
  assert.equal(hash(await readFile(archive)), sourceHash);
 });
 await step("Recover exact baseline and mapping without workspace bytes; reject missing/corrupt original archive", async () => {
  const context = await host.call("courseware.sourceCandidate.context", read());
  const original = await readFile(archive);
  await rm(archive);
  assert.deepEqual(await host.call("courseware.sourceCandidate.context", read()), context);
  await writeFile(archive, original);
  const baseline = await readFile(baselinePath);
  await writeFile(baselinePath, "altered baseline");
  await assert.rejects(host.call("courseware.sourceCandidate.context", read()), /archive bytes changed/);
  await rm(baselinePath);
  await assert.rejects(host.call("courseware.sourceCandidate.context", read()), /No such file/);
  await writeFile(baselinePath, baseline);
  assert.deepEqual(await host.call("courseware.sourceCandidate.context", read()), context);
 });
 await step("Recover after restart, reject corrupt/missing archives and isolate workspaces", async () => {
  await assert.rejects(host.call("courseware.sourceCandidate.get", read("candidate-1", otherSessionId)), /not found/);
  await assert.rejects(host.call("courseware.sourceCandidate.get", { ...read(), outputSha256: outputHash }), /1002/);
  const bytes = await readFile(archivePath);
  await writeFile(archivePath, "tampered");
  await assert.rejects(host.call("courseware.sourceCandidate.get", read()), /archive bytes changed/);
  await rm(archivePath);
  await assert.rejects(host.call("courseware.sourceCandidate.get", read()), /No such file/);
  await writeFile(archivePath, bytes);
  assert.deepEqual(await host.call("courseware.sourceCandidate.get", read()), staged);
 });
 await step("Full-project change marks pending source stale; rejection survives another restart", async () => {
  const changed = (await host.call("courseware.teaching.write", { sessionId, write: {
    projectId: project.projectId, pageId: project.pages[0].pageId,
    expectedSourceRevision: project.source.revision, expectedTeachingRevision: project.teachingRevision,
    actions: [{ id: "speech", type: "speech", text: "Good!", pauseAfterMs: 4000 }],
  } })).project;
  assert.equal((await host.call("courseware.sourceCandidate.get", read())).stale, true);
  await assert.rejects(host.call("courseware.sourceCandidate.context", read()), /stale or rejected/);
  await copyFile(candidateFile, candidatePath); job = await parse(sessionId, candidatePath);
  await assert.rejects(host.call("courseware.sourceCandidate.stage", { ...read(), jobId: job.jobId, outputSha256: outputHash }), /stale or rejected/);
  await release();
  const rejected = await host.call("courseware.sourceCandidate.reject", read());
  assert.equal(rejected.status, "rejected"); assert.equal(rejected.stale, true);
  assert.deepEqual(await host.call("courseware.sourceCandidate.reject", read()), rejected);
  await assert.rejects(host.call("courseware.sourceCandidate.context", read()), /stale or rejected/);
  await stop(); await start();
  assert.deepEqual(await host.call("courseware.sourceCandidate.get", read()), rejected);
  assert.deepEqual((await host.call("courseware.project.get", { sessionId, projectId: project.projectId })).project, changed);
  assert.equal(hash(await readFile(archive)), sourceHash);
 });
 report.status = "PASS"; report.outputHash = outputHash; report.projectId = project.projectId;
} catch (error) {
 report.status = "FAIL"; report.error = String(error.stack || error); process.exitCode = 1;
} finally {
 await stop();
 await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
 await writeFile(join(out, "host.log"), logs.join(""));
 console.log(JSON.stringify(report));
}
