import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(path.join(root, 'packages/courseware-runtime/package.json'));
const { build } = require('esbuild');
const { chromium } = require('@playwright/test');
const output = await mkdtemp(path.join(tmpdir(), 'courseware-import-start-'));
let browser, server;
try {
  await build({ stdin: { resolveDir: path.join(root, 'apps/desktop'), loader: 'tsx', contents: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import i18next from 'i18next';import {initReactI18next} from 'react-i18next';
    import {en,zhCN} from '@pi-desktop/i18n';
    import {CoursewareWorkspaceEntry} from './src/components/courseware/CoursewareWorkspaceEntry';
    import {useAppStore} from './src/stores/app-store';
    window.language=lng=>i18next.changeLanguage(lng);
    await i18next.use(initReactI18next).init({lng:'zh-CN',fallbackLng:'en',resources:{en:{translation:en},'zh-CN':{translation:zhCN}},interpolation:{escapeValue:false}});
    function Fixture(){const id=useAppStore(s=>s.activeSessionId);const [importId,setImportId]=useState(null);
      return <><CoursewareWorkspaceEntry onImport={setImportId}/><output data-testid="import-owner">{importId}</output>
      <button onClick={()=>window.control.patch({activeSessionId:id==='chat'?'other':'chat'})}>Switch session</button></>;}
    createRoot(document.getElementById('root')).render(<Fixture/>);
  ` }, bundle: true, outfile: path.join(output, 'app.js'), format: 'esm', jsx: 'automatic',
  plugins: [{ name: 'external-boundaries', setup(builder) {
    builder.onResolve({ filter: /(?:stores\/app-store|lib\/api)$/ }, args => ({ path: args.path.endsWith('api') ? 'api' : 'store', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', resolveDir: path.join(root,'apps/desktop'), contents: args.path === 'store' ? `
      import {useSyncExternalStore} from 'react';
      const listeners=new Set();window.calls=[];window.sendMode='accept';
      let state={activeSessionId:'chat',messages:[],runningSessions:{},workPanelTabs:[],sessions:[{id:'chat',projectPath:'/workspace'},{id:'other',projectPath:'/other'}],
        openWorkPanelTab:tab=>{window.calls.push(['open',tab]);},
        sendPrompt:async(...args)=>{window.calls.push(['send',...args]);if(window.sendMode==='defer')return new Promise(resolve=>window.resolveSend=resolve);if(window.sendMode==='throw'){window.control.patch({runningSessions:{chat:true},messages:[{role:'user',content:'optimistic'}]});await new Promise(resolve=>setTimeout(resolve,10));window.control.patch({runningSessions:{},messages:[{role:'assistant',content:'Send failed'}]});throw Error('Send failed');}return window.sendMode==='accept';},
        abort:async()=>{window.calls.push(['stop']);window.control.patch({runningSessions:{}});},showToast:()=>{}};
      window.control={patch:patch=>{state={...state,...patch};listeners.forEach(fn=>fn());}};
      export const useAppStore=Object.assign(selector=>useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn);},()=>selector(state)),{getState:()=>state,setState:window.control.patch});
    ` : `
      const listeners=new Set(),auth=new Set();window.imported=false;window.readFail=false;window.pickMode='accept';
      window.saved={nativeTeaching:true,viewId:'view',pageId:'p1',pageNumber:1,project:{projectId:'project',taskType:'import',title:'小数的认识',teachingRevision:'r1',source:{sha256:'a'.repeat(64)},pages:[{pageId:'p1',actions:[]},{pageId:'p2',actions:[]}]}};
      window.emitEditor=value=>listeners.forEach(fn=>fn(value));
      window.emitAuth=()=>auth.forEach(fn=>fn());
      export const api={
        coursewareTaskGet:async id=>({task:id==='chat'?{taskType:'import',educationContext:{schoolStage:'primary',grade:'三年级',subject:'math'},...(window.imported?{importPath:'/workspace/小数的认识.pptx'}:{})}:null}),
        onPptEditorState:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},onAuthChanged:fn=>{auth.add(fn);return()=>auth.delete(fn);},
        pptEditorTeachingOpen:async id=>{window.calls.push(['read',id]);if(window.readFail)throw Error('Saved state unavailable');return structuredClone(window.saved);},
        pickFiles:async()=>window.pickMode==='defer'?new Promise(resolve=>window.resolvePick=resolve):{token:'files'},
        importFiles:async(id,token)=>{window.calls.push(['files',id,token]);return {files:[{name:'讲解词.docx',path:'/workspace/讲解词.docx',kind:'file',mimeType:'application/test',size:20}]};},
        pptEditorOpen:async path=>{window.calls.push(['editor',path]);window.emitEditor({path,status:'ready'});},
        coursewareFixedShareStatus:async()=>({intent:null}),coursewareTeamProjects:async()=>[],
        coursewareFixedCancel:async()=>{},pptEditorInspectCancel:async()=>{},
        pptEditorSnapshotCapture:async(view,revision)=>{window.calls.push(['snapshot',view,revision]);return {projectId:'project',snapshotId:'snapshot'};},
        coursewareFixedBuild:async(session,snapshot)=>{window.calls.push(['build',session,snapshot]);return {status:'ready',previewId:'preview',snapshot,buildRef:{buildId:'build'},report:{visualFidelity:'NOT_VERIFIED',diagnostics:[]}};},
        coursewareFixedPlay:async(preview,locale)=>{window.calls.push(['play',preview,locale]);},
      };
    ` }));
  } }] });
  const css=await readFile(path.join(root,'apps/desktop/src/styles/courseware-chat-workflow.css'),'utf8');
  server=http.createServer(async(req,res)=>{
    if(req.url==='/'){res.setHeader('content-type','text/html');res.end('<!doctype html><meta charset="utf-8"><style>:root{--ds-bg-primary:#fff;--ds-bg-secondary:#f6f7f8;--ds-bg-elevated-opaque:#fff;--ds-border-default:#ccd1d5;--ds-border-subtle:#ddd;--ds-text-primary:#20282c;--ds-text-muted:#59636a;--ds-accent:#147d68;--ds-error:#b22;--radius-sm:8px;--text-sm:14px;--text-md:18px}body{font-family:system-ui;margin:0}#root{max-width:700px;margin:20px auto}'+css+'</style><div id="root"></div><script type="module" src="/app.js"></script>');return;}
    if(req.url==='/app.js'){res.setHeader('content-type','text/javascript');res.end(await readFile(path.join(output,'app.js')));return;}
    res.statusCode=404;res.end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1000,height:1000}}), errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('button',{name:'Switch session'}).waitFor();
  assert.equal(await page.getByRole('region',{name:'PPT 已导入'}).count(),0);
  const editor=async(status='ready',extra={})=>page.evaluate(({status,extra})=>{window.imported=true;window.emitEditor({status,path:status==='opening'?'/workspace/小数的认识.pptx':'小数的认识.pptx',...extra});},{status,extra});
  await editor('opening');
  const card=page.getByRole('region',{name:'PPT 已导入'}),start=page.getByRole('button',{name:'开始完善课件',exact:true});
  await card.waitFor();assert(await start.isDisabled());
  await editor();await start.waitFor();await page.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).find(n=>n.textContent==='开始完善课件').disabled);
  assert.equal(await page.getByTestId('import-owner').textContent(),'chat');
  assert.equal(await card.getByRole('checkbox').count(),0);
  assert.equal(await card.getByRole('spinbutton').count(),0);
  assert.equal(await card.getByText('更多设置',{exact:true}).count(),0);
  await page.getByRole('button',{name:'添加教案或已有讲解词（可选）'}).click();
  await page.getByRole('combobox',{name:'材料类型：讲解词.docx'}).selectOption('script');
  await page.evaluate(()=>window.sendMode='throw');await start.click();await page.getByRole('alert').waitFor();
  assert(await page.getByRole('combobox',{name:'材料类型：讲解词.docx'}).isVisible());
  await page.evaluate(()=>window.sendMode='defer');
  await start.evaluate(button=>{button.click();button.click();});
  await page.waitForFunction(()=>!!window.resolveSend);
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c[0]==='send').length),2);
  const sent=await page.evaluate(()=>window.calls.filter(c=>c[0]==='send').at(-1));
  for(const requirement of [/补齐缺少的逐页讲解/,/生成缺少的真实朗读语音/,/聚光、高亮/,/添加适合教学的动画/,/推断 Quiz 和课堂互动的数量及插入位置/,/逐字保留已有讲解/,/禁止重复插入/])assert.match(sent[1],requirement);
  assert.doesNotMatch(sent[1],/新增 \d+ 页独立 Quiz|不新增教学动画|明确要求重新生成/);assert.match(sent[1],/保留原文/);
  assert.equal(sent[2].fileReferences[0].name,'讲解词.docx');assert.equal(sent[3],'chat');
  // Successful dispatch hands control to Chat; saved user history survives remounts.
  await page.evaluate(()=>{window.resolveSend(true);});
  await card.waitFor({state:'detached'});
  assert.equal(await page.getByRole('button',{name:'停止',exact:true}).count(),0);
  await page.evaluate(()=>window.control.patch({runningSessions:{chat:true},messages:[{id:'accepted',role:'user',content:'Complete this courseware'}]}));
  const readsAfterHandoff=await page.evaluate(()=>window.calls.filter(c=>c[0]==='read').length);
  await editor('saved',{revision:2});
  await page.evaluate(()=>window.control.patch({runningSessions:{}}));
  await page.getByRole('button',{name:'Switch session'}).click();
  await page.getByRole('button',{name:'Switch session'}).click();await editor('ready');
  assert.equal(await card.count(),0);
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c[0]==='read').length),readsAfterHandoff);
  await page.evaluate(()=>window.control.patch({messages:[{id:'recent-tool',role:'tool',toolName:'courseware_media_status',content:'Saved'}]}));
  await page.getByRole('button',{name:'Switch session'}).click();
  await page.getByRole('button',{name:'Switch session'}).click();await editor('ready');
  assert.equal(await card.count(),0);
  // A fresh import still offers setup and preserves all pre-start safeguards.
  await page.evaluate(()=>window.control.patch({messages:[]}));
  await card.waitFor();
  await page.evaluate(()=>window.pickMode='defer');await page.getByRole('button',{name:'添加教案或已有讲解词（可选）'}).click();
  await page.waitForFunction(()=>!!window.resolvePick);
  await page.getByRole('button',{name:'Switch session'}).click();
  await page.evaluate(()=>window.resolvePick({token:'late'}));
  await card.waitFor({state:'detached'});
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c[0]==='files').length),1);
  await page.getByRole('button',{name:'Switch session'}).click();await editor('ready');await card.waitFor();
  await page.evaluate(()=>{window.readFail=true;window.emitAuth();});
  await page.getByRole('alert').waitFor();assert(await start.isDisabled());
  await page.evaluate(()=>{window.readFail=false;window.emitAuth();});
  await page.getByRole('alert').waitFor({state:'detached'});
  await page.evaluate(()=>{window.saved.project.pages.forEach((p,i)=>p.actions=[{id:'s'+i,type:'speech',text:'价格',audioAssetId:'tts-'+'a'.repeat(64)}]);window.saved.project.teachingRevision='r3';});
  await editor('saved',{revision:3});
  await page.getByRole('button',{name:'预览与检查'}).click();
  await page.getByRole('button',{name:'构建预览',exact:true}).click();
  await page.getByRole('button',{name:'播放预览',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.calls.filter(c=>['snapshot','build','play'].includes(c[0]))),[
    ['snapshot','view','r3'],['build','chat',{projectId:'project',snapshotId:'snapshot'}],['play','preview','zh-CN'],
  ]);
  await page.getByRole('button',{name:'Switch session'}).click();
  await page.getByRole('button',{name:'Switch session'}).click();await editor('ready');await card.waitFor();
  await page.setViewportSize({width:430,height:900});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  if(process.env.IMPORT_UI_SCREENSHOT)await page.screenshot({path:process.env.IMPORT_UI_SCREENSHOT,fullPage:true});
  await page.evaluate(()=>window.language('en'));await page.getByRole('region',{name:'PPT imported'}).waitFor();
  assert.deepEqual(errors,[]);
  console.log('IMPORT_START_OK: import transition, automatic teaching requirements + attachment submission, deduplication, error recovery, handoff to Chat, reload persistence, session and account isolation, narrow layout, English/Chinese');
}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(output,{recursive:true,force:true});}
