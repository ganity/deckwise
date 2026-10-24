/** Real sequential Host/parser review gate; remote teaching/callback pins are explicit fixtures. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { Host } from "../../../scripts/e2e/host.mjs";

const [binary, output] = process.argv.slice(2);
assert(binary && output && isAbsolute(binary) && isAbsolute(output));
await fs.mkdir(output);
const root = await fs.mkdtemp(join(tmpdir(), "deckwise-online-review-"));
const data = join(root, "data"), workspace = join(root, "workspace"), foreign = join(root, "foreign");
await fs.mkdir(workspace); await fs.mkdir(foreign); await fs.mkdir(join(data, "plugins/market"), { recursive: true });
await fs.writeFile(join(data, "plugins/market/catalog.json"), JSON.stringify({ schemaVersion: 2, providerId: "official", plugins: [] }));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
process.env.DECKWISE_PPTX_NODE = process.execPath;
process.env.DECKWISE_PPTX_WORKER = fileURLToPath(new URL("../../../packages/courseware-runtime/dist/pptx-worker.mjs", import.meta.url));
const report = { status: "RUNNING", checks: [], hostPids: [], binary, binarySha256: hash(await fs.readFile(binary)),
  realHost: true, realParser: true, projectAndCallbackFixtures: true, realPlatform: false, realDocs: false, paidCalls: false };
let host, sessionId, baselineId, project, mapping, original;
async function start() { await host?.stop(); host = new Host(binary, data); await host.start(); report.hostPids.push(host.child.pid); }
const call = (method, args) => host.call(method, args, 30_000);
async function parse(name) {
  const bytes = await fs.readFile(new URL(`../../../packages/courseware-runtime/tests/fixtures/office-lineage-b7/${name}.pptx`, import.meta.url));
  const path = join(workspace, `${name}.pptx`); await fs.writeFile(path, bytes);
  const { jobId } = await call("courseware.parseStart", { sessionId, path });
  const deadline = Date.now() + 95_000;
  while (Date.now() < deadline) {
    const result = await call("courseware.parseStatus", { jobId });
    if (result.status !== "RUNNING") {
      assert.equal(result.status, "SUCCEEDED", JSON.stringify(result));
      const identity = JSON.parse(await fs.readFile(join(result.outputDirectory, "identity.json"), "utf8"));
      assert.equal(identity.sourceSha256, hash(bytes));
      return { jobId, bytes, path, identity };
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Parser timed out");
}
async function check(name, fn) { await fn(); report.checks.push(name); console.log("PASS", name); }
const target = parsed => ({ source: { revision: "44444444-4444-4444-8444-444444444444", sha256: hash(parsed.bytes) },
  byteLength: parsed.bytes.length, sessionEpoch: 7, callbackId: "c".repeat(64) });
const review = (parsed, extra = {}) => call("courseware.onlineSource.review", { sessionId, baselineId, jobId: parsed.jobId, target: target(parsed), ...extra });
try {
  await start(); sessionId = (await call("session.create", { projectPath: workspace })).session.id;
  const otherChat = (await call("session.create", { projectPath: workspace })).session.id;
  const otherWorkspace = (await call("session.create", { projectPath: foreign })).session.id;
  await call("courseware.task.set", { sessionId, taskType: "import" });
  const before = await call("courseware.task.get", { sessionId });
  await check("Real old parser and complete mapping establish one temporary session-bound baseline", async () => {
    const parsed = await parse("source");
    project = { schemaVersion: "deckwise-courseware/1", projectId: "22222222-2222-4222-8222-222222222222", taskType: "import", title: "Original remote teaching",
      source: { revision: "33333333-3333-4333-8333-333333333333", sha256: hash(parsed.bytes) }, teachingRevision: "teaching-old",
      pages: parsed.identity.pages.map((_, index) => ({ pageId: `old-page-${index}`, locked: false, reviewState: "ready",
        actions: [{ id: `speech-${index}`, type: "speech", text: `Good! Original page ${index + 1}.` }] })) };
    mapping = { revision: "mapping-old", sourceSha256: project.source.sha256,
      pages: parsed.identity.pages.map((page, index) => ({ pageId: project.pages[index].pageId, importPageId: page.importPageId,
        objects: page.objects.map((object, i) => ({ objectId: `old-object-${index}-${i}`, importElementId: object.importElementId })) })) };
    original = structuredClone({ project, mapping });
    const args = { sessionId, jobId: parsed.jobId, sourceByteLength: parsed.bytes.length, project, mapping };
    const first = await call("courseware.onlineSource.baseline", args); baselineId = first.baselineId;
    await assert.rejects(call("courseware.onlineSource.baseline", { ...args, sourceByteLength: parsed.bytes.length + 1 }));
    await assert.rejects(review(parsed), /baseline/u);
    const second = await call("courseware.onlineSource.baseline", args);
    assert.notEqual(second.baselineId, first.baselineId); baselineId = second.baselineId;
    await assert.rejects(review(parsed, { sessionId: otherChat }), /another review context/u);
    await assert.rejects(review(parsed, { sessionId: otherWorkspace }), /another review context/u);
    assert.deepEqual(second.source, project.source); assert.equal(second.teachingRevision, project.teachingRevision);
    await call("courseware.parseRelease", { jobId: parsed.jobId });
  });
  for (const [name, pages] of [["reordered", 3], ["native-edited", 3], ["copied-page", 4]]) {
    await check(`Actual ${name} bytes yield ${pages} review pages without default associations`, async () => {
      const parsed = await parse(name), view = await review(parsed);
      assert.deepEqual(view.original, original); assert.equal(view.requiresExplicitAssociations, true);
      assert.equal(view.target.pages.length, pages); assert.deepEqual(view.target.source, target(parsed).source);
      assert.equal(view.target.sessionEpoch, 7); assert.equal(view.target.callbackId, "c".repeat(64));
      assert.equal(view.previousPages.length, project.pages.length);
      assert(view.target.pages.every((page, index) => page.pageNumber === index + 1 && page.importPageId === parsed.identity.pages[index].importPageId));
      assert(!Object.hasOwn(view, "bindings") && !Object.hasOwn(view, "mapping"));
      assert.deepEqual(await review(parsed), view);
      assert.equal(Buffer.byteLength(JSON.stringify(view)) <= 2 * 1024 * 1024, true);
      await assert.rejects(review(parsed, { target: { ...target(parsed), byteLength: parsed.bytes.length + 1 } }));
      await fs.appendFile(parsed.path, "changed after parsing");
      await assert.rejects(review(parsed), /changed after parsing/u); await fs.writeFile(parsed.path, parsed.bytes);
      await fs.writeFile(join(output, `${name}-review.json`), JSON.stringify(view, null, 2) + "\n");
      await call("courseware.parseRelease", { jobId: parsed.jobId });
    });
  }
  await check("Clear and Host restart invalidate baseline while canonical teaching and archives remain untouched", async () => {
    assert.deepEqual(await call("courseware.task.get", { sessionId }), before);
    await assert.rejects(call("courseware.project.context", { sessionId, projectId: project.projectId }), /not found/u);
    await assert.rejects(fs.access(join(data, "courseware-candidates")));
    assert.deepEqual(await call("courseware.onlineSource.clear", { sessionId, baselineId }), { cleared: true });
    await assert.rejects(call("courseware.onlineSource.clear", { sessionId, baselineId }), /baseline/u);
    const parsed = await parse("source");
    baselineId = (await call("courseware.onlineSource.baseline", { sessionId, jobId: parsed.jobId, sourceByteLength: parsed.bytes.length, project, mapping })).baselineId;
    await call("courseware.parseRelease", { jobId: parsed.jobId }); await start();
    await assert.rejects(review(parsed), /baseline/u);
    assert.equal(new Set(report.hostPids).size, 2);
  });
  report.status = "PASS";
} catch (error) { report.status = "FAIL"; report.error = String(error.stack ?? error); throw error; }
finally {
  await host?.stop(); await fs.rm(root, { recursive: true, force: true }); report.cleanedUp = true;
  await fs.writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
}
