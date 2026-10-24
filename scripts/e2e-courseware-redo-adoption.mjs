/** Real Host/D-worker gate. Injected generator fixtures are not production Chat authority. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Host, resolveHostBinary } from "./e2e/host.mjs";

const [worker, source, generator, out] = process.argv.slice(2);
assert([worker, source, generator, out].every(p => p && isAbsolute(p)), "Supply absolute worker, source, generator module and fresh evidence directory");
assert.equal(process.env.DECKWISE_PPTX_WORKER, worker);
assert.equal(process.env.DECKWISE_PPTX_NODE, process.execPath);
await mkdir(out);
const temp = await mkdtemp(join(tmpdir(), "deckwise-redo-adoption-"));
const data = join(temp, "data");
const workspace = join(temp, "workspace");
const revision = number => join(workspace, `.deckwise-ppt/revisions/redo-e2e/r000${number}/document.pptx`);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const host = new Host(resolveHostBinary(), data);
const report = { status: "RUNNING", checks: [], nativeEditor: false, productionMain: false, productionChat: false, paidCalls: false };
const step = async (name, action) => { console.log("START", name); await action(); report.checks.push(name); console.log("PASS", name); };
let job, sessionId, project, context, generated, staged, intent;
const read = () => ({ sessionId, projectId: project.projectId, candidateId: "redo-1" });
const saved = () => ({ sessionId, jobId: job.jobId });
const canonical = async () => (await host.call("courseware.project.get", { sessionId, projectId: project.projectId })).project;
async function parse(path) {
  if (job) { await host.call("courseware.parseRelease", { jobId: job.jobId }); job = undefined; }
  job = await host.call("courseware.parseStart", { sessionId, path });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const status = await host.call("courseware.parseStatus", { jobId: job.jobId });
    if (status.status !== "RUNNING") { assert.equal(status.status, "SUCCEEDED", JSON.stringify(status)); return; }
    await delay(20);
  }
  throw new Error("Parser did not finish");
}
try {
  await mkdir(join(data, "plugins/market"), { recursive: true });
  await writeFile(join(data, "plugins/market/catalog.json"), JSON.stringify({ schemaVersion: 2, providerId: "official", plugins: [] }));
  await mkdir(join(revision(1), ".."), { recursive: true }); await copyFile(source, revision(1));
  await step("Prepare latest source and generate an exact single-page B candidate", async () => {
    await host.start(); sessionId = (await host.call("session.create", { projectPath: workspace })).session.id;
    await parse(revision(1));
    project = (await host.call("courseware.project.openSaved", saved())).project;
    assert.equal(project.pages.length, 3);
    for (let i = 0; i < 3; i++) {
      project = (await host.call("courseware.teaching.write", { sessionId, write: {
        projectId: project.projectId, pageId: project.pages[i].pageId, expectedSourceRevision: project.source.revision,
        expectedTeachingRevision: project.teachingRevision, actions: [{ id: `speech-${i}`, type: "speech", text: `Good! Page ${i + 1}.`, pauseAfterMs: 4000 }],
      } })).project;
      project = (await host.call("courseware.teaching.confirm", { sessionId, projectId: project.projectId, pageId: project.pages[i].pageId,
        expectedSourceRevision: project.source.revision, expectedTeachingRevision: project.teachingRevision })).project;
    }
    project = (await host.call("courseware.teaching.setLock", { sessionId, projectId: project.projectId, pageId: project.pages[0].pageId,
      expectedSourceRevision: project.source.revision, expectedTeachingRevision: project.teachingRevision, locked: true })).project;
    await host.call("courseware.sourceCandidate.prepare", { ...saved(), request: { candidateId: "redo-1", kind: "page-pptx",
      pageId: project.pages[1].pageId, expectedSourceRevision: project.source.revision, expectedTeachingRevision: project.teachingRevision } });
    context = await host.call("courseware.sourceCandidate.context", read());
    const { text } = await host.call("courseware.pageText", { ...saved(), pageNumber: 2 });
    const module = await import(pathToFileURL(generator).href);
    generated = await module.generate({ context, sourcePptx: await readFile(revision(1)), pageText: text, out,
      getContext: () => host.call("courseware.sourceCandidate.context", read()) });
    assert.equal(generated.proof.sourceSha256, project.source.sha256);
    assert.equal(generated.proof.outputSha256, hash(generated.pptx));
    await writeFile(join(workspace, "candidate.pptx"), generated.pptx);
    await writeFile(join(out, "before.json"), JSON.stringify({ project, context, proof: generated.proof }, null, 2));
  });
  await step("Strict proof staging rejects tampering; unverified candidates cannot adopt", async () => {
    await parse(join(workspace, "candidate.pptx"));
    let params = { ...read(), jobId: job.jobId, outputSha256: hash(generated.pptx) };
    await host.call("courseware.sourceCandidate.stage", params);
    await parse(revision(1));
    await assert.rejects(host.call("courseware.sourceAdoption.prepare", { ...saved(), candidateId: "redo-1" }), /verified/);
    await parse(join(workspace, "candidate.pptx"));
    params = { ...params, jobId: job.jobId };
    for (const field of ["protocol", "sourceSha256", "outputSha256", "mappingRevision", "pageId", "slidePart"]) {
      await assert.rejects(host.call("courseware.sourceCandidate.stage", { ...params, redoEvidence: { ...generated.proof, [field]: "wrong" } }));
    }
    await assert.rejects(host.call("courseware.sourceCandidate.stage", { ...params, redoEvidence: { ...generated.proof, extra: true } }), /unknown field/);
    staged = await host.call("courseware.sourceCandidate.stage", { ...params, redoEvidence: generated.proof });
    assert.equal(staged.lineageVerified, true); assert.equal(staged.applied, false);
    assert.deepEqual(await host.call("courseware.sourceCandidate.stage", { ...params, redoEvidence: generated.proof }), staged);
    assert.deepEqual(await canonical(), project);
  });
  await step("Review and cancellation survive full Host restart with original untouched", async () => {
    await parse(revision(1));
    intent = await host.call("courseware.sourceAdoption.prepare", { ...saved(), candidateId: "redo-1" });
    assert.equal(hash(await readFile(intent.path)), hash(generated.pptx));
    await host.restart(); job = undefined;
    const recovered = await host.call("courseware.sourceAdoption.get", { sessionId, projectId: project.projectId });
    assert.deepEqual(recovered.adoption, intent.adoption);
    assert.equal(recovered.path, intent.path); assert.equal(recovered.archiveError, null);
    await assert.rejects(canonical(), /adoption pending/);
    await parse(revision(1));
    assert.equal((await host.call("courseware.sourceAdoption.cancel", { ...saved(), adoptionId: intent.adoption.adoptionId })).status, "cancelled");
    assert.equal(hash(await readFile(revision(1))), project.source.sha256);
    assert.deepEqual(await canonical(), project);
  });
  await step("Commit reparsed output after interrupted intent and preserve peer teaching", async () => {
    intent = await host.call("courseware.sourceAdoption.prepare", { ...saved(), candidateId: "redo-1" });
    await mkdir(join(revision(2), ".."), { recursive: true }); await copyFile(intent.path, revision(2));
    await host.restart(); job = undefined;
    await parse(revision(2));
    const committed = await host.call("courseware.sourceAdoption.commit", { ...saved(), adoptionId: intent.adoption.adoptionId });
    assert.equal(committed.status, "committed");
    assert.equal(committed.project.source.sha256, hash(generated.pptx));
    assert.notEqual(committed.project.teachingRevision, project.teachingRevision);
    for (let i = 0; i < 3; i++) {
      assert.equal(committed.project.pages[i].pageId, project.pages[i].pageId);
      assert.deepEqual(committed.project.pages[i].actions, project.pages[i].actions);
      assert.equal(committed.project.pages[i].locked, project.pages[i].locked);
      assert.equal(committed.project.pages[i].reviewState, i === 1 ? "review" : project.pages[i].reviewState);
    }
    assert.deepEqual(await host.call("courseware.sourceAdoption.commit", { ...saved(), adoptionId: intent.adoption.adoptionId }), committed);
    await writeFile(join(out, "committed.json"), JSON.stringify(committed, null, 2));
    project = committed.project;
  });
  await step("Restart retains page IDs and only target object IDs are replaced", async () => {
    await host.restart(); job = undefined;
    assert.deepEqual(await canonical(), project);
    assert.equal((await host.call("courseware.sourceCandidate.get", read())).status, "adopted");
    await assert.rejects(host.call("courseware.sourceCandidate.reject", read()), /adopted/);
    await parse(revision(2));
    await host.call("courseware.sourceCandidate.prepare", { ...saved(), request: { candidateId: "inspect-mapping", kind: "page-pptx",
      pageId: project.pages[1].pageId, expectedSourceRevision: project.source.revision, expectedTeachingRevision: project.teachingRevision } });
    const next = await host.call("courseware.sourceCandidate.context", { ...read(), candidateId: "inspect-mapping" });
    assert.notEqual(next.mapping.revision, context.mapping.revision);
    for (const index of [0, 2]) assert.deepEqual(next.mapping.pages[index], context.mapping.pages[index]);
    assert.equal(next.mapping.pages[1].pageId, context.mapping.pages[1].pageId);
    const old = new Set(context.mapping.pages.flatMap(p => p.objects.map(o => o.objectId)));
    assert(next.mapping.pages[1].objects.length > 0);
    for (const object of next.mapping.pages[1].objects) assert(!old.has(object.objectId));
    await writeFile(join(out, "after-context.json"), JSON.stringify(next, null, 2));
    await host.call("courseware.sourceCandidate.reject", { ...read(), candidateId: "inspect-mapping" });
    assert.equal(hash(await readFile(revision(1))), context.mapping.sourceSha256);
  });
  report.status = "PASS_HOST_REDO_ADOPTION";
} catch (error) { report.error = String(error.stack || error); throw error; }
finally {
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(join(out, "host-stderr.log"), host.stderr);
  await host.stop(); await rm(temp, { recursive: true, force: true });
}
