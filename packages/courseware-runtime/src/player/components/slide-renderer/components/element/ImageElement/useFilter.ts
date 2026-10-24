import { useMemo } from 'react';
import type { ImageElementFilters } from '../../../../../lib/types/slides';

export function buildImageFilter(filters?: ImageElementFilters) {
  if (!filters) return '';

  const values: string[] = [];
  for (const [key, raw] of Object.entries(filters as Record<string, unknown>)) {
    if (typeof raw === 'string' && raw) {
      values.push(`${key}(${raw})`);
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;

    const legacy = raw as { type?: unknown; value?: unknown };
    const type = typeof legacy.type === 'string' ? legacy.type : key;
    if (typeof legacy.value === 'string' && legacy.value) {
      values.push(`${type}(${legacy.value})`);
    }
  }
  return values.join(' ');
}

/**
 * Calculate CSS filter string from image filters array
 * @param filters Array of image filters
 */
export function useFilter(filters?: ImageElementFilters) {
  const filter = useMemo(() => buildImageFilter(filters), [filters]);

  return {
    filter,
  };
}
