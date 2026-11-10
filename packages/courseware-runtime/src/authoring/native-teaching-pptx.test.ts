import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { compileScenesToPptx } from './kindergarten/scene-to-pptx';
import { assessmentBackground } from './classroom-pptx';
import { packNativeTeachingPptx } from './native-teaching-pptx';
const png = assessmentBackground;
async function source() {
  return (await compileScenesToPptx([{ version: 1, slideId: 'page', sourceHash: 'sha256:' + 'a'.repeat(64), canvas: { width: 1280, height: 800 },
    visualMasterAssetId: png.id, cleanPlateAssetId: png.id, elements: [{ id: 'title', type: 'native_text', bboxPx: [40, 40, 600, 80], zIndex: 1,
      content: 'Hello', style: { fontFace: 'Arial', fontSizePt: 28, color: '#111111' } }] }], { [png.id]: png.bytes })).pptx;
}
describe('generated native PPTX', () => {
  it('preserves actual Office parts and packages stable native teaching before any editor is opened', async () => {
    const original = await source();
    const input = { source: original, title: 'Lesson', pages: [{ pageId: 'page', narration: 'Hello & <class>.', actions: [] }], generation: { source: 'generated' } };
    const bytes = await packNativeTeachingPptx(input), zip = await JSZip.loadAsync(bytes), before = await JSZip.loadAsync(original);
    expect(Buffer.from(await packNativeTeachingPptx(input))).toEqual(Buffer.from(bytes));
    for (const file of Object.values(before.files).filter(f => !f.dir && !['[Content_Types].xml', 'ppt/_rels/presentation.xml.rels'].includes(f.name)))
      expect(await zip.file(file.name)!.async('uint8array')).toEqual(await file.async('uint8array'));
    const xml = await zip.file('customXml/deckwise-native.xml')!.async('string');
    const teaching = JSON.parse(xml.slice(xml.indexOf('>') + 1, xml.lastIndexOf('<')).replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'));
    expect(teaching.schemaVersion).toBe('deckwise-native-teaching/1');
    expect(teaching.pages[0].actions[0].text).toBe('Hello & <class>.');
    expect(teaching.identity.pages[0].objects).toHaveLength(1);
    expect(teaching.identity.pages[0].objects[0]).toMatchObject({ sourceObjectName: 'title', sourceShapeId: expect.stringMatching(/^\d+$/) });
    expect(await zip.file('ppt/_rels/presentation.xml.rels')!.async('string')).toContain('Target="../customXml/deckwise-native.xml"');
    await expect(packNativeTeachingPptx({ ...input, source: bytes })).rejects.toThrow('already contains');
    await expect(packNativeTeachingPptx({ ...input, pages: [] })).rejects.toThrow('physical');
  });
  it('embeds complete generated Quiz content for export before the first edit', async () => {
    const quiz = { type: 'quiz', interactionMode: 'assessment_review', questions: [{ id: 'q', type: 'single', question: 'Choose',
      options: [{ value: 'A', label: 'Hello' }, { value: 'B', label: 'Bye' }], answer: ['B'], explanation: 'Greeting', referenceAnswer: 'Hello' }] };
    const bytes = await packNativeTeachingPptx({ source: await source(), title: 'Quiz', pages: [{ pageId: 'page', actions: [] }], generation: { pages: [{ pageId: 'page', quiz }] } });
    const xml = await (await JSZip.loadAsync(bytes)).file('customXml/deckwise-native.xml')!.async('string');
    const teaching = JSON.parse(xml.slice(xml.indexOf('>') + 1, xml.lastIndexOf('<')).replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'));
    expect(teaching.assessments.page).toEqual(quiz);
  });
  it('reads only speaker-note content for ordinary PPT exports', async () => {
    const zip = await JSZip.loadAsync(await source());
    const rel = 'ppt/slides/_rels/slide1.xml.rels';
    zip.file(rel, (await zip.file(rel)!.async('string')).replace(/<Relationship\b[^>]*Type="[^"]*\/notesSlide"[^>]*\/>/g, '').replace('</Relationships>', '<Relationship Id="notes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>'));
    zip.file('ppt/notesSlides/notesSlide1.xml', '<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Teacher narration</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>1</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>');
    const bytes = await packNativeTeachingPptx({ source: await zip.generateAsync({ type: 'uint8array' }), title: 'Notes', pages: [{ pageId: 'page', actions: [] }], generation: {} });
    const xml = await (await JSZip.loadAsync(bytes)).file('customXml/deckwise-native.xml')!.async('string');
    expect(xml).toContain('"text":"Teacher narration"');
    expect(xml).not.toContain('Teacher narration\\n1');
  });
});
