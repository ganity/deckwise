import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require=createRequire(import.meta.url);
const source=await readFile(new URL("../electron/main/courseware-asset-locks.ts",import.meta.url),"utf8");
function fixture(){
  let active=true,record=null,revision=0,readCount=0,eligible=true;
  const calls=[];
  const proof={sourceShapeId:"7",assetSha256:"b".repeat(64),pictureSha256:"c".repeat(64),zIndex:0};
  const identity={sessionId:"chat",projectId:"host-project",pageId:"host-page",expectedSourceRevision:"r1",expectedTeachingRevision:"t1"};
  const project={source:{sha256:"a".repeat(64)},pages:[{pageId:"host-page"},{pageId:"peer"}]};
  const host={async call(method,params){
    calls.push([method,structuredClone(params)]);
    if(method==="courseware.assetLocks.set"){
      assert.deepEqual(Object.fromEntries(Object.entries(params).filter(([key])=>Object.hasOwn(identity,key))),identity);
      assert.equal(params.expectedLockRevision,record?.revision??null);
      record={revision:`lock-${++revision}`,images:params.locked?[{pageId:"host-page",objectId:"image",sourceSha256:project.source.sha256,mappingRevision:"map1",image:params.proof}]:[]};
    }
    return {projectId:identity.projectId,pageId:identity.pageId,sourceSha256:project.source.sha256,mappingRevision:"map1",mapping:{},
      objects:[{logicalId:"image",type:"image",sourceShapeId:"7"},{logicalId:"text",type:"text",sourceShapeId:"8"}],locks:structuredClone(record)};
  }};
  const owner={...identity,host,project,sourcePath:"/private/saved.pptx",async assertCurrent(){if(!active)throw new Error("PPTX or current page changed");}};
  const teaching={async assetLockContext(params){assert.deepEqual(params,{viewId:"view",expectedTeachingRevision:"t1"});await owner.assertCurrent();return owner;}};
  const imports={
    "./courseware-candidate-source":{async readCandidateSource(path,hash){assert.equal(path,owner.sourcePath);assert.equal(hash,project.source.sha256);readCount++;return Buffer.from("private bytes");}},
    "./courseware-runtime":{coursewareAuthoringUrl:()=>"fixture-authoring"},
    "@pi-desktop/agent-runtime":{async resolvePageFadeTarget(){return {slidePart:"ppt/slides/slide1.xml"};}},
    "fixture-authoring":{async inspectPageImageAssets(bytes,part){assert.equal(bytes.toString(),"private bytes");assert.equal(part,"ppt/slides/slide1.xml");return [{...proof,eligible,...(eligible?{}:{reason:"cropped image unsupported"})}];}},
  };
  const exports={};new Function("require","exports",ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText)(id=>imports[id]??require(id),exports);
  const coordinator=new exports.CoursewareAssetLockCoordinator(teaching);
  const view={viewId:"view",expectedTeachingRevision:"t1"};
  return {coordinator,view,proof,calls,project,owner,readCount:()=>readCount,hide:()=>{active=false;},unsupported:()=>{eligible=false;},record:value=>{record=value;}};
}

test("image lock read/set derives exact saved bytes and Host identity, and unlock uses lock CAS",async()=>{
  const f=fixture(),initial=await f.coordinator.read(f.view);
  assert.deepEqual(initial.objects,[{objectId:"image",index:1,eligible:true,locked:false,assetSha256:f.proof.assetSha256}]);
  assert(!JSON.stringify(initial).includes("/private/"));assert(!JSON.stringify(initial).includes("sourceShapeId"));
  const locked=await f.coordinator.set({...f.view,expectedLockRevision:null,objectId:"image",locked:true});
  assert.equal(locked.objects[0].locked,true);
  const mutation=f.calls.find(([method])=>method==="courseware.assetLocks.set")[1];assert.deepEqual(mutation.proof,f.proof);assert.equal(mutation.sessionId,"chat");
  await assert.rejects(f.coordinator.set({...f.view,expectedLockRevision:null,objectId:"image",locked:false}),/changed/);
  const unlocked=await f.coordinator.set({...f.view,expectedLockRevision:locked.revision,objectId:"image",locked:false});assert.equal(unlocked.objects[0].locked,false);
});

test("renderer cannot forge paths, UUID proofs, page/session identity, unknown fields or unsupported images",async()=>{
  for(const request of [{...fixture().view,path:"/forged"},{viewId:"view",expectedTeachingRevision:"t1",sessionId:"other"},null,[],{}]){
    const f=fixture();await assert.rejects(f.coordinator.read(request));assert.equal(f.calls.length,0);
  }
  for(const patch of [{objectId:"text"},{objectId:"peer-image"},{locked:"true"},{proof:{assetSha256:"0".repeat(64)}},{pageId:"peer"},{expectedLockRevision:0}]){
    const f=fixture();await assert.rejects(f.coordinator.set({...f.view,expectedLockRevision:null,objectId:"image",locked:true,...patch}));
    assert(!f.calls.some(([method])=>method==="courseware.assetLocks.set"));
  }
  const f=fixture();f.unsupported();const view=await f.coordinator.read(f.view);assert.equal(view.objects[0].eligible,false);
  await assert.rejects(f.coordinator.set({...f.view,expectedLockRevision:null,objectId:"image",locked:true}),/cropped/);
});

test("owner/source invalidation refuses mutation and only current-page or orphan stale locks are projected",async()=>{
  const f=fixture();f.hide();await assert.rejects(f.coordinator.read(f.view),/changed/);assert.equal(f.readCount(),0);
  const g=fixture();g.record({revision:"stale",images:["host-page","peer","deleted"].map((pageId,index)=>({pageId,objectId:`old-${index}`,sourceSha256:"d".repeat(64),mappingRevision:"old",image:g.proof}))});
  const view=await g.coordinator.read(g.view);assert.deepEqual(view.staleLocks.map(lock=>lock.objectId),["old-0","old-2"]);
  await assert.rejects(g.coordinator.set({...g.view,expectedLockRevision:"stale",objectId:"old-1",locked:false}),/not in the current view/);
  assert(!g.calls.some(([method])=>method==="courseware.assetLocks.set"));
  const h=fixture(),call=h.owner.host.call;h.owner.host.call=async(...args)=>{const result=await call(...args);h.hide();return result;};
  await assert.rejects(h.coordinator.set({...h.view,expectedLockRevision:null,objectId:"image",locked:true}),/changed/);
  assert(!h.calls.some(([method])=>method==="courseware.assetLocks.set"));
});
