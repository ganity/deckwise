/** Real React effects and controls; native context and Host replies are fixtures. */
import assert from "node:assert/strict";

export async function testTeachingFollow({ page, expect, project, IPC, report }) {
  await page.evaluate(({ project, channels }) => {
    for (const [index, entry] of project.pages.entries()) entry.actions = [{ id: `speech-${index + 1}`, type: "speech", text: `Narration ${index + 1}` }];
    window.fixtureProject = project;
    window.initialProject = structuredClone(project);
    window.nativePage = 1;
    window.calls = [];
    window.viewNumber = 0;
    window.drafts = new Map(); window.teachingViews = new Map(); window.draftNumber = 0;
    window.activeReads = 0;
    window.maxReads = 0;
    window.piDesktop = {
      on: () => () => {},
      async invoke(channel, payload) {
        window.calls.push({ channel, payload });
        let data;
        if (channel === channels.pptEditorTeachingOpen) {
          data = { viewId: `view-${++window.viewNumber}`, pageNumber: window.nativePage,
            pageId: project.pages[window.nativePage - 1].pageId, project: structuredClone(project) };
          window.lastTeachingView = data;
          window.teachingViews.set(data.viewId, data);
          if (window.deferTeaching) await new Promise(resolve => { window.releaseTeaching = resolve; });
        } else if (channel === channels.pptEditorTeachingWrite) {
          if (payload.viewId !== window.lastTeachingView.viewId || payload.expectedTeachingRevision !== project.teachingRevision)
            throw new Error("Stale teaching write");
          project.pages[window.nativePage - 1].actions = structuredClone(payload.actions);
          project.teachingRevision = `revision-${window.viewNumber}`;
          data = { ...window.lastTeachingView, project: structuredClone(project) };
          window.teachingViews.set(data.viewId, data);
        } else if (channel === channels.pptEditorTeachingDraftGet || channel === channels.pptEditorTeachingDraftSet) {
          const view = window.teachingViews.get(payload.viewId);
          if (!view) throw new Error("Unknown draft view");
          if (window.failDraftRead && channel === channels.pptEditorTeachingDraftGet) throw new Error("Draft storage unavailable");
          if (channel === channels.pptEditorTeachingDraftSet) {
            if (window.deferDraft) await new Promise(resolve => { window.releaseDraft = resolve; });
            if (window.failDraftWrite) throw new Error("Draft write failed");
            const old = window.drafts.get(view.pageId);
            if ((old?.revision ?? null) !== payload.expectedRevision) throw new Error("Draft conflict");
            if (payload.draft) {
              if (JSON.stringify(view.project) !== JSON.stringify(project)) throw new Error("Teaching changed");
              window.drafts.set(view.pageId, { ...structuredClone(payload.draft), pageId: view.pageId,
                revision: `draft-${++window.draftNumber}`, baseline: structuredClone(view.project) });
            } else window.drafts.delete(view.pageId);
          }
          data = { draft: structuredClone(window.drafts.get(view.pageId) ?? null) };
        } else if (channel === channels.pptEditorGetContext) {
          window.maxReads = Math.max(window.maxReads, ++window.activeReads);
          data = { page: window.nativePage, readOnly: false };
          try {
            if (window.deferContext) await new Promise(resolve => { window.releaseContext = resolve; });
            if (window.failContext) throw new Error("Native context unavailable");
          } finally { window.activeReads--; }
        } else if (channel === channels.pptEditorNarrationReview) {
          data = { reviewId: "review-1", status: "needs-review", stale: false, actions: [{ id: "new", type: "speech", text: "Proposed narration" }],
            teaching: { viewId: `view-${++window.viewNumber}`, pageNumber: window.nativePage,
              pageId: project.pages[window.nativePage - 1].pageId, project: structuredClone(project) } };
        } else if (channel === channels.pptEditorTeachingReview) {
          data = { reviewId: "source-review-1", pageCount: project.pages.length,
            targetSha256: "b".repeat(64), project: structuredClone(project) };
        } else if ([channels.coursewareFixedCancel, channels.pptEditorImageClear, channels.pptEditorVisualClear].includes(channel)) data = { ok: true };
        else throw new Error(`Unexpected IPC: ${channel}`);
        return { ok: true, data };
      },
    };
  }, { project: structuredClone(project), channels: IPC.invoke });
  const load = () => page.getByRole("button", { name: "Load current page", exact: true });
  const speech = () => page.getByRole("textbox", { name: "Speech 1", exact: true });
  const expectPage = async number => {
    await expect(page.getByText(`Narration for page ${number}`, { exact: true })).toBeVisible();
    await expect(speech()).toHaveValue(`Narration ${number}`);
  };
  const changePage = number => page.evaluate(number => { window.nativePage = number; }, number);
  const render = async (enabled = true, remount = true) => {
    await page.evaluate(async ({ enabled, remount }) => { await window.renderView(null, enabled, "en", remount); }, { enabled, remount });
    await expect(load()).toBeVisible();
  };
  const mount = async () => {
    await page.evaluate(() => {
      Object.assign(window.fixtureProject, structuredClone(window.initialProject));
      window.drafts.clear(); window.failDraftRead = false; window.failDraftWrite = false; window.deferDraft = false;
      window.nativePage = 1; window.deferContext = false; window.failContext = false; window.deferTeaching = false;
    });
    await render(); await load().click(); await expectPage(1);
  };
  const contextCount = () => page.evaluate(channel => window.calls.filter(call => call.channel === channel).length, IPC.invoke.pptEditorGetContext);
  const step = async (name, run) => { await run(); report.checks.push(name); console.log("PASS", name); };

  await step("Initial load stays explicit; loaded narration follows navigation without another click", async () => {
    await render(); await page.waitForTimeout(1150);
    assert.equal(await contextCount(), 0);
    await load().click(); await expectPage(1);
    await changePage(2); await expectPage(2);
    await changePage(1); await expectPage(1);
  });
  await step("Unsaved narration survives navigation; discard resumes following without a Host write", async () => {
    await speech().fill("Unsaved teacher draft");
    await changePage(2); await page.waitForTimeout(1150);
    await expect(speech()).toHaveValue("Unsaved teacher draft");
    await expect(page.getByText("Narration for page 1", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Discard draft", exact: true }).click();
    await expectPage(2);
    assert(!(await page.evaluate(() => window.calls)).some(call => call.channel === IPC.invoke.pptEditorTeachingWrite));
  });
  await step("A late context read cannot replace a draft typed while that read was pending", async () => {
    await mount();
    await page.evaluate(() => { window.deferContext = true; window.nativePage = 2; window.releaseContext = null; });
    await page.waitForFunction(() => !!window.releaseContext);
    await speech().fill("Draft created during native read");
    await page.evaluate(() => { window.deferContext = false; window.releaseContext(); });
    await page.waitForTimeout(100);
    await expect(speech()).toHaveValue("Draft created during native read");
    await expect(page.getByText("Narration for page 1", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Discard draft", exact: true }).click();
    await expectPage(2);
  });
  await step("Native reads are serial and stop after disabling or remounting the editor", async () => {
    await mount();
    await page.evaluate(() => { window.deferContext = true; window.nativePage = 2; window.releaseContext = null; });
    await page.waitForFunction(() => !!window.releaseContext);
    await page.waitForTimeout(1150); assert.equal(await page.evaluate(() => window.maxReads), 1);
    await render(false, false); await expect(load()).toBeDisabled();
    await render(true, false); await expect(load()).toBeEnabled();
    await page.waitForTimeout(1150); assert.equal(await page.evaluate(() => window.maxReads), 1);
    await render(false, false);
    await page.evaluate(() => { window.deferContext = false; window.releaseContext(); });
    await page.waitForTimeout(100); await expectPage(1);
    const count = await contextCount(); await page.waitForTimeout(1150); assert.equal(await contextCount(), count);
    await render(); await expect(speech()).toHaveCount(0);
    await load().click(); await expectPage(2);
  });
  await step("Read failures are visible, do not loop and recover through explicit reload", async () => {
    await mount(); await page.evaluate(() => { window.failContext = true; });
    await expect(page.getByRole("alert")).toContainText("Native context unavailable");
    const count = await contextCount(); await page.waitForTimeout(1150); assert.equal(await contextCount(), count);
    await page.evaluate(() => { window.failContext = false; window.nativePage = 2; });
    await load().click(); await expectPage(2); await expect(page.getByRole("alert")).toHaveCount(0);
    await changePage(1); await expectPage(1);
  });
  await step("Reviewing a narration candidate pauses following and preserves the proposed text", async () => {
    const review = page.locator(".courseware-narration-review");
    await review.locator("input").fill("candidate-1");
    await review.getByRole("button").click();
    await expect(review).toContainText("Proposed narration");
    await changePage(2); const count = await contextCount(); await page.waitForTimeout(1150);
    assert.equal(await contextCount(), count);
    await expect(review).toContainText("Proposed narration");
    await expect(review.getByText("Narration for page 1", { exact: true })).toBeVisible();
  });
  const writes = () => page.evaluate(channel => window.calls.filter(call => call.channel === channel), IPC.invoke.pptEditorTeachingWrite);
  await step("Saving refuses another native page, then revalidates a returned page against its exact baseline", async () => {
    await mount(); await speech().fill("Teacher draft after navigation"); await changePage(2);
    const before = (await writes()).length;
    await page.getByRole("button", { name: "Save narration", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Teaching changed");
    assert.equal((await writes()).length, before); await expect(speech()).toHaveValue("Teacher draft after navigation");
    await changePage(1); await page.getByRole("button", { name: "Save narration", exact: true }).click();
    await expect(page.getByRole("button", { name: "Save narration", exact: true })).toBeDisabled();
    await expect(page.getByRole("alert")).toHaveCount(0); await expect(speech()).toHaveValue("Teacher draft after navigation");
    assert.equal((await writes()).length, before + 1);
    const call = (await writes()).at(-1), current = await page.evaluate(() => window.lastTeachingView);
    assert.equal(call.payload.viewId, current.viewId);
    assert.equal(call.payload.expectedTeachingRevision, current.project.teachingRevision);
  });
  await step("Concurrent teaching changes preserve the draft and never dispatch an overwrite", async () => {
    await mount(); await speech().fill("Local teacher draft");
    await page.evaluate(() => { window.fixtureProject.teachingRevision = "concurrent-revision"; });
    const before = (await writes()).length;
    await page.getByRole("button", { name: "Save narration", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Teaching changed");
    await expect(speech()).toHaveValue("Local teacher draft"); assert.equal((await writes()).length, before);
  });
  await step("Unmounting during the save recheck prevents a late Host write", async () => {
    await mount(); await speech().fill("Draft in closing panel");
    await page.evaluate(() => { window.deferTeaching = true; window.releaseTeaching = null; });
    const before = (await writes()).length;
    await page.getByRole("button", { name: "Save narration", exact: true }).click();
    await page.waitForFunction(() => !!window.releaseTeaching);
    await render(); await page.evaluate(() => { window.deferTeaching = false; window.releaseTeaching(); });
    await page.waitForTimeout(100); await expect(speech()).toHaveCount(0); assert.equal((await writes()).length, before);
  });
  await step("Unsent page instructions survive navigation and clearing them resumes following", async () => {
    await mount();
    const instruction = page.getByRole("textbox", { name: "本页讲解要求（可选）" });
    await instruction.fill("Keep this request on the original page");
    await changePage(2); await page.waitForTimeout(1150);
    await expect(instruction).toHaveValue("Keep this request on the original page");
    await expect(page.getByText("Narration for page 1", { exact: true })).toBeVisible();
    await instruction.fill(""); await expectPage(2);
  });
  const stored = () => page.getByText("Draft stored locally for recovery. Save narration to apply it.", { exact: true });
  await step("Narration and unsent instructions recover after remount without changing canonical teaching", async () => {
    await mount();
    await page.getByRole("textbox", { name: "本页讲解要求（可选）" }).fill("Preserve the teacher request");
    await speech().fill("Recover this unfinished narration"); await expect(stored()).toBeVisible();
    const before = await page.evaluate(() => structuredClone(window.fixtureProject));
    await render(); await load().click();
    await expect(speech()).toHaveValue("Recover this unfinished narration");
    await expect(page.getByRole("textbox", { name: "本页讲解要求（可选）" })).toHaveValue("Preserve the teacher request");
    await expect(page.getByText("Recovered local draft. Save narration to apply it.", { exact: true })).toBeVisible();
    assert.deepEqual(await page.evaluate(() => window.fixtureProject), before);
    await page.getByRole("button", { name: "Discard draft", exact: true }).click();
    await render(); await load().click(); await expectPage(1);
    assert.equal(await page.evaluate(() => window.drafts.size), 0);
  });
  await step("Formal narration save clears the stored draft and cannot resurrect it on remount", async () => {
    await mount(); await speech().fill("Saved replacement"); await expect(stored()).toBeVisible();
    await page.getByRole("button", { name: "Save narration", exact: true }).click();
    await expect(page.getByRole("button", { name: "Save narration", exact: true })).toBeDisabled();
    await expect(load()).toBeEnabled(); assert.equal(await page.evaluate(() => window.drafts.size), 0);
    await render(); await load().click(); await expect(speech()).toHaveValue("Saved replacement");
    await expect(page.getByText("Recovered local draft. Save narration to apply it.", { exact: true })).toHaveCount(0);
  });
  await step("Stale drafts stay readable but cannot overwrite a concurrent teaching version", async () => {
    await mount(); await speech().fill("Old local version"); await expect(stored()).toBeVisible();
    await page.evaluate(() => {
      window.fixtureProject.teachingRevision = "newer-version";
      window.fixtureProject.pages[0].actions[0].text = "New canonical version";
    });
    await render(); await load().click();
    await expect(speech()).toHaveValue("New canonical version"); await expect(speech()).toBeDisabled();
    await expect(page.getByRole("textbox", { name: "Previous recovery draft" })).toHaveValue("Old local version");
    await expect(page.getByRole("button", { name: "Save narration", exact: true })).toBeDisabled();
    assert.equal(await page.evaluate(() => window.drafts.size), 1);
    await page.getByRole("button", { name: "Discard draft", exact: true }).click();
    await expect(speech()).toBeEnabled(); await expect(speech()).toHaveValue("New canonical version");
  });
  await step("Storage failures are visible and never claim an acknowledged recovery copy", async () => {
    await mount(); await page.evaluate(() => { window.failDraftWrite = true; });
    await speech().fill("Still in memory");
    await expect(page.getByRole("alert")).toContainText("Draft write failed");
    await expect(stored()).toHaveCount(0); await expect(speech()).toHaveValue("Still in memory");
    await expect(page.getByRole("button", { name: "Review saved PPTX changes", exact: true })).toBeDisabled();
    assert.equal(await page.evaluate(() => window.drafts.size), 0);
    await page.evaluate(() => { window.failDraftWrite = false; window.failDraftRead = true; });
    await render(); await load().click(); await expect(page.getByRole("alert")).toContainText("Draft storage unavailable");
    await expect(speech()).toBeDisabled();
    await page.evaluate(() => { window.failDraftRead = false; });
    await load().click(); await expect(speech()).toBeEnabled();
  });
  await step("Pending draft writes are serial and retain the final text", async () => {
    await mount(); await page.evaluate(() => { window.deferDraft = true; window.releaseDraft = null; });
    await speech().fill("First pending text"); await page.waitForFunction(() => !!window.releaseDraft);
    await speech().fill("Final pending text");
    await expect(page.getByText("Saving local recovery draft…", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Review saved PPTX changes", exact: true })).toBeDisabled();
    await page.evaluate(() => { window.deferDraft = false; window.releaseDraft(); });
    await expect(stored()).toBeVisible();
    await render(); await load().click(); await expect(speech()).toHaveValue("Final pending text");
  });
  await step("Saved-source review preserves an acknowledged unfinished draft and cancel recovers it", async () => {
    await mount(); await speech().fill("Retain this draft through source reassociation"); await expect(stored()).toBeVisible();
    const before = await page.evaluate(() => structuredClone(window.fixtureProject));
    const start = page.getByRole("button", { name: "Review saved PPTX changes", exact: true });
    await expect(start).toBeEnabled(); await start.click();
    await expect(page.locator(".courseware-source-review")).toBeVisible();
    assert.deepEqual(await page.evaluate(() => window.fixtureProject), before);
    assert.equal(await page.evaluate(() => window.drafts.size), 1);
    await page.locator(".courseware-source-review").getByRole("button", { name: "Cancel review", exact: true }).click();
    await load().click(); await expect(speech()).toHaveValue("Retain this draft through source reassociation");
    await expect(page.getByText("Recovered local draft. Save narration to apply it.", { exact: true })).toBeVisible();
  });
  assert.equal(await page.evaluate(() => window.maxReads), 1);
  await render(false);
}
