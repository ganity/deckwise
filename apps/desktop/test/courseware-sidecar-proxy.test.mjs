import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { AgentSidecar } = await import("../electron/main/agent-sidecar.ts");

test("sidecar forwards workflow checkpoints through Host while preserving RPC denials", async () => {
  const calls = [];
  const replies = [];
  const sidecar = Object.create(AgentSidecar.prototype);
  sidecar.localTools = new Map();
  sidecar.host = { async call(method, params) {
    calls.push({ method, params });
    if (params.turnId === "stopped") throw Object.assign(new Error("Workflow turn ended"), { code: 1002 });
    return method === "courseware.workflow.get" ? { checkpoint: null, completion: { ready: true } } : { checkpoint: params.checkpoint };
  } };
  sidecar.writeToChild = line => { replies.push(JSON.parse(line)); return true; };
  const proxy = async (method, params) => {
    await sidecar.onLine(JSON.stringify({ jsonrpc: "2.0", id: replies.length, method: "host.proxy", params: { method, params } }));
    return replies.at(-1);
  };
  const read = { sessionId: "chat", projectId: "project" };
  assert.deepEqual((await proxy("courseware.workflow.get", read)).result, { checkpoint: null, completion: { ready: true } });
  const write = { ...read, turnId: "turn", expectedRevision: 0, checkpoint: {
    revision: 1, projectId: "project", sourceSha256: "a".repeat(64), status: "completed", repairAttempts: {}, lastResume: null,
  } };
  assert.deepEqual((await proxy("courseware.workflow.checkpoint", write)).result, { checkpoint: write.checkpoint });
  assert.deepEqual(calls, [{ method: "courseware.workflow.get", params: read }, { method: "courseware.workflow.checkpoint", params: write }]);
  assert.equal((await proxy("courseware.workflow.checkpoint", { ...write, turnId: "stopped" })).error.code, 1002);
  for (const method of ["providers.getSecret", "courseware.workflow.delete", "courseware.projects.delete"]) {
    assert.equal((await proxy(method, read)).error.code, -32601);
  }
  assert.equal(calls.length, 3);
});
