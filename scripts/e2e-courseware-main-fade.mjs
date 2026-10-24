/** Production Main coordinator + actual Host/worker/archives. Native state is an explicit fixture. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import * as shared from "../packages/shared/dist/index.js";
import * as runtime from "../packages/agent-runtime/dist/index.js";

const [worker, source, out] = process.argv.slice(2);
const hostBin = process.env.PI_DESKTOP_HOST_BIN;
const adoptionGate = process.env.DECKWISE_E2E_EXPECT_SOURCE_ADOPTION === "1";
assert([worker, source, out, hostBin].every(path => path && isAbsolute(path)));
await mkdir(out);
const temp = await mkdtemp(join(tmpdir(), "deckwise-main-fade-"));
const data = join(temp, "data"); const workspace = join(temp, "workspace");
const archive = join(workspace, ".deckwise-ppt/revisions/main-fade/r0001/document.pptx");
await mkdir(join(data, "plugins/market"), { recursive: true });
await writeFile(join(data, "plugins/market/catalog.json"), JSON.stringify({ schemaVersion: 2, providerId: "official", plugins: [] }));
await mkdir(dirname(archive), { recursive: true }); await copyFile(source, archive);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const sourceHash = hash(await readFile(archive));
const nativeRequire = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const ts = nativeRequire("typescript");
const JSZip = createRequire(new URL("../packages/agent-runtime/package.json", import.meta.url))("jszip");
const loaded = new Map();
function load(name) {
  if (loaded.has(name)) return loaded.get(name);
  const url = new URL(`../apps/desktop/electron/main/${name}.ts`, import.meta.url);
  const code = ts.transpileModule(nativeRequire("node:fs").readFileSync(url, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} };
  new Function("require", "exports", code)(id => id === "@pi-desktop/shared" ? shared : id === "@pi-desktop/agent-runtime" ? runtime : id.startsWith("./") ? load(id.slice(2)) : nativeRequire(id), module.exports);
  loaded.set(name, module.exports); return module.exports;
}
const { CoursewareTeachingCoordinator } = load("courseware-teaching");
const { CoursewareCandidateCoordinator } = load("courseware-candidates");
const { PptEditorChatBridge } = load("ppt-editor-chat");
const report = { sourceAdoption: adoptionGate, status: "RUNNING", checks: [], temp, sourceHash, electronUi: false, nativeStateFixture: true, paidCalls: false };
const logs = []; const calls = []; let child, exited, host, nextId = 0, afterCall;
async function start() {
  child = spawn(hostBin, [], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, LANG: "C.UTF-8", PI_DESKTOP_DATA_DIR: data, PI_DESKTOP_PLUGIN_MARKET_URL: "http://127.0.0.1:9/catalog.json", DECKWISE_PPTX_NODE: process.execPath, DECKWISE_PPTX_WORKER: worker } });
  const pending = new Map();
  exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(`Host exited ${code}/${signal}`)); }
    pending.clear(); resolve(code);
  }); });
  child.stderr.on("data", bytes => logs.push(String(bytes)));
  createInterface({ input: child.stdout }).on("line", line => {
    const response = JSON.parse(line); const entry = pending.get(response.id); if (!entry) return;
    pending.delete(response.id); clearTimeout(entry.timer);
    if (response.error) entry.reject(new Error(JSON.stringify(response.error))); else entry.resolve(response.result);
  });
  host = { async call(method, params = {}) {
    calls.push([method, structuredClone(params)]);
    const result = await new Promise((resolve, reject) => {
      const id = ++nextId; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, 100_000);
      pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
    await afterCall?.(method, params, result); return result;
  } };
  await host.call("app.handshake", { protocolVersion: 11 });
}
async function stop() {
  if (!child) return; const process = child; child = undefined; process.stdin.end();
  const timer = setTimeout(() => process.kill("SIGKILL"), 10_000);
  try { assert.equal(await exited, 0); } finally { clearTimeout(timer); }
}
async function step(name, fn) { console.log("START", name); await fn(); report.checks.push(name); console.log("PASS", name); }
let sessionId, before, context, receipt, bridge, teaching, active = true, dirty = false;
const binding = { projectId: "native-project", documentId: "native-document", sessionId: "native-session" };
const editorContext = { ...binding, editGeneration: 1, kind: "slide", page: 2, selectedText: "", selectionCharacters: 0, readOnly: false, capabilities: [] };
const snapshot = { ...binding, path: archive, revision: 1, sha256: sourceHash };
const editor = {
  async getContext() { return structuredClone(editorContext); },
  teachingSnapshot() { if (dirty) throw new Error("Save or reopen"); return { ...snapshot }; },
  async verifyTeachingSource() { assert.equal(hash(await readFile(archive)), sourceHash); },
  execute() { throw new Error("No native command is authorized"); },
};
const getProject = () => host.call("courseware.project.get", { sessionId, projectId: context.baseline.coursewareProjectId });
const propose = () => bridge.execute(sessionId, "ppt_propose_page_fade", { kind: "page-fade", baseline: context.baseline }, () => active);
try {
  await step("Production Main bridge prepares, generates, parses and stages a fade copy", async () => {
    await start(); sessionId = (await host.call("session.create", { projectPath: workspace })).session.id;
    bridge = new PptEditorChatBridge(editor, () => host, async () => workspace, () => sessionId);
    bridge.setOwner(sessionId); bridge.setVisible(true); await bridge.capture(sessionId);
    teaching = new CoursewareTeachingCoordinator(editor, () => host, async () => workspace, () => sessionId, id => bridge.assertActive(id));
    const coordinator = new CoursewareCandidateCoordinator(teaching, () => { throw new Error("Fade must not call a model"); });
    bridge.candidates = (...args) => coordinator.execute(...args);
    context = await bridge.execute(sessionId, "ppt_get_narration_context", binding, () => active);
    before = (await getProject()).project;
    if (adoptionGate) {
      await host.call("courseware.teaching.write", { sessionId, write: {
        projectId: before.projectId, pageId: before.pages[1].pageId,
        expectedSourceRevision: before.source.revision, expectedTeachingRevision: before.teachingRevision,
        actions: [{ id: "adoption-speech", type: "speech", text: "Good! Keep going.", pauseAfterMs: 4000 }],
      } });
      before = (await getProject()).project;
      await host.call("courseware.teaching.setLock", { sessionId, projectId: before.projectId,
        pageId: before.pages[0].pageId, expectedSourceRevision: before.source.revision,
        expectedTeachingRevision: before.teachingRevision, locked: true });
      context = await bridge.execute(sessionId, "ppt_get_narration_context", binding, () => active);
      before = (await getProject()).project;
    }
    calls.length = 0;
    afterCall = async (method, params, result) => {
      if (method !== "courseware.sourceCandidate.stage") return;
      afterCall = undefined;
      assert.equal(result.lineageVerified, true);
      for (const change of ["sourceSha256", "outputSha256", "mappingRevision", "pageId", "slidePart", "extra"]) {
        const invalid = structuredClone(params);
        invalid.fadeEvidence[change] = change === "slidePart" ? "ppt/slides/../slide1.xml" : "forged";
        await assert.rejects(host.call(method, invalid));
        assert.deepEqual(await host.call("courseware.sourceCandidate.get", { sessionId,
          projectId: params.projectId, candidateId: params.candidateId }), result);
      }
      const legacyReplay = { ...params }; delete legacyReplay.fadeEvidence;
      assert.deepEqual(await host.call(method, legacyReplay), result);
      report.evidenceRejections = 6;
    };
    receipt = await propose();
    assert.equal(receipt.kind, "page-fade"); assert.equal(receipt.applied, false); assert.equal(receipt.reviewState, "needs-review");
    assert.notEqual(receipt.outputSha256, sourceHash); assert.deepEqual((await getProject()).project, before);
    assert.equal(hash(await readFile(archive)), sourceHash);
    const parses = calls.filter(([method]) => method.startsWith("courseware.parse") && !method.endsWith("Status"));
    assert.deepEqual(parses.map(([method]) => method), ["courseware.parseStart", "courseware.parseRelease", "courseware.parseStart", "courseware.parseRelease"]);
    assert.equal(parses[0][1].path, archive); assert.notEqual(parses[2][1].path, archive);
    assert(!(await readdir(dirname(archive))).some(name => name.startsWith(".candidate-")));
    const staged = await host.call("courseware.sourceCandidate.get", { sessionId, projectId: before.projectId, candidateId: receipt.candidateId });
    assert.equal(staged.status, "needs-review"); assert.equal(staged.lineageVerified, true); assert.equal(staged.outputSha256, receipt.outputSha256);
    const preview = await host.call("courseware.sourceCandidate.preview", { sessionId, projectId: before.projectId, candidateId: receipt.candidateId });
    assert.equal(preview.candidate.outputSha256, receipt.outputSha256);
    assert.equal(preview.path, join(data, "courseware-candidates", `${receipt.outputSha256}.pptx`));
    assert.equal(hash(await readFile(preview.path)), receipt.outputSha256);
    assert.equal(hash(await readFile(join(data, "courseware-candidates", `${receipt.outputSha256}.pptx`))), receipt.outputSha256);
    const generation = await host.call("courseware.sourceCandidate.context", { sessionId, projectId: before.projectId, candidateId: receipt.candidateId });
    const sourceBytes = await readFile(archive);
    const target = await runtime.resolvePageFadeTarget(sourceBytes, generation.mapping, context.baseline.pageId);
    const originalZip = await JSZip.loadAsync(sourceBytes);
    const outputZip = await JSZip.loadAsync(await readFile(join(data, "courseware-candidates", `${receipt.outputSha256}.pptx`)));
    assert.deepEqual(Object.values(outputZip.files).filter(entry => !entry.dir).map(entry => entry.name).sort(), Object.values(originalZip.files).filter(entry => !entry.dir).map(entry => entry.name).sort());
    let preserved = 0;
    for (const [name, entry] of Object.entries(originalZip.files)) {
      if (entry.dir || name === target.slidePart) continue;
      assert.deepEqual(await outputZip.file(name).async("nodebuffer"), await entry.async("nodebuffer"), name);
      preserved++;
    }
    assert.match(await outputZip.file(target.slidePart).async("string"), /<p:transition[^>]* spd="med" advClick="1"><p:fade\/><\/p:transition>/);
    report.changedPart = target.slidePart; report.preservedPackageParts = preserved;
    await writeFile(join(out, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  });
  if (adoptionGate) {
    let parserJob;
    let adoption;
    const read = () => ({ sessionId, projectId: before.projectId });
    const candidateRead = () => ({ ...read(), candidateId: receipt.candidateId });
    const parse = async path => {
      const { jobId } = await host.call("courseware.parseStart", { sessionId, path });
      const deadline = Date.now() + 95_000;
      while (Date.now() < deadline) {
        const state = await host.call("courseware.parseStatus", { jobId });
        if (state.status !== "RUNNING") { assert.equal(state.status, "SUCCEEDED", JSON.stringify(state)); return jobId; }
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      throw new Error("Adoption parser timed out");
    };
    const release = async () => { await host.call("courseware.parseRelease", { jobId: parserJob }); parserJob = undefined; };
    await step("Explicit intent fences teaching and candidates; cancellation requires the original parsed revision", async () => {
      parserJob = await parse(archive);
      const payload = { sessionId, jobId: parserJob, candidateId: receipt.candidateId };
      await assert.rejects(host.call("courseware.sourceAdoption.prepare", { ...payload, path: "/forged" }), /1002/);
      const otherRoot = join(temp, "other"); await mkdir(otherRoot);
      const otherSessionId = (await host.call("session.create", { projectPath: otherRoot })).session.id;
      await assert.rejects(host.call("courseware.sourceAdoption.prepare", { ...payload, sessionId: otherSessionId }), /another workspace/);
      adoption = (await host.call("courseware.sourceAdoption.prepare", payload)).adoption;
      assert.equal(adoption.status, "pending");
      assert.deepEqual((await host.call("courseware.sourceAdoption.prepare", payload)).adoption, adoption);
      await assert.rejects(host.call("courseware.sourceAdoption.get", { ...read(), sessionId: otherSessionId }), /not found/);
      for (const [method, args] of [
        ["courseware.project.get", read()],
        ["courseware.project.openSaved", { sessionId, jobId: parserJob }],
        ["courseware.sourceCandidate.reject", candidateRead()],
        ["courseware.sourceCandidate.preview", candidateRead()],
        ["courseware.teaching.write", { sessionId, write: { projectId: before.projectId, pageId: before.pages[0].pageId,
          expectedSourceRevision: before.source.revision, expectedTeachingRevision: before.teachingRevision, actions: [] } }],
      ]) await assert.rejects(host.call(method, args), /source adoption pending/);
      await assert.rejects(host.call("courseware.sourceAdoption.commit", { sessionId, jobId: parserJob, adoptionId: adoption.adoptionId }), /differs from adoption/);
      const outputArchive = join(data, "courseware-candidates", `${receipt.outputSha256}.pptx`);
      const preserved = await readFile(outputArchive);
      await writeFile(outputArchive, "unavailable output");
      const recovery = await host.call("courseware.sourceAdoption.get", read());
      assert.deepEqual(recovery.adoption, adoption);
      assert.equal(recovery.path, null); assert.match(recovery.archiveError, /archive bytes changed/);
      const cancelled = await host.call("courseware.sourceAdoption.cancel", { sessionId, jobId: parserJob, adoptionId: adoption.adoptionId });
      await writeFile(outputArchive, preserved);
      assert.equal(cancelled.status, "cancelled");
      assert.deepEqual((await getProject()).project, before);
      assert.equal((await host.call("courseware.sourceCandidate.get", candidateRead())).status, "needs-review");
      const previousId = adoption.adoptionId;
      adoption = (await host.call("courseware.sourceAdoption.prepare", payload)).adoption;
      assert.notEqual(adoption.adoptionId, previousId);
      await assert.rejects(host.call("courseware.sourceAdoption.cancel", { sessionId, jobId: parserJob, adoptionId: previousId }), /id changed/);
      await release();
    });
    await step("Pending intent survives Host restart and both private archives remain hash verified", async () => {
      await stop(); await start();
      assert.deepEqual((await host.call("courseware.sourceAdoption.get", read())).adoption, adoption);
      await assert.rejects(getProject(), /source adoption pending/);
      for (const digest of [sourceHash, receipt.outputSha256]) {
        const path = join(data, "courseware-candidates", `${digest}.pptx`);
        const bytes = await readFile(path); await writeFile(path, "corrupt archive");
        const recovery = await host.call("courseware.sourceAdoption.get", read());
        assert.deepEqual(recovery.adoption, adoption); assert.equal(recovery.path, null);
        assert.match(recovery.archiveError, /archive bytes changed/);
        await writeFile(path, bytes);
      }
      assert.deepEqual((await host.call("courseware.sourceAdoption.get", read())).adoption, adoption);
      assert.equal(hash(await readFile(archive)), sourceHash);
    });
    const nextRevision = join(workspace, ".deckwise-ppt/revisions/main-fade/r0002/document.pptx");
    let committed;
    await step("Fresh candidate revision parse commits source, teaching, identities and terminal status together", async () => {
      const { path } = await host.call("courseware.sourceAdoption.get", read());
      await mkdir(dirname(nextRevision), { recursive: true }); await copyFile(path, nextRevision);
      parserJob = await parse(nextRevision);
      const payload = { sessionId, jobId: parserJob, adoptionId: adoption.adoptionId };
      const parsedBytes = await readFile(nextRevision);
      await writeFile(nextRevision, "changed after parsing");
      await assert.rejects(host.call("courseware.sourceAdoption.commit", payload), /changed after parsing/);
      await writeFile(nextRevision, parsedBytes);
      await assert.rejects(host.call("courseware.sourceAdoption.cancel", payload), /differs from adoption/);
      committed = await host.call("courseware.sourceAdoption.commit", payload);
      assert.equal(committed.status, "committed");
      assert.equal(committed.project.source.sha256, receipt.outputSha256);
      assert.equal(committed.project.projectId, before.projectId);
      assert.notEqual(committed.project.teachingRevision, before.teachingRevision);
      assert.deepEqual(committed.project.pages.map(page => [page.pageId, page.actions, page.locked]), before.pages.map(page => [page.pageId, page.actions, page.locked]));
      assert.deepEqual((await getProject()).project, committed.project);
      assert.deepEqual((await host.call("courseware.project.openSaved", { sessionId, jobId: parserJob })).project, committed.project);
      const candidate = await host.call("courseware.sourceCandidate.get", candidateRead());
      assert.equal(candidate.status, "adopted"); assert.equal(candidate.applied, true);
      await assert.rejects(host.call("courseware.sourceCandidate.reject", candidateRead()), /cannot be rejected/);
      await release();
      assert.equal(hash(await readFile(archive)), sourceHash, "Historical saved revision must be immutable");
      assert.equal(hash(await readFile(nextRevision)), receipt.outputSha256);
    });
    await step("Lost commit response recovers after complete restart without a second teaching mutation", async () => {
      await stop(); await start();
      assert.deepEqual((await host.call("courseware.sourceAdoption.get", read())).adoption, committed);
      parserJob = await parse(nextRevision);
      assert.deepEqual(await host.call("courseware.sourceAdoption.commit", { sessionId, jobId: parserJob, adoptionId: adoption.adoptionId }), committed);
      assert.deepEqual((await host.call("courseware.project.openSaved", { sessionId, jobId: parserJob })).project, committed.project);
      await release();
      report.adoption = committed;
    });
  } else {
  await step("Forged proposal, dirty or hidden editor cannot generate", async () => {
    for (const change of ["extra", "baseline", "dirty", "hidden"]) {
      const count = calls.filter(([method]) => method.endsWith(".prepare")).length;
      if (change === "dirty") dirty = true; if (change === "hidden") bridge.setVisible(false);
      const input = { kind: "page-fade", baseline: context.baseline };
      if (change === "extra") input.path = "/forged";
      if (change === "baseline") input.baseline = { ...context.baseline, pageId: "forged" };
      await assert.rejects(bridge.execute(sessionId, "ppt_propose_page_fade", input, () => active));
      assert.equal(calls.filter(([method]) => method.endsWith(".prepare")).length, count);
      dirty = false; bridge.setVisible(true);
    }
  });
  await step("Cancel, navigation, teaching change and competing open cannot stage an old result", async () => {
    for (const change of ["cancel", "page", "teaching", "competing-open"]) {
      context = await bridge.execute(sessionId, "ppt_get_narration_context", binding, () => active);
      let outputJob;
      const count = calls.filter(([method]) => method.endsWith(".stage")).length;
      afterCall = async (method, params, result) => {
        if (method === "courseware.parseStart" && params.path !== archive) outputJob = result.jobId;
        if (method !== "courseware.parseStatus" || params.jobId !== outputJob || result.status !== "SUCCEEDED") return;
        afterCall = undefined;
        if (change === "cancel") active = false;
        if (change === "page") { editorContext.page++; editorContext.editGeneration++; }
        if (change === "teaching") await host.call("courseware.teaching.write", { sessionId, write: { projectId: before.projectId, pageId: before.pages[0].pageId, expectedSourceRevision: before.source.revision, expectedTeachingRevision: before.teachingRevision, actions: [{ id: "changed", type: "speech", text: "Concurrent edit", pauseAfterMs: 1000 }] } });
        if (change === "competing-open") await assert.rejects(teaching.open(sessionId), /already opening/);
      };
      if (change === "competing-open") await propose(); else await assert.rejects(propose());
      assert.equal(calls.filter(([method]) => method.endsWith(".stage")).length, count + (change === "competing-open" ? 1 : 0));
      active = true; editorContext.page = 2; editorContext.editGeneration = 1;
      assert.equal(hash(await readFile(archive)), sourceHash);
      assert(!(await readdir(dirname(archive))).some(name => name.startsWith(".candidate-")));
    }
  });
  await step("Candidate archives and status survive complete Host restart", async () => {
    afterCall = undefined; await stop(); await start();
    const staged = await host.call("courseware.sourceCandidate.get", { sessionId, projectId: before.projectId, candidateId: receipt.candidateId });
    assert.equal(staged.status, "needs-review"); assert.equal(staged.outputSha256, receipt.outputSha256); assert.equal(staged.applied, false); assert.equal(staged.lineageVerified, true);
    assert.equal(staged.stale, true, "The concurrent teaching edit made this original proposal stale");
    await assert.rejects(host.call("courseware.sourceCandidate.preview", { sessionId, projectId: before.projectId, candidateId: receipt.candidateId }), /stale/);
    assert.equal(hash(await readFile(join(data, "courseware-candidates", `${receipt.outputSha256}.pptx`))), receipt.outputSha256);
  });
  }
  report.status = "PASS";
} catch (error) { report.status = "FAIL"; report.error = String(error.stack || error); process.exitCode = 1; }
finally { await stop(); await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n"); await writeFile(join(out, "host.log"), logs.join("")); console.log(JSON.stringify(report)); }
