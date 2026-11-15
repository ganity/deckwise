import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import test from "node:test";
import ts from "typescript";
import * as shared from "@pi-desktop/shared";
import * as runtime from "@pi-desktop/agent-runtime";
import * as coursewareRuntime from "@pi-desktop/courseware-runtime/node";
import { Host, resolveHostBinary } from "../../../scripts/e2e/host.mjs";
const require = createRequire(import.meta.url), cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file);
  const exports = {}; cache.set(file, exports);
  const code = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  new Function("require", "exports", code)(id => id === "@pi-desktop/shared" ? shared : id === "@pi-desktop/agent-runtime" ? runtime : id === "@pi-desktop/courseware-runtime/node" ? coursewareRuntime : id.startsWith(".") ? load(join(dirname(file), id + ".ts")) : require(id), exports);
  return exports;
}
const main = new URL("../electron/main/", import.meta.url).pathname;
const { CoursewareChatWorkflow } = load(join(main,"courseware-chat-workflow.ts"));
const { coursewareStoryPrompt } = load(join(main,"courseware-story.ts"));
const { createSceneCoursePlan } = load(join(main,"courseware-scene-plan.ts"));
const storyDraft = { title: "Rainbow rescue", summary: "Help Robin find the colors", setting: "A garden", objectives: ["Name red"],
  characters: [{ name: "Robin", description: "A round robot with a green scarf" }], beats: [{ id: "find", title: "Find red", event: "Robin finds a red ball", objective: "Name red", activity: "Sort objects by color" }], assumptions: [], bodyPageLimit: 2 };

test("real Main/Host saves and reviews a topic-only story, then hands each route its pinned story across restart", { timeout: 90000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "courseware-story-")); t.after(() => rm(directory,{recursive:true,force:true}));
  const workspace=join(directory,"workspace"), data=join(directory,"data"); await mkdir(workspace);
  await mkdir(join(data,"plugins/market"),{recursive:true});
  await writeFile(join(data,"plugins/market/catalog.json"),JSON.stringify({schemaVersion:2,providerId:"official",plugins:[]}));
  let host=new Host(resolveHostBinary(),data); t.after(()=>host.stop()); await host.start();
  const pinned=[];
  for (const taskType of ["plain","scene"]) {
    const {session}=await host.call("session.create",{title:"Story "+taskType,mode:"agent",projectPath:workspace});
    const sessionId=session.id;
    await host.call("courseware.task.set",{sessionId,taskType,storyFirst:true,educationContext:{schoolStage:"kindergarten",subject:"english"}});
    let dispatchable=true;
    const workflow=new CoursewareChatWorkflow(()=>host,()=>sessionId,{},{});
    let view=await workflow.read(sessionId); assert(shared.storyNeedsApproval(view.story));
    await assert.rejects(workflow.execute(sessionId,"courseware_scene_compile",{},()=>true),/story/);
    await assert.rejects(host.call("tools.execute",{sessionId,toolCallId:"early-write",toolName:"Write",mode:"agent",args:{path:join(workspace,"unexpected"),content:"bad"}}),/approval/);
    const draftPrompt=coursewareStoryPrompt(view.story,taskType);
    assert.match(draftPrompt,/user need not supply a lesson plan/);
    assert.match(draftPrompt,/exactly one question per Quiz page/);
    assert.match(draftPrompt,/Music and video belong only on body pages/);
    const saved=await workflow.execute(sessionId,"courseware_story_save",{expectedRevision:0,story:storyDraft},()=>dispatchable);
    assert.equal(saved.story.revision,1); assert(saved.story.draft.beats.length);
    const pending=await workflow.read(sessionId); assert.equal(pending.plan,null); assert(shared.storyNeedsApproval(pending.story));
    await host.call("courseware.story.decide",{sessionId,expectedRevision:1,sha256:saved.story.sha256,action:"approve"});
    view=await workflow.read(sessionId); assert(!shared.storyNeedsApproval(view.story));
    await workflow.execute(sessionId,"courseware_requirements_update",{
      expectedEducationContext:view.task.educationContext,
      educationContext:{...view.task.educationContext,bodyPageLimit:10},
    },()=>true);
    view=await workflow.read(sessionId);
    assert.equal(view.task.educationContext.bodyPageLimit,10);
    assert.equal(view.story.approvedSha256,saved.story.sha256,"Saving the body-page budget must retain the user's story approval");
    const confirmedStory = structuredClone(view.story);
    await workflow.execute(sessionId,"courseware_requirements_update",{
      expectedEducationContext:view.task.educationContext,
      educationContext:{...view.task.educationContext,visualStyle:"Clean park illustration"},
    },()=>true);
    view=await workflow.read(sessionId);
    assert.equal(view.story.approvedSha256,saved.story.sha256,"A visual-style choice must not hide an already confirmed story");
    assert.equal(view.story.revision,confirmedStory.revision);
    assert.deepEqual(view.story.draft,confirmedStory.draft);
    await host.call("courseware.story.decide",{sessionId,expectedRevision:view.story.revision,sha256:view.story.sha256,action:"approve"});
    assert(!shared.storyNeedsApproval((await workflow.read(sessionId)).story));
    const prompt=coursewareStoryPrompt(view.story,taskType);
    assert(prompt.includes(storyDraft.title)); assert(prompt.includes(view.story.sha256));
    assert.match(prompt,/exactly one question per Quiz page/);
    assert.match(prompt,/Music and video belong only on body pages/);
    assert.match(prompt,/Cover, opening, activity setup and review all consume the saved body-page budget/);
    if (taskType === "plain") {
      assert.match(prompt,/full existing PPT Master/); assert.match(prompt,/SVG authoring, quality, preview and explicit export/);
      const path=join(workspace,`story-source-${sessionId}.json`);
      const content=JSON.stringify({story:view.story.draft,sha256:view.story.sha256});
      const written=await host.call("tools.execute",{sessionId,toolCallId:"archive-approved-story",toolName:"Write",mode:"agent",args:{path,content}});
      assert.equal(written.ok,true); assert.equal(await readFile(path,"utf8"),content);
      assert((await workflow.read(sessionId)).story.bound);
      await assert.rejects(workflow.execute(sessionId,"courseware_story_save",{expectedRevision:1,story:{...storyDraft,title:"Different"}},()=>true),/production/);
    } else {
      const raw={title:"Rainbow rescue",storySha256:view.story.sha256,bodyPageLimit:10,pages:[{title:"Red ball",visibleText:["red"],visualIntent:"Robin finds a red ball in the garden",narration:"Look at the red ball.",teaching:{pageType:"slide",phase:"explore",objective:"Name red",durationSeconds:30,requiredObjects:["Robin","red ball"]}}]};
      let attempts=0;
      const planned=await createSceneCoursePlan({sessionId,modelKey:"fixture",brief:"Teach colors",education:view.task.educationContext,story:view.story},async request=>{
        assert(request.system.includes(storyDraft.title)); attempts++; return {text:JSON.stringify({...raw,storySha256:attempts===1 ? "f".repeat(64) : view.story.sha256})};
      });
      assert.equal(attempts,2); assert.equal(planned.storySha256,view.story.sha256);
      const file=join(workspace,`.deckwise-ppt/scenes/${sessionId}/plan.json`); await mkdir(dirname(file),{recursive:true});
      let bytes=JSON.stringify(raw);
      const written=await host.call("tools.execute",{sessionId,toolCallId:"write-approved-story-plan",toolName:"Write",mode:"agent",args:{path:file,content:bytes}});
      assert.equal(written.ok,true,"Scene planning writes must be admitted after saving the page budget");
      assert.equal((await workflow.read(sessionId)).plan.storySha256,view.story.sha256);
      const revised = await workflow.execute(sessionId,"courseware_story_save",{expectedRevision:1,story:{...storyDraft,title:"Revised rainbow rescue"}},()=>true);
      assert.equal((await workflow.read(sessionId)).plan,null);
      await assert.rejects(host.call("courseware.scenePlan.approve",{sessionId,sha256:createHash("sha256").update(bytes).digest("hex")}),/story|approved version/);
      await host.call("courseware.story.decide",{sessionId,expectedRevision:2,sha256:revised.story.sha256,action:"approve"});
      view=await workflow.read(sessionId); assert.equal(view.plan,null);
      await assert.rejects(host.call("courseware.scenePlan.approve",{sessionId,sha256:createHash("sha256").update(bytes).digest("hex")}),/story|approved version/);
      raw.storySha256=view.story.sha256; bytes=JSON.stringify(raw); await writeFile(file,bytes);
      await host.call("courseware.scenePlan.approve",{sessionId,sha256:createHash("sha256").update(bytes).digest("hex")});
      const ready=await workflow.execute(sessionId,"courseware_scene_plan_submit",{},()=>true); assert.equal(ready.awaitingPlanApproval,false);
      assert((await workflow.read(sessionId)).story.bound);
      await assert.rejects(workflow.execute(sessionId,"courseware_story_save",{expectedRevision:2,story:{...storyDraft,title:"Different"}},()=>true),/production|approved/);
    }
    pinned.push({sessionId,hash:view.story.sha256});
    dispatchable=false;
    await assert.rejects(workflow.execute(sessionId,"courseware_story_save",{expectedRevision:1,story:storyDraft},()=>dispatchable),/cancelled/);
  }
  await host.stop();host=new Host(resolveHostBinary(),data);await host.start();
  for(const {sessionId,hash} of pinned) {
    const restored=await new CoursewareChatWorkflow(()=>host,()=>sessionId,{},{}).read(sessionId);
    assert.equal(restored.story.sha256,hash);assert.equal(restored.story.approvedSha256,hash);
  }
});
