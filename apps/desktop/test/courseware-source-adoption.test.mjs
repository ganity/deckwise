import assert from "node:assert/strict";
import { readFileSync, promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import ts from "typescript";
import * as shared from "../../../packages/shared/dist/index.js";

const require = createRequire(import.meta.url);
const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file);
  const module = { exports: {} }; cache.set(file, module.exports);
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  new Function("require", "exports", "module", "__dirname", outputText)(id => {
    if (id === "@pi-desktop/shared") return shared;
    if (id.startsWith(".")) return load(join(dirname(file), `${id}.ts`));
    return require(id);
  }, module.exports, module, dirname(file));
  return module.exports;
}
const main = new URL("../electron/main/", import.meta.url).pathname;
const { CoursewareSourceAdoption } = load(join(main, "courseware-source-adoption.ts"));
const { sourceHash, installSourceCandidate, restoreMissingSource, rollBackSourceCandidate, adoptionRevision } = load(join(main, "courseware-source-files.ts"));
const { jobIdFor } = load(join(main, "ppt-editor-files.ts"));
const bytes = Buffer.from("PK\x03\x04ppt/presentation.xml[Content_Types].xml");
const output = Buffer.concat([bytes, Buffer.from("candidate")]);

async function fixture(t) {
  const workspace = await fs.mkdtemp(join(tmpdir(), "courseware-adoption-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const source = join(workspace, "lesson.pptx");
  const candidate = join(workspace, "candidate.pptx");
  await fs.writeFile(source, bytes); await fs.writeFile(candidate, output);
  return { workspace, source, candidate };
}

test("installation preserves original backup and publishes an immutable next revision", async t => {
  const f = await fixture(t);
  const originalRevision = await adoptionRevision(f.workspace, f.source, bytes);
  await fs.chmod(f.source, 0o600);
  await installSourceCandidate(f.workspace, f.source, "adoption-1", f.candidate, sourceHash(bytes), sourceHash(output));
  assert.deepEqual(await fs.readFile(f.source), output);
  assert.equal((await fs.stat(f.source)).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readFile(join(f.workspace, ".lesson.pptx.adoption-adoption-1/original.pptx")), bytes);
  const revision = await adoptionRevision(f.workspace, f.source, output);
  assert.equal(revision.revision, 2);
  assert.deepEqual(await fs.readFile(originalRevision.documentPath), bytes);
  assert.deepEqual(await fs.readFile(revision.documentPath), output);
  assert.equal((await adoptionRevision(f.workspace, f.source, output)).revision, 2);
});

test("rollback restores known original bytes and retains rejected candidate without overwriting unknown bytes", async t => {
  const f = await fixture(t);
  await installSourceCandidate(f.workspace, f.source, "adoption-1", f.candidate, sourceHash(bytes), sourceHash(output));
  await rollBackSourceCandidate(f.workspace, f.source, "adoption-1", sourceHash(bytes), sourceHash(output));
  assert.deepEqual(await fs.readFile(f.source), bytes);
  assert.deepEqual(await fs.readFile(join(f.workspace, ".lesson.pptx.adoption-adoption-1-rollback/original.pptx")), output);
  const external = Buffer.concat([bytes, Buffer.from("external")]); await fs.writeFile(f.source, external);
  await assert.rejects(rollBackSourceCandidate(f.workspace, f.source, "adoption-1", sourceHash(bytes), sourceHash(output)), /Unknown live bytes/);
  assert.deepEqual(await fs.readFile(f.source), external);
});

test("crash after displacement restores the exact backup without overwriting a competing writer", async t => {
  const f = await fixture(t);
  const directory = join(f.workspace, ".lesson.pptx.adoption-adoption-1");
  await fs.mkdir(directory); await fs.rename(f.source, join(directory, "original.pptx"));
  await restoreMissingSource(f.workspace, f.source, "adoption-1", sourceHash(bytes));
  assert.deepEqual(await fs.readFile(f.source), bytes);
  const thirdParty = Buffer.concat([bytes, Buffer.from("third-party")]);
  await fs.writeFile(f.source, thirdParty);
  await restoreMissingSource(f.workspace, f.source, "adoption-1", sourceHash(bytes));
  assert.deepEqual(await fs.readFile(f.source), thirdParty);
});

test("missing-source recovery refuses a backup whose bytes changed", async t => {
  const f = await fixture(t);
  const directory = join(f.workspace, ".lesson.pptx.adoption-adoption-1");
  await fs.mkdir(directory); await fs.rename(f.source, join(directory, "original.pptx"));
  await fs.writeFile(join(directory, "original.pptx"), output);
  await assert.rejects(restoreMissingSource(f.workspace, f.source, "adoption-1", sourceHash(bytes)), /backup changed/);
  await assert.rejects(fs.stat(f.source), { code: "ENOENT" });
  assert.deepEqual(await fs.readFile(join(directory, "original.pptx")), output);
});

test("wrong source, corrupt candidate, outside paths and existing backup directories reject intact", async t => {
  const f = await fixture(t);
  for (const change of ["source", "candidate", "directory", "path"]) {
    const id = `case-${change}`;
    if (change === "directory") await fs.mkdir(join(f.workspace, `.lesson.pptx.adoption-${id}`));
    await assert.rejects(installSourceCandidate(f.workspace,
      change === "path" ? join(f.workspace, "../outside.pptx") : f.source,
      id, f.candidate, change === "source" ? "0".repeat(64) : sourceHash(bytes),
      change === "candidate" ? "0".repeat(64) : sourceHash(output)));
    assert.deepEqual(await fs.readFile(f.source), bytes);
  }
});

async function coordinatorFixture(t) {
  const f = await fixture(t);
  const project = JSON.parse(await fs.readFile(new URL("../../../packages/shared/src/courseware-contract.fixtures/accepted.json", import.meta.url), "utf8")).project;
  project.projectId = `office-${jobIdFor(f.workspace, f.source)}`;
  project.source = { revision: sourceHash(output), sha256: sourceHash(output) };
  let receipt = null, frozen = false, dirty = false, lostCommit = false, sessionId = "chat-1";
  const calls = [];
  const host = { async call(method, params) {
    calls.push([method, params]);
    if (method === "courseware.sourceAdoption.forPath") {
      assert.deepEqual(params, { sessionId: "chat-1", sourcePath: f.source });
      return { adoption: receipt?.status === "pending" ? structuredClone(receipt) : null };
    }
    if (method === "courseware.project.attach") return { attached: project.projectId.startsWith("portable-") };
    if (method === "courseware.parseStart") return { jobId: params.path };
    if (method === "courseware.parseStatus") return { status: "SUCCEEDED", summary: { sourceSha256: sourceHash(await fs.readFile(params.jobId)) } };
    if (method === "courseware.parseRelease") return {};
    if (method.endsWith(".commit") || method.endsWith(".cancel")) {
      receipt.status = method.endsWith(".commit") ? "committed" : "cancelled";
      receipt.project = receipt.status === "committed" ? project : null;
      if (lostCommit && receipt.status === "committed") { lostCommit = false; throw new Error("lost commit response"); }
      return structuredClone(receipt);
    }
    throw new Error(method);
  } };
  const snapshot = { sourcePath: f.source, sha256: sourceHash(bytes), revision: 1 };
  const editor = {
    sourceAdoptionSnapshot() { if (dirty) throw new Error("dirty native state"); return snapshot; },
    freezeForSourceAdoption() { if (dirty) throw new Error("dirty native state"); frozen = true; },
  };
  const teaching = {
    async preparePptxAdoption() {
      receipt = { adoptionId: "adoption-1", projectId: project.projectId, candidateId: "candidate-1", sourcePath: f.source,
        sourceSha256: sourceHash(bytes), outputSha256: sourceHash(output), status: "pending", project: null };
      return { adoption: receipt, path: f.candidate, snapshot, context: {}, sessionId: "chat-1", host };
    },
    async assertCurrent() { if (dirty) throw new Error("dirty native state"); },
  };
  const make = () => new CoursewareSourceAdoption(editor, teaching, () => host, async () => f.workspace, () => sessionId, () => {});
  return { ...f, host, teaching, project, make, calls, receipt: () => receipt, frozen: () => frozen,
    prepare: () => teaching.preparePptxAdoption(), dirty: () => { dirty = true; }, loseCommit: () => { lostCommit = true; }, switchChat: () => { sessionId = "chat-2"; } };
}

test("adopt closes native editor, installs, commits and reopens the same document", async t => {
  const f = await coordinatorFixture(t); let reopened;
  await f.make().adopt("review-1", async path => { reopened = path; });
  assert.equal(f.frozen(), true); assert.equal(reopened, "lesson.pptx");
  assert.equal(f.receipt().status, "committed");
  assert.deepEqual(await fs.readFile(f.source), output);
  assert.equal(f.calls.filter(([method]) => method.endsWith(".commit")).length, 1);
});

test("portable source adoption recovers by persisted path and attaches each fresh parser before commit", async t => {
  const f = await coordinatorFixture(t);
  f.project.projectId = "portable-b219f446-0cbc-4d35-97cb-fb8bb1a3e365";
  await f.prepare();
  await installSourceCandidate(f.workspace, f.source, "adoption-1", f.candidate, sourceHash(bytes), sourceHash(output));
  await f.make().beforeOpen(f.workspace, "lesson.pptx", "chat-1");
  assert.equal(f.receipt().status, "committed");
  assert.equal(f.receipt().project.projectId, f.project.projectId);
  const methods = f.calls.map(([method]) => method);
  assert(methods.indexOf("courseware.sourceAdoption.forPath") < methods.indexOf("courseware.parseStart"));
  assert(methods.indexOf("courseware.project.attach") < methods.indexOf("courseware.sourceAdoption.commit"));
  assert(!methods.includes("courseware.sourceAdoption.get"));
});

for (const change of ["owner", "binding", "foreign-path", "foreign-result", "lookup-error"]) test(`source adoption refuses ${change} without an unfenced commit`, async t => {
  const f = await coordinatorFixture(t), call = f.host.call;
  await f.prepare();
  f.host.call = async (method, params) => {
    if (method === "courseware.sourceAdoption.forPath" && change === "lookup-error") throw new Error("Host unavailable");
    const result = await call(method, params);
    if (method === "courseware.sourceAdoption.forPath" && change === "owner") f.switchChat();
    if (method === "courseware.sourceAdoption.forPath" && change === "foreign-path") result.adoption.sourcePath = f.candidate;
    if (method === "courseware.project.attach" && change === "binding") result.attached = true;
    if (method.endsWith(".cancel") && change === "foreign-result") result.projectId = "another-project";
    return result;
  };
  await assert.rejects(f.make().beforeOpen(f.workspace, "lesson.pptx", "chat-1"));
  assert.deepEqual(await fs.readFile(f.source), bytes);
  assert(!f.calls.some(([method]) => method === "courseware.sourceAdoption.commit"));
  if (["binding", "foreign-result"].includes(change)) assert(f.calls.some(([method]) => method === "courseware.parseRelease"));
});

test("source adoption accepts the Host's preserved TTS actions, waits and locked peers after recovery", async t => {
  const f = await coordinatorFixture(t);
  const audioAssetId = `tts-${"a".repeat(64)}`;
  f.project.pages[0].actions = [
    { id: "speech-audio", type: "speech", text: "Keep this exact narration", source: "notes", pauseAfterMs: 1700, audioAssetId },
    { id: "wait-audio", type: "interaction_checkpoint", checkpointId: "checkpoint-audio", checkpointKind: "teacher_continue" },
  ];
  f.project.pages[1].locked = true;
  const expected = structuredClone(f.project);
  f.loseCommit();
  await assert.rejects(f.make().adopt("review-audio", async () => {}), /lost commit response/);
  await f.make().beforeOpen(f.workspace, "lesson.pptx", "chat-1");
  assert.deepEqual(f.receipt().project, expected);
  assert.equal(f.calls.filter(([method]) => method.endsWith(".commit")).length, 1);
  assert.deepEqual(await fs.readFile(f.source), output);
});

test("Host audio preflight rejection leaves source bytes intact before editor freeze or install", async t => {
  const f = await coordinatorFixture(t);
  f.teaching.preparePptxAdoption = async () => { throw new Error("COURSEWARE_AUDIO_REQUIRED: no matching adopted receipt"); };
  await assert.rejects(f.make().adopt("review-forged-audio", async () => {}), /COURSEWARE_AUDIO_REQUIRED/);
  assert.equal(f.frozen(), false);
  assert.equal(f.receipt(), null);
  assert.deepEqual(await fs.readFile(f.source), bytes);
  assert(!f.calls.some(([method]) => method.endsWith(".commit")));
  await assert.rejects(fs.stat(join(f.workspace, ".lesson.pptx.adoption-adoption-1")), { code: "ENOENT" });
});

test("pending before replacement cancels on open; pending after replacement commits on open", async t => {
  for (const installed of [false, true]) {
    const f = await coordinatorFixture(t); await f.prepare();
    if (installed) await installSourceCandidate(f.workspace, f.source, "adoption-1", f.candidate, sourceHash(bytes), sourceHash(output));
    await f.make().beforeOpen(f.workspace, "lesson.pptx", "chat-1");
    assert.equal(f.receipt().status, installed ? "committed" : "cancelled");
  }
});

test("lost commit response recovers by journal status without duplicate write", async t => {
  const f = await coordinatorFixture(t); f.loseCommit(); let reopened = false;
  await assert.rejects(f.make().adopt("review-1", async () => { reopened = true; }), /lost commit response/);
  assert.equal(f.receipt().status, "committed"); assert.equal(reopened, true);
  await f.make().beforeOpen(f.workspace, "lesson.pptx", "chat-1");
  assert.equal(f.calls.filter(([method]) => method.endsWith(".commit")).length, 1);
});

test("interrupted recovery cancels and releases its running parser before retry", async t => {
  const f = await coordinatorFixture(t); await f.prepare();
  const call = f.host.call; let interrupted = false; let cancelled = false;
  f.host.call = async (method, params) => {
    if (method === "courseware.parseStatus" && !interrupted) { interrupted = true; throw new Error("lost parse response"); }
    if (method === "courseware.parseCancel") { cancelled = true; return {}; }
    if (method === "courseware.parseRelease") assert.equal(cancelled, true);
    return call(method, params);
  };
  const coordinator = f.make();
  await assert.rejects(coordinator.beforeOpen(f.workspace, "lesson.pptx", "chat-1"), /lost parse response/);
  assert.equal(cancelled, true); assert.equal(f.calls.at(-1)[0], "courseware.parseRelease");
  assert.equal(f.receipt().status, "pending");
  await coordinator.beforeOpen(f.workspace, "lesson.pptx", "chat-1");
  assert.equal(f.receipt().status, "cancelled");
});

test("unknown third-party bytes keep journal pending and native editor closed", async t => {
  const f = await coordinatorFixture(t); await f.prepare();
  const external = Buffer.concat([bytes, Buffer.from("external")]); await fs.writeFile(f.source, external);
  await assert.rejects(f.make().beforeOpen(f.workspace, "lesson.pptx", "chat-1"), /third-party/);
  assert.equal(f.receipt().status, "pending");
  assert.deepEqual(await fs.readFile(f.source), external);
});

test("dirty native state cannot start adoption and busy operations reject concurrent opens", async t => {
  const f = await coordinatorFixture(t); f.dirty();
  await assert.rejects(f.make().adopt("review-1", async () => {}), /dirty native/);
  assert.equal(f.receipt(), null);
  const g = await coordinatorFixture(t); const coordinator = g.make();
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const running = coordinator.adopt("review-1", async () => { await wait; });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.throws(() => coordinator.assertIdle(), /Finish source adoption/);
  await assert.rejects(coordinator.beforeOpen(g.workspace, "lesson.pptx", "chat-1"), /Finish source adoption/);
  release(); await running; coordinator.assertIdle();
});
