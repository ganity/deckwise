/** URL-bearing fields used by current MAIC PPTist/Quiz package projections. */
export const maicResourceFields = new Set(['src', 'resolvedSrc', 'audioUrl', 'resolvedAudioUrl', 'poster', 'posterUrl', 'resolvedPoster', 'pattern', 'resolvedPattern']);
export function visitMaicResources(value: unknown, replace: (url: string) => string): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (maicResourceFields.has(key) && typeof child === 'string' && child)
      (value as Record<string, unknown>)[key] = replace(child);
    else visitMaicResources(child, replace);
  }
}
export function assertPortableMaicUrl(url: string): void {
  if (/^(?:file:|data:|blob:|[a-z]:[\\/]|\.{1,2}[\\/]|\/|\\\\)/i.test(url)) throw new Error(`Local filesystem path or temporary URL cannot enter MAIC archive: ${url}`);
}
export function collectMaicResources(value: unknown): Set<string> {
  const urls = new Set<string>();
  const visit = (candidate: unknown) => {
    if (!candidate || typeof candidate !== 'object') return;
    for (const [key, child] of Object.entries(candidate)) {
      if (maicResourceFields.has(key) && typeof child === 'string' && child) urls.add(child);
      else visit(child);
    }
  };
  visit(value); return urls;
}
export function sniffMaicMime(bytes: Uint8Array): string | undefined {
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.slice(start, start + length));
  if (bytes[0] === 0x89 && ascii(1, 3) === 'PNG') return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'audio/wav';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 3) === 'ID3' || bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  if (ascii(4, 4) === 'ftyp') return 'video/mp4';
  if ([0x1a, 0x45, 0xdf, 0xa3].every((byte, i) => bytes[i] === byte)) return 'video/webm';
  if (/<svg(?:\s|>)/i.test(new TextDecoder().decode(bytes.slice(0, 4096)))) return 'image/svg+xml';
  return undefined;
}
