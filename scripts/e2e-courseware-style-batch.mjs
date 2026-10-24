/** Actual Host/parser/batch compiler. Review and model scenes are explicit local fixtures. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Host, resolveHostBinary } from "./e2e/host.mjs";

const [worker, source, out] = process.argv.slice(2);
assert.equal(process.argv.length, 5);
assert([worker, source, out].every(p => p && isAbsolute(p)));
assert.equal(process.env.DECKWISE_PPTX_WORKER, worker);
assert.equal(process.env.DECKWISE_PPTX_NODE, process.execPath);
await mkdir(out);
const temp = await mkdtemp(join(tmpdir(), "deckwise-style-batch-"));
const data = join(temp, "data"), workspace = join(temp, "workspace");
const revision = n => join(workspace, `.deckwise-ppt/revisions/style-e2e/r000${n}/document.pptx`);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const host = new Host(resolveHostBinary(), data);
const runtime = await import(pathToFileURL(join(worker, "../authoring.mjs")).href);
const report = { status: "RUNNING", checks: [], productionMain: false, productionChat: false, nativeEditor: false, paidCalls: false };
let job, sessionId, project, context, representative, batch, proof, intent, instruction;
const read = candidateId => ({ sessionId, projectId: project.projectId, candidateId });
const saved = () => ({ sessionId, jobId: job.jobId });
const canonical = async () => (await host.call("courseware.project.get", { sessionId, projectId: project.projectId })).project;
const step = async (name, action) => { console.log("START", name); await action(); report.checks.push(name); console.log("PASS", name); };
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
const request = candidateId => ({ candidateId, pageId: project.pages[1].pageId,
  kind: "page-pptx", expectedSourceRevision: project.source.revision, expectedTeachingRevision: project.teachingRevision });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
const generate = async request => ({ scene: request.schema.parse({ version: 1, slideId: request.pageId,
  sourceHash: request.sourceHash, canvas: request.canvas, visualMasterAssetId: "master", cleanPlateAssetId: "clean",
  elements: [{ id: "title", type: "native_text", bboxPx: [50, 50, 700, 100], zIndex: 1,
    content: "STYLE_BATCH_EDITABLE", style: { fontFace: "Arial", fontSizePt: 28, color: "#173B65" } }],
}), assets: { master: png, clean: png } });
try {
  await mkdir(join(data, "plugins/market"), { recursive: true });
  await writeFile(join(data, "plugins/market/catalog.json"), JSON.stringify({ schemaVersion: 2, providerId: "official", plugins: [] }));
  await mkdir(join(revision(1), ".."), { recursive: true }); await copyFile(source, revision(1));
  await step("Actual Host prepares a verified representative from its saved page mapping", async () => {
    await host.start(); sessionId = (await host.call("session.create", { projectPath: workspace })).session.id;
    await parse(revision(1)); project = (await host.call("courseware.project.openSaved", saved())).project;
    assert.equal(project.pages.length, 3);
    for (let i = 0; i < 3; i++) {
      project = (await host.call("courseware.teaching.write", { sessionId, write: { projectId: project.projectId,
        pageId: project.pages[i].pageId, expectedSourceRevision: project.source.revision, expectedTeachingRevision: project.teachingRevision,
        actions: [{ id: `speech-${i}`, type: "speech", text: `Good! Page ${i + 1}.`, pauseAfterMs: 4000 }],
      } })).project;
      project = (await host.call("courseware.teaching.confirm", { sessionId, projectId: project.projectId, pageId: project.pages[i].pageId,
        expectedSourceRevision: project.source.revision, expectedTeachingRevision: project.teachingRevision })).project;
    }
    project = (await host.call("courseware.teaching.setLock", { sessionId, projectId: project.projectId, pageId: project.pages[2].pageId,
      expectedSourceRevision: project.source.revision, expectedTeachingRevision: project.teachingRevision, locked: true })).project;
    await host.call("courseware.sourceCandidate.prepare", { ...saved(), request: request("representative") });
    context = await host.call("courseware.sourceCandidate.context", read("representative"));
    const texts = [];
    for (let n = 1; n <= 3; n++) texts.push((await host.call("courseware.pageText", { ...saved(), pageNumber: n })).text);
    const contexts = project.pages.map((p, i) => ({ project, documentId: "style-e2e", pageId: p.pageId, pageText: texts[i], clean: true, readOnly: false }));
    instruction = "Use a calm blue classroom style";
    const sourcePptx = await readFile(revision(1));
    representative = await runtime.generatePagePptxCandidate({ sourcePptx, pageText: texts[1], instruction,
      baseline: runtime.coursewarePageBaseline(contexts[1]), target: { pageId: project.pages[1].pageId, slidePart: "ppt/slides/slide2.xml" },
      getCurrentBaseline: async () => runtime.coursewarePageBaseline(contexts[1]), generate });
    representative.reference = { candidateId: representative.candidateId, projectId: project.projectId, source: project.source,
      teachingRevision: project.teachingRevision, targetPageIds: [project.pages[1].pageId], outputSha256: hash(representative.pptx) };
    await writeFile(join(out, "representative.pptx"), representative.pptx);
    await writeFile(join(workspace, "representative.pptx"), representative.pptx);
    await parse(join(workspace, "representative.pptx"));
    await host.call("courseware.sourceCandidate.stage", { ...read("representative"), jobId: job.jobId, outputSha256: hash(representative.pptx),
      redoEvidence: { protocol: "deckwise-main-redo/1", sourceSha256: project.source.sha256, outputSha256: hash(representative.pptx),
        mappingRevision: context.mapping.revision, pageId: project.pages[1].pageId, slidePart: "ppt/slides/slide2.xml" } });
    await parse(revision(1));
    const pageIds = [project.pages[1].pageId, project.pages[0].pageId];
    const scope = { representativeCandidateId: "representative", representativeOutputSha256: hash(representative.pptx),
      instructionHash: runtime.candidateHash(instruction), pageIds };
    const batchRequest = { ...request("batch-1"), kind: "page-style-batch", styleBatch: scope };
    for (const invalid of [{ ...batchRequest, styleBatch: { ...scope, approved: true } },
      { ...batchRequest, styleBatch: { ...scope, pageIds: [project.pages[1].pageId, project.pages[2].pageId] } },
      { ...batchRequest, styleBatch: { ...scope, representativeOutputSha256: "f".repeat(64) } }]) {
      await assert.rejects(host.call("courseware.sourceCandidate.prepare", { ...saved(), request: invalid }));
    }
    await host.call("courseware.sourceCandidate.prepare", { ...saved(), request: batchRequest });
    batch = await runtime.generatePageStyleBatchCandidate({ sourcePptx, sourceMapping: context.mapping, representative, instruction,
      confirmation: { ...scope, representativeCandidateId: representative.candidateId },
      targets: [1, 0].map(i => ({ context: contexts[i], slidePart: `ppt/slides/slide${i + 1}.xml` })),
      getCurrentContexts: async () => {
        const fresh = await canonical();
        return [1, 0].map(i => ({ ...contexts[i], project: fresh }));
      }, generate });
    proof = { protocol: "deckwise-main-style-batch/1", sourceSha256: project.source.sha256, outputSha256: hash(batch.pptx),
      mappingRevision: context.mapping.revision, targets: [1, 0].map(i => ({ pageId: project.pages[i].pageId, slidePart: `ppt/slides/slide${i + 1}.xml` })) };
    assert.deepEqual(batch.scope.pageIds, pageIds); assert.equal(batch.applied, false);
    await writeFile(join(out, "source.pptx"), sourcePptx); await writeFile(join(out, "candidate.pptx"), batch.pptx);
    await writeFile(join(workspace, "candidate.pptx"), batch.pptx);
    await writeFile(join(out, "before.json"), JSON.stringify({ project, context, proof, batchRequest, batchReport: batch.report }, null, 2));
  });
  await step("Batch staging refuses forged scope and remains pending until explicit adoption", async () => {
    await parse(join(workspace, "candidate.pptx"));
    const params = { ...read("batch-1"), jobId: job.jobId, outputSha256: hash(batch.pptx) };
    await host.call("courseware.sourceCandidate.stage", params);
    await parse(revision(1));
    await assert.rejects(host.call("courseware.sourceAdoption.prepare", { ...saved(), candidateId: "batch-1" }), /verified/);
    await parse(join(workspace, "candidate.pptx")); params.jobId = job.jobId;
    for (const field of ["protocol", "sourceSha256", "outputSha256", "mappingRevision"]) {
      await assert.rejects(host.call("courseware.sourceCandidate.stage", { ...params, batchEvidence: { ...proof, [field]: "wrong" } }));
    }
    await assert.rejects(host.call("courseware.sourceCandidate.stage", { ...params, batchEvidence: { ...proof, extra: true } }), /unknown field/);
    await assert.rejects(host.call("courseware.sourceCandidate.stage", { ...params, batchEvidence: { ...proof, targets: [...proof.targets].reverse() } }));
    const staged = await host.call("courseware.sourceCandidate.stage", { ...params, batchEvidence: proof });
    assert.equal(staged.lineageVerified, true); assert.equal(staged.applied, false); assert.deepEqual(staged.targetPageIds, batch.scope.pageIds);
    assert.deepEqual(await host.call("courseware.sourceCandidate.stage", { ...params, batchEvidence: proof }), staged);
    assert.deepEqual(await canonical(), project);
    const preview = await host.call("courseware.sourceCandidate.preview", read("batch-1"));
    assert.equal(hash(await readFile(preview.path)), hash(batch.pptx));
  });
  await step("Pending batch adoption survives Host restart and cancels on original bytes", async () => {
    await parse(revision(1)); intent = await host.call("courseware.sourceAdoption.prepare", { ...saved(), candidateId: "batch-1" });
    await host.restart(); job = undefined;
    const recovered = await host.call("courseware.sourceAdoption.get", { sessionId, projectId: project.projectId });
    assert.deepEqual(recovered.adoption, intent.adoption); assert.equal(recovered.archiveError, null);
    await assert.rejects(host.call("courseware.sourceCandidate.reject", read("representative")), /adoption pending/);
    await parse(revision(1));
    assert.equal((await host.call("courseware.sourceAdoption.cancel", { ...saved(), adoptionId: intent.adoption.adoptionId })).status, "cancelled");
    assert.deepEqual(await canonical(), project);
  });
  await step("Freshly parsed batch commits teaching and all target identities atomically", async () => {
    intent = await host.call("courseware.sourceAdoption.prepare", { ...saved(), candidateId: "batch-1" });
    await mkdir(join(revision(2), ".."), { recursive: true }); await copyFile(intent.path, revision(2));
    await host.restart(); job = undefined; await parse(revision(2));
    const committed = await host.call("courseware.sourceAdoption.commit", { ...saved(), adoptionId: intent.adoption.adoptionId });
    assert.equal(committed.status, "committed"); assert.equal(committed.project.source.sha256, hash(batch.pptx));
    for (let i = 0; i < 3; i++) {
      const old = project.pages[i], next = committed.project.pages[i];
      assert.equal(next.pageId, old.pageId); assert.deepEqual(next.actions, old.actions); assert.equal(next.locked, old.locked);
      assert.equal(next.reviewState, i < 2 ? "review" : old.reviewState);
    }
    assert.deepEqual(await host.call("courseware.sourceAdoption.commit", { ...saved(), adoptionId: intent.adoption.adoptionId }), committed);
    await writeFile(join(out, "committed.json"), JSON.stringify(committed, null, 2)); project = committed.project;
  });
  await step("Restart retains the peer mapping and assigns fresh IDs only to rebuilt objects", async () => {
    await host.restart(); job = undefined; assert.deepEqual(await canonical(), project);
    assert.equal((await host.call("courseware.sourceCandidate.get", read("batch-1"))).status, "adopted");
    await parse(revision(2)); await host.call("courseware.sourceCandidate.prepare", { ...saved(), request: request("inspect") });
    const next = await host.call("courseware.sourceCandidate.context", read("inspect"));
    assert.deepEqual(next.mapping.pages[2], context.mapping.pages[2]);
    const old = new Set(context.mapping.pages.flatMap(p => p.objects.map(o => o.objectId)));
    for (const i of [0, 1]) {
      assert.equal(next.mapping.pages[i].pageId, context.mapping.pages[i].pageId);
      assert(next.mapping.pages[i].objects.length > 0);
      for (const object of next.mapping.pages[i].objects) assert(!old.has(object.objectId));
    }
    await writeFile(join(out, "after-context.json"), JSON.stringify(next, null, 2));
    assert.equal(hash(await readFile(revision(1))), context.mapping.sourceSha256);
    await host.call("courseware.sourceCandidate.reject", read("inspect"));
  });
  report.status = "PASS_HOST_STYLE_BATCH";
} catch (error) { report.error = String(error.stack || error); throw error; }
finally {
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(join(out, "host-stderr.log"), host.stderr);
  await host.stop(); await rm(temp, { recursive: true, force: true });
}
