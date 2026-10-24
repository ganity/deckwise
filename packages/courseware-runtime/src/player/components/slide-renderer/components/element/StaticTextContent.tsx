import { sanitizeSlideHtml } from "../../../../lib/sanitize-slide-html";
"use client";

import { useLayoutEffect, useRef, type CSSProperties } from "react";
import { normalizeImportedSlideHtmlFonts } from "../../../../lib/imported-slide-fonts";

interface TextAutoFit {
  type?: string;
  fontScale?: number;
  lnSpcReduction?: number;
}

interface StaticTextContentProps {
  content: string;
  className?: string;
  isPptxEntranceAnimationTarget?: boolean;
  autoFit?: TextAutoFit;
  recoverLegacyFixedBoxOverflow?: boolean;
  boxWidth?: number;
  boxHeight: number;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  lineHeight?: number;
  paragraphSpace?: number;
}

interface ImportedParagraphFitInput {
  naturalWidth: number;
  availableWidth: number;
  hasHardBreak?: boolean;
  explicitNoWrap?: boolean;
  sourceSingleLine?: boolean;
  autoFit?: TextAutoFit;
}

interface ImportedTextBoxFitInput {
  naturalWidth: number;
  naturalHeight: number;
  availableWidth: number;
  availableHeight: number;
}

interface ImportedParagraphWrapFitInput {
  availableWidth: number;
  hasDanglingAtWidth: (width: number) => boolean;
}

interface LegacyFixedTextHorizontalRecoveryInput {
  left: number;
  width: number;
  naturalWidth: number;
  leftBound: number;
  rightBound: number;
}

export interface LegacyFixedTextHorizontalRecovery {
  left: number;
  width: number;
}

export interface TextFragmentRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface OverlayRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface PinyinTargetMatch {
  paragraph: HTMLElement;
  glyphRects: DOMRect[];
}

const MIN_IMPORTED_TEXT_SCALE = 0.62;
const MIN_IMPORTED_TEXT_BOX_SCALE = 0.72;
const MAX_COMPACT_SINGLE_LINE_GLYPHS = 48;
const MIN_HORIZONTAL_FIT_OVERFLOW_RATIO = 1.01;
const MAX_SOURCE_SINGLE_LINE_HEIGHT_RATIO = 1.45;
const MAX_NORMAL_AUTOFIT_SINGLE_LINE_HEIGHT_RATIO = 1.65;
const MIN_OVERLAY_INTERSECTION_RATIO = 0.65;
const MAX_PINYIN_TARGET_GAP = 120;
const MAX_OVERLAY_FALLBACK_DISTANCE = 120;
const LEGACY_FIXED_BOX_OVERFLOW_TOLERANCE = 1.5;
const MAX_LEGACY_FIXED_BOX_WIDTH_RATIO = 1.35;
const LEGACY_FIXED_BOX_VIEWPORT_MARGIN = 40;
const MAX_IMPORTED_PARAGRAPH_WRAP_EXPANSION = 1.15;
const IMPORTED_PARAGRAPH_WRAP_SEARCH_STEPS = 10;

const PINYIN_SYLLABLE_PATTERN = /^[\p{Script=Latin}\p{Mark}'’]+$/u;
const PINYIN_SIGNAL_PATTERN = /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜüɡ]/iu;
const PPTX_FIRST_TONE_BASES: Record<string, string> = {
  ā: "a",
  ē: "e",
  ī: "ı",
  ō: "o",
  ū: "u",
  Ā: "A",
  Ē: "E",
  Ī: "I",
  Ō: "O",
  Ū: "U",
};

export function extractPptxPinyinSyllables(text: string): string[] {
  const tokens = text.trim().split(/\s+/u).filter(Boolean);
  if (
    tokens.length < 1 ||
    !PINYIN_SIGNAL_PATTERN.test(text) ||
    tokens.some((token) => Array.from(token).length > 7) ||
    tokens.some((token) => !PINYIN_SYLLABLE_PATTERN.test(token))
  ) {
    return [];
  }
  return tokens;
}

export function shouldAlignPptxPinyinSyllables(
  pinyinText: string,
  targetText: string,
): boolean {
  const syllables = extractPptxPinyinSyllables(pinyinText);
  const hanGlyphs = targetText.match(/\p{Script=Han}/gu) ?? [];
  return syllables.length >= 1 && syllables.length === hanGlyphs.length;
}

export function calculatePptxSyllableOffset(
  syllableCenter: number,
  targetCenter: number,
  viewportScale: number,
): number {
  const scale =
    Number.isFinite(viewportScale) && viewportScale > 0 ? viewportScale : 1;
  return (targetCenter - syllableCenter) / scale;
}

export function calculatePptxFirstToneOffset({
  width,
  actualBoundingBoxLeft,
  actualBoundingBoxRight,
}: Pick<
  TextMetrics,
  "width" | "actualBoundingBoxLeft" | "actualBoundingBoxRight"
>): number {
  return (actualBoundingBoxRight - actualBoundingBoxLeft) / 2 - width / 2;
}

function observeImportedTextLayout(
  container: HTMLElement,
  scheduleMeasure: () => void,
): () => void {
  const viewport = container.closest<HTMLElement>("[data-slide-viewport]");
  const resizeObserver =
    typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(scheduleMeasure);
  const resizeTargets = [container, viewport, viewport?.parentElement].filter(
    (target): target is HTMLElement => Boolean(target),
  );
  resizeTargets.forEach((target) => resizeObserver?.observe(target));

  const viewportObserver =
    !viewport || typeof MutationObserver === "undefined"
      ? undefined
      : new MutationObserver(scheduleMeasure);
  if (viewportObserver && viewport) {
    viewportObserver.observe(viewport, {
      attributes: true,
      attributeFilter: [
        "style",
        "data-courseware-fonts-ready",
        "data-slide-layout-ready",
        "data-slide-layout-revision",
        "data-slide-viewport-mode",
      ],
    });
  }

  return () => {
    resizeObserver?.disconnect();
    viewportObserver?.disconnect();
  };
}

export function hasImportedParagraphLayout(content: string): boolean {
  return /<p\b[^>]*(?:data-pptx-source|data-pptx-paragraph-index)=/i.test(
    content,
  );
}

export function hasImportedSemanticTextAnchor(content: string): boolean {
  return /\bdata-pptx-(?:pinyin|overlay)-anchored=["']true["']/i.test(content);
}

export function hasCompactPowerPointSpaceLayout(
  content: string,
  autoFit?: TextAutoFit,
): boolean {
  if (!hasImportedParagraphLayout(content)) return false;
  const explicitlyMarked = /\bdata-pptx-space-mode=["']powerpoint["']/i.test(
    content,
  );
  if (!explicitlyMarked && autoFit?.type !== "shape") return false;
  if ((content.match(/<p\b/gi) ?? []).length !== 1 || /<br\b/i.test(content)) {
    return false;
  }
  const plainHtml = content.replace(/<[^>]+>/g, "").trim();
  const withoutEdgeSpacing = plainHtml
    .replace(/^(?:(?:&nbsp;|&#160;|&#xA0;|\u00a0)|\s)+/i, "")
    .replace(/(?:(?:&nbsp;|&#160;|&#xA0;|\u00a0)|\s)+$/i, "");
  if (
    (withoutEdgeSpacing.match(/(?:&nbsp;|&#160;|&#xA0;|\u00a0)/gi) ?? [])
      .length < 2
  ) {
    return false;
  }
  const visibleText = content
    .replace(/<[^>]+>/g, "")
    .replace(/(?:&nbsp;|&#160;|&#xA0;|\u00a0)/gi, "")
    .replace(/&[^;]+;/g, "");
  return Array.from(visibleText.trim()).length <= 48;
}

export function hasExplicitPowerPointSpaceLayout(content: string): boolean {
  return /\bdata-pptx-space-mode=["']powerpoint["']/i.test(content);
}

export function hasSourceMeasuredPowerPointSpaces(content: string): boolean {
  return /\bdata-pptx-authored-space=["']true["']/i.test(content);
}

export function resolveTextFrameLetterSpacing(
  content: string,
  wordSpace?: number,
): number {
  // Imported rich text keeps DrawingML tracking on each run. Letting the
  // first run's value also inherit from the frame changes every untracked run
  // and makes static and edit mode disagree.
  return /\bstyle=["'][^"']*\bletter-spacing\s*:/i.test(content)
    ? 0
    : (wordSpace ?? 0);
}

export function hasExplicitImportedMultilineParagraphMetrics(
  content: string,
): boolean {
  if (!hasImportedParagraphLayout(content)) return false;

  const paragraphTags = content.match(/<p\b[^>]*>/gi) ?? [];
  if (paragraphTags.length < 2 && !/<br\b/i.test(content)) return false;

  return paragraphTags.some((paragraphTag) =>
    /\bstyle=["'][^"']*\bline-height\s*:/i.test(paragraphTag),
  );
}

export function hasCompactImportedSingleLineLayout(
  content: string,
  autoFit?: TextAutoFit,
): boolean {
  if (!hasImportedParagraphLayout(content)) {
    return false;
  }
  if ((content.match(/<p\b/gi) ?? []).length !== 1 || /<br\b/i.test(content)) {
    return false;
  }

  const visibleText = content
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|&#160;|&#xA0;/gi, " ")
    .replace(/&[^;]+;/g, "")
    .trim();
  const glyphCount = Array.from(visibleText.replace(/\s/gu, "")).length;
  return glyphCount > 0 && glyphCount <= MAX_COMPACT_SINGLE_LINE_GLYPHS;
}

export function hasSourceSingleLineLayout({
  content,
  autoFit,
  boxHeight,
  paddingTop = 0,
  paddingBottom = 0,
  lineHeight,
}: Pick<
  StaticTextContentProps,
  | "content"
  | "autoFit"
  | "boxHeight"
  | "paddingTop"
  | "paddingBottom"
  | "lineHeight"
>): boolean {
  if (!hasCompactImportedSingleLineLayout(content, autoFit)) return false;

  const fontSizes = Array.from(
    content.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px/gi),
    (match) => Number(match[1]),
  ).filter((value) => Number.isFinite(value) && value > 0);
  const maxFontSize = Math.max(0, ...fontSizes);
  if (maxFontSize <= 0) return false;

  const availableHeight = boxHeight - paddingTop - paddingBottom;
  const lineHeightMultiplier =
    lineHeight != null && lineHeight > 0 && lineHeight <= 3 ? lineHeight : 1.2;
  const heightRatio =
    autoFit?.type === "normal"
      ? MAX_NORMAL_AUTOFIT_SINGLE_LINE_HEIGHT_RATIO
      : MAX_SOURCE_SINGLE_LINE_HEIGHT_RATIO;
  return (
    availableHeight > 0 &&
    availableHeight <= maxFontSize * lineHeightMultiplier * heightRatio
  );
}

export function hasPptxTextOverlayIntersection(
  overlay: OverlayRect,
  source: OverlayRect,
): boolean {
  const intersectionWidth =
    Math.min(overlay.right, source.right) - Math.max(overlay.left, source.left);
  const intersectionHeight =
    Math.min(overlay.bottom, source.bottom) - Math.max(overlay.top, source.top);
  const overlayWidth = overlay.right - overlay.left;
  const sourceWidth = source.right - source.left;
  const overlayHeight = overlay.bottom - overlay.top;
  const sourceHeight = source.bottom - source.top;
  if (
    intersectionWidth <= 0 ||
    intersectionHeight <= 0 ||
    overlayWidth <= 0 ||
    sourceWidth <= 0 ||
    overlayHeight <= 0 ||
    sourceHeight <= 0
  ) {
    return false;
  }

  return (
    intersectionWidth / Math.min(overlayWidth, sourceWidth) >=
      MIN_OVERLAY_INTERSECTION_RATIO &&
    intersectionHeight / Math.min(overlayHeight, sourceHeight) >=
      MIN_OVERLAY_INTERSECTION_RATIO
  );
}

export function calculatePptxOverlayTranslation({
  overlay,
  source,
  viewportScale,
  currentX = 0,
  currentY = 0,
}: {
  overlay: Pick<DOMRect, "left" | "top">;
  source: Pick<DOMRect, "left" | "top">;
  viewportScale: number;
  currentX?: number;
  currentY?: number;
}): { x: number; y: number } {
  const scale =
    Number.isFinite(viewportScale) && viewportScale > 0 ? viewportScale : 1;
  return {
    x: currentX + (source.left - overlay.left) / scale,
    y: currentY + (source.top - overlay.top) / scale,
  };
}

function isAccentOverlayColor(color: string): boolean {
  const channels = color
    .match(/\d+(?:\.\d+)?/g)
    ?.slice(0, 3)
    .map(Number);
  if (!channels || channels.length < 3) return false;
  const [red, green, blue] = channels;
  return (
    Math.max(red, green, blue) >= 150 &&
    Math.max(red, green, blue) - Math.min(red, green, blue) >= 80
  );
}

function collectHanGlyphRects(element: HTMLElement): DOMRect[] {
  const rects: DOMRect[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let textNode = walker.nextNode() as Text | null;
  while (textNode) {
    for (const match of textNode.data.matchAll(/\p{Script=Han}/gu)) {
      const start = match.index ?? 0;
      const range = document.createRange();
      range.setStart(textNode, start);
      range.setEnd(textNode, start + match[0].length);
      const rect = range.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) rects.push(rect);
    }
    textNode = walker.nextNode() as Text | null;
  }
  return rects;
}

function getTextContentRect(element: HTMLElement): DOMRect {
  const range = document.createRange();
  range.selectNodeContents(element);
  const rect = range.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0
    ? rect
    : element.getBoundingClientRect();
}

function findPinyinTargetParagraph(
  paragraph: HTMLElement,
  viewport: HTMLElement,
  syllableCount: number,
): PinyinTargetMatch | undefined {
  const paragraphRect = getTextContentRect(paragraph);
  const viewportScale =
    viewport.clientWidth > 0
      ? viewport.getBoundingClientRect().width / viewport.clientWidth
      : 1;
  let bestMatch:
    | (PinyinTargetMatch & {
        score: number;
      })
    | undefined;

  for (const candidate of viewport.querySelectorAll<HTMLElement>(
    ".pptx-imported-static-text > p",
  )) {
    if (candidate === paragraph) continue;
    const candidateContainer = candidate.closest<HTMLElement>(
      ".pptx-imported-static-text",
    );
    if (candidateContainer?.dataset.pptxAnimationTarget === "true") continue;
    const glyphRects = collectHanGlyphRects(candidate);
    if (glyphRects.length !== syllableCount) continue;

    const candidateRect = getTextContentRect(candidate);
    const gap = candidateRect.top - paragraphRect.bottom;
    if (
      gap < -8 * viewportScale ||
      gap > MAX_PINYIN_TARGET_GAP * viewportScale
    ) {
      continue;
    }

    const overlap =
      Math.min(paragraphRect.right, candidateRect.right) -
      Math.max(paragraphRect.left, candidateRect.left);
    const minimumOverlap =
      Math.min(paragraphRect.width, candidateRect.width) * 0.2;
    if (overlap < minimumOverlap) continue;

    const horizontalCenterDistance = Math.abs(
      paragraphRect.left +
        paragraphRect.width / 2 -
        (candidateRect.left + candidateRect.width / 2),
    );
    const score = Math.abs(gap) + horizontalCenterDistance * 0.08;
    if (!bestMatch || score < bestMatch.score) {
      bestMatch = { paragraph: candidate, glyphRects, score };
    }
  }

  return bestMatch;
}

function wrapPinyinSyllables(paragraph: HTMLElement): HTMLElement[][] {
  const textNodes: Text[] = [];
  const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
  let textNode = walker.nextNode() as Text | null;
  while (textNode) {
    textNodes.push(textNode);
    textNode = walker.nextNode() as Text | null;
  }

  const paragraphText = textNodes.map((node) => node.data).join("");
  const matches = Array.from(paragraphText.matchAll(/\S+/gu));
  if (
    matches.length === 0 ||
    matches.some((match) => !PINYIN_SYLLABLE_PATTERN.test(match[0]))
  ) {
    return [];
  }

  const ranges = matches.map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
  const syllableElements = ranges.map(() => [] as HTMLElement[]);
  let nodeStart = 0;

  for (const node of textNodes) {
    const nodeEnd = nodeStart + node.data.length;
    const overlaps = ranges
      .map((range, index) => ({ range, index }))
      .filter(({ range }) => range.start < nodeEnd && range.end > nodeStart);
    if (overlaps.length === 0) {
      nodeStart = nodeEnd;
      continue;
    }
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const { range, index } of overlaps) {
      const localStart = Math.max(0, range.start - nodeStart);
      const localEnd = Math.min(node.data.length, range.end - nodeStart);
      if (localStart > cursor) {
        fragment.append(node.data.slice(cursor, localStart));
      }
      const syllablePart = document.createElement("span");
      syllablePart.dataset.pptxPinyinSyllable = "true";
      syllablePart.dataset.pptxPinyinSyllableIndex = String(index);
      syllablePart.textContent = node.data.slice(localStart, localEnd);
      fragment.append(syllablePart);
      syllableElements[index].push(syllablePart);
      cursor = localEnd;
    }
    if (cursor < node.data.length) fragment.append(node.data.slice(cursor));
    node.replaceWith(fragment);
    nodeStart = nodeEnd;
  }

  return syllableElements;
}

function getPinyinSyllableCenter(parts: HTMLElement[]): number | undefined {
  const rects = parts
    .map((part) => part.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0);
  if (rects.length === 0) return undefined;
  const left = Math.min(...rects.map((rect) => rect.left));
  const right = Math.max(...rects.map((rect) => rect.right));
  return left + (right - left) / 2;
}

function wrapPptxFirstToneMarks(root: HTMLElement): HTMLElement[] {
  const textNodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let textNode = walker.nextNode() as Text | null;
  while (textNode) {
    if (!textNode.parentElement?.closest("[data-pptx-first-tone]")) {
      textNodes.push(textNode);
    }
    textNode = walker.nextNode() as Text | null;
  }

  const marks: HTMLElement[] = [];
  for (const node of textNodes) {
    const matches = Array.from(node.data.matchAll(/[āēīōūĀĒĪŌŪ]/gu));
    if (matches.length === 0) continue;

    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const match of matches) {
      const start = match.index ?? 0;
      if (start > cursor) fragment.append(node.data.slice(cursor, start));
      const mark = document.createElement("span");
      mark.dataset.pptxFirstTone = "true";
      mark.dataset.pptxToneBase = PPTX_FIRST_TONE_BASES[match[0]] ?? "";
      // Keep the authored code point in textContent. Overlay matching and
      // animation target lookup therefore continue to see the original text.
      mark.textContent = match[0];
      fragment.append(mark);
      marks.push(mark);
      cursor = start + match[0].length;
    }
    if (cursor < node.data.length) fragment.append(node.data.slice(cursor));
    node.replaceWith(fragment);
  }

  return marks;
}

function removePptxFirstToneMarks(marks: HTMLElement[]): void {
  for (const mark of marks) {
    if (!mark.isConnected) continue;
    mark.replaceWith(document.createTextNode(mark.textContent ?? ""));
  }
}

function alignPptxFirstToneMarks(marks: HTMLElement[]): void {
  if (marks.length === 0) return;
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return;

  for (const mark of marks) {
    const base = mark.dataset.pptxToneBase;
    if (!base) continue;
    const computed = getComputedStyle(mark);
    context.font = `${computed.fontStyle} ${computed.fontWeight} ${computed.fontSize} ${computed.fontFamily}`;
    const metrics = context.measureText(base);
    const fontSize = Number.parseFloat(computed.fontSize);
    const lineHeight = Number.parseFloat(computed.lineHeight);
    const lineBoxTop =
      Number.isFinite(fontSize) &&
      Number.isFinite(lineHeight) &&
      lineHeight > fontSize
        ? (lineHeight - fontSize) / 2
        : 0;
    const offset = calculatePptxFirstToneOffset(metrics);
    mark.style.setProperty("--pptx-tone-offset", `${offset}px`);
    mark.style.setProperty("--pptx-tone-line-top", `${lineBoxTop}px`);
  }
}

export function shouldPreservePptxAccentOverlayWidth(
  color: string,
  text: string,
  isPptxEntranceAnimationTarget = false,
): boolean {
  const glyphCount = Array.from(text.replace(/\s/gu, "")).length;
  return (
    isPptxEntranceAnimationTarget &&
    glyphCount > 0 &&
    glyphCount <= 8 &&
    isAccentOverlayColor(color)
  );
}

export function normalizeImportedPowerPointSpaces(
  content: string,
  _autoFit?: TextAutoFit,
): string {
  if (!hasExplicitPowerPointSpaceLayout(content)) return content;

  // pptxtojson serializes authored ASCII spaces as NBSP entities. CJK fonts can
  // render those NBSPs close to full-width, making the browser line much wider
  // than PowerPoint and triggering destructive horizontal glyph scaling. The
  // paragraph uses white-space: pre, so ordinary spaces retain the source count.
  // New imports materialize source-measured spaces as explicit-width spans; keep
  // those spans intact while normalizing legacy NBSPs around them.
  return content.replace(
    /<p\b(?=[^>]*\bdata-pptx-space-mode=["']powerpoint["'])[^>]*>[\s\S]*?<\/p>/gi,
    (paragraph) => {
      const fragments = paragraph.split(
        /(<span\b(?=[^>]*\bdata-pptx-authored-space=["']true["'])[^>]*>[\s\S]*?<\/span>)/gi,
      );
      return fragments
        .map((fragment, index) =>
          index % 2 === 1
            ? fragment
            : fragment.replace(/(?:&nbsp;|&#160;|&#xA0;|\u00a0)/gi, " "),
        )
        .join("");
    },
  );
}

function extractImportedHtmlText(content: string): string {
  return content
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 10)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&(?:nbsp|ensp|emsp);/gi, " ")
    .replace(/&[^;]+;/g, " ");
}

export function mergeTextFragmentLineWidths(
  rects: TextFragmentRect[],
): number[] {
  const lines: TextFragmentRect[] = [];
  const sortedRects = rects
    .filter((rect) => rect.right > rect.left && rect.bottom > rect.top)
    .sort((left, right) => left.top - right.top || left.left - right.left);

  for (const rect of sortedRects) {
    const rectHeight = rect.bottom - rect.top;
    const line = lines.find((candidate) => {
      const overlap =
        Math.min(candidate.bottom, rect.bottom) -
        Math.max(candidate.top, rect.top);
      const candidateHeight = candidate.bottom - candidate.top;
      return overlap > Math.min(candidateHeight, rectHeight) * 0.25;
    });
    if (line) {
      line.left = Math.min(line.left, rect.left);
      line.right = Math.max(line.right, rect.right);
      line.top = Math.min(line.top, rect.top);
      line.bottom = Math.max(line.bottom, rect.bottom);
    } else {
      lines.push({ ...rect });
    }
  }

  return lines.map((line) => line.right - line.left);
}

export function shouldPreserveImportedParagraphLine({
  naturalWidth,
  availableWidth,
  hasHardBreak = false,
  explicitNoWrap = false,
  sourceSingleLine = false,
}: ImportedParagraphFitInput): boolean {
  if (hasHardBreak || naturalWidth <= 0 || availableWidth <= 0) return false;
  if (explicitNoWrap || sourceSingleLine) {
    return availableWidth / naturalWidth >= MIN_IMPORTED_TEXT_SCALE;
  }
  const fitRatio = naturalWidth / availableWidth;
  return fitRatio <= 1.12 && 1 / fitRatio >= MIN_IMPORTED_TEXT_SCALE;
}

export function shouldMeasureImportedSingleLineFit({
  sourceSingleLineLayout,
  explicitPowerPointSpaceLayout: _explicitPowerPointSpaceLayout,
  preserveSourceGlyphOverflow = false,
}: {
  sourceSingleLineLayout: boolean;
  explicitPowerPointSpaceLayout: boolean;
  preserveSourceGlyphOverflow?: boolean;
}): boolean {
  return sourceSingleLineLayout && !preserveSourceGlyphOverflow;
}

export function shouldPreserveSourceSingleGlyphOverflow({
  content,
  autoFit,
  boxWidth = 0,
  paddingLeft = 0,
  paddingRight = 0,
}: {
  content: string;
  autoFit?: TextAutoFit;
  boxWidth: number;
  paddingLeft?: number;
  paddingRight?: number;
}): boolean {
  if (autoFit?.type !== "shape" || boxWidth <= 0) return false;

  const text = extractImportedHtmlText(content).replace(/\s/gu, "");
  if (!/^[\u3400-\u9fff\uf900-\ufaff]$/u.test(text)) return false;

  const fontSizes = Array.from(
    content.matchAll(/font-size:\s*(\d+(?:\.\d+)?)(px|pt)/giu),
    (match) => Number(match[1]) * (match[2].toLowerCase() === "pt" ? 4 / 3 : 1),
  ).filter((fontSize) => Number.isFinite(fontSize) && fontSize > 0);
  const fontSize = Math.max(0, ...fontSizes);
  const availableWidth = boxWidth - paddingLeft - paddingRight;
  return fontSize > 0 && availableWidth > 0 && fontSize > availableWidth * 1.05;
}

export function hasImportedSingleLineOverflow(
  naturalWidth: number,
  availableWidth: number,
): boolean {
  return (
    naturalWidth > 0 &&
    availableWidth > 0 &&
    naturalWidth > availableWidth * MIN_HORIZONTAL_FIT_OVERFLOW_RATIO
  );
}

export function calculateImportedTextBoxFitScale({
  naturalWidth,
  naturalHeight,
  availableWidth,
  availableHeight,
}: ImportedTextBoxFitInput): number {
  if (
    naturalWidth <= 0 ||
    naturalHeight <= 0 ||
    availableWidth <= 0 ||
    availableHeight <= 0
  ) {
    return 1;
  }

  const widthScale = availableWidth / naturalWidth;
  const heightScale = availableHeight / naturalHeight;
  const requiredScale = Math.min(1, widthScale, heightScale);
  if (requiredScale >= 1 / MIN_HORIZONTAL_FIT_OVERFLOW_RATIO) return 1;
  return Math.max(MIN_IMPORTED_TEXT_BOX_SCALE, requiredScale);
}

export function calculateImportedTextBoxHorizontalFitScale({
  naturalWidth,
  availableWidth,
}: Pick<ImportedTextBoxFitInput, "naturalWidth" | "availableWidth">): number {
  if (naturalWidth <= 0 || availableWidth <= 0) return 1;

  const requiredScale = Math.min(1, availableWidth / naturalWidth);
  if (requiredScale >= 1 / MIN_HORIZONTAL_FIT_OVERFLOW_RATIO) return 1;
  return Math.max(MIN_IMPORTED_TEXT_BOX_SCALE, requiredScale);
}

export function calculateImportedParagraphWrapFitWidth({
  availableWidth,
  hasDanglingAtWidth,
}: ImportedParagraphWrapFitInput): number | undefined {
  if (!(availableWidth > 0) || !hasDanglingAtWidth(availableWidth)) {
    return undefined;
  }

  let low = availableWidth;
  let high = availableWidth * MAX_IMPORTED_PARAGRAPH_WRAP_EXPANSION;
  if (hasDanglingAtWidth(high)) return undefined;

  for (
    let index = 0;
    index < IMPORTED_PARAGRAPH_WRAP_SEARCH_STEPS;
    index += 1
  ) {
    const middle = (low + high) / 2;
    if (hasDanglingAtWidth(middle)) low = middle;
    else high = middle;
  }
  return high + 1;
}

function hasDanglingEmptyPlaceholderClosingParenthesis(
  paragraph: HTMLElement,
): boolean {
  const characters: Array<{
    char: string;
    top: number;
    authoredSpace: boolean;
  }> = [];
  const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.textContent ?? "";
    for (let index = 0; index < text.length; index += 1) {
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + 1);
      const rect = range.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      characters.push({
        char: text[index] ?? "",
        top: rect.top,
        authoredSpace: Boolean(
          node.parentElement?.closest('span[data-pptx-authored-space="true"]'),
        ),
      });
    }
  }

  for (let index = 0; index < characters.length; index += 1) {
    if (!/[\uFF09)]/u.test(characters[index]?.char ?? "")) continue;
    let cursor = index - 1;
    let sawAuthoredSpace = false;
    while (cursor >= 0 && /\s/u.test(characters[cursor]?.char ?? "")) {
      sawAuthoredSpace ||= characters[cursor]?.authoredSpace === true;
      cursor -= 1;
    }
    if (!/[\uFF08(]/u.test(characters[cursor]?.char ?? "")) continue;
    if (!sawAuthoredSpace) continue;
    if ((characters[index]?.top ?? 0) - (characters[cursor]?.top ?? 0) > 1) {
      return true;
    }
  }
  return false;
}

export function calculateLegacyFixedTextHorizontalRecovery({
  left,
  width,
  naturalWidth,
  leftBound,
  rightBound,
}: LegacyFixedTextHorizontalRecoveryInput): LegacyFixedTextHorizontalRecovery {
  if (
    ![left, width, naturalWidth, leftBound, rightBound].every(
      Number.isFinite,
    ) ||
    width <= 0 ||
    naturalWidth <= width
  ) {
    return { left, width };
  }

  const safeLeftBound = Math.min(left, leftBound);
  const safeRightBound = Math.max(left + width, rightBound);
  const availableWidth = safeRightBound - safeLeftBound;
  const targetWidth = Math.min(
    naturalWidth,
    width * MAX_LEGACY_FIXED_BOX_WIDTH_RATIO,
    availableWidth,
  );
  let remainingGrowth = Math.max(0, targetWidth - width);
  const rightRoom = Math.max(0, safeRightBound - (left + width));
  const rightGrowth = Math.min(remainingGrowth, rightRoom);
  remainingGrowth -= rightGrowth;
  const leftRoom = Math.max(0, left - safeLeftBound);
  const leftGrowth = Math.min(remainingGrowth, leftRoom);

  return {
    left: left - leftGrowth,
    width: width + rightGrowth + leftGrowth,
  };
}

function hasLegacyFixedBoxOverflow(element: HTMLElement): boolean {
  return (
    element.scrollHeight - element.clientHeight >
      LEGACY_FIXED_BOX_OVERFLOW_TOLERANCE ||
    element.scrollWidth - element.clientWidth >
      LEGACY_FIXED_BOX_OVERFLOW_TOLERANCE
  );
}

export function measureUnwrappedTextWidth(
  container: HTMLElement,
  frame: HTMLElement,
): number {
  const clone = container.cloneNode(true) as HTMLElement;
  Object.assign(clone.style, {
    position: "absolute",
    visibility: "hidden",
    pointerEvents: "none",
    display: "inline-block",
    width: "max-content",
    maxWidth: "none",
    height: "auto",
    inset: "auto",
    left: "0",
    top: "0",
  });
  clone.querySelectorAll<HTMLElement>("p").forEach((paragraph) => {
    paragraph.style.whiteSpace = "nowrap";
    paragraph.style.width = "max-content";
    paragraph.style.maxWidth = "none";
  });
  frame.appendChild(clone);
  const width = Math.max(clone.scrollWidth, clone.offsetWidth);
  clone.remove();
  return width;
}

export function StaticTextContent({
  content,
  className,
  isPptxEntranceAnimationTarget = false,
  autoFit,
  recoverLegacyFixedBoxOverflow = false,
  boxWidth = 0,
  boxHeight,
  paddingLeft,
  paddingRight,
  paddingTop,
  paddingBottom,
  lineHeight,
  paragraphSpace,
}: StaticTextContentProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fontNormalizedContent = normalizeImportedSlideHtmlFonts(content);
  const explicitPowerPointSpaceLayout = hasExplicitPowerPointSpaceLayout(
    fontNormalizedContent,
  );
  const compactPowerPointSpaceLayout = hasCompactPowerPointSpaceLayout(
    fontNormalizedContent,
    autoFit,
  );
  const normalizedContent = normalizeImportedPowerPointSpaces(
    fontNormalizedContent,
    autoFit,
  );
  const sourceMeasuredPowerPointSpaces =
    hasSourceMeasuredPowerPointSpaces(normalizedContent);
  const importedLayout = hasImportedParagraphLayout(normalizedContent);
  const preserveImportedMultilineMetrics =
    hasExplicitImportedMultilineParagraphMetrics(normalizedContent);
  const sourceSingleLineLayout = hasSourceSingleLineLayout({
    content: normalizedContent,
    autoFit,
    boxHeight,
    paddingTop,
    paddingBottom,
    lineHeight,
  });
  const preserveSourceGlyphOverflow = shouldPreserveSourceSingleGlyphOverflow({
    content: normalizedContent,
    autoFit,
    boxWidth,
    paddingLeft,
    paddingRight,
  });
  const usePptxPinyinFont =
    importedLayout &&
    extractPptxPinyinSyllables(extractImportedHtmlText(normalizedContent))
      .length > 0;

  useLayoutEffect(() => {
    const container = containerRef.current;
    const frame = container?.closest<HTMLElement>(".element-content");
    const outer = frame?.closest<HTMLElement>(
      ".base-element-text, .editable-element-text",
    );
    const viewport = container?.closest<HTMLElement>("[data-slide-viewport]");
    if (
      !container ||
      !frame ||
      !outer ||
      !viewport ||
      importedLayout ||
      !recoverLegacyFixedBoxOverflow
    ) {
      return;
    }

    const originalFrameStyle = {
      width: frame.style.width,
      height: frame.style.height,
      paddingLeft: frame.style.paddingLeft,
      paddingRight: frame.style.paddingRight,
      paddingTop: frame.style.paddingTop,
      paddingBottom: frame.style.paddingBottom,
    };
    const originalOuterStyle = {
      left: outer.style.left,
      top: outer.style.top,
      width: outer.style.width,
      height: outer.style.height,
    };
    let cancelled = false;
    let frameId = 0;
    const retryTimers: number[] = [];

    const measure = () => {
      if (cancelled || !hasLegacyFixedBoxOverflow(frame)) return;

      // Older generated slides did not persist text padding. The renderer's
      // fallback can turn a valid one-line box into two lines, so reclaim that
      // implicit space only when the stored fixed box actually clips.
      frame.style.padding = "0px";

      if (hasLegacyFixedBoxOverflow(frame)) {
        const viewportRect = viewport.getBoundingClientRect();
        const outerRect = outer.getBoundingClientRect();
        const viewportScale =
          viewport.clientWidth > 0
            ? viewportRect.width / viewport.clientWidth
            : 1;
        if (viewportScale <= 0) return;

        const current = {
          left: (outerRect.left - viewportRect.left) / viewportScale,
          right: (outerRect.right - viewportRect.left) / viewportScale,
          top: (outerRect.top - viewportRect.top) / viewportScale,
          bottom: (outerRect.bottom - viewportRect.top) / viewportScale,
          width: outerRect.width / viewportScale,
          height: outerRect.height / viewportScale,
        };
        let leftBound = LEGACY_FIXED_BOX_VIEWPORT_MARGIN;
        let rightBound =
          viewport.clientWidth - LEGACY_FIXED_BOX_VIEWPORT_MARGIN;
        const obstacles = viewport.querySelectorAll<HTMLElement>(
          '[class*="base-element-"], [class*="editable-element-"]',
        );

        for (const obstacle of obstacles) {
          if (
            obstacle === outer ||
            outer.contains(obstacle) ||
            obstacle.contains(outer)
          ) {
            continue;
          }
          const obstacleRect = obstacle.getBoundingClientRect();
          if (obstacleRect.width <= 0 || obstacleRect.height <= 0) continue;
          const obstacleBounds = {
            left: (obstacleRect.left - viewportRect.left) / viewportScale,
            right: (obstacleRect.right - viewportRect.left) / viewportScale,
            top: (obstacleRect.top - viewportRect.top) / viewportScale,
            bottom: (obstacleRect.bottom - viewportRect.top) / viewportScale,
          };
          const verticalOverlap =
            Math.min(current.bottom, obstacleBounds.bottom) -
            Math.max(current.top, obstacleBounds.top);
          if (verticalOverlap <= Math.min(8, current.height * 0.2)) continue;

          if (obstacleBounds.right <= current.left + 1) {
            leftBound = Math.max(leftBound, obstacleBounds.right);
          } else if (obstacleBounds.left >= current.right - 1) {
            rightBound = Math.min(rightBound, obstacleBounds.left);
          }
        }

        const naturalWidth = measureUnwrappedTextWidth(container, frame);
        const recovered = calculateLegacyFixedTextHorizontalRecovery({
          left: current.left,
          width: current.width,
          naturalWidth,
          leftBound,
          rightBound,
        });
        if (recovered.width > current.width + 1) {
          outer.style.left = `${recovered.left}px`;
          outer.style.width = `${recovered.width}px`;
          frame.style.width = `${recovered.width}px`;
        }

        if (hasLegacyFixedBoxOverflow(frame)) {
          const recoveredTop = Number.parseFloat(outer.style.top || "0");
          const naturalHeight = Math.ceil(frame.scrollHeight);
          const availableHeight = Math.max(
            frame.clientHeight,
            viewport.clientHeight - recoveredTop - 24,
          );
          const recoveredHeight = Math.min(naturalHeight, availableHeight);
          if (recoveredHeight > frame.clientHeight) {
            outer.style.height = `${recoveredHeight}px`;
            frame.style.height = `${recoveredHeight}px`;
          }
        }

        frame.dataset.coursewareOverflowRecovered = "true";
      }
    };

    const scheduleMeasure = () => {
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(measure);
    };

    measure();
    scheduleMeasure();
    void document.fonts?.ready.then(scheduleMeasure);
    retryTimers.push(
      window.setTimeout(scheduleMeasure, 250),
      window.setTimeout(scheduleMeasure, 1000),
    );
    const handleFontsLoaded = () => scheduleMeasure();
    document.fonts?.addEventListener("loadingdone", handleFontsLoaded);
    const stopObservingLayout = observeImportedTextLayout(
      container,
      scheduleMeasure,
    );

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frameId);
      retryTimers.forEach((timer) => window.clearTimeout(timer));
      document.fonts?.removeEventListener("loadingdone", handleFontsLoaded);
      stopObservingLayout();
      frame.style.width = originalFrameStyle.width;
      frame.style.height = originalFrameStyle.height;
      frame.style.paddingLeft = originalFrameStyle.paddingLeft;
      frame.style.paddingRight = originalFrameStyle.paddingRight;
      frame.style.paddingTop = originalFrameStyle.paddingTop;
      frame.style.paddingBottom = originalFrameStyle.paddingBottom;
      outer.style.left = originalOuterStyle.left;
      outer.style.top = originalOuterStyle.top;
      outer.style.width = originalOuterStyle.width;
      outer.style.height = originalOuterStyle.height;
      delete frame.dataset.coursewareOverflowRecovered;
    };
  });

  useLayoutEffect(() => {
    const container = containerRef.current;
    const paragraph = container?.querySelector<HTMLElement>("p");
    if (
      !container ||
      !paragraph ||
      !shouldMeasureImportedSingleLineFit({
        sourceSingleLineLayout,
        explicitPowerPointSpaceLayout,
        preserveSourceGlyphOverflow,
      })
    ) {
      return;
    }

    const paragraphVisual =
      paragraph.querySelector<HTMLElement>("span") ?? paragraph;
    if (
      shouldPreservePptxAccentOverlayWidth(
        getComputedStyle(paragraphVisual).color,
        paragraph.textContent ?? "",
        isPptxEntranceAnimationTarget,
      )
    ) {
      // PPT emphasis animations commonly place a same-size colored glyph in a
      // deliberately tight box over the base text. Fitting that overlay to its
      // own box narrows the glyph and exposes the black source underneath.
      return;
    }

    const previousParagraphFontSize = paragraph.style.fontSize;
    const previousParagraphWhiteSpace = paragraph.style.whiteSpace;
    // PowerPoint keeps a single authored paragraph on one line and shrinks it
    // inside the frame. Letting the browser wrap first changes the line count,
    // so the subsequent fit transform can never restore the source layout.
    paragraph.style.whiteSpace = "nowrap";
    const runFontSizes = Array.from(
      paragraph.querySelectorAll<HTMLElement>("span"),
      (run) => Number.parseFloat(getComputedStyle(run).fontSize),
    ).filter((fontSize) => Number.isFinite(fontSize) && fontSize > 0);
    const paragraphFontSize = Math.max(0, ...runFontSizes);
    const preservePowerPointMetrics =
      paragraph.dataset.pptxPreserveMetrics === "true";
    if (
      preservePowerPointMetrics &&
      !previousParagraphFontSize &&
      paragraphFontSize > 0
    ) {
      // PPT paragraph spacing is calculated from the text run size. When the
      // size exists only on a child span, browsers calculate unitless
      // line-height from the default 16px paragraph and lift large glyphs above
      // their source box.
      paragraph.style.fontSize = `${paragraphFontSize}px`;
      paragraph.dataset.pptxParagraphFontMetrics = paragraphFontSize.toFixed(3);
    }

    let cancelled = false;
    let frame = 0;
    const retryTimers: number[] = [];

    const measure = () => {
      if (cancelled) return;
      paragraph.style.removeProperty("transform");
      paragraph.style.removeProperty("transform-origin");
      paragraph.style.removeProperty("translate");
      paragraph.removeAttribute("data-pptx-horizontal-fit");
      paragraph.removeAttribute("data-pptx-line-box-offset");

      const alignParagraphLineBox = () => {
        if (!preservePowerPointMetrics) return;

        const runRects = Array.from(
          paragraph.querySelectorAll<HTMLElement>("span"),
          (run) => run.getBoundingClientRect(),
        ).filter((rect) => rect.width > 0 && rect.height > 0);
        if (runRects.length === 0) return;

        const paragraphRect = paragraph.getBoundingClientRect();
        const runTop = Math.min(...runRects.map((rect) => rect.top));
        const viewport = container.closest<HTMLElement>(
          "[data-slide-viewport]",
        );
        const viewportScale =
          viewport && viewport.clientWidth > 0
            ? viewport.getBoundingClientRect().width / viewport.clientWidth
            : 1;
        const offset =
          viewportScale > 0 ? (paragraphRect.top - runTop) / viewportScale : 0;
        if (offset <= 0.5 || offset > paragraphFontSize * 0.35) return;

        paragraph.style.translate = `0 ${offset}px`;
        paragraph.dataset.pptxLineBoxOffset = offset.toFixed(3);
      };

      const clone = paragraph.cloneNode(true) as HTMLElement;
      clone.style.position = "absolute";
      clone.style.inset = "auto";
      clone.style.left = "0";
      clone.style.top = "0";
      clone.style.display = "inline-block";
      clone.style.width = "max-content";
      clone.style.maxWidth = "none";
      clone.style.minWidth = "0";
      clone.style.height = "auto";
      clone.style.margin = "0";
      clone.style.whiteSpace = "pre";
      clone.style.overflowWrap = "normal";
      clone.style.wordBreak = "normal";
      clone.style.transform = "none";
      clone.style.visibility = "hidden";
      clone.style.pointerEvents = "none";
      container.appendChild(clone);

      const availableWidth = paragraph.clientWidth;
      // clientWidth/scrollWidth/offsetWidth are layout-space values. A bounding
      // rect is viewport-space and already includes the slide's CSS scale, so
      // mixing it here makes text look wider whenever the canvas is zoomed and
      // incorrectly triggers destructive horizontal compression.
      const naturalWidth = Math.max(clone.scrollWidth, clone.offsetWidth);
      clone.remove();
      if (paragraph.dataset.pptxSyllableAligned === "true") {
        alignParagraphLineBox();
        return;
      }
      if (!hasImportedSingleLineOverflow(naturalWidth, availableWidth)) {
        alignParagraphLineBox();
        return;
      }

      const scale = Math.max(
        MIN_IMPORTED_TEXT_SCALE,
        (availableWidth - 0.5) / naturalWidth,
      );
      const textAlign = getComputedStyle(paragraph).textAlign;
      paragraph.style.transformOrigin =
        textAlign === "right"
          ? "right top"
          : textAlign === "center"
            ? "center top"
            : "left top";
      paragraph.style.transform = `scaleX(${scale})`;
      paragraph.dataset.pptxHorizontalFit = scale.toFixed(4);
      alignParagraphLineBox();
    };

    const scheduleMeasure = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measure);
    };

    // React can re-apply dangerouslySetInnerHTML when the playback canvas
    // settles from its initial scale. Restore the measured PPT metrics in the
    // same layout phase so the first visible playback frame matches a remount.
    measure();
    scheduleMeasure();
    void document.fonts?.ready.then(scheduleMeasure);
    retryTimers.push(
      window.setTimeout(scheduleMeasure, 250),
      window.setTimeout(scheduleMeasure, 1000),
    );
    const handleFontsLoaded = () => scheduleMeasure();
    document.fonts?.addEventListener("loadingdone", handleFontsLoaded);
    const stopObservingLayout = observeImportedTextLayout(
      container,
      scheduleMeasure,
    );

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      retryTimers.forEach((timer) => window.clearTimeout(timer));
      document.fonts?.removeEventListener("loadingdone", handleFontsLoaded);
      stopObservingLayout();
      paragraph.style.fontSize = previousParagraphFontSize;
      paragraph.style.whiteSpace = previousParagraphWhiteSpace;
      paragraph.style.removeProperty("translate");
      delete paragraph.dataset.pptxParagraphFontMetrics;
      delete paragraph.dataset.pptxLineBoxOffset;
    };
  });

  useLayoutEffect(() => {
    const container = containerRef.current;
    const paragraph = container?.querySelector<HTMLElement>("p");
    const viewport = container?.closest<HTMLElement>("[data-slide-viewport]");
    const paragraphCount =
      container?.querySelectorAll(":scope > p").length ?? 0;
    if (
      !container ||
      !paragraph ||
      !viewport ||
      !importedLayout ||
      sourceMeasuredPowerPointSpaces ||
      paragraphCount !== 1
    ) {
      return;
    }

    if (
      isPptxEntranceAnimationTarget ||
      paragraph.dataset.pptxPinyinAnchored === "true"
    ) {
      return;
    }

    const syllables = extractPptxPinyinSyllables(paragraph.textContent ?? "");
    if (syllables.length < 1) return;
    const initialTarget = findPinyinTargetParagraph(
      paragraph,
      viewport,
      syllables.length,
    );
    if (!initialTarget) return;

    const originalInnerHtml = paragraph.innerHTML;
    const previousTransform = paragraph.style.transform;
    const previousTransformOrigin = paragraph.style.transformOrigin;
    const previousShapeTextOverflow = container.parentElement?.style.overflow;
    const syllableElements = wrapPinyinSyllables(paragraph);
    if (syllableElements.length !== syllables.length) {
      paragraph.innerHTML = originalInnerHtml;
      return;
    }

    paragraph.style.removeProperty("transform");
    paragraph.style.removeProperty("transform-origin");
    paragraph.removeAttribute("data-pptx-horizontal-fit");
    paragraph.dataset.pptxSyllableAligned = "true";
    if (container.parentElement) {
      container.parentElement.style.overflow = "visible";
    }

    let cancelled = false;
    let frame = 0;
    const retryTimers: number[] = [];

    const alignSyllables = () => {
      if (cancelled || !paragraph.isConnected) return;
      paragraph.style.removeProperty("transform");
      paragraph.style.removeProperty("transform-origin");
      paragraph.removeAttribute("data-pptx-horizontal-fit");
      for (const parts of syllableElements) {
        for (const part of parts) {
          part.style.position = "relative";
          part.style.left = "0px";
          part.style.removeProperty("transform");
          delete part.dataset.pptxPinyinScale;
        }
      }

      const target = findPinyinTargetParagraph(
        paragraph,
        viewport,
        syllableElements.length,
      );
      if (!target) return;
      const viewportScale =
        viewport.clientWidth > 0
          ? viewport.getBoundingClientRect().width / viewport.clientWidth
          : 1;
      const targetCenters = target.glyphRects.map(
        (rect) => rect.left + rect.width / 2,
      );
      const offsets = syllableElements.map((parts, index) => {
        const syllableCenter = getPinyinSyllableCenter(parts);
        const targetCenter = targetCenters[index];
        if (syllableCenter == null || targetCenter == null) return "0.000";
        const offset = calculatePptxSyllableOffset(
          syllableCenter,
          targetCenter,
          viewportScale,
        );
        for (const part of parts) part.style.left = `${offset}px`;
        return offset.toFixed(3);
      });
      paragraph.dataset.pptxSyllableOffsets = offsets.join(",");
    };

    const scheduleAlign = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(alignSyllables);
    };

    alignSyllables();
    scheduleAlign();
    void document.fonts?.ready.then(scheduleAlign);
    retryTimers.push(
      window.setTimeout(scheduleAlign, 250),
      window.setTimeout(scheduleAlign, 1000),
    );
    const handleFontsLoaded = () => scheduleAlign();
    document.fonts?.addEventListener("loadingdone", handleFontsLoaded);
    const stopObservingLayout = observeImportedTextLayout(
      container,
      scheduleAlign,
    );

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      retryTimers.forEach((timer) => window.clearTimeout(timer));
      document.fonts?.removeEventListener("loadingdone", handleFontsLoaded);
      stopObservingLayout();
      paragraph.innerHTML = originalInnerHtml;
      paragraph.style.transform = previousTransform;
      paragraph.style.transformOrigin = previousTransformOrigin;
      delete paragraph.dataset.pptxSyllableAligned;
      delete paragraph.dataset.pptxSyllableOffsets;
      if (container.parentElement) {
        container.parentElement.style.overflow =
          previousShapeTextOverflow ?? "";
      }
    };
  });

  useLayoutEffect(() => {
    const container = containerRef.current;
    const viewport = container?.closest<HTMLElement>("[data-slide-viewport]");
    if (
      !container ||
      !viewport ||
      !importedLayout ||
      sourceMeasuredPowerPointSpaces ||
      sourceSingleLineLayout ||
      isPptxEntranceAnimationTarget
    ) {
      return;
    }

    const paragraphs = Array.from(
      container.querySelectorAll<HTMLElement>(":scope > p"),
    );
    const pairs = paragraphs.flatMap((paragraph, index) => {
      const target = paragraphs[index + 1];
      if (
        !target ||
        paragraph.dataset.pptxPinyinAnchored === "true" ||
        !shouldAlignPptxPinyinSyllables(
          paragraph.textContent ?? "",
          target.textContent ?? "",
        )
      ) {
        return [];
      }
      return [{ paragraph, target }];
    });
    if (pairs.length === 0) return;

    const originals = pairs.map(({ paragraph }) => ({
      paragraph,
      innerHTML: paragraph.innerHTML,
    }));
    const pairElements = Array.from(
      new Set(pairs.flatMap(({ paragraph, target }) => [paragraph, target])),
    );
    const originalPairStyles = pairElements.map((element) => ({
      element,
      transform: element.style.transform,
      transformOrigin: element.style.transformOrigin,
    }));
    const alignedPairs = pairs.flatMap(({ paragraph, target }) => {
      const syllableCount = extractPptxPinyinSyllables(
        paragraph.textContent ?? "",
      ).length;
      const syllableParts = wrapPinyinSyllables(paragraph);
      if (
        syllableParts.length !== syllableCount ||
        syllableParts.some((parts) => parts.length === 0)
      ) {
        return [];
      }
      paragraph.dataset.pptxSyllableAligned = "true";
      return [{ paragraph, target, syllableParts }];
    });
    if (alignedPairs.length === 0) {
      for (const original of originals) {
        original.paragraph.innerHTML = original.innerHTML;
      }
      return;
    }

    let cancelled = false;
    let frame = 0;
    const retryTimers: number[] = [];

    const alignSyllables = () => {
      if (cancelled) return;
      const viewportScale =
        viewport.clientWidth > 0
          ? viewport.getBoundingClientRect().width / viewport.clientWidth
          : 1;

      for (const { paragraph, target, syllableParts } of alignedPairs) {
        if (!paragraph.isConnected || !target.isConnected) continue;
        paragraph.style.removeProperty("transform");
        paragraph.style.removeProperty("transform-origin");
        target.style.removeProperty("transform");
        target.style.removeProperty("transform-origin");
        delete paragraph.dataset.pptxPairHorizontalFit;
        delete target.dataset.pptxPairHorizontalFit;
        for (const parts of syllableParts) {
          for (const part of parts) {
            part.style.position = "relative";
            part.style.left = "0px";
          }
        }
        const targetRects = collectHanGlyphRects(target);
        if (targetRects.length !== syllableParts.length) continue;

        const offsets = syllableParts.map((parts, index) => {
          const syllableCenter = getPinyinSyllableCenter(parts);
          const targetRect = targetRects[index];
          if (syllableCenter == null || !targetRect) return "0.000";
          const targetCenter = targetRect.left + targetRect.width / 2;
          const offset = calculatePptxSyllableOffset(
            syllableCenter,
            targetCenter,
            viewportScale,
          );
          for (const part of parts) part.style.left = `${offset}px`;
          return offset.toFixed(3);
        });
        paragraph.dataset.pptxSyllableOffsets = offsets.join(",");

        const paragraphRange = document.createRange();
        paragraphRange.selectNodeContents(paragraph);
        const targetRange = document.createRange();
        targetRange.selectNodeContents(target);
        const paragraphRect = paragraphRange.getBoundingClientRect();
        const targetRect = targetRange.getBoundingClientRect();
        const pairLeft = Math.min(paragraphRect.left, targetRect.left);
        const pairRight = Math.max(paragraphRect.right, targetRect.right);
        const availableRight =
          viewport.getBoundingClientRect().right - 12 * viewportScale;
        const pairWidth = pairRight - pairLeft;
        if (pairWidth <= 0 || pairRight <= availableRight) continue;

        const fitScale = Math.max(
          MIN_IMPORTED_TEXT_BOX_SCALE,
          (availableRight - pairLeft) / pairWidth,
        );
        if (!Number.isFinite(fitScale) || fitScale >= 1) continue;
        for (const element of [paragraph, target]) {
          element.style.transformOrigin = "left top";
          element.style.transform = `scaleX(${fitScale})`;
          element.dataset.pptxPairHorizontalFit = fitScale.toFixed(4);
        }
      }
    };

    const scheduleAlign = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(alignSyllables);
    };

    alignSyllables();
    scheduleAlign();
    void document.fonts?.ready.then(scheduleAlign);
    retryTimers.push(
      window.setTimeout(scheduleAlign, 250),
      window.setTimeout(scheduleAlign, 1000),
    );
    const handleFontsLoaded = () => scheduleAlign();
    document.fonts?.addEventListener("loadingdone", handleFontsLoaded);
    const stopObservingLayout = observeImportedTextLayout(
      container,
      scheduleAlign,
    );

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      retryTimers.forEach((timer) => window.clearTimeout(timer));
      document.fonts?.removeEventListener("loadingdone", handleFontsLoaded);
      stopObservingLayout();
      for (const original of originals) {
        original.paragraph.innerHTML = original.innerHTML;
        delete original.paragraph.dataset.pptxSyllableAligned;
        delete original.paragraph.dataset.pptxSyllableOffsets;
      }
      for (const original of originalPairStyles) {
        original.element.style.transform = original.transform;
        original.element.style.transformOrigin = original.transformOrigin;
        delete original.element.dataset.pptxPairHorizontalFit;
      }
    };
  });

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !usePptxPinyinFont) return;

    const marks = wrapPptxFirstToneMarks(container);
    if (marks.length === 0) return;

    let cancelled = false;
    let frame = 0;
    const schedule = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (!cancelled) alignPptxFirstToneMarks(marks);
      });
    };

    schedule();
    void document.fonts?.ready.then(schedule);
    const stopObservingLayout = observeImportedTextLayout(container, schedule);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      stopObservingLayout();
      removePptxFirstToneMarks(marks);
    };
  });

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (
      !container ||
      !importedLayout ||
      !preserveImportedMultilineMetrics ||
      !sourceMeasuredPowerPointSpaces ||
      sourceSingleLineLayout
    ) {
      return;
    }

    const paragraphs = Array.from(
      container.querySelectorAll<HTMLElement>(":scope > p"),
    );
    const originals = paragraphs.map((paragraph) => ({
      paragraph,
      width: paragraph.style.width,
      maxWidth: paragraph.style.maxWidth,
      transform: paragraph.style.transform,
      transformOrigin: paragraph.style.transformOrigin,
    }));
    let cancelled = false;
    let frame = 0;
    const retryTimers: number[] = [];

    const restoreParagraph = (original: (typeof originals)[number]) => {
      const { paragraph } = original;
      paragraph.style.width = original.width;
      paragraph.style.maxWidth = original.maxWidth;
      paragraph.style.transform = original.transform;
      paragraph.style.transformOrigin = original.transformOrigin;
      delete paragraph.dataset.pptxParagraphWrapFit;
    };

    const measure = () => {
      if (cancelled) return;
      for (const original of originals) restoreParagraph(original);

      for (const { paragraph } of originals) {
        if (!hasDanglingEmptyPlaceholderClosingParenthesis(paragraph)) continue;
        const availableWidth = paragraph.clientWidth;
        const expandedWidth = calculateImportedParagraphWrapFitWidth({
          availableWidth,
          hasDanglingAtWidth: (width) => {
            paragraph.style.width = `${width}px`;
            paragraph.style.maxWidth = "none";
            return hasDanglingEmptyPlaceholderClosingParenthesis(paragraph);
          },
        });
        if (!expandedWidth) continue;

        const scale = availableWidth / expandedWidth;
        const textAlign = getComputedStyle(paragraph).textAlign;
        paragraph.style.width = `${expandedWidth}px`;
        paragraph.style.maxWidth = "none";
        paragraph.style.transformOrigin =
          textAlign === "right"
            ? "right top"
            : textAlign === "center"
              ? "center top"
              : "left top";
        paragraph.style.transform = `scaleX(${scale})`;
        paragraph.dataset.pptxParagraphWrapFit = scale.toFixed(4);
      }
    };

    const scheduleMeasure = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measure);
    };

    measure();
    scheduleMeasure();
    void document.fonts?.ready.then(scheduleMeasure);
    retryTimers.push(
      window.setTimeout(scheduleMeasure, 250),
      window.setTimeout(scheduleMeasure, 1000),
    );
    const handleFontsLoaded = () => scheduleMeasure();
    document.fonts?.addEventListener("loadingdone", handleFontsLoaded);
    const stopObservingLayout = observeImportedTextLayout(
      container,
      scheduleMeasure,
    );

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      retryTimers.forEach((timer) => window.clearTimeout(timer));
      document.fonts?.removeEventListener("loadingdone", handleFontsLoaded);
      stopObservingLayout();
      for (const original of originals) restoreParagraph(original);
    };
  });

  useLayoutEffect(() => {
    const container = containerRef.current;
    const textFrame = container?.closest<HTMLElement>(".element-content");
    if (
      !container ||
      !textFrame ||
      !importedLayout ||
      preserveSourceGlyphOverflow ||
      sourceSingleLineLayout ||
      (autoFit?.type !== "shape" && autoFit?.type !== "normal")
    ) {
      return;
    }

    const paragraphs = Array.from(
      container.querySelectorAll<HTMLElement>(":scope > p"),
    );
    const originalContainerStyle = {
      width: container.style.width,
      maxWidth: container.style.maxWidth,
    };
    const originalParagraphStyles = paragraphs.map((paragraph) => ({
      paragraph,
      whiteSpace: paragraph.style.whiteSpace,
      width: paragraph.style.width,
      maxWidth: paragraph.style.maxWidth,
    }));
    let cancelled = false;
    let frame = 0;

    const restoreMultilineFitStyles = () => {
      container.style.width = originalContainerStyle.width;
      container.style.maxWidth = originalContainerStyle.maxWidth;
      for (const original of originalParagraphStyles) {
        original.paragraph.style.whiteSpace = original.whiteSpace;
        original.paragraph.style.width = original.width;
        original.paragraph.style.maxWidth = original.maxWidth;
      }
    };

    const measure = () => {
      if (cancelled) return;
      container.style.removeProperty("transform");
      container.style.removeProperty("transform-origin");
      container.removeAttribute("data-pptx-box-fit");

      if (container.querySelector(":scope > p[data-pptx-paragraph-wrap-fit]")) {
        return;
      }

      const storedAvailableWidth =
        boxWidth - (paddingLeft ?? 0) - (paddingRight ?? 0);
      const availableWidth =
        storedAvailableWidth > 0 ? storedAvailableWidth : container.clientWidth;
      const availableHeight = Math.max(
        0,
        boxHeight - (paddingTop ?? 0) - (paddingBottom ?? 0),
      );
      const naturalWidth = preserveImportedMultilineMetrics
        ? Math.max(
            measureUnwrappedTextWidth(container, textFrame),
            availableWidth,
          )
        : Math.max(container.scrollWidth, availableWidth);
      const naturalHeight = container.scrollHeight;
      const scale = preserveImportedMultilineMetrics
        ? calculateImportedTextBoxHorizontalFitScale({
            naturalWidth,
            availableWidth,
          })
        : calculateImportedTextBoxFitScale({
            naturalWidth,
            naturalHeight,
            availableWidth,
            availableHeight,
          });
      if (scale >= 1) {
        if (preserveImportedMultilineMetrics) restoreMultilineFitStyles();
        return;
      }

      if (preserveImportedMultilineMetrics) {
        container.style.width = `${naturalWidth}px`;
        container.style.maxWidth = "none";
        for (const paragraph of paragraphs) {
          paragraph.style.whiteSpace = "nowrap";
          paragraph.style.width = "max-content";
          paragraph.style.maxWidth = "none";
        }
      }

      const paragraph = container.querySelector<HTMLElement>("p");
      const textAlign = paragraph
        ? getComputedStyle(paragraph).textAlign
        : "left";
      const parentJustify = container.parentElement
        ? getComputedStyle(container.parentElement).justifyContent
        : "flex-start";
      const horizontalOrigin =
        textAlign === "right"
          ? "right"
          : textAlign === "center"
            ? "center"
            : "left";
      const verticalOrigin =
        parentJustify === "flex-end"
          ? "bottom"
          : parentJustify === "center"
            ? "center"
            : "top";
      container.style.transformOrigin = `${horizontalOrigin} ${verticalOrigin}`;
      container.style.transform = preserveImportedMultilineMetrics
        ? `scaleX(${scale})`
        : `scale(${scale})`;
      container.dataset.pptxBoxFit = scale.toFixed(4);
    };

    const scheduleMeasure = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measure);
    };

    measure();
    scheduleMeasure();
    void document.fonts?.ready.then(scheduleMeasure);
    const handleFontsLoaded = () => scheduleMeasure();
    document.fonts?.addEventListener("loadingdone", handleFontsLoaded);
    const stopObservingLayout = observeImportedTextLayout(
      container,
      scheduleMeasure,
    );

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      document.fonts?.removeEventListener("loadingdone", handleFontsLoaded);
      stopObservingLayout();
      restoreMultilineFitStyles();
    };
  });

  useLayoutEffect(() => {
    const container = containerRef.current;
    const initialParagraph = container?.querySelector<HTMLElement>("p");
    if (
      !container ||
      !initialParagraph ||
      !sourceSingleLineLayout ||
      !isPptxEntranceAnimationTarget ||
      hasImportedSemanticTextAnchor(content)
    ) {
      return;
    }

    const overlayText = initialParagraph.textContent?.trim() ?? "";
    if (
      overlayText.length === 0 ||
      Array.from(overlayText.replace(/\s/gu, "")).length > 8
    ) {
      return;
    }
    const viewport = container.closest<HTMLElement>("[data-slide-viewport]");
    if (!viewport) return;

    let firstFrame = 0;
    let secondFrame = 0;
    let retryTimer = 0;
    let lateRetryTimer = 0;
    let cancelled = false;
    const shapeTextContainer = container.parentElement;
    const previousShapeTextOverflow = shapeTextContainer?.style.overflow;
    let shapeTextOverflowAdjusted = false;
    let alignedOverlayVisual: HTMLElement | undefined;

    const staleOverlayVisual =
      initialParagraph.querySelector<HTMLElement>("span") ?? initialParagraph;
    if (staleOverlayVisual.dataset.pptxOverlayCorrected === "true") {
      staleOverlayVisual.style.removeProperty("display");
      staleOverlayVisual.style.removeProperty("translate");
      staleOverlayVisual.style.removeProperty("scale");
      staleOverlayVisual.style.removeProperty("transform-origin");
      staleOverlayVisual.style.removeProperty("position");
      staleOverlayVisual.style.removeProperty("left");
      staleOverlayVisual.style.removeProperty("top");
      delete staleOverlayVisual.dataset.pptxOverlayCorrected;
      delete staleOverlayVisual.dataset.pptxOverlayTranslateX;
      delete staleOverlayVisual.dataset.pptxOverlayTranslateY;
      delete staleOverlayVisual.dataset.pptxOverlayScaleX;
    }

    const alignAnimatedAccentOverlay = () => {
      const paragraph = container.querySelector<HTMLElement>("p");
      if (cancelled || !paragraph?.isConnected) return;
      const overlayVisual =
        paragraph.querySelector<HTMLElement>("span") ?? paragraph;

      const overlayRect = overlayVisual.getBoundingClientRect();
      if (overlayRect.width <= 0 || overlayRect.height <= 0) return;
      let bestMatch:
        | {
            rect: DOMRect;
            score: number;
            intersects: boolean;
          }
        | undefined;

      for (const candidate of viewport.querySelectorAll<HTMLElement>(
        ".pptx-imported-static-text > p",
      )) {
        if (candidate === paragraph) continue;
        const candidateContainer = candidate.closest<HTMLElement>(
          ".pptx-imported-static-text",
        );
        if (candidateContainer?.dataset.pptxAnimationTarget === "true") {
          continue;
        }
        const walker = document.createTreeWalker(
          candidate,
          NodeFilter.SHOW_TEXT,
        );
        let textNode = walker.nextNode() as Text | null;
        while (textNode) {
          let start = textNode.data.indexOf(overlayText);
          while (start >= 0) {
            const range = document.createRange();
            range.setStart(textNode, start);
            range.setEnd(textNode, start + overlayText.length);
            const sourceRect = range.getBoundingClientRect();
            const intersects = hasPptxTextOverlayIntersection(
              overlayRect,
              sourceRect,
            );
            // Importers can preserve the overlay's source box position while
            // losing paragraph spacing/autofit offsets. In that case the red
            // text does not intersect its source yet, so intersection alone
            // would leave it permanently displaced. Prefer an intersecting
            // match, otherwise choose the nearest occurrence of the exact
            // text on the same slide.
            const centerDistance =
              Math.abs(
                overlayRect.left +
                  overlayRect.width / 2 -
                  (sourceRect.left + sourceRect.width / 2),
              ) +
              Math.abs(
                overlayRect.top +
                  overlayRect.height / 2 -
                  (sourceRect.top + sourceRect.height / 2),
              );
            const viewportScale =
              viewport.clientWidth > 0
                ? viewport.getBoundingClientRect().width / viewport.clientWidth
                : 1;
            if (
              !intersects &&
              centerDistance > MAX_OVERLAY_FALLBACK_DISTANCE * viewportScale
            ) {
              start = textNode.data.indexOf(overlayText, start + 1);
              continue;
            }
            const score = centerDistance + (intersects ? 0 : 10000);
            if (!bestMatch || score < bestMatch.score) {
              bestMatch = {
                rect: sourceRect,
                score,
                intersects,
              };
            }
            start = textNode.data.indexOf(overlayText, start + 1);
          }
          textNode = walker.nextNode() as Text | null;
        }
      }

      if (!bestMatch) return;
      alignedOverlayVisual = overlayVisual;
      overlayVisual.dataset.pptxOverlayCorrected = "true";
      if (shapeTextContainer && !shapeTextOverflowAdjusted) {
        // Corrected overlays can extend beyond their original source box.
        // Keeping the default clipping cuts off the animated glyphs.
        shapeTextContainer.style.overflow = "visible";
        shapeTextOverflowAdjusted = true;
      }
      const viewportScale =
        viewport.clientWidth > 0
          ? viewport.getBoundingClientRect().width / viewport.clientWidth
          : 1;
      const currentTranslateX = Number(
        overlayVisual.dataset.pptxOverlayTranslateX ?? 0,
      );
      const currentTranslateY = Number(
        overlayVisual.dataset.pptxOverlayTranslateY ?? 0,
      );
      const { x: nextTranslateX, y: nextTranslateY } =
        calculatePptxOverlayTranslation({
          overlay: overlayRect,
          source: bestMatch.rect,
          viewportScale,
          currentX: currentTranslateX,
          currentY: currentTranslateY,
        });
      const nextLeft = `${nextTranslateX}px`;
      const nextTop = `${nextTranslateY}px`;
      if (overlayVisual.style.position !== "relative") {
        // Relative offsets preserve the inline line box. Converting the span
        // to inline-block changes its baseline and can clip the lower half of
        // the animated glyph inside the original PPT text box.
        overlayVisual.style.position = "relative";
      }
      if (overlayVisual.style.left !== nextLeft) {
        overlayVisual.style.left = nextLeft;
      }
      if (overlayVisual.style.top !== nextTop) {
        overlayVisual.style.top = nextTop;
      }
      overlayVisual.dataset.pptxOverlayTranslateX = String(nextTranslateX);
      overlayVisual.dataset.pptxOverlayTranslateY = String(nextTranslateY);
      // The source text is the slide's initial state. The accent text is an
      // animated overlay that covers it later, so the source must stay visible.
    };

    const schedule = () => {
      if (firstFrame || secondFrame) return;
      firstFrame = window.requestAnimationFrame(() => {
        firstFrame = 0;
        secondFrame = window.requestAnimationFrame(() => {
          secondFrame = 0;
          alignAnimatedAccentOverlay();
        });
      });
    };

    alignAnimatedAccentOverlay();
    schedule();
    retryTimer = window.setTimeout(alignAnimatedAccentOverlay, 250);
    lateRetryTimer = window.setTimeout(alignAnimatedAccentOverlay, 1000);
    void document.fonts?.ready.then(() => {
      schedule();
      window.clearTimeout(retryTimer);
      retryTimer = window.setTimeout(alignAnimatedAccentOverlay, 250);
    });
    const sourceMutationObserver =
      typeof MutationObserver === "undefined"
        ? undefined
        : new MutationObserver(schedule);
    sourceMutationObserver?.observe(viewport, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "style",
        "class",
        "data-courseware-fonts-ready",
        "data-slide-layout-ready",
        "data-slide-layout-revision",
        "data-slide-viewport-mode",
      ],
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
      window.clearTimeout(retryTimer);
      window.clearTimeout(lateRetryTimer);
      sourceMutationObserver?.disconnect();
      if (shapeTextContainer && shapeTextOverflowAdjusted) {
        shapeTextContainer.style.overflow = previousShapeTextOverflow ?? "";
      }
      if (alignedOverlayVisual) {
        alignedOverlayVisual.style.removeProperty("display");
        alignedOverlayVisual.style.removeProperty("translate");
        alignedOverlayVisual.style.removeProperty("scale");
        alignedOverlayVisual.style.removeProperty("transform-origin");
        alignedOverlayVisual.style.removeProperty("position");
        alignedOverlayVisual.style.removeProperty("left");
        alignedOverlayVisual.style.removeProperty("top");
        delete alignedOverlayVisual.dataset.pptxOverlayCorrected;
        delete alignedOverlayVisual.dataset.pptxOverlayTranslateX;
        delete alignedOverlayVisual.dataset.pptxOverlayTranslateY;
        delete alignedOverlayVisual.dataset.pptxOverlayScaleX;
      }
    };
  });

  const style = {
    height: "auto",
    userSelect: "text",
    "--paragraphSpace": `${paragraphSpace === undefined ? 5 : paragraphSpace}px`,
  } as CSSProperties;

  return (
    <div
      ref={containerRef}
      className={`${className ?? ""}${importedLayout ? " pptx-imported-static-text" : ""}`.trim()}
      style={style}
      data-pptx-layout={importedLayout ? "source" : undefined}
      data-pptx-compact-space-layout={
        compactPowerPointSpaceLayout ? "true" : undefined
      }
      data-pptx-source-single-line={sourceSingleLineLayout ? "true" : undefined}
      data-pptx-preserve-multiline-metrics={
        preserveImportedMultilineMetrics ? "true" : undefined
      }
      data-pptx-animation-target={
        isPptxEntranceAnimationTarget ? "true" : undefined
      }
      data-pptx-pinyin-font={usePptxPinyinFont ? "tinos" : undefined}
      dangerouslySetInnerHTML={{ __html: sanitizeSlideHtml(normalizedContent) }}
    />
  );
}
