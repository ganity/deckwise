const ENTITY_MAP: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
  apos: "'",
};

const NARRATION_DECORATION_PATTERN =
  /[\p{Extended_Pictographic}\u200D\uFE0E\uFE0F\u20E3★☆◆◇●○■□▪▫▶▷►◀◁◄※]+/gu;
const IMPORT_FILE_MARKER_PATTERN = /[\[【]\s*文件\s*[:：][^\]】]*[\]】]/gu;

export function normalizeImportText(value: unknown): string {
  const raw = coerceImportTextValue(value);
  if (!raw) return '';

  const withoutTags = raw
    .replace(/<\s*br\s*\/?>/gi, ' ')
    .replace(/<\/?\s*(?:p|div|li|tr|td|th|h[1-6]|section|article|ul|ol)\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '');
  const decoded = decodeHtmlEntities(withoutTags)
    .replace(/([A-Za-z])α(?=[A-Za-z])/g, '$1a')
    .replace(/([A-Za-z])ά(?=[A-Za-z])/g, '$1á');
  const normalized = normalizeFormulaPlaceholders(decoded)
    .replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // 清理明显的文件名模式和导入元数据
  return removeImportMetaNoise(normalized);
}

export function sanitizeImportNarrationText(value: unknown): string {
  return normalizeImportText(value)
    .replace(NARRATION_DECORATION_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function removeImportMetaNoise(text: string): string {
  // 清理文件名模式：包含文件扩展名或明显的文件命名模式
  const withoutFileMarkers = text
    .replace(IMPORT_FILE_MARKER_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!withoutFileMarkers || /\.(pptx?|docx?|pdf|xlsx?)$/i.test(withoutFileMarkers)) {
    return '';
  }

  // 清理"讲清XXX这一页的主要内容"模板
  const withoutTemplate = withoutFileMarkers
    .replace(/^讲清(.+?)这一页的主要内容[。.]?$/u, '$1')
    .replace(/^展开讲解(.+?)的核心信息[。.]?$/u, '$1')
    .replace(/^围绕(.+?)提炼当前页的讲解重点[。.]?$/u, '$1');

  if (withoutTemplate !== withoutFileMarkers && withoutTemplate.trim()) {
    return withoutTemplate.trim();
  }

  return withoutFileMarkers;
}

export function summarizeImportText(value: unknown, maxLength: number): string {
  const normalized = normalizeImportText(value);
  if (!normalized) return '';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function normalizeImportTextList(
  values: Array<string | undefined>,
  options?: {
    maxItems?: number;
    maxItemLength?: number;
    maxTotalLength?: number;
  },
): string[] {
  const normalizedItems = Array.from(
    new Set(
      values
        .map((value) => normalizeImportText(value))
        .filter((value): value is string => Boolean(value)),
    ),
  );

  const maxItems = options?.maxItems ?? normalizedItems.length;
  const maxItemLength = options?.maxItemLength ?? Number.MAX_SAFE_INTEGER;
  const maxTotalLength = options?.maxTotalLength ?? Number.MAX_SAFE_INTEGER;

  const result: string[] = [];
  let totalLength = 0;

  for (const item of normalizedItems) {
    if (result.length >= maxItems) break;

    const trimmed = summarizeImportText(item, maxItemLength);
    if (!trimmed) continue;

    const projectedLength = totalLength + trimmed.length;
    if (result.length > 0 && projectedLength > maxTotalLength) break;
    if (result.length === 0 && trimmed.length > maxTotalLength) {
      result.push(summarizeImportText(trimmed, maxTotalLength));
      break;
    }

    result.push(trimmed);
    totalLength = projectedLength;
  }

  return result;
}

export function joinImportFacts(
  values: Array<string | undefined>,
  options?: {
    maxItems?: number;
    maxItemLength?: number;
    maxTotalLength?: number;
    separator?: string;
  },
) {
  const separator = options?.separator ?? '；';
  return normalizeImportTextList(values, options).join(separator);
}

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|\w+);/gi, (match, entity) => {
    const normalizedEntity = String(entity).toLowerCase();
    if (normalizedEntity.startsWith('#x')) {
      const codePoint = Number.parseInt(normalizedEntity.slice(2), 16);
      return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    }
    if (normalizedEntity.startsWith('#')) {
      const codePoint = Number.parseInt(normalizedEntity.slice(1), 10);
      return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    }
    return ENTITY_MAP[normalizedEntity] ?? match;
  });
}

function coerceImportTextValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => coerceImportTextValue(item))
      .filter(Boolean)
      .join(' ');
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const preferredKeys = ['text', 'content', 'title', 'summary', 'label', 'name'];
    const preferred = preferredKeys
      .map((key) => coerceImportTextValue(record[key]))
      .filter(Boolean)
      .join(' ');
    if (preferred) return preferred;
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return '';
}

export function normalizeFormulaPlaceholders(text: string): string {
  return text
    .replace(/\$\s*\\scriptscriptstyle\s*(?:-|–|—|−)?\s*(?:>|→)\s*\$/gi, ' → ')
    .replace(/\$\s*_\s*\{\s*(?:-|–|—|−)?\s*(?:>|→)\s*\}\s*\$/g, ' → ')
    .replace(/\$\s*\{\s*(?:-|–|—|−)?\s*(?:>|→)\s*\}\s*\$/g, ' → ');
}
