import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { IPC } from '../packages/shared/dist/index.js';
assert(process.argv.length === 2 && process.env.DECKWISE_E2E_OUTPUT);
const output = resolve(process.env.DECKWISE_E2E_OUTPUT); await mkdir(output);
const desktop = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const { createServer } = desktop('vite');
const { chromium, expect } = createRequire(new URL('../packages/courseware-runtime/package.json', import.meta.url))('@playwright/test');
const picture = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
const review = { reviewId: 'review-1', projectId: 'local', pageId: 'page-2', pageNumber: 2, sourceSha256: 'a'.repeat(64),
 original: {width:1600,height:900,preview:picture}, nativeTextless:{width:1600,height:900,preview:picture} };
const checks = [], errors = []; let server, browser;
try {
 server = await createServer({ root: new URL('../apps/desktop', import.meta.url).pathname, configFile:false, esbuild:{jsx:'automatic'}, server:{host:'127.0.0.1',port:0},
  plugins:[{ name:'visual-review-test', resolveId(id){if(id==='/__visuals.jsx') return id;}, load(id){if(id==='/__visuals.jsx') return `
   import {createElement} from 'react'; import {createRoot} from 'react-dom/client';
   import i18n from 'i18next'; import {I18nextProvider} from 'react-i18next'; import {catalogs} from '@pi-desktop/i18n';
   import {CoursewareSourceVisuals} from '/src/components/workpanel/CoursewareSourceVisuals.tsx';
   import {CoursewareTeachingPanel} from '/src/components/workpanel/CoursewareTeachingPanel.tsx';
   import '/src/styles/work-panel.css';
   await i18n.init({lng:'en',resources:{en:{translation:catalogs.en},'zh-CN':{translation:catalogs['zh-CN']}}});
   const root=createRoot(document.getElementById('root'));
   window.render=async (sessionId='chat-1',enabled=true,language='en',parent=false) => {
    await i18n.changeLanguage(language); root.render(createElement(I18nextProvider,{i18n},createElement(parent?CoursewareTeachingPanel:CoursewareSourceVisuals,
     {key:parent?'parent':'child',sessionId,enabled,onActiveChange(active){window.active=active;}})));
   };
  `;},configureServer(instance){instance.middlewares.use((req,res,next)=>{if(req.url!=='/__visuals')return next();res.setHeader('content-type','text/html');res.end('<style>body{font:14px sans-serif;background:#fafafa;color:#222}#root{width:300px;margin:20px;--ds-border-subtle:#ddd;--ds-text-primary:#222;--ds-bg-primary:#fff;--ds-bg-secondary:#eee}</style><div id="root" class="courseware-teaching"></div><script type="module" src="/__visuals.jsx"></script>');});}}] });
 await server.listen(); browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1100,height:1000}});page.on('pageerror',e=>errors.push(String(e)));
 await page.addInitScript(({channels,review})=>{
  window.calls=[];window.defer=false;window.rejectApproval=false;
  window.piDesktop={async invoke(channel,payload){window.calls.push({channel,payload});
   if(channel===channels.pptEditorVisualClear||channel===channels.pptEditorImageClear)return {ok:true,data:{ok:true}};
   if(channel===channels.pptEditorVisualPrepare){if(window.defer)await new Promise(resolve=>window.release=resolve);return {ok:true,data:review};}
   if(channel===channels.pptEditorVisualApprove)return window.rejectApproval?{ok:false,error:{code:'CONFLICT',message:'Saved page changed'}}:{ok:true,data:{approved:true}};
   throw Error('Unexpected IPC '+channel);
  }};
 },{channels:IPC.invoke,review});
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__visuals`);await page.waitForFunction(()=>!!window.render);
 await page.evaluate(()=>window.render());
 const prepare=()=>page.getByRole('button',{name:/^(Prepare current page visuals|准备当前页底图)$/});
 const approve=()=>page.getByRole('button',{name:/^(Approve this background|确认使用此背景)$/});
 await prepare().click(); await expect(page.getByAltText('Original saved page')).toBeVisible(); await expect(approve()).toBeDisabled();
 assert.equal(await page.evaluate(ch=>window.calls.filter(x=>x.channel===ch).length,IPC.invoke.pptEditorVisualApprove),0);
 await page.getByRole('checkbox').check();await approve().click();await expect(page.getByRole('status')).toContainText('Background reviewed');
 checks.push('preview alone never approves; checkbox and explicit approval required');
 await page.screenshot({path:`${output}/review-en.png`});
 await page.evaluate(()=>window.render('chat-2',true,'zh-CN')); await expect(page.getByAltText('原始页面')).toHaveCount(0);
 await prepare().click();await page.getByRole('checkbox').check();await approve().click();await expect(page.getByRole('status')).toContainText('已审核');
 await page.screenshot({path:`${output}/review-zh.png`});checks.push('Chat switch clears review; Chinese labels and approval flow work');
 await page.getByRole('button',{name:'放弃本次底图'}).click(); await page.evaluate(()=>{window.defer=true;});await prepare().click();
 await page.waitForFunction(()=>!!window.release);await page.evaluate(()=>window.render('chat-3',false,'en'));await page.evaluate(()=>window.release());
 await expect(page.getByRole('img')).toHaveCount(0);await expect(prepare()).toBeDisabled();checks.push('late prepared reply is ignored after editor deactivation');
 await page.evaluate(()=>{window.defer=false;window.rejectApproval=true;return window.render('chat-3',true);});await prepare().click();await page.getByRole('checkbox').check();await approve().click();
 await expect(page.getByRole('alert')).toContainText('Saved page changed');await expect(page.getByRole('img')).toHaveCount(0);checks.push('stale approval failure clears the proposed images');
 await page.evaluate(()=>{window.rejectApproval=false;return window.render('chat-3',true,'en',true);});
 await prepare().click();await expect(page.locator('.courseware-teaching .courseware-source-visuals img')).toHaveCount(2);
 await expect(page.getByRole('button',{name:'Load current page',exact:true})).toBeEnabled();
 checks.push('existing teaching parent mounts the visual review without another assistant');
 assert.equal(errors.length,0);await writeFile(`${output}/report.json`,JSON.stringify({status:'PASS',checks,realReact:true,preloadIpcStandIn:true,realMain:false,paidCalls:false,errors},null,2));
 console.log(`PASS ${checks.length} actual React visual-review groups`);
} finally {await browser?.close();await server?.close();}
