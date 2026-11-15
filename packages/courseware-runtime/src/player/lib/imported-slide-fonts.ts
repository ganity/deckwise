import {
  normalizeCoursewareHtmlFonts,
  resolveCoursewareFontFamily,
} from "./courseware-fonts";

export function resolveImportedSlideFontFamily(
  fontFace?: string,
): string | undefined {
  return resolveCoursewareFontFamily(fontFace);
}

export function normalizeImportedSlideHtmlFonts(content: string): string {
  return normalizeCoursewareHtmlFonts(content);
}

export { resolveCoursewareFontStack as resolveImportedSlideFontStack } from "./courseware-fonts";
