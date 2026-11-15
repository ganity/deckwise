import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Host } from "../../../scripts/e2e/host.mjs";
import { loadCoursewareMedia } from "./fixtures/courseware-media-loader.mjs";
import { createServer } from "node:http";
import { once } from "node:events";
const { CoursewareMediaClient } = await loadCoursewareMedia();

test("actual Host SQLite journal survives Host restart, rejects stale writes and isolates principals", {
  skip: !process.env.DECKWISE_E2E_LOCAL_MEDIA_HOST, timeout:90_000,
}, async()=>{
  const data=await mkdtemp(join(tmpdir(),"deckwise-local-media-"));
  await mkdir(join(data,"plugins/market"),{recursive:true});
  await writeFile(join(data,"plugins/market/catalog.json"),JSON.stringify({schemaVersion:2,providerId:"official",plugins:[]}));
  let host=new Host(process.env.DECKWISE_E2E_LOCAL_MEDIA_HOST,data);
  const principalKey="a".repeat(64), principal={}, audio=Buffer.from([73,68,51,4,0,0,0,0,0,0,1,2]);
  let posts=0;
  const client=()=>new CoursewareMediaClient({baseUrl:"https://platform.test",getPrincipal:()=>principal,resolveAccessToken:async()=>"test-token",
    relayJournal:(method,key,value,expectedRevision)=>host.call(`courseware.mediaRelay.${method}`,{principalKey,key,...(method === "write" ? {value,expectedRevision}:{})}),
    fetch:async(url,init)=>{
      assert.equal(new URL(url).pathname,"/courseware/media/relay");assert.equal(init.method,"POST");posts++;
      return new Response(JSON.stringify({code:200,data:{kind:"tts",receipts:[],bytesBase64:audio.toString("base64"),mime:"audio/mpeg",actualPoints:1,billingReceipt:"11111111-1111-4111-8111-111111111111"}}),{headers:{"content-type":"application/json"}});
    }});
  const quote={version:"courseware-media-quote-v1",kind:"tts",model:"tts",priceVersion:"test-v1",maxPoints:2,maxChars:4000,expiresAt:"2099-01-01T00:00:00Z",quoteToken:"4070908800."+"a".repeat(43)};
  try {
    await host.start();
    const task=await client().submitConfirmedTts("speech",{kind:"tts",model:"tts",input:"Hello",voice:"teacher"},quote);
    await host.stop();host=new Host(process.env.DECKWISE_E2E_LOCAL_MEDIA_HOST,data);await host.start();
    assert.deepEqual(await client().findTts({idempotencyKey:task.idempotencyKey,requestHash:task.requestHash}),task);
    assert.deepEqual((await client().download({taskId:task.taskId,idempotencyKey:task.idempotencyKey,requestHash:task.requestHash})).bytes,audio);
    assert.equal(posts,1);
    const saved=await host.call("courseware.mediaRelay.read",{principalKey,key:"task:speech"});assert.equal(saved.revision,2);
    assert.equal(await host.call("courseware.mediaRelay.read",{principalKey:"b".repeat(64),key:"task:speech"}),null);
    await assert.rejects(host.call("courseware.mediaRelay.write",{principalKey,key:"task:speech",expectedRevision:0,value:saved.value}),/changed/);
    await assert.rejects(host.call("courseware.mediaRelay.read",{principalKey,key:"../../auth"}),/Invalid/);
  } finally {await host.stop();await rm(data,{recursive:true,force:true});}
});

test("local layer fallback recovers a lost HTTP receipt from actual Host SQLite after restart", {
  skip: !process.env.DECKWISE_E2E_LOCAL_MEDIA_HOST, timeout: 90_000,
}, async () => {
  const data = await mkdtemp(join(tmpdir(), "deckwise-magic-layers-host-"));
  await mkdir(join(data, "plugins/market"), { recursive: true });
  await writeFile(join(data, "plugins/market/catalog.json"), JSON.stringify({ schemaVersion: 2, providerId: "official", plugins: [] }));
  let host = new Host(process.env.DECKWISE_E2E_LOCAL_MEDIA_HOST, data);
  let accepted = false, posts = 0, plans = 0;
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer user-token");
    if (request.method === "POST") {
      posts++;
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      assert(body.includes('name="image"')); assert(body.includes('"repairPolicy":"extract_only"'));
      accepted = true;
      response.destroy();
      return;
    }
    if (!accepted) { response.writeHead(404, { "content-type": "application/json" }); response.end('{"detail":"not found"}'); return; }
    if (request.url.endsWith("/result")) { response.writeHead(200, { "content-type": "application/zip" }); response.end("PK-local-result"); return; }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "a".repeat(32), status: "succeeded", error: null }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const principal = {}, principalKey = "a".repeat(64), baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const client = () => new CoursewareMediaClient({ baseUrl, imageBaseUrl: baseUrl,
    getPrincipal: () => principal, resolveAccessToken: async () => "user-token", fetch,
    relayJournal: (method, key, value, expectedRevision) => host.call(`courseware.mediaRelay.${method}`, {
      principalKey, key, ...(method === "write" ? { value, expectedRevision } : {}),
    }) });
  const input = { key: "00000000-0000-4000-8000-000000000001", requestHash: "b".repeat(64), sourceSha256: "c".repeat(64),
    image: Buffer.from("selected-source-png"), check: async () => {}, signal: new AbortController().signal,
    plan: async () => { plans++; return { pipelineRevision: 2, repairPolicy: "extract_only", failurePolicy: "best_effort", generateCleanPlate: true,
      objects: [{ id: "object-1", role: "Animal", bbox: [0, 0, 8, 8], zIndex: 1, positivePoints: [[2, 2]] }] }; } };
  try {
    await host.start();
    await assert.rejects(client().magicLayers.split(input), /TRANSPORT_FAILED/);
    await host.stop(); host = new Host(process.env.DECKWISE_E2E_LOCAL_MEDIA_HOST, data); await host.start();
    const recovered = await client().magicLayers.split(input);
    assert.equal(recovered.bytes.toString(), "PK-local-result");
    assert.equal(posts, 1); assert.equal(plans, 1);
    const saved = await host.call("courseware.mediaRelay.read", { principalKey, key: `candidate:magiclayers:${input.key}` });
    assert.equal(saved.value.sourceSha256, input.sourceSha256);
    assert.equal(saved.value.manifest.pipelineRevision, 2);
    assert.equal(await host.call("courseware.mediaRelay.read", { principalKey: "d".repeat(64), key: `candidate:magiclayers:${input.key}` }), null);
  } finally {
    await host.stop();
    await new Promise(resolve => server.close(resolve));
    await rm(data, { recursive: true, force: true });
  }
});
