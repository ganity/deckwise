import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { candidateHash } from "./page-candidate-baseline.js";
import { generatePageFadeCandidate, resolvePageFadeTarget } from "./page-fade-candidate.js";

const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const slide = (extra = "") => `<p:sld xmlns:p="${P}"><p:cSld><p:spTree/></p:cSld>${extra}<p:timing/><p:extLst/></p:sld>`;
async function fixture(extra = "") {
  const zip = new JSZip();
  zip.file("ppt/presentation.xml", `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId1"/></p:sldIdLst></p:presentation>`);
  zip.file("ppt/_rels/presentation.xml.rels", `<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${R}/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="${R}/slide" Target="slides/slide9.xml"/></Relationships>`);
  zip.file("ppt/slides/slide9.xml", slide(extra));
  zip.file("ppt/slides/slide1.xml", slide());
  zip.file("ppt/notesSlides/notesSlide9.xml", "original notes");
  const source = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const baseline = { projectId: "course", documentId: "document", pageId: "logical-nine", sourceRevision: "R1", sourceHash: candidateHash(source), teachingRevision: "T1", contentHash: candidateHash(""), clean: true, readOnly: false, manualLocked: false };
  const mapping = { revision: "map-1", sourceSha256: baseline.sourceHash.slice(7), pages: [{ pageId: "logical-one", importPageId: "page_2", objects: [] }, { pageId: "logical-nine", importPageId: "page_1", objects: [] }] };
  const target = await resolvePageFadeTarget(source, mapping, baseline.pageId);
  return { source, baseline, mapping, target, input: { sourcePptx: source, baseline, pageText: "", target, getCurrentBaseline: async () => baseline } };
}

describe("B4 fade adaptation", () => {
  it("resolves relationship order and changes only the target slide, preserving timing and notes", async () => {
    const f = await fixture(); const before = Buffer.from(f.source);
    expect(f.target.slidePart).toBe("ppt/slides/slide9.xml");
    const result = await generatePageFadeCandidate(f.input);
    expect(result).toMatchObject({ kind: "page-fade", reviewState: "needs-review", applied: false });
    const original = await JSZip.loadAsync(f.source); const output = await JSZip.loadAsync(result.pptx);
    for (const entry of Object.values(original.files)) {
      if (entry.dir) continue;
      if (entry.name !== f.target.slidePart) expect(await output.file(entry.name)!.async("nodebuffer")).toEqual(await entry.async("nodebuffer"));
    }
    expect(await output.file(f.target.slidePart)!.async("string")).toContain('<p:transition xmlns:p="' + P + '" spd="med" advClick="1"><p:fade/></p:transition><p:timing/>');
    expect(f.source).toEqual(before);
    expect(result.hash).toBe(candidateHash(result.pptx));
  });

  it.each([
    '<p:transition advTm="1000"><p:fade/></p:transition>',
    '<p:transition><p:wipe/></p:transition>',
    '<p:transition/><p:transition/>',
    '<p:transition><p:sndAc/></p:transition>',
    '<unknown xmlns="urn:unknown"/>',
  ])("rejects unreviewed transition or extension: %s", async (extra) => {
    const f = await fixture(extra);
    await expect(generatePageFadeCandidate(f.input)).rejects.toThrow();
  });

  it("accepts the verified Office fade compatibility wrapper", async () => {
    const f = await fixture('<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main"><mc:Choice Requires="p14"><p:transition><p:fade/></p:transition></mc:Choice><mc:Fallback><p:transition><p:fade/></p:transition></mc:Fallback></mc:AlternateContent>');
    const result = await generatePageFadeCandidate(f.input);
    const xml = await (await JSZip.loadAsync(result.pptx)).file(f.target.slidePart)!.async("string");
    expect(xml).not.toContain("AlternateContent");
    expect(xml).toContain('spd="med"');
  });

  it("rejects forged or incomplete mapping, source and text, and locks/cancel/stale results", async () => {
    const f = await fixture();
    for (const mapping of [{ ...f.mapping, sourceSha256: "a".repeat(64) }, { ...f.mapping, pages: [f.mapping.pages[0]] }, { ...f.mapping, pages: [f.mapping.pages[0], f.mapping.pages[0]] }]) {
      await expect(resolvePageFadeTarget(f.source, mapping, f.baseline.pageId)).rejects.toThrow();
    }
    await expect(generatePageFadeCandidate({ ...f.input, sourcePptx: Buffer.from("wrong") })).rejects.toThrow();
    await expect(generatePageFadeCandidate({ ...f.input, pageText: "wrong" })).rejects.toThrow();
    for (const change of [{ manualLocked: true }, { clean: false }, { readOnly: true }, { sourceRevision: "R2" }]) {
      await expect(generatePageFadeCandidate({ ...f.input, getCurrentBaseline: async () => ({ ...f.baseline, ...change }) })).rejects.toThrow();
    }
    await expect(generatePageFadeCandidate({ ...f.input, signal: AbortSignal.abort() })).rejects.toThrow();
    let calls = 0;
    await expect(generatePageFadeCandidate({ ...f.input, getCurrentBaseline: async () => ({ ...f.baseline, teachingRevision: ++calls === 1 ? "T1" : "T2" }) })).rejects.toThrow("teachingRevision");
  });

  it.each(["../escape.xml", "ppt/vbaProject.bin", "_xmlsignatures/signature.xml"])("rejects unsafe package entry %s", async (part) => {
    const f = await fixture(); const zip = await JSZip.loadAsync(f.source); zip.file(part, "unsafe");
    const source = await zip.generateAsync({ type: "nodebuffer" });
    await expect(generatePageFadeCandidate({ ...f.input, sourcePptx: source, baseline: { ...f.baseline, sourceHash: candidateHash(source) }, getCurrentBaseline: async () => ({ ...f.baseline, sourceHash: candidateHash(source) }) })).rejects.toThrow();
  });
});
