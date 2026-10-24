/** Test producer boundary only: stage frozen B actions through the actual Host while Desktop is stopped. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

export async function stageNarrationFixtures({ data, sessionId, archive, project, fixture, log }) {
  const child = spawn(process.env.PI_DESKTOP_HOST_BIN, [], { stdio: ["pipe", "pipe", "pipe"], env: {
    PATH: process.env.PATH, LANG: "C.UTF-8", PI_DESKTOP_DATA_DIR: data,
    DECKWISE_PPTX_NODE: process.execPath, DECKWISE_PPTX_WORKER: process.env.DECKWISE_PPTX_WORKER,
  } });
  const pending = new Map();
  let sequence = 0;
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error(`Fixture Host exited ${code}`)); }
      pending.clear(); resolve(code);
    });
  });
  child.stderr.on("data", (bytes) => log.push(String(bytes)));
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const response = JSON.parse(line);
    const request = pending.get(response.id);
    if (!request) return;
    clearTimeout(request.timer); pending.delete(response.id);
    if (response.error) request.reject(new Error(JSON.stringify(response.error)));
    else request.resolve(response.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Fixture RPC timeout: ${method}`)); }, 100_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  let job;
  try {
    await call("app.handshake", { protocolVersion: 11 });
    job = await call("courseware.parseStart", { sessionId, path: archive });
    const deadline = Date.now() + 95_000;
    while (true) {
      const state = await call("courseware.parseStatus", { jobId: job.jobId });
      if (state.status !== "RUNNING") { assert.equal(state.status, "SUCCEEDED", JSON.stringify(state)); break; }
      assert(Date.now() < deadline, "Fixture parser timed out"); await delay(20);
    }
    assert.deepEqual((await call("courseware.project.openSaved", { sessionId, jobId: job.jobId })).project, project);
    const writes = [];
    for (const candidateId of ["a6-adopt", "a6-stale"]) {
      const write = { projectId: project.projectId, pageId: project.pages[0].pageId,
        expectedSourceRevision: project.source.revision, expectedTeachingRevision: project.teachingRevision, actions: fixture.write.actions };
      const candidate = await call("courseware.narrationCandidate.stage", { sessionId, jobId: job.jobId, candidateId, write });
      assert.equal(candidate.status, "needs-review"); writes.push(candidate);
    }
    assert.deepEqual((await call("courseware.project.openSaved", { sessionId, jobId: job.jobId })).project, project);
    return writes;
  } finally {
    try { if (job) await call("courseware.parseRelease", { jobId: job.jobId }); }
    finally {
      child.stdin.end(); const kill = setTimeout(() => child.kill("SIGKILL"), 10_000);
      try { assert.equal(await exited, 0); } finally { clearTimeout(kill); lines.close(); }
    }
  }
}
