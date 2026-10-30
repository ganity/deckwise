import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import ts from "typescript";
import * as shared from "../../../packages/shared/dist/index.js";
const require = createRequire(import.meta.url), cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file);
  const module = { exports: {} }; cache.set(file, module.exports);
  const output = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  new Function("require", "exports", output)(id => id === "@pi-desktop/shared" ? shared : id.startsWith(".") ? load(join(dirname(file), id + ".ts")) : require(id), module.exports);
  return module.exports;
}
const main = new URL("../electron/main/", import.meta.url).pathname;
const { CoursewareNativeSave } = load(join(main, "courseware-native-save.ts"));
const { jobIdFor } = load(join(main, "ppt-editor-files.ts"));
function setup() {
  const workspace = "/tmp/native-save", sourcePath = workspace + "/lesson.pptx", calls = [];
  const input = { workspace, sourcePath, sourceRevisionPath: "old.pptx", sourceSha256: "a".repeat(64), outputPath: "new.pptx", outputSha256: "b".repeat(64),
    saveRequestId: "save-1", binding: { projectId: createHash("sha256").update(workspace).digest("hex"), documentId: jobIdFor(workspace, sourcePath), sessionId: "editor-session" } };
  input.lineage = { ...input.binding, protocol: "deckwise-office-page-lineage/1", saveRequestId: input.saveRequestId,
    sourceSha256: input.sourceSha256, outputSha256: input.outputSha256 };
  let path, status = "committed";
  const receipt = { saveId: "receipt", sourcePath, sourceSha256: input.sourceSha256, outputSha256: input.outputSha256, status: "pending" };
  const host = { async call(method, params) {
    calls.push({ method, params });
    if (method === "courseware.parseStart") { path = params.path; return { jobId: path }; }
    if (method === "courseware.parseStatus") return { status: "SUCCEEDED", summary: { sourceSha256: path === "old.pptx" ? input.sourceSha256 : input.outputSha256 } };
    if (method === "courseware.nativeSave.prepare") return receipt;
    if (method === "courseware.nativeSave.resolve") return { ...receipt, status };
    if (method === "courseware.nativeSave.forPath") return { save: receipt };
    return {};
  } };
  const service = new CoursewareNativeSave(() => host, () => "chat-session", async () => workspace, () => {}, async operation => operation());
  return { input, service, calls, setStatus: value => { status = value; }, host };
}

test("native save parses and releases the old source before the new source, then resolves the durable receipt", async () => {
  const f = setup(); const pending = await f.service.prepare(f.input);
  assert.deepEqual(f.calls.map(c => c.method), ["courseware.parseStart", "courseware.parseStatus", "courseware.project.attach", "courseware.project.openSaved", "courseware.parseRelease",
    "courseware.parseStart", "courseware.parseStatus", "courseware.nativeSave.prepare", "courseware.parseRelease"]);
  await pending.commit();
  assert.equal(f.calls.at(-1).method, "courseware.nativeSave.resolve");
});
test("native save rejects foreign export receipts before parser or authority writes", async () => {
  for (const change of [{ outputSha256: "c".repeat(64) }, { documentId: "foreign" }, { saveRequestId: "old-save" }]) {
    const f = setup(); Object.assign(f.input.lineage, change);
    await assert.rejects(f.service.prepare(f.input), /identity is unavailable/);
    assert.equal(f.calls.length, 0);
  }
});
test("native save releases failed parsing and never prepares a live-file replacement", async () => {
  const f = setup(), original = f.host.call;
  f.host.call = async (method, params) => method === "courseware.parseStatus" ? { status: "FAILED", message: "invalid exported file" } : original(method, params);
  await assert.rejects(f.service.prepare(f.input), /invalid exported file/);
  assert.equal(f.calls.at(-1).method, "courseware.parseRelease");
  assert.equal(f.calls.some(c => c.method === "courseware.nativeSave.prepare"), false);
});
test("reopening resolves a durable save before opening or parsing the document", async () => {
  const f = setup(); await f.service.recover(f.input.workspace, f.input.sourcePath, "chat-session");
  assert.deepEqual(f.calls.map(c => c.method), ["courseware.nativeSave.forPath", "courseware.nativeSave.resolve"]);
});

test("real SDK files retain narration and object UUIDs across two real Host saves and reopen", {
  skip: !process.env.DECKWISE_NATIVE_SAVE_FIXTURE, timeout: 120_000,
}, async t => {
  const { promises: fs } = await import("node:fs"), { tmpdir } = await import("node:os");
  const { Host, resolveHostBinary } = await import("../../../scripts/e2e/host.mjs");
  const root = await fs.mkdtemp(join(tmpdir(), "native-save-host-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace"), data = join(root, "profile");
  await fs.mkdir(workspace); await fs.mkdir(join(data, "plugins/market"), { recursive: true });
  await fs.writeFile(join(data, "plugins/market/catalog.json"), JSON.stringify({ schemaVersion: 2, providerId: "official", plugins: [] }));
  const host = new Host(resolveHostBinary(), data);
  const fixture = process.env.DECKWISE_NATIVE_SAVE_FIXTURE;
  const receipts = JSON.parse(await fs.readFile(join(fixture, "lineage.json"), "utf8"));
  const { publishRevision, replaceSourceFile } = load(join(main, "ppt-editor-files.ts"));
  const sourcePath = join(workspace, "lesson.pptx"), documentId = jobIdFor(workspace, sourcePath), archive = join(workspace, ".deckwise-ppt/revisions");
  const original = await fs.readFile(join(fixture, "original.pptx"));
  await fs.writeFile(sourcePath, original);
  let previous = await publishRevision({ root: archive, jobId: documentId, bytes: original, extension: "pptx", cause: "generated", expectedRevision: 0 });
  const binding = { projectId: createHash("sha256").update(workspace).digest("hex"), documentId, sessionId: "sdk-session" };
  try {
    await host.start();
    const { session } = await host.call("session.create", { title: "Native save", mode: "agent", projectPath: workspace });
    const service = new CoursewareNativeSave(() => host, () => session.id, async () => workspace, () => {}, async operation => operation());
    let firstContext;
    for (const [index, name] of ["first.pptx", "second.pptx"].entries()) {
      const bytes = await fs.readFile(join(fixture, name));
      const next = await publishRevision({ root: archive, jobId: documentId, bytes, extension: "pptx", cause: "edited", expectedRevision: previous.revision });
      const lineage = { ...receipts[index], ...binding }; delete lineage.bytes;
      const pending = await service.prepare({ workspace, sourcePath, sourceRevisionPath: previous.documentPath, sourceSha256: previous.sha256,
        outputPath: next.documentPath, outputSha256: next.sha256, saveRequestId: lineage.saveRequestId, binding, lineage });
      await replaceSourceFile(sourcePath, bytes, "pptx", previous.sha256);
      await pending.commit();
      let context = await host.call("courseware.project.context", { sessionId: session.id, projectId: "office-" + documentId });
      if (!firstContext) {
        const project = context.project;
        await host.call("courseware.teaching.write", { sessionId: session.id, write: { projectId: project.projectId, pageId: project.pages[0].pageId,
          expectedSourceRevision: project.source.revision, expectedTeachingRevision: project.teachingRevision,
          actions: [{ id: "narration", type: "speech", text: "Keep my narration across native PPT saves." }] } });
        firstContext = await host.call("courseware.project.context", { sessionId: session.id, projectId: project.projectId });
      } else {
        assert.equal(context.project.pages[0].pageId, firstContext.project.pages[0].pageId);
        assert.equal(context.savedObjects.pages[0].objects[0].objectId, firstContext.savedObjects.pages[0].objects[0].objectId);
        assert.deepEqual(context.project.pages[0].actions, firstContext.project.pages[0].actions);
      }
      previous = next;
    }
    await service.recover(workspace, sourcePath, session.id);
    assert.equal((await fs.readFile(sourcePath)).equals(await fs.readFile(join(fixture, "second.pptx"))), true);
  } finally { await host.stop(); }
});
