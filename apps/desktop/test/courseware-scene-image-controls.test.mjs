import assert from "node:assert/strict";
import test from "node:test";
import { sceneWorkspaceProgress } from "@pi-desktop/shared";

const plan = { sha256: "a".repeat(64), pages: [{ pageId: "cover" }, { pageId: "page2" }] };
const image = (pageId, kind, extra = {}) => ({ intentId: `${pageId}-${kind}`, pageId, planSha256: plan.sha256,
  target: kind === "layer" ? { kind, name: "Character" } : { kind }, current: true, selected: true, phase: "submitted",
  asset: { sha256: kind.repeat(16).slice(0, 64), byteLength: 100 }, ...extra });
const masters = plan.pages.map(page => image(page.pageId, "visualMaster"));
const complete = plan.pages.flatMap(page => [image(page.pageId, "visualMaster"), image(page.pageId, "cleanPlate"), image(page.pageId, "layer")]);
const progress = (rows, running = false, compilation) => sceneWorkspaceProgress(plan, rows, running, compilation);

test("cover review and page generation have distinct states and real page counts", () => {
  assert.equal(progress([]).phase, "cover");
  assert.equal(progress([{ ...masters[0], selected: false }]).phase, "style");
  assert.equal(progress([{ ...masters[0], selected: false }]).activity, "review");
  assert.deepEqual(progress([masters[0]], true), { phase: "images", activity: "running", imageCount: 1, assetPages: 0, total: 2 });
});

test("all images remain previews while layers are missing, even when Chat stops", () => {
  assert.deepEqual(progress(masters), { phase: "layers", activity: "paused", imageCount: 2, assetPages: 0, total: 2 });
  assert.equal(progress(masters, true).phase, "layers");
  assert.equal(progress([...masters, ...complete.filter(row => row.pageId === "cover" && row.target.kind !== "visualMaster")]).assetPages, 1);
});

test("only a matching actual compiler job shows conversion", () => {
  assert.equal(progress(complete, true).phase, "queued");
  assert.equal(progress(complete, true, { state: "running", planSha256: "old" }).phase, "queued");
  assert.equal(progress(complete, false, { state: "running", planSha256: plan.sha256 }).phase, "converting");
  assert.equal(progress(complete, true, { state: "failed", planSha256: plan.sha256 }).activity, "failed");
  assert.equal(progress(complete, true, { state: "stopped", planSha256: plan.sha256 }).activity, "paused");
});

test("service waiting, uncertainty and failure cannot be reported as completion", () => {
  const pending = image("page2", "cleanPlate", { selected: false, asset: null });
  assert.equal(progress([...masters, pending]).activity, "waiting");
  assert.equal(progress([...masters, { ...pending, phase: "submission-unknown" }]).activity, "unknown");
  assert.equal(progress([...masters, { ...pending, task: { state: "failed" } }]).activity, "failed");
  assert.equal(progress([...masters, { ...pending, task: { state: "cancelled" } }]).activity, "failed");
  assert.equal(progress([...complete, { ...pending, task: { state: "failed" } }]).activity, "paused", "Superseded failed alternatives do not block selected assets");
});

test("foreign, stale and duplicate assets do not inflate progress", () => {
  const rows = [...masters, masters[0], image("foreign", "visualMaster"), image("page2", "layer", { planSha256: "old" })];
  assert.equal(progress(rows).imageCount, 2);
  assert.equal(progress(rows).assetPages, 0);
  assert.equal(progress([{ ...masters[0], current: false }]).imageCount, 0);
});
