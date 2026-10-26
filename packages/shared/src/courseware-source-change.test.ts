import { expect, it } from "vitest";
import { sourceChangeForTeaching, chatChangesForTeaching } from "./courseware-source-change.js";
import fixture from "./courseware-contract.fixtures/accepted.json";
import { isCoursewareProject } from "./courseware-contract.js";

it("validates source changes against the current teaching, not a frozen success label", () => {
  const project = structuredClone(fixture.project);
  if (!isCoursewareProject(project)) throw new Error("Invalid fixture project");
  const change = { changeGroupId: "review-1", phase: "teaching-review", stale: false,
    baselineSource: "b".repeat(64), baselineTeachingRevision: "before", targetSource: project.source.sha256,
    expected: ["source-associated", "teaching-review"], completed: ["source-saved", "source-associated"],
    associationTeachingRevision: "associated", currentTeachingRevision: project.teachingRevision,
    pendingPageIds: project.pages.filter(page => page.reviewState !== "ready").map(page => page.pageId) };
  project.pages[0].reviewState = "review";
  change.pendingPageIds = project.pages.filter(page => page.reviewState !== "ready").map(page => page.pageId);
  expect(sourceChangeForTeaching({ project, sourceChange: change }, project)).toEqual(change);
  expect(sourceChangeForTeaching({ project }, project)).toBeUndefined();
  for (const patch of [{ phase: "complete" }, { stale: true }, { completed: ["source-saved"] }, { pendingPageIds: [] },
    { pendingPageIds: ["foreign"] }, { currentTeachingRevision: "old" }, { targetSource: "no-hash" },
    { associationTeachingRevision: null }, { expected: [] }, { extra: true }]) {
    expect(() => sourceChangeForTeaching({ project, sourceChange: { ...change, ...patch } }, project)).toThrow();
  }
  project.pages.forEach(page => { page.reviewState = "ready"; });
  const complete = { ...change, phase: "complete", pendingPageIds: [], completed: [...change.completed, "teaching-review"] };
  expect(sourceChangeForTeaching({ project, sourceChange: complete }, project)).toEqual(complete);
  const superseded = { ...change, targetSource: "c".repeat(64), phase: "superseded", stale: true, pendingPageIds: [] };
  expect(sourceChangeForTeaching({ project, sourceChange: superseded }, project)).toEqual(superseded);
  const prepared = { ...superseded, phase: "source-review", completed: ["source-saved"], associationTeachingRevision: null };
  expect(sourceChangeForTeaching({ project, sourceChange: prepared }, project)).toEqual(prepared);
  expect(() => sourceChangeForTeaching({ project: { ...project, teachingRevision: "older" }, sourceChange: complete }, project)).toThrow();
  const raw = { project, sourceChange: complete };
  const result = sourceChangeForTeaching(raw, project)!;
  result.completed.push("forged");
  expect(raw.sourceChange.completed).not.toContain("forged");
});

it("summarizes acknowledgements and unknown outcomes without exposing stored instructions", () => {
  const group = { changeGroupId: "chat-1", operations: [
    { args: "private instruction", outcome: { state: "acknowledged", saved: false } },
    { outcome: { state: "uncertain", saved: false } }, { outcome: null },
  ] };
  expect(chatChangesForTeaching({ chatChanges: [group] })).toEqual([
    { changeGroupId: "chat-1", acknowledged: 1, uncertain: 1, pending: 1 },
  ]);
  expect(chatChangesForTeaching({})).toBeUndefined();
  for (const changes of [[group, group], [{ ...group, changeGroupId: "bad/id" }],
    [{ ...group, operations: [] }], [{ ...group, operations: [{}] }],
    [{ ...group, operations: [{ outcome: { state: "complete", saved: true } }] }]]) {
    expect(() => chatChangesForTeaching({ chatChanges: changes })).toThrow();
  }
});

it("requires immutable version references for linked adoption and retains later-change status", () => {
  const candidate = { candidateId: "candidate-1", status: "adopted", sourceSha256: "a".repeat(64),
    teachingRevision: "adopted-revision", pageIds: ["page-1"] };
  const operation = { outcome: { state: "acknowledged", saved: false, candidateId: "candidate-1" }, candidate };
  const read = (operation: unknown) => chatChangesForTeaching({ chatChanges: [{ changeGroupId: "chat-1", operations: [operation] }] });
  expect(read(operation)?.[0].candidates).toEqual([candidate]);
  expect(read({ ...operation, candidate: { ...candidate, status: "superseded" } })?.[0].candidates?.[0].status).toBe("superseded");
  for (const status of ["needs-review", "stale", "rejected", "unknown"]) {
    expect(read({ ...operation, candidate: { candidateId: "candidate-1", status } })?.[0].candidates?.[0].status).toBe(status);
  }
  for (const patch of [{ candidateId: "foreign" }, { sourceSha256: "bad" }, { teachingRevision: null },
    { pageIds: [] }, { pageIds: ["page-1", "page-1"] }, { pageIds: ["bad/id"] }, { status: "complete" },
    { status: "needs-review" }, { extra: true }]) expect(() => read({ ...operation, candidate: { ...candidate, ...patch } })).toThrow();
  expect(() => read({ ...operation, outcome: null })).toThrow();
  const result = read(operation)!; result[0].candidates![0].pageIds!.push("changed");
  expect(candidate.pageIds).toEqual(["page-1"]);
});

it("retains unexecuted planned items and checks each result against its actual distinct operation", () => {
  const plan = { pageId: "page-1", pageNumber: 1, items: [
    { label: "Edit page", toolName: "ppt_add_slide_text", status: "not-recorded" },
    { label: "Rewrite narration", toolName: "ppt_propose_page_narration", status: "not-recorded" },
  ] };
  const group = { changeGroupId: "group", operations: [] as unknown[], plan };
  expect(chatChangesForTeaching({ chatChanges: [group] })?.[0].plan).toEqual(plan);
  const operation = { toolCallId: "call:1", toolName: "ppt_add_slide_text", outcome: { state: "acknowledged", saved: false, page: 1 } };
  const next = { ...group, operations: [operation], plan: { ...plan, items: [
    { ...plan.items[0], status: "native-unsaved", toolCallId: "call:1" }, plan.items[1],
  ] } };
  expect(chatChangesForTeaching({ chatChanges: [next] })?.[0].plan?.items.map(item => item.status)).toEqual(["native-unsaved", "not-recorded"]);
  for (const patch of [{ status: "adopted" }, { toolCallId: "foreign" }, { toolName: "ppt_propose_page_narration" }, { extra: true }])
    expect(() => chatChangesForTeaching({ chatChanges: [{ ...next, plan: { ...next.plan, items: [{ ...next.plan.items[0], ...patch }] } }] })).toThrow();
  expect(() => chatChangesForTeaching({ chatChanges: [{ ...next, plan: { ...next.plan, items: [next.plan.items[0], next.plan.items[0]] } }] })).toThrow();
  expect(() => chatChangesForTeaching({ chatChanges: [{ ...next, operations: [{ ...operation, outcome: { ...operation.outcome, page: 2 } }] }] })).toThrow();
});

it("validates explicit human disposition without rewriting unexecuted or unknown step states", () => {
  const group = { changeGroupId: "group", sessionId: "chat", receiptSha256: "a".repeat(64), operations: [],
    plan: { pageId: "page", pageNumber: 1, items: [{ label: "Rewrite narration", toolName: "ppt_propose_page_narration", status: "not-recorded" }] },
    resolution: { changeGroupId: "group", sessionId: "chat", receiptSha256: "a".repeat(64), note: "Keep current narration; cancel remainder.",
      source: { revision: "R2", sha256: "b".repeat(64) }, teachingRevision: "T3", projectSha256: "c".repeat(64) } };
  const read = (value: unknown) => chatChangesForTeaching({ chatChanges: [value] })![0];
  const result = read(group);
  expect(result.plan?.items[0].status).toBe("not-recorded");
  expect(result.resolution).toEqual({ note: group.resolution.note, sourceSha256: "b".repeat(64), teachingRevision: "T3" });
  for (const patch of [{ note: "" }, { note: "x".repeat(501) }, { changeGroupId: "other" }, { receiptSha256: "d".repeat(64) },
    { sessionId: "other" }, { projectSha256: "bad" }, { source: { revision: "R2", sha256: "bad" } }, { extra: true }])
    expect(() => read({ ...group, resolution: { ...group.resolution, ...patch } })).toThrow();
  expect(() => read({ ...group, receiptSha256: undefined })).toThrow();
  expect(() => read({ ...group, plan: undefined })).toThrow();
});

it("recognizes saved narration without a candidate and rejects save claims from native source edits", () => {
  const operation = { toolCallId: "narration", toolName: "ppt_propose_page_narration", outcome: { state: "acknowledged", saved: true } };
  const change = { changeGroupId: "group", operations: [operation], plan: { pageId: "page-1", pageNumber: 1,
    items: [{ label: "Generate narration", toolName: operation.toolName, toolCallId: operation.toolCallId, status: "saved" }] } };
  expect(chatChangesForTeaching({ chatChanges: [change] })?.[0].plan?.items[0].status).toBe("saved");
  for (const patch of [{ state: "uncertain" }, { saved: false }]) {
    expect(() => chatChangesForTeaching({ chatChanges: [{ ...change, operations: [{ ...operation, outcome: { ...operation.outcome, ...patch } }] }] })).toThrow();
  }
  expect(() => chatChangesForTeaching({ chatChanges: [{ ...change, operations: [{ ...operation, toolName: "ppt_add_slide_text" }] }] })).toThrow();
});
