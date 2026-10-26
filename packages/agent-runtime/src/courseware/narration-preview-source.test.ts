import { expect, it } from 'vitest';
import JSZip from 'jszip';
import { narrationPreviewSource } from './narration-preview-source.js';

it('rasterizes a disposable source without external relationships, macros or embedded executables', async () => {
  const source = new JSZip();
  source.file('ppt/slides/slide1.xml', '<slide>Keep the original content</slide>');
  source.file('ppt/slides/_rels/slide1.xml.rels', '<Relationships><Relationship Id="ok" Target="../media/image.png"/><Relationship Id="external" Target="https://private.invalid" TargetMode="External"/><r:Relationship TargetMode=\'External\' Id="file" Target="file:///private"/></Relationships>');
  source.file('ppt/vbaProject.bin', 'macro'); source.file('ppt/embeddings/object.bin', 'active');
  const bytes = await source.generateAsync({ type: 'nodebuffer' }), before = Buffer.from(bytes);
  const prepared = await JSZip.loadAsync(await narrationPreviewSource(bytes));
  const rels = await prepared.file('ppt/slides/_rels/slide1.xml.rels')!.async('string');
  expect(rels).toContain('Id="ok"'); expect(rels).not.toContain('private');
  expect(prepared.file('ppt/vbaProject.bin')).toBeNull(); expect(prepared.file('ppt/embeddings/object.bin')).toBeNull();
  expect(await prepared.file('ppt/slides/slide1.xml')!.async('string')).toContain('Keep the original content');
  expect(bytes).toEqual(before);
});
