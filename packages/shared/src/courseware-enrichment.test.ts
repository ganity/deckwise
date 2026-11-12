import { describe, expect, it } from "vitest";
import { inspectCoursewareEnrichment, isCoursewareEnrichment, parseCoursewareScript, type CoursewareEnrichment } from "./courseware-enrichment.js";

const source = (): CoursewareEnrichment => ({ schemaVersion: "deckwise-teaching-enrichment/1",
  originalPages: [{ pageId: "one", pageNumber: 1 }, { pageId: "two", pageNumber: 2 }],
  script: { sha256: "a".repeat(64), policy: "preserve", silentPageIds: ["two"],
    segments: [{ id: "line", text: "Hello. 1.25 kg. Watch the video.", sourceLine: 1, pageId: "one", actionId: "speech" }] } });
describe("portable teaching sources", () => {
  it("keeps greetings, decimals, spacing and media references verbatim while stripping page headings", () => {
    const segments = parseCoursewareScript("Hello, class!\r\nP1：1.25 kg.  Watch the video!\nNext sentence.\n第十二页\nGoodbye.");
    expect(segments.map(s => [s.text, s.sourcePageNumber, s.sourceLine])).toEqual([
      ["Hello, class!", undefined, 1], ["1.25 kg.  Watch the video!", 1, 2], ["Next sentence.", 1, 3], ["Goodbye.", 12, 5],
    ]);
    expect(parseCoursewareScript("Ｐａｇｅ ２：  Original *words*.")[0]).toMatchObject({ sourcePageNumber: 2, text: "Original *words*." });
    expect(parseCoursewareScript("P1.25 is a decimal")[0].text).toBe("P1.25 is a decimal");
  });
  it("splits long speech without losing a character or breaking a surrogate pair", () => {
    const text = "a".repeat(3999) + "😀" + " rest";
    const segments = parseCoursewareScript(text);
    expect(segments.map(s => s.text).join("")).toBe(text);
    expect(segments.every(s => s.text.length <= 4000 && !/[\uD800-\uDBFF]$/u.test(s.text))).toBe(true);
  });
  it("rejects out of order/out of range labels, empty and oversized scripts", () => {
    for (const text of ["P2: Two\nP1: One", "P101: Unknown", "P0: Unknown", "P1:\n", "x".repeat(500001)])
      expect(() => parseCoursewareScript(text)).toThrow();
  });
  it("rejects unknown versions, private fields, conflicting silence, duplicate IDs and oversized evidence", () => {
    expect(isCoursewareEnrichment(source())).toBe(true);
    expect(isCoursewareEnrichment({ ...source(), path: "/private/material.docx" })).toBe(false);
    expect(isCoursewareEnrichment({ ...source(), schemaVersion: "future" })).toBe(false);
    const conflict = source(); conflict.script!.silentPageIds.push("one"); expect(isCoursewareEnrichment(conflict)).toBe(false);
    const duplicate = source(); duplicate.script!.segments.push(duplicate.script!.segments[0]); expect(isCoursewareEnrichment(duplicate)).toBe(false);
  });
  it("survives reorder/insertion and reports changed, removed and unmatched speech rather than rewriting", () => {
    const e = source();
    const pages = [{ pageId: "two", actions: [] }, { pageId: "new-quiz", actions: [] },
      { pageId: "one", actions: [{ id: "speech", type: "speech", text: e.script!.segments[0].text, audioAssetId: "adopted" }] }];
    expect(inspectCoursewareEnrichment(e, pages).ready).toBe(true);
    pages[2].actions[0].text = "Edited by teacher";
    expect(inspectCoursewareEnrichment(e, pages).issues[0].code).toBe("SCRIPT_CHANGED");
    expect(inspectCoursewareEnrichment(e, pages.slice(0, 2)).issues[0].code).toBe("SCRIPT_UNMATCHED");
    expect(inspectCoursewareEnrichment(undefined, pages).ready).toBe(true);
  });
  it("reports missing plan stages and does not treat an unverified activity ID as completion", () => {
    const e = source(); e.plan = { sha256: "b".repeat(64), units: [{ id: "review", title: "Review", evidence: "Ask a question", kind: "checkpoint", pageIds: ["two"], activityId: "wrong" }] };
    const pages = [{ pageId: "one", actions: [{ id: "speech", type: "speech", text: e.script!.segments[0].text }] }, { pageId: "two", actions: [] }];
    expect(inspectCoursewareEnrichment(e, pages).issues).toContainEqual({ code: "ACTIVITY_MISSING", sourceId: "review" });
  });
  it("rejects an activity inserted before its mapped source page", () => {
    const e = source();
    e.plan = { sha256: "b".repeat(64), units: [{ id: "quiz", title: "Review", evidence: "Ask a question", kind: "quiz", pageIds: ["two"], activityId: "quiz-action" }] };
    const pages = [{ pageId: "two", actions: [{ id: "quiz-action", type: "interaction_checkpoint", context: { sourceSceneIds: ["one"] } }] },
      { pageId: "one", actions: [{ id: "speech", type: "speech", text: e.script!.segments[0].text }] }];
    expect(inspectCoursewareEnrichment(e, pages).issues).toContainEqual({ code: "ACTIVITY_ORDER_MISMATCH", sourceId: "quiz", pageId: "two" });
    pages.reverse();
    expect(inspectCoursewareEnrichment(e, pages).issues).toEqual([]);
  });
});

it("allows explicitly authorized revision to produce new speech identities while retaining source-page coverage", () => {
  const e = source(); e.script!.policy = "revise";
  const pages = [{ pageId: "one", actions: [{ id: "new-generated-id", type: "speech", text: "An authorized revision." }] }, { pageId: "two", actions: [] }];
  expect(inspectCoursewareEnrichment(e, pages).ready).toBe(true);
  pages[0].actions = [];
  expect(inspectCoursewareEnrichment(e, pages).issues[0].code).toBe("SCRIPT_UNMATCHED");
});

it("recognizes Slide and bracketed source-page headings without trimming spoken lines", () => {
  expect(parseCoursewareScript("Slide 2\n  Exact words.  \n【第十二页】\nNext." ).map(s => [s.sourcePageNumber, s.text])).toEqual([
    [2, "  Exact words.  "], [12, "Next."],
  ]);
  expect(() => parseCoursewareScript("Slide 2\nTwo\nSlide 1\nOne")).toThrow(/order/);
  expect(parseCoursewareScript("Slide 1.25 is a decimal")[0].text).toBe("Slide 1.25 is a decimal");
});
