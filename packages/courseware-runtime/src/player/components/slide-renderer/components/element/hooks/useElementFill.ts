import { useMemo } from "react";
import type { PPTShapeElement } from "../../../../../lib/types/slides";

/**
 * Calculate element fill style
 * Returns pattern/gradient URL or solid color fill
 * @param element Shape element
 * @param source Source identifier for pattern/gradient IDs
 */
export function useElementFill(element: PPTShapeElement, source: string) {
  const fill = useMemo(() => {
    if (element.pattern) return `url(#${source}-pattern-${element.id})`;
    if (element.gradient) return `url(#${source}-gradient-${element.id})`;
    return element.fill || "none";
  }, [element.pattern, element.gradient, element.fill, element.id, source]);

  return {
    fill,
  };
}

export function getElementFill(
  element: PPTShapeElement,
  ids: { patternId: string; gradientId: string },
) {
  if (element.pattern) return `url(#${ids.patternId})`;
  if (element.gradient) return `url(#${ids.gradientId})`;
  return element.fill || "none";
}
