import { useMemo } from "react";
import type { PPTElementOutline } from "../../../../../lib/types/slides";

export function getStrokeDashArray(
  style: PPTElementOutline["style"],
  width: number,
) {
  if (style === "dashed")
    return width <= 6
      ? `${width * 4.5} ${width * 2}`
      : `${width * 4} ${width * 1.5}`;
  if (style === "dotted")
    return width <= 6
      ? `${width * 1.8} ${width * 1.6}`
      : `${width * 1.5} ${width * 1.2}`;
  return "0 0";
}

/**
 * Calculate element outline (border) styles
 * Handles default values and stroke dash array for dashed/dotted borders
 * @param outline Outline configuration
 */
export function useElementOutline(outline?: PPTElementOutline) {
  const outlineWidth = useMemo(() => outline?.width ?? 0, [outline?.width]);

  const outlineStyle = useMemo(
    () => outline?.style || "solid",
    [outline?.style],
  );

  const outlineColor = useMemo(
    () => outline?.color || "#d14424",
    [outline?.color],
  );

  const strokeDashArray = useMemo(
    () => getStrokeDashArray(outlineStyle, outlineWidth),
    [outlineWidth, outlineStyle],
  );

  return {
    outlineWidth,
    outlineStyle,
    outlineColor,
    strokeDashArray,
  };
}
