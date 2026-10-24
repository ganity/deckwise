import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Local HTTP audio boundary; Main and Host retain actual quote/archive/receipt handling. */
export async function createRebuiltAttentionFixture(speechPattern = /^Good! Page [1-3]\.$/u) {
  const audio = await readFile(new URL("../../packages/courseware-runtime/tests/fixtures/fixed-courseware/page-1.wav", import.meta.url));
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  const tasks = new Map();
  let heldDownload;
  const requestHash = request => hash("courseware-media-v1" + [request.kind, request.model, request.input, request.voice ?? null]
    .map(value => `:${value === null ? -1 : value.length}:${value ?? ""}`).join(""));
  return {
    async handle(req, res) {
      const url = new URL(req.url, "http://127.0.0.1");
      const send = data => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ code: 200, data })); return true; };
      if (url.pathname === "/courseware/team/projects") return send([]);
      if (url.pathname === "/courseware/media/models") return send([{ model: "fixture-speech", voices: ["classroom"], providerDefaultVoice: false }]);
      if (url.pathname === "/courseware/media/models/fixture-speech/quote") {
        const expiry = Math.floor(Date.now() / 1000) + 300;
        return send({ version: "courseware-media-quote-v1", kind: "tts", model: "fixture-speech", priceVersion: "fixture-v1",
          maxPoints: 1, maxChars: 2500, expiresAt: new Date(expiry * 1000).toISOString(), quoteToken: `${expiry}.${"a".repeat(43)}` });
      }
      if (url.pathname === "/courseware/media/tasks/confirmed" && req.method === "POST") {
        let raw = ""; for await (const chunk of req) raw += chunk;
        const { request, confirmation } = JSON.parse(raw), key = req.headers["idempotency-key"];
        assert.equal(request.kind, "tts"); assert.equal(request.model, "fixture-speech"); assert.equal(request.voice, "classroom");
        assert.match(request.input, speechPattern); assert.equal(confirmation.maxPoints, 1);
        assert(key && !tasks.has(key) && tasks.size < 3, "Do not retry or add paid requests");
        const taskId = `rebuilt-speech-${tasks.size + 1}`;
        const task = { version: "courseware-media-v1", kind: "tts", taskId, idempotencyKey: key, requestHash: requestHash(request),
          model: request.model, state: "ready", feeState: "settled", reservedPoints: 1, actualPoints: 1, errorCode: null,
          receiptId: `courseware-media:${taskId}`, assetRef: { assetId: `asset-${taskId}`, sha256: hash(audio), mime: "audio/wav",
            byteLength: audio.length, durationMs: 5955, downloadPath: `/courseware/media/tasks/${taskId}/asset` } };
        tasks.set(key, task); return send(task);
      }
      if (url.pathname === "/courseware/media/tasks/by-idempotency") {
        const task = tasks.get(url.searchParams.get("key")); assert(task); return send(task);
      }
      const match = /^\/courseware\/media\/tasks\/(rebuilt-speech-[1-3])(\/asset)?$/u.exec(url.pathname);
      if (!match) return false;
      const task = [...tasks.values()].find(entry => entry.taskId === match[1]); assert(task);
      if (match[2]) {
        if (heldDownload) {
          const held = heldDownload; heldDownload = undefined;
          held.arrived(); await held.released;
        }
        res.setHeader("content-type", "audio/wav"); res.end(audio); return true;
      }
      return send(task);
    },
    holdNextDownload() {
      assert(!heldDownload);
      let arrived, release;
      const received = new Promise(resolve => { arrived = resolve; });
      const released = new Promise(resolve => { release = resolve; });
      heldDownload = { arrived, released };
      return { received, release };
    },
    async adoptAudio(invoke, view, sessionId) {
      const speech = view.project.pages.find(page => page.pageId === view.pageId).actions[0];
      const scope = { viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision };
      const task = await invoke("pptEditorTtsPrepare", { ...scope, actionId: speech.id, model: "fixture-speech", voice: "classroom" });
      const operation = { ...scope, intentId: task.intentId };
      const quote = await invoke("pptEditorTtsQuote", operation);
      assert.equal(quote.maxPoints, 1);
      await invoke("pptEditorTtsSubmitConfirmed", { ...operation, quoteId: quote.quoteId });
      await invoke("pptEditorTtsArchive", operation);
      await invoke("pptEditorTtsAdopt", operation);
      const adopted = await invoke("pptEditorTeachingOpen", { sessionId });
      assert.equal(adopted.project.pages.find(page => page.pageId === adopted.pageId).actions[0].audioAssetId, `tts-${hash(audio)}`);
      return adopted;
    },
    result: () => ({ requests: tasks.size, sha256: hash(audio), mime: "audio/wav", byteLength: audio.length, paidCalls: false }),
  };
}

export async function testRebuiltAttentionPlayback({ player, expect, report, out, association = report.redoAttention }) {
  const target = await player.evaluate(async ({ objectId, pageIndex }) => {
    const selected = await window.deckwiseFixedPlayer.readPackage();
    const pkg = JSON.parse(new TextDecoder().decode(selected.bytes));
    return pkg.pages[pageIndex].objects.find(object => object.objectId === objectId)?.importElementId;
  }, { objectId: association.newTarget, pageIndex: association.pageIndex });
  assert(target, "Adopted UUID must resolve to the actual fixed-player object");
  const highlight = player.locator('[data-fixed-effect="highlight"]');
  const spotlight = player.locator('[data-fixed-effect="spotlight"]');
  await expect(highlight).toHaveCount(1);
  await player.getByRole("button", { name: /暂停|Pause/, exact: true }).click();
  await expect(highlight).toHaveAttribute("data-target-ids", target);
  const prefix = association.pageIndex === 0 ? "rebuilt-target" : `rebuilt-target-page-${association.pageIndex + 1}`;
  await player.screenshot({ path: join(out, `${prefix}-highlight.png`) });
  const slider = player.getByRole("slider", { name: /调整旁白进度|Seek narration/, exact: true });
  await slider.press("Home");
  for (let step = 0; step < 100; step++) await slider.press("ArrowRight");
  await expect(highlight).toHaveCount(0);
  await expect(spotlight).toHaveCount(1);
  await expect(spotlight).toHaveAttribute("data-target-ids", target);
  await player.screenshot({ path: join(out, `${prefix}-spotlight.png`) });
  association.playback = { target, highlight: true, spotlight: true, pausedSeekMs: 1000 };
  await player.getByRole("button", { name: /继续|Resume/, exact: true }).click();
}
