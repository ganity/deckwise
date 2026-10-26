import JSZip from 'jszip';

/** Disposable rasterization copy only; external links and active content never reach Office. */
export async function narrationPreviewSource(bytes: Uint8Array): Promise<Buffer> {
  if (!bytes.length || bytes.length > 50 * 1024 * 1024) throw new Error('Invalid narration source size');
  const zip = await JSZip.loadAsync(bytes);
  for (const name of Object.keys(zip.files)) {
    if (/vbaProject|\/embeddings\//iu.test(name)) zip.remove(name);
    else if (name.endsWith('.rels')) {
      const xml = await zip.files[name].async('string');
      zip.file(name, xml.replace(/<(?:\w+:)?Relationship\b[^>]*\bTargetMode\s*=\s*(["'])External\1[^>]*\/?\s*>/giu, ''));
    }
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
