import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import ts from "typescript";

const nativeRequire = createRequire(import.meta.url);
const office = { validateOfficeBytes: (bytes) => {
  const value = Buffer.from(bytes);
  if (!value.subarray(0, 2).equals(Buffer.from("PK"))) throw new Error("Invalid PPTX");
  return value;
} };
const revisions = {};
const revisionSource = await readFile(new URL("../electron/main/ppt-editor-files.ts", import.meta.url), "utf8");
new Function("require", "exports", ts.transpileModule(revisionSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)((id) => id === "./office-file" ? office : nativeRequire(id), revisions);

const source = await readFile(new URL("../electron/main/courseware-scene-staging.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
const exports = {};
new Function("require", "exports", outputText)((id) => {
  if (id === "node:crypto") return { createHash };
  if (id === "node:fs") return { constants, promises: fs };
  if (id === "node:path") return { dirname, join };
  if (id === "node:timers/promises") return { setTimeout };
  if (id === "./fs-panel") return {
    resolveRealPathForCreateWithinRoot: async (root, relative) => resolve(root, relative),
    resolveRealOpenablePath: async (path) => path,
  };
  if (id === "./office-file") return office;
  if (id === "./ppt-editor-files") return revisions;
  throw new Error(`Unexpected dependency: ${id}`);
}, exports);
const { stageGeneratedSceneCourse } = exports;
const pptx = Buffer.from("PK generated ppt/presentation.xml [Content_Types].xml");
const sha256 = createHash("sha256").update(pptx).digest("hex");

test("generated source survives parsing and initializes narration before attaching the task", async () => {
  const workspace = await mkdtemp(join(tmpdir(), `deckwise-scene-stage-${randomUUID()}-`));
  const path = join(workspace, ".deckwise-ppt", "generated", `${sha256}.pptx`);
  const documentId = revisions.jobIdFor(workspace, path);
  const revisionRoot = join(workspace, ".deckwise-ppt", "revisions");
  const calls = [];
  const host = { async call(method, params) {
    calls.push(method);
    if (method === "courseware.parseStart") {
      assert.equal(params.path, join(revisionRoot, documentId, "r0001", "document.pptx"));
      assert.equal(createHash("sha256").update(await fs.readFile(params.path)).digest("hex"), sha256);
      return { jobId: "job" };
    }
    if (method === "courseware.parseStatus") return { status: "SUCCEEDED", summary: { sourceSha256: sha256 } };
    if (method === "courseware.project.initializeGenerated") {
      assert.equal(params.sourceSha256, sha256);
      assert.deepEqual(params.narrations, ["第一句讲解"]);
      return { project: { projectId: `office-${documentId}`, source: { sha256 }, pages: [{}] } };
    }
    if (method === "courseware.task.attachGenerated") return { task: { generatedPath: params.path } };
    if (method === "courseware.parseRelease") return {};
    throw new Error(method);
  } };
  const input = { workspace, sessionId: "session", title: "问候课", pptx, teaching: [{ pageId: "scene-001", narration: "第一句讲解" }], host };
  try {
    const result = await stageGeneratedSceneCourse(input);
    assert.equal(result.path, join(workspace, ".deckwise-ppt", "generated", `${sha256}.pptx`));
    assert.deepEqual(calls, ["courseware.parseStart", "courseware.parseStatus", "courseware.project.initializeGenerated", "courseware.task.attachGenerated", "courseware.parseRelease"]);
    assert.deepEqual(await fs.readFile(result.path), pptx);
    await stageGeneratedSceneCourse(input);
    assert.deepEqual(await fs.readFile(result.path), pptx);
    const saved = await revisions.listRevisions(revisionRoot, documentId);
    assert.equal(saved.length, 1, "A retry reuses the same saved editor revision");
    assert.equal(saved[0].cause, "generated");
    assert.equal(result.project.projectId, `office-${documentId}`);
  } finally { await fs.rm(workspace, { recursive: true, force: true }); }
});

test("a parse failure keeps the content-addressed PPTX for recovery and releases the job", async () => {
  const workspace = await mkdtemp(join(tmpdir(), `deckwise-scene-failed-${randomUUID()}-`));
  const calls = [];
  const host = { async call(method) {
    calls.push(method);
    if (method === "courseware.parseStart") return { jobId: "job" };
    if (method === "courseware.parseStatus") return { status: "FAILED", message: "Parser rejected source" };
    if (method === "courseware.parseRelease") return {};
    throw new Error(method);
  } };
  try {
    await assert.rejects(stageGeneratedSceneCourse({ workspace, sessionId: "session", title: "问候课", pptx,
      teaching: [{ pageId: "scene-001", narration: "第一句讲解" }], host }), /Parser rejected source/);
    assert.deepEqual(calls, ["courseware.parseStart", "courseware.parseStatus", "courseware.parseRelease"]);
    assert.deepEqual(await fs.readFile(join(workspace, ".deckwise-ppt", "generated", `${sha256}.pptx`)), pptx);
  } finally { await fs.rm(workspace, { recursive: true, force: true }); }
});

test("staging refuses to replace a different saved editor revision", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deckwise-scene-revision-"));
  const calls = [];
  const host = { async call(method) {
    calls.push(method);
    if (method === "courseware.parseStart") return { jobId: "job" };
    if (method === "courseware.parseStatus") return { status: "FAILED", message: "Parser rejected source" };
    if (method === "courseware.parseRelease") return {};
    throw new Error(method);
  } };
  const input = { workspace, sessionId: "session", title: "Shapes", pptx, teaching: [{ pageId: "scene-001", narration: "Good!" }], host };
  try {
    await assert.rejects(stageGeneratedSceneCourse(input), /Parser rejected source/);
    const path = join(workspace, ".deckwise-ppt", "generated", `${sha256}.pptx`);
    const root = join(workspace, ".deckwise-ppt", "revisions");
    const jobId = revisions.jobIdFor(workspace, path);
    const edited = Buffer.from("PK edited document");
    const saved = await revisions.publishRevision({ root, jobId, bytes: edited, extension: "pptx", cause: "edited", expectedRevision: 1 });
    calls.length = 0;
    await assert.rejects(stageGeneratedSceneCourse(input), /different saved revision/);
    assert.deepEqual(calls, []);
    assert.deepEqual(await fs.readFile(saved.documentPath), edited);
    assert.equal((await revisions.listRevisions(root, jobId)).length, 2);
    assert.deepEqual(await fs.readFile(path), pptx);
  } finally { await fs.rm(workspace, { recursive: true, force: true }); }
});

test("reviewed scene proof reaches both Host writes and a changed selection stops each write boundary", async t => {
  for (const failAt of [0, 1, 2]) await t.test(`scope check ${failAt}`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "deckwise-scene-proof-"));
    let checks = 0; const calls = [];
    const sceneProof = { planSha256: "a".repeat(64), principalKey: "b".repeat(64), selectedIntentIds: ["intent-a"] };
    const host = { async call(method, params) {
      calls.push(method);
      if (method === "courseware.parseStart") return { jobId: "job" };
      if (method === "courseware.parseStatus") return { status: "SUCCEEDED", summary: { sourceSha256: sha256 } };
      if (method === "courseware.project.initializeGenerated") {
        assert.deepEqual(params.sceneProof, sceneProof);
        assert.deepEqual(params.sceneMapping, { pages: [] });
        return { project: { projectId: "office-lesson", source: { sha256 }, pages: [{}] } };
      }
      if (method === "courseware.task.attachGenerated") { assert.deepEqual(params.sceneProof, sceneProof); return {}; }
      if (method === "courseware.parseRelease") return {};
      throw new Error(method);
    } };
    const request = { workspace, sessionId: "session", title: "Shapes", pptx, teaching: [{ pageId: "scene-001", narration: "Good!" }], host,
      sceneProof, sceneMapping: { pages: [] }, async assertCurrent() { if (++checks === failAt) throw new Error("SCENE_INPUT_CHANGED"); } };
    try {
      if (failAt) await assert.rejects(stageGeneratedSceneCourse(request), /SCENE_INPUT_CHANGED/);
      else await stageGeneratedSceneCourse(request);
      assert.equal(calls.includes("courseware.project.initializeGenerated"), failAt !== 1);
      assert.equal(calls.includes("courseware.task.attachGenerated"), failAt === 0);
      assert.equal(calls.at(-1), "courseware.parseRelease");
    } finally { await fs.rm(workspace, { recursive: true, force: true }); }
  });
});

test("canonical-only Quiz staging creates no fake PPT and archives resource pixels once", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "maic-quiz-stage-"));
  const image = Buffer.from("verified image pixels");
  const src = `data:image/png;base64,${image.toString("base64")}`;
  const document = { stage: { name: "draft" }, scenes: [{ type: "quiz", content: { type: "quiz", questions: [{ id: "q", image: { src } }] } }], mediaManifest: [{ src, originalSrc: src, mimeType: "image/png" }] };
  const calls = [];
  try {
    const result = await stageGeneratedSceneCourse({ workspace, sessionId: "s", title: "Final lesson", pptx: new Uint8Array(), teaching: [], canonicalClassroom: document,
      host: { async call(method, params) {
        calls.push(method);
        assert.equal(method, "courseware.classroom.create");
        assert.equal(params.classroom.stage.name, "Final lesson");
        const asset = params.classroom.mediaManifest[0];
        assert.match(asset.src, /^\.deckwise-ppt\/classroom-assets\/[a-f0-9]{64}\.png$/);
        assert.equal(asset.src, asset.originalSrc);
        assert.equal(params.classroom.scenes[0].content.questions[0].image.src, asset.src);
        assert.deepEqual(await fs.readFile(join(workspace, asset.src)), image);
        return { projectId: "canonical-only", sourceRevision: "sha256", revision: "1" };
      } } });
    assert.equal(result.path, "");
    assert.equal(result.project.projectId, "canonical-only");
    assert.deepEqual(calls, ["courseware.classroom.create"]);
    assert.equal(document.mediaManifest[0].src, src, "Staging doesn't mutate the caller's document");
    assert(!await fs.stat(join(workspace, ".deckwise-ppt", "generated")).catch(() => false));
  } finally { await fs.rm(workspace, { recursive: true, force: true }); }
});
