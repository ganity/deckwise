import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const addedText = "Try drawing a circle.";
const narration = "Trace the round edge. Can you find a circle?";

// Only the external model is fixed; native tools, save and teaching use real wiring.
export function chatFirstEditResponse({ user, has, result, plain }) {
  const read = name => JSON.parse(plain(result(name).content));
  const tool = user.includes("CHAT_FIRST_REWRITE") ? "ppt_propose_page_narration" : "ppt_add_slide_text";
  if (!result("Skill")) return has("Skill")
    ? { name: "Skill", args: { id: "deckwise/ppt-edit" } }
    : { name: "ToolSearch", args: { query: "Skill" } };
  if (!has("ppt_get_presentation_text")) return { name: "ToolSearch", args: { query: "ppt_get_presentation_text" } };
  if (!result("ppt_get_presentation_text")) return { name: "ppt_get_presentation_text", args: {} };
  const context = read("ppt_get_presentation_text").context;
  assert(plain(result("ppt_get_presentation_text").content).includes("A circle has no corners."));
  if (!has(tool)) return { name: "ToolSearch", args: { query: tool } };
  if (!result(tool)) return { name: tool, args: { editGeneration: context.editGeneration,
    ...(tool === "ppt_add_slide_text" ? { text: addedText } : { instruction: "Use short sentences, a participation question and simple English praise." }) } };
  const receipt = read(tool);
  assert.equal(receipt.saved, false);
  if (tool === "ppt_add_slide_text") {
    assert.equal(receipt.response.status, "verified");
    return { content: "CHAT_FIRST_EDIT_DONE：页面已修改，请保存。" };
  }
  assert.equal(receipt.applied, false);
  assert.equal(receipt.reviewState, "needs-review");
  return { content: `CHAT_FIRST_REWRITE_DONE ${receipt.candidateId}` };
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

export async function testChatFirstEditing({ getPage, invoke, expect, workflow, composer, step, start, stop, workspace, report, hash, out, requestCount }) {
  const sessionId = report.ordinary.sessionId;
  const path = join(workspace, report.ordinary.projectPath, "exports");
  const exports = (await readdir(path)).filter(name => name.endsWith(".pptx"));
  assert.equal(exports.length, 1);
  const file = join(path, exports[0]);
  const before = (await invoke("pptEditorTeachingOpen", { sessionId })).project;
  let savedHash, adopted;
  const page = () => getPage();
  const nativeText = async () => {
    const context = await invoke("pptEditorGetContext");
    return (await invoke("pptEditorExecute", { projectId: context.projectId, documentId: context.documentId,
      sessionId: context.sessionId, editGeneration: context.editGeneration, requestId: randomUUID(), tool: "get_presentation_text", input: {} })).result.text;
  };
  const send = async text => { await composer().fill(text); await composer().press("Enter"); };
  await step("The same generated ordinary Chat edits actual Office objects and explicitly saves its PPTX", async () => {
    await send("CHAT_FIRST_EDIT 在当前页加一句 Try drawing a circle.，不要自动保存。");
    await expect(page().getByText(/^CHAT_FIRST_EDIT_DONE：/)).toBeVisible({ timeout: 90_000 });
    assert((await nativeText()).includes(addedText));
    assert.equal(hash(await readFile(file)), before.source.sha256, "Native editing remains unsaved");
    await page().getByRole("button", { name: "保存到原文件", exact: true }).click();
    await expect(page().locator('.ppt-editor-document [role="status"]')).toContainText("已保存", { timeout: 120_000 });
    savedHash = hash(await readFile(file));
    assert.notEqual(savedHash, before.source.sha256);
    await assert.rejects(invoke("pptEditorTeachingOpen", { sessionId }), /COURSEWARE_CONFLICT.*reconcile/);
    await page().locator(".courseware-teaching").getByRole("button", { name: /审核已保存的 PPTX 变更/ }).click();
    const review = page().locator(".courseware-source-review");
    await expect(review.locator("select")).toHaveCount(1, { timeout: 120_000 });
    const confirm = review.getByRole("button", { name: "采用这些关联", exact: true });
    await expect(confirm).toBeDisabled();
    await review.locator("select").selectOption("0");
    await review.getByRole("checkbox").check(); await confirm.click();
    await expect(review).toHaveCount(0, { timeout: 120_000 });
    const associated = (await invoke("pptEditorTeachingOpen", { sessionId })).project;
    assert.equal(associated.source.sha256, savedHash);
    assert.deepEqual(associated.pages[0].actions, before.pages[0].actions);
  });
  await step("The same Chat rewrites narration from the saved Office page and waits for explicit adoption", async () => {
    const baseline = (await invoke("pptEditorTeachingOpen", { sessionId })).project;
    await send("CHAT_FIRST_REWRITE 请改写本页讲解，短句、一个参与问题和简单英语鼓励。");
    const reply = page().getByText(/^CHAT_FIRST_REWRITE_DONE [\w.-]+$/);
    await expect(reply).toBeVisible({ timeout: 120_000 });
    assert.deepEqual((await invoke("pptEditorTeachingOpen", { sessionId })).project, baseline);
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
    adopted = (await invoke("pptEditorTeachingOpen", { sessionId })).project;
    assert.deepEqual(adopted.pages[0].actions.filter(action => action.type === "speech").map(({ text, pauseAfterMs }) => ({ text, pauseAfterMs })),
      [{ text: narration, pauseAfterMs: 4000 }, { text: "Good!", pauseAfterMs: undefined }]);
    assert.equal(adopted.pages[0].pageId, before.pages[0].pageId);
    assert.equal(adopted.source.sha256, savedHash);
    assert.equal(hash(await readFile(file)), savedHash, "Narration adoption must not rewrite PPTX");
    await page().screenshot({ path: join(out, "ordinary-chat-edited.png") });
  });
  await step("Full restart restores the ordinary Office edit and adopted page narration without generation replay", async () => {
    const count = requestCount();
    await stop(); await start();
    await page().evaluate(id => window.__PI_DESKTOP__.selectSession(id), sessionId);
    await workflow().getByRole("button", { name: "打开 PPT 编辑", exact: true }).click();
    await expect.poll(async () => {
      try { return await nativeText(); } catch { return ""; }
    }, { timeout: 90_000 }).toContain(addedText);
    assert.deepEqual((await invoke("pptEditorTeachingOpen", { sessionId })).project, adopted);
    assert.equal(hash(await readFile(file)), savedHash);
    await expect(workflow().getByRole("status")).toHaveText("可以编辑");
    assert.equal(requestCount(), count, "Restart must not submit model requests");
    report.ordinary.editing = { nativeSavedSha256: savedHash, pageId: adopted.pages[0].pageId,
      teachingRevision: adopted.teachingRevision, explicitSave: true, explicitNarrationAdoption: true, mainChatNarrationReview: true, restartVerified: true };
  });
}
