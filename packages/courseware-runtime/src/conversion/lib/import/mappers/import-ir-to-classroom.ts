import type { Action } from '../../types/action';

import type { PPTElement, PPTImageElement, PPTTextElement, PPTTableElement, PPTLatexElement, PPTLineElement, PPTShapeElement, PPTVideoElement, PPTAudioElement, TableCell } from '../../types/slides';

import type { Scene } from '../../types/stage';

import { DEFAULT_IMPORT_THEME, IMPORT_VIEWPORT_SIZE } from '../constants';

import { SHAPE_LIST, SHAPE_PATH_FORMULAS } from '../../../configs/shapes';

import { ShapePathFormulasKeys } from '../../types/slides';

import type { SlideElementIR, SlideIR } from '../types';

import { normalizeImportText, sanitizeImportNarrationText } from '../narration/text-normalizer';

export function mapSlideIrToScenes(classroomId: string, importIR: SlideIR): Scene[] {
  return importIR.pages.map((page, index) => {
    const slideId = `slide_${index + 1}`;
    const viewportRatio = page.width > 0 ? page.height / page.width : 0.5625;
    const backgroundElement = mapSlideBackgroundElement(page);
    return {
      id: `scene_${index + 1}`,
      stageId: classroomId,
      type: 'slide',
      title: deriveSlideTitle(page, index, importIR.title),
      order: index + 1,
      content: {
        type: 'slide',
        canvas: {
          id: slideId,
          viewportSize: IMPORT_VIEWPORT_SIZE,
          viewportRatio,
          theme: DEFAULT_IMPORT_THEME,
          background:
            page.background?.type === 'solid'
              ? page.background
              : { type: 'solid', color: DEFAULT_IMPORT_THEME.backgroundColor },
          elements: [
            ...(backgroundElement ? [backgroundElement] : []),
            ...page.elements.map(mapSlideElement),
          ],
        },
      },
      actions: buildSpeechActions(
        page.notes,
        page.elements,
        index,
        deriveSlideTitle(page, index, importIR.title),
        importIR.narrationMode,
      ),
      metadata: {
        importSourcePageId: page.id,
        importSourcePageIndex: index,
        importSourcePageNumber: index + 1,
      },
    };
  });
}

type DocumentSceneRole = 'cover' | 'chapter' | 'content' | 'summary';

function summarizePlainText(text: string, maxLength: number): string {
  const normalized = normalizeImportText(text);
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function mapSlideElement(element: SlideElementIR): PPTElement {
  const scaledContent = element.content;
  const scaledWordSpace = element.wordSpace;
  const scaledParagraphSpace = element.paragraphSpace;
  // PPTX auto-fit describes how PowerPoint authored the source shape. The imported
  // width and height are already the final saved geometry, so browser playback must
  // not grow the box again using platform-dependent font measurements.
  const fixedBox = element.fixedBox ?? true;
  const sourceMetadata = {
    ...(element.sourceShapeId ? { sourceShapeId: element.sourceShapeId } : {}),
    ...(element.sourceGroupShapeIds?.length
      ? { sourceGroupShapeIds: element.sourceGroupShapeIds }
      : {}),
    ...(element.sourceOrder != null ? { sourceOrder: element.sourceOrder } : {}),
  };

  if (element.type === 'image') {
    return {
      id: element.id,
      ...sourceMetadata,
      type: 'image',
      left: element.left,
      top: element.top,
      width: element.width,
      height: element.height,
      rotate: element.rotate ?? 0,
      ...(element.flipH ? { flipH: true } : {}),
      ...(element.flipV ? { flipV: true } : {}),
      fixedRatio: true,
      src: element.src || '',
      ...(element.opacity != null
        ? {
            filters: {
              opacity: `${Math.round(element.opacity * 100)}%`,
            },
          }
        : {}),
      ...(element.clip
        ? {
            clip: element.clip,
          }
        : {}),
      ...(element.imageRole === 'background'
        ? {
            imageType: 'background',
          }
        : {}),
    } satisfies PPTImageElement;
  }

  if (element.type === 'video') {
    return {
      id: element.id,
      ...sourceMetadata,
      type: 'video',
      left: element.left,
      top: element.top,
      width: element.width,
      height: element.height,
      rotate: element.rotate ?? 0,
      src: element.src || '',
      autoplay: element.autoplay === true,
      trigger: element.trigger === 'auto' ? 'auto' : 'click',
      ...(element.poster ? { poster: element.poster } : {}),
      ...(element.ext ? { ext: element.ext } : {}),
    } satisfies PPTVideoElement;
  }

  if (element.type === 'audio') {
    return {
      id: element.id,
      ...sourceMetadata,
      type: 'audio',
      left: element.left,
      top: element.top,
      width: element.width,
      height: element.height,
      rotate: element.rotate ?? 0,
      fixedRatio: false,
      color: DEFAULT_IMPORT_THEME.fontColor,
      loop: element.loop === true,
      ...(element.trimStartMs != null ? { trimStartMs: element.trimStartMs } : {}),
      ...(element.trimEndMs != null ? { trimEndMs: element.trimEndMs } : {}),
      autoplay: element.autoplay === true,
      trigger: element.trigger === 'auto' ? 'auto' : 'click',
      src: element.src || '',
      ...(element.ext ? { ext: element.ext } : {}),
    } satisfies PPTAudioElement;
  }

  if (element.type === 'table') {
    return {
      id: element.id,
      ...sourceMetadata,
      type: 'table',
      left: element.left,
      top: element.top,
      width: element.width,
      height: element.height,
      rotate: element.rotate ?? 0,
      data: toTableCells(element.table ?? []),
      outline: resolveImportedTableOutline(element.table ?? []),
      colWidths: element.tableColWidths ?? [],
      // Imported PPTX tables carry a fixed frame height. Derive the row size
      // from that frame so the browser cannot overflow the table and expose
      // an extra grid row in playback mode.
      cellMinHeight:
        element.table && element.table.length > 0 && element.height > 0
          ? element.height / element.table.length
          : 32,
    } satisfies PPTTableElement;
  }

  if (element.type === 'formula') {
    return {
      id: element.id,
      ...sourceMetadata,
      type: 'latex',
      left: element.left,
      top: element.top,
      width: element.width,
      height: element.height,
      rotate: element.rotate ?? 0,
      latex: element.latex || '',
      ...(element.content ? { html: element.content } : {}),
      ...(['left', 'center', 'right'].includes(element.textAlign ?? '') ? { align: element.textAlign as 'left' | 'center' | 'right' } : {}),
      color: DEFAULT_IMPORT_THEME.fontColor,
    } satisfies PPTLatexElement;
  }

  if (element.type === 'line') {
    const geometry = resolveImportedLineGeometry(element);
    return {
      id: element.id,
      ...sourceMetadata,
      type: 'line',
      left: geometry.left,
      top: geometry.top,
      width: element.borderWidth ?? 1,
      start: geometry.start,
      end: geometry.end,
      style: element.borderType ?? 'solid',
      color: element.borderColor ?? DEFAULT_IMPORT_THEME.fontColor,
      points: element.points ?? ['', ''],
    } satisfies PPTLineElement;
  }

  const presetShape = element.type === 'shape' ? resolvePresetImportShape(element) : null;

  if (element.type === 'shape' && element.interactionRole === 'focus_anchor') {
    const fallbackName =
      'name' in element && typeof element.name === 'string' ? element.name : undefined;
    return {
      id: element.id,
      ...sourceMetadata,
      type: 'shape',
      left: element.left,
      top: element.top,
      width: element.width,
      height: element.height,
      rotate: element.rotate ?? 0,
      viewBox: [element.width, element.height],
      path: '',
      fixedRatio: false,
      fill: 'transparent',
      opacity: 0,
      name: element.focusLabel ?? fallbackName,
    } satisfies PPTShapeElement;
  }

  if (element.type === 'shape' && ((element.path && element.viewBox) || presetShape)) {
    const shapePath = element.path ?? presetShape?.path ?? '';
    const shapeViewBox = element.viewBox ?? presetShape?.viewBox ?? [element.width, element.height];
    const outlineWidth =
      element.borderWidth != null && element.borderWidth > 0 ? element.borderWidth : undefined;
    return {
      id: element.id,
      ...sourceMetadata,
      type: 'shape',
      left: element.left,
      top: element.top,
      width: element.width,
      height: element.height,
      rotate: element.rotate ?? 0,
      ...(element.flipH ? { flipH: true } : {}),
      ...(element.flipV ? { flipV: true } : {}),
      ...(element.points ? { points: element.points } : {}),
      viewBox: shapeViewBox,
      path: shapePath,
      ...(element.subPaths?.length
        ? {
            subPaths: element.subPaths.map((subPath) => ({
              path: subPath.path,
              ...(subPath.fill ? { fill: subPath.fill } : {}),
              ...(subPath.borderWidth != null && subPath.borderWidth > 0
                ? {
                    outline: {
                      color: subPath.borderColor ?? '#000000',
                      width: subPath.borderWidth,
                      style: subPath.borderType ?? 'solid',
                    },
                  }
                : {}),
            })),
          }
        : {}),
      fixedRatio: false,
      fill: element.invisible ? 'transparent' : (element.fillColor ?? 'transparent'),
      ...(element.invisible
        ? { opacity: 0 }
        : element.opacity != null
          ? { opacity: element.opacity }
          : {}),
      ...(presetShape?.pathFormula
        ? {
            pathFormula: presetShape.pathFormula,
            ...(presetShape.keypoints ? { keypoints: presetShape.keypoints } : {}),
          }
        : {}),
      ...(element.pattern
        ? {
            pattern: element.pattern,
            patternScaleMode: element.patternScaleMode ?? 'cover',
            ...(element.patternCrop ? { patternCrop: element.patternCrop } : {}),
          }
        : {}),
      ...(element.fillGradient
        ? {
            gradient: element.fillGradient,
          }
        : {}),
      ...(outlineWidth != null
        ? {
            outline: {
              color: element.borderColor ?? '#000000',
              width: outlineWidth,
              style: element.borderType ?? 'solid',
              ...(element.borderGradient ? { gradient: element.borderGradient } : {}),
            },
          }
        : {}),
      ...(element.shadow ? { shadow: element.shadow } : {}),
      ...(element.content
        ? {
            text: {
              content: scaledContent || element.content,
              defaultFontName: element.defaultFontName ?? DEFAULT_IMPORT_THEME.fontName,
              defaultColor: element.defaultColor ?? DEFAULT_IMPORT_THEME.fontColor,
              align: element.verticalAlign ?? 'middle',
              ...(element.textAlign && element.textAlign !== 'distributed'
                ? { textAlign: element.textAlign }
                : {}),
              ...(element.lineHeight != null ? { lineHeight: element.lineHeight } : {}),
              ...(scaledWordSpace != null ? { wordSpace: scaledWordSpace } : {}),
              ...(scaledParagraphSpace != null ? { paragraphSpace: scaledParagraphSpace } : {}),
              ...(element.vertical === true ? { vertical: true } : {}),
              ...(fixedBox ? { fixedBox: true } : {}),
              ...(element.overflowVisible != null
                ? { overflowVisible: element.overflowVisible }
                : {}),
              ...(element.textInsets?.left != null ? { paddingLeft: element.textInsets.left } : {}),
              ...(element.textInsets?.right != null
                ? { paddingRight: element.textInsets.right }
                : {}),
              ...(element.textInsets?.top != null ? { paddingTop: element.textInsets.top } : {}),
              ...(element.textInsets?.bottom != null
                ? { paddingBottom: element.textInsets.bottom }
                : {}),
              ...(element.autoFit ? { autoFit: element.autoFit } : {}),
              type:
                element.textType === 'subtitle' || element.textType === 'notes'
                  ? element.textType
                  : element.textType === 'title'
                    ? 'title'
                    : 'content',
            },
          }
        : {}),
    } satisfies PPTShapeElement;
  }

  return {
    id: element.id,
    ...sourceMetadata,
    type: 'text',
    left: element.left,
    top: element.top,
    width: element.width,
    height: element.height,
    rotate: element.rotate ?? 0,
    content: scaledContent || element.content || '',
    defaultFontName: element.defaultFontName ?? DEFAULT_IMPORT_THEME.fontName,
    defaultColor: element.defaultColor ?? DEFAULT_IMPORT_THEME.fontColor,
    ...(element.lineHeight != null ? { lineHeight: element.lineHeight } : {}),
    ...(element.opacity != null ? { opacity: element.opacity } : {}),
    ...(scaledWordSpace != null ? { wordSpace: scaledWordSpace } : {}),
    ...(scaledParagraphSpace != null ? { paragraphSpace: scaledParagraphSpace } : {}),
    ...(element.vertical === true ? { vertical: true } : {}),
    ...(fixedBox ? { fixedBox: true } : {}),
    ...(element.overflowVisible != null ? { overflowVisible: element.overflowVisible } : {}),
    ...(element.textInsets?.left != null ? { paddingLeft: element.textInsets.left } : {}),
    ...(element.textInsets?.right != null ? { paddingRight: element.textInsets.right } : {}),
    ...(element.textInsets?.top != null ? { paddingTop: element.textInsets.top } : {}),
    ...(element.textInsets?.bottom != null ? { paddingBottom: element.textInsets.bottom } : {}),
    ...(element.verticalAlign ? { verticalAlign: element.verticalAlign } : {}),
    ...(element.verticalAlign ? { vAlign: element.verticalAlign } : {}),
    ...(element.textAlign && element.textAlign !== 'distributed'
      ? { textAlign: element.textAlign }
      : {}),
    ...(element.autoFit ? { autoFit: element.autoFit } : {}),
    textType:
      element.textType === 'subtitle' || element.textType === 'notes'
        ? element.textType
        : element.textType === 'title'
          ? 'title'
          : 'content',
  } satisfies PPTTextElement;
}

function resolveImportedLineGeometry(element: SlideElementIR): {
  left: number;
  top: number;
  start: [number, number];
  end: [number, number];
} {
  const frameWidth = Math.max(0, element.width);
  const frameHeight = Math.max(0, element.height);
  const sourceStart: [number, number] = [0, 0];
  const sourceEnd = element.lineEnd ?? [frameWidth, frameHeight];
  const rotation = ((element.rotate ?? 0) % 360) * (Math.PI / 180);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const centerX = frameWidth / 2;
  const centerY = frameHeight / 2;

  const transform = (point: [number, number]): [number, number] => {
    const reflectedX = element.flipH ? frameWidth - point[0] : point[0];
    const reflectedY = element.flipV ? frameHeight - point[1] : point[1];
    const x = reflectedX - centerX;
    const y = reflectedY - centerY;
    return [centerX + cos * x - sin * y, centerY + sin * x + cos * y];
  };

  const start = transform(sourceStart);
  const end = transform(sourceEnd);
  const leftOffset = Math.min(start[0], end[0]);
  const topOffset = Math.min(start[1], end[1]);
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return {
    left: round(element.left + leftOffset),
    top: round(element.top + topOffset),
    start: [round(start[0] - leftOffset), round(start[1] - topOffset)],
    end: [round(end[0] - leftOffset), round(end[1] - topOffset)],
  };
}

function resolvePresetImportShape(element: SlideElementIR): {
  path: string;
  viewBox: [number, number];
  pathFormula?: ShapePathFormulasKeys;
  keypoints?: number[];
} | null {
  if (!element.shapeType || element.width <= 0 || element.height <= 0) return null;

  const pptxShapeType =
    element.shapeType === 'flowChartConnector' && element.pattern ? 'ellipse' : element.shapeType;
  const shapeTemplate = SHAPE_LIST.flatMap((group) => group.children).find(
    (candidate) => candidate.pptxShapeType === pptxShapeType,
  );
  if (!shapeTemplate) return null;

  if (shapeTemplate.pathFormula) {
    const pathFormula = shapeTemplate.pathFormula as ShapePathFormulasKeys;
    const formula = SHAPE_PATH_FORMULAS[pathFormula];
    const keypoints =
      element.keypoints ??
      (pathFormula === ShapePathFormulasKeys.ROUND_RECT
        ? [0.125]
        : (formula?.defaultValue ?? undefined));
    const path = formula
      ? formula.formula(element.width, element.height, keypoints)
      : shapeTemplate.path;
    if (pathFormula === ShapePathFormulasKeys.ROUND_RECT) {
      return {
        path,
        viewBox: [element.width, element.height],
        pathFormula,
        keypoints,
      };
    }
    return {
      path,
      viewBox: [element.width, element.height],
      pathFormula,
      ...(keypoints ? { keypoints } : {}),
    };
  }

  return {
    path: shapeTemplate.path,
    viewBox: shapeTemplate.viewBox,
  };
}

function mapSlideBackgroundElement(page: SlideIR['pages'][number]): PPTImageElement | null {
  if (page.background?.type !== 'image' || !page.background.src) {
    return null;
  }

  return {
    id: `${page.id}_background`,
    type: 'image',
    left: 0,
    top: 0,
    width: IMPORT_VIEWPORT_SIZE,
    height: page.height,
    rotate: 0,
    fixedRatio: false,
    src: page.background.src,
    imageType: 'background',
    ...(page.background.opacity != null
      ? {
          filters: {
            opacity: `${Math.round(page.background.opacity * 100)}%`,
          },
        }
      : {}),
  };
}

function buildSpeechActions(
  notes: string | string[] | undefined, // 支持数组
  elements: SlideElementIR[],
  index: number,
  slideTitle?: string,
  narrationMode?: SlideIR['narrationMode'],
): Action[] {
  // 处理notes可能是字符串或数组
  const notesText = Array.isArray(notes)
    ? notes.join('。') // 数组用句号连接
    : notes;
  const sanitizedNotesText = sanitizeImportNarrationText(notesText);

  const baseText =
    sanitizedNotesText ||
    summarizeSlideElements(elements, slideTitle) ||
    `第 ${index + 1} 页导入完成。`;
  const isLightRewrite = narrationMode === 'light_rewrite';
  const text = isLightRewrite ? lightRewriteNarration(baseText) : baseText;
  return [
    {
      id: `speech_slide_${index + 1}`,
      type: 'speech',
      text,
      source: isLightRewrite ? 'light_rewrite' : sanitizedNotesText ? 'notes' : 'generated',
    } satisfies Action,
  ];
}

function summarizeSlideElements(elements: SlideElementIR[], slideTitle?: string): string {
  const normalizedSlideTitle = slideTitle ? stripHtml(slideTitle).trim() : '';
  const textParts = elements
    .filter((element) => element.type === 'text' && typeof element.content === 'string')
    .map((element) => stripHtml(element.content || '').trim())
    .filter(Boolean);
  const hasChapterLabel = textParts.some(isDecorativeChapterLabel);
  const chapterLabel = textParts.find(isDecorativeChapterLabel);
  const nonChapterTextParts = textParts.filter((text) => !isDecorativeChapterLabel(text));
  const isSectionDivider =
    hasChapterLabel &&
    nonChapterTextParts.length <= 1 &&
    textParts.every((text) => text.length <= 24);
  if (normalizedSlideTitle && isSectionDivider) {
    return [chapterLabel, normalizedSlideTitle]
      .filter(
        (text, index, values): text is string => Boolean(text) && values.indexOf(text) === index,
      )
      .join(' ');
  }
  return textParts.slice(0, 4).join('，');
}

function isDecorativeChapterLabel(text: string): boolean {
  return /^[第\d一二三四五六七八九十]+[章节篇]$/.test(text.trim());
}

function lightRewriteNarration(text: string, role: DocumentSceneRole = 'content'): string {
  if (!text) return text;
  if (role === 'chapter') {
    return summarizePlainText(text, 48);
  }
  return summarizePlainText(text, role === 'cover' ? 56 : 72);
}

function deriveSlideTitle(
  page: SlideIR['pages'][number],
  index: number,
  fallback?: string,
): string {
  const namedTitle = page.elements.find(element => /^(?:page[-_])?title$/i.test(element.sourceObjectName ?? "") && element.content && isUsableSlideTitle(stripHtml(element.content).trim()));
  const titleElement = namedTitle ?? page.elements.find(
    (element) =>
      element.textType === 'title' &&
      element.content &&
      isUsableSlideTitle(stripHtml(element.content).trim()),
  );
  const title = titleElement?.content ? stripHtml(titleElement.content).trim() : '';
  return (
    title ||
    deriveProminentTextTitle(page) ||
    (index === 0 && fallback && !/^(?:source|document|untitled)(?:\.pptx)?$/i.test(fallback) ? fallback : undefined) ||
    `第 ${index + 1} 页`
  );
}

function isUsableSlideTitle(value: string): boolean {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized || [...normalized].length > 80) return false;
  if (!/[\p{L}\p{N}]/u.test(normalized)) return false;
  if (/^[【[](?:图片|视频|音频|文件(?:[：:].*)?)[】\]]?$/u.test(normalized)) return false;
  return !/^[【[]?(?:规则|要求|说明|注意|备注|提示)[】\]]?[：:]/u.test(normalized);
}

function deriveProminentTextTitle(page: SlideIR['pages'][number]): string {
  const centerX = page.width / 2;
  const centerY = page.height / 2;
  const candidates = page.elements
    .filter((element) => (element.type === 'text' || element.type === 'shape') && element.content)
    .map((element) => {
      const text = stripHtml(element.content || '').trim();
      const area = Math.max(0, element.width) * Math.max(0, element.height);
      const elementCenterX = element.left + element.width / 2;
      const elementCenterY = element.top + element.height / 2;
      const distanceFromCenter =
        Math.abs(elementCenterX - centerX) / Math.max(1, page.width) +
        Math.abs(elementCenterY - centerY) / Math.max(1, page.height);
      const isCentered = distanceFromCenter <= 0.32;
      const isTitleLength = text.length >= 2 && text.length <= 24;
      const isChapterLabel = isDecorativeChapterLabel(text);
      const score =
        area +
        (isCentered ? 50_000 : 0) +
        (isTitleLength ? 20_000 : 0) -
        (isChapterLabel ? 80_000 : 0);
      return { text, score };
    })
    .filter((candidate) => candidate.text && isUsableSlideTitle(candidate.text));

  return candidates.sort((left, right) => right.score - left.score)[0]?.text || '';
}

type ImportedTableCell = NonNullable<SlideElementIR['table']>[number][number];

function toTableCells(rows: ImportedTableCell[][]): TableCell[][] {
  return rows.map((row, rowIndex) =>
    row.map(
      (cell, cellIndex) =>
        ({
          id: `cell_${rowIndex + 1}_${cellIndex + 1}`,
          colspan: normalizeImportedTableSpan(
            typeof cell === 'object' && cell ? cell.colSpan : undefined,
          ),
          rowspan: normalizeImportedTableSpan(
            typeof cell === 'object' && cell ? cell.rowSpan : undefined,
          ),
          text: extractImportedTableText(cell),
          style: mapImportedTableCellStyle(cell),
        }) satisfies TableCell,
    ),
  );
}

function extractImportedTableText(cell: ImportedTableCell): string {
  if (typeof cell === 'string') return cell;
  return cell?.text ?? '';
}

function normalizeImportedTableSpan(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 1 ? value : 1;
}

function mapImportedTableCellStyle(cell: ImportedTableCell): TableCell['style'] | undefined {
  if (!cell || typeof cell !== 'object') return undefined;
  const style: NonNullable<TableCell['style']> = {};
  if (cell.fillColor) {
    style.backcolor = cell.fillColor;
  }
  if (cell.fontColor) style.color = cell.fontColor;
  if (cell.fontBold) style.bold = true;

  return Object.keys(style).length > 0 ? style : undefined;
}

function resolveImportedTableOutline(rows: ImportedTableCell[][]): PPTTableElement['outline'] {
  const borders = rows.flatMap((row) =>
    row.flatMap((cell) =>
      cell && typeof cell === 'object' ? Object.values(cell.borders ?? {}) : [],
    ),
  );
  if (borders.length === 0) return { color: '#d9d9d9', style: 'solid', width: 1 };

  const border = borders.find((candidate) => (candidate?.borderWidth ?? 0) > 0) ?? borders[0];
  return {
    color: border?.borderColor ?? '#d9d9d9',
    style:
      border?.borderType === 'dashed' || border?.borderType === 'dotted'
        ? border.borderType
        : 'solid',
    width: border?.borderWidth ?? 0,
  };
}

function stripHtml(text: string): string {
  return normalizeImportText(text);
}
