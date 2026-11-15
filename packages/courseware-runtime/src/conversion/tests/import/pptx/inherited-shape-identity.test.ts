import JSZip from 'jszip';
import { expect, it } from 'vitest';
import PptxGen from '../../../../../vendor/pptxgenjs/index.cjs';
import { importPptxFromBuffer } from '../../../lib/import/pptx/import-pptx-from-buffer';

it('retains layout artwork with colliding part-local ids without giving it slide identity', async () => {
  const pptx = new PptxGen();
  pptx.addSlide().addText('Native title', { x: 1, y: 1, w: 4, h: 1 });
  const zip = await JSZip.loadAsync(await pptx.write({ outputType: 'nodebuffer' }));
  const slide = await zip.file('ppt/slides/slide1.xml')!.async('string');
  const shapeId = [...slide.matchAll(/<p:cNvPr\b[^>]*\bid="(\d+)"/g)][1][1];
  const layoutPath = 'ppt/slideLayouts/slideLayout1.xml';
  const layout = await zip.file(layoutPath)!.async('string');
  zip.file(layoutPath, layout.replace('</p:spTree>', `<p:sp><p:nvSpPr><p:cNvPr id="${shapeId}" name="Layout decoration"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="E0E0E0"/></a:solidFill></p:spPr></p:sp></p:spTree>`));
  const ir = await importPptxFromBuffer({ arrayBuffer: await zip.generateAsync({ type: 'arraybuffer' }), fileName: 'inherited.pptx', narrationMode: 'original' });
  const inherited = ir.pages[0].elements.filter(e => e.id.startsWith('pptx_fallback_layout_'));
  expect(inherited.length).toBeGreaterThan(0);
  expect(inherited.every(e => !e.sourceShapeId && !e.sourceGroupShapeIds && e.sourceOrder === undefined)).toBe(true);
  expect(ir.pages[0].elements.filter(e => e.sourceShapeId === shapeId)).toHaveLength(1);
});

it.each([
  ['<a:schemeClr val="bg1"></a:schemeClr>', 'warning'],
  ['<a:srgbClr val="FF0000"/>', 'error'],
] as const)('distinguishes default notes background %s from custom content', async (color, severity) => {
  const pptx = new PptxGen();
  pptx.addSlide().addText('Native title', { x: 1, y: 1, w: 4, h: 1 });
  const zip = await JSZip.loadAsync(await pptx.write({ outputType: 'nodebuffer' }));
  zip.file('ppt/notesMasters/notesMaster1.xml', `<p:notesMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:bg><p:bgPr><a:solidFill>${color}</a:solidFill></p:bgPr></p:bg><p:spTree/></p:cSld></p:notesMaster>`);
  const ir = await importPptxFromBuffer({ arrayBuffer: await zip.generateAsync({ type: 'arraybuffer' }), fileName: 'notes.pptx', narrationMode: 'original' });
  expect(ir.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'PPTX_NOTES_MASTER_UNVERIFIED', severity })]));
});
