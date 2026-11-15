import assert from "node:assert/strict";

/** Real sharing controls; only the public preload boundary supplies outcomes. */
export async function testShareRecovery({ page, expect, project, snapshot, IPC, report }) {
  const teamProjectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const unknown = { intentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", state: "unknown", receiptAware: true,
    selection: { projectId: project.projectId, snapshotId: snapshot.snapshotId,
      buildId: "a".repeat(64), manifestSha256: "b".repeat(64), teamProjectId, channel: "shared" } };
  await page.evaluate(({ channels, unknown, snapshot }) => {
    window.shareIntent = structuredClone(unknown);
    window.rejectRecovery = false;
    window.rejectStatusAuth = false;
    window.piDesktop.on = (_channel, listener) => {
      window.shareAuthListener = listener;
      return () => { if (window.shareAuthListener === listener) window.shareAuthListener = undefined; };
    };
    window.piDesktop.invoke = async (channel, payload) => {
      window.calls.push({ channel, payload });
      const ok = data => ({ ok: true, data });
      if (channel === channels.coursewareFixedShareStatus) {
        if (window.rejectStatusAuth) return { ok: false, error: { code: "AUTH_REQUIRED", message: "COURSEWARE_MEDIA_AUTH_REQUIRED" } };
        return ok({ intent: structuredClone(window.shareIntent) });
      }
      if (channel === channels.coursewareFixedShareRecover) {
        if (window.rejectRecovery) return { ok: false, error: { code: "NOT_CONFIRMED", message: "Remote publication is not confirmed" } };
        window.shareIntent.state = "bound";
        return ok({ intent: structuredClone(window.shareIntent) });
      }
      if (channel === channels.coursewareFixedShare) {
        window.shareIntent = structuredClone(unknown);
        return { ok: false, error: { code: "RESULT_UNKNOWN", message: "Share response was lost" } };
      }
      if (channel === channels.coursewareTeamProjects)
        return ok([{ projectId: unknown.selection.teamProjectId, role: "OWNER" }]);
      if (channel === channels.coursewareFixedCancel) return ok({ ok: true });
      if (channel === channels.pptEditorSnapshotCapture) return ok(snapshot);
      if (channel === channels.coursewareFixedBuild) return ok({ status: "ready", previewId: "preview-1", snapshot,
        buildRef: { buildId: unknown.selection.buildId, packageSha256: unknown.selection.buildId, snapshotId: snapshot.snapshotId }, report: {} });
      throw new Error(`Unexpected share-recovery IPC: ${channel}`);
    };
  }, { channels: IPC.invoke, unknown, snapshot });
  const render = () => page.evaluate(async project => window.renderView({ viewId: "view-1",
    pageId: project.pages[0].pageId, project }, true, "zh-CN"), project);
  const query = () => page.getByRole("button", { name: "查询分享结果", exact: true });
  const share = () => page.getByRole("button", { name: "共享到团队", exact: true });
  const step = async (name, action) => { await action(); report.checks.push(name); console.log("PASS", name); };
  const publications = () => page.evaluate(channel => window.calls.filter(call => call.channel === channel), IPC.invoke.coursewareFixedShare);

  await step("A reopened unknown share is visible and queryable without rebuilding a preview", async () => {
    await render();
    await expect(query()).toBeEnabled();
    await expect(page.getByText("分享结果尚未确认，请查询原分享结果。", { exact: true })).toBeVisible();
    await expect(page.getByText(/不能重新发布/)).toBeVisible();
    await expect(share()).toHaveCount(0);
    assert.deepEqual(await publications(), []);
  });
  await step("A failed query retains the original intent and never republishes", async () => {
    await page.evaluate(() => { window.rejectRecovery = true; });
    await query().click();
    await expect(page.getByRole("alert")).toContainText("Remote publication is not confirmed");
    await expect(query()).toBeEnabled();
    const calls = await page.evaluate(channel => window.calls.filter(call => call.channel === channel), IPC.invoke.coursewareFixedShareRecover);
    assert.deepEqual(calls, [{ channel: IPC.invoke.coursewareFixedShareRecover, payload: { sessionId: "chat-1", intentId: unknown.intentId } }]);
    assert.deepEqual(await publications(), []);
  });
  await step("Successful explicit reconciliation confirms the original binding without a new POST", async () => {
    await page.evaluate(() => { window.rejectRecovery = false; });
    await query().click();
    await expect(page.getByText("此前分享及原任务团队绑定已确认。", { exact: true })).toBeVisible();
    await expect(query()).toHaveCount(0);
    assert.deepEqual(await publications(), []);
  });
  await step("A lost share reply disables resubmission and panel remount reloads query recovery", async () => {
    await page.evaluate(() => { window.shareIntent = null; window.calls = []; });
    await render();
    await page.getByRole("button", { name: "构建预览", exact: true }).click();
    await page.getByRole("combobox", { name: "团队项目", exact: true }).selectOption(teamProjectId);
    await expect(share()).toBeEnabled(); await share().click();
    await expect(page.getByRole("alert")).toContainText("Share response was lost");
    await expect(query()).toBeEnabled(); await expect(share()).toBeDisabled();
    assert.equal((await publications()).length, 1);
    await render();
    await expect(query()).toBeEnabled(); await expect(share()).toHaveCount(0);
    await query().click();
    await expect(page.getByText("此前分享及原任务团队绑定已确认。", { exact: true })).toBeVisible();
    assert.equal((await publications()).length, 1);
  });
  await step("A local preview remains usable before login while sharing waits for fresh authorization", async () => {
    await page.evaluate(() => { window.shareIntent = null; window.rejectStatusAuth = true; window.calls = []; });
    await render();
    await page.getByRole("button", { name: "构建预览", exact: true }).click();
    await page.getByRole("combobox", { name: "团队项目", exact: true }).selectOption(teamProjectId);
    await expect(share()).toBeDisabled(); await expect(page.getByRole("alert")).toHaveCount(0);
    await page.evaluate(() => { window.rejectStatusAuth = false; window.shareAuthListener({ status: "authenticated" }); });
    await page.getByRole("combobox", { name: "团队项目", exact: true }).selectOption(teamProjectId);
    await expect(share()).toBeEnabled();
    assert.deepEqual(await publications(), []);
  });
}
