/** Exercise the real teaching parent and audio task child through finite preload replies. */
import assert from "node:assert/strict";

export async function testTtsTasks({ page, expect, project, IPC, report }) {
  const view = { viewId: "view-1", pageNumber: 1, pageId: project.pages[0].pageId, project: structuredClone(project) };
  view.project.pages[0].actions = [{ id: "speech-1", type: "speech", text: "Good! 小朋友😀" }];
  const task = { intentId: "intent-1", pageId: view.pageId, actionId: "speech-1", model: "fixture-tts", voice: "teacher",
    phase: "submitted", current: true, audioReady: false, task: null };
  const adopted = structuredClone(view); adopted.project.teachingRevision = "T9";
  adopted.project.pages[0].actions[0].audioAssetId = `tts-${"a".repeat(64)}`;
  adopted.project.pages[0].reviewState = "review";
  await page.evaluate(({ channels, authEvent, adopted }) => {
    window.listeners = new Map(); window.calls = []; window.adopted = adopted;
    window.piDesktop = {
      on(channel, listener) {
        const listeners = window.listeners.get(channel) ?? new Set();
        listeners.add(listener); window.listeners.set(channel, listeners);
        return () => { listeners.delete(listener); if (!listeners.size) window.listeners.delete(channel); };
      },
      async invoke(channel, payload) {
        window.calls.push({ channel, payload });
        let data;
        if (channel === channels.pptEditorTeachingOpen) data = structuredClone(window.testView);
        else if (channel === channels.pptEditorTeachingDraftGet || channel === channels.pptEditorTeachingDraftSet) data = { draft: null };
        else if (channel === channels.pptEditorGetContext) data = { page: window.testView.pageNumber, readOnly: false };
        else if (channel === channels.pptEditorTtsModels) data = [{ model: "fixture-tts", voices: ["teacher"], providerDefaultVoice: true }];
        else if (channel === channels.pptEditorTtsPrepare) data = { intentId: "new-intent", pageId: window.testView.pageId,
          actionId: payload.actionId, model: payload.model, voice: payload.voice, phase: "prepared", current: true, audioReady: false, task: null };
        else if (channel === channels.pptEditorTtsQuote) data = { quoteId: "quote-1", intentId: payload.intentId,
          model: "fixture-tts", voice: null, maxPoints: 5, maxChars: 4000, expiresAt: "2099-01-01T00:00:00Z" };
        else if (channel === channels.pptEditorTtsSubmitConfirmed) data = { intentId: payload.intentId, pageId: window.testView.pageId,
          actionId: "speech-1", model: "fixture-tts", voice: null, phase: "submitted", current: true, audioReady: false, task: null };
        else if (channel === channels.pptEditorTtsList) data = structuredClone(window.testTasks);
        else if (channel === channels.pptEditorTtsStatus) data = { ...window.testTasks.find((entry) => entry.intentId === payload.intentId),
          task: { state: "ready", feeState: "settled", reservedPoints: 7, actualPoints: 5, errorCode: null } };
        else if (channel === channels.pptEditorTtsArchive) data = { intentId: payload.intentId, archived: true, durationMs: 1200, audioReady: false };
        else if (channel === channels.pptEditorTtsAdopt) data = structuredClone(window.adopted);
        else if ([channels.coursewareFixedCancel, channels.pptEditorImageClear, channels.pptEditorVisualClear].includes(channel)) data = { ok: true };
        else throw new Error(`Unexpected IPC: ${channel}`);
        if (window.deferChannel === channel) await new Promise((resolve) => { window.releaseReply = resolve; });
        if (window.rejectChannel === channel) return { ok: false, error: { code: "COURSEWARE_TTS_BINDING_CHANGED", message: "COURSEWARE_TTS_BINDING_CHANGED" } };
        return { ok: true, data };
      },
    };
    window.authChange = () => { for (const listener of [...(window.listeners.get(authEvent) ?? [])]) listener({ status: "signed-out" }); };
  }, { channels: IPC.invoke, authEvent: IPC.event.authChanged, adopted });
  const loadPage = () => page.getByRole("button", { name: "Load current page", exact: true });
  const scope = () => page.getByRole("region", { name: "Narration audio" });
  const loadTasks = () => scope().getByRole("button", { name: "Load this page’s audio requests", exact: true });
  const archive = () => scope().getByRole("button", { name: "Retrieve and verify audio", exact: true });
  const adopt = () => scope().getByRole("button", { name: "Adopt audio", exact: true });
  const mount = async (tasks = [task], data = view) => {
    await page.evaluate(async ({ tasks, data }) => {
      window.testTasks = tasks; window.testView = data; window.deferChannel = null; window.rejectChannel = null; window.releaseReply = null;
      await window.renderView(data);
    }, { tasks, data });
    await expect(loadPage()).toBeEnabled(); await loadPage().click(); await expect(loadTasks()).toBeEnabled();
    await page.evaluate(() => { window.calls = []; });
  };
  const calls = async () => (await page.evaluate(() => window.calls)).filter(({ channel }) =>
    ![IPC.invoke.pptEditorImageClear, IPC.invoke.pptEditorVisualClear, IPC.invoke.pptEditorGetContext, IPC.invoke.pptEditorTeachingDraftGet].includes(channel));
  const step = async (name, run) => { await run(); report.checks.push(name); console.log("PASS", name); };
  await step("Existing task list is explicit, current-page scoped and empty-account aware", async () => {
    await mount([]); assert.deepEqual(await calls(), []);
    await loadTasks().click(); await expect(scope()).toContainText("No narration audio requests for this page.");
    await mount([{ ...task, pageId: "other-page" }]); await loadTasks().click(); await expect(scope()).toContainText("No narration audio requests");
  });
  await step("Prepared and unknown requests can be queried without submission or adoption", async () => {
    await mount([{ ...task, phase: "prepared" }]); await loadTasks().click(); await expect(archive()).toBeDisabled();
    await expect(adopt()).toHaveCount(0);
    await mount([{ ...task, phase: "submission-unknown" }]); await loadTasks().click();
    await expect(scope()).toContainText("Querying never resubmits"); await expect(archive()).toBeDisabled();
    await scope().getByRole("button", { name: "Check status", exact: true }).click();
    await expect(scope()).toContainText("Reserved: 7 points · Actual: 5 · Settled");
    assert.deepEqual((await calls()).map((entry) => entry.channel), [IPC.invoke.pptEditorTtsList, IPC.invoke.pptEditorTtsStatus]);
  });
  await step("Retrieval blocks parent edits, does not adopt and requires a separate unchecked confirmation", async () => {
    await mount(); await loadTasks().click();
    await page.evaluate((channel) => { window.deferChannel = channel; }, IPC.invoke.pptEditorTtsArchive);
    await archive().click(); await page.waitForFunction(() => !!window.releaseReply);
    await expect(loadPage()).toBeDisabled(); await expect(page.getByRole("textbox").last()).toBeDisabled();
    await expect(page.getByRole("checkbox", { name: "Lock this page" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Build preview", exact: true })).toBeDisabled();
    await page.evaluate(() => { window.releaseReply(); });
    await expect(scope()).toContainText("1200 ms"); await expect(loadPage()).toBeEnabled();
    await expect(scope().getByRole("checkbox")).not.toBeChecked(); await expect(adopt()).toBeDisabled();
    assert(!(await calls()).some((entry) => entry.channel === IPC.invoke.pptEditorTtsAdopt));
    await scope().getByRole("checkbox").check(); await expect(adopt()).toBeEnabled(); await adopt().click();
    await expect(page.getByRole("button", { name: "Confirm this page", exact: true })).toBeEnabled();
    await expect(scope().locator("article")).toHaveCount(0);
    assert.deepEqual((await calls()).filter((entry) => entry.channel !== IPC.invoke.coursewareFixedCancel), [
      { channel: IPC.invoke.pptEditorTtsList, payload: { viewId: "view-1", expectedTeachingRevision: "T8" } },
      { channel: IPC.invoke.pptEditorTtsArchive, payload: { viewId: "view-1", expectedTeachingRevision: "T8", intentId: "intent-1" } },
      { channel: IPC.invoke.pptEditorTtsAdopt, payload: { viewId: "view-1", expectedTeachingRevision: "T8", intentId: "intent-1" } },
    ]);
  });
  await step("Version-only stale requests remain explicitly adoptable; locked or removed segments cannot adopt", async () => {
    await mount([{ ...task, current: false }]); await loadTasks().click();
    await expect(scope()).toContainText("a version change alone does not require regeneration");
    await archive().click(); await scope().getByRole("checkbox").check(); await expect(adopt()).toBeEnabled();
    for (const locked of [true, false]) {
      const data = structuredClone(view); data.project.pages[0].locked = locked;
      if (!locked) data.project.pages[0].actions = [];
      await mount([task], data); await loadTasks().click(); await archive().click();
      await expect(scope().getByRole("checkbox")).toBeDisabled(); await expect(adopt()).toBeDisabled();
    }
  });
  await step("Account changes clear private rows and ignore late archive and adoption replies", async () => {
    for (const channel of [IPC.invoke.pptEditorTtsArchive, IPC.invoke.pptEditorTtsAdopt]) {
      await mount(); await loadTasks().click();
      if (channel === IPC.invoke.pptEditorTtsAdopt) { await archive().click(); await scope().getByRole("checkbox").check(); }
      await page.evaluate((channel) => { window.deferChannel = channel; }, channel);
      await (channel === IPC.invoke.pptEditorTtsArchive ? archive() : adopt()).click();
      await page.waitForFunction(() => !!window.releaseReply); await page.evaluate(() => { window.authChange(); window.releaseReply(); });
      await expect(scope().locator("article")).toHaveCount(0); await expect(loadPage()).toBeEnabled();
      await expect(page.getByRole("button", { name: "Page confirmed", exact: true })).toBeVisible();
    }
  });
  await step("Draft edits, disabled editor and remount clear confirmation and fence late task replies", async () => {
    await mount(); await loadTasks().click(); await archive().click(); await scope().getByRole("checkbox").check();
    await page.getByRole("textbox").last().fill("Changed narration");
    await expect(scope().locator("article")).toHaveCount(0); await expect(loadTasks()).toBeDisabled();
    await page.getByRole("button", { name: "Discard draft", exact: true }).click(); await expect(loadTasks()).toBeEnabled();
    for (const remount of [false, true]) {
      await mount(); await loadTasks().click();
      await page.evaluate((channel) => { window.deferChannel = channel; }, IPC.invoke.pptEditorTtsArchive);
      await archive().click(); await page.waitForFunction(() => !!window.releaseReply);
      await page.evaluate(async ({ view, remount }) => { await window.renderView(view, false, "en", remount); }, { view, remount });
      await expect(loadPage()).toBeDisabled(); await page.evaluate(() => { window.releaseReply(); });
      await expect(page.getByText(/Audio verified and stored locally/)).toHaveCount(0);
      assert.equal(await page.evaluate(() => [...window.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0)), remount ? 1 : 2);
    }
  });
  await step("Archive and adoption failures stay visible and retry never starts paid generation", async () => {
    await mount(); await loadTasks().click();
    await page.evaluate((channel) => { window.rejectChannel = channel; }, IPC.invoke.pptEditorTtsArchive);
    await archive().click(); await expect(scope().getByRole("alert")).toContainText("COURSEWARE_TTS_BINDING_CHANGED");
    await expect(adopt()).toHaveCount(0);
    await page.evaluate(() => { window.rejectChannel = null; }); await archive().click();
    await scope().getByRole("checkbox").check();
    await page.evaluate((channel) => { window.rejectChannel = channel; }, IPC.invoke.pptEditorTtsAdopt);
    await adopt().click(); await expect(scope().getByRole("alert")).toContainText("COURSEWARE_TTS_BINDING_CHANGED");
    await expect(scope().getByRole("checkbox")).not.toBeChecked(); await expect(adopt()).toBeDisabled();
    const allowed = new Set([IPC.invoke.pptEditorTtsList, IPC.invoke.pptEditorTtsStatus, IPC.invoke.pptEditorTtsArchive,
      IPC.invoke.pptEditorTtsAdopt, IPC.invoke.coursewareFixedCancel]);
    assert((await calls()).every((entry) => allowed.has(entry.channel)));
  });
  await step("New audio requires a displayed quote and fee confirmation in the real parent/child panel", async () => {
    await mount([]);
    await scope().getByRole("button", { name: "Load available voices", exact: true }).click();
    await scope().getByRole("combobox", { name: /^Narration segment/ }).selectOption("speech-1");
    await scope().getByRole("combobox", { name: /^Model/ }).selectOption("fixture-tts");
    await scope().getByRole("button", { name: "View quote (no charge)", exact: true }).click();
    const generate = scope().getByRole("button", { name: "Confirm and generate audio", exact: true });
    await expect(generate).toBeDisabled();
    assert(!(await calls()).some(entry => entry.channel === IPC.invoke.pptEditorTtsSubmitConfirmed));
    await scope().getByLabel("I confirm the quoted maximum cost for this segment.", { exact: true }).check();
    await expect(generate).toBeEnabled();
    await page.evaluate(channel => { window.deferChannel = channel; }, IPC.invoke.pptEditorTtsSubmitConfirmed);
    await generate.click();
    await page.waitForFunction(() => !!window.releaseReply);
    await expect(loadPage()).toBeDisabled();
    await expect(scope().getByRole("button", { name: "Load available voices", exact: true })).toBeDisabled();
    await page.evaluate(() => window.releaseReply());
    await expect(loadPage()).toBeEnabled();
    await expect(generate).toHaveCount(0);
    const submitted = (await calls()).filter(entry => entry.channel === IPC.invoke.pptEditorTtsSubmitConfirmed);
    assert.equal(submitted.length, 1);
    assert.deepEqual(submitted[0].payload, { viewId: "view-1", expectedTeachingRevision: view.project.teachingRevision,
      intentId: "new-intent", quoteId: "quote-1" });
  });

}
