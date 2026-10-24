import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import sharp from 'sharp';


type PptxImportAssetType = 'image' | 'video' | 'audio';

interface RegisteredAssetMetadata {
  assetType: PptxImportAssetType;
  mimeType: string;
  ext: string;
  checksum: string;
}

export class PptxImportAssetRegistry {
  private readonly bySourceKey = new Map<string, Promise<string>>();
  private readonly byChecksum = new Map<string, string>();
  private readonly assetDir: string;
  private reservedBytes = 0;

  constructor(
    private readonly jobId: string,
    assetDirectory: string,
    private readonly maxBytes = Infinity,
  ) {
    this.assetDir = assetDirectory;
  }

  assertWithinBudget(): void {
    if (this.reservedBytes > this.maxBytes) {
      throw new Error('PPTX_OUTPUT_LIMIT: Import assets exceed the local output limit');
    }
  }

  async registerAsset(input: {
    assetType: PptxImportAssetType;
    sourceKey: string;
    mimeType: string;
    buffer: Uint8Array | Buffer;
    ext?: string;
  }): Promise<string> {
    const cached = this.bySourceKey.get(input.sourceKey);
    if (cached) {
      return cached;
    }

    const task = this.persistAsset(input);
    this.bySourceKey.set(input.sourceKey, task);
    return task;
  }

  private async persistAsset(input: {
    assetType: PptxImportAssetType;
    sourceKey: string;
    mimeType: string;
    buffer: Uint8Array | Buffer;
    ext?: string;
  }): Promise<string> {
    const normalizedInput = await normalizeImportAsset(input);
    const buffer = Buffer.isBuffer(normalizedInput.buffer)
      ? normalizedInput.buffer
      : Buffer.from(normalizedInput.buffer);
    const checksum = createHash('sha1').update(buffer).digest('hex');
    const ext = normalizeExtension(
      normalizedInput.ext,
      normalizedInput.mimeType,
      normalizedInput.assetType,
    );
    const checksumKey = `${normalizedInput.assetType}:${checksum}:${ext}`;
    const existing = this.byChecksum.get(checksumKey);
    if (existing) {
      return buildImportAssetPlaceholder(this.jobId, existing);
    }

    const assetId = `${normalizedInput.assetType}_${checksum.slice(0, 20)}`;
    const assetPath = path.join(this.assetDir, `${assetId}.${ext}`);
    const metadataPath = path.join(this.assetDir, `${assetId}.json`);
    const metadata: RegisteredAssetMetadata = {
      assetType: normalizedInput.assetType,
      mimeType: normalizedInput.mimeType,
      ext,
      checksum,
    };
    const metadataJson = JSON.stringify(metadata);
    // Reserve before the first await so concurrent assets cannot each spend the same space.
    this.reservedBytes += buffer.length + Buffer.byteLength(metadataJson);
    this.assertWithinBudget();
    await fs.mkdir(this.assetDir, { recursive: true });
    await fs.writeFile(assetPath, buffer);
    await fs.writeFile(metadataPath, metadataJson);
    this.byChecksum.set(checksumKey, assetId);
    return buildImportAssetPlaceholder(this.jobId, assetId);
  }
}

async function normalizeImportAsset(input: {
  assetType: PptxImportAssetType;
  sourceKey: string;
  mimeType: string;
  buffer: Uint8Array | Buffer;
  ext?: string;
}) {
  const ext = input.ext?.trim().replace(/^\./, '').toLowerCase();
  const isTiff =
    input.assetType === 'image' &&
    (input.mimeType.toLowerCase() === 'image/tiff' || ext === 'tif' || ext === 'tiff');
  if (!isTiff) return input;

  try {
    return {
      ...input,
      mimeType: 'image/png',
      ext: 'png',
      buffer: await sharp(input.buffer).png().toBuffer(),
    };
  } catch {
    return input;
  }
}

export function buildImportAssetPlaceholder(jobId: string, assetId: string): string {
  return `import-asset:${jobId}:${assetId}`;
}

function normalizeExtension(
  ext: string | undefined,
  mimeType: string,
  assetType: PptxImportAssetType,
): string {
  const normalizedExt = ext?.trim().replace(/^\./, '').toLowerCase();
  if (normalizedExt) {
    if (!/^[a-z0-9]{1,12}$/.test(normalizedExt)) {
      throw new Error('Invalid import asset extension');
    }
    return normalizedExt;
  }

  const normalizedMime = mimeType.trim().toLowerCase();
  if (normalizedMime === 'image/svg+xml') return 'svg';
  if (normalizedMime === 'image/jpeg') return 'jpg';
  if (normalizedMime === 'image/png') return 'png';
  if (normalizedMime === 'image/webp') return 'webp';
  if (normalizedMime === 'image/gif') return 'gif';
  if (normalizedMime === 'video/mp4') return 'mp4';
  if (normalizedMime === 'video/webm') return 'webm';
  if (normalizedMime === 'audio/mpeg' || normalizedMime === 'audio/mp3') return 'mp3';
  if (normalizedMime === 'audio/wav') return 'wav';
  if (normalizedMime === 'audio/ogg') return 'ogg';
  if (normalizedMime === 'audio/aac') return 'aac';
  if (normalizedMime === 'audio/mp4') return 'm4a';

  if (assetType === 'video') return 'mp4';
  if (assetType === 'audio') return 'mp3';
  return 'png';
}
