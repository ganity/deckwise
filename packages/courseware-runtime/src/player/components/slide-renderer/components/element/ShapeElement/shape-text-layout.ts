import type { PPTShapeElement, ShapeText } from "../../../../../lib/types/slides";
import { isIntegratedEllipseCalloutPath } from "./shape-path-transform";

const ELLIPSE_INSCRIBED_INSET_RATIO = (1 - Math.SQRT1_2) / 2;
const TRAILING_EMPTY_PARAGRAPHS =
  /(?:\s*<p\b[^>]*>(?:\s|&nbsp;|&#0*160;|&#x0*a0;|<[^>]+>)*<\/p>)+\s*$/giu;

export interface ShapeTextLayout {
  content: string;
  paddingLeft: number;
  paddingRight: number;
  paddingTop: number;
  paddingBottom: number;
}

export function trimTrailingEmptyShapeParagraphs(content: string): string {
  return content.replace(TRAILING_EMPTY_PARAGRAPHS, "");
}

export function resolveShapeTextLayout(
  element: Pick<
    PPTShapeElement,
    "path" | "viewBox" | "width" | "height" | "sourceShapeId"
  >,
  text: ShapeText,
): ShapeTextLayout {
  const fallback = {
    content: text.content,
    paddingLeft: text.paddingLeft ?? 10,
    paddingRight: text.paddingRight ?? 10,
    paddingTop: text.paddingTop ?? 10,
    paddingBottom: text.paddingBottom ?? 10,
  };
  if (!isIntegratedEllipseCalloutPath(element)) return fallback;

  // PowerPoint lays out ellipse text inside its inscribed rectangle rather
  // than across the full shape transform. Imported legacy scenes only stored
  // the generic text-box padding, so recover that rectangle at render time.
  const horizontalInset = element.width * ELLIPSE_INSCRIBED_INSET_RATIO;
  const verticalInset = element.height * ELLIPSE_INSCRIBED_INSET_RATIO;
  return {
    content: trimTrailingEmptyShapeParagraphs(text.content),
    paddingLeft: Math.max(fallback.paddingLeft, horizontalInset),
    paddingRight: Math.max(fallback.paddingRight, horizontalInset),
    paddingTop: Math.max(fallback.paddingTop, verticalInset),
    paddingBottom: Math.max(fallback.paddingBottom, verticalInset),
  };
}
