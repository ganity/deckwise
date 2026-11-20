import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import PptxGen from '../../../../../vendor/pptxgenjs/index.cjs';
import { importPptxFromBuffer } from '../../../lib/import/pptx/import-pptx-from-buffer';
import { mapSlideIrToScenes } from '../../../lib/import/mappers/import-ir-to-classroom';

async function equation(body: string) {
  const deck = new PptxGen();
  deck.addSlide().addText('placeholder', { x: 2, y: 1, w: 2, h: 1.5, objectName: 'fraction-formula' });
  const zip = await JSZip.loadAsync(await deck.write({ outputType: 'nodebuffer' }));
  const path = 'ppt/slides/slide1.xml';
  const xml = await zip.file(path)!.async('string');
  const shapeId = xml.match(/<p:cNvPr id="(\d+)" name="fraction-formula"/)![1];
  zip.file(path, xml.replace(/<p:txBody>[\s\S]*?<\/p:txBody>/, `<p:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="l"/><a14:m xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:oMathPara><m:oMath>${body}</m:oMath></m:oMathPara></a14:m></a:p></p:txBody>`));
  return { shapeId, ir: await importPptxFromBuffer({ arrayBuffer: await zip.generateAsync({ type: 'arraybuffer' }), fileName: 'math.pptx', narrationMode: 'original' }) };
}

it.each(['1', '3'])('preserves native %s/4 formula content, identity and playable fraction layout', async numerator => {
  const { ir, shapeId } = await equation(`<m:f><m:fPr><m:type m:val="bar"/></m:fPr><m:num><m:r><a:rPr sz="7200"><a:solidFill><a:srgbClr val="236DA8"/></a:solidFill></a:rPr><m:t>${numerator}</m:t></m:r></m:num><m:den><m:r><m:t>4</m:t></m:r></m:den></m:f>`);
  const formulas = ir.pages[0].elements.filter(e => e.sourceShapeId === shapeId);
  expect(formulas).toHaveLength(1);
  expect(formulas[0]).toMatchObject({ type: 'formula', sourceObjectName: 'fraction-formula', latex: `\\frac{${numerator}}{4}` });
  expect(formulas[0].content).toContain('border-top:');
  expect(formulas[0].content).toContain('#236DA8');
  const slide = mapSlideIrToScenes('math', ir)[0].content;
  expect(JSON.stringify(slide)).toContain('border-top:');
  expect(ir.warnings?.some(w => w.code === 'PPTX_NATIVE_MATH_UNVERIFIED')).toBe(false);
});

it('keeps the unsupported-math gate for roots instead of claiming conversion fidelity', async () => {
  const { ir } = await equation('<m:rad><m:e><m:r><m:t>2</m:t></m:r></m:e></m:rad>');
  expect(ir.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'PPTX_NATIVE_MATH_UNVERIFIED', severity: 'error' })]));
});

it('restores every source binding in the four-page paid Master regression, including grouped fractions', async () => {
  const bytes = await readFile('tests/fixtures/native-math/fractions.pptx');
  const ir = await importPptxFromBuffer({ arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), fileName: 'fractions.pptx', narrationMode: 'original' });
  expect(ir.pages).toHaveLength(4);
  for (const page of ir.pages) {
    expect(page.elements.filter(e => !e.sourceShapeId)).toEqual([]);
    expect(new Set(page.elements.map(e => e.sourceShapeId)).size).toBe(page.elements.length);
  }
  expect(ir.pages.flatMap(p => p.elements.filter(e => e.type === 'formula').map(e => e.latex))).toEqual(['\\frac{1}{4}', '\\frac{3}{4}']);
  expect(ir.warnings?.some(w => w.code === 'PPTX_NATIVE_MATH_UNVERIFIED')).toBe(false);
});
