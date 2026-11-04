import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(root, 'package.json'));
const desktopRequire = createRequire(join(root, '../../apps/desktop/package.json'));
const { build } = require('esbuild');
const { chromium, expect } = require('@playwright/test');
const out = await mkdtemp(join(tmpdir(), 'maic-assessment-'));
const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZsAAAAASUVORK5CYII=';
const questions = [
  {id:'single',type:'single',question:'Greeting?',options:[{value:'A',label:'Hello',image:{src:image}},{value:'B',label:'Bye'}],answer:['A'],points:2,analysis:'Use Hello.'},
  {id:'multiple',type:'multiple',question:'Pick two',options:[{value:'A',label:'One'},{value:'B',label:'Two'},{value:'C',label:'Three'}],answer:['A','B'],points:3},
  {id:'judge',type:'judge',question:'Greeting is friendly.',options:[{value:'T',label:'True'},{value:'F',label:'False'}],answer:['T'],points:1},
  {id:'short',type:'short_answer',question:'Introduce yourself',answer:['My name is Pandy.'],referenceAnswer:'My name is Pandy.',hasAnswer:false,points:9},
];
await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {MaicAssessmentQuiz} from '${join(root,'src/player/components/courseware/MaicAssessmentQuiz.tsx')}';createRoot(document.getElementById('root')).render(<MaicAssessmentQuiz questions={${JSON.stringify(questions)}} onComplete={()=>window.completed=true}/>);`,resolveDir:root,loader:'tsx'},outfile:join(out,'app.js'),bundle:true,format:'esm',jsx:'automatic',plugins:[{name:'one-react',setup(builder){builder.onResolve({filter:/^react(?:-dom)?(?:\/.*)?$/},args=>({path:desktopRequire.resolve(args.path)}));}}]});
await writeFile(join(out,'app.css'),await readFile(join(root,'src/maic-quiz.css')));
const server=createServer(async(req,res)=>{res.setHeader('content-type',req.url==='/app.js'?'text/javascript':req.url==='/app.css'?'text/css':'text/html');res.end(req.url==='/app.js'||req.url==='/app.css'?await readFile(join(out,req.url.slice(1))):'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><script type="module" src="/app.js"></script>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const chrome=process.env.CHROME_BIN || (existsSync('/usr/bin/google-chrome')?'/usr/bin/google-chrome':undefined);
const browser=await chromium.launch({headless:true,args:['--no-sandbox'],...(chrome?{executablePath:chrome}:{})});
try {
  const page=await browser.newPage({viewport:{width:1280,height:800}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const card=id=>page.locator(`[data-question-id="${id}"]`);
  await expect(page.getByRole('button',{name:'提交答案',exact:true})).toBeDisabled();
  await expect(page.getByText('My name is Pandy.',{exact:true})).toHaveCount(0);
  await card('single').getByRole('button',{name:'B Bye',exact:true}).click();
  await card('multiple').getByRole('button',{name:'A One',exact:true}).click();
  await card('multiple').getByRole('button',{name:'B Two',exact:true}).click();
  await card('judge').getByRole('button',{name:'T True',exact:true}).click();
  await card('short').getByRole('textbox').fill('Hello, my name is Pandy.');
  await page.getByRole('button',{name:'提交答案',exact:true}).click();
  await expect(page.getByText('答题报告',{exact:true})).toBeVisible();
  await expect(page.locator('[data-grading-status="correct"]')).toHaveCount(2);
  await expect(page.locator('[data-grading-status="incorrect"]')).toHaveCount(1);
  await expect(page.locator('[data-grading-status="ungraded"]')).toHaveCount(1);
  await expect(page.getByRole('status').filter({hasText:'未计入当前得分'})).toHaveText('1 道题需要教师或在线评价，未计入当前得分。');
  await expect(page.getByText('/ 6',{exact:true})).toBeVisible();
  await expect(card('single').getByText('解析：Use Hello.',{exact:true})).toBeVisible();
  await expect(card('short').getByText('My name is Pandy.',{exact:true})).toBeVisible();
  await expect(card('multiple').getByRole('button').first()).toBeDisabled();
  const dash = Number(await page.locator('circle[stroke-dashoffset]').getAttribute('stroke-dashoffset'));
  assert(Math.abs(dash - 2 * Math.PI * 34 * (1 - 0.67)) < 0.001, 'Score ring must represent the earned percentage');
  await page.screenshot({path:join(out,'review-1280.png')});
  await page.getByRole('button',{name:'重新答题',exact:true}).click();
  await expect(page.locator('[aria-pressed="true"]')).toHaveCount(0);
  await expect(card('short').getByRole('textbox')).toHaveValue('');
  await expect(page.getByRole('button',{name:'提交答案',exact:true})).toBeDisabled();
  assert.deepEqual(errors,[]);
  console.log(`PASS assessment answering/review/local weighted scoring/ungraded short answer/retry: ${out}`);
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
