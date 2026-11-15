import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { onlineTeachingPlatform } from "../../../scripts/e2e/online-teaching.mjs";

const projectId = "b53115d2-18ae-44f2-bfd2-c47b3d1a7652";
const source = { revision: "d3b4b10a-c0d5-4711-a954-f354374f375b", sha256: "a".repeat(64) };
const prefix = `/courseware/team/projects/${projectId}`;
function fixture() {
  const platform = onlineTeachingPlatform({ projectId, source });
  const send = async (method, suffix, body) => {
    const request = Readable.from(body === undefined ? [] : [JSON.stringify(body)]); request.method = method;
    const result = {};
    result.handled = await platform.handle({ request, route: `${prefix}${suffix}`, actor: { role: "OWNER" },
      response: { writeHead(status) { result.status = status; }, end(text) { result.text = text; } },
      send(data, code = 200) { result.code = code; result.data = structuredClone(data); } });
    return result;
  };
  return { platform, send };
}

test("online teaching fixture reads no pause by default and exposes an immutable captured held version", async () => {
  const f = fixture();
  assert.deepEqual(await f.send("GET", "/editing-session/5/write-pauses/current"), { handled: true, code: 200, data: null });
  const held = f.platform.holdWrites();
  assert.equal(held.state, "held"); assert.deepEqual(held.teaching.project.source, source);
  const captured = structuredClone(held);
  held.teaching.project.pages[0].actions[0].text = "mutated returned copy";
  const read = await f.send("GET", "/editing-session/5/write-pauses/current");
  assert.deepEqual(read.data, captured);
  assert.equal((await f.send("POST", "/pages/logical-page-1/lease", { sessionEpoch: 5 })).code, 46800);
  assert.equal(f.platform.commits, 0);
});

test("lost resume response is committed, readback is null, and explicit same-pause retry returns the captured released receipt", async () => {
  const f = fixture(), held = f.platform.holdWrites();
  f.platform.dropNextResume();
  const route = `/editing-session/5/write-pauses/${held.pauseId}`;
  const first = await f.send("DELETE", route);
  assert.equal(first.status, 503); assert.equal(first.data, undefined);
  assert.equal((await f.send("GET", "/editing-session/5/write-pauses/current")).data, null);
  const retry = await f.send("DELETE", route);
  assert.equal(retry.code, 200); assert.deepEqual(retry.data, { ...held, state: "released" });
  assert.deepEqual(f.platform.events.filter(event => event.type === "resume").map(event => event.pauseId), [held.pauseId, held.pauseId]);
  assert.equal((await f.send("POST", "/pages/logical-page-2/lease", { sessionEpoch: 5 })).code, 200);
  assert.equal(f.platform.commits, 0);
});

test("fixture does not implement a new pause POST or accept a foreign session/pause recovery route", async () => {
  const f = fixture(), held = f.platform.holdWrites();
  for (const [method, route] of [["POST", "/editing-session/5/write-pauses"],
    ["GET", "/editing-session/6/write-pauses/current"], ["DELETE", `/editing-session/6/write-pauses/${held.pauseId}`],
    ["DELETE", "/editing-session/5/write-pauses/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]]) {
    assert.equal((await f.send(method, route)).handled, false);
  }
});
