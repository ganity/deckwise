import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { requestPptEditor } from "../electron/main/ppt-editor-request.ts";

const channel = "deckwise-editor:event";
test("courseware desktop driver rejects unknown cases before boot or dependency loading", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../../../scripts/e2e-courseware.mjs", import.meta.url)), "--case", "unknown"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Supported invocation: --case W01.2/);
});

function response(ipc, sender, id, type = "document:context", payload = { page: 1 }) {
  ipc.emit(channel, { sender: { id: sender } }, { type: "message", message: { id, type, payload } });
}

test("request listener is installed before send and checks sender, request ID and type", async () => {
  const ipc = new EventEmitter();
  const abort = new AbortController();
  const result = await requestPptEditor(ipc, 7, "current", "document:context", () => {
    response(ipc, 8, "current");
    response(ipc, 7, "old");
    response(ipc, 7, "current", "document:command-result");
    response(ipc, 7, "old", "document:error");
    assert.equal(ipc.listenerCount(channel), 1);
    response(ipc, 7, "current");
  }, abort.signal);
  assert.deepEqual(result, { page: 1 });
  assert.equal(ipc.listenerCount(channel), 0);
});

test("errors, send failure, timeout and session closure reject and clean up", async () => {
  for (const failure of ["protocol", "send", "timeout", "close", "host"]) {
    const ipc = new EventEmitter();
    const abort = new AbortController();
    const pending = requestPptEditor(ipc, 7, "current", "document:context", () => {
      if (failure === "protocol") response(ipc, 7, "current", "document:error", { message: "stale context" });
      if (failure === "send") throw new Error("send failed");
      if (failure === "close") abort.abort();
      if (failure === "host") ipc.emit(channel, { sender: { id: 7 } }, { type: "error" });
    }, abort.signal, 5);
    await assert.rejects(pending);
    assert.equal(ipc.listenerCount(channel), 0);
    assert.equal(abort.signal.onabort, null);
  }
});

test("an already closed session sends no command", async () => {
  const ipc = new EventEmitter();
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(requestPptEditor(ipc, 7, "current", "document:context", () => {
    assert.fail("must not send");
  }, abort.signal), /closed/);
  assert.equal(ipc.listenerCount(channel), 0);
});

test("page preview responses correlate exactly and cancellation removes pending listeners", async () => {
  const ipc = new EventEmitter();
  const controller = new AbortController();
  const result = await requestPptEditor(ipc, 7, "preview", "document:page-preview", () => {
    response(ipc, 8, "preview", "document:page-preview");
    response(ipc, 7, "preview", "document:context");
    response(ipc, 7, "preview", "document:page-preview", { sourceSha256: "a".repeat(64) });
  }, controller.signal);
  assert.equal(result.sourceSha256, "a".repeat(64));
  assert.equal(ipc.listenerCount(channel), 0);
  const pending = requestPptEditor(ipc, 7, "cancel-preview", "document:page-preview", () => {}, controller.signal);
  controller.abort();
  await assert.rejects(pending, /closed/);
  assert.equal(ipc.listenerCount(channel), 0);
});

test("target-bound image approval cannot be acknowledged by an old generic context reply", async () => {
  const ipc = new EventEmitter();
  const abort = new AbortController();
  const result = await requestPptEditor(ipc, 7, "image-target", "document:image-target-reviewed", () => {
    response(ipc, 7, "image-target", "document:context", { page: 99 });
    response(ipc, 8, "image-target", "document:image-target-reviewed", { page: 99 });
    response(ipc, 7, "old", "document:image-target-reviewed", { page: 99 });
    assert.equal(ipc.listenerCount(channel), 1);
    response(ipc, 7, "image-target", "document:image-target-reviewed", { page: 1, editGeneration: 2 });
  }, abort.signal);
  assert.deepEqual(result, { page: 1, editGeneration: 2 });
  assert.equal(ipc.listenerCount(channel), 0);
});
