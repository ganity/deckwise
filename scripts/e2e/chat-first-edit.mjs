import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const addedText = "Try drawing a circle.";
const redoneText = "One round circle, a fresh layout.";
const narration = "Trace the round edge. Can you find a circle?";
const JSZip = createRequire(new URL("../../packages/courseware-runtime/package.json", import.meta.url))("jszip");

// Only the external model is fixed; native tools, save and teaching use real wiring.
export function chatFirstEditResponse({ user, has, result, plain }) {
  const read = name => JSON.parse(plain(result(name).content));
  const tool = user.includes("CHAT_FIRST_REWRITE") ? "ppt_propose_page_narration" :
    user.includes("CHAT_FIRST_FADE") ? "ppt_propose_page_fade" : user.includes("CHAT_FIRST_REDO") ? "ppt_propose_page_redo" : "ppt_add_slide_text";
  if (!result("Skill")) return has("Skill")
    ? { name: "Skill", args: { id: "deckwise/ppt-edit" } }
    : { name: "ToolSearch", args: { query: "Skill" } };
  if (!has("ppt_get_presentation_text")) return { name: "ToolSearch", args: { query: "ppt_get_presentation_text" } };
  if (!result("ppt_get_presentation_text")) return { name: "ppt_get_presentation_text", args: {} };
  const context = read("ppt_get_presentation_text").context;
  assert(plain(result("ppt_get_presentation_text").content).includes("A circle has no corners."));
  if (!has(tool)) return { name: "ToolSearch", args: { query: tool } };
  if (!result(tool)) return { name: tool, args: { editGeneration: context.editGeneration,
    ...(tool === "ppt_add_slide_text" ? { text: addedText } : tool === "ppt_propose_page_narration" ?
      { instruction: "Use short sentences, a participation question and simple English praise." } : tool === "ppt_propose_page_redo" ?
      { instruction: "Rebuild this current saved page with a fresh layout and the title One round circle, a fresh layout." } : {}) } };
  const receipt = read(tool);
  assert.equal(receipt.saved, false);
  if (tool === "ppt_add_slide_text") {
    assert.equal(receipt.response.status, "verified");
    return { content: "CHAT_FIRST_EDIT_DONE：页面已修改，请保存。" };
  }
  assert.equal(receipt.applied, false);
  assert.equal(receipt.reviewState, "needs-review");
  return { content: `CHAT_FIRST_${tool === "ppt_propose_page_fade" ? "FADE" : tool === "ppt_propose_page_redo" ? "REDO" : "REWRITE"}_DONE ${receipt.candidateId}` };
}

export function chatFirstRedoSceneResponse(scene, visuals, sourceSha256) {
  assert.equal(scene.sourceHash, "sha256:" + sourceSha256);
  const text = scene.pageText.replace(/<[^>]*>/gu, "").replace(/&#160;|&nbsp;/gu, " ").replace(/\s+/gu, " ");
  assert(text.includes(addedText), "Redo must use the latest saved Office page, including the native Chat edit");
  assert(scene.instruction.includes(redoneText));
  assert.equal(scene.availableAssets.length, 2);
  for (const [key, hashKey] of [["visualMasterAssetId", "originalSha256"], ["cleanPlateAssetId", "textlessSha256"]]) {
    const asset = scene.availableAssets.find(asset => asset.assetId === scene[key]);
    assert(asset && asset.sha256 === visuals[hashKey], "Model images must match the exact saved-page pixels approved in Chat");
  }
  return JSON.stringify({ version: 1, slideId: scene.pageId, sourceHash: scene.sourceHash, canvas: scene.canvas,
    visualMasterAssetId: scene.visualMasterAssetId, cleanPlateAssetId: scene.cleanPlateAssetId,
    elements: [{ id: "redone-title", type: "native_text", bboxPx: [80, 70, 1000, 150], zIndex: 1, content: redoneText,
      style: { fontFace: "Arial", fontSizePt: 34, color: "#173B65" } }] });
}

export function chatFirstNarrationResponse(body, plain) {
  assert.equal(body.tools?.length ?? 0, 0);
  const data = JSON.parse(plain(body.messages.findLast(row => row.role === "user")?.content));
  const text = data.pageText.replace(/<[^>]*>/gu, "").replace(/&#160;|&nbsp;/gu, " ").replace(/\s+/gu, " ");
  assert(text.includes(addedText), "Narration must read the saved Office edit");
  return JSON.stringify({ blocks: [
    { type: "speech", text: narration }, { type: "wait", durationMs: 4000 }, { type: "speech", text: "Good!" },
  ] });
}

export async function testChatFirstEditing({ getPage, getApp, invoke, expect, workflow, composer, step, start, stop, workspace, report, hash, out, requestCount }) {
  const sessionId = report.ordinary.sessionId;
  const path = join(workspace, report.ordinary.projectPath, "exports");
  const exports = (await readdir(path)).filter(name => name.endsWith(".pptx"));
  assert.equal(exports.length, 1);
  const file = join(path, exports[0]);
  const readTeaching = async () => {
    let value;
    await expect.poll(async () => {
      try { value = await invoke("pptEditorTeachingOpen", { sessionId }); return true; }
      catch (error) {
        if (!String(error).includes("Teaching is already opening")) throw error;
        return false;
      }
    }, { timeout: 120_000 }).toBe(true);
    return value;
  };
  const before = (await readTeaching()).project;
  let savedHash, adopted;
  const page = () => getPage();
  const nativeText = async () => {
    const context = await invoke("pptEditorGetContext");
    return (await invoke("pptEditorExecute", { projectId: context.projectId, documentId: context.documentId,
      sessionId: context.sessionId, editGeneration: context.editGeneration, requestId: randomUUID(), tool: "get_presentation_text", input: {} })).result.text;
  };
  const send = async text => { await composer().fill(text); await composer().press("Enter"); };
  const readOnlyPreview = async () => {
    await expect.poll(async () => {
      const states = [];
      for (const target of getApp().context().pages()) for (const frame of target.frames()) {
        const state = await frame.evaluate(() => {
          const editor = window.Asc?.editor;
          return editor ? { loaded: editor.isDocumentLoadComplete, restrictions: editor.restrictions } : null;
        }).catch(() => null);
        if (state) states.push(state);
      }
      report.ordinary.pptxPreviewStates = states;
      // WiseOffice applies live view restriction 128; it intentionally mounts in edit mode.
      return states.some(state => state.loaded && typeof state.restrictions === "number" && (state.restrictions & 128) === 128);
    }, { timeout: 90_000 }).toBe(true);
  };
  await step("The same generated ordinary Chat edits actual Office objects and explicitly saves its PPTX", async () => {
    await send("CHAT_FIRST_EDIT 在当前页加一句 Try drawing a circle.，不要自动保存。");
    await expect(page().getByText(/^CHAT_FIRST_EDIT_DONE：/)).toBeVisible({ timeout: 90_000 });
    assert((await nativeText()).includes(addedText));
    assert.equal(hash(await readFile(file)), before.source.sha256, "Native editing remains unsaved");
    await page().getByRole("button", { name: "保存到原文件", exact: true }).click();
    await expect(page().locator('.ppt-editor-document [role="status"]')).toContainText("已保存", { timeout: 120_000 });
    savedHash = hash(await readFile(file));
    assert.notEqual(savedHash, before.source.sha256);
    await assert.rejects(readTeaching(), /COURSEWARE_CONFLICT.*reconcile/);
    await page().locator(".courseware-teaching").getByRole("button", { name: /审核已保存的 PPTX 变更/ }).click();
    const review = page().locator(".courseware-source-review");
    await expect(review.locator("select")).toHaveCount(1, { timeout: 120_000 });
    const confirm = review.getByRole("button", { name: "采用这些关联", exact: true });
    await expect(confirm).toBeDisabled();
    await review.locator("select").selectOption("0");
    await review.getByRole("checkbox").check(); await confirm.click();
    await expect(review).toHaveCount(0, { timeout: 120_000 });
    const associated = (await readTeaching()).project;
    assert.equal(associated.source.sha256, savedHash);
    assert.deepEqual(associated.pages[0].actions, before.pages[0].actions);
  });
  await step("The same Chat rewrites narration from the saved Office page and waits for explicit adoption", async () => {
    const baseline = (await readTeaching()).project;
    await send("CHAT_FIRST_REWRITE 请改写本页讲解，短句、一个参与问题和简单英语鼓励。");
    const reply = page().getByText(/^CHAT_FIRST_REWRITE_DONE [\w.-]+$/);
    await expect(reply).toBeVisible({ timeout: 120_000 });
    assert.deepEqual((await readTeaching()).project, baseline);
    const chatReview = workflow().locator(".courseware-chat-narration");
    await expect(chatReview.locator("input:not([type=checkbox])")).toHaveCount(0);
    await chatReview.getByRole("button", { name: "讲解候选 · 审阅候选", exact: true }).click();
    const panel = chatReview.locator(".courseware-narration-review");
    await expect(panel).toContainText(narration);
    await page().screenshot({ path: join(out, "chat-narration-review.png") });
    const adopt = panel.getByRole("button", { name: "采用讲解", exact: true });
    await expect(adopt).toBeDisabled(); await panel.getByRole("checkbox").check(); await adopt.click();
    await expect(panel.getByText("候选讲解", { exact: true })).toHaveCount(0, { timeout: 120_000 });
    await expect(chatReview.getByRole("status")).toHaveText("已采用");
    await expect(page().locator(".courseware-teaching").getByRole("textbox", { name: "讲解段 1", exact: true })).toHaveValue(narration);
    adopted = (await readTeaching()).project;
    assert.deepEqual(adopted.pages[0].actions.filter(action => action.type === "speech").map(({ text, pauseAfterMs }) => ({ text, pauseAfterMs })),
      [{ text: narration, pauseAfterMs: 4000 }, { text: "Good!", pauseAfterMs: undefined }]);
    assert.equal(adopted.pages[0].pageId, before.pages[0].pageId);
    assert.equal(adopted.source.sha256, savedHash);
    assert.equal(hash(await readFile(file)), savedHash, "Narration adoption must not rewrite PPTX");
    await page().screenshot({ path: join(out, "ordinary-chat-edited.png") });
  });
  await step("Closing and rejecting a Chat candidate keep unchanged teaching usable without manual reload", async () => {
    const chat = workflow().locator(".courseware-chat-pptx");
    const teaching = page().locator(".courseware-teaching");
    await send("CHAT_FIRST_FADE 请生成淡入候选，我先预览，不直接替换。");
    await expect(page().getByText(/^CHAT_FIRST_FADE_DONE [\w.-]+$/).last()).toBeVisible({ timeout: 120_000 });
    await chat.getByRole("button", { name: /页面淡入.*审阅候选稿/ }).click();
    const review = chat.locator(".courseware-source-review");
    await review.getByRole("button", { name: "打开只读预览", exact: true }).click();
    await readOnlyPreview();
    await getApp().evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .filter(window => window.getTitle().startsWith("PPTX candidate ")).forEach(window => window.close()));
    await page().bringToFront();
    await review.getByRole("button", { name: "关闭候选审阅", exact: true }).click();
    const confirm = teaching.getByRole("button", { name: "确认本页教学内容", exact: true });
    await expect(confirm).toBeEnabled({ timeout: 120_000 }); await confirm.click();
    await expect(teaching.getByRole("button", { name: "本页已确认", exact: true })).toBeVisible({ timeout: 120_000 });
    await expect(teaching.locator('[role="alert"]')).toHaveCount(0);
    assert.equal(hash(await readFile(file)), savedHash);
    await chat.getByRole("button", { name: /页面淡入.*审阅候选稿/ }).click();
    await review.getByRole("button", { name: "拒绝候选", exact: true }).click();
    await expect(chat.getByRole("status")).toHaveText("已拒绝");
    const lock = teaching.getByRole("checkbox", { name: "锁定本页", exact: true });
    const speech = teaching.getByRole("textbox", { name: "讲解段 1", exact: true });
    await expect(lock).toBeEnabled({ timeout: 120_000 }); await lock.click();
    await expect(lock).toBeChecked({ timeout: 120_000 });
    await expect(speech).toBeDisabled({ timeout: 120_000 });
    await expect(lock).toBeEnabled(); await lock.click();
    await expect(lock).not.toBeChecked({ timeout: 120_000 });
    await expect(speech).toBeEnabled({ timeout: 120_000 });
    await expect(teaching.locator('[role="alert"]')).toHaveCount(0);
    const next = (await readTeaching()).project;
    assert.deepEqual(next.pages.map(page => page.actions), adopted.pages.map(page => page.actions));
    assert.equal(next.source.sha256, savedHash); adopted = next;
    report.ordinary.reviewExit = { previewClosed: true, candidateRejected: true, teachingUsableWithoutManualReload: true, sourceUnchanged: true };
  });
  await step("Main Chat previews and explicitly adopts a real fade candidate while preserving native content and teaching", async () => {
    const original = await readFile(file), baseline = structuredClone(adopted);
    await send("CHAT_FIRST_FADE 请为当前页生成一个淡入过渡候选，我要先预览确认再替换。");
    await expect(page().getByText(/^CHAT_FIRST_FADE_DONE [\w.-]+$/)).toHaveCount(2, { timeout: 120_000 });
    assert.equal(hash(await readFile(file)), savedHash, "Generating a candidate cannot replace the source");
    assert.deepEqual((await readTeaching()).project, baseline);
    const chat = workflow().locator(".courseware-chat-pptx");
    await expect(chat.locator('input:not([type="checkbox"])')).toHaveCount(0);
    await chat.getByRole("button", { name: /页面淡入.*审阅候选稿/ }).click();
    const review = chat.locator(".courseware-source-review");
    await expect(review).toBeVisible();
    const adopt = review.getByRole("button", { name: "采纳并重新打开", exact: true });
    await expect(adopt).toBeDisabled();
    await review.getByRole("button", { name: "打开只读预览", exact: true }).click();
    await expect.poll(() => getApp().evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .filter(window => window.getTitle().startsWith("PPTX candidate ")).length), { timeout: 90_000 }).toBe(1);
    await readOnlyPreview();
    assert.equal(hash(await readFile(file)), savedHash, "Read-only preview cannot replace the source");
    await page().bringToFront(); await review.getByRole("checkbox").check();
    await page().screenshot({ path: join(out, "chat-pptx-review.png") });
    await adopt.click(); await expect(review).toHaveCount(0, { timeout: 120_000 });
    await expect(chat.getByRole("status")).toHaveText("已采用");
    await page().evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const teaching = page().locator(".courseware-teaching");
    const confirm = teaching.getByRole("button", { name: "确认本页教学内容", exact: true });
    await expect(confirm).toBeEnabled({ timeout: 120_000 });
    assert.equal(await teaching.locator('[role="alert"]').count(), 0, await teaching.locator('[role="alert"]').allTextContents());
    await confirm.click();
    await expect(teaching.getByRole("button", { name: "本页已确认", exact: true })).toBeVisible({ timeout: 120_000 });
    await expect(teaching.locator('[role="alert"]')).toHaveCount(0);
    adopted = (await readTeaching()).project;
    const installed = await readFile(file);
    assert.equal(hash(installed), adopted.source.sha256); assert.notEqual(hash(installed), savedHash);
    assert.deepEqual(adopted.pages.map(({ pageId, actions }) => ({ pageId, actions })), baseline.pages.map(({ pageId, actions }) => ({ pageId, actions })));
    const [oldZip, newZip] = await Promise.all([JSZip.loadAsync(original), JSZip.loadAsync(installed)]);
    const parts = Object.keys(oldZip.files).filter(name => !oldZip.files[name].dir).sort();
    assert.deepEqual(Object.keys(newZip.files).filter(name => !newZip.files[name].dir).sort(), parts);
    for (const name of parts) if (name !== "ppt/slides/slide1.xml")
      assert.deepEqual(await newZip.file(name).async("nodebuffer"), await oldZip.file(name).async("nodebuffer"), `Preserve ${name}`);
    const oldSlide = await oldZip.file("ppt/slides/slide1.xml").async("string");
    const newSlide = await newZip.file("ppt/slides/slide1.xml").async("string");
    assert.match(newSlide, /<p:transition\b[^>]*spd="med"[^>]*advClick="1"[^>]*><p:fade\/><\/p:transition>/);
    for (const part of ["cSld", "timing"])
      assert.deepEqual(newSlide.match(new RegExp(`<p:${part}\\b[\\s\\S]*?<\\/p:${part}>`))?.[0],
        oldSlide.match(new RegExp(`<p:${part}\\b[\\s\\S]*?<\\/p:${part}>`))?.[0], `Preserve native ${part}`);
    await expect.poll(nativeText, { timeout: 90_000 }).toContain(addedText);
    await expect(page().locator(".courseware-teaching").getByRole("textbox", { name: "讲解段 1", exact: true })).toHaveValue(narration);
    await page().screenshot({ path: join(out, "chat-pptx-adopted.png") });
    report.ordinary.pptxReview = { kind: "page-fade", previousSha256: savedHash, installedSha256: adopted.source.sha256,
      readOnlyPreview: true, explicitAdoption: true, preservedParts: parts.length - 1, teachingPreserved: true, sidebarConfirmedNewSource: true };
  });
  await step("Full restart restores the ordinary Office edit and adopted page narration without generation replay", async () => {
    const count = requestCount();
    await stop(); await start();
    await page().evaluate(id => window.__PI_DESKTOP__.selectSession(id), sessionId);
    await workflow().getByRole("button", { name: "打开 PPT 编辑", exact: true }).click();
    await expect.poll(async () => {
      try { return await nativeText(); } catch { return ""; }
    }, { timeout: 90_000 }).toContain(addedText);
    assert.deepEqual((await readTeaching()).project, adopted);
    assert.equal(hash(await readFile(file)), adopted.source.sha256);
    await expect(workflow().getByRole("status")).toHaveText("可以编辑");
    assert.equal(requestCount(), count, "Restart must not submit model requests");
    report.ordinary.editing = { nativeSavedSha256: savedHash, pageId: adopted.pages[0].pageId,
      teachingRevision: adopted.teachingRevision, explicitSave: true, explicitNarrationAdoption: true, mainChatNarrationReview: true, restartVerified: true };
  });
  await step("Main Chat prepares real saved-page visuals and approval survives the subsequent redo turn", async () => {
    const requests = requestCount(), sourceHash = hash(await readFile(file));
    const teaching = page().locator(".courseware-teaching");
    await teaching.getByRole("button", { name: "读取当前页讲解", exact: true }).click();
    await expect(teaching.getByRole("textbox", { name: "讲解段 1", exact: true })).toHaveValue(narration);
    const visuals = workflow().locator(".courseware-source-visuals");
    await workflow().locator("summary").filter({ hasText: "重做前的页面底图" }).click();
    await expect(page().locator(".courseware-teaching .courseware-source-visuals")).toHaveCount(0);
    await visuals.getByRole("button", { name: "准备当前页底图", exact: true }).click();
    await expect(visuals.locator("img")).toHaveCount(2, { timeout: 120_000 });
    const images = await visuals.locator("img").evaluateAll(nodes => nodes.map(node => node.src));
    assert(images.every(src => src.startsWith("data:image/png;base64,")));
    assert.notEqual(images[0], images[1], "Actual text omission must change the saved-page pixels");
    const approve = visuals.getByRole("button", { name: "确认使用此背景", exact: true });
    await expect(approve).toBeDisabled(); await expect(visuals.getByRole("checkbox")).not.toBeChecked();
    await visuals.getByRole("checkbox").check(); await approve.click();
    await expect(visuals.getByRole("status")).toContainText("已审核");
    assert.equal(requestCount(), requests, "Visual preparation/approval must not call a model");
    assert.equal(hash(await readFile(file)), sourceHash);
    assert.deepEqual((await readTeaching()).project, adopted);
    await page().screenshot({ path: join(out, "chat-real-source-visuals.png") });
    report.ordinary.visuals = { originalSha256: hash(Buffer.from(images[0].split(",")[1], "base64")),
      textlessSha256: hash(Buffer.from(images[1].split(",")[1], "base64")), sourceUnchanged: true, explicitApproval: true, modelCalls: 0 };
  });
  await step("The same Chat compiles a page redo from approved native visuals without replacing the live source", async () => {
    const baseline = structuredClone(adopted), sourceHash = hash(await readFile(file));
    await send("CHAT_FIRST_REDO 这一页重新排版，标题改为 One round circle, a fresh layout.，先给我候选。");
    await expect(page().getByText(/^CHAT_FIRST_REDO_DONE [\w.-]+$/)).toBeVisible({ timeout: 180_000 });
    assert.equal(hash(await readFile(file)), sourceHash);
    assert.deepEqual((await readTeaching()).project, baseline);
    assert((await nativeText()).includes(addedText), "Proposal must not change the live Office document");
    const chat = workflow().locator(".courseware-chat-pptx");
    await chat.getByRole("button", { name: /重做页面.*审阅候选稿/ }).click();
    const review = chat.locator(".courseware-source-review");
    await expect(review).toBeVisible();
    await expect(review.getByRole("button", { name: "采纳并重新打开", exact: true })).toBeDisabled();
    await review.getByRole("button", { name: "打开只读预览", exact: true }).click();
    await readOnlyPreview();
    await page().bringToFront();
    await page().screenshot({ path: join(out, "chat-real-redo-review.png") });
  });
  await step("Explicit Chat redo adoption reopens native objects and preserves logical-page narration and original notes", async () => {
    const baseline = structuredClone(adopted), previous = await readFile(file);
    const chat = workflow().locator(".courseware-chat-pptx"), review = chat.locator(".courseware-source-review");
    await review.getByRole("checkbox").check();
    await review.getByRole("button", { name: "采纳并重新打开", exact: true }).click();
    await expect(review).toHaveCount(0, { timeout: 120_000 });
    await expect(chat.getByRole("status")).toHaveText("已采用");
    await expect.poll(nativeText, { timeout: 90_000 }).toContain(redoneText);
    assert(!(await nativeText()).includes(addedText), "Redo installs the new native page, not the earlier SVG or source");
    adopted = (await readTeaching()).project;
    assert.deepEqual(adopted.pages.map(({ pageId, actions }) => ({ pageId, actions })), baseline.pages.map(({ pageId, actions }) => ({ pageId, actions })));
    const installed = await readFile(file);
    assert.equal(hash(installed), adopted.source.sha256); assert.notEqual(hash(installed), hash(previous));
    const [oldZip, newZip] = await Promise.all([JSZip.loadAsync(previous), JSZip.loadAsync(installed)]);
    const slide = await newZip.file("ppt/slides/slide1.xml").async("string");
    assert(slide.includes(redoneText) && !slide.includes(addedText));
    const notes = Object.keys(oldZip.files).filter(name => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name));
    assert(notes.length > 0);
    for (const name of notes) assert.deepEqual(await newZip.file(name).async("nodebuffer"), await oldZip.file(name).async("nodebuffer"));
    const teaching = page().locator(".courseware-teaching");
    await expect(teaching.getByRole("textbox", { name: "讲解段 1", exact: true })).toHaveValue(narration);
    await page().screenshot({ path: join(out, "chat-real-redo-adopted.png") });
    report.ordinary.redo = { kind: "page-pptx", previousSha256: hash(previous), installedSha256: adopted.source.sha256,
      explicitAdoption: true, teachingPreserved: true, notesPreserved: notes.length, nativeText: redoneText, sourceVisualsUsed: true };
  });
  await step("Full restart restores the Chat-redone page and narration without replaying generation", async () => {
    const requests = requestCount();
    await stop(); await start();
    await page().evaluate(id => window.__PI_DESKTOP__.selectSession(id), sessionId);
    await workflow().getByRole("button", { name: "打开 PPT 编辑", exact: true }).click();
    await expect.poll(async () => { try { return await nativeText(); } catch { return ""; } }, { timeout: 90_000 }).toContain(redoneText);
    assert.deepEqual((await readTeaching()).project, adopted);
    assert.equal(hash(await readFile(file)), adopted.source.sha256);
    assert.equal(requestCount(), requests);
    report.ordinary.redo.restartVerified = true;
  });

}
