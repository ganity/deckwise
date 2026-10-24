import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GlobalFonts } from '@napi-rs/canvas';
import { createRequire } from 'node:module';
import { importPptxFromBuffer } from '../lib/import/pptx/import-pptx-from-buffer';
import JSZip from 'jszip';
import { assertPptxZipWithinLimits } from '../lib/import/pptx/pptx-zip-package';
import { PptxImportAssetRegistry } from '../lib/import/pptx/pptx-import-asset-registry';
import { exportSavedSourceIdentity } from '../lib/import/pptx/saved-source-identity';

// Local pilot worker limits; the server byte API keeps its existing defaults.
const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const MAX_PAGES = 100;
const [input, output, ...extra] = process.argv.slice(2);
if (!input || !output || extra.length || !path.isAbsolute(input) || !path.isAbsolute(output)) {
  throw new Error('Usage: pptx-worker.mjs <absolute-input.pptx> <new-absolute-output-directory>');
}
if (path.extname(input).toLowerCase() !== '.pptx') throw new Error('PPTX input required');

await mkdir(output);
try {
  // Keep the byte entry independent of network fetching.
  globalThis.fetch = async () => {
    throw new Error('Network access is disabled in the local PPTX worker');
  };
  const handle = await open(input, 'r');
  let bytes: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) {
      throw new Error('ZIP_LIMIT_EXCEEDED: Invalid or oversized PPTX input');
    }
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  if (bytes.length > MAX_INPUT_BYTES)
    throw new Error('PPTX_INPUT_LIMIT: Source grew beyond the input limit');
  const started = performance.now();
  // Inspect declared expansion before the parser inflates page/media content.
  const zip = await JSZip.loadAsync(bytes);
  assertPptxZipWithinLimits(zip, MAX_EXPANDED_BYTES);
  if (
    Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name)).length >
    MAX_PAGES
  ) {
    throw new Error('PPTX_PAGE_LIMIT: Local parsing supports at most 100 pages');
  }
  const assets = new PptxImportAssetRegistry(
    'local',
    path.join(output, 'assets'),
    MAX_OUTPUT_BYTES,
  );
  const ir = await importPptxFromBuffer({
    arrayBuffer: new Uint8Array(bytes).buffer,
    fileName: path.basename(input),
    narrationMode: 'original',
    assetSink: assets,
  });
  // Parser fallbacks may catch individual asset errors; a budget failure remains fatal.
  assets.assertWithinBudget();
  if (ir.pages.length > MAX_PAGES)
    throw new Error('PPTX_PAGE_LIMIT: Worker result exceeds 100 pages');
  const fontPath = createRequire(import.meta.url).resolve(
    '@fontsource/abeezee/files/abeezee-latin-400-normal.woff',
  );
  if (!GlobalFonts.registerFromPath(fontPath, 'W024 packaged measurement font')) {
    throw new Error('Packaged measurement font could not be registered');
  }
  const irJson = JSON.stringify(ir);
  const assetFiles = await readdir(path.join(output, 'assets')).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    },
  );
  const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
  const identity = await exportSavedSourceIdentity(sourceSha256, ir, async (reference) => {
    const match = /^import-asset:local:((?:image|audio|video)_[a-f0-9]{20})$/.exec(reference);
    const files = match
      ? assetFiles.filter((file) => file.startsWith(`${match[1]}.`) && !file.endsWith('.json'))
      : [];
    if (files.length !== 1) throw new Error('IDENTITY_ASSET_MISSING_OR_AMBIGUOUS');
    return readFile(path.join(output, 'assets', files[0]));
  });
  const identityJson = JSON.stringify(identity);
  let outputBytes = Buffer.byteLength(irJson) + Buffer.byteLength(identityJson);
  for (const file of assetFiles) {
    outputBytes += (await stat(path.join(output, 'assets', file))).size;
  }
  // Reserve the Host's maximum report size as well as IR and asset bytes.
  if (outputBytes + 128 * 1024 > MAX_OUTPUT_BYTES)
    throw new Error('PPTX_OUTPUT_LIMIT: Worker result exceeds the local output limit');
  await writeFile(path.join(output, 'slide-ir.json'), irJson);
  await writeFile(path.join(output, 'identity.json'), identityJson);
  await writeFile(
    path.join(output, 'result.json'),
    JSON.stringify({
      status: 'PARSED',
      sourceSha256,
      identitySchemaVersion: identity.schemaVersion,
      identitySha256: createHash('sha256').update(identityJson).digest('hex'),
      elapsedMs: Math.round(performance.now() - started),
      maxRssKiB: process.resourceUsage().maxRSS,
      runtime: process.versions,
      packagedMeasurementFontLoaded: GlobalFonts.has('W024 packaged measurement font'),
      visualFidelity: 'NOT_RUN',
      deckwiseIntegration: 'NOT_IMPLEMENTED',
    }),
  );
} catch (error) {
  await rm(output, { recursive: true, force: true });
  throw error;
}
