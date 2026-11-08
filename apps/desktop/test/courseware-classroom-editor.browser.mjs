import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const requireRuntime = createRequire(path.join(root, 'packages/courseware-runtime/package.json'));
const { build } = requireRuntime('esbuild');
const { chromium } = requireRuntime('@playwright/test');
const output = await mkdtemp(path.join(tmpdir(), 'maic-editor-browser-'));
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5X0AAAAASUVORK5CYII=';
await build({ stdin: { contents: `import React, {useState} from 'react'; import {createRoot} from 'react-dom/client'; import {flushSync} from 'react-dom'; import {CoursewareClassroomEditor} from './src/components/workpanel/CoursewareClassroomEditor';
import i18n from 'i18next'; import {initReactI18next} from 'react-i18next'; import {zhCN} from '@pi-desktop/i18n';
import {prepareMaicAssessmentSpeech} from '@pi-desktop/courseware-runtime/player'; window.__prepareSpeech=prepareMaicAssessmentSpeech;
i18n.use(initReactI18next).init({lng:'zh-CN',initAsync:false,resources:{'zh-CN':{translation:zhCN}}});
function Fixture(){const [page,setPage]=useState(0); const [revision,setRevision]=useState(0); window.__reopen=()=>flushSync(()=>setRevision(n=>n+1)); window.__selectPage=setPage; return React.createElement(CoursewareClassroomEditor,{key:revision,sessionId:'fixture',sidebar:location.search==='?sidebar',initialPageIndex:page});} createRoot(document.getElementById('root')).render(React.createElement(Fixture));`, resolveDir: path.join(root, 'apps/desktop'), loader: 'tsx' }, bundle: true, write: true, outfile: path.join(output, 'app.js'), format: 'esm', jsx: 'automatic' });
const server = http.createServer(async (req, res) => {
  try {
    if (new URL(req.url, 'http://localhost').pathname === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html><head><link rel="stylesheet" href="app.css"></head><body><div id="root" style="height:900px"></div><script type="module" src="app.js"></script></body></html>'); return; }
    res.setHeader('content-type', req.url === '/app.css' ? 'text/css' : 'text/javascript'); res.end(await readFile(path.join(output, req.url.slice(1))));
  } catch { res.statusCode = 404; res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ image }) => {
    const now = Date.now();
    let view = { projectId: 'project', revision: '0', sourceRevision: 'source', classroom: { id: 'course', createdAt: new Date(now).toISOString(), stage: { id: 'course', name: 'Test', createdAt: now, updatedAt: now }, scenes: [
      { id: 'quiz', stageId: 'course', type: 'quiz', title: 'Image quiz', order: 1, content: { type: 'quiz', interactionMode: 'classroom_instant_feedback', questions: [{ id: 'q', type: 'single', question: 'Choose a greeting', options: [{value:'A',label:'Hello'}, {value:'B',label:'Bye'}], answer:['A'] }] }, actions: [] },
      { id: 'slide', stageId: 'course', type: 'slide', title: 'Interaction', order: 2, content: { type: 'slide', canvas: { id: 'slide', elements: [{ id:'slide_question', type:'text', content:'<p>Old question</p>' }] } }, actions: [{ id:'checkpoint', type:'interaction_checkpoint', checkpointId:'checkpoint', checkpointKind:'chapter_summary', chapterId:'chapter', chapterTitle:'Chapter', question:'Old question', referenceAnswer:{summary:'Old reference',keyPoints:[]}, context:{chapterSummary:'Context',sourceSceneIds:[]} }] },
    ] } };
    if (location.search === '?pending') view.classroom.scenes[1].metadata = {nativeTeachingSyncPending:true};
    let failImage = location.search !== '?reopen'; window.__writes = []; window.__imageRevisions = []; window.__ttsCalls = []; window.__imageCalls = [];
    window.piDesktop = { platform:'linux', invoke: async (channel, input) => {
      if (channel.endsWith('/tts/models')) { window.__ttsCalls.push('models'); return {ok:true,data:[{model:'fixture-model',voices:['fixture-voice'],providerDefaultVoice:false}]}; }
      if (channel.endsWith('/image/models')) { window.__imageCalls.push('models'); return {ok:true,data:['image-model']}; }
      if (channel.endsWith('/open')) return {ok:true,data:structuredClone(view)};
      if (input.expectedRevision !== view.revision || input.expectedSourceRevision !== view.sourceRevision) return {ok:false,error:{message:'CAS conflict'}};
      if (channel.includes('/image/')) {
        const kind=channel.split('/').at(-1); window.__imageCalls.push(kind);
        if(kind==='quote')return {ok:true,data:{key:'image',state:'quoted',quote:{quoteId:'image-quote',maxPoints:9,expiresAt:new Date(Date.now()+60000).toISOString()}}};
        if(kind==='submit'){if(input.quoteId!=='image-quote')throw Error('Image quote required');return {ok:true,data:{key:'image',state:'processing'}};}
        const q=view.classroom.scenes.find(scene=>scene.id===input.sceneId).content.questions.find(q=>q.id===input.questionId);
        q.options.find(option=>option.value===input.optionValue).image={src:image,assetId:'generated',mimeType:'image/png'};
        view.revision=String(Number(view.revision)+1);window.__currentView=structuredClone(view);
        return {ok:true,data:{key:'image',state:'adopted',view:structuredClone(view)}};
      }
      if (channel.includes('/tts/')) {
        const kind = channel.split('/').at(-1); window.__ttsCalls.push(kind);
        if (kind === 'quote') return {ok:true,data:{key:'tts',state:'quoted',quote:{quoteId:'quote',maxPoints:7,expiresAt:new Date(Date.now()+60000).toISOString()}}};
        if (kind === 'submit') {
          if(input.quoteId!=='quote') return {ok:false,error:{message:'quote required'}};
          if(window.__insufficientTts) return {ok:false,error:{message:'COURSEWARE_MEDIA_INSUFFICIENT_POINTS'}};
          return {ok:true,data:{key:'tts',state:'processing'}};
        }
        const speech=view.classroom.scenes.find(scene=>scene.id===input.sceneId).actions.find(action=>action.id===input.actionId);
        if(!speech)throw Error('Saved speech missing');
        speech.audioId='audio-'+view.revision; speech.audioUrl='asset.wav';
        view.revision=String(Number(view.revision)+1); view.classroom.audioManifest=[...(view.classroom.audioManifest??[]).filter(entry=>entry.sceneId!==input.sceneId||entry.actionId!==input.actionId),{sceneId:input.sceneId,actionId:input.actionId,assetId:speech.audioId,audioId:speech.audioId,mimeType:'audio/wav',url:'asset.wav',originalUrl:'asset.wav'}];
        window.__currentView=structuredClone(view); return {ok:true,data:{key:'tts',state:'adopted',view:structuredClone(view)}};
      }
      if (channel.endsWith('/write')) { view = {...view, revision:String(Number(view.revision)+1), classroom:window.__prepareSpeech(input.classroom)}; window.__writes.push(structuredClone(view)); if (location.search === '?reopen') window.__reopen(); }
      if (channel.endsWith('/image')) {
        window.__imageRevisions.push(input.expectedRevision);
        if (failImage) { failImage = false; return {ok:false,error:{message:'fixture image failure'}}; }
        if (input.classroom) view.classroom = structuredClone(input.classroom);
        const q = view.classroom.scenes.find(s=>s.id===input.sceneId).content.questions.find(q=>q.id===input.questionId);
        (input.optionValue ? q.options.find(o=>o.value===input.optionValue) : q).image = {src:image,assetId:'image',mimeType:'image/png'};
        view.revision=String(Number(view.revision)+1);
        if (location.search === '?reopen') window.__reopen();
      }
      if (channel.endsWith('/reference')) { view.classroom.scenes.find(s=>s.id===input.sceneId).actions.find(a=>a.id===input.actionId).referenceAnswer.summary = 'Updated reference'; view.revision=String(Number(view.revision)+1); }
      window.__currentView = structuredClone(view); return {ok:true,data:structuredClone(view)};
    } };
  }, { image });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByLabel('问题', { exact:true }).fill('Updated greeting');
  await page.waitForFunction(() => window.__writes.some(v => v.classroom.scenes[0].content.questions[0].question === 'Updated greeting'));
  await page.getByLabel('题目图片', { exact:true }).setInputFiles({ name:'one.png', mimeType:'image/png', buffer:Buffer.from(image.split(',')[1], 'base64') });
  await page.getByRole('alert').filter({hasText:'fixture image failure'}).waitFor();
  await page.getByLabel('题目图片', { exact:true }).setInputFiles({ name:'one.png', mimeType:'image/png', buffer:Buffer.from(image.split(',')[1], 'base64') });
  await page.getByRole('img', { name:'题目图片', exact:true }).waitFor();
  const revisions = await page.evaluate(() => window.__imageRevisions);
  assert.equal(revisions.length, 2); assert.equal(revisions[1], revisions[0], 'Failed atomic upload does not advance the revision');
  await page.getByRole('button', { name:'2. 互动 · Interaction', exact:true }).click();
  await page.getByLabel('问题', { exact:true }).fill('New <question>');
  await page.getByRole('button', { name:'保存课程', exact:true }).click();
  await page.waitForFunction(() => window.__currentView.classroom.scenes[1].actions.some(a=>a.question === 'New <question>'));
  const saved = await page.evaluate(() => window.__currentView);
  assert.equal(saved.classroom.scenes[1].content.canvas.elements[0].content, '<p>New &lt;question&gt;</p>');
  await page.getByRole('button', { name:'根据当前问题更新参考答案', exact:true }).click();
  await page.getByLabel('参考答案', { exact:true }).waitFor();
  await page.waitForFunction(() => document.querySelector('textarea') && window.__currentView.classroom.scenes[1].actions.some(a=>a.referenceAnswer?.summary === 'Updated reference'));
  await page.getByRole('button', { name:'1. Quiz · Image quiz', exact:true }).click();
  await page.getByLabel('题型',{exact:true}).selectOption('multiple');
  await page.getByRole('button', { name:'正确答案 A', exact:true }).click();
  await page.getByRole('button', { name:'正确答案 B', exact:true }).click();
  await page.getByRole('button', { name:'保存课程', exact:true }).click();
  await page.waitForFunction(() => window.__currentView.classroom.scenes[0].content.questions[0].answer.length === 2);
  await page.getByText('生成选项配图',{exact:true}).click();
  await page.getByLabel('配图选项',{exact:true}).selectOption('B');
  await page.getByRole('button',{name:'读取图片模型',exact:true}).click();
  await page.getByRole('button',{name:'获取配图报价',exact:true}).click();
  await page.getByText(/最高 9 积分/).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.__imageCalls),['models','quote']);
  await page.getByRole('button',{name:'确认报价并生成配图',exact:true}).click();
  await page.getByRole('button',{name:'刷新并应用配图',exact:true}).click();
  await page.waitForFunction(()=>window.__currentView.classroom.scenes[0].content.questions[0].options[1].image?.assetId==='generated');
  assert.deepEqual(await page.evaluate(()=>window.__imageCalls),['models','quote','submit','refresh']);
  page.once('dialog', dialog => dialog.accept());
  await page.getByLabel('题型',{exact:true}).selectOption('judge');
  await page.getByRole('button', { name:'正确答案 T', exact:true }).click();
  await page.getByRole('button', { name:'保存课程', exact:true }).click();
  await page.waitForFunction(() => window.__currentView.classroom.scenes[0].content.questions[0].type === 'judge');
  assert.deepEqual(await page.evaluate(() => window.__currentView.classroom.scenes[0].content.questions[0].options.map(option => option.value)), ['T','F']);
  page.once('dialog', dialog => dialog.accept());
  await page.getByLabel('题型',{exact:true}).selectOption('short_answer');
  await page.getByLabel('参考答案', {exact:true}).fill('  My exact reference  ');
  await page.getByRole('button', { name:'保存课程', exact:true }).click();
  await page.waitForFunction(() => window.__currentView.classroom.scenes[0].content.questions[0].answer[0] === '  My exact reference  ');
  assert.equal(await page.evaluate(() => window.__currentView.classroom.scenes[0].content.questions[0].hasAnswer), false);
  await page.locator('.maic-question').getByRole('button', {name:'生成语音',exact:true}).click({timeout:2500});
  await page.waitForFunction(()=>window.__currentView.classroom.audioManifest?.length===1);
  assert.deepEqual(await page.evaluate(()=>window.__ttsCalls),['models','quote','submit','refresh']);
  assert.equal(await page.locator('.maic-speech-tools').getByRole('button', {name:/报价|确认费用|刷新并应用/}).count(),0);
  assert.equal(await page.locator('.maic-speech-tools').getByText(/最高.*积分|quoted/).count(),0);
  assert(await page.locator('.maic-question').getByRole('button',{name:'重新生成语音',exact:true}).isVisible());
  await page.getByLabel('问题',{exact:true}).fill('Updated spoken question');
  await page.getByText('文字已修改，需要更新语音',{exact:true}).waitFor();
  await page.waitForFunction(()=>window.__currentView.classroom.scenes[0].actions[0].text==='Updated spoken question');
  assert.equal(await page.evaluate(()=>window.__currentView.classroom.scenes[0].actions[0].audioId),undefined);
  assert.equal(await page.evaluate(()=>window.__currentView.classroom.audioManifest.length),0);
  await page.locator('.maic-question').getByRole('button',{name:'生成语音',exact:true}).click();
  await page.waitForFunction(()=>window.__currentView.classroom.audioManifest.length===1);
  await page.goto(`http://127.0.0.1:${server.address().port}/?missing`);
  await page.locator('.maic-question').getByRole('button',{name:'生成语音',exact:true}).click();
  await page.waitForFunction(()=>window.__currentView?.classroom.audioManifest?.length===1);
  assert.equal(await page.evaluate(()=>window.__writes.length),1,'Older questions create and save their speech automatically');
  assert.deepEqual(await page.evaluate(()=>window.__ttsCalls),['models','quote','submit','refresh']);
  await page.evaluate(()=>{window.__insufficientTts=true;window.__ttsCalls=[];});
  await page.locator('.maic-question').getByRole('button',{name:'重新生成语音',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'积分不足，请充值后重试。'}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.__ttsCalls),['quote','submit']);
  assert.equal(await page.evaluate(()=>window.__currentView.classroom.audioManifest.length),1,'A failed regeneration retains the current audio');
  await page.goto(`http://127.0.0.1:${server.address().port}/?pending`);
  await page.getByText(/本页原生教学暂不能同步到 MAIC/).waitFor();
  assert.equal(await page.getByRole('button', {name:'导出 maic 课件',exact:true}).isDisabled(), true);
  assert.equal(await page.getByRole('button', {name:'播放整个课程',exact:true}).isDisabled(), true);
  await page.getByLabel('问题', {exact:true}).fill('Editing remains available');
  await page.waitForFunction(() => window.__writes.some(v => v.classroom.scenes[0].content.questions[0].question === 'Editing remains available'));
  assert.equal(await page.evaluate(() => window.__currentView.classroom.scenes[1].metadata.nativeTeachingSyncPending), true);
  await page.goto(`http://127.0.0.1:${server.address().port}/?sidebar`);
  await page.getByText('Quiz 编辑', {exact:true}).waitFor();
  assert.equal(await page.getByRole('navigation', {name:'课程场景'}).count(),0);
  assert.equal(await page.getByText('题目语音', {exact:true}).count(),1);
  await page.getByLabel('问题', {exact:true}).fill('Sidebar question');
  await page.evaluate(()=>window.__selectPage(1));
  await page.getByText('课堂互动编辑', {exact:true}).waitFor();
  await page.getByLabel('约束性提示词', {exact:true}).fill('Respond in one sentence');
  await page.waitForFunction(()=>window.__writes.some(v=>v.classroom.scenes[0].content.questions[0].question==='Sidebar question' && v.classroom.scenes[1].actions.some(a=>a.constraintPrompt==='Respond in one sentence')));
  await page.locator('.maic-question').getByRole('button',{name:'生成语音',exact:true}).click();
  await page.waitForFunction(()=>window.__currentView.classroom.audioManifest.some(entry=>entry.sceneId==='slide'));
  await page.getByLabel('问题',{exact:true}).fill('Updated interaction question');
  await page.waitForFunction(()=>window.__currentView.classroom.scenes[1].actions.some(a=>a.type==='speech'&&a.text==='Updated interaction question'&&!a.audioId));
  assert.equal(await page.evaluate(()=>window.__currentView.classroom.audioManifest.some(entry=>entry.sceneId==='slide')),false);
  await page.getByText('更多上下文设置', {exact:true}).click();
  await page.getByLabel('参考答案标签', {exact:true}).fill('Teacher reference');
  await page.waitForFunction(()=>window.__writes.some(v=>v.classroom.scenes[1].actions.some(a=>a.referenceAnswer?.label==='Teacher reference')));
  await page.evaluate(()=>window.__selectPage(0));
  await page.getByText('Quiz 编辑', {exact:true}).waitFor();
  assert.equal(await page.getByLabel('问题',{exact:true}).inputValue(),'Sidebar question');
  // A native PPT save replaces the requesting iframe. Attachment must already be committed.
  await page.goto(`http://127.0.0.1:${server.address().port}/?reopen`);
  await page.getByLabel('问题', {exact:true}).fill('Question edited immediately before upload');
  await page.getByLabel('选项 A 图片', {exact:true}).setInputFiles({ name:'option.png', mimeType:'image/png', buffer:Buffer.from(image.split(',')[1], 'base64') });
  await page.waitForFunction(() => window.__currentView?.classroom.scenes[0].content.questions[0].options[0].image, null, {timeout:5000});
  assert.equal(await page.evaluate(() => window.__currentView.classroom.scenes[0].content.questions[0].question), 'Question edited immediately before upload');
  assert.equal(await page.evaluate(() => window.__writes.length), 0, 'Upload never performs a separate pre-save that destroys its caller');
  await page.getByRole('img', {name:'选项 A 图片',exact:true}).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS real renderer: autosave, failed image retry, checkpoint synchronization, four question types, one-click TTS and insufficient-points feedback');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); await rm(output,{recursive:true,force:true}); }
