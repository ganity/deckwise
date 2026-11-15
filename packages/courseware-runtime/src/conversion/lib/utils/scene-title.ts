const HAN_PATTERN = /\p{Script=Han}/u;
const TITLE_BREAK_PATTERN = /[：:。；;！？!?]/u;
const ZH_TITLE_MAX = 24;
const OTHER_TITLE_MAX = 72;

export function normalizeSceneTitle(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';

  const isEnglishLeadingBilingualTitle =
    /^[A-Za-z]/u.test(normalized) && HAN_PATTERN.test(normalized);
  const maxLength =
    HAN_PATTERN.test(normalized) && !isEnglishLeadingBilingualTitle
      ? ZH_TITLE_MAX
      : OTHER_TITLE_MAX;
  const chars = [...normalized];
  if (chars.length <= maxLength) return normalized;

  if (HAN_PATTERN.test(normalized)) {
    const firstClause = normalized.split(TITLE_BREAK_PATTERN)[0]?.trim() ?? '';
    if ([...firstClause].length >= 4 && [...firstClause].length <= maxLength) {
      return firstClause;
    }
  }

  return `${chars.slice(0, maxLength - 1).join('')}…`;
}

type SceneTitleContext = {
  title: string;
  description?: string;
  keyPoints?: string[];
};

function findDistinctiveEnglishQuestion(item: SceneTitleContext): string | undefined {
  const context = [item.description, ...(item.keyPoints ?? [])].filter(Boolean).join(' ');
  const match = context.match(
    /\b(?:what|where|when|who|whose|which|why|how|do|does|did|is|are|can|could|would|will)\b[^?\n]{1,58}\?/iu,
  );
  return match?.[0].replace(/\s+/gu, ' ').trim();
}

function buildDistinctiveDuplicateTitle(item: SceneTitleContext, title: string): string {
  const question = findDistinctiveEnglishQuestion(item);
  if (!question) return title;
  return normalizeSceneTitle(
    HAN_PATTERN.test(title) ? `${question} ${title}` : `${title}: ${question}`,
  );
}

export function normalizeSceneTitles<T extends SceneTitleContext>(items: readonly T[]): T[] {
  const normalizedTitles = items.map((item) => normalizeSceneTitle(item.title));
  const titleCounts = new Map<string, number>();
  normalizedTitles.forEach((title) => titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1));

  return items.map((item, index) => {
    const normalizedTitle = normalizedTitles[index] ?? '';
    const title =
      (titleCounts.get(normalizedTitle) ?? 0) > 1
        ? buildDistinctiveDuplicateTitle(item, normalizedTitle)
        : normalizedTitle;
    return title === item.title ? item : { ...item, title };
  });
}
