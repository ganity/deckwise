import { describe, expect, it } from "vitest";
import { isCoursewareOnlineSourceMapping as valid } from "./courseware-online-source-mapping.js";

const mapping = () => ({ revision: "mapping-1", sourceSha256: "a".repeat(64), pages: [
  { pageId: "page-a", importPageId: "page_1", objects: [{ objectId: "object-a", importElementId: "text_1" }] },
  { pageId: "page-b", importPageId: "page_2", objects: [{ objectId: "object-b", importElementId: "text_1" }] },
] });

describe("complete online source mapping", () => {
  it("accepts a complete source mapping with page-local import object IDs and empty slides", () => {
    const value = mapping(); expect(valid(value)).toBe(true);
    value.pages[1]!.objects = []; expect(valid(value)).toBe(true);
  });
  it("rejects incomplete and extra fields at each level", () => {
    const original = mapping();
    expect(valid(null)).toBe(false);
    expect(valid({ ...original, sourceRevision: "invented" })).toBe(false);
    expect(valid({ ...original, pages: [{ pageId: "page-a", importPageId: "page_1" }] })).toBe(false);
    expect(valid({ ...original, pages: [{ ...original.pages[0], objects: [{ objectId: "object-a" }] }] })).toBe(false);
    expect(valid({ ...original, pages: [{ ...original.pages[0], slidePart: "slide1.xml" }] })).toBe(false);
  });
  it("refuses duplicate logical IDs globally and duplicate native IDs within their scope", () => {
    const original = mapping();
    for (const mutate of [
      (v: ReturnType<typeof mapping>) => { v.pages[1]!.pageId = "page-a"; },
      (v: ReturnType<typeof mapping>) => { v.pages[1]!.objects[0]!.objectId = "object-a"; },
      (v: ReturnType<typeof mapping>) => { v.pages[1]!.pageId = "object-a"; },
      (v: ReturnType<typeof mapping>) => { v.pages[1]!.importPageId = "page_1"; },
      (v: ReturnType<typeof mapping>) => { v.pages[0]!.objects.push({ objectId: "object-c", importElementId: "text_1" }); },
    ]) { const value = structuredClone(original); mutate(value); expect(valid(value)).toBe(false); }
  });
  it("bounds identifiers, page count and total object count", () => {
    const original = mapping();
    for (const revision of ["..", "x/y", "x".repeat(129)]) expect(valid({ ...original, revision })).toBe(false);
    for (const importPageId of ["", " \t", "x\u0000", "x".repeat(201)])
      expect(valid({ ...original, pages: [{ ...original.pages[0], importPageId }] })).toBe(false);
    expect(valid({ ...original, sourceSha256: "A".repeat(64) })).toBe(false);
    expect(valid({ ...original, pages: [] })).toBe(false);
    expect(valid({ ...original, pages: Array.from({ length: 101 }, (_, i) => ({ pageId: `p-${i}`, importPageId: `i-${i}`, objects: [] })) })).toBe(false);
    expect(valid({ ...original, pages: [{ pageId: "page", importPageId: "page_1", objects: Array.from({ length: 10_001 }, (_, i) =>
      ({ objectId: `o-${i}`, importElementId: `i-${i}` })) }] })).toBe(false);
  });
});
