import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Hold only the external audio response; all editor/teaching/Host state remains real. */
export async function testNativeAudioConcurrency({ getPage, getSdk, invoke, expect, sessionId, goToPage,
  fixture, file, out, report, step, stop, start, readRecords }) {
  const hash = async () => createHash("sha256").update(await readFile(file)).digest("hex");
  const open = () => invoke("pptEditorTeachingOpen", { sessionId });
  const scope = view => ({ viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision });
  const prepare = async view => {
    const task = await invoke("pptEditorTtsPrepare", { ...scope(view), actionId: view.project.pages[0].actions[0].id,
      model: "fixture-speech", voice: "classroom" });
    const operation = { ...scope(view), intentId: task.intentId };
    const quote = await invoke("pptEditorTtsQuote", operation);
    assert.equal(quote.maxPoints, 1);
    await invoke("pptEditorTtsSubmitConfirmed", { ...operation, quoteId: quote.quoteId });
    return operation;
  };
  const move = async delta => {
    const before = await getSdk().evaluate(() => {
      const doc = window.Asc.editor.WordControl.m_oLogicDocument;
      const shape = doc.Slides[0].cSld.spTree.find(shape => shape.getDocContent?.()?.GetText({}).includes("CHAT_ADDED_IN_OFFICE"));
      if (!shape) throw new Error("Missing native Chat text box");
      shape.Set_CurrentElement(); shape.getDocContent().SelectAll(); doc.Document_UpdateSelectionState();
      return { x: shape.spPr.xfrm.offX, y: shape.spPr.xfrm.offY };
    });
    const context = await invoke("pptEditorGetContext");
    const position = { xMm: Math.round((before.x + delta) * 1000) / 1000, yMm: Math.round(before.y * 1000) / 1000 };
    const result = await invoke("pptEditorExecute", { projectId: context.projectId, documentId: context.documentId,
      sessionId: context.sessionId, editGeneration: context.editGeneration, requestId: randomUUID(),
      tool: "set_slide_text_box_position", input: position });
    assert.equal(result.status, "verified");
    return position;
  };
  const save = async previousHash => {
    await getPage().locator(".ppt-editor-toolbar").getByRole("button", { name: /保存到原文件|Save to original/, exact: true }).click();
    await expect(getPage().locator('.ppt-editor-document [role="status"]')).toContainText(/已保存|Saved/, { timeout: 120_000 });
    assert.notEqual(await hash(), previousHash);
  };
  let before, late, staleReview, associated, positions = [];
  await goToPage(0);
  await step("Actual Office race: adopted baseline audio and a second quoted task use the same unchanged speech", async () => {
    const initial = await open();
    const first = await prepare(initial);
    await invoke("pptEditorTtsArchive", first); await invoke("pptEditorTtsAdopt", first);
    before = (await open()).project;
    assert.match(before.pages[0].actions[0].audioAssetId, /^tts-[a-f0-9]{64}$/u);
    late = await prepare(await open());
    assert.equal(fixture.result().requests, 2);
    await copyFile(file, join(out, "native-race-baseline.pptx"));
    await writeFile(join(out, "native-race-before.json"), JSON.stringify({ project: before, records: await readRecords() }, null, 2));
  });
  await step("Actual native edit during held audio download refuses late archive and leaves adopted teaching intact", async () => {
    const barrier = fixture.holdNextDownload();
    const pending = invoke("pptEditorTtsArchive", late).then(value => ({ value }), error => ({ error: String(error) }));
    try {
      await Promise.race([barrier.received, pending.then(result => { throw new Error(`Archive ended before download barrier: ${JSON.stringify(result)}`); }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Audio download barrier not reached")), 30_000).unref())]);
      positions.push(await move(1));
      await assert.rejects(open(), /Save or reopen/u);
    } finally { barrier.release(); }
    const result = await pending;
    assert.match(result.error ?? "", /Save or reopen|changed|STALE/u);
    assert.equal(await hash(), before.source.sha256, "The actual native edit is unsaved");
    const records = await readRecords();
    const projects = records.filter(row => row.ns === "coursewareProjects.v1");
    assert.equal(projects.length, 1); assert.deepEqual(projects[0].value, before);
    const audios = records.filter(row => row.ns === "coursewareTtsAudio.v1");
    assert.equal(audios.length, 1, "Late download must not archive before the dirty-state check");
    await getPage().screenshot({ path: join(out, "native-race-dirty.png") });
    await save(before.source.sha256);
    staleReview = await invoke("pptEditorTeachingReview", { sessionId });
    assert.deepEqual(staleReview.project, before);
    await copyFile(file, join(out, "native-race-first-save.pptx"));
  });
  await step("Actual second native edit and Save invalidate an already prepared page-association review", async () => {
    const reviewInput = { reviewId: staleReview.reviewId, bindings: before.pages.map((_, index) => index) };
    const firstHash = await hash(); positions.push(await move(1));
    await assert.rejects(invoke("pptEditorTeachingAdopt", reviewInput), /Save or reopen|changed/u);
    await save(firstHash);
    await assert.rejects(invoke("pptEditorTeachingAdopt", reviewInput), /changed|Review|review/u);
    const records = await readRecords();
    assert.deepEqual(records.find(row => row.ns === "coursewareProjects.v1").value, before);
    const teaching = getPage().locator(".courseware-teaching");
    await teaching.getByRole("button", { name: /Review saved PPTX changes|审核已保存的 PPTX 变更/ }).click();
    const review = getPage().locator(".courseware-source-review");
    const choices = review.locator("select");
    await expect(choices).toHaveCount(before.pages.length, { timeout: 120_000 });
    for (let index = 0; index < before.pages.length; index++) {
      await expect(choices.nth(index)).toHaveValue(""); await choices.nth(index).selectOption(String(index));
    }
    const adopt = review.getByRole("button", { name: /Use these associations|采用这些关联/ });
    await expect(adopt).toBeDisabled(); await review.getByRole("checkbox").check(); await adopt.click();
    await expect(review).toHaveCount(0, { timeout: 120_000 });
    associated = await open();
    assert.equal(associated.project.source.sha256, await hash());
    assert.notEqual(associated.project.source.sha256, staleReview.targetSha256);
    assert.deepEqual(associated.project.pages, before.pages.map(page => ({ ...page, reviewState: "review" })));
    await assert.rejects(invoke("pptEditorSnapshotCapture", scope(associated)), /COURSEWARE_REVIEW_REQUIRED|COURSEWARE_AUDIO_REQUIRED/u);
    await copyFile(file, join(out, "native-race-final.pptx"));
  });
  await step("Full restart retains the newest native source and adopted audio; old unadopted audio cannot attach", async () => {
    await stop(); await start(); await goToPage(0);
    const restored = await open(); assert.deepEqual(restored.project, associated.project);
    const recovered = { ...scope(restored), intentId: late.intentId };
    await invoke("pptEditorTtsArchive", recovered);
    await assert.rejects(invoke("pptEditorTtsAdopt", recovered), /STALE|stale|changed/u);
    assert.deepEqual((await open()).project, associated.project);
    assert.equal(fixture.result().requests, 2);
    assert.equal(await hash(), associated.project.source.sha256);
    report.nativeAudioConcurrency = { before, after: associated.project, staleReview, positions,
      lateIntentId: late.intentId, fixture: fixture.result(), paidCalls: false };
    report.savedSha256 = associated.project.source.sha256;
    await writeFile(join(out, "native-race-final.json"), JSON.stringify({ ...report.nativeAudioConcurrency, records: await readRecords() }, null, 2));
    await getPage().screenshot({ path: join(out, "native-race-restarted.png") });
  });
}
