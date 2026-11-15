import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import * as shared from '../../../packages/shared/dist/index.js';
const e=fileURLToPath(new URL('../../../',import.meta.url));
const require=createRequire(import.meta.url);
const ts=require('typescript');
function load(file,mocks){const exports={};let s=readFileSync(join(e,'apps/desktop/electron/main',file),'utf8');
 s=s.replace('await import(/* @vite-ignore */ authoring)','await __authoring()');
 const {outputText}=ts.transpileModule(s,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}});
 new Function('require','exports','__authoring',outputText)((id)=>{if(id==='@pi-desktop/shared')return shared;if(id in mocks)return mocks[id];throw new Error(id);},exports,mocks.authoring);return exports;}
function setup(){
 const binding={projectId:'workspace',documentId:'document',sessionId:'native'};
 const context={...binding,editGeneration:1,kind:'slide',page:1,selectedText:'',selectionCharacters:0,readOnly:false,capabilities:[{name:'get_presentation_text',description:'read',readOnly:true,inputSchema:{}}]};
 const project=structuredClone(JSON.parse(readFileSync(join(e,'packages/shared/src/courseware-contract.fixtures/accepted.json'))).project);
 project.source.sha256='a'.repeat(64);project.pages[0].locked=false;
 const canonical={project,mapping:{revision:'map',sourceSha256:project.source.sha256,pages:[]}};
 const snapshot={...binding,path:'/workspace/source.pptx',revision:1,sha256:project.source.sha256};
 let mode='agent',projectPath='/workspace';
 let active=true,inspectFail=false,reviewFail=false,failCleanup=false,dispatchFail=false,hooks={},inspections=0;
 const calls=[],sent=[];
 const native=()=>structuredClone(context);
 const host={async call(method){calls.push(method);await hooks[method]?.();if(method==='session.get')return {session:{mode,projectPath}};if(method==='courseware.project.openSaved')return {project:structuredClone(project)};if(method==='courseware.project.context')return {mapping:structuredClone(canonical.mapping),project:structuredClone(canonical.project)};if(method==='courseware.pageText')return {text:'Current text'};throw new Error(method);}};
 const teaching={async withSaved(session,operation){await hooks.withSaved?.();const result=await operation(host,'job',structuredClone(snapshot),native(),session);if(failCleanup)throw new Error('cleanup failed');return result;},async assertCurrent(){await hooks.assertCurrent?.();if(context.editGeneration!==1||context.page!==1||context.readOnly||snapshot.sha256!==project.source.sha256)throw new Error('native or source changed');}};
 const proof={editGeneration:1,page:1,sourceHash:'sha256:'+project.source.sha256,slideHash:'sha256:'+'b'.repeat(64)};
 const authoring=async()=>({async inspectPageFadeSource(input){inspections++;await input.getCurrentBaseline();await hooks.inspect?.();await input.getCurrentBaseline();if(inspectFail)throw new Error('unsupported sound');return {target:{...input.target,pageNumber:1},baseline:input.baseline,slideHash:proof.slideHash};}});
 const editor={async getContext(){return native();},async reviewFade(p){sent.push(['review',structuredClone(p)]);await hooks.review?.();if(reviewFail)throw new Error('review refused');return {...native(),capabilities:[...native().capabilities,{name:'set_slide_fade',description:'fade',readOnly:false,inputSchema:{type:'object',properties:{},additionalProperties:false}}]};},async executeFade(command,authorization,workspace,check,can,signal){await hooks.execute?.();await check();signal.throwIfAborted();assert(can());sent.push(['execute',structuredClone(command),structuredClone(authorization)]);if(dispatchFail)throw new Error('uncertain');context.editGeneration++;editor.invalidateFade?.();return {...command,status:'verified',result:{page:1,transition:'fade',durationMs:750,verified:true,saved:false}};}};
 const {CoursewareNativeFadeCoordinator}=load('courseware-native-fade.ts',{'@pi-desktop/agent-runtime':{candidateHash:()=> 'sha256:'+'c'.repeat(64),resolvePageFadeTarget:async(_,mapping,pageId)=>({pageId,slidePart:'ppt/slides/slide7.xml'})},'./courseware-candidate-source':{readCandidateSource:async()=>Buffer.from('source')},'./courseware-runtime':{coursewareAuthoringUrl:()=> 'file:///fixture.mjs'},authoring});
 const coordinator=new CoursewareNativeFadeCoordinator(teaching,editor,async()=>'/workspace');
 const command={...binding,requestId:'once',editGeneration:1,tool:'set_slide_fade',input:{}};
 return {coordinator,command,context,canonical,project,proof,calls,sent,hooks,editor,
 can:()=>active,read:()=>coordinator.context('chat',native(),()=>active),execute:(c=command)=>coordinator.execute('chat',c,()=>active),
 change(key){if(key==='mode')mode='plan';if(key==='workspace')projectPath='/foreign';if(key==='cancel')active=false;if(key==='inspect')inspectFail=true;if(key==='review')reviewFail=true;if(key==='cleanup')failCleanup=true;if(key==='uncertain')dispatchFail=true;},get inspections(){return inspections;}};
}
test('retains actual inspection privately, consumes once and routes fixed proof',async()=>{const f=setup();const c=await f.read();assert(c.capabilities.some(v=>v.name==='set_slide_fade'));assert(!JSON.stringify(c).includes('slideHash'));const r=await f.execute();assert.equal(r.result.saved,false);assert.deepEqual(f.sent[1][2],f.proof);await assert.rejects(f.execute(),/fresh/);assert.equal(f.sent.filter(v=>v[0]==='execute').length,1);assert(f.calls.every(v=>!v.includes('Candidate')));});
for(const change of ['inspect','review','cleanup'])test('withholds fade on '+change+' failure and refuses execution',async()=>{const f=setup();f.change(change);const c=await f.read();assert(!c.capabilities.some(v=>v.name==='set_slide_fade'));await assert.rejects(f.execute());assert.equal(f.sent.filter(v=>v[0]==='execute').length,0);});
for(const change of ['locked','teaching','mapping','source','page','generation','readonly','cancel','clear'])test('rechecks '+change+' after context and before dispatch',async()=>{const f=setup();await f.read();if(change==='locked')f.project.pages[0].locked=true;if(change==='teaching')f.project.teachingRevision='late';if(change==='mapping')f.canonical.mapping.revision='late';if(change==='source')f.project.source.sha256='d'.repeat(64);if(change==='page')f.context.page=2;if(change==='generation')f.context.editGeneration++;if(change==='readonly')f.context.readOnly=true;if(change==='cancel')f.change('cancel');if(change==='clear')f.coordinator.clear();await assert.rejects(f.execute());assert.equal(f.sent.filter(v=>v[0]==='execute').length,0);});
for(const phase of ['inspect','review','execute'])test('cancellation during '+phase+' has no native side effect',async()=>{const f=setup();if(phase==='execute'){await f.read();f.hooks.execute=async()=>f.change('cancel');await assert.rejects(f.execute());}else{f.hooks[phase]=async()=>f.change('cancel');await assert.rejects(f.read());}assert.equal(f.sent.filter(v=>v[0]==='execute').length,0);});
test('uncertain dispatch is consumed without automatic retry',async()=>{const f=setup();await f.read();f.change('uncertain');await assert.rejects(f.execute(),/uncertain/);await assert.rejects(f.execute(),/fresh/);assert.equal(f.sent.filter(v=>v[0]==='execute').length,1);});
test('pins command before asynchronous revalidation',async()=>{const f=setup();await f.read();const c=structuredClone(f.command);f.hooks.assertCurrent=async()=>{c.input={arbitrary:true};c.requestId='mutated';};await f.execute(c);assert.equal(f.sent[1][1].requestId,'once');assert.deepEqual(f.sent[1][1].input,{});});
for(const change of ['binding','generation','input','tool','session'])test('rejects forged command '+change,async()=>{const f=setup();await f.read();const c=structuredClone(f.command);if(change==='binding')c.documentId='foreign';if(change==='generation')c.editGeneration=2;if(change==='input')c.input={sourceHash:'forged'};if(change==='tool')c.tool='add_slide_text';if(change==='session'){await assert.rejects(f.coordinator.execute('foreign-chat',c,f.can));}else await assert.rejects(f.execute(c));assert.equal(f.sent.filter(v=>v[0]==='execute').length,0);});
test('latest readonly context withholds fade without parsing',async()=>{const f=setup();f.context.readOnly=true;assert(!(await f.read()).capabilities.some(v=>v.name==='set_slide_fade'));assert.equal(f.inspections,0);});

for(const change of ['mode','workspace'])test('rechecks persisted session '+change+' after permission',async()=>{const f=setup();await f.read();f.change(change);await assert.rejects(f.execute(),/mode or persisted workspace/);assert.equal(f.sent.filter(v=>v[0]==='execute').length,0);});
