import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import * as runtime from "../../../packages/agent-runtime/dist/index.js";

const require = createRequire(import.meta.url);
const JSZip = createRequire(new URL("../../../packages/agent-runtime/package.json", import.meta.url))("jszip");
const source = await readFile(new URL("../electron/main/courseware-source-candidate.ts", import.meta.url), "utf8");
const readerModule = { exports: {} };
const readerSource = await readFile(new URL("../electron/main/courseware-candidate-source.ts", import.meta.url), "utf8");
new Function("require", "exports", ts.transpileModule(readerSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText)(
  id => id === "@pi-desktop/agent-runtime" ? runtime : require(id), readerModule.exports);
function load(generate = runtime.generatePageFadeCandidate) {
  const module = { exports: {} };
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  new Function("require", "exports", outputText)(id => id === "@pi-desktop/agent-runtime"
    ? { ...runtime, generatePageFadeCandidate: generate } : id === "./courseware-candidate-source" ? readerModule.exports : require(id), module.exports);
  return module.exports.stagePageFadeCandidate;
}

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), "deckwise-fade-evidence-"));
  try {
    const zip = new JSZip();
    const p = "http://schemas.openxmlformats.org/presentationml/2006/main";
    const r = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    zip.file("ppt/presentation.xml", `<p:presentation xmlns:p="${p}" xmlns:r="${r}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`);
    zip.file("ppt/_rels/presentation.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${r}/slide" Target="slides/slide7.xml"/></Relationships>`);
    zip.file("ppt/slides/slide7.xml", `<p:sld xmlns:p="${p}"><p:cSld><p:spTree/></p:cSld></p:sld>`);
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    const sourcePath = join(directory, "source.pptx"); await writeFile(sourcePath, bytes);
    const sourceHash = runtime.candidateHash(bytes);
    const baseline = { coursewareProjectId: "course", pageId: "page", sourceRevision: "R1", sourceSha256: sourceHash.slice(7), teachingRevision: "T1" };
    const generationBaseline = { projectId: "native", documentId: "document", pageId: "page", sourceRevision: "R1", sourceHash,
      teachingRevision: "T1", contentHash: runtime.candidateHash(""), clean: true, readOnly: false, manualLocked: false };
    const calls = []; let parsed; let verified = true;
    const host = { async call(method, params) {
      calls.push([method, params]);
      if (method === "courseware.sourceCandidate.prepare") return {};
      if (method === "courseware.sourceCandidate.context") return { mapping: { revision: "map-1", sourceSha256: baseline.sourceSha256,
        pages: [{ pageId: "page", importPageId: "page_1", objects: [] }] } };
      if (method === "courseware.sourceCandidate.stage") {
        assert.equal(params.outputSha256, runtime.candidateHash(parsed).slice(7));
        return { status: "needs-review", candidateId: params.candidateId, outputSha256: params.outputSha256,
          stale: false, applied: false, lineageVerified: verified };
      }
      throw new Error(method);
    } };
    const input = { host, sourcePath, baseline, generationBaseline, sessionId: "chat", jobId: "source-job", pageText: "",
      signal: new AbortController().signal, current: async () => generationBaseline,
      parseOutput: async (path, hash) => { parsed = await readFile(path); assert.equal(runtime.candidateHash(parsed), `sha256:${hash}`); return "output-job"; } };
    await run({ input, calls, directory, bytes, unverified: () => { verified = false; } });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("Main attests the retained exact output and resolved slide part, then cleans temporary files", () => fixture(async f => {
  const receipt = await load()(f.input);
  const stage = f.calls.find(([method]) => method.endsWith(".stage"))[1];
  assert.deepEqual(stage.fadeEvidence, { protocol: "deckwise-main-fade/1", sourceSha256: f.input.baseline.sourceSha256,
    outputSha256: receipt.outputSha256, mappingRevision: "map-1", pageId: "page", slidePart: "ppt/slides/slide7.xml" });
  assert.deepEqual(await readFile(f.input.sourcePath), f.bytes);
  assert.deepEqual(await readdir(f.directory), ["source.pptx"]);
  assert.equal(receipt.applied, false);
}));

test("Main refuses unverified Host receipts and still cleans the output copy", () => fixture(async f => {
  f.unverified();
  await assert.rejects(load()(f.input), /Invalid staged source candidate/);
  assert.deepEqual(await readdir(f.directory), ["source.pptx"]);
  assert.deepEqual(await readFile(f.input.sourcePath), f.bytes);
}));

test("Main never attests a mismatched retained result", async () => {
  for (const change of ["hash", "kind", "scope", "changedParts", "addedParts"]) {
    await fixture(async f => {
      const stage = load(async input => {
        const result = await runtime.generatePageFadeCandidate(input);
        if (change === "hash") result.hash = runtime.candidateHash("different");
        if (change === "kind") result.kind = "page-pptx";
        if (change === "scope") result.scope.pageIds = ["other"];
        if (change === "changedParts") result.report.changedParts.push("ppt/presentation.xml");
        if (change === "addedParts") result.report.addedParts.push("added.xml");
        return result;
      });
      await assert.rejects(stage(f.input), /Invalid retained fade result/);
      assert(!f.calls.some(([method]) => method.endsWith(".stage")), change);
      assert.deepEqual(await readdir(f.directory), ["source.pptx"]);
    });
  }
});

test("shared candidate reader refuses stale bytes, symlinks, oversized files and cancellation", () => fixture(async f => {
  const { readCandidateSource } = readerModule.exports;
  const signal = new AbortController().signal;
  assert.deepEqual(await readCandidateSource(f.input.sourcePath, f.input.baseline.sourceSha256, signal), f.bytes);
  await assert.rejects(readCandidateSource(f.input.sourcePath, "a".repeat(64), signal), /changed/);
  const alias = join(f.directory, "alias.pptx"); await symlink(f.input.sourcePath, alias);
  await assert.rejects(readCandidateSource(alias, f.input.baseline.sourceSha256, signal));
  const oversized = join(f.directory, "oversized.pptx"); await writeFile(oversized, ""); await truncate(oversized, 50 * 1024 * 1024 + 1);
  await assert.rejects(readCandidateSource(oversized, f.input.baseline.sourceSha256, signal), /limits/);
  const cancelled = new AbortController(); cancelled.abort(new Error("cancelled reader"));
  await assert.rejects(readCandidateSource(f.input.sourcePath, f.input.baseline.sourceSha256, cancelled.signal), /cancelled reader/);
}));
