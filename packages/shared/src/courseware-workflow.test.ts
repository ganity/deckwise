import { describe, expect, it } from "vitest";
import { coursewareMediaRecovery, coursewareTeachingProgress, sceneAssetBlockers } from "./courseware-workflow.js";
import type { CoursewareSceneImageView, CoursewareScenePlanSnapshot } from "./courseware-scene-plan.js";

const plan: CoursewareScenePlanSnapshot = { relativePath: "plan.json", sha256: "a".repeat(64), approvedSha256: "a".repeat(64), title: "Lesson",
  pages: [{ pageId: "scene-001", sourceHash: "sha256:" + "a".repeat(64), title: "Hello", visibleText: ["Hello"], visualIntent: "A garden", narration: "Hello!" }] };

it.each([
  [{ image: { phase: "submission-unknown", task: null }, waitingFor: "service" }, "unknown"],
  [{ image: { phase: "submission-unknown", task: { state: "queued" } } }, "pending"],
  [{ state: "submission_unknown", saved: false }, "unknown"],
  [{ media: { task: { state: "failed" } } }, "failed"],
  [{ image: { task: { state: "archiving", errorCode: "UPSTREAM_HTTP_401" } } }, "failed"],
  [{ image: { phase: "submitted", asset: { sha256: "archive" } } }, "archived"],
  [{ image: { selected: true } }, "adopted"],
  [{ requiresHumanSelection: true, image: { asset: {} } }, "needs-human"],
] as const)("normalizes actual recovery envelope %j", (value, expected) => {
  expect(coursewareMediaRecovery(value)).toBe(expected);
});
const image = (kind: "visualMaster" | "cleanPlate" | "layer", sha256: string): CoursewareSceneImageView => ({
  intentId: kind, planSha256: plan.sha256, pageId: "scene-001", target: kind === "layer" ? { kind, name: "child" } : { kind },
  model: "image-model", prompt: "Image", phase: "submitted", current: true, selected: true, task: null,
  asset: { sha256, mimeType: "image/png", byteLength: 100, width: 1280, height: 800 },
});

describe("scene compilation readiness", () => {
  it("names every missing page asset and accepts a complete selected set", () => {
    expect(sceneAssetBlockers(plan, []).map(row => row.kind)).toEqual(["visualMaster", "cleanPlate", "layer"]);
    expect(sceneAssetBlockers(plan, [image("visualMaster", "b"), image("cleanPlate", "c"), image("layer", "d")])).toEqual([]);
  });
  it("rejects stale, unselected, duplicate and identical backgrounds", () => {
    const rows = [image("visualMaster", "b"), image("cleanPlate", "c"), image("layer", "d")];
    for (const patch of [{ current: false }, { selected: false }, { planSha256: "old" }])
      expect(sceneAssetBlockers(plan, [{ ...rows[0], ...patch }, ...rows.slice(1)]).map(row => row.kind)).toContain("visualMaster");
    expect(sceneAssetBlockers(plan, [...rows, { ...rows[2], intentId: "duplicate" }]).map(row => row.kind)).toContain("duplicate");
    expect(sceneAssetBlockers(plan, [rows[0], image("cleanPlate", "b"), rows[2]]).map(row => row.kind)).toContain("distinctBackground");
  });
  it("rejects incomplete selected records without an aggregate asset ceiling", () => {
    const rows = [image("visualMaster", "b"), image("cleanPlate", "c"), image("layer", "d")];
    expect(sceneAssetBlockers(plan, [{ ...rows[0], asset: null }, ...rows.slice(1)]).map(row => row.kind)).toContain("incomplete");
    rows[0].asset!.byteLength = 447 * 1024 * 1024;
    expect(sceneAssetBlockers(plan, rows)).toEqual([]);
  });
});


it("teaching readiness follows saved media and unresolved slots, not legacy page review", () => {
  const project = { pages: [{ actions: [{ type: "speech", text: "Hello", audioAssetId: "voice" }], reviewState: "review" }] };
  expect(coursewareTeachingProgress(project as any)).toEqual({ total: 1, audio: 1, ready: 1 });
  for (const action of [{ type: "speech", text: "Hello" }, { type: "video_slot" }, { type: "music_slot" },
    { type: "speech", text: "Hello", audioAssetId: "voice", attention: {} }]) {
    project.pages[0].actions = [action as any];
    project.pages[0].reviewState = "ready";
    expect(coursewareTeachingProgress(project as any).ready).toBe(0);
  }
});
