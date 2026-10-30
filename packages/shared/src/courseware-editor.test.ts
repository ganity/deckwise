import { describe, expect, it } from "vitest";
import { isCoursewareTeachingDraft, isCoursewareTeachingHistory, isCoursewareInteractionCheckpoint, replaceNarrationText } from "./courseware-editor.js";
import fixture from "./courseware-contract.fixtures/accepted.json";

it("bounds teacher-led question payloads and retains them in deleted-page history", () => {
  const checkpoint = { id: "question", type: "interaction_checkpoint", checkpointId: "question", checkpointKind: "chapter_summary",
    chapterId: "page", chapterTitle: "Shapes", question: "How many sides?", referenceAnswer: { summary: "Four", keyPoints: ["Four equal sides"] },
    context: { chapterSummary: "A square has four equal sides", sourceSceneIds: ["page"] } };
  expect(isCoursewareInteractionCheckpoint(checkpoint)).toBe(true);
  expect(isCoursewareTeachingHistory({ entries: [{ teachingRevision: "T1", sourceRevision: "R1", pageId: "page", pageNumber: 1,
    actions: [checkpoint], omittedAudioCount: 0, omittedCueCount: 0 }], skippedEntryCount: 0 })).toBe(true);
  for (const patch of [{ question: "" }, { question: "x".repeat(4001) }, { checkpointId: ".." },
    { referenceAnswer: { summary: "Four", keyPoints: [] } }, { context: { ...checkpoint.context, sourceSceneIds: ["page", "page"] } },
    { assessedCorrect: true }, { checkpointKind: "quiz" }]) expect(isCoursewareInteractionCheckpoint({ ...checkpoint, ...patch })).toBe(false);
});

it("validates recovery drafts separately from authoritative teaching", () => {
  const draft = { revision: "draft-1", baseline: fixture.project, pageId: fixture.project.pages[0].pageId,
    actions: [{ id: "empty", type: "speech", text: "" }], instruction: "Short sentences" };
  expect(isCoursewareTeachingDraft(draft)).toBe(true);
  for (const patch of [{ pageId: "other" }, { revision: "" }, { instruction: "x".repeat(4001) },
    { baseline: {} }, { actions: [{ type: "speech" }] }, { extra: true }]) expect(isCoursewareTeachingDraft({ ...draft, ...patch })).toBe(false);
});

it("accepts only bounded deleted-page narration projections without old media or object bindings", () => {
  const entry = { teachingRevision: "old-teaching", sourceRevision: "old-source", pageId: "deleted-page", pageNumber: 2,
    actions: [{ id: "new-speech", type: "speech", text: "Good!", source: "generated", pauseAfterMs: 1500 },
      { id: "new-wait", type: "interaction_checkpoint", checkpointId: "new-checkpoint", checkpointKind: "teacher_continue" }],
    omittedAudioCount: 1, omittedCueCount: 2 };
  const history = { entries: [entry], skippedEntryCount: 1 };
  expect(isCoursewareTeachingHistory(history)).toBe(true);
  expect(isCoursewareTeachingHistory({ entries: [], skippedEntryCount: 0 })).toBe(true);
  for (const patch of [{ pageId: "" }, { pageNumber: 0 }, { pageNumber: 101 }, { omittedAudioCount: -1 }, { actions: [] },
    { actions: [{ ...entry.actions[0], audioAssetId: "old-audio" }] }, { actions: [{ ...entry.actions[0], visualCues: [] }] },
    { actions: [{ ...entry.actions[0], pauseAfterMs: 30_001 }] }, { actions: [{ ...entry.actions[0], source: "unknown" }] },
    { actions: [{ ...entry.actions[0], source: ["generated"] }] },
    { actions: [{ ...entry.actions[0], text: "x".repeat(32_001) }] }, { actions: [{ ...entry.actions[1], checkpointKind: "quiz" }] },
    { actions: [entry.actions[0], entry.actions[0]] }, { archivePath: "/private/source" }])
    expect(isCoursewareTeachingHistory({ ...history, entries: [{ ...entry, ...patch }] })).toBe(false);
  expect(isCoursewareTeachingHistory({ ...history, entries: [entry, entry] })).toBe(false);
  expect(isCoursewareTeachingHistory({ ...history, skippedEntryCount: 1_000_001 })).toBe(false);
  expect(isCoursewareTeachingHistory({ ...history, credential: "unexpected" })).toBe(false);
  const large = { ...entry, actions: Array.from({ length: 1000 }, (_, index) => ({ id: `speech-${index}`, type: "speech", text: "x".repeat(32_000) })) };
  expect(isCoursewareTeachingHistory({ ...history, entries: [large] })).toBe(false);
});

describe("manual narration edits", () => {
  it("preserves voice and pacing but invalidates audio and its timing", () => {
    const original = { id: "speech-1", type: "speech", text: "Old", speakerId: "teacher", voice: "warm", pauseAfterMs: 1000,
      audioId: "old", audioUrl: "local", audioAssetId: "a1", durationMs: 2000, visualCues: [{}], speechCuePlans: [{}], pptxCue: {}, attention: { type: "highlight", objectIds: ["old"] } };
    expect(replaceNarrationText(original, "New")).toEqual({ id: "speech-1", type: "speech", text: "New", speakerId: "teacher", voice: "warm", pauseAfterMs: 1000 });
    expect(original.audioId).toBe("old");
    expect(replaceNarrationText(original, "Old")).toBe(original);
    expect(() => replaceNarrationText({ type: "wait" }, "New")).toThrow();
  });
});

it("preserves only strictly bounded explicit delays in deleted-page teaching history", () => {
  const entry = { teachingRevision: "T", sourceRevision: "R", pageId: "p", pageNumber: 1,
    actions: [{ id: "delay", type: "delay", durationMs: 1200 }], omittedAudioCount: 0, omittedCueCount: 0 };
  const history = (action: unknown) => ({ entries: [{ ...entry, actions: [action] }], skippedEntryCount: 0 });
  expect(isCoursewareTeachingHistory(history(entry.actions[0]))).toBe(true);
  for (const durationMs of [-1, 0.5, 30001, "1000", null])
    expect(isCoursewareTeachingHistory(history({ ...entry.actions[0], durationMs }))).toBe(false);
  expect(isCoursewareTeachingHistory(history({ ...entry.actions[0], extra: true }))).toBe(false);
});
