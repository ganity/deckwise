import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Exercise existing teaching controls; object authority comes from the live Host view. */
export async function authorSceneEffects({ page, expect, readTeaching, saveTeaching, teachingReady, pageNumber, report }) {
  await pageNumber(1);
  const baseline = await readTeaching();
  const speech = baseline.project.pages[0].actions.find(action => action.type === "speech" && action.audioAssetId);
  const target = baseline.teachingObjects.find(object => object.status === "mapped" && object.effectTargetEligible);
  assert(speech && target, "Effects require adopted audio and an eligible mapped object");
  const panel = page.getByRole("region", { name: "高亮与聚光", exact: true });
  const targetName = (target.role || target.name) + (target.aliases.length ? ` · ${target.aliases.join(" / ")}` : "");
  const add = panel.getByRole("button", { name: "添加提示", exact: true });
  const consent = panel.getByRole("checkbox", { name: "我已核对已保存页面中的这些对象，并审核本讲解段的时间区间。", exact: true });
  const confirm = async () => {
    await saveTeaching();
    const button = page.locator(".courseware-teaching").getByRole("button", { name: "确认本页教学内容", exact: true });
    if (await button.isEnabled()) await button.click();
    await teachingReady();
  };
  for (const cue of [{ kind: "highlight", start: "0", end: "800" }, { kind: "spotlight", start: "800", end: "1900" }]) {
    await panel.getByRole("combobox", { name: "效果", exact: true }).selectOption(cue.kind);
    await panel.getByRole("checkbox", { name: targetName, exact: true }).check();
    await panel.getByRole("spinbutton", { name: "本段开始时间（毫秒）", exact: true }).fill(cue.start);
    await panel.getByRole("spinbutton", { name: "本段结束时间（毫秒）", exact: true }).fill(cue.end);
    await expect(add).toBeDisabled();
    await consent.check(); await expect(add).toBeEnabled(); await add.click();
    await confirm();
  }
  const current = await readTeaching();
  const updated = current.project.pages[0].actions.find(action => action.id === speech.id);
  assert.equal(updated.audioAssetId, speech.audioAssetId);
  assert.equal(updated.text, speech.text);
  assert.equal(updated.visualCues.length, 2);
  assert.deepEqual(updated.visualCues.map(cue => [cue.atMs, cue.endMs, cue.effect.type]),
    [[0, 800, "highlight"], [800, 1900, "spotlight"]]);
  for (const cue of updated.visualCues)
    assert.equal(cue.effect.type === "highlight" ? cue.effect.elementIds[0] : cue.effect.elementId, target.objectId);
  assert.deepEqual(current.project.pages[1], baseline.project.pages[1]);
  assert.deepEqual(current.project.pages[0].actions.filter(action => action.id !== speech.id),
    baseline.project.pages[0].actions.filter(action => action.id !== speech.id));
  assert.equal(current.project.pages[0].reviewState, "ready");
  report.effects = { page: 1, objectId: target.objectId, audioAssetId: speech.audioAssetId, cues: updated.visualCues };
  return current.project;
}

/** Continue only the owned two-page Circle fixture; never regenerate its existing audio. */
export async function reassociateSceneEffects({ page, getSdk, invoke, sessionId, expect, input, out, report,
  readTeaching, teachingReady, pageNumber }) {
  await pageNumber(1);
  const baseline = await readTeaching(), project = baseline.project;
  const speech = project.pages[0].actions.find(action => action.type === "speech" && action.visualCues?.length === 2);
  const oldTarget = baseline.teachingObjects.find(object => object.objectId === speech?.visualCues[0].effect.elementIds[0]);
  report.reassociationBaselineObjects = baseline.teachingObjects;
  assert(speech && oldTarget?.effectTargetEligible && oldTarget.status === "mapped" &&
    (oldTarget.name === "title" || ["text", "shape"].includes(oldTarget.savedKind) && oldTarget.savedIndex === 1),
  "Use the reviewed Circle title fixture");
  await copyFile(input.generatedPath, join(out, "scene-baseline.pptx"));
  const inventory = () => getSdk().evaluate(() => window.Asc.editor.WordControl.m_oLogicDocument.Slides.map(slide =>
    slide.cSld.spTree.map(shape => ({ text: shape.getDocContent?.()?.GetText({}) ?? "", type: shape.getObjectType(),
      geometry: Object.fromEntries(["offX", "offY", "extX", "extY", "rot", "flipH", "flipV"].map(key => [key, shape.spPr?.xfrm?.[key]])) }))));
  const before = await inventory(); assert.equal(before[0][0].text.trim(), "Circle");
  await getSdk().evaluate(() => {
    const doc = window.Asc.editor.WordControl.m_oLogicDocument, title = doc.Slides[0].cSld.spTree[0];
    title.Set_CurrentElement(); title.getDocContent().SelectAll(); doc.Document_UpdateSelectionState();
  });
  const context = await invoke("pptEditorGetContext");
  assert.equal(context.selectedText.trim(), "Circle");
  assert(context.capabilities.some(item => item.name === "set_slide_text_box_position"));
  const position = { xMm: Math.round((before[0][0].geometry.offX + 1) * 1000) / 1000,
    yMm: Math.round(before[0][0].geometry.offY * 1000) / 1000 };
  const command = { projectId: context.projectId, documentId: context.documentId, sessionId: context.sessionId,
    editGeneration: context.editGeneration, requestId: randomUUID(), tool: "set_slide_text_box_position", input: position };
  assert.equal((await invoke("pptEditorExecute", command)).status, "verified");
  const after = await inventory(), expected = structuredClone(before);
  Object.assign(expected[0][0].geometry, { offX: position.xMm, offY: position.yMm });
  assert.deepEqual(after, expected);
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  assert.equal(hash(await readFile(input.generatedPath)), report.sourceSha256, "Native move remains unsaved");
  await page.locator(".ppt-editor-toolbar").getByRole("button", { name: "保存到原文件", exact: true }).click();
  const teaching = page.locator(".courseware-teaching");
  const prepare = teaching.getByRole("button", { name: "审核已保存的 PPTX 变更", exact: true });
  await expect(prepare).toBeEnabled({ timeout: 240_000 });
  report.savedSha256 = hash(await readFile(input.generatedPath)); assert.notEqual(report.savedSha256, report.sourceSha256);
  await assert.rejects(invoke("pptEditorTeachingOpen", { sessionId }), /COURSEWARE_CONFLICT.*reconcile/u);
  await prepare.click();
  const review = page.locator(".courseware-source-review"), choices = review.locator("select");
  await expect(choices).toHaveCount(project.pages.length + 1, { timeout: 120_000 });
  const adopt = review.getByRole("button", { name: "采用这些关联", exact: true });
  await expect(adopt).toBeDisabled();
  for (let index = 0; index < project.pages.length; index++) {
    await expect(choices.nth(index)).toHaveValue(""); await choices.nth(index).selectOption(String(index));
  }
  const effects = review.getByRole("region", { name: "重新关联高亮与聚光对象", exact: true });
  const target = effects.getByRole("combobox"); await expect(target).toHaveValue("");
  await expect(effects.getByRole("checkbox")).toBeDisabled();
  await expect(review.getByText("高亮 · 0–800 毫秒", { exact: true })).toBeVisible();
  await expect(review.getByText("聚光 · 800–1900 毫秒", { exact: true })).toBeVisible();
  await expect(target.locator('option[value="1"]')).toHaveText(/新第 1 页使用 · (文本|形状) · 对象 1/u);
  await target.selectOption("1"); await expect(adopt).toBeDisabled();
  await effects.getByRole("checkbox").check(); await expect(adopt).toBeDisabled();
  await review.getByRole("checkbox", { name: "我已核对每一页的关联，并确认采用此版本。", exact: true }).check();
  await review.screenshot({ path: join(out, "scene-explicit-reassociation.png") });
  await adopt.click(); await expect(review).toHaveCount(0, { timeout: 120_000 }); await teachingReady();
  let current = await readTeaching();
  assert.equal(current.project.taskType, "scene"); assert.equal(current.project.source.sha256, report.savedSha256);
  assert.deepEqual(current.project.pages.map(p => p.pageId), project.pages.map(p => p.pageId));
  assert(current.project.pages.every(p => p.reviewState === "review"));
  const next = current.project.pages[0].actions.find(action => action.id === speech.id);
  const newTargetId = next.visualCues[0].effect.elementIds[0]; assert.notEqual(newTargetId, oldTarget.objectId);
  const rebound = current.teachingObjects.find(object => object.objectId === newTargetId);
  assert(rebound?.effectTargetEligible && ["text", "shape"].includes(rebound.savedKind) && rebound.savedIndex === 1);
  const expectedActions = structuredClone(project.pages[0].actions), expectedSpeech = expectedActions.find(action => action.id === speech.id);
  expectedSpeech.visualCues[0].effect.elementIds = [newTargetId]; expectedSpeech.visualCues[1].effect.elementId = newTargetId;
  assert.deepEqual(current.project.pages[0].actions, expectedActions);
  assert.deepEqual(current.project.pages[1].actions, project.pages[1].actions);
  for (let number = 1; number <= project.pages.length; number++) {
    await pageNumber(number); await teaching.getByRole("button", { name: "确认本页教学内容", exact: true }).click(); await teachingReady();
  }
  await pageNumber(1); current = await readTeaching();
  assert(current.project.pages.every(p => p.reviewState === "ready"));
  report.reassociation = { oldTarget, rebound, nativeBefore: before, nativeAfter: after };
  report.effects = { page: 1, objectId: newTargetId, audioAssetId: speech.audioAssetId, cues: next.visualCues };
  await copyFile(input.generatedPath, join(out, "scene-reassociated.pptx"));
  return current.project;
}
