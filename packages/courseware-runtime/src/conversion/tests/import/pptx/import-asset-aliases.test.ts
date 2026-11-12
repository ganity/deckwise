import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { PptxImportAssetRegistry } from '../../../lib/import/pptx/pptx-import-asset-registry';

test('concurrent JPEG/JPG source aliases share one content-addressed file and metadata', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'asset-aliases-'));
  try {
    const registry = new PptxImportAssetRegistry('local', directory, 4096);
    const buffer = Buffer.from('same source media bytes');
    const refs = await Promise.all(['jpeg', 'jpg', 'jpeg'].map((ext, i) => registry.registerAsset({
      sourceKey: `ppt/media/image${i}.${ext}`, assetType: 'image', mimeType: 'image/jpeg', ext, buffer,
    })));
    expect(new Set(refs).size).toBe(1);
    const files = await readdir(directory);
    expect(files).toHaveLength(2);
    const media = files.find(name => !name.endsWith('.json'))!;
    expect(await readFile(path.join(directory, media))).toEqual(buffer);
    expect(JSON.parse(await readFile(path.join(directory, files.find(name => name.endsWith('.json'))!), 'utf8')).ext).toBe(path.extname(media).slice(1));
    registry.assertWithinBudget();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
