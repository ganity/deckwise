/** Actual Host/worker/SQLite identity gate. No renderer, model or provider calls. */
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const [worker, source, out] = process.argv.slice(2);
const hostBin = process.env.PI_DESKTOP_HOST_BIN;
assert([worker, source, out, hostBin].every((path) => path && isAbsolute(path)), "Supply absolute worker, source PPTX, new evidence directory and PI_DESKTOP_HOST_BIN");
await mkdir(out);
const temp = await mkdtemp(join(tmpdir(), "deckwise-identity-"));
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
const report = { status: "RUNNING", checks: [], temp, sourceHash, paidCalls: false, electronUi: false, referenceApi: false };
const logs = [];
let host;
let sequence = 0;

async function start(workerPath = worker) {
  const child = spawn(hostBin, [], { stdio: ["pipe", "pipe", "pipe"], env: {
    PATH: process.env.PATH, LANG: "C.UTF-8", PI_DESKTOP_DATA_DIR: data,
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

async function identities() {
  const { stdout } = await promisify(execFile)("python3", ["-c", "import sqlite3,json,sys; db=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); print(json.dumps([json.loads(row[0]) for row in db.execute(\"SELECT value_json FROM kv WHERE ns='coursewareIdentities.v1'\")]))", join(data, "pi.sqlite")]);
  return JSON.parse(stdout);
}

let sessionId;
let otherSessionId;
let parsed;
let project;
let savedIdentity;
try {
  await step("Admit the real D2f worker and reject forged/cross-workspace openSaved", async () => {
    await start();
    sessionId = (await host.call("session.create", { projectPath: workspace })).session.id;
    otherSessionId = (await host.call("session.create", { projectPath: otherWorkspace })).session.id;
    parsed = await parse(sessionId);
    assert.equal(parsed.summary.sourceSha256, sourceHash);
    assert.match(parsed.summary.identitySha256, /^[a-f0-9]{64}$/);
    await assert.rejects(host.call("courseware.project.openSaved", { sessionId, jobId: parsed.jobId, identity: {} }), /1002/);
    await assert.rejects(host.call("courseware.project.openSaved", { sessionId: otherSessionId, jobId: parsed.jobId }), /another workspace/);
  });
  await step("Reject altered identity bytes using the completed-job digest pin", async () => {
    const identityPath = join(parsed.outputDirectory, "identity.json");
    const original = await readFile(identityPath);
    await writeFile(identityPath, "{}");
    const resultPath = join(parsed.outputDirectory, "result.json");
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    result.identitySha256 = hash(Buffer.from("{}"));
    await writeFile(resultPath, JSON.stringify(result));
    await assert.rejects(host.call("courseware.project.openSaved", { sessionId, jobId: parsed.jobId }), /digest mismatch/);
    assert.deepEqual(await identities(), []);
    assert.equal((await host.call("courseware.project.get", { sessionId, projectId: "office-identity-e2e" })).project, null);
    await writeFile(identityPath, original);
    project = (await host.call("courseware.project.openSaved", { sessionId, jobId: parsed.jobId })).project;
    [savedIdentity] = await identities();
    assert(savedIdentity.mappingRevision);
    assert.equal(savedIdentity.pages.length, project.pages.length);
    savedIdentity.pages.forEach((page, index) => {
      assert.equal(page.logicalId, project.pages[index].pageId);
      for (const object of page.objects) assert.match(object.logicalId, /^[0-9a-f-]{36}$/);
    });
    await writeFile(join(out, "bound-identity.json"), JSON.stringify(savedIdentity, null, 2));
    await writeFile(join(out, "worker-identity.json"), original);
  });
  await step("Persist narration and lock, then release all temporary parser output", async () => {
    project = (await host.call("courseware.teaching.write", { sessionId, write: {
      projectId: project.projectId, pageId: project.pages[0].pageId,
      expectedSourceRevision: project.source.revision, expectedTeachingRevision: project.teachingRevision,
      actions: [{ id: "speech-identity", type: "speech", text: "Good! Look at the picture." }],
    } })).project;
    project = (await host.call("courseware.teaching.setLock", { sessionId, projectId: project.projectId, pageId: project.pages[0].pageId, expectedSourceRevision: project.source.revision, expectedTeachingRevision: project.teachingRevision, locked: true })).project;
    await host.call("courseware.parseRelease", { jobId: parsed.jobId });
    await assert.rejects(readFile(join(parsed.outputDirectory, "identity.json")));
    assert.deepEqual(await identities(), [savedIdentity]);
  });
  await step("Restart the actual Host and reparse without changing IDs, narration or lock", async () => {
    await stop(); await start();
    assert.deepEqual((await host.call("courseware.project.get", { sessionId, projectId: project.projectId })).project, project);
    parsed = await parse(sessionId);
    assert.deepEqual((await host.call("courseware.project.openSaved", { sessionId, jobId: parsed.jobId })).project, project);
    assert.deepEqual(await identities(), [savedIdentity]);
    await host.call("courseware.parseRelease", { jobId: parsed.jobId });
  });
  await step("Changed but parseable PPTX cannot migrate teaching or replace its baseline", async () => {
    const changed = join(workspace, ".deckwise-ppt/revisions/identity-e2e/r0002/document.pptx");
    await mkdir(join(changed, ".."), { recursive: true });
    await writeFile(changed, Buffer.concat([await readFile(source), Buffer.from("\n")]));
    parsed = await parse(sessionId, changed);
    assert.notEqual(parsed.summary.sourceSha256, sourceHash);
    await assert.rejects(host.call("courseware.project.openSaved", { sessionId, jobId: parsed.jobId }), /COURSEWARE_CONFLICT/);
    assert.deepEqual((await host.call("courseware.project.get", { sessionId, projectId: project.projectId })).project, project);
    assert.deepEqual(await identities(), [savedIdentity]);
    await host.call("courseware.parseRelease", { jobId: parsed.jobId });
    assert.equal(hash(await readFile(source)), sourceHash);
  });
  if (process.env.DECKWISE_IDENTITY_REFERENCE_API) await step("D2f validates and reproduces the Host-bound identity from its mapping", async () => {
    const api = await import(pathToFileURL(process.env.DECKWISE_IDENTITY_REFERENCE_API));
    const mapping = { revision: savedIdentity.mappingRevision, sourceSha256: sourceHash,
      pages: savedIdentity.pages.map((page) => ({ pageId: page.logicalId, importPageId: page.importPageId,
        objects: page.objects.map((object) => ({ objectId: object.logicalId, importElementId: object.importElementId })),
      })),
    };
    const exported = JSON.parse(await readFile(join(out, "worker-identity.json"), "utf8"));
    assert.deepEqual(api.validateSavedSourceIdentity(savedIdentity), savedIdentity);
    assert.deepEqual(api.bindSavedSourceIdentity(exported, mapping), savedIdentity);
    await writeFile(join(out, "host-mapping.json"), JSON.stringify(mapping, null, 2));
    report.referenceApi = true;
    report.referenceApiSha256 = hash(await readFile(process.env.DECKWISE_IDENTITY_REFERENCE_API));
  });
  if (process.env.DECKWISE_LEGACY_PPTX_WORKER) await step("Actual legacy worker reopens teaching and retains the existing identity", async () => {
    await stop(); await start(process.env.DECKWISE_LEGACY_PPTX_WORKER);
    parsed = await parse(sessionId);
    assert.equal(parsed.summary.identitySha256, undefined);
    assert.deepEqual((await host.call("courseware.project.openSaved", { sessionId, jobId: parsed.jobId })).project, project);
    assert.deepEqual(await identities(), [savedIdentity]);
    await host.call("courseware.parseRelease", { jobId: parsed.jobId });
  });
  if (process.env.DECKWISE_E2E_EXPECT_REVIEW === "1") await step("Durable review rejects stale teaching and adopts only explicit associations after Host restart", async () => {
    await stop(); await start();
    const changed = join(workspace, ".deckwise-ppt/revisions/identity-e2e/r0002/document.pptx");
    parsed = await parse(sessionId, changed);
    let review = await host.call("courseware.review.prepare", { sessionId, jobId: parsed.jobId });
    await assert.rejects(host.call("courseware.review.prepare", { sessionId: otherSessionId, jobId: parsed.jobId }), /another workspace/);
    await assert.rejects(host.call("courseware.review.adopt", { sessionId, jobId: parsed.jobId, reviewId: review.reviewId, bindings: project.pages.map(() => null) }), /COURSEWARE_LOCKED/);
    project = (await host.call("courseware.teaching.setLock", { sessionId, projectId: project.projectId, pageId: project.pages[0].pageId, expectedSourceRevision: project.source.revision, expectedTeachingRevision: project.teachingRevision, locked: true })).project;
    await assert.rejects(host.call("courseware.review.adopt", { sessionId, jobId: parsed.jobId, reviewId: review.reviewId, bindings: project.pages.map((entry) => entry.pageId) }), /COURSEWARE_CONFLICT/);
    review = await host.call("courseware.review.prepare", { sessionId, jobId: parsed.jobId });
    await host.call("courseware.parseRelease", { jobId: parsed.jobId });
    await stop(); await start();
    parsed = await parse(sessionId, changed);
    assert.deepEqual(await host.call("courseware.review.prepare", { sessionId, jobId: parsed.jobId }), review);
    const request = { sessionId, jobId: parsed.jobId, reviewId: review.reviewId, bindings: project.pages.map((entry) => entry.pageId) };
    await assert.rejects(host.call("courseware.review.adopt", { ...request, lineage: {} }), /1002/);
    const bytesBefore = hash(await readFile(changed));
    const adopted = (await host.call("courseware.review.adopt", request)).project;
    assert.equal(adopted.source.sha256, bytesBefore);
    assert.deepEqual(adopted.pages, project.pages);
    assert.notEqual(adopted.teachingRevision, project.teachingRevision);
    assert.equal(hash(await readFile(changed)), bytesBefore);
    assert.equal((await identities()).length, 2);
    assert.deepEqual((await identities()).find((entry) => entry.sourceSha256 === sourceHash), savedIdentity);
    await assert.rejects(host.call("courseware.review.adopt", request), /COURSEWARE_CONFLICT/);
    await host.call("courseware.parseRelease", { jobId: parsed.jobId });
    await writeFile(join(out, "adopted-project.json"), JSON.stringify(adopted, null, 2));
  });
  if (process.env.DECKWISE_E2E_EXPECT_NARRATION_CANDIDATE === "1") {
    assert(process.env.DECKWISE_NARRATION_FIXTURE, "Supply the frozen B narration output fixture");
    const fixtureBytes = await readFile(process.env.DECKWISE_NARRATION_FIXTURE);
    const fixture = JSON.parse(fixtureBytes);
    assert.equal(fixture.audioReady, false);
    report.narrationFixtureSha256 = hash(fixtureBytes);
    report.narrationProducer = "Frozen B2 action payload rebound to actual Host IDs; no generator transport or model call";
    const current = async () => (await host.call("courseware.project.get", { sessionId, projectId: project.projectId })).project;
    const lookup = (candidateId) => ({ sessionId, projectId: project.projectId, candidateId });
    const writeFor = (baseline) => ({ projectId: baseline.projectId, pageId: baseline.pages.find((page) => !page.locked).pageId,
      expectedSourceRevision: baseline.source.revision, expectedTeachingRevision: baseline.teachingRevision, actions: structuredClone(fixture.write.actions) });
    let baseline = await current();
    const activeArchive = baseline.source.sha256 === sourceHash ? archive : join(workspace, ".deckwise-ppt/revisions/identity-e2e/r0002/document.pptx");
    const unchangedBytes = await readFile(activeArchive);
    assert.equal(hash(unchangedBytes), baseline.source.sha256);
    let pending;
    await step("Stage B narration actions without applying; strict authority and restart preserve pending state", async () => {
      parsed = await parse(sessionId, activeArchive);
      const request = { sessionId, jobId: parsed.jobId, candidateId: "narration-1", write: writeFor(baseline) };
      await assert.rejects(host.call("courseware.narrationCandidate.stage", { ...request, workspace }), /1002/);
      await assert.rejects(host.call("courseware.narrationCandidate.stage", { ...request, sessionId: otherSessionId }), /another workspace/);
      pending = await host.call("courseware.narrationCandidate.stage", request);
      assert.equal(pending.status, "needs-review"); assert.equal(pending.audioReady, false);
      assert.deepEqual(await host.call("courseware.narrationCandidate.stage", request), pending);
      assert.deepEqual(await current(), baseline);
      await assert.rejects(host.call("courseware.narrationCandidate.get", { ...lookup("narration-1"), sessionId: otherSessionId }), /COURSEWARE_NOT_FOUND/);
      await host.call("courseware.parseRelease", { jobId: parsed.jobId });
      await stop(); await start();
      assert.deepEqual(await host.call("courseware.narrationCandidate.get", lookup("narration-1")), pending);
      assert.deepEqual(await current(), baseline);
    });
    await step("Stale teaching, rejected proposal and locked target cannot be adopted", async () => {
      parsed = await parse(sessionId, activeArchive);
      const manual = writeFor(baseline); manual.actions = [{ id: "manual-change", type: "speech", text: "Manual revision while a proposal is pending." }];
      baseline = (await host.call("courseware.teaching.write", { sessionId, write: manual })).project;
      await assert.rejects(host.call("courseware.narrationCandidate.adopt", { sessionId, jobId: parsed.jobId, candidateId: "narration-1" }), /COURSEWARE_CONFLICT/);
      const rejected = await host.call("courseware.narrationCandidate.reject", lookup("narration-1"));
      assert.equal(rejected.status, "rejected");
      assert.deepEqual(await host.call("courseware.narrationCandidate.reject", lookup("narration-1")), rejected);
      await assert.rejects(host.call("courseware.narrationCandidate.adopt", { sessionId, jobId: parsed.jobId, candidateId: "narration-1" }), /COURSEWARE_CONFLICT/);
      const locked = baseline.pages.find((page) => page.locked); assert(locked);
      await assert.rejects(host.call("courseware.narrationCandidate.stage", { sessionId, jobId: parsed.jobId, candidateId: "locked", write: { ...writeFor(baseline), pageId: locked.pageId } }), /COURSEWARE_LOCKED/);
      assert.deepEqual(await current(), baseline);
    });
    await step("Fresh-source CAS adopts only the selected page and persists terminal state across Host restart", async () => {
      const write = writeFor(baseline);
      const identityBefore = await identities();
      await host.call("courseware.narrationCandidate.stage", { sessionId, jobId: parsed.jobId, candidateId: "narration-2", write });
      const request = { sessionId, jobId: parsed.jobId, candidateId: "narration-2" };
      await assert.rejects(host.call("courseware.narrationCandidate.adopt", { ...request, write }), /1002/);
      try {
        await writeFile(activeArchive, Buffer.concat([unchangedBytes, Buffer.from(" changed after parse")]));
        await assert.rejects(host.call("courseware.narrationCandidate.adopt", request), /saved revision changed/);
      } finally { await writeFile(activeArchive, unchangedBytes); }
      const adopted = (await host.call("courseware.narrationCandidate.adopt", request)).project;
      assert.equal(adopted.source.sha256, baseline.source.sha256);
      assert.notEqual(adopted.teachingRevision, baseline.teachingRevision);
      assert.deepEqual(adopted.educationContext, baseline.educationContext);
      for (const [index, page] of adopted.pages.entries()) {
        if (page.pageId === write.pageId) assert.deepEqual(page, { ...baseline.pages[index], actions: write.actions, reviewState: "review" });
        else assert.deepEqual(page, baseline.pages[index]);
      }
      assert.equal(hash(await readFile(activeArchive)), hash(unchangedBytes));
      assert.deepEqual(await identities(), identityBefore);
      assert.equal((await host.call("courseware.narrationCandidate.get", lookup("narration-2"))).status, "adopted");
      await assert.rejects(host.call("courseware.narrationCandidate.adopt", request), /COURSEWARE_CONFLICT/);
      await host.call("courseware.parseRelease", { jobId: parsed.jobId });
      await stop(); await start();
      assert.deepEqual(await current(), adopted);
      assert.equal((await host.call("courseware.narrationCandidate.get", lookup("narration-2"))).status, "adopted");
      assert.equal((await host.call("courseware.narrationCandidate.get", lookup("narration-1"))).status, "rejected");
      await writeFile(join(out, "narration-adopted-project.json"), JSON.stringify(adopted, null, 2));
    });
  }
  report.status = "PASS";
} catch (error) { report.status = "FAIL"; report.error = error.stack; process.exitCode = 1; }
finally {
  try { await stop(); } catch (error) { report.status = "FAIL"; report.cleanupError = error.stack; process.exitCode = 1; }
  report.artifacts = { host: { path: hostBin, sha256: hash(await readFile(hostBin)) }, worker: { path: worker, sha256: hash(await readFile(worker)) } };
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(join(out, "host.log"), logs.join(""));
  console.log(JSON.stringify(report, null, 2));
}
