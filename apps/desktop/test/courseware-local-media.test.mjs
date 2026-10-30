import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { loadCoursewareMedia } from "./fixtures/courseware-media-loader.mjs";
const { CoursewareMediaClient } = await loadCoursewareMedia();
const audio = Buffer.from([73,68,51,4,0,0,0,0,0,0,1,2]);
const token = n => `job${n}.` + "a".repeat(43);
const quote = kind => ({ version:"courseware-media-quote-v1", kind, model:kind, priceVersion:"test-v1",
  maxPoints:kind === "music-export" ? 0 : 2, maxChars:4000, expiresAt:"2099-01-01T00:00:00Z", quoteToken:"4070908800." + "a".repeat(43) });
const json = (data, code=200) => new Response(JSON.stringify({ code, data }), { headers:{"content-type":"application/json"} });
const ref = task => ({taskId:task.taskId,idempotencyKey:task.idempotencyKey,requestHash:task.requestHash});
function fixture() {
  const db = new Map(), calls = []; let principal = {}, state = "processing", fail=false;
  const options = { baseUrl:"https://platform.test", getPrincipal:()=>principal, resolveAccessToken:async()=>"main-only-token",
    relayJournal:async(method,key,value,revision)=>{
      const old=db.get(key);
      if(method === "read")return structuredClone(old ?? null);
      if((old?.revision ?? 0)!==revision)throw Error("COURSEWARE_MEDIA_JOURNAL_CONFLICT");
      const next={revision:revision+1,value:structuredClone(value)}; db.set(key,next); return structuredClone(next);
    },
    fetch:async(url,init)=>{
      calls.push({url,init});
      if(init.method === "POST") {
        if(fail)throw Error("connection lost");
        const {request}=JSON.parse(init.body);
        return json({kind:request.kind,receipts:request.kind === "tts" ? [] : request.kind === "music" ? [token(1),token(2)] : [token(3)],
          bytesBase64:request.kind === "tts" ? audio.toString("base64") : null,mime:request.kind === "tts" ? "audio/mpeg" : null,
          actualPoints:request.kind === "music-export" ? 0 : 1,billingReceipt:"11111111-1111-4111-8111-111111111111"});
      }
      if(url.includes("/relay/query?"))return json({success:true,taskId:"provider-1",status:state,durationSeconds:8.25});
      if(url.includes("/relay/asset?"))return new Response(audio,{headers:{"content-type":"audio/mpeg"}});
      throw Error("Server task APIs must not be called: " + url);
    }};
  return {db,calls,options,client:()=>new CoursewareMediaClient(options),setState:s=>{state=s;},fail:()=>{fail=true;},changePrincipal:()=>{principal={};}};
}
const song = {kind:"music",model:"music",input:"Hello",music:{title:"Hello Song",tags:"gentle"}};
const speech = {kind:"tts",model:"tts",input:"Hello children!",voice:"teacher"};

test("bulk local TTS uses five relay calls across clients and cancels or fences queued work before POST", async () => {
  const f = fixture(), respond = f.options.fetch;
  let open, firstFive, active = 0, peak = 0, posted = 0, current = true;
  const gate = new Promise(resolve => { open = resolve; });
  const started = new Promise(resolve => { firstFive = resolve; });
  f.options.fetch = async (url, init) => {
    active++; peak = Math.max(peak, active); posted++;
    if (posted === 5) firstFive();
    await gate;
    try { return await respond(url, init); } finally { active--; }
  };
  const jobs = Array.from({ length: 20 }, (_, i) => f.client().submitConfirmedTts(`batch-${i}`, speech, quote("tts")));
  const controller = new AbortController();
  const cancelled = f.client().submitConfirmedTts("cancelled", speech, quote("tts"), controller.signal);
  const cancellation = assert.rejects(cancelled, /WAIT_CANCELLED/);
  const stale = f.client().submitConfirmedTts("stale", speech, quote("tts"), undefined, undefined,
    () => assert(current, "context changed"));
  const refusal = assert.rejects(stale, /context changed/);
  await started;
  assert.equal(posted, 5);
  controller.abort(); current = false; open();
  await Promise.all([...jobs, cancellation, refusal]);
  assert.equal(peak, 5); assert.equal(posted, 20);
  assert.ok((await Promise.all(jobs)).every(task => task.state === "ready"));
  assert.equal(f.db.has("task:cancelled"), false);
  assert.equal(f.db.has("task:stale"), false);
});

test("queued TTS rechecks quote expiration instead of submitting an expired paid offer", async t => {
  t.mock.timers.enable({ apis: ["Date"] });
  const f = fixture(), respond = f.options.fetch;
  let open, firstFive, posted = 0;
  const gate = new Promise(resolve => { open = resolve; });
  const started = new Promise(resolve => { firstFive = resolve; });
  f.options.fetch = async (url, init) => {
    if (++posted === 5) firstFive();
    await gate;
    return respond(url, init);
  };
  const jobs = Array.from({ length: 5 }, (_, i) => f.client().submitConfirmedTts(`active-${i}`, speech, quote("tts")));
  const expires = Math.ceil(Date.now() / 1000) + 5;
  const waiting = f.client().submitConfirmedTts("expired", speech, { ...quote("tts"),
    expiresAt: new Date(expires * 1000).toISOString(), quoteToken: `${expires}.` + "a".repeat(43) });
  const refusal = assert.rejects(waiting, /QUOTE_EXPIRED/);
  await started;
  t.mock.timers.tick(6000); open();
  await Promise.all([...jobs, refusal]);
  assert.equal(posted, 5);
  assert.equal(f.db.has("task:expired"), false);
});

test("queued speech progresses after original local music receipts complete without another music POST", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(), client = f.client();
  await Promise.all(Array.from({ length: 5 }, (_, i) => client.music.submitConfirmed(`song-${i}`, song, quote("music"))));
  const speechTask = client.submitConfirmedTts("speech", speech, quote("tts"));
  assert.equal(f.calls.filter(call => call.init.method === "POST").length, 5);
  f.setState("completed");
  t.mock.timers.tick(3000);
  assert.equal((await speechTask).state, "ready");
  assert.equal(f.calls.filter(call => call.init.method === "POST").length, 6);
  assert.equal(f.calls.filter(call => call.url.includes("/relay/query?")).length, 10);
});

test("TTS audio and receipt survive a client restart with no Platform task/asset lookup",async()=>{
  const f=fixture(), first=f.client();
  const task=await first.submitConfirmedTts("tts-1",speech,quote("tts"));
  assert.equal(task.state,"ready"); assert.equal(task.actualPoints,1);
  assert.ok(f.db.get("task:tts-1").value.bytesBase64);
  const restarted=f.client();
  assert.deepEqual(await restarted.findTts({idempotencyKey:task.idempotencyKey,requestHash:task.requestHash}),task);
  assert.deepEqual((await restarted.download(ref(task))).bytes,audio);
  assert.deepEqual(await restarted.submitConfirmedTts("tts-1",speech,quote("tts")),task);
  assert.equal(f.calls.length,1); assert.ok(f.calls[0].url.endsWith("/courseware/media/relay"));
  assert.equal(f.calls[0].init.headers.get("Authorization"),"Bearer main-only-token");
});
test("Desktop polls music, stores candidates, explicitly exports for zero points and downloads locally",async()=>{
  const f=fixture(), task=await f.client().music.submitConfirmed("music-1",song,quote("music"));
  assert.equal(task.state,"submitted");
  let collection=await f.client().music.candidates(ref(task));
  assert.equal(collection.task.state,"submitted"); assert.equal(collection.candidates.length,2);
  f.setState("completed");
  collection=await f.client().music.candidates(ref(task));
  assert.equal(collection.task.state,"ready"); assert.ok(collection.candidates.every(v=>v.exportable && v.durationMs===8250));
  const candidate=collection.candidates[0];
  const before=f.calls.filter(v=>v.init.method === "POST").length;
  assert.deepEqual((await f.client().music.preview(ref(task),candidate.candidateId)).bytes,audio);
  assert.equal(f.calls.filter(v=>v.init.method === "POST").length,before);
  const exportTask=await f.client().music.submitConfirmed("export-1",{kind:"music-export",model:"music-export",input:candidate.candidateId},quote("music-export"));
  const body=JSON.parse(f.calls.find(v=>v.init.method === "POST" && JSON.parse(v.init.body).request.kind === "music-export").init.body);
  assert.equal(body.sourceReceipt,token(1));
  assert.equal(exportTask.actualPoints,0);
  const output=await f.client().music.downloadExport(ref(exportTask));
  assert.equal(output.task.state,"ready"); assert.deepEqual(output.bytes,audio);
  const count=f.calls.length;
  assert.deepEqual((await f.client().music.downloadExport(ref(exportTask))).bytes,audio);
  assert.equal(f.calls.length,count); assert.equal(f.calls.filter(v=>v.init.method === "POST").length,2);
});
test("lost receipt stays unknown across restart and never sends a second POST",async()=>{
  const f=fixture();f.fail();
  await assert.rejects(f.client().music.submitConfirmed("lost",song,quote("music")),/TRANSPORT_FAILED/);
  const recovered=await f.client().music.submitConfirmed("lost",song,quote("music"));
  assert.equal(recovered.state,"submission_unknown");
  assert.equal((await f.client().music.get(ref(recovered),"music")).state,"submission_unknown");
  assert.equal(f.calls.length,1);
  await assert.rejects(f.client().music.submitConfirmed("lost",{...song,input:"different"},quote("music")),/INVALID_RESPONSE/);
});
test("concurrent submit claims one local journal entry before touching the supplier",async()=>{
  const f=fixture();
  const results=await Promise.allSettled([f.client().submitConfirmedTts("race",speech,quote("tts")),f.client().submitConfirmedTts("race",speech,quote("tts"))]);
  assert.ok(results.some(v=>v.status === "fulfilled"));
  assert.equal(f.calls.filter(v=>v.init.method === "POST").length,1);
});
test("missing local persistence and foreign export candidates cannot fall back to Platform tasks",async()=>{
  const f=fixture();
  await assert.rejects(f.client().music.submitConfirmed("bad-export",{kind:"music-export",model:"music-export",input:"11111111-1111-4111-8111-111111111111"},quote("music-export")),/INVALID_CANDIDATE/);
  const c=new CoursewareMediaClient({...f.options,relayJournal:async()=>{throw Error("JOURNAL_UNAVAILABLE");}});
  await assert.rejects(c.submitConfirmedTts("tts",speech,quote("tts")),/JOURNAL_UNAVAILABLE/);
  assert.equal(f.calls.length,0);
});
test("corrupt audio and supplier metadata are rejected at the local archive boundary",async()=>{
  const f=fixture(), task=await f.client().submitConfirmedTts("tts",speech,quote("tts"));
  f.db.get("task:tts").value.bytesBase64=Buffer.from("bad").toString("base64");
  await assert.rejects(f.client().download(ref(task)),/INTEGRITY/);
  const g=fixture(), mt=await g.client().music.submitConfirmed("music",song,quote("music"));
  const original=g.options.fetch;g.options.fetch=async(url,init)=>url.includes("/query?") ? json({success:true,taskId:"x",status:"completed",durationSeconds:-1}):original(url,init);
  await assert.rejects(g.client().music.get(ref(mt),"music"),/INVALID_RESPONSE/);
});

test("a definite preflight refusal is saved locally and cannot be mistaken for a running supplier job",async()=>{
  const f=fixture();f.options.fetch=async()=>json(null,46014);
  await assert.rejects(f.client().submitConfirmedTts("refused",speech,quote("tts")),/PLATFORM_46014/);
  const saved=f.db.get("task:refused").value.task;
  assert.equal(saved.state,"failed");assert.equal(saved.feeState,"released");assert.equal(saved.errorCode,"PLATFORM_46014");
  assert.deepEqual(await f.client().get(ref(saved)),saved);
});
