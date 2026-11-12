import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { openPptEditorDocument, PptEditorNotReadyError, waitForPptEditorMessage, waitForPptEditorTeachingReady } from "../electron/main/ppt-editor-handshake.ts";

const channel = "deckwise-editor:event";
const send = (ipc, senderId, type, id, payload) => ipc.emit(channel,
  { sender: { id: senderId } }, { type: "message", message: { type, id, payload } });

test("opening requires the intended sender, response type, and command ID", async () => {
  const ipc = new EventEmitter();
  const ready = waitForPptEditorMessage(ipc, 7, "document:ready", undefined, 1000);
  send(ipc, 8, "document:ready");
  send(ipc, 7, "document:opened", "old");
  assert.equal(ipc.listenerCount(channel), 1);
  send(ipc, 7, "document:ready");
  await ready;
  assert.equal(ipc.listenerCount(channel), 0);

  const opened = waitForPptEditorMessage(ipc, 7, "document:opened", "current", 1000);
  send(ipc, 7, "document:opened", "old");
  send(ipc, 7, "document:error", "old", { message: "stale failure" });
  assert.equal(ipc.listenerCount(channel), 1);
  send(ipc, 7, "document:opened", "current");
  await opened;
  assert.equal(ipc.listenerCount(channel), 0);
});

test("protocol and host failures reject the handshake and release its listener", async () => {
  const ipc = new EventEmitter();
  const opened = waitForPptEditorMessage(ipc, 7, "document:opened", "current", 1000);
  send(ipc, 7, "document:error", "current", { message: "conversion failed" });
  await assert.rejects(opened, /conversion failed/);
  assert.equal(ipc.listenerCount(channel), 0);

  const ready = waitForPptEditorMessage(ipc, 7, "document:ready", undefined, 1000);
  ipc.emit(channel, { sender: { id: 7 } }, { type: "error", message: "host unavailable" });
  await assert.rejects(ready, /host unavailable/);
  assert.equal(ipc.listenerCount(channel), 0);
});

test("missing handshake times out and closing cancels the pending wait", async () => {
  const ipc = new EventEmitter();
  await assert.rejects(waitForPptEditorMessage(ipc, 7, "document:ready", undefined, 5), /timed out/);
  assert.equal(ipc.listenerCount(channel), 0);
  const abort = new AbortController();
  const pending = waitForPptEditorMessage(ipc, 7, "document:ready", undefined, 1000, abort.signal);
  abort.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(ipc.listenerCount(channel), 0);
});

test("document acknowledgement is registered before an immediate dispatch reply", async () => {
  const ipc = new EventEmitter();
  await openPptEditorDocument(ipc, 7, "open", () => send(ipc, 7, "document:opened", "open"), new AbortController().signal, 100);
  assert.equal(ipc.listenerCount(channel), 0);
});

test("document phase has a fresh deadline after shell readiness", async () => {
  const ipc = new EventEmitter();
  const ready = waitForPptEditorMessage(ipc, 7, "document:ready", undefined, 100);
  send(ipc, 7, "document:ready");
  await ready;
  await openPptEditorDocument(ipc, 7, "open", () => setImmediate(() => send(ipc, 7, "document:opened", "open")), new AbortController().signal, 100);
  assert.equal(ipc.listenerCount(channel), 0);
});

test("document dispatch failure, timeout and cancellation release listeners", async () => {
  const ipc = new EventEmitter();
  await assert.rejects(openPptEditorDocument(ipc, 7, "open", () => { throw new Error("dispatch failed"); }, new AbortController().signal, 100), /dispatch failed/);
  await assert.rejects(openPptEditorDocument(ipc, 7, "open", () => {}, new AbortController().signal, 5), /timed out/);
  const cancelled = new AbortController();
  cancelled.abort(new Error("closed"));
  await assert.rejects(openPptEditorDocument(ipc, 7, "open", () => assert.fail("must not dispatch"), cancelled.signal), /closed/);
  const switched = new AbortController();
  await assert.rejects(openPptEditorDocument(ipc, 7, "open", () => switched.abort(new Error("switched")), switched.signal), /switched/);
  assert.equal(ipc.listenerCount(channel), 0);
});

for (const operation of ["scene_compile", "ppt_import_save", "ppt_master_export"]) {
  test(`${operation} media check waits for editor readiness/save without repeating generation or payment`, async () => {
    let editorReady = false, waitingForSave = false, checks = 0, generated = 1, paid = 1, mediaChecks = 0;
    const pending = waitForPptEditorTeachingReady({
      ready: () => editorReady && !waitingForSave,
      phase: () => waitingForSave ? "saving" : "opening",
      check: () => { checks++; }, timeoutMs: 1000, intervalMs: 1,
    });
    setTimeout(() => { editorReady = true; }, 5);
    setTimeout(() => { waitingForSave = false; }, 10);
    waitingForSave = true;
    await pending;
    mediaChecks++;
    assert(checks > 1);
    assert.equal(mediaChecks, 1);
    assert.equal(generated, 1);
    assert.equal(paid, 1);
    assert.equal(editorReady, true);
    assert.equal(waitingForSave, false);
  });
}

test("editor readiness timeout preserves the operation phase for bounded status retry", async () => {
  await assert.rejects(waitForPptEditorTeachingReady({ ready: () => false, phase: () => "opening", check() {}, timeoutMs: 2 }),
    error => error instanceof PptEditorNotReadyError && error.code === "PPT_EDITOR_NOT_READY" && error.phase === "opening");
  await assert.rejects(waitForPptEditorTeachingReady({ ready: () => false, phase: () => "saving", check() {}, timeoutMs: 2 }),
    error => error instanceof PptEditorNotReadyError && error.code === "PPT_EDITOR_NOT_READY" && error.phase === "saving");
  await assert.rejects(waitForPptEditorTeachingReady({ ready: () => false, phase: () => "focus", check() {}, timeoutMs: 2 }),
    error => error instanceof PptEditorNotReadyError && error.code === "PPT_EDITOR_NOT_READY" && error.phase === "focus");
});
