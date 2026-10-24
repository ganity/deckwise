/** Real Host/worker check for ordinary and imported PPTX speaker notes. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const [hostBin, worker, source] = process.argv.slice(2);
assert([hostBin, worker, source].every((path) => path && isAbsolute(path)));
const temp = await mkdtemp(join(tmpdir(), "deckwise-notes-"));
const data = join(temp, "data"), workspace = join(temp, "workspace");
await mkdir(join(data, "plugins/market"), { recursive: true });
await mkdir(join(workspace, ".deckwise-ppt/revisions/notes-e2e/r0001"), { recursive: true });
const saved = join(workspace, ".deckwise-ppt/revisions/notes-e2e/r0001/document.pptx");
const importedSaved = join(workspace, ".deckwise-ppt/revisions/import-notes-e2e/r0001/document.pptx");
await copyFile(source, saved);
await mkdir(join(importedSaved, ".."), { recursive: true });
await copyFile(source, importedSaved);
const sha256 = createHash("sha256").update(await readFile(saved)).digest("hex");
const child = spawn(hostBin, [], { stdio: ["pipe", "pipe", "pipe"], env: {
  PATH: process.env.PATH, LANG: "C.UTF-8", PI_DESKTOP_DATA_DIR: data,
  PI_DESKTOP_PLUGIN_MARKET_URL: "http://127.0.0.1:9/catalog.json",
  DECKWISE_PPTX_NODE: process.execPath, DECKWISE_PPTX_WORKER: worker,
} });
const pending = new Map();
let id = 0;
let stderr = "";
child.stderr.on("data", (data) => { stderr += String(data); });
createInterface({ input: child.stdout }).on("line", (line) => {
  const response = JSON.parse(line), waiter = pending.get(response.id);
  if (!waiter) return;
  pending.delete(response.id); clearTimeout(waiter.timer);
  response.error ? waiter.reject(new Error(JSON.stringify(response.error))) : waiter.resolve(response.result);
});
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const current = ++id;
  const timer = setTimeout(() => { pending.delete(current); reject(new Error(`Host timeout: ${method}`)); }, 100_000);
  pending.set(current, { resolve, reject, timer });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: current, method, params })}\n`);
});
const exit = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => resolve(code)); });
try {
  await call("app.handshake", { protocolVersion: 11 });
  const sessionId = (await call("session.create", { projectPath: workspace })).session.id;
  await call("courseware.task.set", { sessionId, taskType: "plain" });
  const { jobId } = await call("courseware.parseStart", { sessionId, path: saved });
  let status;
  do { status = await call("courseware.parseStatus", { jobId }); if (status.status === "RUNNING") await delay(50); }
  while (status.status === "RUNNING");
  assert.equal(status.status, "SUCCEEDED", JSON.stringify(status));
  assert.equal(status.summary.sourceSha256, sha256);
  const original = (await call("courseware.project.openSaved", { sessionId, jobId })).project;
  assert.equal(original.pages.length, status.summary.pages);
  const narrations = [];
  for (let pageNumber = 1; pageNumber <= original.pages.length; pageNumber++) {
    narrations.push((await call("courseware.pageNotes", { sessionId, jobId, pageNumber })).text);
  }
  assert(narrations.every((text) => text.trim() && text.length <= 2500));
  const initialized = (await call("courseware.project.initializeGenerated", {
    sessionId, jobId, sourceSha256: sha256, title: "北斗导航课", narrations,
  })).project;
  assert.equal(initialized.pages[0].actions[0].text, narrations[0]);
  assert.deepEqual((await call("courseware.project.openSaved", { sessionId, jobId })).project, initialized);
  await assert.rejects(call("courseware.project.initializeGenerated", {
    sessionId, jobId, sourceSha256: "0".repeat(64), title: "北斗导航课", narrations,
  }), /does not match source|differs/i);
  await call("courseware.parseRelease", { jobId });
  const importSessionId = (await call("session.create", { projectPath: workspace })).session.id;
  await call("courseware.task.set", { sessionId: importSessionId, taskType: "import" });
  const importedJob = (await call("courseware.parseStart", { sessionId: importSessionId, path: importedSaved })).jobId;
  let importedStatus;
  do { importedStatus = await call("courseware.parseStatus", { jobId: importedJob }); if (importedStatus.status === "RUNNING") await delay(50); }
  while (importedStatus.status === "RUNNING");
  assert.equal(importedStatus.status, "SUCCEEDED", JSON.stringify(importedStatus));
  const importProject = (await call("courseware.project.openSaved", { sessionId: importSessionId, jobId: importedJob })).project;
  assert.deepEqual(importProject.pages[0].actions, []);
  assert.equal((await call("courseware.pageNotes", { sessionId: importSessionId, jobId: importedJob, pageNumber: 1 })).text, narrations[0]);
  assert.deepEqual((await call("courseware.project.openSaved", { sessionId: importSessionId, jobId: importedJob })).project.pages[0].actions, []);
  await call("courseware.parseRelease", { jobId: importedJob });
  console.log(JSON.stringify({ status: "PASS", pages: narrations.length, firstNarration: narrations[0].slice(0, 60), importPreviewNoWrite: true, workspace }));
} catch (error) {
  console.error(stderr.slice(-3000));
  throw error;
} finally {
  child.stdin.end();
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try { assert.equal(await exit, 0, stderr.slice(-1000)); } finally { clearTimeout(timer); }
}
