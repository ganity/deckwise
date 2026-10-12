import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { waitForPptEditorMessage } from "../electron/main/ppt-editor-handshake.ts";

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
