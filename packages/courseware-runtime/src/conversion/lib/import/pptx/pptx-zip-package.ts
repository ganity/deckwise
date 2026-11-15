import JSZip, { type JSZipObject } from 'jszip';

const MAX_ARCHIVE_ENTRIES = 5_000;
const MAX_PPTX_BYTES = 512 * 1024 * 1024;
const MAX_PPTX_TOTAL_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024;
const MAX_MEDIA_BYTES = 256 * 1024 * 1024;
const MAX_REFERENCED_MEDIA_BYTES = 1024 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 200;

export type ExternalMediaResolution =
  | {
      status: 'resolved';
      sourceKey: string;
      assetPath: string;
      mimeType: string;
      bytes: Uint8Array;
    }
  | {
      status: 'remote' | 'invalid' | 'missing' | 'ambiguous';
      basename?: string;
    };

export interface PptxZipPackage {
  pptxFileName: string;
  pptxBuffer: ArrayBuffer;
  entryCount: number;
  resolveExternalMedia(target: string): Promise<ExternalMediaResolution>;
}

function decodeLegacyZipFileName(bytes: Uint8Array | Buffer | string[]): string {
  const input = Array.isArray(bytes)
    ? Uint8Array.from(bytes, (value) => value.charCodeAt(0))
    : bytes;
  return new TextDecoder('gb18030', { fatal: true }).decode(input);
}

export async function loadPptxZipPackage(buffer: ArrayBuffer): Promise<PptxZipPackage> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer, { decodeFileName: decodeLegacyZipFileName });
  } catch (error) {
    throw zipError('INVALID_ZIP_PACKAGE', '无法读取 ZIP 课件包', error);
  }

  const entries = Object.values(zip.files);
  assertEntryCountWithinLimit(entries);

  const indexedEntries = entries.map((entry) => ({
    entry,
    path: normalizeArchivePath(entry.name),
  }));
  for (const item of indexedEntries) {
    if (isUnsafeArchivePath(item.entry.unsafeOriginalName ?? item.entry.name)) {
      throw zipError('ZIP_UNSAFE_ENTRY', 'ZIP 文件路径不安全');
    }
  }

  const pptxEntries = indexedEntries.filter(({ entry, path }) => isEligiblePptx(entry, path));
  if (pptxEntries.length === 0) {
    throw zipError('ZIP_PPTX_MISSING', 'ZIP 中未找到 PPTX 文件');
  }
  if (pptxEntries.length > 1) {
    throw zipError('ZIP_MULTIPLE_PPTX', 'ZIP 中只能包含一个 PPTX 文件');
  }

  const pptx = pptxEntries[0]!;
  assertEntryWithinLimits(pptx.entry, MAX_PPTX_BYTES);
  const pptxBuffer = await pptx.entry.async('arraybuffer');
  const mediaEntries = indexedEntries.filter(
    ({ entry, path }) => !entry.dir && path !== pptx.path && !isIgnoredMetadataPath(path),
  );
  const resolutionCache = new Map<string, Promise<ExternalMediaResolution>>();
  let extractedMediaBytes = 0;

  return {
    pptxFileName: basename(pptx.path),
    pptxBuffer,
    entryCount: entries.length,
    resolveExternalMedia(target) {
      const matched = resolveExternalMedia(target, mediaEntries);
      if (!matched.entry) return Promise.resolve(matched.result);

      const cached = resolutionCache.get(matched.path);
      if (cached) return cached;

      const resolution = (async (): Promise<ExternalMediaResolution> => {
        const size = assertEntryWithinLimits(matched.entry, MAX_MEDIA_BYTES);
        if (extractedMediaBytes + size > MAX_REFERENCED_MEDIA_BYTES) {
          throw zipError('ZIP_LIMIT_EXCEEDED', 'ZIP 引用媒体总大小超过限制');
        }
        extractedMediaBytes += size;

        return {
          status: 'resolved' as const,
          sourceKey: `zip:${matched.path}`,
          assetPath: matched.path,
          mimeType: guessMimeType(matched.path),
          bytes: await matched.entry.async('uint8array'),
        };
      })();
      resolutionCache.set(matched.path, resolution);
      return resolution;
    },
  };
}

export function assertPptxZipWithinLimits(
  zip: JSZip,
  maxExpandedBytes = MAX_PPTX_TOTAL_UNCOMPRESSED_BYTES,
): void {
  const entries = Object.values(zip.files);
  assertEntryCountWithinLimit(entries);

  let totalBytes = 0;
  for (const entry of entries) {
    if (isUnsafeArchivePath(entry.unsafeOriginalName ?? entry.name)) {
      throw zipError('ZIP_UNSAFE_ENTRY', 'ZIP 文件路径不安全');
    }
    if (entry.dir) continue;
    totalBytes += assertEntryWithinLimits(entry, MAX_PPTX_BYTES);
    if (totalBytes > maxExpandedBytes) {
      throw zipError('ZIP_LIMIT_EXCEEDED', 'PPTX 解压后总大小超过限制');
    }
  }
}

function resolveExternalMedia(
  target: string,
  entries: Array<{ entry: JSZipObject; path: string }>,
):
  | { entry: JSZipObject; path: string; result?: never }
  | { entry?: never; path?: never; result: ExternalMediaResolution } {
  const normalized = normalizeExternalTarget(target);
  if (normalized.status !== 'local') {
    return { entry: undefined, result: normalized.result };
  }

  const targetSegments = splitPath(normalized.path);
  let bestLength = 0;
  let best: Array<{ entry: JSZipObject; path: string }> = [];
  for (const candidate of entries) {
    const suffixLength = matchingSuffixLength(targetSegments, splitPath(candidate.path));
    if (suffixLength === 0) continue;
    if (suffixLength > bestLength) {
      bestLength = suffixLength;
      best = [candidate];
    } else if (suffixLength === bestLength) {
      best.push(candidate);
    }
  }

  if (best.length === 1) return best[0]!;
  if (best.length > 1) {
    return {
      entry: undefined,
      result: { status: 'ambiguous', basename: normalized.basename },
    };
  }
  return {
    entry: undefined,
    result: { status: 'missing', basename: normalized.basename },
  };
}

function normalizeExternalTarget(
  target: string,
):
  | { status: 'local'; path: string; basename: string }
  | { status: 'other'; result: ExternalMediaResolution } {
  const trimmed = decodeTarget(target.trim()).normalize('NFC');
  const remote = /^(?:https?:)?\/\//i.test(trimmed);
  if (remote) {
    return {
      status: 'other',
      result: { status: 'remote', basename: safeTargetBasename(trimmed) },
    };
  }
  if (!trimmed || /^null$/i.test(trimmed) || trimmed.includes('\0')) {
    return {
      status: 'other',
      result: { status: 'invalid', basename: safeTargetBasename(trimmed) },
    };
  }

  const withoutFileScheme = trimmed.replace(/^file:(?:\/\/\/?)?/i, '');
  if (/^[a-z][a-z0-9+.-]*:/i.test(withoutFileScheme) && !/^[a-z]:[\\/]/i.test(withoutFileScheme)) {
    return {
      status: 'other',
      result: { status: 'invalid', basename: safeTargetBasename(withoutFileScheme) },
    };
  }

  const path = withoutFileScheme
    .split(/[?#]/, 1)[0]!
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/^[a-z]:\//i, '')
    .normalize('NFC');
  const targetBasename = basename(path);
  if (!targetBasename) {
    return { status: 'other', result: { status: 'invalid' } };
  }
  return { status: 'local', path, basename: targetBasename };
}

function decodeTarget(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeArchivePath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .normalize('NFC');
}

function isUnsafeArchivePath(value: string): boolean {
  const path = value.replace(/\\/g, '/');
  return (
    path.includes('\0') ||
    path.startsWith('/') ||
    /^[a-z]:\//i.test(path) ||
    path.split('/').includes('..')
  );
}

function isEligiblePptx(entry: JSZipObject, path: string): boolean {
  const name = basename(path);
  return (
    !entry.dir &&
    path.toLowerCase().endsWith('.pptx') &&
    !name.startsWith('~$') &&
    !isIgnoredMetadataPath(path)
  );
}

function isIgnoredMetadataPath(path: string): boolean {
  const normalized = path.toLowerCase();
  return normalized.startsWith('__macosx/') || basename(normalized) === '.ds_store';
}

function assertEntryCountWithinLimit(entries: JSZipObject[]): void {
  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    throw zipError('ZIP_LIMIT_EXCEEDED', `ZIP 文件数量超过 ${MAX_ARCHIVE_ENTRIES}`);
  }
}

function assertEntryWithinLimits(entry: JSZipObject, maxBytes: number): number {
  const metadata = (
    entry as JSZipObject & {
      _data?: { compressedSize?: number; uncompressedSize?: number };
    }
  )._data;
  const compressedSize = metadata?.compressedSize;
  const uncompressedSize = metadata?.uncompressedSize;
  if (
    !Number.isFinite(compressedSize) ||
    !Number.isFinite(uncompressedSize) ||
    compressedSize == null ||
    uncompressedSize == null ||
    compressedSize < 0 ||
    uncompressedSize < 0
  ) {
    throw zipError('ZIP_UNSAFE_ENTRY', 'ZIP 文件大小元数据无效');
  }
  if (uncompressedSize > maxBytes) {
    throw zipError('ZIP_LIMIT_EXCEEDED', 'ZIP 文件解压后大小超过限制');
  }
  if (
    uncompressedSize > 0 &&
    (compressedSize === 0 || uncompressedSize / compressedSize > MAX_COMPRESSION_RATIO)
  ) {
    throw zipError('ZIP_LIMIT_EXCEEDED', 'ZIP 文件压缩比超过限制');
  }
  return uncompressedSize;
}

function matchingSuffixLength(left: string[], right: string[]): number {
  let matched = 0;
  while (
    matched < left.length &&
    matched < right.length &&
    left[left.length - 1 - matched] === right[right.length - 1 - matched]
  ) {
    matched += 1;
  }
  return matched;
}

function splitPath(value: string): string[] {
  return value
    .split('/')
    .filter(Boolean)
    .map((part) => part.toLowerCase());
}

function safeTargetBasename(target: string): string | undefined {
  const value = basename(target.replace(/\\/g, '/').split(/[?#]/, 1)[0] ?? '');
  return value || undefined;
}

function basename(value: string): string {
  return value.slice(value.lastIndexOf('/') + 1);
}

function guessMimeType(value: string): string {
  const extension = basename(value).toLowerCase().split('.').pop();
  if (extension === 'png') return 'image/png';
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'gif') return 'image/gif';
  if (extension === 'webp') return 'image/webp';
  if (extension === 'svg') return 'image/svg+xml';
  if (extension === 'bmp') return 'image/bmp';
  if (extension === 'mp4' || extension === 'm4v') return 'video/mp4';
  if (extension === 'webm') return 'video/webm';
  if (extension === 'mov') return 'video/quicktime';
  if (extension === 'mp3') return 'audio/mpeg';
  if (extension === 'wav') return 'audio/wav';
  if (extension === 'ogg') return 'audio/ogg';
  if (extension === 'aac') return 'audio/aac';
  if (extension === 'm4a') return 'audio/mp4';
  return 'application/octet-stream';
}

function zipError(code: string, message: string, cause?: unknown): Error {
  return new Error(`${code}: ${message}`, cause == null ? undefined : { cause });
}
