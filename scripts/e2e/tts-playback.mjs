import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Continuous product controls; provider selection and cost bounds belong to the dedicated runner. */
export async function testChatTtsPlayback({ app, page, expect, invoke, sessionId, goToPage, project, out, step, report }) {
  const teaching = page.locator(".courseware-teaching");
  const load = () => teaching.getByRole("button", { name: /Load current page|读取当前页讲解/ });
  const synthetic = process.env.DECKWISE_E2E_LOOPBACK_TTS === "1";
  assert(synthetic !== (process.env.DECKWISE_E2E_REAL_TTS === "1"));
  const model = synthetic ? "loopback-courseware" : process.env.DECKWISE_E2E_TTS_MODEL;
  const voice = synthetic ? "loopback_teacher" : process.env.DECKWISE_E2E_TTS_VOICE;
  assert(model && voice);
  if (!synthetic) assert(project.pages.flatMap((entry) => entry.actions)
    .filter((action) => action.type === "speech").length <= 4, "Real TTS acceptance is limited to four one-point segments");
  report.mediaProviderFixture = synthetic;
  report.continuousTts = [];
  const original = structuredClone(project);
  for (let index = 0; index < original.pages.length; index++) {
    await goToPage(index);
    await load().click();
    await expect(load()).toBeEnabled({ timeout: 120_000 });
    await expect(teaching).toContainText(new RegExp(`第 ${index + 1} 页讲解|Narration for page ${index + 1}`));
    for (const speech of original.pages[index].actions.filter((action) => action.type === "speech")) {
      await step(`Page ${index + 1} segment ${speech.id}: quote, confirm, query, archive and adopt through visible controls`, async () => {
        const tts = teaching.locator(".courseware-tts-tasks");
        await tts.getByRole("button", { name: /读取可用模型与音色|Load available models/ }).click();
        await expect(tts.locator("select").nth(1).locator("option").filter({ hasText: model })).toHaveCount(1);
        await tts.locator("select").nth(0).selectOption(speech.id);
        await tts.locator("select").nth(1).selectOption(model);
        await tts.locator("select").nth(2).selectOption(voice);
        await tts.getByRole("button", { name: /查看报价|Get quote/ }).click();
        const submit = tts.getByRole("button", { name: /确认费用并生成配音|Confirm fee and generate/ });
        await expect(tts).toContainText(/最高 1 积分|Maximum 1 point/);
        await expect(submit).toBeDisabled();
        await tts.getByRole("checkbox", { name: /确认按此费用上限|Confirm this fee/ }).check();
        if (!synthetic) report.paidCalls = report.paidMediaCalls = true;
        await submit.click();
        const article = tts.locator("article").filter({ hasText: speech.text });
        await expect(article).toHaveCount(1);
        const check = article.getByRole("button", { name: /查询状态|Check status/ });
        await expect(check).toBeEnabled();
        await expect.poll(async () => {
          const errors = await tts.getByRole("alert").allTextContents();
          assert.equal(errors.length, 0, errors.join("\n"));
          assert(!await article.getByText(/结果不明|尚未确认|生成失败|Submission unconfirmed|Generation failed/).count(), "Do not resubmit an unknown or failed result");
          await check.click();
          await expect(check).toBeEnabled();
          return article.getByText(/音频可获取|Audio available/).isVisible();
        }, { timeout: 120_000, intervals: [1000, 2000] }).toBe(true);
        await expect(article).toContainText(/已结算|Settled/);
        await article.getByRole("button", { name: /获取并校验音频|Retrieve and verify audio/ }).click();
        await expect(article).toContainText(/音频已校验并保存|Audio verified/);
        const adopt = article.getByRole("button", { name: /采用配音|Adopt audio/ });
        await expect(adopt).toBeDisabled();
        await article.getByRole("checkbox", { name: /将这份音频应用|Apply this audio/ }).check();
        await adopt.click();
        await expect(article).toHaveCount(0);
        report.continuousTts.push({ page: index + 1, actionId: speech.id });
      });
    }
    const confirm = teaching.getByRole("button", { name: /确认本页教学内容|Confirm this page/, exact: true });
    if (await confirm.count()) {
      await expect(confirm).toBeEnabled();
      await confirm.click();
      await expect(load()).toBeEnabled({ timeout: 120_000 });
    }
  }
  await expect(load()).toBeEnabled({ timeout: 120_000 });
  project = (await invoke("pptEditorTeachingOpen", { sessionId })).project;
  assert(project.pages.every((entry) => entry.reviewState === "ready"));
  assert.deepEqual(project.source, original.source);
  for (const entry of report.continuousTts) {
    const action = project.pages[entry.page - 1].actions.find((action) => action.id === entry.actionId);
    const before = original.pages[entry.page - 1].actions.find((action) => action.id === entry.actionId);
    assert.equal(action.text, before.text);
    assert.match(action.audioAssetId, /^tts-[a-f0-9]{64}$/);
    entry.audioAssetId = action.audioAssetId;
  }
  await goToPage(0);
  await load().click();
  await testAdoptedPlayback({ app, page, expect, project, out, step, report });
  return project;
}

/** Native edits keep verified audio only after explicit saved-source review. */
export async function testNativeAudioSave({ page, expect, invoke, sessionId, goToPage, project, file, out, step, report }) {
  const teaching = page.locator(".courseware-teaching");
  const load = () => teaching.getByRole("button", { name: /Load current page|读取当前页讲解/ });
  let associated;
  await writeFile(join(out, "audio-before-native-save.json"), JSON.stringify(project, null, 2));
  await step("Actual native edit and save preserve narration/audio only after explicit page associations", async () => {
    const context = await invoke("pptEditorGetContext");
    await invoke("pptEditorExecute", { projectId: context.projectId, documentId: context.documentId,
      sessionId: context.sessionId, editGeneration: context.editGeneration, requestId: randomUUID(),
      tool: "add_slide_text", input: { text: "EDIT_AFTER_AUDIO_ADOPTION" } });
    await assert.rejects(invoke("pptEditorTeachingOpen", { sessionId }), /Save or reopen/);
    await invoke("pptEditorSave");
    await expect(load()).toBeEnabled({ timeout: 120_000 });
    const savedSha256 = createHash("sha256").update(await readFile(file)).digest("hex");
    assert.notEqual(savedSha256, project.source.sha256);
    await assert.rejects(invoke("pptEditorTeachingOpen", { sessionId }), /COURSEWARE_CONFLICT.*reconcile/);
    await teaching.getByRole("button", { name: /Review saved PPTX changes|审核已保存的 PPTX 变更/ }).click();
    const review = page.locator(".courseware-source-review");
    const choices = review.locator("select");
    await expect(choices).toHaveCount(project.pages.length, { timeout: 120_000 });
    const confirm = review.getByRole("button", { name: /Use these associations|采用这些关联/ });
    for (let index = 0; index < project.pages.length; index++) {
      await expect(choices.nth(index)).toHaveValue("");
      await choices.nth(index).selectOption(String(index));
    }
    await expect(confirm).toBeDisabled();
    await review.locator("input[type=checkbox]").check();
    await page.screenshot({ path: join(out, "audio-native-associations.png") });
    await confirm.click();
    await expect(review).toHaveCount(0, { timeout: 120_000 });
    associated = (await invoke("pptEditorTeachingOpen", { sessionId })).project;
    assert.equal(associated.source.sha256, savedSha256);
    assert.notEqual(associated.teachingRevision, project.teachingRevision);
    assert.deepEqual(associated.pages, project.pages.map(entry => ({ ...entry, reviewState: "review" })));
    assert.equal(createHash("sha256").update(await readFile(file)).digest("hex"), savedSha256);
    report.savedSha256 = savedSha256;
    report.nativeAudioSave = { sourceSha256: savedSha256, previousSourceSha256: project.source.sha256,
      explicitAssociations: true, speechAndAudioPreserved: true };
  });
  await step("Teacher confirms the edited pages without another audio request", async () => {
    for (let index = 0; index < associated.pages.length; index++) {
      await goToPage(index); await load().click();
      const confirm = teaching.getByRole("button", { name: /确认本页教学内容|Confirm this page/, exact: true });
      await expect(confirm).toBeEnabled({ timeout: 120_000 }); await confirm.click();
      await expect(load()).toBeEnabled({ timeout: 120_000 });
    }
    const confirmed = (await invoke("pptEditorTeachingOpen", { sessionId })).project;
    assert.deepEqual(confirmed.pages, project.pages);
    assert.deepEqual(confirmed.source, associated.source);
    associated = confirmed;
    await writeFile(join(out, "audio-after-native-save.json"), JSON.stringify(associated, null, 2));
    await goToPage(0); await load().click(); await expect(load()).toBeEnabled({ timeout: 120_000 });
  });
  return associated;
}

/** Playback-only continuation never creates a media task. */
export async function testAdoptedPlayback({ app, page, expect, project, out, step, report, exercisePlayer }) {
  await step("Same-session teaching controls freeze, build and play the adopted audio", async () => {
    const preview = page.locator(".courseware-playback");
    const build = preview.getByRole("button", { name: /Build preview|构建预览/, exact: true });
    await expect(build).toBeEnabled();
    await build.click();
    const approve = preview.getByRole("button", { name: /Continue building|确认并继续构建/ });
    const play = preview.getByRole("button", { name: /Play preview|播放预览/ });
    await expect.poll(async () => {
      const errors = await preview.getByRole("alert").allTextContents();
      assert.equal(errors.length, 0, errors.join("\n"));
      return await play.isVisible() ? "ready" : await approve.isVisible() ? "review" : "pending";
    }, { timeout: 90_000 }).not.toBe("pending");
    if (await approve.isVisible()) {
      for (const checkbox of await preview.getByRole("checkbox").all()) await checkbox.check();
      await approve.click();
    }
    await expect(play).toBeEnabled();
    await page.screenshot({ path: join(out, "continuous-build-ready.png") });
    await app.context().addInitScript(() => {
      window.__audioEvents = [];
      const originalPlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function (...args) {
        for (const type of ["playing", "ended", "error"])
          this.addEventListener(type, () => window.__audioEvents.push(type), { once: true });
        return originalPlay.apply(this, args);
      };
    });
    const opened = app.waitForEvent("window");
    await play.click();
    const player = await opened;
    try {
      await expect(player.locator("[data-player-mode]")).toBeVisible();
      await expect(player.locator("#error")).toBeEmpty();
      const audio = await player.evaluate(async () => {
        const selected = await window.deckwiseFixedPlayer.readPackage();
        const pkg = JSON.parse(new TextDecoder().decode(selected.bytes));
        const audio = pkg.assets.filter((asset) => /^audio\//.test(asset.mimeType));
        const verified = [];
        for (const asset of audio) verified.push({ id: asset.id, sha256: asset.sha256,
          bytes: Array.from(await window.deckwiseFixedPlayer.readAsset(asset.id)) });
        return verified;
      });
      assert(audio.length > 0);
      for (const asset of audio) assert.equal(createHash("sha256").update(Buffer.from(asset.bytes)).digest("hex"), asset.sha256);
      await player.getByRole("button", { name: /播放|Play/, exact: true }).click();
      if (exercisePlayer) await exercisePlayer(player);
      await expect(player.getByRole("status")).toContainText(/播放完成|Playback complete/, { timeout: 180_000 });
      report.continuousAudioEvents = await player.evaluate(() => window.__audioEvents);
      assert(report.continuousAudioEvents.includes("playing") && report.continuousAudioEvents.includes("ended"));
      assert(!report.continuousAudioEvents.includes("error"));
      await player.screenshot({ path: join(out, "continuous-player-complete.png") });
      await writeFile(join(out, "continuous-teaching.json"), JSON.stringify(project, null, 2));
    } finally { await player.close(); }
    await preview.getByRole("button", { name: /Close preview|关闭预览/ }).click();
  });
}
