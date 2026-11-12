import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const requireRuntime = createRequire(path.join(root, "packages/courseware-runtime/package.json"));
const { build } = requireRuntime("esbuild");
const { chromium } = requireRuntime("@playwright/test");
const output = await mkdtemp(path.join(tmpdir(), "composer-submit-browser-"));
let browser, server;
try {
  await build({
    stdin: { resolveDir: path.join(root, "apps/desktop"), loader: "tsx", contents: `
      import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
      import {useComposerDraft} from './src/features/chat/composer/hooks/useComposerDraft';
      import {useComposerSubmit} from './src/features/chat/composer/hooks/useComposerSubmit';
      import {ComposerStatus} from './src/features/chat/composer/ComposerStatus';
      import {writeComposerDraft} from './src/lib/composer-draft-cache';
      window.testState={activeSessionId:'chat'};window.mode='reject';
      const original='Explain this lesson '+String.fromCodePoint(0xE000);
      writeComposerDraft('chat',{text:original,fileReferences:[{path:'/tmp/lesson.docx',name:'lesson.docx',kind:'file',token:String.fromCodePoint(0xE000)}]});
      const sessions=[{id:'chat'},{id:'other'}],noop=()=>{},t=key=>({'common.close':'Close','coursewareWorkflow.sendFailed':'Request not accepted'}[key]||key);
      async function send(content,snapshot){window.lastSubmission={content,snapshot};
        if(window.mode==='throw')throw new Error('Local document failed');
        if(window.mode==='defer')return new Promise((resolve,reject)=>{window.rejectSend=reject;});
        return window.mode==='accept';}
      function Fixture(){const [session,setSession]=useState('chat');
        const draft=useComposerDraft({variant:'docked',activeSessionId:session,workspacePath:'/tmp',sessions,composerPrefill:null,clearComposerPrefill:noop,t,invalidatePromptEnhancement:noop,inputBlocked:false});
        const submit=useComposerSubmit({value:draft.value,draftKey:draft.draftKey,activeSessionId:session,modelReady:true,sendBlocked:false,pasting:false,activeFileReferences:draft.activeFileReferences,t,sendPrompt:send,steerPrompt:send,showToast:noop,draft});
        return <><button onClick={()=>{const next=session==='chat'?'other':'chat';window.testState.activeSessionId=next;setSession(next);}}>Switch session</button>
          <output data-testid="session">{session}</output><textarea aria-label="Draft" value={draft.value} onChange={e=>draft.setValue(e.target.value)}/>
          <div data-testid="attachments">{draft.activeFileReferences.map(f=><span key={f.path}>{f.name}</span>)}</div>
          <button onClick={()=>void submit.submit()}>Send</button>
          <ComposerStatus t={t} submissionError={submit.submissionError} clearSubmissionError={submit.clearSubmissionError}
            queuedPrompts={[]} removeQueuedPrompt={noop} moveQueuedPrompt={noop} editQueuedPrompt={noop} sendQueuedNow={noop}
            approvalPending={false} enhancementError={null} clearEnhancementError={noop} droppedDirectories={[]}
            openDroppedFolderAsProject={noop} insertDroppedDirectoryPaths={noop} dismissDroppedDirectories={noop}/></>;}
      createRoot(document.getElementById('root')).render(<Fixture/>);
    ` },
    bundle: true, outfile: path.join(output, "app.js"), format: "esm", jsx: "automatic",
    plugins: [{ name: "isolated-local-services", setup(builder) {
      builder.onResolve({ filter: /(?:stores\/app-store|lib\/(?:api|commands)|hooks\/use-composer-autocomplete)$/ }, args => ({ path: args.path, namespace: "local-fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "local-fixture" }, args => ({ contents:
        args.path.endsWith("app-store") ? "export const useAppStore=Object.assign(selector=>selector(window.testState),{getState:()=>window.testState});" :
        args.path.endsWith("api") ? "export const api={};" :
        args.path.endsWith("commands") ? "export const runExtensionCommand=()=>{},runPaletteCommand=()=>{};" :
        "export const resolveComposerCommand=async()=>null;",
      }));
    } }],
  });
  server = http.createServer(async (req, res) => {
    if (req.url === "/") { res.setHeader("content-type", "text/html"); res.end('<!doctype html><div id="root"></div><script type="module" src="/app.js"></script>'); return; }
    if (req.url !== "/app.js") { res.statusCode = 404; res.end(); return; }
    res.setHeader("content-type", "text/javascript"); res.end(await readFile(path.join(output, "app.js")));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const draft = page.getByRole("textbox", { name: "Draft" });
  const send = page.getByRole("button", { name: "Send", exact: true });
  const waitDraft = text => page.waitForFunction(text => document.querySelector("textarea")?.value === text, text);
  const original = "Explain this lesson \uE000";
  await waitDraft(original);
  for (const mode of ["reject", "throw"]) {
    await page.evaluate(mode => { window.mode = mode; }, mode);
    await send.click();
    await page.getByRole("alert").waitFor();
    await waitDraft(original);
    assert.equal(await page.getByTestId("attachments").textContent(), "lesson.docx");
    assert.match(await page.getByRole("alert").textContent(), mode === "throw" ? /Local document failed/ : /Request not accepted/);
    assert.equal(await page.evaluate(() => window.lastSubmission.snapshot.fileReferences[0].name), "lesson.docx");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("alert").waitFor({ state: "detached" });
  }
  await page.evaluate(() => { window.mode = "defer"; });
  await send.click();
  await waitDraft("");
  await page.getByRole("button", { name: "Switch session" }).click();
  await waitDraft("");
  await draft.fill("Other session draft");
  await page.evaluate(() => { window.rejectSend(new Error("Late failure")); });
  await page.waitForFunction(() => document.querySelector("textarea").value === "Other session draft" && !document.querySelector('[role="alert"]'));
  await page.getByRole("button", { name: "Switch session" }).click();
  await waitDraft(original);
  assert.equal(await page.getByTestId("attachments").textContent(), "lesson.docx");
  await page.evaluate(() => { window.mode = "defer"; });
  await send.click();
  await waitDraft("");
  await draft.fill("Newer typing wins");
  await page.evaluate(() => { window.rejectSend(new Error("Same-session failure")); });
  await page.getByRole("alert").waitFor();
  await waitDraft("Newer typing wins");
  await page.evaluate(() => { window.mode = "accept"; });
  await send.click();
  await waitDraft("");
  await page.getByRole("alert").waitFor({ state: "detached" });
  assert.deepEqual(errors, []);
  console.log("COMPOSER_SUBMIT_ERRORS_OK: real React submit/draft hooks and status UI preserve attachments, isolate late failures and retain newer typing");
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(output, { recursive: true, force: true });
}
