/** Public Main entry with real Host, frozen worker/compiler and Electron PNG codec. */
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import * as runtime from "../../../packages/agent-runtime/dist/index.js";
import * as shared from "../../../packages/shared/dist/index.js";
import { Host, resolveHostBinary } from "../../../scripts/e2e/host.mjs";

const { nativeImage } = (await import("electron")).default;
assert(nativeImage, "Run inside the isolated Electron test bootstrap");
assert(process.env.DECKWISE_E2E_PPTX && process.env.DECKWISE_PPTX_WORKER && process.env.DECKWISE_PPTX_NODE);
const require = createRequire(import.meta.url);
const authoringUrl = pathToFileURL(join(dirname(process.env.DECKWISE_PPTX_WORKER), "authoring.mjs")).href;
const modules = new Map([["@pi-desktop/agent-runtime", runtime], ["@pi-desktop/shared", shared],
  ["electron", { nativeImage }], [authoringUrl, await import(authoringUrl)]]);
// Load the current Main sources; only editor/render/model are external fixture edges.
function load(id) {
  if (modules.has(id)) return modules.get(id);
  if (!id.startsWith("./")) return require(id);
  const exports = {};
  modules.set(id, exports);
  const source = readFileSync(new URL(`../electron/main/${id.slice(2)}.ts`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  new Function("require", "exports", outputText)(load, exports);
  return exports;
}
const { CoursewareTeachingCoordinator } = load("./courseware-teaching");
const { CoursewareVisualReview } = load("./courseware-visual-review");
const { CoursewareCandidateCoordinator } = load("./courseware-candidates");
const { CoursewareSourceAdoption } = load("./courseware-source-adoption");
const { jobIdFor, publishRevision } = load("./ppt-editor-files");
const { adoptionRevision } = load("./courseware-source-files");
const JSZip = createRequire(new URL("../../../packages/agent-runtime/package.json", import.meta.url))("jszip");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

async function candidateAttentionScenario(t) {
  const directory = await mkdtemp(join(tmpdir(), "deckwise-main-redo-"));
  const workspace = join(directory, "workspace"), data = join(directory, "data");
  await mkdir(workspace, { recursive: true });
  await mkdir(join(data, "plugins/market"), { recursive: true });
  await writeFile(join(data, "plugins/market/catalog.json"), JSON.stringify({ schemaVersion: 2, providerId: "official", plugins: [] }));
  const source = await readFile(process.env.DECKWISE_E2E_PPTX);
  const livePath = join(workspace, "lesson.pptx");
  await writeFile(livePath, source);
  const firstRevision = await publishRevision({ root: join(workspace, ".deckwise-ppt/revisions"), jobId: jobIdFor(workspace, livePath),
    bytes: source, extension: "pptx", cause: "generated", expectedRevision: 0 });
  const sourcePath = firstRevision.documentPath;
  const host = new Host(resolveHostBinary(), data);
  t.after(async () => { await host.stop(); await rm(directory, { recursive: true, force: true }); });
  let modelCalls = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    modelCalls++;
    assert.equal(input.images.length, 2);
    assert.equal(input.data.instruction, "Redo this page; preserve narration and current facts.");
    const scene = { version: 1, slideId: input.data.slideId, sourceHash: input.data.sourceHash,
      canvas: input.data.canvas, visualMasterAssetId: input.data.visualMasterAssetId,
      cleanPlateAssetId: input.data.cleanPlateAssetId, elements: [{ id: "redo-title", type: "native_text",
        bboxPx: [20, 20, input.data.canvas.width - 40, 160], zIndex: 1, content: input.data.pageText,
        style: { fontFace: "Arial", fontSizePt: 26, color: "#173B65", align: "left" } }] };
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ text: JSON.stringify(scene) }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  await host.start();
  const { provider } = await host.call("providers.create", { name: "Local Main redo fixture", vendorKey: "custom",
    type: "openai_compatible", protocol: "openai_compatible", baseUrl: endpoint, authKind: "none", defaultModelId: "redo-fixture", apiStyle: "chat_completions" });
  const { session } = await host.call("session.create", { projectPath: workspace, providerId: provider.id, modelId: "redo-fixture", mode: "agent" });
  const binding = { projectId: "native-project", documentId: "native-document", sessionId: "native-editor" };
  const snapshot = { ...binding, path: sourcePath, revision: 1, sha256: hash(source) };
  const context = { ...binding, editGeneration: 1, page: 2, readOnly: false };
  let dirty = false, frozen = false;
  const editor = { async getContext() { return { ...context }; },
    teachingSnapshot() { if (dirty) throw new Error("Save or reopen the PPTX"); return { ...snapshot }; },
    async verifyTeachingSource() { assert.equal(hash(await readFile(snapshot.path)), snapshot.sha256); },
    sourceAdoptionSnapshot() { return { ...snapshot, sourcePath: livePath }; },
    freezeForSourceAdoption() { assert(!dirty); frozen = true; } };
  const assertOwner = id => assert.equal(id, session.id);
  const teaching = new CoursewareTeachingCoordinator(editor, () => host, async () => workspace, () => session.id, assertOwner);
  let project = (await teaching.open(session.id)).project;
  assert.equal(project.pages.length, 3, "Use the retained three-page source fixture");
  for (const [index, page] of project.pages.entries()) {
    project = (await host.call("courseware.teaching.write", { sessionId: session.id, write: {
      projectId: project.projectId, pageId: page.pageId, expectedSourceRevision: project.source.revision,
      expectedTeachingRevision: project.teachingRevision,
      actions: [{ id: `speech-${index}`, type: "speech", text: `Keep narration ${index}`, pauseAfterMs: 4000 }],
    } })).project;
  }
  context.page = 1;
  const peer = await teaching.open(session.id);
  const target = peer.teachingObjects.find(object => object.status === "mapped" && object.effectTargetEligible);
  assert(target, "Use a real parser-mapped eligible object on the unchanged peer page");
  const actions = structuredClone(project.pages[0].actions);
  actions[0].visualCues = [
    { id: "peer-highlight", atMs: 0, endMs: 800, effect: { type: "highlight", elementIds: [target.objectId] } },
    { id: "peer-spotlight", atMs: 800, endMs: 1900, effect: { type: "spotlight", elementId: target.objectId } },
  ];
  project = (await host.call("courseware.teaching.write", { sessionId: session.id, write: {
    projectId: project.projectId, pageId: project.pages[0].pageId, expectedSourceRevision: project.source.revision,
    expectedTeachingRevision: project.teachingRevision, actions,
  } })).project;
  context.page = 2;
  project = (await host.call("courseware.teaching.setLock", { sessionId: session.id, projectId: project.projectId,
    pageId: project.pages[0].pageId, expectedSourceRevision: project.source.revision,
    expectedTeachingRevision: project.teachingRevision, locked: true })).project;
  const canonical = structuredClone(project);
  const png = color => nativeImage.createFromBitmap(Buffer.from(Array(16).fill(color).flat()), { width: 4, height: 4 }).toPNG();
  const image = (id, bytes) => ({ assetIds: [id], bytes, sha256: hash(bytes), width: 4, height: 4 });
  const visuals = new CoursewareVisualReview(teaching, editor, async () => workspace, assertOwner, async input => {
    await input.assertCurrent();
    const rendered = (id, bytes, nativeTextOmitted) => ({ page: 2, pageToken: "native-page-2", sourceSha256: snapshot.sha256,
      nativeTextOmitted, image: image(id, bytes) });
    return { pageCount: 3, normal: rendered("master", png([20, 60, 110, 255]), false),
      textless: rendered("clean", png([255, 255, 255, 255]), true) };
  });
  let active = true;
  const candidates = new CoursewareCandidateCoordinator(teaching, () => assert.fail("Text-only completion is not redo"), {
    visuals, async completeScene(input) {
      assert.equal(input.modelKey, `${provider.id}/redo-fixture`);
      const response = await fetch(endpoint, { method: "POST", signal: input.signal, headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: JSON.parse(input.data), images: input.images.map(value => ({ sha256: value.sha256, bytes: [...value.bytes] })) }) });
      const output = await response.json();
      return output;
    },
  });
  const current = () => candidates.execute(session.id, "ppt_get_narration_context", {}, () => active);
  const propose = baseline => candidates.execute(session.id, "ppt_propose_page_redo", { kind: "page-pptx", baseline,
    instruction: "Redo this page; preserve narration and current facts." }, () => active);
  assert(!(await current()).capabilities.includes("page-pptx"));
  const review = await visuals.prepare({ sessionId: session.id });
  await visuals.approve({ reviewId: review.reviewId });
  const approved = await current(); assert(approved.capabilities.includes("page-pptx"));
  const receipt = await propose(approved.baseline);
  assert.equal(modelCalls, 1); assert.equal(receipt.applied, false); assert.equal(receipt.reviewState, "needs-review");
  const reviewed = await teaching.reviewPptxCandidate({ sessionId: session.id, candidateId: receipt.candidateId });
  assert.equal(reviewed.lineageVerified, true); assert.equal(reviewed.stale, false);
  assert.deepEqual(reviewed.targetPageIds, [project.pages[1].pageId]);
  const preview = await teaching.previewPptxCandidate(reviewed.reviewId);
  const copy = await readFile(preview.path);
  assert.equal(hash(copy), receipt.outputSha256);
  assert.notEqual(hash(copy), snapshot.sha256);
  const beforeZip = await JSZip.loadAsync(source), afterZip = await JSZip.loadAsync(copy);
  for (const part of ["ppt/slides/slide1.xml", "ppt/slides/slide3.xml", "ppt/notesSlides/notesSlide2.xml"]) {
    assert.deepEqual(await afterZip.file(part).async("nodebuffer"), await beforeZip.file(part).async("nodebuffer"), part);
  }
  assert((await afterZip.file("ppt/slides/slide2.xml").async("string")).includes("redo-title"));
  assert.deepEqual(await readFile(sourcePath), source);
  assert.deepEqual((await host.call("courseware.project.get", { sessionId: session.id, projectId: project.projectId })).project, canonical);
  assert(!(await readdir(dirname(sourcePath))).some(name => name.startsWith(".candidate-")));
  dirty = true; await assert.rejects(current(), /Save or reopen/); dirty = false;
  active = false; await assert.rejects(propose(approved.baseline), /cancelled/); active = true;
  await teaching.rejectPptxCandidate(reviewed.reviewId);
  assert.equal((await host.call("courseware.sourceCandidate.get", { sessionId: session.id, projectId: project.projectId, candidateId: receipt.candidateId })).status, "rejected");
  assert.deepEqual(await readFile(sourcePath), source);
  assert.deepEqual((await host.call("courseware.project.get", { sessionId: session.id, projectId: project.projectId })).project, canonical);
  await host.restart();
  assert.equal((await host.call("courseware.sourceCandidate.get", { sessionId: session.id, projectId: project.projectId, candidateId: receipt.candidateId })).status, "rejected");
  assert.deepEqual((await host.call("courseware.project.get", { sessionId: session.id, projectId: project.projectId })).project, canonical);
  project = (await host.call("courseware.teaching.setLock", { sessionId: session.id, projectId: project.projectId,
    pageId: project.pages[0].pageId, expectedSourceRevision: project.source.revision,
    expectedTeachingRevision: project.teachingRevision, locked: false })).project;
  context.page = 1;
  const fadeCanonical = structuredClone(project);
  const fade = await candidates.execute(session.id, "ppt_propose_page_fade", { kind: "page-fade", baseline: (await current()).baseline }, () => active);
  assert.equal(fade.kind, "page-fade"); assert.equal(fade.applied, false); assert.equal(modelCalls, 1);
  const fadeReview = await teaching.reviewPptxCandidate({ sessionId: session.id, candidateId: fade.candidateId });
  assert.equal(fadeReview.lineageVerified, true); assert.equal(fadeReview.stale, false);
  await teaching.previewPptxCandidate(fadeReview.reviewId);
  await teaching.rejectPptxCandidate(fadeReview.reviewId);
  assert.deepEqual(await readFile(sourcePath), source);
  assert.deepEqual((await host.call("courseware.project.get", { sessionId: session.id, projectId: project.projectId })).project, fadeCanonical);

  context.page = 2;
  const targetPage = await teaching.open(session.id);
  const oldTarget = targetPage.teachingObjects.find(object => object.status === "mapped" && object.effectTargetEligible);
  assert(oldTarget);
  const targetActions = structuredClone(project.pages[1].actions);
  targetActions[0].visualCues = [
    { id: "redo-highlight", atMs: 0, endMs: 800, effect: { type: "highlight", elementIds: [oldTarget.objectId] } },
    { id: "redo-spotlight", atMs: 800, endMs: 1900, effect: { type: "spotlight", elementId: oldTarget.objectId } },
  ];
  project = (await host.call("courseware.teaching.write", { sessionId: session.id, write: {
    projectId: project.projectId, pageId: project.pages[1].pageId, expectedSourceRevision: project.source.revision,
    expectedTeachingRevision: project.teachingRevision, actions: targetActions,
  } })).project;
  const targetVisual = await visuals.prepare({ sessionId: session.id }); await visuals.approve({ reviewId: targetVisual.reviewId });
  const redo = await propose((await current()).baseline);
  const redoReview = await teaching.reviewPptxCandidate({ sessionId: session.id, candidateId: redo.candidateId });
  assert.equal(redoReview.effectTargets.length, 1);
  assert.equal(redoReview.effectTargets[0].objectId, oldTarget.objectId);
  assert.equal(redoReview.effectTargets[0].pageIndex, 1);
  assert.equal(redoReview.effectCues.length, 2);
  await assert.rejects(teaching.preparePptxAdoption(redoReview.reviewId, livePath), /effect.*association/);
  assert.deepEqual(await readFile(livePath), source);
  const replacement = redoReview.effectPages[1].objects.find(object => ["text", "shape", "image"].includes(object.kind));
  assert(replacement);
  const choices = [{ pageIndex: 1, objectId: oldTarget.objectId, targetIndex: replacement.index }];
  const adoption = new CoursewareSourceAdoption(editor, teaching, () => host, async () => workspace, () => session.id, () => {});
  await adoption.adopt(redoReview.reviewId, async () => {
    assert(frozen);
    const revision = await adoptionRevision(workspace, livePath, await readFile(livePath));
    Object.assign(snapshot, { path: revision.documentPath, revision: revision.revision, sha256: revision.sha256 });
    context.editGeneration++; frozen = false;
  }, choices);
  assert.equal(snapshot.sha256, redo.outputSha256);
  assert.equal(hash(await readFile(livePath)), redo.outputSha256);
  assert.deepEqual(await readFile(sourcePath), source, "Immutable original revision is retained");
  const after = (await host.call("courseware.project.get", { sessionId: session.id, projectId: project.projectId })).project;
  const mapped = (await host.call("courseware.project.context", { sessionId: session.id, projectId: project.projectId })).mapping;
  const newTarget = mapped.pages[1].objects[replacement.index - 1].objectId;
  assert.equal(typeof newTarget, "string");
  assert.notEqual(newTarget, oldTarget.objectId);
  const expectedActions = structuredClone(targetActions);
  expectedActions[0].visualCues[0].effect.elementIds = [newTarget]; expectedActions[0].visualCues[1].effect.elementId = newTarget;
  assert.deepEqual(after.pages[1].actions, expectedActions);
  assert.deepEqual(after.pages[0].actions, project.pages[0].actions);
  assert.equal(after.pages[1].reviewState, "review");
  await host.restart();
  assert.deepEqual((await teaching.open(session.id)).project, after);
  assert.equal(modelCalls, 2);
  if (process.env.DECKWISE_E2E_OUTPUT) {
    const output = process.env.DECKWISE_E2E_OUTPUT;
    await mkdir(output, { recursive: true });
    await writeFile(join(output, "before.pptx"), source);
    await writeFile(join(output, "adopted.pptx"), await readFile(livePath));
    await writeFile(join(output, "adoption.json"), JSON.stringify({ before: project, after, mapping: mapped, choices,
      outputSha256: redo.outputSha256, modelCalls, paidCalls: false, nativeEditor: "fixture" }, null, 2));
  }
}

test("public Main redo and fade preserve attention; explicit target associations survive source adoption and Host restart", { timeout: 90_000 }, async t => {
  try { await candidateAttentionScenario(t); }
  catch (error) { console.error(error); process.exitCode = 1; throw error; }
});
