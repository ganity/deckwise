import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp,readFile,writeFile } from 'node:fs/promises';
import { dirname,join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const cloud=resolve(process.env.MAIC_CLOUD_WEB_ROOT || join(root,'../../../../cloud-web-trainwise'));
const runtimeRequire=createRequire(join(root,'package.json'));
const desktopRequire=createRequire(join(root,'../../apps/desktop/package.json'));
const cloudRequire=createRequire(join(cloud,'package.json'));
const {build}=runtimeRequire('esbuild');const {chromium,expect}=runtimeRequire('@playwright/test');
const out=await mkdtemp(join(tmpdir(),'maic-assessment-reference-'));
const authority=await readFile(join(cloud,'components/scene-renderers/quiz-view.tsx'),'utf8');
const translations=await readFile(join(cloud,'lib/i18n/stage.ts'),'utf8');
const labels=Object.fromEntries([...translations.split('  quiz: {')[1].split('\n  },')[0].matchAll(/    (\w+): '([^']*)'/g)].map(match=>[match[1],match[2]]));
const aliases=new Map([...authority.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)].filter(match=>match[2].startsWith('@/')).map(match=>[match[2],match[1].split(',').map(name=>name.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]).filter(Boolean)]));
const questions=[{id:'single',type:'single',question:'Choose a greeting',options:[{value:'A',label:'Hello'},{value:'B',label:'Bye'}],answer:['A'],points:2},{id:'multi',type:'multiple',question:'Pick two',options:[{value:'A',label:'One'},{value:'B',label:'Two'},{value:'C',label:'Three'}],answer:['A','B'],points:3},{id:'short',type:'short_answer',question:'Introduce yourself',answer:['My name is Pandy.'],hasAnswer:false,points:9}];
await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {SingleChoiceQuestion,MultipleChoiceQuestion,ShortAnswerQuestion,ScoreBanner,ClassroomInstantSingleQuestionView} from 'reference-authority';import {MaicAssessmentQuiz} from '${join(root,'src/player/components/courseware/MaicAssessmentQuiz.tsx')}';
import {MaicInstantQuizCard} from '${join(root,'src/player/components/courseware/MaicInstantQuizCard.tsx')}';
const root=createRoot(document.getElementById('root'));const questions=${JSON.stringify(questions)};
window.render=(which,kind='assessment',disabled=false)=>{document.getElementById('css').href='/'+which+'.css';document.getElementById('host').disabled=which!=='runtime';document.getElementById('root').className=which==='runtime'?'maic-editor':'';root.render(kind==='instant'?<section data-maic-quiz-card style={{height:'100%'}}>{which==='runtime'?<MaicInstantQuizCard key={which+disabled} question={questions[0]} disabled={disabled} onAnswer={()=>{}}/>:<ClassroomInstantSingleQuestionView key={which+disabled} questions={[questions[0]]} sceneId="reference"/>}</section>:which==='runtime'?<MaicAssessmentQuiz key={which+disabled} questions={questions} disabled={disabled}/>:<section data-maic-quiz-card><div className="px-6 py-4 space-y-4">{questions.map((q,i)=>{const C=q.type==='single'?SingleChoiceQuestion:q.type==='multiple'?MultipleChoiceQuestion:ShortAnswerQuestion;return <C key={q.id} question={q} index={i} disabled={disabled} onChange={()=>{}}/>})}</div></section>)};
window.render('reference');`,loader:'tsx',resolveDir:cloud},bundle:true,format:'esm',jsx:'automatic',outfile:join(out,'app.js'),plugins:[{name:'reference-view-boundaries',setup(builder){
  builder.onResolve({filter:/^reference-authority$/},()=>({path:join(cloud,'components/scene-renderers/quiz-view.tsx'),namespace:'authority'}));
  builder.onLoad({filter:/.*/,namespace:'authority'},()=>({contents:authority+'\nexport {SingleChoiceQuestion,MultipleChoiceQuestion,ShortAnswerQuestion,ScoreBanner,ClassroomInstantSingleQuestionView};',loader:'tsx',resolveDir:cloud}));
  builder.onResolve({filter:/^react(?:-dom)?(?:\/.*)?$/},args=>({path:desktopRequire.resolve(args.path)}));
  builder.onResolve({filter:/^@\//},args=>({path:args.path,namespace:'boundary'}));
  builder.onLoad({filter:/.*/,namespace:'boundary'},args=>({contents:(aliases.get(args.path)||[]).map(name=>name==='useI18n'?`export const useI18n=()=>({locale:'zh-CN',t:key=>(${JSON.stringify(labels)})[key.replace('quiz.','')]??key});`:name==='cn'?`export const cn=(...a)=>a.filter(Boolean).join(' ');`:name==='useDraftCache'?`export const useDraftCache=()=>({clearCache(){}});`:name==='SpeechButton'?`export const SpeechButton=()=>null;`:name==='createLogger'?`export const createLogger=()=>({warn(){},error(){},info(){}});`:`export const ${name}=()=>{throw Error('Unexpected reference service: ${name}')};`).join('\n'),loader:'js'}));
}}]});
const {compile}=cloudRequire('@tailwindcss/node');const postcss=cloudRequire('postcss');
const globals=await readFile(join(cloud,'app/globals.css'),'utf8');
const darkVariant=globals.match(/@custom-variant dark\s+[^;]+;/)?.[0];assert(darkVariant,'Actual reference dark variant missing');
const compiler=await compile(`@import "tailwindcss";\n${darkVariant}`,{base:cloud,onDependency(){}});
const css=postcss.parse(compiler.build([...authority.matchAll(/["'`]([^"'`\n]+)["'`]/g)].flatMap(match=>match[1].split(/\s+/))));
css.walkRules(rule=>{if(rule.parent.type==='atrule' && /keyframes/.test(rule.parent.name))return;for(let ancestor=rule.parent;ancestor;ancestor=ancestor.parent)if(ancestor.type==='rule')return;rule.selectors=rule.selectors.map(selector=>selector===':root'||selector===':host'||selector==='html'?'[data-maic-quiz-card]':`[data-maic-quiz-card] ${selector}`)});
await writeFile(join(out,'reference.css'),css.toString());await writeFile(join(out,'runtime.css'),await readFile(join(root,'src/maic-quiz.css')));
const hostCss=(await Promise.all(['styles/tokens.css','styles/base.css','components/workpanel/courseware-classroom-editor.css'].map(path=>readFile(join(root,'../../apps/desktop/src',path),'utf8')))).join('\n');await writeFile(join(out,'host.css'),hostCss);
const server=createServer(async(req,res)=>{res.setHeader('content-type',req.url.endsWith('.js')?'text/javascript':req.url.endsWith('.css')?'text/css':'text/html');res.end(['/app.js','/runtime.css','/reference.css','/host.css'].includes(req.url)?await readFile(join(out,req.url.slice(1))):'<!doctype html><html data-theme="dark"><meta charset="utf-8"><link id="css" rel="stylesheet" href="/reference.css"><link id="host" rel="stylesheet" href="/host.css" disabled><style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><script type="module" src="/app.js"></script>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const chrome=process.env.CHROME_BIN||(existsSync('/usr/bin/google-chrome')?'/usr/bin/google-chrome':undefined);
const browser=await chromium.launch({headless:true,args:['--no-sandbox'],...(chrome?{executablePath:chrome}:{})});
try {
  const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  for(const width of [1280,1844]) {
    await page.setViewportSize({width,height:908});const measurements=[];
    for(const mode of ['reference','runtime']) {
      await page.evaluate(mode=>window.render(mode),mode);
      await page.waitForFunction(()=>document.getElementById('css').sheet && (document.getElementById('host').disabled || document.getElementById('host').sheet));
      await expect(page.getByText('Introduce yourself',{exact:true})).toBeVisible();
      // Wait for reference motion to settle by observing actual stationary geometry.
      await page.waitForFunction(()=>{const el=[...document.querySelectorAll('p')].find(el=>el.textContent==='Choose a greeting');if(!el)return false;const top=el.getBoundingClientRect().top;const old=window.lastTop;window.lastTop=top;return old===top;});
      const cards=mode==='runtime'?page.locator('[data-question-id]'):page.locator('[data-maic-quiz-card] .relative.overflow-hidden');
      await expect(cards).toHaveCount(3);
      measurements.push(await cards.evaluateAll(cards=>cards.map(card=>{const base=card.getBoundingClientRect();return {width:base.width,height:base.height,children:[...card.querySelectorAll('p,button,textarea')].map(el=>{const r=el.getBoundingClientRect();return {tag:el.tagName,text:el.tagName==='TEXTAREA'?'textarea':el.textContent,x:r.x-base.x,y:r.y-base.y,width:r.width,height:r.height,style:Object.fromEntries(['backgroundColor','padding','borderRadius','color','opacity'].map(key=>[key,getComputedStyle(el)[key]]))}})}})));
      await page.screenshot({path:join(out,`${mode}-${width}.png`)});
    }
    for(let i=0;i<3;i++) {
      const before=measurements[0][i],after=measurements[1][i];assert.equal(before.children.length,after.children.length);
      for(const key of ['width','height'])assert(Math.abs(before[key]-after[key])<=2,`card ${i}.${key}: ${before[key]} vs ${after[key]}`);
      before.children.forEach((reference,j)=>{const actual=after.children[j];assert.equal(actual.tag,reference.tag);assert.equal(actual.text,reference.text);assert.deepEqual(actual.style,reference.style,`card ${i}, child ${j} computed style`);for(const key of ['x','y','width','height'])assert(Math.abs(reference[key]-actual[key])<=2,`card ${i}, child ${j}.${key}: ${reference[key]} vs ${actual[key]}`)});
    }
  }
  for(const colorScheme of ['light','dark']) {
  await page.emulateMedia({colorScheme});
  for(const explicitDark of [false,true]) {
  await page.evaluate(explicitDark=>document.documentElement.classList.toggle('dark',explicitDark),explicitDark);
  for (const disabled of [false,true]) {
    const styles=[];
    for(const mode of ['reference','runtime']) {
      await page.evaluate(({mode,disabled})=>window.render(mode,'instant',disabled),{mode,disabled});
      await expect(page.locator('[data-classroom-instant-layout]')).toBeVisible();
      await page.waitForFunction(()=>document.getElementById('css').sheet && (document.getElementById('host').disabled || document.getElementById('host').sheet));
      if(mode==='reference' && disabled) await page.locator('[data-classroom-instant-layout] button').evaluateAll(buttons=>buttons.forEach(button=>button.disabled=true));
      await expect(page.locator('[data-classroom-instant-layout] button').first()).toHaveCSS('border-radius','28px');
      await expect(page.locator('[data-classroom-instant-layout] button').first()).toHaveCSS('background-color',explicitDark?/^(?:oklab\(0\.129 |rgba\(2, 6, 23, 0\.4\))/: 'rgb(255, 255, 255)');
      styles.push(await page.locator('[data-classroom-instant-layout] button').evaluateAll(buttons=>buttons.map(button=>Object.fromEntries(['backgroundColor','padding','borderRadius','borderWidth','color','opacity'].map(key=>[key,getComputedStyle(button)[key]])))));
      await page.screenshot({path:join(out,`${mode}-instant-os-${colorScheme}-dark-${explicitDark}-disabled-${disabled}.png`)});
    }
    assert.deepEqual(styles[1],styles[0],`Instant control styles with OS ${colorScheme}, explicit dark ${explicitDark}, disabled ${disabled}`);
  }
  }
  }
  await page.evaluate(()=>document.documentElement.classList.remove('dark'));
  const disabledAssessmentStyles=[];
  for(const mode of ['reference','runtime']) {
    await page.evaluate(mode=>window.render(mode,'assessment',true),mode);
    await expect(page.getByText('Introduce yourself',{exact:true})).toBeVisible();
    const cards=mode==='runtime'?page.locator('[data-question-id]'):page.locator('[data-maic-quiz-card] .relative.overflow-hidden');
    await expect(cards.first().getByRole('button').first()).toHaveCSS('border-radius','12px');
    disabledAssessmentStyles.push(await cards.evaluateAll(cards=>cards.flatMap(card=>[...card.querySelectorAll('button,textarea')].map(control=>Object.fromEntries(['backgroundColor','padding','borderRadius','color','opacity'].map(key=>[key,getComputedStyle(control)[key]]))))));
  }
  assert.deepEqual(disabledAssessmentStyles[1],disabledAssessmentStyles[0],'Disabled assessment controls retain cloud styles inside the dark editor');
  assert.deepEqual(errors,[]);console.log(`PASS actual cloud-web assessment question geometry and control cascade against dark app CSS at 1280/1844: ${out}`);
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
