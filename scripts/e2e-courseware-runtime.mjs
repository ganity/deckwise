/** Host transport/worker integration check. This is not the full N-DE W02.4 UI gate. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [worker, sampleFile, evidence] = process.argv.slice(-3);
assert(worker && sampleFile && evidence && [worker, sampleFile, evidence].every((path) => path.startsWith("/")), "Supply absolute worker entry, W00 samples.json, and new evidence directory");
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const { app } = require("electron");
const samples = JSON.parse(await readFile(sampleFile, "utf8"));
const sampleRoot = resolve(dirname(sampleFile), "../../../..");
const temp = await mkdtemp(join(tmpdir(), "deckwise-host-pptx-"));
app.setPath("userData", join(temp, "profile"));
await mkdir(evidence);
const workspace = join(temp, "workspace");
const data = join(temp, "data");
await mkdir(workspace);
await mkdir(join(data, "plugins/market"), { recursive: true });
await writeFile(join(data, "plugins/market/catalog.json"), JSON.stringify({ schemaVersion: 2, providerId: "official", plugins: [] }));
process.env.PI_DESKTOP_HOST_BIN ||= join(root, "target/debug/pi-desktop-host-core");
process.env.DECKWISE_PPTX_WORKER = resolve(worker);
let host;
const logs = [];
const results = [];
const checks = [];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const normalizedText = (text) => text.replace(/<[^>]*>/g, "").replace(/&(?:nbsp|amp|lt|gt|quot|#\d+|#x[\da-f]+);/gi, " ").replace(/\s+/g, "").normalize("NFC");
async function terminal(jobId) {
  const deadline = Date.now() + 95_000;
  while (Date.now() < deadline) {
    const state = await host.call("courseware.parseStatus", { jobId });
    if (state.status !== "RUNNING") return state;
    await delay(10);
  }
  throw new Error("Host parser did not reach terminal state");
}
try {
  const transport = join(temp, "host.cjs");
  await build({
    stdin: { contents: 'export { HostProcess } from "./apps/desktop/electron/main/host-process";', resolveDir: root, loader: "ts" },
    outfile: transport, bundle: true, platform: "node", format: "cjs",
    external: ["electron"],
    alias: { "@pi-desktop/shared": join(root, "packages/shared/src/index.ts") },
    define: { __dirname: JSON.stringify(join(root, "apps/desktop/electron/main")) },
  });
  const { HostProcess } = require(transport);
  host = new HostProcess(data, (line) => logs.push(line));
  await host.handshake();
  await assert.rejects(host.call("courseware.parseStart", { path: "missing.pptx" }));
  await host.call("workspace.set", { path: workspace });
  await assert.rejects(host.call("courseware.parseStatus", { jobId: "unknown" }));
  await assert.rejects(host.call("courseware.parseStart", { path: "../outside.pptx" }));
  const outside = join(temp, "outside.pptx");
  await writeFile(outside, "outside");
  await symlink(outside, join(workspace, "escape.pptx"));
  await assert.rejects(host.call("courseware.parseStart", { path: "escape.pptx" }));
  checks.push("No workspace, unknown ID, traversal and symlink escape rejected");
  for (const sample of samples) {
    const source = join(sampleRoot, sample.path);
    const content = await readFile(source);
    assert.equal(hash(content), sample.sha256);
    const input = join(workspace, `${sample.id}.pptx`);
    await copyFile(source, input);
    await assert.rejects(host.call("courseware.parseStart", { path: input, outputDirectory: temp }));
    const started = await host.call("courseware.parseStart", { path: input });
    await assert.rejects(host.call("courseware.parseStart", { path: input }));
    const state = await terminal(started.jobId);
    assert.equal(state.status, "SUCCEEDED", JSON.stringify(state));
    assert.equal(state.pages, sample.slides);
    const ir = JSON.parse(await readFile(join(state.outputDirectory, "slide-ir.json"), "utf8"));
    const workerResult = JSON.parse(await readFile(join(state.outputDirectory, "result.json"), "utf8"));
    assert.equal(workerResult.sourceSha256, sample.sha256);
    assert.equal(hash(await readFile(input)), sample.sha256);
    assert.equal(ir.pages.length, sample.slides);
    let checkedTextAnchors = 0;
    for (const anchor of sample.requiredAnchors) {
      const text = normalizedText(ir.pages[anchor.page - 1].elements.map((element) => `${element.content ?? ""} ${JSON.stringify(element.table ?? "")} ${element.latex ?? ""}`).join(" "));
      for (const expected of anchor.textSamples.filter((item) => normalizedText(item))) {
        assert(text.includes(normalizedText(expected)), `${sample.id}: missing ${expected}`);
        checkedTextAnchors++;
      }
    }
    results.push({ id: sample.id, pages: state.pages, sourceSha256: sample.sha256, checkedTextAnchors, workerResult });
    await host.call("courseware.parseRelease", { jobId: started.jobId });
    await assert.rejects(readFile(join(state.outputDirectory, "slide-ir.json")));
    await assert.rejects(host.call("courseware.parseStatus", { jobId: started.jobId }));
  }
  checks.push("20 real HostProcess/Rust/worker parses, hashes/page counts, explicit release");

  const invalid = join(workspace, "invalid.pptx");
  await writeFile(invalid, "not a PPTX");
  let job = await host.call("courseware.parseStart", { path: invalid });
  let state = await terminal(job.jobId);
  assert.equal(state.status, "FAILED");
  assert.equal(state.cleanupFailed, false);
  await host.call("courseware.parseRelease", { jobId: job.jobId });
  checks.push("Invalid PPTX fails and host cleanup completes");

  job = await host.call("courseware.parseStart", { path: join(workspace, "S17.pptx") });
  await assert.rejects(host.call("courseware.parseRelease", { jobId: job.jobId }));
  const jobDirectory = join(data, "cache/courseware", job.jobId);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await readFile(join(jobDirectory, "worker.log"), "utf8").catch(() => "")).includes("开始解析 PPTX")) break;
    await delay(5);
  }
  assert((await readFile(join(jobDirectory, "worker.log"), "utf8")).includes("开始解析 PPTX"));
  await host.call("courseware.parseCancel", { jobId: job.jobId });
  state = await terminal(job.jobId);
  assert.equal(state.status, "FAILED");
  assert.match(state.message, /canceled/);
  assert.equal(state.cleanupFailed, false);
  await host.call("courseware.parseRelease", { jobId: job.jobId });
  checks.push("Cancel during real parsing, reject premature release, reap and cleanup");

  await host.call("courseware.parseStart", { path: join(workspace, "S17.pptx") });
  await host.dispose();
  host = undefined;
  assert.deepEqual(await readdir(join(data, "cache/courseware")), []);
  checks.push("Host stdin shutdown cancels worker and removes retained job");
  await writeFile(join(evidence, "report.json"), JSON.stringify({
    status: "HOST_WORKER_INTEGRATION_PASS", head: "LOCAL_UNCOMMITTED", runtime: process.versions,
    checks, samples: results,
    notVerified: ["Renderer/preload UI path", "Full N-DE W02.4", "Installer resources", "Fonts/visual fidelity", "Production resource budgets", "Crash orphan recovery", "Windows/macOS"],
  }, null, 2));
  console.log(JSON.stringify({ checks: checks.length, samples: results.length, pages: results.reduce((sum, item) => sum + item.pages, 0), textAnchors: results.reduce((sum, item) => sum + item.checkedTextAnchors, 0) }));
} finally {
  if (host) await host.dispose();
  await writeFile(join(evidence, "host.log"), logs.join(""));
  await rm(temp, { recursive: true, force: true });
  app.quit();
}
