import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { createRebuiltAttentionFixture } from "../../../scripts/e2e/rebuilt-attention.mjs";

test("audio fixture keeps the original contract and holds exactly one download without resubmission", async () => {
  const fixture = await createRebuiltAttentionFixture();
  const server = createServer(async (req, res) => {
    try { if (!await fixture.handle(req, res)) { res.writeHead(404); res.end(); } }
    catch (error) { res.writeHead(400); res.end(String(error)); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${origin}/courseware/media/tasks/confirmed`, { method: "POST",
      headers: { "idempotency-key": "task-once", "content-type": "application/json" },
      body: JSON.stringify({ request: { kind: "tts", model: "fixture-speech", voice: "classroom", input: "Good! Page 1." },
        confirmation: { maxPoints: 1 } }) });
    assert.equal(response.status, 200);
    const { data: task } = await response.json();
    const hold = fixture.holdNextDownload();
    assert.throws(() => fixture.holdNextDownload());
    let received = false;
    const pending = fetch(origin + task.assetRef.downloadPath).then(async response => {
      received = true; assert.equal(response.status, 200); return Buffer.from(await response.arrayBuffer());
    });
    try { await hold.received; assert.equal(received, false); }
    finally { hold.release(); }
    const bytes = await pending;
    const next = await fetch(origin + task.assetRef.downloadPath);
    assert.deepEqual(Buffer.from(await next.arrayBuffer()), bytes);
    assert.equal(fixture.result().requests, 1);
    assert.equal(fixture.result().paidCalls, false);
    const duplicate = await fetch(`${origin}/courseware/media/tasks/confirmed`, { method: "POST",
      headers: { "idempotency-key": "task-once", "content-type": "application/json" },
      body: JSON.stringify({ request: { kind: "tts", model: "fixture-speech", voice: "classroom", input: "Good! Page 1." },
        confirmation: { maxPoints: 1 } }) });
    assert.equal(duplicate.status, 400); assert.equal(fixture.result().requests, 1);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
