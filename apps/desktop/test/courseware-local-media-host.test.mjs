import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Host } from "../../../scripts/e2e/host.mjs";
import { loadCoursewareMedia } from "./fixtures/courseware-media-loader.mjs";
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
