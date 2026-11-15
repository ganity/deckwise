import type {
  ImportWarning,
  PptAnimationItemIR,
  SlideElementIR,
  SlideIR,
  SlidePageIR,
} from '../types';
import {
  normalizeViewportRect,
  targetHeightFromWidth,
} from '../geometry/normalize-viewport';
import { DEFAULT_IMPORT_THEME } from '../constants';
import { resolveCoursewareFontFamily } from '../../courseware-fonts';
import { parsePptxTiming } from './animation/parse-pptx-timing';
import {
  assertPptxZipWithinLimits,
  loadPptxZipPackage,
  type ExternalMediaResolution,
} from './pptx-zip-package';
import { createLogger } from '../../logger';
import type { PdfPageImage } from '../../types/pdf';
import { createRequire } from 'node:module';
import JSZip from 'jszip';
import sharp from 'sharp';
import { SVGPathData } from 'svg-pathdata';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

const log = createLogger('PptxImport');
const resolveImportDependency = createRequire(import.meta.url).resolve;
// Large media-heavy decks are externalized after the initial download. Keep the
// entry limit aligned with the packaged-import limit so valid 300-500 MiB decks
// reach that existing slimming path instead of being rejected up front.
const MAX_DIRECT_PPTX_BYTES = 512 * 1024 * 1024;
const MAX_PARSER_MEDIA_DATA_URL_CHARS = 256 * 1024 * 1024;
const PPTX_DEFAULT_TEXT_INSET_EMU = {
  left: 91440,
  right: 91440,
  top: 45720,
  bottom: 45720,
} as const;
const PPTX_NORMAL_LINE_HEIGHT = 1.2;
const importedFontMeasureContext = createCanvas(1, 1).getContext('2d');
const importedSpaceAdvanceCache = new Map<string, number>();
const importedMeasurementFontRegistrations = new Set<string>();

const IMPORTED_MEASUREMENT_FONT_FILES: Record<string, string[]> = {
  abeezee: ['@fontsource', 'abeezee', 'files', 'abeezee-latin-400-normal.woff'],
  'abeezee regular': ['@fontsource', 'abeezee', 'files', 'abeezee-latin-400-normal.woff'],
  'abeezee bold': ['@fontsource', 'abeezee', 'files', 'abeezee-latin-400-normal.woff'],
};

type PptxParseFunction = (input: ArrayBuffer) => Promise<PptxToJsonResult>;

interface PptxParserTextInsets {
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
  l?: number;
  r?: number;
  t?: number;
  b?: number;
}

type PptxToJsonTableCell = NonNullable<SlideElementIR['table']>[number][number];

interface PptxToJsonPageElement {
  id?: string;
  sourceShapeId?: string;
  sourceGroupShapeIds?: string[];
  type?: string;
  shapType?: string;
  order?: number | string;
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  rotate?: number;
  flipH?: boolean;
  flipV?: boolean;
  isFlipH?: boolean;
  isFlipV?: boolean;
  content?: string;
  text?: { content?: string; type?: string };
  src?: string;
  poster?: string;
  autoplay?: boolean;
  trigger?: 'auto' | 'click';
  loop?: boolean;
  ext?: string;
  rect?: {
    t?: number;
    b?: number;
    l?: number;
    r?: number;
  };
  geom?: string;
  data?: PptxToJsonTableCell[][];
  colWidths?: number[];
  latex?: string;
  isVertical?: boolean;
  autoFit?: {
    type?: string;
    fontScale?: number;
    lnSpcReduction?: number;
  };
  fill?: {
    color?: string;
    type?: string;
    value?:
      | string
      | {
          picBase64?: string;
          base64?: string;
          opacity?: number;
          rot?: number | string;
          path?: string;
          colors?: Array<{
            pos?: string | number;
            color?: string;
          }>;
        };
  } | null;
  borderColor?: string;
  borderWidth?: number;
  borderType?: string;
  path?: string;
  pathViewBox?: {
    width?: number;
    height?: number;
  };
  strokeOnly?: boolean;
  vAlign?: string;
  textInsets?: PptxParserTextInsets;
  textInset?: PptxParserTextInsets;
  elements?: PptxToJsonPageElement[];
}

interface PptxToJsonPage {
  id?: string;
  width?: number;
  height?: number;
  notes?: string;
  note?: string;
  fill?: {
    type?: string;
    value?:
      | string
      | {
          picBase64?: string;
          base64?: string;
          opacity?: number;
          rot?: number | string;
          path?: string;
          colors?: Array<{
            pos?: string | number;
            color?: string;
          }>;
        };
  };
  elements?: PptxToJsonPageElement[];
}

interface PptxToJsonResult {
  title?: string;
  size?: {
    width?: number;
    height?: number;
  };
  slides?: PptxToJsonPage[];
}

interface PptxTextHighlight {
  text: string;
  color: string;
}

type PptxParagraphAlignment = 'left' | 'center' | 'right' | 'justify' | 'distributed';
type PptxParagraphLineHeight = number | string;
type PptxParagraphSpacing = { unit: 'line-height'; value: number } | { unit: 'px'; value: number };

interface PptxSlideElementMetadata {
  sourceElementId?: string;
  textHighlights?: PptxTextHighlight[];
  emptyParagraphFontSizes?: Record<number, number>;
  distributedParagraphIndexes?: number[];
  paragraphAlignments?: Record<number, PptxParagraphAlignment>;
  paragraphLineHeights?: Record<number, PptxParagraphLineHeight>;
  paragraphSpaceBefore?: Record<number, PptxParagraphSpacing>;
  paragraphBreaks?: string[];
  noWrap?: boolean;
  overflowVisible?: boolean;
  textInsets?: SlideElementIR['textInsets'];
  patternScaleMode?: SlideElementIR['patternScaleMode'];
  patternCrop?: SlideElementIR['patternCrop'];
  verticalAlign?: SlideElementIR['verticalAlign'];
  autoFit?: SlideElementIR['autoFit'];
  keypoints?: SlideElementIR['keypoints'];
  borderWidth?: SlideElementIR['borderWidth'];
  borderType?: SlideElementIR['borderType'];
}

interface PptxSlideSupplement {
  sourceNames?: Map<string, string>;
  background?: SlidePageIR['background'];
  elementMetadata: PptxSlideElementMetadata[];
  fallbackElements: SlideElementIR[];
  tableNoFillBySourceId?: Map<string, boolean[][]>;
  themeFonts?: PptxThemeFonts;
  pptxAnimation?: SlidePageIR['pptxAnimation'];
}

type PptxThemeFontToken = '+mj-lt' | '+mj-ea' | '+mj-cs' | '+mn-lt' | '+mn-ea' | '+mn-cs';
type PptxThemeFonts = Partial<Record<PptxThemeFontToken, string>>;

const PPTX_THEME_FONT_TOKENS = new Set<PptxThemeFontToken>([
  '+mj-lt',
  '+mj-ea',
  '+mj-cs',
  '+mn-lt',
  '+mn-ea',
  '+mn-cs',
]);

interface PptxThemeStyleContext {
  schemeColors: Record<string, string>;
  lineStyles: string[];
  effectStyles: string[];
}

interface PptxSlideLayoutContext {
  path: string;
  xml: string;
  relationships: Map<string, PptxRelationshipEntry>;
}

interface ParserFlattenTransform {
  matrix: [number, number, number, number, number, number];
  rotation: number;
  flipH: boolean;
  flipV: boolean;
}

interface FallbackCustomGeometry {
  path: string;
  viewBox: [number, number];
}

interface XmlAffineTransform {
  translateX: number;
  translateY: number;
  scaleX: number;
  scaleY: number;
  childOffsetX: number;
  childOffsetY: number;
}

interface ChartFrameNode {
  id: string;
  relId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FallbackMediaNode {
  kind: 'video' | 'audio' | 'unknown';
  relId: string;
}

type MediaPlaybackTrigger = {
  trigger: 'auto' | 'click';
  loop: boolean;
};

interface ParsedChartModel {
  chartType:
    | 'bar'
    | 'column'
    | 'line'
    | 'area'
    | 'pie'
    | 'ring'
    | 'scatter'
    | 'radar'
    | 'bubble'
    | 'summary';
  labels: string[];
  legends: string[];
  series: number[][];
  themeColors: string[];
  stack?: boolean;
  smooth?: boolean;
  seriesTypes?: Array<'bar' | 'column' | 'line' | 'area'>;
  seriesShowValues?: boolean[];
  seriesAxisIds?: Array<string | undefined>;
  seriesFormatCodes?: Array<string | undefined>;
  seriesLineWidths?: Array<number | undefined>;
  seriesMarkerKinds?: Array<string | undefined>;
  seriesMarkerSizes?: Array<number | undefined>;
  primaryAxis?: ParsedChartAxis;
  secondaryAxis?: ParsedChartAxis;
  chartBackgroundColor?: string;
  plotAreaBackgroundColor?: string;
  scatterXSeries?: number[][];
  bubbleSizes?: number[][];
}

interface ParsedChartAxis {
  id?: string;
  min?: number;
  max?: number;
  formatCode?: string;
  showMajorGridlines?: boolean;
  position?: 'left' | 'right';
}

interface PptxParseRecoveryResult {
  mode: 'parsed' | 'sanitized' | 'fallback';
  parsed?: PptxToJsonResult;
  fallback?: {
    title: string;
    deckSize: {
      width: number;
      height: number;
    };
    pages: SlidePageIR[];
  };
  warnings: ImportWarning[];
}

interface PptxRelationshipEntry {
  id: string;
  target?: string;
  type?: string;
  targetMode?: string;
}

export interface PptxImportAssetSink {
  registerAsset(input: {
    assetType: 'image' | 'video' | 'audio';
    sourceKey: string;
    mimeType: string;
    buffer: Uint8Array | Buffer;
    ext?: string;
  }): Promise<string>;
}

type PagePreviewRenderer = (input: {
  arrayBuffer: ArrayBuffer;
  fileName: string;
}) => Promise<PdfPageImage[]>;

interface PptxImportMediaContext {
  assetRegistry?: PptxImportAssetSink;
  resolveExternalMedia?: (target: string) => Promise<ExternalMediaResolution>;
  warnings: ImportWarning[];
  warningKeys: Set<string>;
}

interface ResolvedRelationshipAsset {
  sourceKey: string;
  assetPath: string;
  mimeType: string;
  bytes: Uint8Array;
}

export async function importPptxFromBuffer(params: {
  arrayBuffer: ArrayBuffer;
  fileName: string;
  narrationMode?: 'original' | 'light_rewrite' | 'generated';
  assetSink?: PptxImportAssetSink;
  renderPagePreviews?: PagePreviewRenderer;
  packageType?: 'zip';
  signal?: AbortSignal;
}): Promise<SlideIR> {
  const startedAt = Date.now();
  throwIfAborted(params.signal);
  if (params.arrayBuffer.byteLength > MAX_DIRECT_PPTX_BYTES) {
    throw new Error('ZIP_LIMIT_EXCEEDED: ZIP 文件大小超过限制');
  }
  const mediaContext: PptxImportMediaContext = {
    assetRegistry: params.assetSink,
    warnings: [],
    warningKeys: new Set<string>(),
  };
  let fileName = params.fileName;
  let arrayBuffer = params.arrayBuffer;
  if (params.packageType === 'zip') {
    const packageSource = await loadPptxZipPackage(arrayBuffer);
    fileName = packageSource.pptxFileName;
    arrayBuffer = packageSource.pptxBuffer;
    mediaContext.resolveExternalMedia = packageSource.resolveExternalMedia;
  }
  const prepare =
    params.assetSink || params.packageType === 'zip'
      ? prepareAndParsePptxBuffer
      : importPptxFromBufferLegacyPath;
  const prepared = await prepare({
    arrayBuffer,
    fileName,
    startedAt,
    fetchStartedAt: startedAt,
    fetchedAt: Date.now(),
    mediaContext,
    renderPagePreviews: params.renderPagePreviews,
    signal: params.signal,
  });
  const parsed = prepared.recovered.parsed;
  throwIfAborted(params.signal);
  const pages = parsed
    ? (parsed.slides ?? []).map((page, index) =>
        mapPage(page, index, parsed.size, prepared.slideSupplements[index], mediaContext),
      )
    : mergeFallbackPagesWithSupplements(
        prepared.recovered.fallback?.pages ?? [],
        prepared.slideSupplements,
        prepared.recovered.fallback?.deckSize,
      );
  for (const preview of prepared.pagePreviews) {
    const page = pages[preview.pageNumber - 1];
    if (!page?.id || !preview.src) continue;
    const previewSrc = mediaContext.assetRegistry
      ? await externalizeParserDataUrl(
          preview.src,
          mediaContext.assetRegistry,
          `page_${preview.pageNumber}_preview`,
          'image',
        )
      : preview.src;
    page.previewImage = {
      src: previewSrc || preview.src,
      width: preview.width,
      height: preview.height,
    };
  }
  if (mediaContext.assetRegistry) {
    await externalizeSlidePagesMedia(pages, mediaContext.assetRegistry);
  }
  throwIfAborted(params.signal);
  const warnings = [...prepared.recovered.warnings, ...mediaContext.warnings];

  return {
    kind: 'slide',
    sourceType: 'pptx',
    title: parsed?.title || prepared.recovered.fallback?.title || stripExtension(fileName),
    pages,
    ...(params.narrationMode ? { narrationMode: params.narrationMode } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    fidelityReport: {
      sourceType: 'pptx',
      detectedPath: 'ppt',
      level: prepared.recovered.mode === 'fallback' ? 'L1' : 'L2',
      ...(warnings.length > 0 ? { notes: warnings.map((warning) => warning.message) } : {}),
    },
  };
}

async function prepareAndParsePptxBuffer(params: {
  arrayBuffer: ArrayBuffer;
  fileName: string;
  startedAt: number;
  fetchStartedAt: number;
  fetchedAt: number;
  mediaContext: PptxImportMediaContext;
  renderPagePreviews?: PagePreviewRenderer;
  signal?: AbortSignal;
}): Promise<{
  recovered: PptxParseRecoveryResult;
  slideSupplements: PptxSlideSupplement[];
  pagePreviews: PdfPageImage[];
}> {
  const { arrayBuffer, fetchedAt } = params;
  throwIfAborted(params.signal);
  const byteLength = arrayBuffer.byteLength;
  let slideSupplements: PptxSlideSupplement[] = [];
  let parserArrayBuffer = arrayBuffer;
  let slimMs = 0;
  let supplementMs = 0;

  const originalZip = await loadPptxZip(arrayBuffer);
  throwIfAborted(params.signal);

  if (originalZip) {
    const supplementStartedAt = Date.now();
    slideSupplements = await extractPptxSlideSupplementsFromZip(originalZip, params.mediaContext);
    throwIfAborted(params.signal);
    const supplementCompletedAt = Date.now();
    supplementMs = supplementCompletedAt - supplementStartedAt;

    const slimStartedAt = Date.now();
    parserArrayBuffer = await slimLoadedPptxForMainParser(
      originalZip,
      arrayBuffer,
      params.fileName,
    );
    throwIfAborted(params.signal);
    const slimCompletedAt = Date.now();
    slimMs = slimCompletedAt - slimStartedAt;
  } else {
    const slimStartedAt = Date.now();
    parserArrayBuffer = arrayBuffer;
    const slimCompletedAt = Date.now();
    slimMs = slimCompletedAt - slimStartedAt;

    const supplementStartedAt = Date.now();
    slideSupplements = originalZip
      ? await extractPptxSlideSupplementsFromZip(originalZip, params.mediaContext)
      : [];
    const supplementCompletedAt = Date.now();
    supplementMs = supplementCompletedAt - supplementStartedAt;
  }

  log.info(`开始解析 PPTX: file=${params.fileName}, bytes=${byteLength}`);
  log.info(
    `PPTX 导入阶段耗时: file=${params.fileName}, fetchMs=${fetchedAt - params.fetchStartedAt}, slimMs=${slimMs}, totalBeforeParseMs=${Date.now() - params.startedAt}`,
  );
  const parseStartedAt = Date.now();
  // shortcut: synchronous parser work cannot be interrupted; use an isolated process for hard cancellation.
  const recovered = await parsePptxWithRecovery(parserArrayBuffer, arrayBuffer, params.fileName);
  throwIfAborted(params.signal);
  const parseCompletedAt = Date.now();
  const parsed = recovered.parsed;
  log.info(
    `PPTX 主解析完成: file=${params.fileName}, mode=${recovered.mode}, slides=${parsed?.slides?.length ?? recovered.fallback?.pages.length ?? 0}, parseMs=${parseCompletedAt - parseStartedAt}`,
  );
  log.info(
    `PPTX 补偿解析完成: file=${params.fileName}, supplements=${slideSupplements.length}, supplementMs=${supplementMs}, elapsedMs=${Date.now() - params.startedAt}`,
  );
  const pagePreviews = await renderPptxPagePreviews({
    arrayBuffer,
    fileName: params.fileName,
    renderer: params.renderPagePreviews,
    warnings: params.mediaContext.warnings,
  });

  return {
    recovered,
    slideSupplements,
    pagePreviews,
  };
}

async function importPptxFromBufferLegacyPath(params: {
  arrayBuffer: ArrayBuffer;
  fileName: string;
  startedAt: number;
  fetchStartedAt: number;
  mediaContext: PptxImportMediaContext;
  renderPagePreviews?: PagePreviewRenderer;
  signal?: AbortSignal;
}): Promise<{
  recovered: PptxParseRecoveryResult;
  slideSupplements: PptxSlideSupplement[];
  pagePreviews: PdfPageImage[];
}> {
  const { arrayBuffer } = params;
  throwIfAborted(params.signal);
  const fetchedAt = Date.now();
  const originalZip = await loadPptxZip(arrayBuffer);
  const parserArrayBuffer = arrayBuffer;
  log.info(`开始解析 PPTX: file=${params.fileName}, bytes=${arrayBuffer.byteLength}`);
  log.info(
    `PPTX 导入阶段耗时: file=${params.fileName}, fetchMs=${fetchedAt - params.fetchStartedAt}, slimMs=0, totalBeforeParseMs=${fetchedAt - params.startedAt}`,
  );
  const parseStartedAt = Date.now();
  const recovered = await parsePptxWithRecovery(parserArrayBuffer, arrayBuffer, params.fileName);
  throwIfAborted(params.signal);
  const parseCompletedAt = Date.now();
  const parsed = recovered.parsed;
  log.info(
    `PPTX 主解析完成: file=${params.fileName}, mode=${recovered.mode}, slides=${parsed?.slides?.length ?? recovered.fallback?.pages.length ?? 0}, parseMs=${parseCompletedAt - parseStartedAt}`,
  );
  const supplementStartedAt = Date.now();
  const slideSupplements = originalZip
    ? await extractPptxSlideSupplementsFromZip(originalZip, params.mediaContext)
    : [];
  const supplementCompletedAt = Date.now();
  log.info(
    `PPTX 补偿解析完成: file=${params.fileName}, supplements=${slideSupplements.length}, supplementMs=${supplementCompletedAt - supplementStartedAt}, elapsedMs=${supplementCompletedAt - params.startedAt}`,
  );
  const pagePreviews = await renderPptxPagePreviews({
    arrayBuffer,
    fileName: params.fileName,
    renderer: params.renderPagePreviews,
    warnings: params.mediaContext.warnings,
  });
  return {
    recovered,
    slideSupplements,
    pagePreviews,
  };
}

async function renderPptxPagePreviews(params: {
  arrayBuffer: ArrayBuffer;
  fileName: string;
  renderer?: PagePreviewRenderer;
  warnings: ImportWarning[];
}): Promise<PdfPageImage[]> {
  if (!params.renderer) return [];

  try {
    const pageImages = await params.renderer(params);
    log.info(`PPTX 整页预览生成完成: file=${params.fileName}, pages=${pageImages.length}`);
    return pageImages;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    params.warnings.push({
      code: 'pptx-page-preview-unavailable',
      message: `PPTX 整页预览生成失败，讲解将回退到解析图片：${reason}`,
      severity: 'warning',
    });
    log.warn(`PPTX 整页预览生成失败: file=${params.fileName}, reason=${reason}`);
    return [];
  }
}

async function loadPptxZip(arrayBuffer: ArrayBuffer): Promise<JSZip | undefined> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(arrayBuffer);
  } catch {
    return undefined;
  }
  assertPptxZipWithinLimits(zip);
  return zip;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('PPTX import canceled', 'AbortError');
  }
}

async function parsePptxWithRecovery(
  parserArrayBuffer: ArrayBuffer,
  originalArrayBuffer: ArrayBuffer,
  fileName: string,
): Promise<PptxParseRecoveryResult> {
  const parse = await loadPptxParseFunction();

  try {
    const parsed = (await parse(parserArrayBuffer)) as PptxToJsonResult;
    return {
      mode: 'parsed',
      parsed,
      warnings: [],
    };
  } catch (primaryError) {
    log.warn(
      `PPTX 主解析失败，尝试清洗关系文件后重试: file=${fileName}, error=${getErrorMessage(primaryError)}`,
    );
  }

  const sanitized = await sanitizePptxRelationshipTargets(parserArrayBuffer);
  if (sanitized.changed) {
    log.info(
      `PPTX 检测到可清洗的异常结构: file=${fileName}, changedFileCount=${sanitized.changedFileCount}, changedRelationshipCount=${sanitized.changedRelationshipCount}, prunedEmptyBlipPictureCount=${sanitized.prunedEmptyBlipPictureCount}, normalizedMasterCustomGeometryCount=${sanitized.normalizedMasterCustomGeometryCount}`,
    );
    try {
      const parsed = (await parse(sanitized.buffer)) as PptxToJsonResult;
      return {
        mode: 'sanitized',
        parsed,
        warnings: [
          {
            code: 'pptx_structure_sanitized',
            severity: 'warning',
            message: describeSanitizedPptxChanges(sanitized),
          },
        ],
      };
    } catch (sanitizedError) {
      log.warn(
        `PPTX 清洗后重试仍失败，转入 OOXML fallback: file=${fileName}, error=${getErrorMessage(sanitizedError)}`,
      );
    }
  } else {
    log.warn(`PPTX 未发现可清洗的异常结构，直接转入 OOXML fallback: file=${fileName}`);
  }

  const fallback = await buildFallbackPptxFromZip(originalArrayBuffer, fileName);
  const sanitizedWarnings: ImportWarning[] = sanitized.changed
    ? [
        {
          code: 'pptx_structure_sanitized',
          severity: 'info',
          message: `${describeSanitizedPptxChanges(sanitized)}，但主解析仍失败，已降级为 OOXML 导入`,
        },
      ]
    : [];
  const warnings: ImportWarning[] = [
    {
      code: 'pptx_fallback_ooxml',
      severity: 'warning',
      message: 'PPTX 主解析失败，已切换为 OOXML 兼容导入模式，可能存在少量样式差异',
    },
    ...sanitizedWarnings,
  ];
  return {
    mode: 'fallback',
    fallback,
    warnings,
  };
}

async function slimLoadedPptxForMainParser(
  zip: JSZip,
  originalArrayBuffer: ArrayBuffer,
  fileName: string,
): Promise<ArrayBuffer> {
  const fontPaths = Object.keys(zip.files).filter((entryPath) =>
    /^ppt\/fonts\/.+\.fntdata$/i.test(entryPath),
  );
  const embeddedMediaTargets = await collectEmbeddedParserMediaTargets(zip);
  const embeddedImageTargets = await collectEmbeddedParserImageTargets(zip);
  const slimmedTargets = new Set<string>([
    ...fontPaths,
    ...embeddedMediaTargets,
    ...embeddedImageTargets,
  ]);
  if (slimmedTargets.size <= 0) {
    return originalArrayBuffer;
  }

  for (const target of slimmedTargets) {
    if (!zip.file(target)) continue;
    if (embeddedImageTargets.includes(target)) {
      const replacement = buildSlimImagePlaceholder(target);
      if (replacement) {
        zip.file(target, replacement);
        continue;
      }
    }
    zip.file(target, new Uint8Array([0]));
  }

  log.info(
    `PPTX 主解析瘦身完成: file=${fileName}, slimmedEntries=${slimmedTargets.size}, fonts=${fontPaths.length}, media=${embeddedMediaTargets.length}, images=${embeddedImageTargets.length}`,
  );
  return zip.generateAsync({ type: 'arraybuffer' });
}

async function collectEmbeddedParserMediaTargets(zip: JSZip): Promise<string[]> {
  const targets = new Set<string>();
  const slidePaths = extractSortedSlidePaths(zip);
  for (const slidePath of slidePaths) {
    const relationships = parseRelationshipEntries(
      await readZipText(zip, getSlideRelsPath(slidePath)),
    );
    for (const entry of relationships.values()) {
      if (!entry.target || entry.targetMode === 'External') continue;
      if (!isEmbeddedParserMediaRelationship(entry.type)) continue;
      targets.add(resolveZipTarget(slidePath, entry.target));
    }
  }
  return [...targets];
}

async function collectEmbeddedParserImageTargets(zip: JSZip): Promise<string[]> {
  const targets = new Set<string>();
  const slidePaths = extractSortedSlidePaths(zip);
  for (const slidePath of slidePaths) {
    const relationships = parseRelationshipEntries(
      await readZipText(zip, getSlideRelsPath(slidePath)),
    );
    for (const entry of relationships.values()) {
      if (!entry.target || entry.targetMode === 'External') continue;
      if (!isEmbeddedParserImageRelationship(entry.type)) continue;
      targets.add(resolveZipTarget(slidePath, entry.target));
    }
  }
  return [...targets];
}

function isEmbeddedParserMediaRelationship(type?: string): boolean {
  if (!type) return false;
  return /\/(video|audio|media)$/i.test(type);
}

function isEmbeddedParserImageRelationship(type?: string): boolean {
  if (!type) return false;
  return /\/(image|hdphoto)$/i.test(type);
}

function buildSlimImagePlaceholder(target: string): Uint8Array | null {
  const ext = normalizeMediaExtension(target)?.toLowerCase();
  if (ext === 'png' || ext === 'wdp') {
    return Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
      0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8,
      0xcf, 0xc0, 0x00, 0x00, 0x03, 0x01, 0x01, 0x00, 0xc9, 0xfe, 0x92, 0xef, 0x00, 0x00, 0x00,
      0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
  }
  if (ext === 'jpg' || ext === 'jpeg') {
    return Uint8Array.from([
      0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07,
      0x07, 0x07, 0x09, 0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
      0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20, 0x24, 0x2e, 0x27,
      0x20, 0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29, 0x2c, 0x30, 0x31, 0x34, 0x34, 0x34,
      0x1f, 0x27, 0x39, 0x3d, 0x38, 0x32, 0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x11,
      0x08, 0x00, 0x01, 0x00, 0x01, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
      0xff, 0xc4, 0x00, 0x14, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xc4, 0x00, 0x14, 0x10, 0x01, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xda, 0x00, 0x0c, 0x03,
      0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00, 0xff, 0xd9,
    ]);
  }
  if (ext === 'gif') {
    return Uint8Array.from([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00,
      0x00, 0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00,
      0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
    ]);
  }
  return null;
}

async function sanitizePptxRelationshipTargets(arrayBuffer: ArrayBuffer): Promise<{
  buffer: ArrayBuffer;
  changed: boolean;
  changedFileCount: number;
  changedRelationshipCount: number;
  prunedEmptyBlipPictureCount: number;
  normalizedMasterCustomGeometryCount: number;
}> {
  const zip = await loadPptxZip(arrayBuffer);
  if (!zip) {
    return {
      buffer: arrayBuffer,
      changed: false,
      changedFileCount: 0,
      changedRelationshipCount: 0,
      prunedEmptyBlipPictureCount: 0,
      normalizedMasterCustomGeometryCount: 0,
    };
  }

  let changedFileCount = 0;
  let changedRelationshipCount = 0;
  const relPaths = Object.keys(zip.files).filter((path) => /^ppt\/.*\.rels$/i.test(path));
  for (const relPath of relPaths) {
    const xml = await readZipText(zip, relPath);
    if (!xml) continue;
    const { xml: nextXml, changedCount } = injectMissingRelationshipTargets(xml);
    if (changedCount <= 0) continue;
    zip.file(relPath, nextXml);
    changedFileCount += 1;
    changedRelationshipCount += changedCount;
  }

  let prunedEmptyBlipPictureCount = 0;
  const slidePaths = extractSortedSlidePaths(zip);
  for (const slidePath of slidePaths) {
    const xml = await readZipText(zip, slidePath);
    if (!xml) continue;
    const { xml: nextXml, prunedCount } = pruneEmptyBlipPictureNodes(xml);
    if (prunedCount <= 0) continue;
    zip.file(slidePath, nextXml);
    changedFileCount += 1;
    prunedEmptyBlipPictureCount += prunedCount;
  }

  // pptxtojson assumes every custom geometry has one path. Some WPS-created
  // masters contain an invisible multi-path geometry, which otherwise throws
  // before the slide content can be parsed. Only normalize that parser input;
  // the original deck remains untouched and is still used for fallback data.
  let normalizedMasterCustomGeometryCount = 0;
  const masterPaths = Object.keys(zip.files).filter((path) =>
    /^ppt\/slideMasters\/slideMaster\d+\.xml$/i.test(path),
  );
  for (const masterPath of masterPaths) {
    const xml = await readZipText(zip, masterPath);
    if (!xml) continue;
    const { xml: nextXml, normalizedCount } = normalizeUnsupportedMasterCustomGeometry(xml);
    if (normalizedCount <= 0) continue;
    zip.file(masterPath, nextXml);
    changedFileCount += 1;
    normalizedMasterCustomGeometryCount += normalizedCount;
  }

  if (
    changedRelationshipCount <= 0 &&
    prunedEmptyBlipPictureCount <= 0 &&
    normalizedMasterCustomGeometryCount <= 0
  ) {
    return {
      buffer: arrayBuffer,
      changed: false,
      changedFileCount: 0,
      changedRelationshipCount: 0,
      prunedEmptyBlipPictureCount: 0,
      normalizedMasterCustomGeometryCount: 0,
    };
  }

  const buffer = await zip.generateAsync({ type: 'arraybuffer' });
  return {
    buffer,
    changed: true,
    changedFileCount,
    changedRelationshipCount,
    prunedEmptyBlipPictureCount,
    normalizedMasterCustomGeometryCount,
  };
}

function normalizeUnsupportedMasterCustomGeometry(xml: string): {
  xml: string;
  normalizedCount: number;
} {
  let normalizedCount = 0;
  const nextXml = xml.replace(/<a:custGeom\b[\s\S]*?<\/a:custGeom>/gi, (customGeometryXml) => {
    // pptxtojson reads only one path and cannot safely process the multi-path
    // master geometry emitted by some WPS templates.
    if (
      (customGeometryXml.match(/<a:path\b/gi) ?? []).length < 2 ||
      !/<a:cxnLst\b/i.test(customGeometryXml)
    ) {
      return customGeometryXml;
    }
    normalizedCount += 1;
    return '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>';
  });
  return { xml: nextXml, normalizedCount };
}

function injectMissingRelationshipTargets(xml: string): {
  xml: string;
  changedCount: number;
} {
  let changedCount = 0;
  let nextXml = xml.replace(/<Relationship\b([^>]*?)\/>/gi, (match, attrs) => {
    if (/\bTarget=/i.test(attrs)) return match;
    changedCount += 1;
    return `<Relationship${attrs} Target=""/>`;
  });
  nextXml = nextXml.replace(
    /<Relationship\b([^>]*?)>(\s*)<\/Relationship>/gi,
    (match, attrs, whitespace) => {
      if (/\bTarget=/i.test(attrs)) return match;
      changedCount += 1;
      return `<Relationship${attrs} Target="">${whitespace}</Relationship>`;
    },
  );
  return { xml: nextXml, changedCount };
}

function pruneEmptyBlipPictureNodes(xml: string): {
  xml: string;
  prunedCount: number;
} {
  let prunedCount = 0;
  const nextXml = xml.replace(/<p:pic\b[\s\S]*?<\/p:pic>/gi, (block) => {
    if (!/<a:blip\b/i.test(block)) return block;
    if (/<a:blip\b[^>]*(?:r:embed|r:link)=/i.test(block)) return block;
    prunedCount += 1;
    return '';
  });
  return {
    xml: nextXml,
    prunedCount,
  };
}

function describeSanitizedPptxChanges(sanitized: {
  changedFileCount: number;
  changedRelationshipCount: number;
  prunedEmptyBlipPictureCount: number;
  normalizedMasterCustomGeometryCount: number;
}): string {
  const parts: string[] = [];
  if (sanitized.changedRelationshipCount > 0) {
    parts.push(`修复缺失 Target 的关系节点 ${sanitized.changedRelationshipCount} 处`);
  }
  if (sanitized.prunedEmptyBlipPictureCount > 0) {
    parts.push(`移除空图片引用节点 ${sanitized.prunedEmptyBlipPictureCount} 个`);
  }
  if (sanitized.normalizedMasterCustomGeometryCount > 0) {
    parts.push(
      `规避主解析器不支持的母版多路径自定义几何 ${sanitized.normalizedMasterCustomGeometryCount} 个`,
    );
  }
  const summary = parts.length > 0 ? parts.join('，') : '修复了异常 PPTX 结构';
  return `PPTX 存在异常结构，已自动清洗并继续导入（文件数 ${sanitized.changedFileCount}，${summary}）`;
}

async function buildFallbackPptxFromZip(
  arrayBuffer: ArrayBuffer,
  fileName: string,
): Promise<{
  title: string;
  deckSize: {
    width: number;
    height: number;
  };
  pages: SlidePageIR[];
}> {
  const zip = await loadPptxZip(arrayBuffer);
  if (!zip) {
    throw new Error('Invalid PPTX ZIP');
  }
  const presentationXml = await readZipText(zip, 'ppt/presentation.xml');
  const deckSize = extractPresentationSlideSize(presentationXml);
  const slidePaths = extractSortedSlidePaths(zip);
  const targetHeight = targetHeightFromWidth(1000, deckSize.width, deckSize.height);

  const pages = await Promise.all(
    slidePaths.map(async (slidePath, index) => {
      const slideXml = await readZipText(zip, slidePath);
      const relationshipsXml = await readZipText(zip, getSlideRelsPath(slidePath));
      const relationshipEntries = parseRelationshipEntries(relationshipsXml);
      const layoutContext = await extractSlideLayoutContext(zip, slidePath, relationshipEntries);
      const themeStyle = await extractSlideThemeStyleContext(zip, layoutContext);
      const notes = await extractFallbackSlideNotes(zip, slidePath, relationshipEntries);
      const background = slideXml
        ? await extractSlideBackgroundWithLayoutFallback(
            zip,
            slidePath,
            slideXml,
            relationshipEntries,
            deckSize,
          )
        : undefined;
      const elements = slideXml
        ? [
            ...(layoutContext
              ? await extractSlideLayoutRenderableElements(
                  zip,
                  layoutContext,
                  deckSize,
                  undefined,
                  slideXml,
                  themeStyle,
                )
              : []),
            ...(await extractFallbackRenderableElements(
              zip,
              slidePath,
              slideXml,
              relationshipEntries,
              deckSize,
              undefined,
              themeStyle,
            )),
          ]
        : [];
      return {
        id: `page_${index + 1}`,
        width: 1000,
        height: targetHeight,
        ...(notes ? { notes } : {}),
        ...(background ? { background } : {}),
        elements,
      } satisfies SlidePageIR;
    }),
  );

  return {
    title: stripExtension(fileName),
    deckSize,
    pages,
  };
}

function mergeFallbackPagesWithSupplements(
  pages: SlidePageIR[],
  slideSupplements: PptxSlideSupplement[],
  deckSize?: { width: number; height: number },
): SlidePageIR[] {
  if (!deckSize) return pages;
  return pages.map((page, index) => {
    const supplement = slideSupplements[index];
    const fallbackElements = (supplement?.fallbackElements ?? []).map((element) =>
      scaleSupplementElement(element, deckSize.width, deckSize.height, page.height),
    );
    if (fallbackElements.length <= 0 && !supplement?.background && !supplement?.pptxAnimation)
      return page;
    const elements = normalizeImportedAnimatedTextOverlays(
      normalizeImportedPronunciationLayout(
        normalizeOverlayPlaceholderTextInsets(
          normalizeImportedShapeGeometry(
            materializeImportedElementSpaceWidths(
              applyPptxThemeFonts(
                mergeSupplementElements(page.elements, fallbackElements),
                supplement?.themeFonts,
              ),
            ),
          ),
        ),
      ),
      supplement?.pptxAnimation,
    );
    for (const element of elements) {
      const name = element.sourceShapeId && supplement?.sourceNames?.get(element.sourceShapeId);
      if (name) element.sourceObjectName = name;
    }
    return {
      ...page,
      background: mergeSupplementBackground(page.background, supplement?.background),
      elements: applyMotionEntranceFinalPositions(
        elements,
        supplement?.pptxAnimation,
        page.width,
        page.height,
      ),
      ...(supplement?.pptxAnimation ? { pptxAnimation: supplement.pptxAnimation } : {}),
    };
  });
}

function mapPage(
  page: PptxToJsonPage,
  index: number,
  deckSize?: PptxToJsonResult['size'],
  supplement?: PptxSlideSupplement,
  mediaContext?: PptxImportMediaContext,
): SlidePageIR {
  const pageWidth = page.width ?? deckSize?.width ?? 960;
  const pageHeight = page.height ?? deckSize?.height ?? 540;
  const targetHeight = targetHeightFromWidth(1000, pageWidth, pageHeight);
  const fallbackElements = (supplement?.fallbackElements ?? []).map((element) =>
    scaleSupplementElement(element, pageWidth, pageHeight, targetHeight),
  );

  let metadataIndex = 0;
  const metadataByElementId = new Map<string, PptxSlideElementMetadata>();
  const metadataBySourceId = new Map(
    (supplement?.elementMetadata ?? []).flatMap((metadata) =>
      metadata.sourceElementId ? [[metadata.sourceElementId, metadata] as const] : [],
    ),
  );
  const parserElements = sortParserElementsBySourceOrder(flattenPageElements(page.elements ?? []));
  const mappedElements = parserElements.flatMap((element, elementIndex) => {
    const rawType = normalizeElementType(element);
    const positionalMetadata =
      rawType === 'shape' || rawType === 'text'
        ? supplement?.elementMetadata[metadataIndex++]
        : undefined;
    const metadata =
      (element.sourceShapeId ? metadataBySourceId.get(element.sourceShapeId) : undefined) ??
      positionalMetadata;

    const rawMapped = mapElement(
      element,
      pageWidth,
      pageHeight,
      targetHeight,
      elementIndex,
      metadata,
      element.sourceShapeId
        ? supplement?.tableNoFillBySourceId?.get(element.sourceShapeId)
        : undefined,
      mediaContext,
    );
    const mapped = rawMapped.map((mappedElement, mappedIndex) => {
      // A simple PPT shape can be split into a visual background plus an
      // editable text layer. Source identity (and therefore animations) must
      // follow the foreground text rather than the decorative background.
      const carriesSourceIdentity = rawMapped.length === 1 || mappedIndex === rawMapped.length - 1;
      return {
        ...mappedElement,
        ...(carriesSourceIdentity && element.sourceShapeId
          ? { sourceShapeId: element.sourceShapeId }
          : {}),
        ...(element.sourceGroupShapeIds?.length
          ? { sourceGroupShapeIds: element.sourceGroupShapeIds }
          : {}),
        ...(normalizeNumber(element.order) != null
          ? { sourceOrder: normalizeNumber(element.order) }
          : {}),
      };
    });
    if (metadata?.sourceElementId) {
      // When a shape is split, the OOXML metadata belongs to the editable
      // foreground text. Giving it to the visual background as well lets the
      // fallback reconciler hydrate the background with duplicate text.
      const metadataTargets = mapped.length > 1 ? mapped.slice(-1) : mapped;
      for (const mappedElement of metadataTargets) {
        metadataByElementId.set(mappedElement.id, metadata);
      }
    }
    return mapped;
  });

  const elements = normalizeImportedAnimatedTextOverlays(
    normalizeImportedPronunciationLayout(
      normalizeOverlayPlaceholderTextInsets(
        normalizeImportedShapeGeometry(
          materializeImportedElementSpaceWidths(
            applyPptxThemeFonts(
              repairParserMediaFromSupplements(
                mergeSupplementElements(mappedElements, fallbackElements, metadataByElementId),
                fallbackElements,
              ),
              supplement?.themeFonts,
            ),
          ),
        ),
      ),
    ),
    supplement?.pptxAnimation,
  );
  for (const element of elements) {
    const name = element.sourceShapeId && supplement?.sourceNames?.get(element.sourceShapeId);
    if (name) element.sourceObjectName = name;
  }
  return {
    id: page.id || `page_${index + 1}`,
    width: 1000,
    height: targetHeight,
    notes: page.notes ?? page.note,
    background: mergeSupplementBackground(mapPageBackground(page.fill), supplement?.background),
    elements: applyMotionEntranceFinalPositions(
      elements,
      supplement?.pptxAnimation,
      1000,
      targetHeight,
    ),
    ...(supplement?.pptxAnimation ? { pptxAnimation: supplement.pptxAnimation } : {}),
  };
}

function normalizeOverlayPlaceholderTextInsets(elements: SlideElementIR[]): SlideElementIR[] {
  const normalizedById = new Map(elements.map((element) => [element.id, element]));
  for (const element of elements) {
    const paragraphPlaceholderCenters = calculateImportedPlaceholderCenters(element);
    const paragraphPlaceholderCounts = paragraphPlaceholderCenters.map((centers) => centers.length);
    const placeholderCount = paragraphPlaceholderCounts.reduce((sum, count) => sum + count, 0);
    if (
      placeholderCount <= 0 ||
      (element.type !== 'text' && element.type !== 'shape') ||
      element.verticalAlign !== 'top' ||
      !(element.fontSize && element.fontSize > 0) ||
      !(element.lineHeight && element.lineHeight > 1.2)
    ) {
      continue;
    }

    const hostColor = normalizeCssColor(element.defaultColor);
    const nearbyAnswerOverlays = elements.filter((candidate) => {
      if (
        candidate === element ||
        candidate.type !== 'text' ||
        !candidate.content ||
        (candidate.content.match(/<p\b/gi)?.length ?? 0) !== 1 ||
        /<br\b/i.test(candidate.content) ||
        !(candidate.fontSize && candidate.fontSize > 0) ||
        normalizeElementIdentityText(candidate.content).length > 10
      ) {
        return false;
      }
      const candidateColor = normalizeCssColor(candidate.defaultColor);
      if (
        !candidateColor ||
        candidateColor === hostColor ||
        !isAccentOverlayColor(candidateColor)
      ) {
        return false;
      }
      if (
        candidate.fontSize < element.fontSize! * 0.65 ||
        candidate.fontSize > element.fontSize! * 1.35
      ) {
        return false;
      }

      const horizontalTolerance = Math.max(16, element.fontSize! * 0.75);
      const verticalTolerance = Math.max(16, element.fontSize! * 0.75);
      return (
        candidate.left + candidate.width >= element.left - horizontalTolerance &&
        candidate.left <= element.left + element.width + horizontalTolerance &&
        candidate.top + candidate.height >= element.top - verticalTolerance &&
        candidate.top <= element.top + element.height + verticalTolerance
      );
    });
    if (nearbyAnswerOverlays.length < placeholderCount) continue;

    const sortedOverlays = nearbyAnswerOverlays
      .slice()
      .sort((left, right) => left.top - right.top || left.left - right.left)
      .slice(0, placeholderCount);
    let overlayIndex = 0;
    paragraphPlaceholderCounts.forEach((linePlaceholderCount, lineIndex) => {
      if (linePlaceholderCount <= 0) return;
      const lineOverlays = sortedOverlays
        .slice(overlayIndex, overlayIndex + linePlaceholderCount)
        .sort((left, right) => left.left - right.left);
      overlayIndex += linePlaceholderCount;
      const lineCenterY =
        element.top +
        (element.textInsets?.top ?? 0) +
        (lineIndex + 0.5) * element.fontSize! * element.lineHeight!;
      for (const [lineOverlayIndex, overlay] of lineOverlays.entries()) {
        const placeholderCenterX = paragraphPlaceholderCenters[lineIndex]?.[lineOverlayIndex];
        const overlayTextCenterOffset = calculateImportedTextCenterOffset(overlay);
        normalizedById.set(overlay.id, {
          ...overlay,
          ...(placeholderCenterX != null
            ? { left: roundCanvasNumber(placeholderCenterX - overlayTextCenterOffset) }
            : {}),
          top: roundCanvasNumber(lineCenterY - overlay.height / 2),
          verticalAlign: 'middle',
          textInsets: {
            ...overlay.textInsets,
            top: 0,
            bottom: 0,
          },
          overflowVisible: true,
        });
      }
    });
  }
  return elements.map((element) => normalizedById.get(element.id) ?? element);
}

interface ImportedParagraphMetric {
  text: string;
  content: string;
  align: string;
  distributeLastLine: boolean;
}

interface ImportedCharacterMetrics {
  characters: string[];
  advances: number[];
}

function extractImportedParagraphMetrics(content?: string): ImportedParagraphMetric[] {
  if (!content) return [];
  const paragraphMatches = Array.from(content.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi));
  const metrics = paragraphMatches.map((match) => {
    const attributes = match[1] ?? '';
    const sourceAlign = attributes.match(/\bdata-pptx-align=["']([^"']+)["']/i)?.[1];
    const cssAlign = attributes.match(/(?:^|;)\s*text-align\s*:\s*([^;"']+)/i)?.[1];
    const textAlignLast = attributes.match(/(?:^|;)\s*text-align-last\s*:\s*([^;"']+)/i)?.[1];
    return {
      text: normalizeImportedMetricText(match[2]),
      content: match[2] ?? '',
      align: (sourceAlign ?? cssAlign ?? 'left').trim().toLowerCase(),
      distributeLastLine:
        sourceAlign?.trim().toLowerCase() === 'distributed' ||
        textAlignLast?.trim().toLowerCase() === 'justify',
    };
  });
  if (metrics.length > 0) return metrics;
  return [
    {
      text: normalizeImportedMetricText(content),
      content,
      align: 'left',
      distributeLastLine: false,
    },
  ];
}

function extractImportedCharacterMetrics(
  content: string,
  fontSize: number,
): ImportedCharacterMetrics {
  const explicitSpaceAdvances: number[] = [];
  const markedContent = content.replace(
    /<span\b([^>]*)\bdata-pptx-authored-space=["']true["']([^>]*)>[\s\S]*?<\/span>/gi,
    (space, beforeAttributes: string, afterAttributes: string) => {
      const attributes = `${beforeAttributes}${afterAttributes}`;
      const attributeAdvance = Number(
        attributes.match(/\bdata-pptx-space-em=["']([\d.]+)["']/i)?.[1],
      );
      const styleAdvance = Number(
        attributes.match(/\bstyle=["'][^"']*\bwidth\s*:\s*([\d.]+)em/i)?.[1],
      );
      const extraSpacing = Number(
        attributes.match(/\bdata-pptx-space-letter-spacing=["']([\d.-]+)px["']/i)?.[1],
      );
      const spaceEm =
        Number.isFinite(attributeAdvance) && attributeAdvance > 0
          ? attributeAdvance
          : Number.isFinite(styleAdvance) && styleAdvance > 0
            ? styleAdvance
            : 0.25;
      explicitSpaceAdvances.push(
        fontSize * spaceEm + (Number.isFinite(extraSpacing) && extraSpacing > 0 ? extraSpacing : 0),
      );
      return '\uE000';
    },
  );
  const rawCharacters = Array.from(normalizeImportedMetricText(markedContent));
  let explicitSpaceIndex = 0;
  const characters = rawCharacters.map((character) => (character === '\uE000' ? ' ' : character));
  const advances = rawCharacters.map((character) => {
    if (character !== '\uE000') return importedCharacterAdvance(character, fontSize);
    const advance = explicitSpaceAdvances[explicitSpaceIndex] ?? fontSize * 0.25;
    explicitSpaceIndex += 1;
    return advance;
  });
  return { characters, advances };
}

function trimImportedCharacterMetrics(metrics: ImportedCharacterMetrics): ImportedCharacterMetrics {
  let start = 0;
  let end = metrics.characters.length;
  while (start < end && /\s/u.test(metrics.characters[start]!)) start += 1;
  while (end > start && /\s/u.test(metrics.characters[end - 1]!)) end -= 1;
  return {
    characters: metrics.characters.slice(start, end),
    advances: metrics.advances.slice(start, end),
  };
}

function calculateImportedPlaceholderCenters(element: SlideElementIR): number[][] {
  const fontSize = Math.max(1, element.fontSize ?? 16);
  const letterSpacing = element.wordSpace ?? 0;
  const insetLeft = element.textInsets?.left ?? 0;
  const insetRight = element.textInsets?.right ?? 0;
  const availableWidth = Math.max(1, element.width - insetLeft - insetRight);

  return extractImportedParagraphMetrics(element.content).map((paragraph) => {
    const { characters, advances } = extractImportedCharacterMetrics(paragraph.content, fontSize);
    const naturalWidth =
      advances.reduce((sum, advance) => sum + advance, 0) +
      Math.max(0, characters.length - 1) * letterSpacing;
    const distributedGap =
      paragraph.distributeLastLine && characters.length > 1
        ? Math.max(0, availableWidth - naturalWidth) / (characters.length - 1)
        : 0;
    const renderedWidth = naturalWidth + distributedGap * Math.max(0, characters.length - 1);
    const alignOffset =
      paragraph.align === 'center'
        ? Math.max(0, (availableWidth - renderedWidth) / 2)
        : paragraph.align === 'right'
          ? Math.max(0, availableWidth - renderedWidth)
          : 0;
    const starts: number[] = [];
    let cursor = alignOffset;
    characters.forEach((character, index) => {
      starts.push(cursor);
      cursor += advances[index] ?? fontSize;
      if (index < characters.length - 1) cursor += letterSpacing + distributedGap;
    });

    const centers: number[] = [];
    for (let index = 0; index < characters.length; index += 1) {
      if (characters[index] !== '(' && characters[index] !== '\uFF08') continue;
      let closingIndex = index + 1;
      while (closingIndex < characters.length && /\s/u.test(characters[closingIndex]!)) {
        closingIndex += 1;
      }
      if (characters[closingIndex] !== ')' && characters[closingIndex] !== '\uFF09') continue;
      const openerEnd = (starts[index] ?? 0) + (advances[index] ?? fontSize);
      const closerStart = starts[closingIndex] ?? openerEnd;
      centers.push(roundCanvasNumber(element.left + insetLeft + (openerEnd + closerStart) / 2));
      index = closingIndex;
    }
    return centers;
  });
}

function calculateImportedTextCenterOffset(element: SlideElementIR): number {
  const paragraph = extractImportedParagraphMetrics(element.content)[0];
  const fontSize = Math.max(1, element.fontSize ?? 16);
  const insetLeft = element.textInsets?.left ?? 0;
  const insetRight = element.textInsets?.right ?? 0;
  const availableWidth = Math.max(1, element.width - insetLeft - insetRight);
  if (!paragraph) return element.width / 2;
  if (
    paragraph.align === 'center' ||
    paragraph.align === 'distributed' ||
    paragraph.align === 'justify'
  ) {
    return insetLeft + availableWidth / 2;
  }

  const { characters, advances } = extractImportedCharacterMetrics(paragraph.content, fontSize);
  const textWidth = Math.min(
    availableWidth,
    advances.reduce((sum, advance) => sum + advance, 0) +
      Math.max(0, characters.length - 1) * (element.wordSpace ?? 0),
  );
  return paragraph.align === 'right'
    ? insetLeft + availableWidth - textWidth / 2
    : insetLeft + textWidth / 2;
}

function normalizeImportedShapeGeometry(elements: SlideElementIR[]): SlideElementIR[] {
  return elements.map((element) => {
    if (element.type !== 'shape' || !element.path || !element.viewBox) return element;

    const normalizedElement = normalizeIntegratedEllipseCalloutTextLayout(element);

    const recoveredIntegratedEllipseCallout = recoverIntegratedEllipseCalloutPath(
      normalizedElement.path!,
      normalizedElement.shapeType,
      normalizedElement.viewBox!,
    );
    if (recoveredIntegratedEllipseCallout) {
      return {
        ...normalizedElement,
        path: recoveredIntegratedEllipseCallout,
      };
    }

    const recoveredCalloutPath =
      recoverIncompleteRoundCalloutPath(
        normalizedElement.path!,
        normalizedElement.shapeType,
        normalizedElement.viewBox!,
      ) ??
      recoverIncompleteEllipseCalloutPath(
        normalizedElement.path!,
        normalizedElement.shapeType,
        normalizedElement.viewBox!,
      );
    if (recoveredCalloutPath) {
      return {
        ...normalizedElement,
        path: recoveredCalloutPath,
      };
    }

    if (normalizedElement.shapeType === 'cloudCallout') {
      const pathBounds = getPathBounds(normalizedElement.path!);
      const subpaths = getClosedSubpathBounds(normalizedElement.path!);
      if (isThoughtBubbleGeometry(pathBounds, subpaths)) {
        const body = subpaths[0]!;
        const bodyWidth = body.maxX - body.minX;
        const bodyHeight = body.maxY - body.minY;
        return {
          ...normalizedElement,
          path: new SVGPathData(normalizedElement.path!)
            .toAbs()
            .translate(-body.minX, -body.minY)
            .encode(),
          viewBox: [roundCanvasNumber(bodyWidth), roundCanvasNumber(bodyHeight)],
        };
      }
    }

    return normalizedElement;
  });
}

const ELLIPSE_INSCRIBED_TEXT_INSET_RATIO = (1 - Math.SQRT1_2) / 2;
const TRAILING_EMPTY_IMPORTED_PARAGRAPHS =
  /(?:\s*<p\b[^>]*>(?:\s|&nbsp;|&#0*160;|&#x0*a0;|<[^>]+>)*<\/p>)+\s*$/giu;

function normalizeIntegratedEllipseCalloutTextLayout(element: SlideElementIR): SlideElementIR {
  if (element.shapeType !== 'wedgeEllipseCallout' || !element.content) return element;

  const horizontalInset = element.width * ELLIPSE_INSCRIBED_TEXT_INSET_RATIO;
  const verticalInset = element.height * ELLIPSE_INSCRIBED_TEXT_INSET_RATIO;
  return {
    ...element,
    content: element.content.replace(TRAILING_EMPTY_IMPORTED_PARAGRAPHS, ''),
    textInsets: {
      left: Math.max(element.textInsets?.left ?? 0, horizontalInset),
      right: Math.max(element.textInsets?.right ?? 0, horizontalInset),
      top: Math.max(element.textInsets?.top ?? 0, verticalInset),
      bottom: Math.max(element.textInsets?.bottom ?? 0, verticalInset),
    },
  };
}

function recoverIntegratedEllipseCalloutPath(
  path: string,
  shapeType: string | undefined,
  viewBox: [number, number],
): string | undefined {
  if (shapeType !== 'wedgeEllipseCallout') return undefined;
  const [width, height] = viewBox;
  if (!(width > 0 && height > 0)) return undefined;

  try {
    const commands = new SVGPathData(path).toAbs().commands;
    const move = commands[0];
    const pointer = commands[1];
    const secondConnection = commands[2];
    if (
      commands.length < 6 ||
      move?.type !== SVGPathData.MOVE_TO ||
      pointer?.type !== SVGPathData.LINE_TO ||
      secondConnection?.type !== SVGPathData.LINE_TO ||
      commands.some(
        (command) =>
          command.type !== SVGPathData.MOVE_TO &&
          command.type !== SVGPathData.LINE_TO &&
          command.type !== SVGPathData.CLOSE_PATH,
      )
    ) {
      return undefined;
    }

    const frame = { minX: 0, minY: 0, maxX: width, maxY: height };
    const pointerOutsideFrame =
      pointer.x < frame.minX - width * 0.05 ||
      pointer.x > frame.maxX + width * 0.05 ||
      pointer.y < frame.minY - height * 0.05 ||
      pointer.y > frame.maxY + height * 0.05;
    const connectionsInsideFrame =
      move.x >= frame.minX &&
      move.x <= frame.maxX &&
      move.y >= frame.minY &&
      move.y <= frame.maxY &&
      secondConnection.x >= frame.minX &&
      secondConnection.x <= frame.maxX &&
      secondConnection.y >= frame.minY &&
      secondConnection.y <= frame.maxY;
    if (!pointerOutsideFrame || !connectionsInsideFrame) return undefined;

    // pptxtojson traces only the short ellipse arc between both pointer
    // connections. Replace that trace with the complementary large arc so the
    // ellipse body and pointer remain one filled contour without a seam.
    return [
      `M ${roundCanvasNumber(move.x)} ${roundCanvasNumber(move.y)}`,
      `L ${roundCanvasNumber(pointer.x)} ${roundCanvasNumber(pointer.y)}`,
      `L ${roundCanvasNumber(secondConnection.x)} ${roundCanvasNumber(secondConnection.y)}`,
      `A ${roundCanvasNumber(width / 2)} ${roundCanvasNumber(height / 2)} 0 1 0 ${roundCanvasNumber(move.x)} ${roundCanvasNumber(move.y)}`,
      'Z',
    ].join(' ');
  } catch {
    return undefined;
  }
}

function recoverIncompleteRoundCalloutPath(
  path: string,
  shapeType: string | undefined,
  viewBox: [number, number],
): string | undefined {
  if (shapeType !== 'wedgeRoundRectCallout') return undefined;
  const [width, height] = viewBox;
  if (!(width > 0 && height > 0)) return undefined;

  const bounds = getPathBounds(path);
  const pathWidth = bounds.maxX - bounds.minX;
  const pathHeight = bounds.maxY - bounds.minY;
  const isBottomTailWithoutBody =
    pathWidth > 0 &&
    pathHeight > 0 &&
    pathWidth <= width * 0.4 &&
    pathHeight <= height * 0.4 &&
    bounds.minX >= width * 0.35 &&
    bounds.minY >= height * 0.55;
  if (!isBottomTailWithoutBody) return undefined;

  const bodyBottom = Math.min(height, Math.max(height * 0.72, bounds.minY));
  const radius = Math.min(width / 2, bodyBottom / 2);
  const tailLeft = Math.max(radius * 0.5, Math.min(bounds.minX, width - radius * 0.5));
  const tailRight = Math.max(tailLeft + width * 0.04, Math.min(bounds.maxX, width - radius * 0.25));
  const tailTip = getLowestPathPoint(path) ?? {
    x: (bounds.minX + bounds.maxX) / 2,
    y: bounds.maxY,
  };

  return [
    `M ${roundCanvasNumber(radius)} 0`,
    `H ${roundCanvasNumber(width - radius)}`,
    `Q ${roundCanvasNumber(width)} 0 ${roundCanvasNumber(width)} ${roundCanvasNumber(radius)}`,
    `V ${roundCanvasNumber(bodyBottom - radius)}`,
    `Q ${roundCanvasNumber(width)} ${roundCanvasNumber(bodyBottom)} ${roundCanvasNumber(width - radius)} ${roundCanvasNumber(bodyBottom)}`,
    `H ${roundCanvasNumber(tailRight)}`,
    `L ${roundCanvasNumber(tailTip.x)} ${roundCanvasNumber(tailTip.y)}`,
    `L ${roundCanvasNumber(tailLeft)} ${roundCanvasNumber(bodyBottom)}`,
    `H ${roundCanvasNumber(radius)}`,
    `Q 0 ${roundCanvasNumber(bodyBottom)} 0 ${roundCanvasNumber(bodyBottom - radius)}`,
    `V ${roundCanvasNumber(radius)}`,
    `Q 0 0 ${roundCanvasNumber(radius)} 0`,
    'Z',
  ].join(' ');
}

function recoverIncompleteEllipseCalloutPath(
  path: string,
  shapeType: string | undefined,
  viewBox: [number, number],
): string | undefined {
  if (shapeType !== 'wedgeEllipseCallout') return undefined;
  const [width, height] = viewBox;
  if (!(width > 0 && height > 0)) return undefined;

  const bounds = getPathBounds(path);
  const pathWidth = bounds.maxX - bounds.minX;
  const pathHeight = bounds.maxY - bounds.minY;
  const isTailOnly =
    pathWidth > 0 &&
    pathHeight > 0 &&
    pathWidth <= width * 0.4 &&
    pathHeight <= height * 0.4 &&
    bounds.minX >= width * 0.45 &&
    bounds.minY >= height * 0.55;
  if (!isTailOnly) return undefined;

  // pptxtojson sometimes emits only the three-point pointer for an ellipse
  // callout. Recreate the nominal ellipse in the authored viewBox and retain
  // the original pointer tip, which may intentionally overflow the viewBox.
  const centerY = height / 2;
  const radiusX = width / 2;
  const radiusY = height / 2;
  const tailTip = getLowestPathPoint(path) ?? {
    x: (bounds.minX + bounds.maxX) / 2,
    y: bounds.maxY,
  };
  const tailLeft = Math.max(width * 0.5, Math.min(bounds.minX, width * 0.82));
  const tailRight = Math.max(tailLeft + width * 0.04, Math.min(bounds.maxX, width * 0.92));
  const tailBaseY = Math.min(height, Math.max(height * 0.72, bounds.minY));

  return [
    `M 0 ${roundCanvasNumber(centerY)}`,
    `A ${roundCanvasNumber(radiusX)} ${roundCanvasNumber(radiusY)} 0 1 1 ${roundCanvasNumber(width)} ${roundCanvasNumber(centerY)}`,
    `A ${roundCanvasNumber(radiusX)} ${roundCanvasNumber(radiusY)} 0 1 1 0 ${roundCanvasNumber(centerY)}`,
    'Z',
    `M ${roundCanvasNumber(tailLeft)} ${roundCanvasNumber(tailBaseY)}`,
    `L ${roundCanvasNumber(tailTip.x)} ${roundCanvasNumber(tailTip.y)}`,
    `L ${roundCanvasNumber(tailRight)} ${roundCanvasNumber(tailBaseY)}`,
    'Z',
  ].join(' ');
}

function getLowestPathPoint(path: string): { x: number; y: number } | undefined {
  try {
    let lowest: { x: number; y: number } | undefined;
    for (const command of new SVGPathData(path).toAbs().commands) {
      const x = 'x' in command ? command.x : undefined;
      const y = 'y' in command ? command.y : undefined;
      if (
        typeof x === 'number' &&
        Number.isFinite(x) &&
        typeof y === 'number' &&
        Number.isFinite(y) &&
        (!lowest || y > lowest.y)
      ) {
        lowest = { x, y };
      }
    }
    return lowest;
  } catch {
    return undefined;
  }
}

function getClosedSubpathBounds(
  path: string,
): Array<{ minX: number; minY: number; maxX: number; maxY: number }> {
  try {
    const commands = new SVGPathData(path).toAbs().commands;
    const results: Array<{ minX: number; minY: number; maxX: number; maxY: number }> = [];
    let current: typeof commands = [];
    for (const command of commands) {
      if (command.type === SVGPathData.MOVE_TO && current.length > 0) current = [];
      current.push(command);
      if (command.type !== SVGPathData.CLOSE_PATH) continue;
      results.push(getPathBounds(new SVGPathData(current).encode()));
      current = [];
    }
    return results;
  } catch {
    return [];
  }
}

function isThoughtBubbleGeometry(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  subpaths: Array<{ minX: number; minY: number; maxX: number; maxY: number }>,
): boolean {
  if (subpaths.length !== 4) return false;
  const [body, ...dots] = subpaths;
  const bodyWidth = body!.maxX - body!.minX;
  const bodyHeight = body!.maxY - body!.minY;
  const totalWidth = bounds.maxX - bounds.minX;
  if (!(bodyWidth > 0 && bodyHeight > 0 && totalWidth > 0)) return false;
  return (
    bodyWidth >= totalWidth * 0.8 &&
    dots.every((dot) => {
      const dotWidth = dot.maxX - dot.minX;
      const dotHeight = dot.maxY - dot.minY;
      return (
        dotWidth > 0 &&
        dotHeight > 0 &&
        dotWidth <= bodyWidth * 0.2 &&
        dotHeight <= bodyHeight * 0.2 &&
        dot.maxY > body!.maxY
      );
    })
  );
}

function extractImportedParagraphTexts(content?: string): string[] {
  if (!content) return [];
  const paragraphs = Array.from(content.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi), (match) =>
    normalizeImportedMetricText(match[1]),
  );
  return paragraphs.length > 0 ? paragraphs : [normalizeImportedMetricText(content)];
}

function countEmptyParenthesisPlaceholdersInText(content: string): number {
  const text = decodeXmlText(content).replace(/(?:&nbsp;|&#160;|&#xA0;|\u00a0)/gi, ' ');
  return (text.match(/[（(][\s\u00a0]*[）)]/gu) ?? []).length;
}

function isAccentOverlayColor(color: string): boolean {
  const normalized = color.replace(/^#/, '');
  if (!/^[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(normalized)) return false;
  const [red, green, blue] = [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];
  return (
    Math.max(red, green, blue) >= 144 &&
    Math.max(red, green, blue) - Math.min(red, green, blue) >= 72
  );
}

interface ImportedPinyinAnchor {
  syllable: string;
  centerX: number;
  targetSourceShapeId?: string;
  host: Pick<
    SlideElementIR,
    'left' | 'top' | 'width' | 'height' | 'fontSize' | 'lineHeight' | 'textInsets' | 'verticalAlign'
  >;
}

function normalizeImportedPronunciationLayout(elements: SlideElementIR[]): SlideElementIR[] {
  const anchors: ImportedPinyinAnchor[] = [];
  const anchoredElements = elements.map((element) => {
    const syllables = extractImportedPinyinSyllables(element.content);
    if (syllables.length < 2 || !element.content) return element;

    const target = findImportedPinyinTarget(element, syllables.length, elements);
    if (!target) return element;
    const hanCenters = calculateImportedHanGlyphCenters(target);
    if (hanCenters.length !== syllables.length) return element;

    syllables.forEach((syllable, index) => {
      const centerX = hanCenters[index];
      if (centerX == null) return;
      anchors.push({
        syllable: normalizeImportedPinyinToken(syllable),
        centerX,
        targetSourceShapeId: target.sourceShapeId,
        host: {
          left: element.left,
          top: element.top,
          width: element.width,
          height: element.height,
          fontSize: element.fontSize,
          lineHeight: element.lineHeight,
          textInsets: element.textInsets,
          verticalAlign: element.verticalAlign,
        },
      });
    });
    return {
      ...element,
      content: buildImportedAnchoredPinyinContent(
        element.content,
        syllables,
        hanCenters,
        element,
        target.sourceShapeId,
      ),
      overflowVisible: true,
    };
  });

  if (anchors.length === 0) return anchoredElements;
  return anchoredElements.map((element) => {
    const syllables = extractImportedPinyinSyllables(element.content);
    if (
      syllables.length !== 1 ||
      !element.content ||
      !element.defaultColor ||
      !isAccentOverlayColor(element.defaultColor) ||
      /data-pptx-pinyin-anchored=/i.test(element.content)
    ) {
      return element;
    }

    const normalizedSyllable = normalizeImportedPinyinToken(syllables[0]!);
    const matchingAnchors = anchors.filter((anchor) => anchor.syllable === normalizedSyllable);
    if (matchingAnchors.length === 0) return element;
    const elementCenterX = element.left + element.width / 2;
    const anchor = matchingAnchors.reduce((best, candidate) =>
      Math.abs(candidate.centerX - elementCenterX) < Math.abs(best.centerX - elementCenterX)
        ? candidate
        : best,
    );
    if (Math.abs(anchor.centerX - elementCenterX) > Math.max(160, element.width * 3))
      return element;

    const anchoredOverlay = {
      ...element,
      ...anchor.host,
      textInsets: anchor.host.textInsets ? { ...anchor.host.textInsets } : element.textInsets,
    };
    return {
      ...anchoredOverlay,
      content: buildImportedAnchoredPinyinContent(
        anchoredOverlay.content!,
        syllables,
        [anchor.centerX],
        anchoredOverlay,
        anchor.targetSourceShapeId,
      ),
      overflowVisible: true,
    };
  });
}

function extractImportedPinyinSyllables(content?: string): string[] {
  if (!content || /data-pptx-pinyin-anchored=/i.test(content)) return [];
  const text = normalizeImportedMetricText(content).trim();
  if (!text || /[\u3400-\u9fff\uf900-\ufaff]/u.test(text)) return [];
  const syllables = text.split(/\s+/u).filter(Boolean);
  if (
    syllables.length === 0 ||
    !syllables.every((token) => /^[\p{Script=Latin}\p{Mark}'’]+$/u.test(token)) ||
    !/[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜüɡ]/iu.test(text)
  ) {
    return [];
  }
  return syllables;
}

function normalizeImportedPinyinToken(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('zh-CN').replace(/g/gu, 'ɡ');
}

function findImportedPinyinTarget(
  pinyin: SlideElementIR,
  expectedGlyphCount: number,
  elements: SlideElementIR[],
): SlideElementIR | undefined {
  const pinyinRight = pinyin.left + pinyin.width;
  const pinyinBottom = pinyin.top + pinyin.height;
  const pinyinCenterX = pinyin.left + pinyin.width / 2;
  return elements
    .filter((candidate) => {
      if (candidate === pinyin || !candidate.content) return false;
      const hanCount = Array.from(normalizeImportedMetricText(candidate.content)).filter((char) =>
        /[\u3400-\u9fff\uf900-\ufaff]/u.test(char),
      ).length;
      if (hanCount !== expectedGlyphCount) return false;
      const verticalGap = candidate.top - pinyinBottom;
      if (verticalGap < -18 || verticalGap > 140) return false;
      const overlap = Math.max(
        0,
        Math.min(pinyinRight, candidate.left + candidate.width) -
          Math.max(pinyin.left, candidate.left),
      );
      return overlap >= Math.min(pinyin.width, candidate.width) * 0.2;
    })
    .map((candidate) => ({
      candidate,
      score:
        Math.abs(candidate.top - pinyinBottom) +
        Math.abs(candidate.left + candidate.width / 2 - pinyinCenterX) * 0.08,
    }))
    .sort((left, right) => left.score - right.score)[0]?.candidate;
}

function calculateImportedHanGlyphCenters(element: SlideElementIR): number[] {
  const fontSize = Math.max(1, element.fontSize ?? 16);
  const letterSpacing = element.wordSpace ?? 0;
  const insetLeft = element.textInsets?.left ?? 0;
  const insetRight = element.textInsets?.right ?? 0;
  const availableWidth = Math.max(1, element.width - insetLeft - insetRight);
  const paragraph = extractImportedParagraphMetrics(element.content)[0];
  const { characters, advances } = trimImportedCharacterMetrics(
    extractImportedCharacterMetrics(paragraph?.content ?? element.content ?? '', fontSize),
  );
  const naturalWidth =
    advances.reduce((sum, advance) => sum + advance, 0) +
    Math.max(0, characters.length - 1) * letterSpacing;
  const paragraphAlign = paragraph?.align ?? 'left';
  const distributedGap =
    paragraph?.distributeLastLine && characters.length > 1
      ? Math.max(0, availableWidth - naturalWidth) / (characters.length - 1)
      : 0;
  const renderedWidth = naturalWidth + distributedGap * Math.max(0, characters.length - 1);
  let cursor =
    paragraphAlign === 'center'
      ? Math.max(0, (availableWidth - renderedWidth) / 2)
      : paragraphAlign === 'right'
        ? Math.max(0, availableWidth - renderedWidth)
        : 0;
  const centers: number[] = [];

  characters.forEach((char, index) => {
    const advance = advances[index] ?? fontSize;
    if (/[\u3400-\u9fff\uf900-\ufaff]/u.test(char)) {
      centers.push(roundCanvasNumber(element.left + insetLeft + cursor + advance / 2));
    }
    cursor += advance;
    if (index < characters.length - 1) cursor += letterSpacing + distributedGap;
  });
  return centers;
}

function importedCharacterAdvance(character: string, fontSize: number): number {
  if (/\s/u.test(character)) return fontSize * 0.25;
  if (/[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff01-\uff60]/u.test(character)) return fontSize;
  return fontSize * 0.55;
}

function calculateImportedSubstringOffset(
  host: SlideElementIR,
  overlayText: string,
): number | undefined {
  const fontSize = Math.max(1, host.fontSize ?? 16);
  const letterSpacing = host.wordSpace ?? 0;
  const insetLeft = host.textInsets?.left ?? 0;
  const insetRight = host.textInsets?.right ?? 0;
  const availableWidth = Math.max(1, host.width - insetLeft - insetRight);

  for (const paragraph of extractImportedParagraphMetrics(host.content)) {
    const { characters, advances } = extractImportedCharacterMetrics(paragraph.content, fontSize);
    const characterText = characters.join('');
    const matchIndex = characterText.indexOf(overlayText);
    if (matchIndex < 0) continue;

    const naturalWidth =
      advances.reduce((sum, advance) => sum + advance, 0) +
      Math.max(0, characters.length - 1) * letterSpacing;
    const distributedGap =
      paragraph.distributeLastLine && characters.length > 1
        ? Math.max(0, availableWidth - naturalWidth) / (characters.length - 1)
        : 0;
    const renderedWidth = naturalWidth + distributedGap * Math.max(0, characters.length - 1);
    const alignOffset =
      paragraph.align === 'center'
        ? Math.max(0, (availableWidth - renderedWidth) / 2)
        : paragraph.align === 'right'
          ? Math.max(0, availableWidth - renderedWidth)
          : 0;
    const prefixAdvance = advances.slice(0, matchIndex).reduce((sum, advance) => sum + advance, 0);
    const prefixGaps = matchIndex * (letterSpacing + distributedGap);
    return roundCanvasNumber(alignOffset + prefixAdvance + prefixGaps);
  }

  return undefined;
}

function normalizeImportedAnimatedTextOverlays(
  elements: SlideElementIR[],
  animation: SlidePageIR['pptxAnimation'],
): SlideElementIR[] {
  const entranceShapeIds = new Set(
    animation?.steps
      .flatMap((step) => step.items)
      .filter((item) => item.animationType === 'in' && item.target?.shapeId)
      .map((item) => item.target!.shapeId) ?? [],
  );
  if (entranceShapeIds.size === 0) return elements;

  return elements.map((element) => {
    if (
      !element.content ||
      /data-pptx-(?:pinyin|overlay)-anchored=/i.test(element.content) ||
      ![element.sourceShapeId, ...(element.sourceGroupShapeIds ?? [])].some((shapeId) =>
        shapeId ? entranceShapeIds.has(shapeId) : false,
      )
    ) {
      return element;
    }
    const overlayText = normalizeImportedMetricText(element.content).trim();
    if (!overlayText || overlayText.length > 24) return element;
    const overlayColor = normalizeCssColor(element.defaultColor);
    const host = elements
      .filter((candidate) => {
        if (candidate === element || !candidate.content) return false;
        if (
          [candidate.sourceShapeId, ...(candidate.sourceGroupShapeIds ?? [])].some((shapeId) =>
            shapeId ? entranceShapeIds.has(shapeId) : false,
          )
        ) {
          return false;
        }
        const candidateText = normalizeImportedMetricText(candidate.content).trim();
        if (!candidateText.includes(overlayText) || candidateText.length < overlayText.length) {
          return false;
        }
        if (
          element.fontSize &&
          candidate.fontSize &&
          Math.abs(candidate.fontSize - element.fontSize) > element.fontSize * 0.15
        ) {
          return false;
        }
        const verticalOverlap =
          Math.min(element.top + element.height, candidate.top + candidate.height) -
          Math.max(element.top, candidate.top);
        if (verticalOverlap < Math.min(element.height, candidate.height) * 0.55) return false;
        const candidateColor = normalizeCssColor(candidate.defaultColor);
        return candidateText.length > overlayText.length || candidateColor !== overlayColor;
      })
      .map((candidate) => ({
        candidate,
        score:
          Math.abs(candidate.top - element.top) +
          Math.abs(candidate.left - element.left) * 0.02 +
          Math.abs((candidate.fontSize ?? 0) - (element.fontSize ?? 0)),
      }))
      .sort((left, right) => left.score - right.score)[0]?.candidate;
    if (!host) return element;

    const anchoredContent = buildImportedAnchoredOverlayContent(element, host);
    if (!anchoredContent) return element;
    return {
      ...element,
      left: host.left,
      top: host.top,
      width: host.width,
      height: host.height,
      verticalAlign: host.verticalAlign,
      textInsets: host.textInsets ? { ...host.textInsets } : element.textInsets,
      content: anchoredContent,
      overflowVisible: true,
    };
  });
}

function buildImportedAnchoredOverlayContent(
  overlay: SlideElementIR,
  host: SlideElementIR,
): string | undefined {
  if (!overlay.content) return undefined;
  const paragraphMatch = overlay.content.match(/<p\b([^>]*)>[\s\S]*?<\/p>/i);
  if (!paragraphMatch) return undefined;
  const spanMatch = overlay.content.match(
    /<span\b[^>]*\bstyle=["']([^"']*)["'][^>]*>([\s\S]*?)<\/span>/i,
  );
  if (!spanMatch) return undefined;
  const hostContentLeft = host.left + (host.textInsets?.left ?? 0);
  const overlayContentLeft = overlay.left + (overlay.textInsets?.left ?? 0);
  const geometryRelativeLeft = roundCanvasNumber(overlayContentLeft - hostContentLeft);
  const overlayText = normalizeImportedMetricText(overlay.content).trim();
  const substringRelativeLeft = calculateImportedSubstringOffset(host, overlayText);
  const sharedSourceFrame =
    Math.abs(overlay.left - host.left) <= Math.max(2, host.width * 0.015) &&
    Math.abs(overlay.width - host.width) <= Math.max(4, host.width * 0.03);
  const useSubstringPosition =
    substringRelativeLeft != null &&
    overlayText.length < normalizeImportedMetricText(host.content).trim().length &&
    sharedSourceFrame;
  const relativeLeft = useSubstringPosition ? substringRelativeLeft : geometryRelativeLeft;
  const hostContentTop = host.top + (host.textInsets?.top ?? 0);
  const overlayContentTop = overlay.top + (overlay.textInsets?.top ?? 0);
  const relativeTop = roundCanvasNumber(overlayContentTop - hostContentTop);
  const paragraphStyle = parseInlineStyle(
    paragraphMatch[1]?.match(/\sstyle=["']([^"']*)["']/i)?.[1] ?? '',
  );
  paragraphStyle.position = 'relative';
  paragraphStyle['white-space'] = 'nowrap';
  const spanStyle = parseInlineStyle(spanMatch[1] ?? '');
  spanStyle.position = 'absolute';
  spanStyle.left = `${relativeLeft}px`;
  if (Math.abs(relativeTop) > 0.25) spanStyle.top = `${relativeTop}px`;
  spanStyle['white-space'] = 'nowrap';
  return `<p data-pptx-overlay-anchored="true" data-pptx-overlay-position-source="${useSubstringPosition ? 'text' : 'geometry'}" style="${serializeInlineStyle(paragraphStyle)}"><span data-pptx-overlay-left="${relativeLeft}" data-pptx-overlay-top="${relativeTop}" style="${serializeInlineStyle(spanStyle)}">${spanMatch[2] ?? ''}</span></p>`;
}

function normalizeImportedMetricText(content?: string): string {
  if (!content) return '';
  return decodeXmlText(
    content
      .replace(/<span\b[^>]*\bdata-pptx-authored-space=["']true["'][^>]*>[\s\S]*?<\/span>/gi, ' ')
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/(?:&nbsp;|&#160;|&#xA0;|\u00a0)/gi, ' '),
  );
}

function buildImportedAnchoredPinyinContent(
  content: string,
  syllables: string[],
  slideCenters: number[],
  element: SlideElementIR,
  targetSourceShapeId?: string,
): string {
  const paragraphMatch = content.match(/<p\b([^>]*)>[\s\S]*?<\/p>/i);
  const spanStyle = content.match(/<span\b[^>]*\bstyle=["']([^"']*)["']/i)?.[1] ?? '';
  if (!paragraphMatch) return content;
  let attrs = paragraphMatch[1] ?? '';
  attrs = attrs.replace(/\sdata-pptx-pinyin-(?:anchored|target-source-id)=["'][^"']*["']/gi, '');
  attrs += ' data-pptx-pinyin-anchored="true"';
  if (targetSourceShapeId) {
    attrs += ` data-pptx-pinyin-target-source-id="${escapeXml(targetSourceShapeId)}"`;
  }
  const paragraphStyleMatch = attrs.match(/\sstyle=["']([^"']*)["']/i);
  const paragraphStyle = parseInlineStyle(paragraphStyleMatch?.[1] ?? '');
  paragraphStyle.position = 'relative';
  paragraphStyle['white-space'] = 'nowrap';
  const nextParagraphStyle = `style="${serializeInlineStyle(paragraphStyle)}"`;
  attrs = paragraphStyleMatch
    ? attrs.replace(paragraphStyleMatch[0], ` ${nextParagraphStyle}`)
    : `${attrs} ${nextParagraphStyle}`;

  const contentLeft = element.left + (element.textInsets?.left ?? 0);
  const anchoredSyllables = syllables
    .map((syllable, index) => {
      const relativeLeft = roundCanvasNumber((slideCenters[index] ?? contentLeft) - contentLeft);
      const style = parseInlineStyle(spanStyle);
      style.position = 'absolute';
      style.left = `${relativeLeft}px`;
      style.transform = 'translateX(-50%)';
      style['white-space'] = 'nowrap';
      return `<span data-pptx-pinyin-syllable="${index}" data-pptx-anchor-left="${relativeLeft}" style="${serializeInlineStyle(style)}">${escapeXml(syllable)}</span>`;
    })
    .join('');
  return `<p${attrs}>${anchoredSyllables}</p>`;
}

function applyMotionEntranceFinalPositions(
  elements: SlideElementIR[],
  animation: SlidePageIR['pptxAnimation'],
  pageWidth: number,
  pageHeight: number,
): SlideElementIR[] {
  const motionItemByShapeId = new Map<string, PptAnimationItemIR>();
  for (const item of animation?.steps.flatMap((step) => step.items) ?? []) {
    if (
      item.animationType === 'in' &&
      item.motion &&
      item.target &&
      !item.target.paragraphIndexes?.length &&
      !item.target.characterRange &&
      !motionItemByShapeId.has(item.target.shapeId)
    ) {
      motionItemByShapeId.set(item.target.shapeId, item);
    }
  }
  if (motionItemByShapeId.size === 0) return elements;
  return elements.map((element) => {
    const motionItem = [...motionItemByShapeId].find(
      ([shapeId]) =>
        element.sourceShapeId === shapeId || element.sourceGroupShapeIds?.includes(shapeId),
    )?.[1];
    const motion = motionItem?.motion;
    if (!motionItem || !motion) return element;
    const xScale = motion.xScaleBasis === 'height' ? pageHeight : pageWidth;
    return {
      ...element,
      left: roundCanvasNumber(element.left + (motion.toX - motion.fromX) * xScale),
      top: roundCanvasNumber(element.top + (motion.toY - motion.fromY) * pageHeight),
    };
  });
}

function applyPptxThemeFonts(
  elements: SlideElementIR[],
  themeFonts?: PptxThemeFonts,
): SlideElementIR[] {
  return elements.map((element) => {
    const rawEastAsianFont = themeFonts?.['+mn-ea'] ?? themeFonts?.['+mj-ea'];
    const contentText = normalizeElementPlainText(element.content);
    const eastAsianFont = themeFonts
      ? (resolvePptxThemeFont('+mn-ea', themeFonts) ?? resolvePptxThemeFont('+mj-ea', themeFonts))
      : undefined;
    const shouldUseEastAsianFont = Boolean(
      eastAsianFont &&
      containsCjkText(contentText) &&
      isGenericLatinFontFamily(element.defaultFontName),
    );
    const defaultFontName = themeFonts
      ? shouldUseEastAsianFont
        ? eastAsianFont
        : resolvePptxThemeFont(element.defaultFontName, themeFonts)
      : element.defaultFontName;
    const contentWithSourceMetrics = annotateImportedResolvedSpaceMetrics(
      element.content,
      themeFonts,
      rawEastAsianFont,
    );
    const content = contentWithSourceMetrics?.replace(
      /(font-family\s*:\s*)([^;\"]+)/gi,
      (match, prefix: string, rawValue: string) => {
        if (!themeFonts) return match;
        const resolved = resolvePptxThemeFont(stripCssQuotes(rawValue.trim()), themeFonts);
        return shouldUseEastAsianFont && eastAsianFont && isGenericLatinFontFamily(rawValue)
          ? `${prefix}${eastAsianFont}`
          : resolved
            ? `${prefix}${resolved}`
            : match;
      },
    );
    return content !== element.content || defaultFontName !== element.defaultFontName
      ? {
          ...element,
          ...(content ? { content } : {}),
          ...(defaultFontName ? { defaultFontName } : {}),
        }
      : element;
  });
}

function annotateImportedResolvedSpaceMetrics(
  content: string | undefined,
  themeFonts?: PptxThemeFonts,
  rawEastAsianFont?: string,
): string | undefined {
  if (!content || !/(?:&nbsp;|&#160;|&#xA0;|\u00a0)/i.test(content)) return content;
  const hasCjkText = containsCjkText(normalizeElementPlainText(content));
  const mappedEastAsianFont = resolveImportedCssFontFamily(rawEastAsianFont);

  return content.replace(/<span\b([^>]*)>/gi, (tag, rawAttributes: string) => {
    const style = parseInlineStyle(rawAttributes.match(/\bstyle=["']([^"']*)["']/i)?.[1] ?? '');
    const renderedFont = stripCssQuotes(style['font-family'] ?? '');
    const existingSourceFont = decodeXmlText(
      rawAttributes.match(/\bdata-pptx-source-font=["']([^"']+)["']/i)?.[1] ?? '',
    );
    const themeSourceFont = themeFonts?.[renderedFont.trim().toLowerCase() as PptxThemeFontToken];
    const renderedUsesThemeEastAsianFont = Boolean(
      rawEastAsianFont &&
      hasCjkText &&
      (isGenericLatinFontFamily(renderedFont) ||
        (mappedEastAsianFont &&
          mappedEastAsianFont.trim().toLowerCase() === renderedFont.trim().toLowerCase())),
    );
    const sourceFont =
      themeSourceFont ||
      (renderedUsesThemeEastAsianFont ? rawEastAsianFont : undefined) ||
      existingSourceFont ||
      renderedFont;
    if (!sourceFont) return tag;

    let attributes = upsertImportedDataAttribute(
      rawAttributes,
      'data-pptx-source-font',
      sourceFont,
    );
    attributes = upsertImportedDataAttribute(
      attributes,
      'data-pptx-space-em',
      String(measureImportedSourceSpaceAdvance(sourceFont, style['font-weight'])),
    );
    return `<span${attributes}>`;
  });
}

function upsertImportedDataAttribute(
  rawAttributes: string,
  attributeName: string,
  value: string,
): string {
  const pattern = new RegExp(`\\b${attributeName}=["'][^"']*["']`, 'i');
  const attribute = `${attributeName}="${escapeXml(value)}"`;
  return pattern.test(rawAttributes)
    ? rawAttributes.replace(pattern, attribute)
    : `${rawAttributes} ${attribute}`;
}

function isGenericLatinFontFamily(fontFace: string | undefined): boolean {
  if (!fontFace) return true;
  const normalized = stripCssQuotes(fontFace.trim().split(',')[0] ?? '').toLowerCase();
  return /^(?:aptos|arial|calibri|cambria|courier new|georgia|helvetica|times new roman|verdana)$/.test(
    normalized,
  );
}

function resolvePptxThemeFont(
  fontFace: string | undefined,
  themeFonts: PptxThemeFonts,
): string | undefined {
  if (!fontFace) return undefined;
  const resolved = themeFonts[fontFace.trim().toLowerCase() as PptxThemeFontToken];
  return resolveImportedCssFontFamily(resolved ?? fontFace);
}

function mergeSupplementBackground(
  parserBackground: SlidePageIR['background'],
  supplementBackground: SlidePageIR['background'],
): SlidePageIR['background'] {
  if (!parserBackground) return supplementBackground;
  if (!supplementBackground) return parserBackground;
  if (
    supplementBackground.type === 'image' &&
    typeof supplementBackground.src === 'string' &&
    !isSlimPlaceholderDataUrl(supplementBackground.src) &&
    (parserBackground.type !== 'image' ||
      typeof parserBackground.src !== 'string' ||
      isSlimPlaceholderDataUrl(parserBackground.src))
  ) {
    return supplementBackground;
  }
  return parserBackground;
}

function mergeSupplementElements(
  elements: SlideElementIR[],
  fallbackElements: SlideElementIR[],
  metadataByElementId: ReadonlyMap<string, PptxSlideElementMetadata> = new Map(),
): SlideElementIR[] {
  const sourceMergedElements = [...elements];
  const remainingFallbackElements: SlideElementIR[] = [];
  const sourceMatchedElementIds = new Set<string>();
  const fallbackOrderBySourceId = new Map<string, number>();
  fallbackElements.forEach((fallback, index) => {
    const sourceId = fallbackSourceOrderId(fallback);
    if (sourceId && !fallbackOrderBySourceId.has(sourceId)) {
      fallbackOrderBySourceId.set(sourceId, index);
    }
  });

  for (const fallback of fallbackElements) {
    if (fallback.type === 'line' && fallback.sourceShapeId) {
      const parserLineIndex = sourceMergedElements.findIndex(
        (element) => element.type === 'line' && element.sourceShapeId === fallback.sourceShapeId,
      );
      if (parserLineIndex >= 0) {
        const parserLine = sourceMergedElements[parserLineIndex]!;
        sourceMergedElements[parserLineIndex] = {
          ...parserLine,
          left: fallback.left,
          top: fallback.top,
          width: fallback.width,
          height: fallback.height,
          ...(fallback.lineEnd ? { lineEnd: fallback.lineEnd } : {}),
          ...(fallback.borderColor ? { borderColor: fallback.borderColor } : {}),
          ...(fallback.borderWidth != null ? { borderWidth: fallback.borderWidth } : {}),
          ...(fallback.borderType ? { borderType: fallback.borderType } : {}),
          ...(fallback.points ? { points: fallback.points } : {}),
        };
        continue;
      }
    }
    // A parsed bent connector already carries its authored multi-segment path.
    // Merge OOXML endpoint styles onto it instead of adding a duplicate line.
    if (
      fallback.sourceShapeId &&
      (fallback.type === 'line' || isBentConnectorPathShape(fallback.shapeType))
    ) {
      const parserConnectorIndex = sourceMergedElements.findIndex(
        (element) =>
          element.sourceShapeId === fallback.sourceShapeId &&
          element.type === 'shape' &&
          isBentConnectorPathShape(element.shapeType),
      );
      if (parserConnectorIndex >= 0) {
        const parserConnector = sourceMergedElements[parserConnectorIndex]!;
        sourceMergedElements[parserConnectorIndex] = {
          ...parserConnector,
          ...(fallback.borderColor ? { borderColor: fallback.borderColor } : {}),
          ...(fallback.borderWidth != null ? { borderWidth: fallback.borderWidth } : {}),
          ...(fallback.borderType ? { borderType: fallback.borderType } : {}),
          ...(fallback.points ? { points: fallback.points } : {}),
        };
        continue;
      }
    }
    if (isFallbackLayoutSupplement(fallback)) {
      remainingFallbackElements.push(fallback);
      continue;
    }
    const sourceElementId = extractFallbackSourceElementId(fallback);
    const sourceMatchIndex = sourceElementId
      ? sourceMergedElements.findIndex((element) => {
          const metadata = metadataByElementId.get(element.id);
          return isSourceElementMatch(element, fallback, metadata, sourceElementId);
        })
      : -1;
    if (sourceMatchIndex < 0) {
      remainingFallbackElements.push(fallback);
      continue;
    }

    const parserElement = sourceMergedElements[sourceMatchIndex]!;
    sourceMergedElements[sourceMatchIndex] = mergeSourceMatchedElement(
      parserElement,
      fallback,
      metadataByElementId.get(parserElement.id),
    );
    sourceMatchedElementIds.add(parserElement.id);
  }

  const parserElements = pruneCollapsedParserElementsWithFallbackText(
    sourceMergedElements,
    remainingFallbackElements,
    sourceMatchedElementIds,
  );
  if (remainingFallbackElements.length <= 0) {
    const reordered = parserElements.filter(hasResolvedMediaSource);
    pruneSlimParserPlaceholderImages(reordered);
    reorderParserPanelBackgroundsBehindText(reordered);
    reorderLateParserBannerImagesBehindText(reordered);
    reorderFallbackImagesBehindText(reordered);
    return normalizeImportedTextFlipTransforms(reordered);
  }

  const merged = [...parserElements];
  for (const fallback of remainingFallbackElements) {
    if (isFallbackLayoutSupplement(fallback)) {
      merged.splice(findSupplementInsertIndex(merged, fallback), 0, fallback);
      continue;
    }
    const mediaHydrationIndex = merged.findIndex((element) =>
      shouldHydrateSupplementMediaElement(element, fallback),
    );
    if (mediaHydrationIndex >= 0) {
      merged[mediaHydrationIndex] = mergeSupplementMediaElement(
        merged[mediaHydrationIndex],
        fallback,
      );
      continue;
    }

    const lineHydrationIndex =
      fallback.type === 'line' && fallback.points
        ? merged.findIndex(
            (element) =>
              element.type === 'line' &&
              Math.abs(element.left - fallback.left) < 1 &&
              Math.abs(element.top - fallback.top) < 1 &&
              Math.abs(element.width - fallback.width) < 1 &&
              Math.abs(element.height - fallback.height) < 1,
          )
        : -1;
    if (lineHydrationIndex >= 0) {
      merged[lineHydrationIndex] = {
        ...merged[lineHydrationIndex],
        points: fallback.points,
      };
      continue;
    }

    const replacementIndex = merged.findIndex(
      (element) =>
        shouldReplaceSlimParserImage(element, fallback) ||
        shouldReplaceParserPosterImage(element, fallback) ||
        shouldReplaceParserImageWithSourceEffect(element, fallback) ||
        shouldReplaceBadParserElement(element, fallback) ||
        shouldReplaceDistortedParserImage(element, fallback) ||
        shouldReplaceDistortedParserShape(element, fallback) ||
        shouldReplaceSlimParserShapePattern(element, fallback) ||
        shouldReplacePlainShapeWithPatternShape(element, fallback),
    );
    if (replacementIndex >= 0) {
      merged.splice(replacementIndex, 1, fallback);
      removeAdditionalDistortedParserShapeDuplicates(merged, fallback, replacementIndex + 1);
      continue;
    }

    const fallbackText = normalizeElementPlainText(fallback.content);
    const shouldHydrateFont = Boolean(fallback.defaultFontName && containsCjkText(fallbackText));
    const shouldHydrateLineBreaks = Boolean(fallback.hardLineBreaks?.length);
    const textHydrationIndex =
      shouldHydrateFont || shouldHydrateLineBreaks
        ? merged.findIndex((element) => {
            const elementText = normalizeElementPlainText(element.content);
            return (
              isDuplicateTextContent(elementText, fallbackText) &&
              calculateRectOverlapRatio(element, fallback) > 0.35
            );
          })
        : -1;
    if (textHydrationIndex >= 0) {
      const parserElement = merged[textHydrationIndex];
      const contentWithLineBreaks = shouldHydrateLineBreaks
        ? applyFallbackHardLineBreaks(parserElement.content, fallback.hardLineBreaks)
        : parserElement.content;
      merged[textHydrationIndex] = {
        ...parserElement,
        ...(shouldHydrateFont
          ? {
              defaultFontName:
                resolveImportedCssFontFamily(fallback.defaultFontName) ?? fallback.defaultFontName,
            }
          : {}),
        content:
          shouldHydrateFont && fallback.defaultFontName
            ? applyCjkFontFamily(
                contentWithLineBreaks,
                resolveImportedCssFontFamily(fallback.defaultFontName) ?? fallback.defaultFontName,
              )
            : contentWithLineBreaks,
      };
      continue;
    }

    if (merged.some((element) => isDuplicateSupplementElement(element, fallback))) {
      continue;
    }
    const insertIndex = isChartFallbackSupplement(fallback)
      ? findChartSupplementInsertIndex(merged, fallback, fallbackOrderBySourceId)
      : findSupplementInsertIndex(merged, fallback);
    merged.splice(insertIndex, 0, fallback);
  }
  pruneUnresolvedMediaElements(merged);
  pruneSlimParserPlaceholderImages(merged);
  reorderParserPanelBackgroundsBehindText(merged);
  reorderLateParserBannerImagesBehindText(merged);
  reorderFallbackImagesBehindText(merged);
  return normalizeImportedTextFlipTransforms(merged);
}

function normalizeImportedTextFlipTransforms(elements: SlideElementIR[]): SlideElementIR[] {
  return elements.map((element) => {
    if (element.type !== 'text') return element;

    const canRepresentAsHalfTurn =
      (element.flipH === true && element.flipV === true) ||
      (element.vertical === true && element.flipV === true);
    if (!canRepresentAsHalfTurn) return element;

    const { flipH: _flipH, flipV: _flipV, ...rest } = element;
    return {
      ...rest,
      rotate: normalizeRotation((element.rotate ?? 0) + 180),
    };
  });
}

function fallbackSourceOrderId(element: SlideElementIR): string | undefined {
  return (
    element.sourceShapeId ??
    extractFallbackSourceElementId(element) ??
    element.id.match(/^pptx_chart_(.+)$/)?.[1]
  );
}

function isChartFallbackSupplement(element: SlideElementIR): boolean {
  return element.type === 'image' && element.id.startsWith('pptx_chart_');
}

function findChartSupplementInsertIndex(
  elements: SlideElementIR[],
  fallback: SlideElementIR,
  fallbackOrderBySourceId: ReadonlyMap<string, number>,
): number {
  const fallbackOrder = fallbackOrderBySourceId.get(fallbackSourceOrderId(fallback) ?? '');
  if (fallbackOrder == null) return elements.length;
  const nextElementIndex = elements.findIndex((element) => {
    const order = fallbackOrderBySourceId.get(fallbackSourceOrderId(element) ?? '');
    return order != null && order > fallbackOrder;
  });
  return nextElementIndex >= 0 ? nextElementIndex : elements.length;
}

function extractFallbackSourceElementId(element: SlideElementIR): string | undefined {
  return element.id.match(/^pptx_fallback_shape_(.+)$/)?.[1];
}

function mergeSourceMatchedElement(
  parserElement: SlideElementIR,
  fallback: SlideElementIR,
  metadata?: PptxSlideElementMetadata,
): SlideElementIR {
  const fallbackText = normalizeElementPlainText(fallback.content);
  const shouldHydrateFont = Boolean(fallback.defaultFontName && containsCjkText(fallbackText));
  const parserContent = applyImportedTextHighlights(
    parserElement.content,
    metadata?.textHighlights,
  );
  const sourceContent = applyImportedTextHighlights(fallback.content, metadata?.textHighlights);
  const sourceTextColor = normalizeCssColor(fallback.defaultColor);
  const sourceFillColor = normalizeCssColor(fallback.fillColor);
  const fallbackHasFill = Boolean(
    fallback.fillColor != null || fallback.fillGradient || fallback.pattern,
  );
  const preserveSourceTextVisibility = Boolean(
    sourceContent &&
    sourceTextColor &&
    sourceFillColor &&
    sourceTextColor.toLowerCase() === sourceFillColor.toLowerCase(),
  );
  // The parser may normalize the spacer runs in a no-wrap text box. Prefer
  // OOXML-backed content there, because those spaces encode digit columns in
  // vertical calculations rather than ordinary prose spacing.
  const preserveSourceNoWrapSpacing = Boolean(
    metadata?.noWrap && sourceContent && /(?:&nbsp;|&#160;|&#xA0;|\u00a0)/i.test(sourceContent),
  );
  let content =
    preserveSourceTextVisibility || preserveSourceNoWrapSpacing
      ? sourceContent
      : normalizeElementPlainText(parserContent)
        ? parserContent
        : (sourceContent ?? parserContent);
  if (fallback.hardLineBreaks?.length) {
    content = applyFallbackHardLineBreaks(content, fallback.hardLineBreaks);
  }
  if (metadata?.paragraphBreaks?.length) {
    content = applyFallbackParagraphBreaks(content, metadata.paragraphBreaks);
  }
  if (shouldHydrateFont && fallback.defaultFontName) {
    content = applyCjkFontFamily(
      content,
      resolveImportedCssFontFamily(fallback.defaultFontName) ?? fallback.defaultFontName,
    );
  }
  // pptxtojson currently reports some normAutofit text boxes as shape/text autofit.
  // The OOXML bodyPr is authoritative for imported fidelity: normAutofit keeps
  // the authored box and scales the text, whereas spAutoFit is allowed to grow
  // the box. Prefer the fallback mode when the parser and OOXML disagree.
  const autoFit = resolveMergedAutoFit(parserElement.autoFit, fallback.autoFit);
  if (content) content = applyImportedTextMetricPolicy(content, autoFit);

  const rawDefaultFontName = shouldHydrateFont
    ? fallback.defaultFontName
    : (parserElement.defaultFontName ?? fallback.defaultFontName);
  const defaultFontName = resolveImportedCssFontFamily(rawDefaultFontName) ?? rawDefaultFontName;
  const defaultColor = preserveSourceTextVisibility
    ? fallback.defaultColor
    : (parserElement.defaultColor ?? fallback.defaultColor);
  const wordSpace = parserElement.wordSpace ?? fallback.wordSpace;
  const textAlign = parserElement.textAlign ?? fallback.textAlign;
  const sourceMetadata = {
    ...((parserElement.sourceShapeId ?? fallback.sourceShapeId)
      ? { sourceShapeId: parserElement.sourceShapeId ?? fallback.sourceShapeId }
      : {}),
    ...(parserElement.sourceGroupShapeIds?.length || fallback.sourceGroupShapeIds?.length
      ? {
          sourceGroupShapeIds: parserElement.sourceGroupShapeIds ?? fallback.sourceGroupShapeIds,
        }
      : {}),
    ...((parserElement.sourceOrder ?? fallback.sourceOrder) != null
      ? { sourceOrder: parserElement.sourceOrder ?? fallback.sourceOrder }
      : {}),
  };
  const preserveParserPath = Boolean(
    parserElement.path &&
    parserElement.viewBox &&
    (parserElement.subPaths?.length ||
      (parserElement.shapeType &&
        INTENTIONAL_OVERFLOW_PARSER_PATH_SHAPES.has(parserElement.shapeType) &&
        isIntentionalOverflowCalloutPath(
          parserElement.path,
          parserElement.viewBox,
          parserElement.width,
          parserElement.height,
        ))),
  );
  const preserveParserOutline = Boolean(
    parserElement.subPaths?.length ||
    (parserElement.shapeType &&
      INTENTIONAL_OVERFLOW_PARSER_PATH_SHAPES.has(parserElement.shapeType)),
  );
  if (
    parserElement.type === 'text' &&
    (parserElement.promotedFromShapeText || !hasVisibleShapeStyle(fallback))
  ) {
    return {
      ...parserElement,
      ...sourceMetadata,
      ...(content ? { content } : {}),
      ...(fallback.hardLineBreaks?.length ? { hardLineBreaks: fallback.hardLineBreaks } : {}),
      ...(defaultFontName ? { defaultFontName } : {}),
      ...(defaultColor ? { defaultColor } : {}),
      ...(wordSpace != null ? { wordSpace } : {}),
      ...(textAlign ? { textAlign } : {}),
      ...(autoFit ? { autoFit } : {}),
      ...(parserElement.flipH || fallback.flipH ? { flipH: true } : {}),
      ...(parserElement.flipV || fallback.flipV ? { flipV: true } : {}),
    };
  }

  return {
    ...fallback,
    ...sourceMetadata,
    id: parserElement.id,
    ...(preserveParserOutline && parserElement.borderColor
      ? { borderColor: parserElement.borderColor }
      : {}),
    ...(preserveParserOutline && parserElement.borderWidth != null
      ? { borderWidth: parserElement.borderWidth }
      : {}),
    ...(preserveParserOutline && parserElement.borderType
      ? { borderType: parserElement.borderType }
      : {}),
    ...(preserveParserOutline && parserElement.borderGradient
      ? { borderGradient: parserElement.borderGradient }
      : {}),
    ...(parserElement.subPaths?.length ? { subPaths: parserElement.subPaths } : {}),
    ...(preserveParserPath ? { path: parserElement.path, viewBox: parserElement.viewBox } : {}),
    ...(!fallbackHasFill && parserElement.fillColor ? { fillColor: parserElement.fillColor } : {}),
    ...(!fallbackHasFill && parserElement.fillGradient
      ? { fillGradient: parserElement.fillGradient }
      : {}),
    ...(!fallbackHasFill && parserElement.pattern
      ? {
          pattern: parserElement.pattern,
          patternScaleMode: parserElement.patternScaleMode,
          patternCrop: parserElement.patternCrop,
        }
      : {}),
    ...(content ? { content } : {}),
    ...(parserElement.textType ? { textType: parserElement.textType } : {}),
    ...(parserElement.fixedBox != null ? { fixedBox: parserElement.fixedBox } : {}),
    ...(defaultFontName ? { defaultFontName } : {}),
    ...(defaultColor ? { defaultColor } : {}),
    ...(parserElement.fontSize != null ? { fontSize: parserElement.fontSize } : {}),
    ...(parserElement.fontWeight ? { fontWeight: parserElement.fontWeight } : {}),
    ...(parserElement.lineHeight != null ? { lineHeight: parserElement.lineHeight } : {}),
    ...(wordSpace != null ? { wordSpace } : {}),
    ...(textAlign ? { textAlign } : {}),
    ...(parserElement.paragraphSpace != null
      ? { paragraphSpace: parserElement.paragraphSpace }
      : {}),
    ...(parserElement.textInsets ? { textInsets: parserElement.textInsets } : {}),
    ...(parserElement.verticalAlign ? { verticalAlign: parserElement.verticalAlign } : {}),
    ...(parserElement.vertical != null ? { vertical: parserElement.vertical } : {}),
    ...(autoFit ? { autoFit } : {}),
    ...(!fallback.path &&
    parserElement.path &&
    calculateRectOverlapRatio(parserElement, fallback) >= 0.85
      ? { path: parserElement.path, viewBox: parserElement.viewBox }
      : {}),
  };
}

function resolveMergedAutoFit(
  parserAutoFit: SlideElementIR['autoFit'] | undefined,
  fallbackAutoFit: SlideElementIR['autoFit'] | undefined,
) {
  if (parserAutoFit?.type !== 'shrink' && fallbackAutoFit?.type === 'shrink') {
    return { ...fallbackAutoFit, type: 'normal' };
  }
  return parserAutoFit ?? fallbackAutoFit;
}

function isPathOutsideViewBox(path: string, viewBox: [number, number]): boolean {
  try {
    const bounds = getPathBounds(path);
    return (
      bounds.minX < -0.01 ||
      bounds.minY < -0.01 ||
      bounds.maxX > viewBox[0] + 0.01 ||
      bounds.maxY > viewBox[1] + 0.01
    );
  } catch {
    return false;
  }
}

function isIntentionalOverflowCalloutPath(
  path: string,
  viewBox: [number, number],
  width?: number,
  height?: number,
): boolean {
  try {
    const [viewBoxWidth, viewBoxHeight] = viewBox;
    if (!isPathOutsideViewBox(path, viewBox)) return false;
    if (!(width && width > 0 && height && height > 0)) return false;
    // A real callout's nominal body aspect matches its element frame even when
    // the pointer extends outside the body. Corrupt parser viewBoxes do not.
    const aspectRatio = viewBoxWidth / viewBoxHeight / (width / height);
    return aspectRatio >= 0.75 && aspectRatio <= 4 / 3;
  } catch {
    return false;
  }
}

function inferOverflowCalloutBodyViewBox(
  path: string,
  shapeType: string | undefined,
  width?: number,
  height?: number,
): [number, number] | undefined {
  if (!(width && width > 0 && height && height > 0)) return undefined;

  try {
    const commands = new SVGPathData(path).toAbs().commands;
    const xCoordinates = new Map<string, { value: number; count: number }>();
    const yCoordinates = new Map<string, { value: number; count: number }>();
    let hasZeroX = false;
    let hasZeroY = false;
    let ellipseBodyWidth = 0;
    let ellipseBodyHeight = 0;

    const collectCoordinate = (
      coordinates: Map<string, { value: number; count: number }>,
      value: number | undefined,
    ) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return;
      const key = value.toPrecision(12);
      const current = coordinates.get(key);
      coordinates.set(key, { value, count: (current?.count ?? 0) + 1 });
    };

    for (const command of commands) {
      const x = 'x' in command ? command.x : undefined;
      const y = 'y' in command ? command.y : undefined;
      if (typeof x === 'number' && Math.abs(x) <= 1e-9) hasZeroX = true;
      if (typeof y === 'number' && Math.abs(y) <= 1e-9) hasZeroY = true;
      collectCoordinate(xCoordinates, x);
      collectCoordinate(yCoordinates, y);
      if (shapeType === 'wedgeEllipseCallout') {
        const radiusX = 'rX' in command ? command.rX : undefined;
        const radiusY = 'rY' in command ? command.rY : undefined;
        if (typeof radiusX === 'number') ellipseBodyWidth = Math.max(ellipseBodyWidth, radiusX * 2);
        if (typeof radiusY === 'number')
          ellipseBodyHeight = Math.max(ellipseBodyHeight, radiusY * 2);
      }
    }
    if (shapeType !== 'wedgeEllipseCallout' && (!hasZeroX || !hasZeroY)) {
      return undefined;
    }

    const frameAspect = width / height;
    const bounds = getPathBounds(path);
    if (shapeType === 'wedgeEllipseCallout' && ellipseBodyWidth > 0 && ellipseBodyHeight > 0) {
      const ellipseViewBox: [number, number] = [ellipseBodyWidth, ellipseBodyHeight];
      const aspectError = Math.abs(ellipseViewBox[0] / ellipseViewBox[1] / frameAspect - 1);
      if (aspectError <= 0.015 && isPathOutsideViewBox(path, ellipseViewBox)) {
        return ellipseViewBox;
      }
    }
    let best:
      | {
          viewBox: [number, number];
          aspectError: number;
          repetitions: number;
          area: number;
        }
      | undefined;

    for (const xCoordinate of xCoordinates.values()) {
      if (!(xCoordinate.value > 1e-9)) continue;
      for (const yCoordinate of yCoordinates.values()) {
        if (!(yCoordinate.value > 1e-9)) continue;
        const candidate: [number, number] = [xCoordinate.value, yCoordinate.value];
        const aspectError = Math.abs(candidate[0] / candidate[1] / frameAspect - 1);
        if (aspectError > 0.015 || !isPathOutsideViewBox(path, candidate)) continue;

        const repetitions = xCoordinate.count + yCoordinate.count;
        const area = candidate[0] * candidate[1];
        if (
          !best ||
          aspectError < best.aspectError - 1e-6 ||
          (Math.abs(aspectError - best.aspectError) <= 1e-6 &&
            (repetitions > best.repetitions ||
              (repetitions === best.repetitions && area > best.area)))
        ) {
          best = { viewBox: candidate, aspectError, repetitions, area };
        }
      }
    }

    if (!best) return undefined;
    const [bodyWidth, bodyHeight] = best.viewBox;
    if (
      shapeType !== 'wedgeEllipseCallout' &&
      (bodyWidth > bounds.maxX + 1e-9 || bodyHeight > bounds.maxY + 1e-9)
    ) {
      return undefined;
    }
    return best.viewBox;
  } catch {
    return undefined;
  }
}

function isSourceElementMatch(
  element: SlideElementIR,
  fallback: SlideElementIR,
  metadata: PptxSlideElementMetadata | undefined,
  sourceElementId: string,
): boolean {
  // Parsed PPTX elements normally carry the source shape id themselves. Use
  // it as a strong match even when the supplemental metadata table was not
  // populated (for example when a parser shape has no visible styling).
  if (metadata?.sourceElementId !== sourceElementId && element.sourceShapeId !== sourceElementId) {
    return false;
  }
  if (hasSameElementTransform(element, fallback)) return true;

  const overlapRatio = calculateRectOverlapRatio(element, fallback);
  if (
    overlapRatio >= 0.85 &&
    calculateRectCenterDistance(element, fallback) <= 12 &&
    largerOverSmaller(element.width, fallback.width) <= 1.1 &&
    largerOverSmaller(element.height, fallback.height) <= 1.1
  ) {
    return true;
  }

  const elementText = normalizeElementIdentityText(element.content);
  const fallbackText = normalizeElementIdentityText(fallback.content);
  if (fallbackText && !elementText && isParserWhiteOverlayShape(element)) return true;
  if (elementText && elementText === fallbackText) return overlapRatio >= 0.8;

  return Boolean(
    element.pattern &&
    fallback.pattern &&
    element.pattern === fallback.pattern &&
    overlapRatio >= 0.85,
  );
}

function hasVisibleShapeStyle(element: SlideElementIR): boolean {
  return Boolean(
    element.pattern ||
    element.fillGradient ||
    element.borderGradient ||
    element.borderColor ||
    (element.borderWidth != null && element.borderWidth > 0) ||
    (element.fillColor && element.fillColor !== 'transparent'),
  );
}

function hasResolvedMediaSource(element: SlideElementIR): boolean {
  return element.type !== 'video' && element.type !== 'audio' ? true : Boolean(element.src?.trim());
}

function pruneUnresolvedMediaElements(elements: SlideElementIR[]): void {
  for (let index = elements.length - 1; index >= 0; index -= 1) {
    if (!hasResolvedMediaSource(elements[index]!)) {
      elements.splice(index, 1);
    }
  }
}

function pruneCollapsedParserElementsWithFallbackText(
  elements: SlideElementIR[],
  fallbackElements: SlideElementIR[],
  protectedElementIds: ReadonlySet<string> = new Set(),
): SlideElementIR[] {
  const fallbackTexts = new Set(
    fallbackElements.map((element) => normalizeElementPlainText(element.content)).filter(Boolean),
  );
  if (fallbackTexts.size < 2) return elements;
  const collapsedTextIds = new Set(
    elements
      .filter(
        (element) =>
          !protectedElementIds.has(element.id) &&
          isCollapsedParserTextDuplicate(element, elements, fallbackTexts),
      )
      .map((element) => element.id),
  );
  if (collapsedTextIds.size === 0) return elements;

  return elements.filter((element, index) => {
    if (protectedElementIds.has(element.id)) return true;
    if (collapsedTextIds.has(element.id)) {
      return false;
    }
    if (!isParserPlaceholderShape(element)) return true;
    const previous = elements[index - 1];
    const next = elements[index + 1];
    return (
      !isCollapsedParserTextNeighbor(previous, collapsedTextIds) &&
      !isCollapsedParserTextNeighbor(next, collapsedTextIds)
    );
  });
}

function isCollapsedParserTextDuplicate(
  element: SlideElementIR,
  elements: SlideElementIR[],
  fallbackTexts: Set<string>,
): boolean {
  if (!element.id.startsWith('pptx_')) return false;
  const text = normalizeElementPlainText(element.content);
  if (!text || !fallbackTexts.has(text)) return false;
  const duplicateCount = elements.filter((candidate) => {
    if (candidate === element) return false;
    const candidateText = normalizeElementPlainText(candidate.content);
    if (!candidateText || !fallbackTexts.has(candidateText)) return false;
    return calculateRectCenterDistance(element, candidate) <= 24;
  }).length;
  return duplicateCount >= 1;
}

function isCollapsedParserTextNeighbor(
  element: SlideElementIR | undefined,
  collapsedTextIds: Set<string>,
): boolean {
  if (!element) return false;
  return collapsedTextIds.has(element.id);
}

function isParserPlaceholderShape(element: SlideElementIR): boolean {
  if (element.type !== 'shape') return false;
  if (!element.id.startsWith('pptx_shape_')) return false;
  return !normalizeElementPlainText(element.content) && !isVisualCardBackgroundShape(element);
}

function pruneSlimParserPlaceholderImages(elements: SlideElementIR[]) {
  for (let index = elements.length - 1; index >= 0; index -= 1) {
    const element = elements[index];
    if (!isSlimParserPlaceholderImage(element)) continue;
    elements.splice(index, 1);
  }
}

function isParserImageElement(element: SlideElementIR): boolean {
  return element.type === 'image' && element.id.startsWith('pptx_image_');
}

function isSlimParserPlaceholderImage(element: SlideElementIR): boolean {
  return (
    isParserImageElement(element) &&
    typeof element.src === 'string' &&
    isSlimPlaceholderDataUrl(element.src)
  );
}

function removeAdditionalDistortedParserShapeDuplicates(
  elements: SlideElementIR[],
  replacement: SlideElementIR,
  startIndex: number,
) {
  for (let index = elements.length - 1; index >= startIndex; index -= 1) {
    if (shouldReplaceDistortedParserShape(elements[index], replacement)) {
      elements.splice(index, 1);
    }
  }
}

function findSupplementInsertIndex(elements: SlideElementIR[], fallback: SlideElementIR): number {
  if (isFallbackLayoutSupplement(fallback)) {
    const firstContentIndex = elements.findIndex((element) => !isFallbackLayoutSupplement(element));
    return firstContentIndex >= 0 ? firstContentIndex : elements.length;
  }

  if (isFallbackImageSupplement(fallback)) {
    const textOverlayIndex = findFallbackImageTextInsertIndex(elements, fallback);
    if (textOverlayIndex < elements.length) return textOverlayIndex;
  }

  const fallbackText = normalizeElementPlainText(fallback.content);
  if (!isCardBackgroundSupplement(fallback, fallbackText)) return elements.length;

  const foregroundIndex = elements.findIndex((element) =>
    shouldInsertCardBackgroundBeforeElement(fallback, element),
  );
  return foregroundIndex >= 0 ? foregroundIndex : elements.length;
}

function isFallbackImageSupplement(element: SlideElementIR): boolean {
  return (
    element.type === 'image' &&
    (element.id.startsWith('pptx_fallback_image_') ||
      element.id.startsWith('pptx_fallback_layout_image_'))
  );
}

function isFallbackLayoutSupplement(element: SlideElementIR): boolean {
  return (
    element.id.startsWith('pptx_fallback_master_') || element.id.startsWith('pptx_fallback_layout_')
  );
}

function findFallbackImageTextInsertIndex(
  elements: SlideElementIR[],
  fallback: SlideElementIR,
): number {
  const overlappingTextIndex = elements.findIndex((candidate) => {
    if (!isForegroundTextElement(candidate)) return false;
    return calculateRectOverlapRatio(fallback, candidate) >= 0.12;
  });

  if (overlappingTextIndex < 0) return elements.length;

  let insertIndex = overlappingTextIndex;
  while (insertIndex > 0) {
    const previous = elements[insertIndex - 1];
    if (!isForegroundTextElement(previous)) break;
    if (calculateRectOverlapRatio(fallback, previous) < 0.12) break;
    insertIndex -= 1;
  }
  return insertIndex;
}

function reorderParserPanelBackgroundsBehindText(elements: SlideElementIR[]) {
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index];
    if (!isParserPanelBackground(element)) continue;

    const targetIndex = findPanelBackgroundInsertIndex(elements, element, index);
    if (targetIndex === index) continue;

    elements.splice(index, 1);
    elements.splice(targetIndex, 0, element);
  }
}

function reorderLateParserBannerImagesBehindText(elements: SlideElementIR[]) {
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index];
    if (!isLateParserBannerImage(elements, element, index)) continue;

    const targetIndex = findBannerImageInsertIndex(elements, element, index);
    if (targetIndex === index) continue;

    elements.splice(index, 1);
    elements.splice(targetIndex, 0, element);
  }
}

function reorderFallbackImagesBehindText(elements: SlideElementIR[]) {
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index];
    if (!isFallbackImageSupplement(element)) continue;

    const targetIndex = findFallbackImageTextInsertIndex(elements, element);
    if (targetIndex >= index) continue;

    elements.splice(index, 1);
    elements.splice(targetIndex, 0, element);
  }
}

function isParserPanelBackground(element: SlideElementIR): boolean {
  if (element.type !== 'shape') return false;
  if (isFallbackLayoutSupplement(element)) return false;
  if (!isWhiteLikeColor(element.fillColor)) return false;
  if (normalizeElementPlainText(element.content)) return false;
  if (element.pattern || element.fillGradient || element.borderGradient) return false;
  return Math.max(0, element.width) * Math.max(0, element.height) >= 20000;
}

function findPanelBackgroundInsertIndex(
  elements: SlideElementIR[],
  background: SlideElementIR,
  currentIndex: number,
): number {
  const overlappingTextIndex = elements.findIndex((candidate, index) => {
    if (index === currentIndex) return false;
    if (!isForegroundTextElement(candidate)) return false;
    return calculateRectOverlapRatio(background, candidate) >= 0.08;
  });

  if (overlappingTextIndex < 0 || overlappingTextIndex >= currentIndex) {
    return currentIndex;
  }

  let insertIndex = overlappingTextIndex;
  while (insertIndex > 0) {
    const previous = elements[insertIndex - 1];
    if (!isForegroundTextElement(previous)) break;
    if (calculateRectOverlapRatio(background, previous) < 0.08) break;
    insertIndex -= 1;
  }
  return insertIndex;
}

function isLateParserBannerImage(
  elements: SlideElementIR[],
  image: SlideElementIR,
  currentIndex: number,
): boolean {
  if (image.type !== 'image') return false;
  if (image.imageRole === 'background') return false;

  const imageArea = Math.max(0, image.width) * Math.max(0, image.height);
  if (imageArea < 120000) return false;
  if (image.width < 420) return false;
  if (image.top > 80) return false;
  if (image.top + image.height < 120) return false;

  const overlapsEarlierHeadingText = elements.some((candidate, index) => {
    if (index >= currentIndex) return false;
    if (!isBannerHeadingText(candidate)) return false;
    return calculateRectOverlapRatio(image, candidate) >= 0.35;
  });
  if (!overlapsEarlierHeadingText) return false;

  return findBannerImageInsertIndex(elements, image, currentIndex) < currentIndex;
}

function isBannerHeadingText(element: SlideElementIR): boolean {
  const text = normalizeElementPlainText(element.content);
  if (!text) return false;
  if (element.type !== 'text' && element.type !== 'shape') return false;
  return element.top < 180;
}

function findBannerImageInsertIndex(
  elements: SlideElementIR[],
  image: SlideElementIR,
  currentIndex: number,
): number {
  for (let index = 0; index < currentIndex; index += 1) {
    const candidate = elements[index];
    if (!shouldKeepElementAboveBannerImage(image, candidate)) continue;
    if (calculateRectOverlapRatio(image, candidate) < 0.12) continue;
    return index;
  }

  return currentIndex;
}

function shouldKeepElementAboveBannerImage(
  image: SlideElementIR,
  candidate: SlideElementIR,
): boolean {
  if (candidate.id === image.id) return false;

  if (candidate.type === 'image') {
    return candidate.imageRole !== 'background';
  }

  if (normalizeElementPlainText(candidate.content)) {
    return true;
  }

  if (candidate.type !== 'shape') return false;
  if (candidate.pattern || candidate.fillGradient || candidate.borderGradient) return true;

  const fillColor = normalizeCssColor(candidate.fillColor);
  return Boolean(fillColor && fillColor !== 'transparent' && !isWhiteLikeColor(fillColor));
}

function isForegroundTextElement(element: SlideElementIR): boolean {
  if (element.type === 'text') return Boolean(normalizeElementPlainText(element.content));
  if (element.type !== 'shape') return false;
  return Boolean(normalizeElementPlainText(element.content));
}

function isCardBackgroundSupplement(element: SlideElementIR, elementText: string): boolean {
  return (
    element.type === 'shape' &&
    !elementText &&
    isCardLikeShapeType(element.shapeType) &&
    isVisualCardBackgroundShape(element)
  );
}

function isCardLikeShapeType(shapeType?: string): boolean {
  if (!shapeType) return false;
  return shapeType === 'rect' || shapeType.toLowerCase().includes('roundrect');
}

function shouldInsertCardBackgroundBeforeElement(
  fallback: SlideElementIR,
  element: SlideElementIR,
): boolean {
  if (element.type !== 'image') return false;
  if (element.imageRole === 'background') return false;

  const overlapRatio = calculateRectOverlapRatio(fallback, element);
  if (overlapRatio < 0.08) return false;

  const fallbackArea = Math.max(0, fallback.width) * Math.max(0, fallback.height);
  const imageArea = Math.max(0, element.width) * Math.max(0, element.height);
  return largerOverSmaller(fallbackArea, imageArea) <= 4;
}

function shouldReplaceBadParserElement(element: SlideElementIR, fallback: SlideElementIR): boolean {
  const elementText = normalizeElementPlainText(element.content);
  const fallbackText = normalizeElementPlainText(fallback.content);
  if (!isDuplicateTextContent(elementText, fallbackText)) return false;
  if (calculateRectOverlapRatio(element, fallback) > 0.05) return false;

  const elementArea = Math.max(0, element.width) * Math.max(0, element.height);
  const fallbackArea = Math.max(0, fallback.width) * Math.max(0, fallback.height);
  if (elementArea <= 0 || fallbackArea <= 0) return false;

  return elementArea < 4 && fallbackArea > 64;
}

function shouldReplaceSlimParserImage(element: SlideElementIR, fallback: SlideElementIR): boolean {
  if (element.type !== 'image' || fallback.type !== 'image') return false;
  if (!element.src || !isSlimPlaceholderDataUrl(element.src)) return false;
  if (!fallback.src || isSlimPlaceholderDataUrl(fallback.src)) return false;

  const overlapRatio = calculateRectOverlapRatio(element, fallback);
  if (overlapRatio < 0.92) return false;

  const centerDistance = calculateRectCenterDistance(element, fallback);
  if (centerDistance > 8) return false;

  const widthRatio = largerOverSmaller(element.width, fallback.width);
  const heightRatio = largerOverSmaller(element.height, fallback.height);
  return widthRatio <= 1.12 && heightRatio <= 1.12;
}

function shouldReplaceDistortedParserImage(
  element: SlideElementIR,
  fallback: SlideElementIR,
): boolean {
  if (element.type !== 'image' || fallback.type !== 'image') return false;
  if (!element.src || !fallback.src || element.src !== fallback.src) return false;

  const leftDelta = Math.abs(element.left - fallback.left);
  const topDelta = Math.abs(element.top - fallback.top);
  if (leftDelta > 32 || topDelta > 16) return false;

  const widthRatio = largerOverSmaller(element.width, fallback.width);
  const heightRatio = largerOverSmaller(element.height, fallback.height);
  const areaRatio = largerOverSmaller(
    element.width * element.height,
    fallback.width * fallback.height,
  );

  return widthRatio > 1.2 || heightRatio > 1.2 || areaRatio > 1.35;
}

function shouldReplaceParserImageWithSourceEffect(
  element: SlideElementIR,
  fallback: SlideElementIR,
): boolean {
  if (element.type !== 'image' || fallback.type !== 'image') return false;
  if (!fallback.sourceEffectApplied || !fallback.src) return false;
  return hasSameElementTransform(element, fallback);
}

function largerOverSmaller(left: number, right: number) {
  const a = Math.abs(left);
  const b = Math.abs(right);
  const smaller = Math.max(1e-6, Math.min(a, b));
  const larger = Math.max(a, b);
  return larger / smaller;
}

function isSlimPlaceholderDataUrl(value: string): boolean {
  if (
    value ===
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC' ||
    value ===
      'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==' ||
    value ===
      'data:image/jpeg;base64,/9j/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAD/xAAUEAEAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8A/9k='
  ) {
    return true;
  }
  const match = value.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return false;
  const [, mimeType, base64Data] = match;
  return isSlimPlaceholderBase64(mimeType, base64Data);
}

function isSlimPlaceholderBase64(mimeType: string, base64Data: string): boolean {
  const normalizedMimeType = mimeType.trim().toLowerCase();
  if (normalizedMimeType === 'image/gif') {
    return base64Data === 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(base64Data, 'base64');
  } catch {
    return false;
  }

  if (normalizedMimeType === 'image/png') {
    return buffer.equals(Buffer.from(buildSlimPngPlaceholderBytes()));
  }

  if (normalizedMimeType === 'image/jpeg') {
    return buffer.equals(Buffer.from(buildSlimJpegPlaceholderBytes()));
  }

  return false;
}

function buildSlimPngPlaceholderBytes(): Uint8Array {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x00, 0x03, 0x01, 0x01, 0x00, 0xc9, 0xfe, 0x92, 0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
    0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
}

function buildSlimJpegPlaceholderBytes(): Uint8Array {
  return Uint8Array.from([
    0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07,
    0x07, 0x09, 0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12, 0x13, 0x0f,
    0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20, 0x24, 0x2e, 0x27, 0x20, 0x22, 0x2c,
    0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29, 0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27, 0x39, 0x3d,
    0x38, 0x32, 0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xc4, 0x00, 0x14, 0x00, 0x01,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xc4, 0x00, 0x14,
    0x10, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xda,
    0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00, 0xff, 0xd9,
  ]);
}

function shouldReplacePlainShapeWithPatternShape(
  element: SlideElementIR,
  fallback: SlideElementIR,
): boolean {
  if (element.type !== 'shape' || fallback.type !== 'shape') return false;
  if (!isVisualCardBackgroundShape(fallback)) return false;
  if (!isTransparentParserShape(element) && !(fallback.pattern && !element.pattern)) return false;
  if (element.shapeType && fallback.shapeType && element.shapeType !== fallback.shapeType)
    return false;
  if (isClearlyCompressedShapePath(element)) return true;

  const overlapRatio = calculateRectOverlapRatio(element, fallback);
  const centerDistance = calculateRectCenterDistance(element, fallback);
  const widthRatio = largerOverSmaller(element.width, fallback.width);
  const heightRatio = largerOverSmaller(element.height, fallback.height);
  const areaRatio = largerOverSmaller(
    element.width * element.height,
    fallback.width * fallback.height,
  );

  if (overlapRatio >= 0.65 && widthRatio <= 1.25 && heightRatio <= 1.25) {
    return true;
  }

  return (
    overlapRatio >= 0.45 &&
    centerDistance <= 48 &&
    widthRatio <= 1.35 &&
    heightRatio <= 1.35 &&
    areaRatio <= 1.6
  );
}

function shouldReplaceSlimParserShapePattern(
  element: SlideElementIR,
  fallback: SlideElementIR,
): boolean {
  if (element.type !== 'shape' || fallback.type !== 'shape') return false;
  if (!element.pattern || !fallback.pattern) return false;
  if (!isSlimPlaceholderDataUrl(element.pattern) || isSlimPlaceholderDataUrl(fallback.pattern))
    return false;
  if (element.shapeType && fallback.shapeType && element.shapeType !== fallback.shapeType)
    return false;

  const overlapRatio = calculateRectOverlapRatio(element, fallback);
  const centerDistance = calculateRectCenterDistance(element, fallback);
  const widthRatio = largerOverSmaller(element.width, fallback.width);
  const heightRatio = largerOverSmaller(element.height, fallback.height);

  return overlapRatio >= 0.72 && centerDistance <= 24 && widthRatio <= 1.15 && heightRatio <= 1.15;
}

function shouldReplaceDistortedParserShape(
  element: SlideElementIR,
  fallback: SlideElementIR,
): boolean {
  if (element.type !== 'shape' || fallback.type !== 'shape') return false;
  if (!fallback.fillGradient && !fallback.pattern) return false;
  if (!isParserWhiteOverlayShape(element)) return false;
  if (normalizeElementPlainText(element.content)) return false;

  const overlapRatio = calculateRectOverlapRatio(element, fallback);
  const centerDistance = calculateRectCenterDistance(element, fallback);
  const widthRatio = largerOverSmaller(element.width, fallback.width);
  const heightRatio = largerOverSmaller(element.height, fallback.height);

  return overlapRatio >= 0.72 && centerDistance <= 24 && widthRatio <= 1.08 && heightRatio <= 1.08;
}

function isParserWhiteOverlayShape(element: SlideElementIR): boolean {
  if (element.pattern || element.fillGradient) return false;
  if (!isWhiteLikeColor(element.fillColor)) return false;
  if (element.opacity != null && element.opacity < 0.95) return false;
  return true;
}

function isWhiteLikeColor(color?: string): boolean {
  if (!color) return false;
  const normalized = color.trim().replace(/^#/, '');
  if (normalized.length !== 6 && normalized.length !== 8) return false;
  const rgb = normalized.slice(0, 6);
  const alpha = normalized.length === 8 ? parseInt(normalized.slice(6), 16) : 255;
  const channels = [rgb.slice(0, 2), rgb.slice(2, 4), rgb.slice(4, 6)].map((value) =>
    parseInt(value, 16),
  );
  if (channels.some((value) => !Number.isFinite(value))) return false;
  return alpha >= 240 && channels.every((value) => value >= 248);
}

function isTransparentParserShape(element: SlideElementIR): boolean {
  return (
    element.type === 'shape' &&
    !element.pattern &&
    !element.fillGradient &&
    (!element.fillColor || element.fillColor === 'transparent')
  );
}

function normalizeParserShapePath(params: {
  path?: string;
  shapeType?: string;
  width?: number;
  height?: number;
}) {
  const { path, shapeType, width, height } = params;
  if (!path || !width || !height) return path;
  if (shapeType && INTENTIONAL_OVERFLOW_PARSER_PATH_SHAPES.has(shapeType)) return path;

  try {
    const bounds = getPathBounds(path);
    if (!shouldScaleCompressedPath(bounds, width, height)) return path;
    const pathWidth = Math.max(1e-6, bounds.maxX - bounds.minX);
    const pathHeight = Math.max(1e-6, bounds.maxY - bounds.minY);
    return new SVGPathData(path)
      .toAbs()
      .translate(-bounds.minX, -bounds.minY)
      .scale(width / pathWidth, height / pathHeight)
      .encode();
  } catch {
    return path;
  }
}

function normalizeParserPathViewBox(
  value: PptxToJsonPageElement['pathViewBox'],
): [number, number] | undefined {
  const width = normalizeNumber(value?.width);
  const height = normalizeNumber(value?.height);
  if (!(width && width > 0 && height && height > 0)) return undefined;
  return [width, height];
}

function isCorruptParserRoundRectPath(
  path: string | undefined,
  pathViewBox: [number, number] | undefined,
): boolean {
  if (!path || !pathViewBox) return false;
  try {
    const bounds = getPathBounds(path);
    const [width, height] = pathViewBox;
    const toleranceX = Math.max(0.5, width * 0.02);
    const toleranceY = Math.max(0.5, height * 0.02);
    return (
      bounds.minX < -toleranceX ||
      bounds.minY < -toleranceY ||
      bounds.maxX > width + toleranceX ||
      bounds.maxY > height + toleranceY
    );
  } catch {
    return false;
  }
}

const FIXED_PARSER_PATH_VIEWBOX_SHAPES = new Set([
  'blockArc',
  'pie',
  'pieWedge',
  'arc',
  'chord',
  'teardrop',
  'mathPlus',
  'mathMinus',
  'mathMultiply',
  'mathDivide',
  'mathEqual',
  'mathNotEqual',
  'bracePair',
]);

const INTENTIONAL_OVERFLOW_PARSER_PATH_SHAPES = new Set([
  'wedgeRectCallout',
  'wedgeRoundRectCallout',
  'wedgeEllipseCallout',
  'callout1',
  'callout2',
  'callout3',
  'accentCallout1',
  'accentCallout2',
  'accentCallout3',
  'borderCallout1',
  'borderCallout2',
  'borderCallout3',
  'accentBorderCallout1',
  'accentBorderCallout2',
  'accentBorderCallout3',
]);

function resolveParserShapeViewBox(params: {
  path?: string;
  shapeType?: string;
  width?: number;
  height?: number;
  pathViewBox?: [number, number];
}): [number, number] | undefined {
  const { path, shapeType, width, height, pathViewBox } = params;
  if (shapeType && FIXED_PARSER_PATH_VIEWBOX_SHAPES.has(shapeType) && pathViewBox) {
    return pathViewBox;
  }
  if (shapeType && INTENTIONAL_OVERFLOW_PARSER_PATH_SHAPES.has(shapeType) && path) {
    // pptxtojson emits wedgeEllipseCallout as one closed contour: two lines form
    // the pointer and the remaining line segments approximate the ellipse. Its
    // repeated arc coordinates can look like a much smaller body viewBox, so
    // preserve the authored frame before applying the generic repetition-based
    // inference. Otherwise the contour is stretched and later mistaken for a
    // corrupt tail-only shape.
    if (
      shapeType === 'wedgeEllipseCallout' &&
      pathViewBox &&
      isIntentionalOverflowCalloutPath(path, pathViewBox, width, height)
    ) {
      return pathViewBox;
    }
    const inferredBodyViewBox = inferOverflowCalloutBodyViewBox(path, shapeType, width, height);
    if (inferredBodyViewBox) {
      if (!pathViewBox) return inferredBodyViewBox;

      const widthScale = pathViewBox[0] / inferredBodyViewBox[0];
      const heightScale = pathViewBox[1] / inferredBodyViewBox[1];
      const isUniformlyInflated =
        widthScale > 1.2 && heightScale > 1.2 && Math.abs(widthScale / heightScale - 1) <= 0.05;
      if (isUniformlyInflated) return inferredBodyViewBox;
    }
    if (pathViewBox && isIntentionalOverflowCalloutPath(path, pathViewBox, width, height)) {
      return pathViewBox;
    }
  }
  if (!path || !(width && width > 0 && height && height > 0)) {
    return width && height ? [width, height] : pathViewBox;
  }

  try {
    const bounds = getPathBounds(path);
    const pathWidth = bounds.maxX - Math.min(0, bounds.minX);
    const pathHeight = bounds.maxY - Math.min(0, bounds.minY);
    const positivePresetPathOverflowsViewBox =
      Boolean(shapeType) &&
      !INTENTIONAL_OVERFLOW_PARSER_PATH_SHAPES.has(shapeType ?? '') &&
      Boolean(pathViewBox) &&
      bounds.minX >= -0.01 &&
      bounds.minY >= -0.01 &&
      pathWidth > 0 &&
      pathHeight > 0 &&
      (bounds.maxX > pathViewBox![0] * 1.001 || bounds.maxY > pathViewBox![1] * 1.001);
    if (positivePresetPathOverflowsViewBox) {
      return [pathWidth, pathHeight];
    }
    if (pathViewBox && isCredibleParserPathViewBox(bounds, pathViewBox)) {
      return pathViewBox;
    }
    if (!(pathWidth > 0 && pathHeight > 0)) return [width, height];
    return pathWidth / pathHeight > width / height
      ? [pathWidth, pathWidth * (height / width)]
      : [pathHeight * (width / height), pathHeight];
  } catch {
    return [width, height];
  }
}

function isCredibleParserPathViewBox(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  viewBox: [number, number],
): boolean {
  const [viewBoxWidth, viewBoxHeight] = viewBox;
  const pathWidth = bounds.maxX - bounds.minX;
  const pathHeight = bounds.maxY - bounds.minY;
  if (!(viewBoxWidth > 0 && viewBoxHeight > 0 && pathWidth > 0 && pathHeight > 0)) {
    return false;
  }

  const pathAspect = pathWidth / pathHeight;
  const viewBoxAspect = viewBoxWidth / viewBoxHeight;
  const aspectRatio = pathAspect / viewBoxAspect;

  // pptxtojson occasionally reports a corrupt viewBox (for example 7200x100 for a
  // 3600x1620 path). Keep deriving a replacement only for those clear mismatches.
  if (aspectRatio < 0.75 || aspectRatio > 4 / 3) return false;

  // Custom geometry and callout tails may intentionally extend outside the shape frame.
  // Once the source coordinate system agrees with the path aspect, keep it intact rather
  // than recomputing it from the visible bounds after a group applies non-uniform scaling.
  return true;
}

function buildBracePairSubPaths(params: {
  shapeType?: string;
  path?: string;
  viewBox?: [number, number];
  fillColor?: string;
  borderColor?: string;
  borderWidth?: number;
  borderType?: SlideElementIR['borderType'];
}): SlideElementIR['subPaths'] | undefined {
  const { shapeType, path, viewBox, fillColor, borderColor, borderWidth, borderType } = params;
  if (shapeType !== 'bracePair' || !path || !viewBox || !fillColor) return undefined;

  const [width, height] = viewBox;
  const inset = roundCanvasNumber(Math.min(height / 6, width / 2));
  const right = roundCanvasNumber(width - inset);
  return [
    {
      path: `M ${inset} 0 H ${right} V ${height} H ${inset} Z`,
      fill: fillColor,
    },
    {
      path,
      fill: 'transparent',
      ...(borderColor ? { borderColor } : {}),
      ...(borderWidth != null && borderWidth > 0 ? { borderWidth } : {}),
      ...(borderType ? { borderType } : {}),
    },
  ];
}

function isClearlyCompressedShapePath(element: SlideElementIR): boolean {
  if (element.type !== 'shape' || !element.path) return false;
  return shouldScaleCompressedPath(getPathBounds(element.path), element.width, element.height);
}

function shouldScaleCompressedPath(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  width: number,
  height: number,
) {
  if (!(width > 0 && height > 0)) return false;
  const pathWidth = Math.max(0, bounds.maxX - bounds.minX);
  const pathHeight = Math.max(0, bounds.maxY - bounds.minY);
  if (!(pathWidth > 0 && pathHeight > 0)) return false;
  return width / pathWidth > 8 && height / pathHeight > 8;
}

function getPathBounds(path: string) {
  const pathData = new SVGPathData(path).toAbs();
  if (pathData.commands.some((command) => command.type === SVGPathData.ARC)) {
    const { minX, minY, maxX, maxY } = pathData.getBounds();
    if ([minX, minY, maxX, maxY].every(Number.isFinite)) {
      return { minX, minY, maxX, maxY };
    }
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const command of pathData.commands) {
    for (const [x, y] of [
      ['x' in command ? command.x : undefined, 'y' in command ? command.y : undefined],
      ['x1' in command ? command.x1 : undefined, 'y1' in command ? command.y1 : undefined],
      ['x2' in command ? command.x2 : undefined, 'y2' in command ? command.y2 : undefined],
    ] as const) {
      if (typeof x === 'number' && Number.isFinite(x)) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
      }
      if (typeof y === 'number' && Number.isFinite(y)) {
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }

  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY)
  ) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }

  return { minX, minY, maxX, maxY };
}

function hasSameElementTransform(left: SlideElementIR, right: SlideElementIR): boolean {
  const rotationDelta = Math.abs(
    normalizeRotation(left.rotate ?? 0) - normalizeRotation(right.rotate ?? 0),
  );
  return (
    Math.abs(left.left - right.left) < 1 &&
    Math.abs(left.top - right.top) < 1 &&
    Math.abs(left.width - right.width) < 1 &&
    Math.abs(left.height - right.height) < 1 &&
    Math.min(rotationDelta, 360 - rotationDelta) < 0.1 &&
    Boolean(left.flipH) === Boolean(right.flipH) &&
    Boolean(left.flipV) === Boolean(right.flipV)
  );
}

function isDuplicateSupplementElement(element: SlideElementIR, fallback: SlideElementIR): boolean {
  if (element.id === fallback.id) return true;
  if (!hasSameElementTransform(element, fallback)) return false;

  const elementText = normalizeElementIdentityText(element.content);
  const fallbackText = normalizeElementIdentityText(fallback.content);
  if (elementText || fallbackText) return Boolean(elementText && elementText === fallbackText);

  if (element.type !== fallback.type) return false;

  if (fallback.type === 'image') {
    return Boolean(element.src && fallback.src && element.src === fallback.src);
  }

  if (fallback.type === 'video' || fallback.type === 'audio') {
    return Boolean(
      element.src &&
      fallback.src &&
      element.src === fallback.src &&
      element.poster === fallback.poster,
    );
  }

  if (fallback.type === 'shape' && element.pattern && fallback.pattern) {
    return (
      element.pattern === fallback.pattern &&
      JSON.stringify(element.patternCrop ?? null) === JSON.stringify(fallback.patternCrop ?? null)
    );
  }

  return false;
}

function shouldHydrateSupplementMediaElement(
  element: SlideElementIR,
  fallback: SlideElementIR,
): boolean {
  if (element.type !== fallback.type) return false;
  if (element.type !== 'video' && element.type !== 'audio' && element.type !== 'image')
    return false;
  if (element.src?.trim()) return false;
  if (!fallback.src?.trim()) return false;
  if (element.id === fallback.id) return true;

  const overlapRatio = calculateRectOverlapRatio(element, fallback);
  if (overlapRatio < 0.9) return false;

  const centerDistance = calculateRectCenterDistance(element, fallback);
  if (centerDistance > 12) return false;

  const widthRatio = largerOverSmaller(element.width, fallback.width);
  const heightRatio = largerOverSmaller(element.height, fallback.height);
  if (widthRatio > 1.08 || heightRatio > 1.08) return false;

  return true;
}

function mergeSupplementMediaElement(
  element: SlideElementIR,
  fallback: SlideElementIR,
): SlideElementIR {
  return {
    ...element,
    ...fallback,
    id: element.id,
    left: element.left,
    top: element.top,
    width: element.width,
    height: element.height,
    rotate: element.rotate ?? fallback.rotate,
  };
}

function shouldReplaceParserPosterImage(
  element: SlideElementIR,
  fallback: SlideElementIR,
): boolean {
  if (element.type !== 'image' || fallback.type !== 'video') return false;
  const overlapRatio = calculateRectOverlapRatio(element, fallback);
  if (element.src && fallback.poster && element.src === fallback.poster) {
    return overlapRatio >= 0.85;
  }

  return (
    overlapRatio >= 0.98 &&
    Math.abs(element.left - fallback.left) < 1 &&
    Math.abs(element.top - fallback.top) < 1 &&
    Math.abs(element.width - fallback.width) < 1 &&
    Math.abs(element.height - fallback.height) < 1
  );
}

function isVisualCardBackgroundShape(element: SlideElementIR): boolean {
  return Boolean(
    element.pattern ||
    element.fillGradient ||
    element.borderGradient ||
    (element.fillColor && element.fillColor !== 'transparent'),
  );
}

function isDuplicateTextContent(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length > right.length ? left : right;
  return shorter.length >= 8 && longer.includes(shorter);
}

function calculateRectOverlapRatio(left: SlideElementIR, right: SlideElementIR): number {
  const x1 = Math.max(left.left, right.left);
  const y1 = Math.max(left.top, right.top);
  const x2 = Math.min(left.left + left.width, right.left + right.width);
  const y2 = Math.min(left.top + left.height, right.top + right.height);
  const overlapWidth = Math.max(0, x2 - x1);
  const overlapHeight = Math.max(0, y2 - y1);
  const overlapArea = overlapWidth * overlapHeight;
  if (overlapArea <= 0) return 0;
  const smallerArea = Math.max(1, Math.min(left.width * left.height, right.width * right.height));
  return overlapArea / smallerArea;
}

function calculateRectCenterDistance(left: SlideElementIR, right: SlideElementIR): number {
  const leftCenterX = left.left + left.width / 2;
  const leftCenterY = left.top + left.height / 2;
  const rightCenterX = right.left + right.width / 2;
  const rightCenterY = right.top + right.height / 2;
  return Math.hypot(leftCenterX - rightCenterX, leftCenterY - rightCenterY);
}

function scaleSupplementElement(
  element: SlideElementIR,
  pageWidth: number,
  pageHeight: number,
  targetHeight: number,
): SlideElementIR {
  const normalized = normalizeViewportRect({
    x: element.left,
    y: element.top,
    width: element.width,
    height: element.height,
    sourceWidth: pageWidth,
    sourceHeight: pageHeight,
    targetWidth: 1000,
    targetHeight,
  });

  return {
    ...element,
    left: roundCanvasNumber(normalized.left),
    top: roundCanvasNumber(normalized.top),
    width: roundCanvasNumber(normalized.width),
    height: roundCanvasNumber(normalized.height),
  };
}

function mapElement(
  element: PptxToJsonPageElement,
  pageWidth: number,
  pageHeight: number,
  targetHeight: number,
  index: number,
  metadata?: PptxSlideElementMetadata,
  tableNoFill?: boolean[][],
  mediaContext?: PptxImportMediaContext,
): SlideElementIR[] {
  const textScale = pageWidth > 0 ? 1000 / pageWidth : 1;
  const parserTextInsets = normalizeTextInsets(
    element.textInsets ?? element.textInset ?? {},
    textScale,
  );
  const normalized = normalizeViewportRect({
    x: element.left ?? 0,
    y: element.top ?? 0,
    width: element.width ?? 120,
    height: element.height ?? 48,
    sourceWidth: pageWidth,
    sourceHeight: pageHeight,
    targetWidth: 1000,
    targetHeight,
  });
  const sourceParagraphCount =
    (element.content || element.text?.content || '').match(/<p\b/gi)?.length ?? 0;
  const promotedTextOnlyShape =
    element.type === 'shape' &&
    element.isVertical !== true &&
    sourceParagraphCount >= 2 &&
    !element.path &&
    !element.fill &&
    !(typeof element.borderWidth === 'number' && element.borderWidth > 0);
  const rawType = normalizeElementType(element);
  const importedTextInsets = metadata?.textInsets ?? parserTextInsets;
  const autoFit = mapAutoFit(element.autoFit) ?? metadata?.autoFit;
  const normalizedTextContent = applyImportedDefaultLineHeight(
    applyImportedParagraphLayout(
      applyImportedEmptyParagraphFontSizes(
        applyFallbackParagraphBreaks(
          normalizeImportedTextContent(element.content || element.text?.content || '', textScale),
          metadata?.paragraphBreaks,
        ) ?? '',
        metadata?.emptyParagraphFontSizes,
      ),
      metadata?.distributedParagraphIndexes,
      metadata?.paragraphLineHeights,
      metadata?.paragraphAlignments,
      metadata?.paragraphSpaceBefore,
    ),
    metadata?.paragraphLineHeights,
  );
  const content = applyImportedTextMetricPolicy(
    applyImportedNoWrap(normalizedTextContent, metadata?.noWrap),
    autoFit,
  );
  const extractedTextStyle = extractTextStyle(content);
  const textAlign = resolveImportedHorizontalTextAlign(metadata?.paragraphAlignments);
  const textStyle = content
    ? {
        ...extractedTextStyle,
        ...(textAlign ? { textAlign } : {}),
        lineHeight: extractedTextStyle.lineHeight ?? 1.2,
        paragraphSpace: extractedTextStyle.paragraphSpace ?? 0,
      }
    : extractedTextStyle;
  const verticalAlign = mapVerticalAlign(element.vAlign) ?? metadata?.verticalAlign;
  const overflowVisible =
    metadata?.overflowVisible ??
    (shouldPreserveSingleHanGlyphOverflow({
      content,
      autoFit,
      fontSize: textStyle.fontSize,
      width: normalized.width,
      textInsets: importedTextInsets,
    })
      ? true
      : undefined);

  if (rawType === 'text' && isFullyInvisibleImportedTextContent(content)) {
    return [];
  }

  if (shouldDropParserArtifact(rawType, normalized, content) && !isLineShapeElement(element)) {
    return [];
  }

  if (rawType === 'image') {
    return [
      {
        id: element.id || `pptx_image_${index + 1}`,
        type: 'image',
        left: roundCanvasNumber(normalized.left),
        top: roundCanvasNumber(normalized.top),
        width: roundCanvasNumber(normalized.width),
        height: roundCanvasNumber(normalized.height),
        rotate: element.rotate ?? 0,
        ...(element.flipH || element.isFlipH ? { flipH: true } : {}),
        ...(element.flipV || element.isFlipV ? { flipV: true } : {}),
        src: normalizeImportedMediaReference(
          element.src,
          element.id || `pptx_image_${index + 1}`,
          'image',
          mediaContext,
        ),
        opacity: normalizeOpacity(undefined),
        imageRole: 'content',
        clip: mapImageClip(element),
      },
    ];
  }

  if (rawType === 'video') {
    return [
      {
        id: element.id || `pptx_video_${index + 1}`,
        type: 'video',
        left: roundCanvasNumber(normalized.left),
        top: roundCanvasNumber(normalized.top),
        width: roundCanvasNumber(normalized.width),
        height: roundCanvasNumber(normalized.height),
        rotate: element.rotate ?? 0,
        src:
          normalizeImportedMediaReference(
            element.src,
            element.id || `pptx_video_${index + 1}`,
            'video',
            mediaContext,
          ) || '',
        poster: normalizeImportedMediaReference(
          element.poster,
          `${element.id || `pptx_video_${index + 1}`}_poster`,
          'image',
          mediaContext,
        ),
        autoplay: element.autoplay === true || element.trigger === 'auto',
        trigger: element.trigger === 'auto' ? 'auto' : 'click',
        ext: normalizeMediaExtension(element.ext ?? element.src),
      },
    ];
  }

  if (rawType === 'audio') {
    return [
      {
        id: element.id || `pptx_audio_${index + 1}`,
        type: 'audio',
        left: roundCanvasNumber(normalized.left),
        top: roundCanvasNumber(normalized.top),
        width: roundCanvasNumber(normalized.width),
        height: roundCanvasNumber(normalized.height),
        rotate: element.rotate ?? 0,
        src:
          normalizeImportedMediaReference(
            element.src,
            element.id || `pptx_audio_${index + 1}`,
            'audio',
            mediaContext,
          ) || '',
        autoplay: element.autoplay === true || element.trigger === 'auto',
        trigger: element.trigger === 'auto' ? 'auto' : 'click',
        loop: element.loop === true,
        ext: normalizeMediaExtension(element.ext ?? element.src),
      },
    ];
  }

  if (isLineShapeElement(element)) {
    const lineEnd = resolveParserLineEndpoint(
      element,
      normalized.width,
      normalized.height,
      textScale,
    );
    return [
      {
        id: element.id || `pptx_line_${index + 1}`,
        type: 'line',
        left: roundCanvasNumber(normalized.left),
        top: roundCanvasNumber(normalized.top),
        width: roundCanvasNumber(normalized.width),
        height: roundCanvasNumber(normalized.height),
        rotate: element.rotate ?? 0,
        ...(element.flipH || element.isFlipH ? { flipH: true } : {}),
        ...(element.flipV || element.isFlipV ? { flipV: true } : {}),
        borderColor: normalizeColor(element.borderColor),
        borderWidth: normalizeBorderWidth(element.borderWidth),
        borderType: metadata?.borderType ?? mapBorderType(element.borderType),
        ...(lineEnd ? { lineEnd } : {}),
      },
    ];
  }

  if (rawType === 'shape') {
    const isOpenConnectorPath = isBentConnectorPathShape(element.shapType);
    const parserPathViewBox = normalizeParserPathViewBox(element.pathViewBox);
    // roundRect is an editor-native preset. pptxtojson can emit a wildly
    // oversized path when WPS stores a large `adj` value for a pill shape
    // (for example 3121875 instead of a normalized DrawingML guide). Rebuild
    // only paths that leave their own viewBox; valid grouped paths stay intact.
    const rebuildCorruptRoundRect =
      element.shapType === 'roundRect' &&
      isCorruptParserRoundRectPath(element.path, parserPathViewBox);
    const normalizedShapePath = rebuildCorruptRoundRect
      ? undefined
      : normalizeParserShapePath({
          path: element.path,
          shapeType: element.shapType,
          width: parserPathViewBox ? undefined : element.width,
          height: parserPathViewBox ? undefined : element.height,
        });
    const sourceFillColor = mapSolidFillColor(element.fill);
    const fillColor = element.strokeOnly || isOpenConnectorPath ? undefined : sourceFillColor;
    const fillGradient =
      element.strokeOnly || isOpenConnectorPath ? undefined : mapFillGradient(element.fill);
    const pattern =
      element.strokeOnly || isOpenConnectorPath
        ? undefined
        : mapShapeFillPattern(element.fill, element.id || `pptx_shape_${index + 1}`, mediaContext);
    const textInsets = importedTextInsets;
    const shapeElement: SlideElementIR = {
      id: element.id || `pptx_shape_${index + 1}`,
      type: 'shape',
      left: roundCanvasNumber(normalized.left),
      top: roundCanvasNumber(normalized.top),
      width: roundCanvasNumber(normalized.width),
      height: roundCanvasNumber(normalized.height),
      rotate: element.rotate ?? 0,
      ...(element.flipH || element.isFlipH ? { flipH: true } : {}),
      ...(element.flipV || element.isFlipV ? { flipV: true } : {}),
      content,
      textType: mapTextType(element.text?.type),
      ...textStyle,
      ...(textInsets ? { textInsets } : {}),
      ...(overflowVisible != null ? { overflowVisible } : {}),
      ...(autoFit ? { autoFit } : {}),
      path: normalizedShapePath,
      viewBox: resolveParserShapeViewBox({
        path: normalizedShapePath,
        shapeType: element.shapType,
        width: element.width,
        height: element.height,
        pathViewBox: parserPathViewBox,
      }),
      subPaths: buildBracePairSubPaths({
        shapeType: element.shapType,
        path: normalizedShapePath,
        viewBox: parserPathViewBox,
        fillColor: sourceFillColor,
        borderColor: normalizeColor(element.borderColor),
        borderWidth: metadata?.borderWidth ?? normalizeBorderWidth(element.borderWidth),
        borderType: metadata?.borderType ?? mapBorderType(element.borderType),
      }),
      shapeType: element.shapType,
      keypoints: metadata?.keypoints,
      pattern,
      ...(metadata?.patternScaleMode ? { patternScaleMode: metadata.patternScaleMode } : {}),
      ...(metadata?.patternCrop ? { patternCrop: metadata.patternCrop } : {}),
      fillColor,
      fillGradient,
      borderColor: normalizeColor(element.borderColor),
      borderWidth: metadata?.borderWidth ?? normalizeBorderWidth(element.borderWidth),
      borderType: metadata?.borderType ?? mapBorderType(element.borderType),
      verticalAlign,
      vertical: element.isVertical === true,
      autoFit,
    };
    if (!shouldPromoteImportedShapeText(element, shapeElement, content)) {
      return [shapeElement];
    }

    const textElement: SlideElementIR = {
      id: shapeElement.id,
      type: 'text',
      left: shapeElement.left,
      top: shapeElement.top,
      width: shapeElement.width,
      height: shapeElement.height,
      rotate: shapeElement.rotate,
      ...(shapeElement.flipH ? { flipH: true } : {}),
      ...(shapeElement.flipV ? { flipV: true } : {}),
      content,
      textType: shapeElement.textType,
      ...textStyle,
      ...(textInsets ? { textInsets } : {}),
      ...(overflowVisible != null ? { overflowVisible } : {}),
      ...(verticalAlign ? { verticalAlign } : {}),
      vertical: false,
      ...(autoFit ? { autoFit } : {}),
      fixedBox: true,
      promotedFromShapeText: true,
    };
    if (!hasVisibleShapeStyle(shapeElement)) return [textElement];

    const backgroundElement: SlideElementIR = {
      ...shapeElement,
      id: `${shapeElement.id}_background`,
      content: undefined,
      sourceShapeId: undefined,
      textType: undefined,
      textInsets: undefined,
      verticalAlign: undefined,
      vertical: undefined,
      autoFit: undefined,
    };
    return [backgroundElement, textElement];
  }

  if (rawType === 'table') {
    return [
      {
        id: element.id || `pptx_table_${index + 1}`,
        type: 'table',
        left: roundCanvasNumber(normalized.left),
        top: roundCanvasNumber(normalized.top),
        width: roundCanvasNumber(normalized.width),
        height: roundCanvasNumber(normalized.height),
        rotate: element.rotate ?? 0,
        table: normalizeImportedTable(element.data ?? [], textScale, tableNoFill),
        tableColWidths: normalizeImportedTableColumnWidths(element.colWidths),
      },
    ];
  }

  if (rawType === 'latex' || rawType === 'formula') {
    return [
      {
        id: element.id || `pptx_formula_${index + 1}`,
        type: 'formula',
        left: roundCanvasNumber(normalized.left),
        top: roundCanvasNumber(normalized.top),
        width: roundCanvasNumber(normalized.width),
        height: roundCanvasNumber(normalized.height),
        rotate: element.rotate ?? 0,
        latex: element.latex || content,
      },
    ];
  }

  const textInsets = importedTextInsets;
  return [
    {
      id: element.id || `pptx_text_${index + 1}`,
      type: 'text',
      left: roundCanvasNumber(normalized.left),
      top: roundCanvasNumber(normalized.top),
      width: roundCanvasNumber(normalized.width),
      height: roundCanvasNumber(normalized.height),
      rotate: element.rotate ?? 0,
      ...(element.flipH || element.isFlipH ? { flipH: true } : {}),
      ...(element.flipV || element.isFlipV ? { flipV: true } : {}),
      content,
      textType: mapTextType(element.text?.type),
      ...textStyle,
      ...(textInsets ? { textInsets } : {}),
      ...(overflowVisible != null ? { overflowVisible } : {}),
      ...(verticalAlign ? { verticalAlign } : {}),
      vertical: element.isVertical === true,
      autoFit,
      ...(promotedTextOnlyShape
        ? {
            fixedBox: true,
            promotedFromShapeText: true,
          }
        : {}),
    },
  ];
}

function shouldPromoteImportedShapeText(
  source: PptxToJsonPageElement,
  shape: SlideElementIR,
  content: string,
): boolean {
  if (source.isVertical === true || (content.match(/<p\b/gi) ?? []).length < 2) return false;
  if (source.shapType === 'rect') return true;
  if (!shape.path || !shape.viewBox) return false;

  try {
    const commands = new SVGPathData(shape.path).toAbs().commands;
    if (
      commands.length < 5 ||
      commands.some(
        (command) =>
          command.type !== SVGPathData.MOVE_TO &&
          command.type !== SVGPathData.LINE_TO &&
          command.type !== SVGPathData.CLOSE_PATH,
      )
    ) {
      return false;
    }
    const bounds = getPathBounds(shape.path);
    const tolerance = Math.max(shape.viewBox[0], shape.viewBox[1], 1) * 0.002;
    return (
      Math.abs(bounds.minX) <= tolerance &&
      Math.abs(bounds.minY) <= tolerance &&
      Math.abs(bounds.maxX - shape.viewBox[0]) <= tolerance &&
      Math.abs(bounds.maxY - shape.viewBox[1]) <= tolerance
    );
  } catch {
    return false;
  }
}

function isLineShapeElement(element: PptxToJsonPageElement): boolean {
  return (
    element.type === 'shape' &&
    typeof element.shapType === 'string' &&
    (element.shapType === 'line' ||
      element.shapType === 'straightConnector' ||
      (/^(?:bentConnector|curvedConnector)/.test(element.shapType) &&
        !isBentConnectorPathShape(element.shapType)))
  );
}

function isBentConnectorPathShape(shapeType?: string): boolean {
  return shapeType === 'bentConnector2' || shapeType === 'bentConnector3';
}

function resolveParserLineEndpoint(
  element: PptxToJsonPageElement,
  frameWidth: number,
  frameHeight: number,
  textScale: number,
): [number, number] | undefined {
  if (!element.path) return undefined;

  try {
    const commands = new SVGPathData(element.path).toAbs().commands;
    let endpoint: [number, number] | undefined;
    for (const command of commands) {
      if (
        'x' in command &&
        'y' in command &&
        Number.isFinite(command.x) &&
        Number.isFinite(command.y)
      ) {
        endpoint = [command.x * textScale, command.y * textScale];
      }
    }
    if (!endpoint) return undefined;

    const [x, y] = endpoint;
    const fitsFrame = (value: number, frame: number) => {
      if (frame <= 0.5) return Math.abs(value) <= 0.5;
      const ratio = Math.abs(value) / frame;
      return ratio >= 0.8 && ratio <= 1.2;
    };
    return fitsFrame(x, frameWidth) && fitsFrame(y, frameHeight) ? endpoint : undefined;
  } catch {
    return undefined;
  }
}

function mapTextType(value: unknown): SlideElementIR['textType'] {
  if (value === 'title' || value === 'subtitle' || value === 'content' || value === 'notes') {
    return value;
  }
  return 'content';
}

function shouldDropParserArtifact(
  rawType: string,
  normalized: Pick<SlideElementIR, 'width' | 'height'>,
  content: string,
) {
  if (rawType !== 'text' && rawType !== 'shape') return false;
  if ((normalized.width > 0.5 && normalized.height > 0.5) || normalizeElementPlainText(content))
    return false;
  return true;
}

function isFullyInvisibleImportedTextContent(content: string): boolean {
  if (!normalizeElementPlainText(content)) return false;

  const styleMatches = Array.from(content.matchAll(/style="([^"]*)"/gi));
  if (styleMatches.length === 0) return false;

  let sawVisibilityStyle = false;

  for (const [, rawStyle] of styleMatches) {
    const visibility = classifyImportedTextStyleVisibility(parseInlineStyle(rawStyle));
    if (visibility === 'visible') return false;
    if (visibility === 'hidden') sawVisibilityStyle = true;
  }

  return sawVisibilityStyle;
}

function classifyImportedTextStyleVisibility(
  styleMap: Record<string, string>,
): 'hidden' | 'visible' | 'unknown' {
  const display = styleMap.display?.trim().toLowerCase();
  const visibility = styleMap.visibility?.trim().toLowerCase();
  const color = (styleMap['-webkit-text-fill-color'] ?? styleMap.color)?.trim().toLowerCase();
  const opacity = normalizeNumberish(styleMap.opacity);

  if (display === 'none' || visibility === 'hidden') return 'hidden';
  if (opacity != null && opacity <= 0) return 'hidden';
  if (color) return isInvisibleImportedTextColor(color) ? 'hidden' : 'visible';
  if (opacity != null && opacity > 0) return 'visible';
  return 'unknown';
}

function isInvisibleImportedTextColor(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized === 'transparent') return true;
  if (/^rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/i.test(normalized)) return true;
  if (/^hsla\([^)]*,\s*0(?:\.0+)?\s*\)$/i.test(normalized)) return true;
  if (/^#[0-9a-f]{8}$/i.test(normalized)) return normalized.slice(7, 9) === '00';
  if (/^#[0-9a-f]{4}$/i.test(normalized)) return normalized[4] === '0';
  return false;
}

function normalizeElementType(element: PptxToJsonPageElement): string {
  if (element.type === 'group') return 'group';
  if (element.type === 'video') return 'video';
  if (element.type === 'audio') return 'audio';
  if (element.fill?.type === 'image') return 'shape';
  if (element.type === 'shape' && hasTextContent(element)) {
    if (element.path || element.fill || element.borderWidth) {
      return 'shape';
    }
    return 'text';
  }
  return element.type || 'text';
}

function hasTextContent(element: PptxToJsonPageElement): boolean {
  return Boolean(
    (typeof element.content === 'string' && element.content.trim()) ||
    (typeof element.text?.content === 'string' && element.text.content.trim()),
  );
}

function roundCanvasNumber(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

function normalizeColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeCssColor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.trim() || undefined;
}

function normalizeBorderWidth(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

function mapBorderType(value: unknown): SlideElementIR['borderType'] {
  if (value === 'dashed' || value === 'dotted' || value === 'solid') return value;
  return undefined;
}

function mapVerticalAlign(value: unknown): SlideElementIR['verticalAlign'] {
  if (value === 'top') return 'top';
  if (value === 'bottom') return 'bottom';
  if (value === 'mid' || value === 'middle' || value === 'center') return 'middle';
  return undefined;
}

function mapAutoFit(
  value: PptxToJsonPageElement['autoFit'],
): SlideElementIR['autoFit'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const type = typeof value.type === 'string' && value.type.trim() ? value.type.trim() : undefined;
  const fontScale = normalizeNumberish(value.fontScale);
  const lnSpcReduction = normalizeNumberish(value.lnSpcReduction);

  if (!type && fontScale == null && lnSpcReduction == null) {
    return undefined;
  }

  return {
    ...(type ? { type } : {}),
    ...(fontScale != null ? { fontScale } : {}),
    ...(lnSpcReduction != null ? { lnSpcReduction } : {}),
  };
}

function mapImageClip(element: PptxToJsonPageElement): SlideElementIR['clip'] | undefined {
  const range = mapImageClipRange(element.rect);
  const shape = mapImageClipShape(element.geom);
  if (!range && !shape) return undefined;

  return {
    range: range ?? [
      [0, 0],
      [100, 100],
    ],
    shape: shape ?? 'rect',
  };
}

function mapImageClipRange(
  rect: PptxToJsonPageElement['rect'],
): NonNullable<SlideElementIR['clip']>['range'] | undefined {
  if (!rect || typeof rect !== 'object') return undefined;
  const left = clampPercent(normalizeNumberish(rect.l) ?? 0);
  const top = clampPercent(normalizeNumberish(rect.t) ?? 0);
  const rightInset = clampPercent(normalizeNumberish(rect.r) ?? 0);
  const bottomInset = clampPercent(normalizeNumberish(rect.b) ?? 0);
  if (left === 0 && top === 0 && rightInset === 0 && bottomInset === 0) {
    return undefined;
  }

  return [
    [left, top],
    [clampPercent(100 - rightInset), clampPercent(100 - bottomInset)],
  ];
}

function mapImageClipShape(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;

  switch (normalized) {
    case 'rect':
      return 'rect';
    case 'roundRect':
    case 'round1Rect':
    case 'round2SameRect':
    case 'round2DiagRect':
    case 'snipRoundRect':
    case 'snip1Rect':
    case 'snip2SameRect':
    case 'snip2DiagRect':
      return 'roundRect';
    case 'ellipse':
    case 'circle':
      return 'ellipse';
    case 'triangle':
    case 'rtTriangle':
    case 'triangle2':
    case 'triangle3':
      return 'triangle';
    case 'diamond':
      return 'rhombus';
    default:
      return normalized.startsWith('custom:') ? 'rect' : normalized;
  }
}

function mapPageBackground(fill: PptxToJsonPage['fill']): SlidePageIR['background'] {
  if (!fill) return undefined;
  if (fill.type === 'color') {
    const color = normalizeColor(fill.value);
    if (!color) return undefined;
    return {
      type: 'solid',
      color,
    };
  }
  if (fill.type === 'image' && fill.value && typeof fill.value === 'object') {
    const rawSrc = fill.value.base64 ?? fill.value.picBase64;
    const src = typeof rawSrc === 'string' ? rawSrc.trim() : undefined;
    if (!src) return undefined;
    return {
      type: 'image',
      src,
      opacity: normalizeOpacity(fill.value.opacity),
    };
  }
  return undefined;
}

function mapSolidFillColor(fill: PptxToJsonPageElement['fill']): string | undefined {
  if (!fill) return undefined;
  if (fill.type === 'color' && typeof fill.value === 'string') {
    return normalizeColor(fill.value);
  }
  return normalizeColor(fill.color);
}

function mapFillGradient(
  fill: PptxToJsonPageElement['fill'],
): SlideElementIR['fillGradient'] | undefined {
  if (!fill || fill.type !== 'gradient' || !fill.value || typeof fill.value !== 'object') {
    return undefined;
  }

  const colors = (fill.value.colors ?? [])
    .map((item) => {
      const pos = normalizePercent(item.pos);
      const color = normalizeColor(item.color);
      if (pos == null || !color) return null;
      return { pos, color };
    })
    .filter((item): item is { pos: number; color: string } => Boolean(item));

  if (colors.length === 0) return undefined;

  return {
    type: fill.value.path === 'circle' || fill.value.path === 'rect' ? 'radial' : 'linear',
    colors,
    rotate: normalizeNumber(fill.value.rot) ?? 0,
  };
}

function normalizePercent(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = Number(value.trim().replace(/%$/, ''));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeNumberish(value: unknown): number | undefined {
  return normalizeNumber(value);
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 100) return 100;
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

function extractTextStyle(
  content: string,
): Pick<
  SlideElementIR,
  | 'defaultFontName'
  | 'defaultColor'
  | 'fontSize'
  | 'fontWeight'
  | 'lineHeight'
  | 'wordSpace'
  | 'paragraphSpace'
> {
  if (!content) return {};

  const paragraphStyle = extractFirstStyle(content, /<p\b[^>]*style="([^"]*)"/i);
  const spanStyle = extractFirstStyle(content, /<span\b[^>]*style="([^"]*)"/i);
  const style = { ...paragraphStyle, ...spanStyle };
  const lineHeight = style['line-height']
    ? cssLineHeight(style['line-height'], style['font-size'])
    : undefined;

  return {
    ...(style['font-family'] ? { defaultFontName: stripCssQuotes(style['font-family']) } : {}),
    ...(style.color ? { defaultColor: style.color } : {}),
    ...(style['font-size'] ? { fontSize: cssSizeToCanvasPx(style['font-size']) } : {}),
    ...(style['font-weight'] ? { fontWeight: style['font-weight'] } : {}),
    ...(lineHeight != null ? { lineHeight } : {}),
    ...(style['letter-spacing'] ? { wordSpace: cssSizeToCanvasPx(style['letter-spacing']) } : {}),
    ...(style['margin-bottom']
      ? { paragraphSpace: cssSizeToCanvasPx(style['margin-bottom']) }
      : {}),
  };
}

function extractFirstStyle(content: string, pattern: RegExp): Record<string, string> {
  const match = content.match(pattern);
  if (!match?.[1]) return {};
  return match[1]
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((acc, part) => {
      const separatorIndex = part.indexOf(':');
      if (separatorIndex <= 0) return acc;
      const key = part.slice(0, separatorIndex).trim().toLowerCase();
      const value = part.slice(separatorIndex + 1).trim();
      if (key && value) acc[key] = value;
      return acc;
    }, {});
}

function stripCssQuotes(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '');
}

function cssSizeToCanvasPx(value: string): number | undefined {
  const trimmed = value.trim();
  const parsed = Number(trimmed.replace(/(pt|px)$/i, ''));
  if (!Number.isFinite(parsed)) return undefined;
  return Math.round((parsed + Number.EPSILON) * 1000) / 1000;
}

function cssLineHeight(value: string, fontSize?: string): number | undefined {
  const match = value.trim().match(/^(\d+(?:\.\d+)?|\.\d+)(pt|px|em|%)?$/i);
  if (!match) return undefined;

  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  if (!unit || unit === 'em') return amount;
  if (unit === '%') return roundCanvasNumber(amount / 100);

  const fontMatch = fontSize?.trim().match(/^(\d+(?:\.\d+)?|\.\d+)(pt|px)$/i);
  if (!fontMatch) return undefined;

  const lineHeightPx = amount * (unit === 'pt' ? 4 / 3 : 1);
  const fontSizePx = Number(fontMatch[1]) * (fontMatch[2].toLowerCase() === 'pt' ? 4 / 3 : 1);
  return fontSizePx > 0 ? roundCanvasNumber(lineHeightPx / fontSizePx) : undefined;
}

function normalizeElementPlainText(content?: string): string {
  if (!content) return '';
  return decodeXmlText(content)
    .replace(/&nbsp;/gi, ' ')
    .replace(/<\s*br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[  -​  　]/g, ' ')
    .replace(/[\s，,。；;：:、·•\-—_\/\\｜|（）()【】\[\]{}<>《》“”"'’‘]+/g, '')
    .trim();
}

function shouldPreserveSingleHanGlyphOverflow({
  content,
  autoFit,
  fontSize,
  width,
  textInsets,
}: {
  content?: string;
  autoFit?: SlideElementIR['autoFit'];
  fontSize?: number;
  width: number;
  textInsets?: SlideElementIR['textInsets'];
}): boolean {
  if (autoFit?.type !== 'shape' || !fontSize || fontSize <= 0 || width <= 0) return false;

  const text = normalizeElementPlainText(content);
  if (!/^[\u3400-\u9fff\uf900-\ufaff]$/u.test(text)) return false;

  const availableWidth = width - (textInsets?.left ?? 0) - (textInsets?.right ?? 0);
  return availableWidth > 0 && fontSize > availableWidth * 1.05;
}

function normalizeElementIdentityText(content?: string): string {
  if (!content) return '';
  return decodeXmlText(content)
    .replace(/&nbsp;/gi, ' ')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/[  -​  　]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeImportedTextContent(content: string, textScale: number): string {
  if (!content) return content;

  const normalized = content
    .replace(
      /(font-size\s*:\s*)(\d+(?:\.\d+)?)(pt|px)/gi,
      (_, prefix: string, rawValue: string) => `${prefix}${scaleCssUnit(rawValue, textScale)}px`,
    )
    .replace(
      /(letter-spacing\s*:\s*)(\d+(?:\.\d+)?)(pt|px)/gi,
      (_, prefix: string, rawValue: string) => `${prefix}${scaleCssUnit(rawValue, textScale)}px`,
    )
    .replace(
      /(line-height\s*:\s*)(\d+(?:\.\d+)?)(pt|px)/gi,
      (_, prefix: string, rawValue: string) => `${prefix}${scaleCssUnit(rawValue, textScale)}px`,
    )
    .replace(
      /(margin-bottom\s*:\s*)(\d+(?:\.\d+)?)(pt|px)/gi,
      (_, prefix: string, rawValue: string) => `${prefix}${scaleCssUnit(rawValue, textScale)}px`,
    )
    .replace(
      /(margin-(?:top|bottom)\s*:\s*)(\d+(?:\.\d+)?)em/gi,
      (_, prefix: string, rawValue: string) =>
        `${prefix}${roundCanvasNumber(Number(rawValue) / 100)}em`,
    );

  const trimmed = trimImportedParagraphTrailingSpaces(
    normalizeImportedListIndent(downgradeTransparentGradientText(normalized), textScale),
  );
  return normalizeImportedFontFamilies(annotateImportedSourceSpaceMetrics(trimmed));
}

function annotateImportedSourceSpaceMetrics(content: string): string {
  return content.replace(/<p\b[^>]*>[\s\S]*?<\/p>/gi, (paragraph) => {
    if (isImportedBlankParagraph(paragraph)) return paragraph;
    const paragraphStyle = parseInlineStyle(
      paragraph.match(/<p\b[^>]*\bstyle=["']([^"']*)["']/i)?.[1] ?? '',
    );
    const sourceAlign = paragraph.match(/\bdata-pptx-align=["']([^"']+)["']/i)?.[1];
    const align = (sourceAlign ?? paragraphStyle['text-align'] ?? '').trim().toLowerCase();
    if (align === 'distributed') return paragraph;

    return paragraph.replace(
      /<span\b([^>]*)>([\s\S]*?)<\/span>/gi,
      (span, rawAttributes: string, body: string) => {
        if (!/(?:&nbsp;|&#160;|&#xA0;|\u00a0)/i.test(body)) return span;
        const style = parseInlineStyle(rawAttributes.match(/\bstyle=["']([^"']*)["']/i)?.[1] ?? '');
        const sourceFont = stripCssQuotes(style['font-family'] ?? '');
        const fontWeight = style['font-weight'];
        const spaceEm = measureImportedSourceSpaceAdvance(sourceFont, fontWeight);
        let attributes = rawAttributes;
        if (sourceFont && !/\bdata-pptx-source-font=/i.test(attributes)) {
          attributes += ` data-pptx-source-font="${escapeXml(sourceFont)}"`;
        }
        if (!/\bdata-pptx-space-em=/i.test(attributes)) {
          attributes += ` data-pptx-space-em="${spaceEm}"`;
        }
        return `<span${attributes}>${body}</span>`;
      },
    );
  });
}

function materializeImportedAuthoredSpaceWidths(content: string): string {
  return content.replace(/<p\b[^>]*>[\s\S]*?<\/p>/gi, (paragraph) => {
    if (isImportedBlankParagraph(paragraph)) return paragraph;
    const paragraphStyle = parseInlineStyle(
      paragraph.match(/<p\b[^>]*\bstyle=["']([^"']*)["']/i)?.[1] ?? '',
    );
    const align = (paragraphStyle['text-align'] ?? '').trim().toLowerCase();
    const sourceAlign = paragraph.match(/\bdata-pptx-align=["']([^"']+)["']/i)?.[1];
    const metricText = normalizeImportedMetricText(paragraph);
    const isFormulaParagraph = /[÷×+−-]/u.test(metricText) && /=/u.test(metricText);
    const hasParenthesizedPlaceholder = /[（(]\s+[)）]/u.test(metricText);
    if (align === 'distributed' || sourceAlign?.trim().toLowerCase() === 'distributed') {
      return paragraph;
    }

    const metricStack: Array<{
      spaceEm: number;
      sourceFont?: string;
      letterSpacingPx: number;
    }> = [];
    let insideParentheses = false;
    return paragraph.replace(/<[^>]+>|[^<]+/g, (token) => {
      if (/^<span\b/i.test(token)) {
        const inherited = metricStack[metricStack.length - 1];
        const rawSpaceEm = Number(token.match(/\bdata-pptx-space-em=["']([\d.]+)["']/i)?.[1]);
        const style = parseInlineStyle(token.match(/\bstyle=["']([^"']*)["']/i)?.[1] ?? '');
        const hasLetterSpacing = Object.prototype.hasOwnProperty.call(style, 'letter-spacing');
        const parsedLetterSpacing = hasLetterSpacing
          ? cssSizeToCanvasPx(style['letter-spacing'] ?? '')
          : undefined;
        const sourceFont =
          token.match(/\bdata-pptx-source-font=["']([^"']+)["']/i)?.[1] ?? inherited?.sourceFont;
        metricStack.push({
          spaceEm:
            Number.isFinite(rawSpaceEm) && rawSpaceEm > 0
              ? rawSpaceEm
              : (inherited?.spaceEm ?? 0.25),
          ...(sourceFont ? { sourceFont } : {}),
          letterSpacingPx: parsedLetterSpacing ?? inherited?.letterSpacingPx ?? 0,
        });
        return token;
      }
      if (/^<\/span\b/i.test(token)) {
        metricStack.pop();
        return token;
      }
      if (token.startsWith('<')) {
        return token;
      }
      const metric = metricStack[metricStack.length - 1] ?? {
        spaceEm: 0.25,
        letterSpacingPx: 0,
      };
      return token.replace(/[（()]|）|(?:&nbsp;|&#160;|&#xA0;|\u00a0)/gi, (match) => {
        if (match === '(' || match === '（') {
          insideParentheses = true;
          return match;
        }
        if (match === ')' || match === '）') {
          insideParentheses = false;
          return match;
        }

        const usesKaiTiPlaceholderMetrics =
          resolveKnownPptxSourceSpaceAdvance(metric.sourceFont ?? '') === 0.25;
        const spaceEm =
          (isFormulaParagraph ||
            (hasParenthesizedPlaceholder && insideParentheses && usesKaiTiPlaceholderMetrics)) &&
          metric.letterSpacingPx <= 0
            ? Math.max(metric.spaceEm, 0.5)
            : metric.spaceEm;
        const sourceFontAttribute = metric.sourceFont
          ? ` data-pptx-source-font="${escapeXml(metric.sourceFont)}"`
          : '';
        const letterSpacingAttribute =
          metric.letterSpacingPx > 0
            ? ` data-pptx-space-letter-spacing="${metric.letterSpacingPx}px"`
            : '';
        const authoredSpaceWidth =
          metric.letterSpacingPx > 0
            ? `calc(${spaceEm}em + ${metric.letterSpacingPx}px)`
            : `${spaceEm}em`;
        const authoredSpaceLetterSpacing =
          metric.letterSpacingPx > 0 ? ' letter-spacing: 0px;' : '';
        // Keep a real non-breaking-space text node inside the metric span. An
        // empty inline span renders correctly in the static view, but rich-text
        // parsers discard it when the user enters edit mode.
        return `<span data-pptx-authored-space="true"${sourceFontAttribute} data-pptx-space-em="${spaceEm}"${letterSpacingAttribute} style="display: inline-block; width: ${authoredSpaceWidth}; white-space: pre;${authoredSpaceLetterSpacing}">&#160;</span>`;
      });
    });
  });
}

function materializeImportedElementSpaceWidths(elements: SlideElementIR[]): SlideElementIR[] {
  return elements.map((element) =>
    element.content
      ? { ...element, content: materializeImportedAuthoredSpaceWidths(element.content) }
      : element,
  );
}

function measureImportedSourceSpaceAdvance(fontFamily: string, fontWeight?: string): number {
  const normalizedFamily = fontFamily.trim().toLowerCase();
  const normalizedWeight = /^\d+$/.test(fontWeight ?? '') ? fontWeight! : '400';
  const cacheKey = `${normalizedWeight}:${normalizedFamily || 'default'}`;
  const cached = importedSpaceAdvanceCache.get(cacheKey);
  if (cached != null) return cached;

  const sourceMetric = resolveKnownPptxSourceSpaceAdvance(normalizedFamily);
  const fallback = fallbackImportedSourceSpaceAdvance(normalizedFamily);
  let measured = sourceMetric ?? fallback;
  if (sourceMetric == null) {
    try {
      const measurementFamily = resolveImportedMeasurementFontFamily(fontFamily);
      if (measurementFamily && ensureImportedMeasurementFont(measurementFamily)) {
        const escapedFamily = measurementFamily.replace(/["\\]/g, '\\$&');
        importedFontMeasureContext.font = `${normalizedWeight} 100px "${escapedFamily}"`;
        const candidate = importedFontMeasureContext.measureText(' ').width / 100;
        if (Number.isFinite(candidate) && candidate >= 0.12 && candidate <= 0.7) {
          measured = candidate;
        }
      }
    } catch {
      measured = fallback;
    }
  }

  const rounded = roundCanvasNumber(measured);
  importedSpaceAdvanceCache.set(cacheKey, rounded);
  return rounded;
}

function ensureImportedMeasurementFont(fontFamily: string): boolean {
  if (GlobalFonts.has(fontFamily)) return true;
  const fileSegments = IMPORTED_MEASUREMENT_FONT_FILES[fontFamily.trim().toLowerCase()];
  if (!fileSegments || importedMeasurementFontRegistrations.has(fontFamily)) {
    return false;
  }

  importedMeasurementFontRegistrations.add(fontFamily);
  try {
    const fontPath = resolveImportDependency(fileSegments.join('/'));
    GlobalFonts.registerFromPath(fontPath, fontFamily);
  } catch {
    return false;
  }
  return GlobalFonts.has(fontFamily);
}

function resolveKnownPptxSourceSpaceAdvance(fontFamily: string): number | undefined {
  // Keep source layout metrics independent from the browser render-font mapping.
  // The KaiTi family uses quarter-em ASCII spaces in Office/WPS. The available
  // measurement substitute reports 0.5em, which makes authored spacer runs
  // overflow and forces a destructive horizontal fit in the browser.
  if (/^(?:楷体(?:_gb2312)?|kaiti(?:_gb2312)?|华文楷体|stkaiti)$/u.test(fontFamily)) {
    return 0.25;
  }
  return undefined;
}

function resolveImportedMeasurementFontFamily(fontFamily: string): string | undefined {
  const normalized = fontFamily.trim().toLowerCase();
  if (!normalized) return undefined;
  const aliases: Record<string, string> = {
    宋体: 'SimSun',
    新宋体: 'NSimSun',
    黑体: 'SimHei',
    楷体: 'KaiTi',
    楷体_gb2312: 'KaiTi',
    华文楷体: 'KaiTi',
    stkaiti: 'KaiTi',
    华文行楷: 'KaiTi',
    stxingkai: 'KaiTi',
    仿宋: 'FangSong',
    仿宋_gb2312: 'FangSong',
    微软雅黑: 'Microsoft YaHei',
    abeezee: 'ABeeZee',
    'abeezee regular': 'ABeeZee',
    'abeezee bold': 'ABeeZee',
  };
  return aliases[normalized] ?? stripCssQuotes(fontFamily.trim().split(',')[0] ?? '');
}

function fallbackImportedSourceSpaceAdvance(fontFamily: string): number {
  if (/courier|consolas|cousine/.test(fontFamily)) return 0.6;
  if (
    /simsun|nsimsun|simhei|kaiti|stkaiti|stxingkai|fangsong|宋体|新宋体|黑体|楷体|华文楷体|华文行楷|仿宋/.test(
      fontFamily,
    )
  ) {
    return 0.5;
  }
  if (/microsoft yahei|微软雅黑/.test(fontFamily)) return 0.296;
  if (/calibri|aptos|carlito/.test(fontFamily)) return 0.226;
  if (/cambria|caladea/.test(fontFamily)) return 0.22;
  if (/arial|helvetica|tahoma|verdana|arimo|segoe/.test(fontFamily)) return 0.278;
  return 0.25;
}

function trimImportedParagraphTrailingSpaces(content: string): string {
  return content.replace(/<p\b[^>]*>[\s\S]*?<\/p>/gi, (paragraph) => {
    if (isImportedBlankParagraph(paragraph)) return paragraph;
    return paragraph.replace(
      /(?:(?:&nbsp;|&#160;|&#xA0;|\u00a0|[ \t])+)(?=(?:<\/(?:span|a|strong|em|b|i)>)*\s*<\/p>$)/gi,
      '',
    );
  });
}

function isImportedBlankParagraph(paragraph: string): boolean {
  return !paragraph
    .replace(/<[^>]+>/g, '')
    .replace(/(?:&nbsp;|&#160;|&#xA0;|\u00a0)/gi, '')
    .trim();
}

function applyImportedEmptyParagraphFontSizes(
  content: string,
  fontSizes?: Record<number, number>,
): string {
  if (!content || !fontSizes) return content;

  let normalized = content;
  for (const [paragraphIndex, fontSize] of Object.entries(fontSizes)) {
    const pattern = new RegExp(
      `<p\\b(?=[^>]*\\bdata-pptx-paragraph-index=["']${paragraphIndex}["'])[^>]*>[\\s\\S]*?<\\/p>`,
      'i',
    );
    normalized = normalized.replace(pattern, (paragraph) => {
      if (!isImportedBlankParagraph(paragraph)) return paragraph;
      return paragraph.replace(
        /(font-size\s*:\s*)\d+(?:\.\d+)?px/i,
        `$1${roundCanvasNumber(fontSize)}px`,
      );
    });
  }
  return normalized;
}

function applyImportedParagraphLayout(
  content: string,
  distributedParagraphIndexes?: number[],
  paragraphLineHeights?: Record<number, PptxParagraphLineHeight>,
  paragraphAlignments?: Record<number, PptxParagraphAlignment>,
  paragraphSpaceBefore?: Record<number, PptxParagraphSpacing>,
): string {
  if (!content) return content;

  let fallbackIndex = 0;
  return content.replace(/<p\b([^>]*)>[\s\S]*?<\/p>/gi, (paragraph, rawAttrs: string) => {
    const attrs = String(rawAttrs ?? '');
    const explicitIndex = Number(attrs.match(/\bdata-pptx-paragraph-index=["'](\d+)["']/i)?.[1]);
    const paragraphIndex = Number.isInteger(explicitIndex) ? explicitIndex : fallbackIndex;
    const paragraphPosition = fallbackIndex;
    fallbackIndex += 1;

    return paragraph.replace(/<p\b([^>]*)>/i, (_match, currentRawAttrs: string) => {
      let nextAttrs = String(currentRawAttrs ?? '');
      const styleMatch = nextAttrs.match(/\sstyle="([^"]*)"/i);
      const styleMap = parseInlineStyle(styleMatch?.[1] ?? '');
      const lineHeight = paragraphLineHeights?.[paragraphIndex];
      if (lineHeight != null) styleMap['line-height'] = lineHeight.toString();

      const spaceBefore = paragraphSpaceBefore?.[paragraphIndex];
      if (spaceBefore) {
        // CSS paragraph margins collapse and resolve `em` against the paragraph
        // wrapper's 16px font, not the actual PowerPoint run size. Materialize
        // the DrawingML spacing as padding so adjacent paragraph advances match
        // Office. PowerPoint ignores space-before on the first paragraph.
        delete styleMap['margin-top'];
        styleMap['padding-top'] =
          paragraphPosition === 0
            ? '0px'
            : `${resolveImportedParagraphSpacingPixels(paragraph, lineHeight, spaceBefore)}px`;
      }

      const alignment =
        paragraphAlignments?.[paragraphIndex] ??
        (distributedParagraphIndexes?.includes(paragraphIndex) ? 'distributed' : undefined);
      if (alignment === 'distributed') {
        const glyphCount = Array.from(
          decodeXmlText(
            paragraph.replace(/<[^>]+>/g, '').replace(/(?:&nbsp;|&#160;|&#xA0;|\u00a0)/gi, ' '),
          ).replace(/\s/gu, ''),
        ).length;
        styleMap['text-align'] = glyphCount === 1 ? 'center' : 'justify';
        if (glyphCount === 1) {
          delete styleMap['text-align-last'];
          delete styleMap['text-justify'];
        } else {
          styleMap['text-align-last'] = 'justify';
          styleMap['text-justify'] = 'inter-character';
        }
      } else if (alignment) {
        styleMap['text-align'] = alignment;
        delete styleMap['text-align-last'];
        delete styleMap['text-justify'];
      }

      const nextStyle = `style="${serializeInlineStyle(styleMap)}"`;
      nextAttrs = styleMatch
        ? nextAttrs.replace(styleMatch[0], ` ${nextStyle}`)
        : `${nextAttrs} ${nextStyle}`;
      if (!/\bdata-pptx-source=/i.test(nextAttrs)) {
        nextAttrs += ' data-pptx-source="true"';
      }
      if (alignment) {
        nextAttrs = /\bdata-pptx-align=["'][^"']*["']/i.test(nextAttrs)
          ? nextAttrs.replace(/\bdata-pptx-align=["'][^"']*["']/i, `data-pptx-align="${alignment}"`)
          : `${nextAttrs} data-pptx-align="${alignment}"`;
      }
      return `<p${nextAttrs}>`;
    });
  });
}

function resolveImportedParagraphSpacingPixels(
  paragraph: string,
  lineHeight: PptxParagraphLineHeight | undefined,
  spacing: PptxParagraphSpacing,
): number {
  if (spacing.unit === 'px') return roundCanvasNumber(spacing.value);

  const fontSizes = [...paragraph.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px/gi)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && value > 0);
  const fontSize = fontSizes.length > 0 ? Math.max(...fontSizes) : 16;
  const fixedLineHeight =
    typeof lineHeight === 'string' && /px$/i.test(lineHeight)
      ? Number.parseFloat(lineHeight)
      : undefined;
  const relativeLineHeight =
    typeof lineHeight === 'number'
      ? lineHeight
      : typeof lineHeight === 'string' && /^\d+(?:\.\d+)?$/.test(lineHeight)
        ? Number(lineHeight)
        : PPTX_NORMAL_LINE_HEIGHT;
  const lineBoxHeight =
    fixedLineHeight != null && Number.isFinite(fixedLineHeight)
      ? fixedLineHeight
      : fontSize * relativeLineHeight;
  return roundCanvasNumber(lineBoxHeight * spacing.value);
}

function applyImportedDefaultLineHeight(
  content: string,
  paragraphLineHeights?: Record<number, PptxParagraphLineHeight>,
): string {
  if (!content) return content;

  // An omitted DrawingML <a:lnSpc> uses PowerPoint's default leading. The
  // parser's generic line-height:1 is too tight for multi-line CJK text. Keep
  // explicit source percentages (including 100%) unchanged, including when a
  // text box mixes explicit and implicit paragraphs.
  let fallbackIndex = 0;
  return content.replace(/<p\b([^>]*)>[\s\S]*?<\/p>/gi, (paragraph, rawAttrs: string) => {
    const attrs = String(rawAttrs ?? '');
    const explicitIndex = Number(attrs.match(/\bdata-pptx-paragraph-index=["'](\d+)["']/i)?.[1]);
    const paragraphIndex = Number.isInteger(explicitIndex) ? explicitIndex : fallbackIndex;
    fallbackIndex += 1;
    if (
      paragraphLineHeights &&
      Object.prototype.hasOwnProperty.call(paragraphLineHeights, paragraphIndex)
    ) {
      return paragraph;
    }
    return paragraph.replace(/<p\b([^>]*)>/i, (openingTag, openingAttrs: string) => {
      const styleMatch = String(openingAttrs ?? '').match(/\sstyle="([^"]*)"/i);
      if (!styleMatch) return openingTag;
      const styleMap = parseInlineStyle(styleMatch[1] ?? '');
      if (!/^1(?:\.0+)?$/.test(styleMap['line-height'] ?? '')) return openingTag;
      styleMap['line-height'] = '1.2';
      const nextStyle = `style="${serializeInlineStyle(styleMap)}"`;
      return `<p${String(openingAttrs).replace(styleMatch[0], ` ${nextStyle}`)}>`;
    });
  });
}

function applyImportedTextMetricPolicy(
  content: string,
  autoFit?: SlideElementIR['autoFit'],
): string {
  if (!content || autoFit?.type !== 'shape') return content;
  return content.replace(
    /<p\b([^>]*)>([\s\S]*?)<\/p>/gi,
    (paragraph, rawAttrs: string, body: string) => {
      if (/<br\b/i.test(body)) return paragraph;
      const spacingText = body
        .replace(
          /<span\b[^>]*\bdata-pptx-authored-space=["']true["'][^>]*>[\s\S]*?<\/span>/gi,
          '\u00a0',
        )
        .replace(/<[^>]+>/g, '')
        .replace(/(?:&nbsp;|&#160;|&#xA0;|\u00a0)/gi, '\u00a0')
        .replace(/^[\s\u00a0]+|[\s\u00a0]+$/g, '');
      if ((spacingText.match(/\u00a0/g) ?? []).length < 2) return paragraph;

      const visibleText = decodeXmlText(
        body
          .replace(
            /<span\b[^>]*\bdata-pptx-authored-space=["']true["'][^>]*>[\s\S]*?<\/span>/gi,
            '',
          )
          .replace(/<[^>]+>/g, '')
          .replace(/(?:&nbsp;|&#160;|&#xA0;|\u00a0)/gi, '')
          .replace(/&[^;]+;/g, ''),
      );
      if (Array.from(visibleText.trim()).length > 48) return paragraph;

      let attrs = String(rawAttrs ?? '');
      if (!/\bdata-pptx-preserve-metrics=/i.test(attrs)) {
        attrs += ' data-pptx-preserve-metrics="true"';
      }
      if (!/\bdata-pptx-space-mode=/i.test(attrs)) {
        attrs += ' data-pptx-space-mode="powerpoint"';
      }
      return `<p${attrs}>${body}</p>`;
    },
  );
}

function normalizeImportedFontFamilies(content: string): string {
  return content.replace(
    /(font-family\s*:\s*)([^;"]+)/gi,
    (_match, prefix: string, rawValue: string) => {
      const value = rawValue.trim();
      return `${prefix}${resolveImportedCssFontFamily(stripCssQuotes(value)) ?? value}`;
    },
  );
}

function applyImportedNoWrap(content: string, noWrap?: boolean): string {
  if (!content || !noWrap) return content;
  return content.replace(/<p\b([^>]*)>/gi, (_match, rawAttrs: string) => {
    const attrs = String(rawAttrs ?? '');
    const styleMatch = attrs.match(/\sstyle="([^"]*)"/i);
    const styleMap = parseInlineStyle(styleMatch?.[1] ?? '');
    styleMap['white-space'] = 'nowrap';
    styleMap['overflow-wrap'] = 'normal';
    styleMap['word-break'] = 'normal';
    const nextStyle = `style="${serializeInlineStyle(styleMap)}"`;
    return styleMatch
      ? `<p${attrs.replace(styleMatch[0], ` ${nextStyle}`)}>`
      : `<p${attrs} ${nextStyle}>`;
  });
}

function applyImportedTextHighlights(
  content: string | undefined,
  highlights: PptxTextHighlight[] | undefined,
): string | undefined {
  if (!content || !highlights?.length) return content;
  const pending = highlights.map((highlight) => ({ ...highlight, applied: false }));

  return content.replace(/<span\b([^>]*)>([^<]*)<\/span>/gi, (match, attrs, body) => {
    let nextBody = String(body);
    for (const highlight of pending) {
      if (highlight.applied) continue;
      const pattern = buildImportedTextFragmentPattern(highlight.text);
      if (!pattern?.test(nextBody)) continue;
      highlight.applied = true;
      const color = normalizeCssColor(highlight.color) ?? highlight.color;
      nextBody = nextBody.replace(
        pattern,
        (text) =>
          `<span style="background-color: ${color}">${text.replace(/(?:&nbsp;|&#160;|&#xA0;|\u00a0)/gi, ' ')}</span>`,
      );
    }
    return nextBody === body ? match : `<span${attrs}>${nextBody}</span>`;
  });
}

function buildImportedTextFragmentPattern(value: string): RegExp | undefined {
  const text = value.trim();
  if (!text) return undefined;
  const pattern = Array.from(text)
    .map((char) => {
      if (/\s/u.test(char)) return '(?:\\s|&nbsp;|&#160;|&#xA0;)+';
      if (char === '&') return '(?:&amp;|&)';
      if (char === "'") return "(?:'|&apos;|&#39;|&#x27;)";
      if (char === '"') return '(?:"|&quot;|&#34;|&#x22;)';
      if (char === '<') return '(?:&lt;|<)';
      if (char === '>') return '(?:&gt;|>)';
      return escapeRegExp(char);
    })
    .join('');
  return new RegExp(pattern, 'i');
}

function scaleCssUnit(rawValue: string, textScale: number): string {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return rawValue;
  return roundCanvasNumber(parsed * textScale).toString();
}

function normalizeImportedListIndent(content: string, textScale: number): string {
  const padding = `${roundCanvasNumber(17.142 * textScale)}px`;
  return content.replace(/<ul\b([^>]*)>/gi, (_match, rawAttrs: string) => {
    const attrs = String(rawAttrs ?? '');
    const styleMatch = attrs.match(/\sstyle="([^"]*)"/i);
    const styleMap = parseInlineStyle(styleMatch?.[1] ?? '');
    styleMap['padding-left'] ??= padding;
    styleMap['margin-left'] ??= '0';
    styleMap['margin-top'] ??= '0';
    styleMap['margin-bottom'] ??= '0';

    const nextStyle = `style="${serializeInlineStyle(styleMap)}"`;
    if (styleMatch) {
      return `<ul${attrs.replace(styleMatch[0], ` ${nextStyle}`)}>`;
    }
    return `<ul${attrs} ${nextStyle}>`;
  });
}

function downgradeTransparentGradientText(content: string): string {
  return content.replace(/style="([^"]*)"/gi, (match, rawStyle: string) => {
    const styleMap = parseInlineStyle(rawStyle);
    if (!isTransparentGradientTextStyle(styleMap)) return match;

    const fallbackColor =
      extractGradientFallbackColor(styleMap.background) ??
      extractGradientFallbackColor(styleMap['background-image']) ??
      DEFAULT_IMPORT_THEME.fontColor;

    delete styleMap.background;
    delete styleMap['background-image'];
    delete styleMap['background-clip'];
    delete styleMap['-webkit-background-clip'];
    delete styleMap['-webkit-text-fill-color'];
    styleMap.color = fallbackColor;

    return `style="${serializeInlineStyle(styleMap)}"`;
  });
}

function parseInlineStyle(styleText: string): Record<string, string> {
  return styleText
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((acc, part) => {
      const separatorIndex = part.indexOf(':');
      if (separatorIndex <= 0) return acc;
      const key = part.slice(0, separatorIndex).trim().toLowerCase();
      const value = part.slice(separatorIndex + 1).trim();
      if (key && value) acc[key] = value;
      return acc;
    }, {});
}

function serializeInlineStyle(styleMap: Record<string, string>): string {
  return Object.entries(styleMap)
    .map(([key, value]) => `${key}: ${value}`)
    .join('; ');
}

function isTransparentGradientTextStyle(styleMap: Record<string, string>): boolean {
  const clip = styleMap['background-clip'] ?? styleMap['-webkit-background-clip'];
  const color = styleMap.color?.trim().toLowerCase();
  const fillColor = styleMap['-webkit-text-fill-color']?.trim().toLowerCase();
  const background = styleMap.background ?? styleMap['background-image'];

  return (
    clip === 'text' &&
    typeof background === 'string' &&
    /linear-gradient|radial-gradient/i.test(background) &&
    (color === 'transparent' || fillColor === 'transparent')
  );
}

function extractGradientFallbackColor(background?: string): string | undefined {
  if (!background) return undefined;
  const colorMatches = Array.from(
    background.matchAll(/#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8}|[0-9a-fA-F]{3}|[0-9a-fA-F]{4})\b/g),
  );
  if (colorMatches.length === 0) return undefined;
  const middleIndex = Math.floor(colorMatches.length / 2);
  return colorMatches[middleIndex]?.[0];
}

function flattenPageElements(
  elements: PptxToJsonPageElement[],
  transform: ParserFlattenTransform = identityParserFlattenTransform(),
  sourceGroupShapeIds: string[] = [],
): PptxToJsonPageElement[] {
  return elements.flatMap((element) => {
    const transformedRect = transformParserElementFrame(element, transform.matrix);
    const elementRotate = normalizeRotation((element.rotate ?? 0) + transform.rotation);
    const elementFlipH = Boolean(element.flipH || element.isFlipH);
    const elementFlipV = Boolean(element.flipV || element.isFlipV);
    const effectiveFlipH = elementFlipH !== transform.flipH;
    const effectiveFlipV = elementFlipV !== transform.flipV;
    const absoluteElement: PptxToJsonPageElement = {
      ...element,
      left: transformedRect.left,
      top: transformedRect.top,
      width: transformedRect.width,
      height: transformedRect.height,
      rotate: elementRotate,
      flipH: effectiveFlipH,
      flipV: effectiveFlipV,
      isFlipH: effectiveFlipH,
      isFlipV: effectiveFlipV,
      ...(sourceGroupShapeIds.length > 0 ? { sourceGroupShapeIds } : {}),
    };

    if (element.type !== 'group') {
      return [absoluteElement];
    }

    return flattenPageElements(
      element.elements ?? [],
      combineParserFlattenTransforms(transform, element),
      element.sourceShapeId ? [...sourceGroupShapeIds, element.sourceShapeId] : sourceGroupShapeIds,
    );
  });
}

function sortParserElementsBySourceOrder(
  elements: PptxToJsonPageElement[],
): PptxToJsonPageElement[] {
  const ordered = elements.map((element, index) => ({
    element,
    index,
    order: normalizeNumber(element.order),
  }));
  if (ordered.some((entry) => entry.order == null)) return elements;

  return ordered
    .sort((left, right) => left.order! - right.order! || left.index - right.index)
    .map((entry) => entry.element);
}

function identityParserFlattenTransform(): ParserFlattenTransform {
  return {
    matrix: [1, 0, 0, 1, 0, 0],
    rotation: 0,
    flipH: false,
    flipV: false,
  };
}

function combineParserFlattenTransforms(
  parent: ParserFlattenTransform,
  group: PptxToJsonPageElement,
): ParserFlattenTransform {
  const groupMatrix = createParserElementMatrix(group);
  return {
    matrix: multiplyParserMatrices(parent.matrix, groupMatrix),
    rotation: normalizeRotation(parent.rotation + (group.rotate ?? 0)),
    flipH: parent.flipH !== Boolean(group.flipH || group.isFlipH),
    flipV: parent.flipV !== Boolean(group.flipV || group.isFlipV),
  };
}

function createParserElementMatrix(
  element: PptxToJsonPageElement,
): [number, number, number, number, number, number] {
  const left = element.left ?? 0;
  const top = element.top ?? 0;
  const width = element.width ?? 0;
  const height = element.height ?? 0;
  const rotation = element.rotate ?? 0;
  const flipH = Boolean(element.flipH || element.isFlipH);
  const flipV = Boolean(element.flipV || element.isFlipV);

  const scaleX = flipH ? -1 : 1;
  const scaleY = flipV ? -1 : 1;
  const reflection: [number, number, number, number, number, number] = [
    scaleX,
    0,
    0,
    scaleY,
    flipH ? width : 0,
    flipV ? height : 0,
  ];
  if (!rotation) {
    return [scaleX, 0, 0, scaleY, left + (flipH ? width : 0), top + (flipV ? height : 0)];
  }

  const centerX = width / 2;
  const centerY = height / 2;
  const radians = (rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const rotateAroundCenter: [number, number, number, number, number, number] = [
    cos,
    sin,
    -sin,
    cos,
    centerX - cos * centerX + sin * centerY,
    centerY - sin * centerX - cos * centerY,
  ];
  const rotated = multiplyParserMatrices(rotateAroundCenter, reflection);
  return multiplyParserMatrices([1, 0, 0, 1, left, top], rotated);
}

function transformParserElementFrame(
  element: PptxToJsonPageElement,
  matrix: [number, number, number, number, number, number],
): { left: number; top: number; width: number; height: number } {
  const left = element.left ?? 0;
  const top = element.top ?? 0;
  const width = element.width ?? 0;
  const height = element.height ?? 0;
  if (width === 0 && height === 0) {
    const point = transformParserPoint(left, top, matrix);
    return {
      left: point.x,
      top: point.y,
      width,
      height,
    };
  }

  const center = transformParserPoint(left + width / 2, top + height / 2, matrix);
  const scaleX = Math.hypot(matrix[0], matrix[1]);
  const scaleY = Math.hypot(matrix[2], matrix[3]);
  const transformedWidth = width * scaleX;
  const transformedHeight = height * scaleY;
  return {
    left: center.x - transformedWidth / 2,
    top: center.y - transformedHeight / 2,
    width: transformedWidth,
    height: transformedHeight,
  };
}

function transformParserPoint(
  x: number,
  y: number,
  matrix: [number, number, number, number, number, number],
): { x: number; y: number } {
  const [a, b, c, d, e, f] = matrix;
  return {
    x: a * x + c * y + e,
    y: b * x + d * y + f,
  };
}

function multiplyParserMatrices(
  left: [number, number, number, number, number, number],
  right: [number, number, number, number, number, number],
): [number, number, number, number, number, number] {
  const [a1, b1, c1, d1, e1, f1] = left;
  const [a2, b2, c2, d2, e2, f2] = right;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

function normalizeRotation(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const normalized = value % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function mapShapeFillPattern(
  fill: PptxToJsonPageElement['fill'],
  elementId?: string,
  mediaContext?: PptxImportMediaContext,
): string | undefined {
  if (!fill || fill.type !== 'image' || !fill.value || typeof fill.value !== 'object') {
    return undefined;
  }

  return normalizeImportedMediaReference(
    fill.value.base64 ?? fill.value.picBase64,
    elementId ? `${elementId}_pattern` : undefined,
    'image',
    mediaContext,
  );
}

function normalizeDataUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.startsWith('data:') ? trimmed : undefined;
}

async function extractPptxSlideSupplementsFromZip(
  zip: JSZip,
  mediaContext?: PptxImportMediaContext,
): Promise<PptxSlideSupplement[]> {
  const presentationXml = await readZipText(zip, 'ppt/presentation.xml');
  const applicationXml = await readZipText(zip, 'docProps/app.xml');
  const application = applicationXml?.match(
    /<(?:\w+:)?Application\b[^>]*>([\s\S]*?)<\/(?:\w+:)?Application>/i,
  )?.[1];
  const usesWpsMotionCoordinates = /\b(?:WPS|Kingsoft)\b/i.test(decodeXmlText(application ?? ''));
  const slideSize = extractPresentationSlideSize(presentationXml);
  const slidePaths = extractSortedSlidePaths(zip);
  await recordPptxAuxiliaryMasterWarnings(zip, mediaContext);

  const supplements: PptxSlideSupplement[] = [];
  for (const [pageIndex, slidePath] of slidePaths.entries()) {
    const slideXml = await readZipText(zip, slidePath);
    if (!slideXml) {
      supplements.push({ background: undefined, elementMetadata: [], fallbackElements: [] });
      continue;
    }
    const elementMetadata = extractSlideElementMetadata(
      slideXml,
      slideSize.width,
      slideSize.height,
    );
    const tableNoFillBySourceId = extractTableNoFillBySourceId(slideXml);
    const timing = parsePptxTiming(slideXml);
    if (timing.accepted && usesWpsMotionCoordinates) {
      for (const item of timing.animation.steps.flatMap((step) => step.items)) {
        if (item.motion) item.motion.xScaleBasis = 'height';
      }
    }
    if (timing.accepted) {
      for (const warning of timing.warnings ?? []) {
        recordPptxTimingWarning(mediaContext, slidePath, pageIndex, warning, true);
      }
    } else {
      recordPptxTimingWarning(mediaContext, slidePath, pageIndex, timing.warning, false);
    }
    const relationships = parseRelationshipEntries(
      await readZipText(zip, getSlideRelsPath(slidePath)),
    );
    await recordPptxContentWarnings(
      zip,
      slidePath,
      slideXml,
      relationships,
      pageIndex,
      mediaContext,
    );
    const layoutContext = await extractSlideLayoutContext(zip, slidePath, relationships);
    const themeFonts = await extractSlideThemeFonts(zip, layoutContext);
    const themeStyle = await extractSlideThemeStyleContext(zip, layoutContext);
    const background = await extractSlideBackgroundWithLayoutFallback(
      zip,
      slidePath,
      slideXml,
      relationships,
      slideSize,
      mediaContext,
    );
    const fallbackElements = await extractSlideFallbackElements(
      zip,
      slidePath,
      slideXml,
      relationships,
      slideSize,
      mediaContext,
      layoutContext,
      themeStyle,
    );
    const sourceNames = new Map<string, string>();
    for (const tag of slideXml.match(/<(?:\w+:)?cNvPr\b[^>]*>/g) ?? []) {
      const id = extractXmlAttr(tag, 'id'), name = extractXmlAttr(tag, 'name');
      if (id && name && name.length <= 200) sourceNames.set(id, name);
    }
    supplements.push({
      sourceNames,
      background,
      elementMetadata,
      fallbackElements,
      ...(tableNoFillBySourceId.size > 0 ? { tableNoFillBySourceId } : {}),
      themeFonts,
      ...(timing.accepted && timing.animation.steps.length > 0
        ? { pptxAnimation: timing.animation }
        : {}),
    });
  }
  return supplements;
}

function normalizeImportedTable(
  rows: PptxToJsonTableCell[][],
  textScale: number,
  noFillRows?: boolean[][],
): PptxToJsonTableCell[][] {
  return rows.map((row, rowIndex) =>
    row.map((cell, cellIndex) => {
      const noFill = noFillRows?.[rowIndex]?.[cellIndex] === true;
      if (typeof cell === 'string') {
        const text = normalizeImportedTextContent(cell, textScale);
        return noFill ? { text, fillColor: 'transparent' } : text;
      }
      return {
        ...cell,
        ...(typeof cell.text === 'string'
          ? { text: normalizeImportedTextContent(cell.text, textScale) }
          : {}),
        ...(noFill ? { fillColor: 'transparent' } : {}),
      };
    }),
  );
}

function normalizeImportedTableColumnWidths(widths?: number[]): number[] | undefined {
  if (!widths?.length || widths.some((width) => !Number.isFinite(width) || width <= 0)) {
    return undefined;
  }
  const total = widths.reduce((sum, width) => sum + width, 0);
  return total > 0 ? widths.map((width) => roundCanvasNumber(width / total)) : undefined;
}

async function externalizeSlidePagesMedia(
  pages: SlidePageIR[],
  assetRegistry: PptxImportAssetSink,
): Promise<void> {
  for (const [pageIndex, page] of pages.entries()) {
    try {
      if (page.background?.type === 'image') {
        page.background.src = await externalizeParserDataUrl(
          page.background.src,
          assetRegistry,
          `page_${pageIndex + 1}_background`,
          'image',
        );
      }
      await externalizeSlideElementsMedia(page.elements, assetRegistry, `page_${pageIndex + 1}`);
    } catch (error) {
      log.warn(
        `PPTX 页面媒体外置失败，保留页面其余内容: page=${pageIndex + 1}, error=${getErrorMessage(error)}`,
      );
    }
  }
}

function resolveImportedHorizontalTextAlign(
  paragraphAlignments?: Record<number, PptxParagraphAlignment>,
): SlideElementIR['textAlign'] | undefined {
  const alignments = Object.values(paragraphAlignments ?? {});
  if (alignments.length === 0) return undefined;
  const first = alignments[0];
  if (!first || alignments.some((alignment) => alignment !== first)) return undefined;
  return first;
}

function repairParserMediaFromSupplements(
  elements: SlideElementIR[],
  fallbackElements: SlideElementIR[],
): SlideElementIR[] {
  const fallbackMediaBySourceId = new Map(
    fallbackElements
      .filter(
        (element) =>
          (element.type === 'video' || element.type === 'audio') && element.sourceShapeId,
      )
      .map((element) => [element.sourceShapeId!, element]),
  );
  if (fallbackMediaBySourceId.size === 0) return elements;

  return elements.map((element) => {
    if (element.type !== 'video' && element.type !== 'audio') return element;
    const sourceId = element.sourceShapeId;
    const fallback = sourceId ? fallbackMediaBySourceId.get(sourceId) : undefined;
    if (!fallback?.src) return element;
    const parserSrc = element.src;
    const parserMediaIsInvalid =
      typeof parserSrc !== 'string' ||
      (parserSrc.startsWith('data:') && parserSrc.length > MAX_PARSER_MEDIA_DATA_URL_CHARS);
    if (!parserMediaIsInvalid) return element;
    return {
      ...element,
      src: fallback.src,
      ...(fallback.poster ? { poster: fallback.poster } : {}),
      ...(fallback.ext ? { ext: fallback.ext } : {}),
    };
  });
}

async function externalizeSlideElementsMedia(
  elements: SlideElementIR[],
  assetRegistry: PptxImportAssetSink,
  scope: string,
): Promise<void> {
  for (const [elementIndex, element] of elements.entries()) {
    const elementId = element.id || `${scope}_element_${elementIndex + 1}`;
    element.src = await externalizeParserDataUrl(
      element.src,
      assetRegistry,
      `${elementId}_src`,
      element.type === 'video' ? 'video' : element.type === 'audio' ? 'audio' : 'image',
    );
    element.poster = await externalizeParserDataUrl(
      element.poster,
      assetRegistry,
      `${elementId}_poster`,
      'image',
    );
    element.pattern = await externalizeParserDataUrl(
      element.pattern,
      assetRegistry,
      `${elementId}_pattern`,
      'image',
    );
  }
}

async function externalizeParserDataUrl(
  value: unknown,
  assetRegistry: PptxImportAssetSink,
  sourceKey: string,
  assetType: 'image' | 'video' | 'audio',
): Promise<string | undefined> {
  const dataUrl = normalizeDataUrl(value);
  if (!dataUrl) {
    return typeof value === 'string' ? value : undefined;
  }
  // Parser output can contain malformed or recursively-expanded data URLs for
  // media-heavy PPTX files. Do not let one oversized value exhaust the stack.
  if (dataUrl.length > MAX_PARSER_MEDIA_DATA_URL_CHARS) {
    log.warn(`PPTX 媒体 data URL 过大，跳过外置: source=${sourceKey}, chars=${dataUrl.length}`);
    return undefined;
  }
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    return dataUrl;
  }
  const [, mimeType, base64Data] = match;
  return assetRegistry.registerAsset({
    assetType,
    sourceKey: `parser:${sourceKey}:${mimeType}:${base64Data.length}`,
    mimeType,
    buffer: Buffer.from(base64Data, 'base64'),
    ext: normalizeMediaExtension(mimeType) || normalizeMediaExtension(dataUrl),
  });
}

async function extractFallbackSlideNotes(
  zip: JSZip,
  slidePath: string,
  relationships: Map<string, PptxRelationshipEntry>,
): Promise<string | undefined> {
  const notesEntry = Array.from(relationships.values()).find((entry) =>
    (entry.type || '').includes('/notesSlide'),
  );
  if (!notesEntry?.target) return undefined;
  const notesPath = resolveZipTarget(slidePath, notesEntry.target);
  const notesXml = await readZipText(zip, notesPath);
  if (!notesXml) return undefined;
  const texts = collectTextNodes(notesXml)
    .map((text) => text.trim())
    .filter(Boolean);
  return texts.length > 0 ? texts.join('\n') : undefined;
}

async function extractSlideBackground(
  zip: JSZip,
  slidePath: string,
  slideXml: string,
  relationships: Map<string, PptxRelationshipEntry>,
  mediaContext?: PptxImportMediaContext,
): Promise<SlidePageIR['background'] | undefined> {
  const bgXml = firstTagXml(slideXml, 'p:bg');
  if (!bgXml) return undefined;

  const bgPrXml = firstTagXml(bgXml, 'p:bgPr');
  if (!bgPrXml) return undefined;

  const imageBackground = await extractBackgroundFromStyleXml(
    zip,
    slidePath,
    bgPrXml,
    relationships,
    mediaContext,
  );
  if (imageBackground) return imageBackground;

  const color = extractSolidFillColor(bgPrXml);
  if (!color) return undefined;

  return {
    type: 'solid',
    color,
  };
}

async function extractSlideBackgroundWithLayoutFallback(
  zip: JSZip,
  slidePath: string,
  slideXml: string,
  relationships: Map<string, PptxRelationshipEntry>,
  deckSize: { width: number; height: number },
  mediaContext?: PptxImportMediaContext,
): Promise<SlidePageIR['background'] | undefined> {
  const direct = await extractSlideBackground(
    zip,
    slidePath,
    slideXml,
    relationships,
    mediaContext,
  );
  const layoutContext = await extractSlideLayoutContext(zip, slidePath, relationships);
  if (!layoutContext) return direct;

  if (shouldRenderMasterShapes(slideXml, layoutContext.xml)) {
    const masterBackground = await extractSlideMasterFullPageImage(
      zip,
      layoutContext,
      deckSize,
      mediaContext,
    );
    if (masterBackground) return masterBackground;
  }

  return (
    direct ??
    (await extractSlideBackground(
      zip,
      layoutContext.path,
      layoutContext.xml,
      layoutContext.relationships,
      mediaContext,
    ))
  );
}

function shouldRenderMasterShapes(slideXml: string, layoutXml: string): boolean {
  const slideTag = slideXml.match(/<p:sld\b[^>]*>/i)?.[0] ?? '';
  const layoutTag = layoutXml.match(/<p:sldLayout\b[^>]*>/i)?.[0] ?? '';
  return (
    extractXmlAttr(slideTag, 'showMasterSp') !== '0' &&
    extractXmlAttr(layoutTag, 'showMasterSp') !== '0'
  );
}

async function extractSlideMasterFullPageImage(
  zip: JSZip,
  layoutContext: PptxSlideLayoutContext,
  deckSize: { width: number; height: number },
  mediaContext?: PptxImportMediaContext,
): Promise<SlidePageIR['background'] | undefined> {
  const masterEntry = Array.from(layoutContext.relationships.values()).find((entry) =>
    (entry.type || '').includes('/slideMaster'),
  );
  if (!masterEntry?.target) return undefined;

  const masterPath = resolveZipTarget(layoutContext.path, masterEntry.target);
  const masterXml = await readZipText(zip, masterPath);
  if (!masterXml) return undefined;
  const masterElements = await extractFallbackRenderableElements(
    zip,
    masterPath,
    masterXml,
    parseRelationshipEntries(await readZipText(zip, getSlideRelsPath(masterPath))),
    deckSize,
    mediaContext,
  );
  const targetHeight = targetHeightFromWidth(1000, deckSize.width, deckSize.height);
  const image = masterElements.findLast(
    (element) =>
      element.type === 'image' &&
      Boolean(element.src) &&
      element.left <= 1 &&
      element.top <= 1 &&
      element.left + element.width >= 999 &&
      element.top + element.height >= targetHeight - 1,
  );
  if (!image?.src) return undefined;

  return {
    type: 'image',
    src: image.src,
    ...(image.opacity != null ? { opacity: image.opacity } : {}),
  };
}

async function extractSlideLayoutContext(
  zip: JSZip,
  slidePath: string,
  relationships: Map<string, PptxRelationshipEntry>,
): Promise<PptxSlideLayoutContext | undefined> {
  const layoutEntry = Array.from(relationships.values()).find((entry) =>
    (entry.type || '').includes('/slideLayout'),
  );
  if (!layoutEntry?.target) return undefined;

  const layoutPath = resolveZipTarget(slidePath, layoutEntry.target);
  const layoutXml = await readZipText(zip, layoutPath);
  if (!layoutXml) return undefined;

  return {
    path: layoutPath,
    xml: layoutXml,
    relationships: parseRelationshipEntries(await readZipText(zip, getSlideRelsPath(layoutPath))),
  };
}

async function extractSlideThemeFonts(
  zip: JSZip,
  layoutContext?: PptxSlideLayoutContext,
): Promise<PptxThemeFonts | undefined> {
  if (!layoutContext) return undefined;
  const masterEntry = Array.from(layoutContext.relationships.values()).find((entry) =>
    (entry.type || '').includes('/slideMaster'),
  );
  if (!masterEntry?.target) return undefined;

  const masterPath = resolveZipTarget(layoutContext.path, masterEntry.target);
  const masterRelationships = parseRelationshipEntries(
    await readZipText(zip, getSlideRelsPath(masterPath)),
  );
  const themeEntry = Array.from(masterRelationships.values()).find((entry) =>
    (entry.type || '').includes('/theme'),
  );
  if (!themeEntry?.target) return undefined;

  const themeXml = await readZipText(zip, resolveZipTarget(masterPath, themeEntry.target));
  if (!themeXml) return undefined;
  const major = firstTagXml(themeXml, 'a:majorFont') ?? '';
  const minor = firstTagXml(themeXml, 'a:minorFont') ?? '';
  const fonts: PptxThemeFonts = {
    '+mj-lt': extractXmlAttr(firstTagXml(major, 'a:latin') ?? '', 'typeface'),
    '+mj-ea': extractThemeEastAsianFont(major),
    '+mj-cs': extractXmlAttr(firstTagXml(major, 'a:cs') ?? '', 'typeface'),
    '+mn-lt': extractXmlAttr(firstTagXml(minor, 'a:latin') ?? '', 'typeface'),
    '+mn-ea': extractThemeEastAsianFont(minor),
    '+mn-cs': extractXmlAttr(firstTagXml(minor, 'a:cs') ?? '', 'typeface'),
  };
  return Object.values(fonts).some(Boolean) ? fonts : undefined;
}

async function extractSlideThemeStyleContext(
  zip: JSZip,
  layoutContext?: PptxSlideLayoutContext,
): Promise<PptxThemeStyleContext | undefined> {
  if (!layoutContext) return undefined;
  const masterEntry = Array.from(layoutContext.relationships.values()).find((entry) =>
    (entry.type || '').includes('/slideMaster'),
  );
  if (!masterEntry?.target) return undefined;

  const masterPath = resolveZipTarget(layoutContext.path, masterEntry.target);
  const masterRelationships = parseRelationshipEntries(
    await readZipText(zip, getSlideRelsPath(masterPath)),
  );
  const themeEntry = Array.from(masterRelationships.values()).find((entry) =>
    (entry.type || '').includes('/theme'),
  );
  if (!themeEntry?.target) return undefined;

  const themeXml = await readZipText(zip, resolveZipTarget(masterPath, themeEntry.target));
  if (!themeXml) return undefined;
  const colorSchemeXml = firstTagXml(themeXml, 'a:clrScheme') ?? '';
  const schemeColors = Object.fromEntries(
    [
      'dk1',
      'lt1',
      'dk2',
      'lt2',
      'accent1',
      'accent2',
      'accent3',
      'accent4',
      'accent5',
      'accent6',
      'hlink',
      'folHlink',
    ]
      .map((name) => {
        const entryXml = firstTagXml(colorSchemeXml, `a:${name}`) ?? '';
        const srgb = extractXmlAttr(firstTagXml(entryXml, 'a:srgbClr') ?? '', 'val');
        const system = extractXmlAttr(firstTagXml(entryXml, 'a:sysClr') ?? '', 'lastClr');
        const value = srgb || system;
        return value ? [name, `#${value.replace(/^#/, '')}`] : undefined;
      })
      .filter((entry): entry is [string, string] => Boolean(entry)),
  );
  const lineStyles = splitDirectXmlChildren(firstTagXml(themeXml, 'a:lnStyleLst') ?? '', ['a:ln']);
  const effectStyles = splitDirectXmlChildren(firstTagXml(themeXml, 'a:effectStyleLst') ?? '', [
    'a:effectStyle',
  ]);
  return Object.keys(schemeColors).length || lineStyles.length || effectStyles.length
    ? { schemeColors, lineStyles, effectStyles }
    : undefined;
}

function extractThemeEastAsianFont(fontXml: string): string | undefined {
  const direct = extractXmlAttr(firstTagXml(fontXml, 'a:ea') ?? '', 'typeface');
  if (direct) return direct;
  const hans = Array.from(fontXml.matchAll(/<a:font\b[^>]*>/gi)).find(
    (match) => extractXmlAttr(match[0], 'script') === 'Hans',
  );
  return hans ? extractXmlAttr(hans[0], 'typeface') : undefined;
}

async function extractSlideLayoutRenderableElements(
  zip: JSZip,
  layoutContext: PptxSlideLayoutContext,
  deckSize: { width: number; height: number },
  mediaContext?: PptxImportMediaContext,
  slideXml?: string,
  themeStyle?: PptxThemeStyleContext,
): Promise<SlideElementIR[]> {
  const masterElements =
    !slideXml || shouldRenderMasterShapes(slideXml, layoutContext.xml)
      ? await extractSlideMasterRenderableElements(
          zip,
          layoutContext,
          deckSize,
          mediaContext,
          themeStyle,
        )
      : [];
  const backgroundElement = extractLayoutBackgroundGradientElement(layoutContext.xml, deckSize);
  const elements = await extractFallbackRenderableElements(
    zip,
    layoutContext.path,
    layoutContext.xml,
    layoutContext.relationships,
    deckSize,
    mediaContext,
    themeStyle,
  );
  return [
    ...masterElements,
    ...(backgroundElement ? [backgroundElement] : []),
    ...elements.map((element) => {
      // Layout shape ids, like master ids, belong to another OOXML part.
      const inheritedElement = { ...element };
      delete inheritedElement.sourceShapeId;
      delete inheritedElement.sourceGroupShapeIds;
      delete inheritedElement.sourceOrder;
      return {
        ...inheritedElement,
        id: `pptx_fallback_layout_${element.id.replace(/^pptx_fallback_/, '')}`,
        imageRole: element.type === 'image' ? 'background' : element.imageRole,
      };
    }),
  ];
}

async function extractSlideMasterRenderableElements(
  zip: JSZip,
  layoutContext: PptxSlideLayoutContext,
  deckSize: { width: number; height: number },
  mediaContext?: PptxImportMediaContext,
  themeStyle?: PptxThemeStyleContext,
): Promise<SlideElementIR[]> {
  const masterEntry = Array.from(layoutContext.relationships.values()).find((entry) =>
    (entry.type || '').includes('/slideMaster'),
  );
  if (!masterEntry?.target) return [];

  const masterPath = resolveZipTarget(layoutContext.path, masterEntry.target);
  const masterXml = await readZipText(zip, masterPath);
  if (!masterXml) return [];

  const targetHeight = targetHeightFromWidth(1000, deckSize.width, deckSize.height);
  const elements = await extractFallbackRenderableElements(
    zip,
    masterPath,
    masterXml,
    parseRelationshipEntries(await readZipText(zip, getSlideRelsPath(masterPath))),
    deckSize,
    mediaContext,
    themeStyle,
  );

  return elements.flatMap((element) => {
    // A full-slide master picture is already promoted to the page background.
    if (
      element.type === 'image' &&
      element.left <= 1 &&
      element.top <= 1 &&
      element.left + element.width >= 999 &&
      element.top + element.height >= targetHeight - 1
    ) {
      return [];
    }

    // Shape ids are local to each OOXML part. Dropping master source ids avoids
    // collisions with same-numbered slide shapes and their animation targets.
    const inheritedElement = { ...element };
    delete inheritedElement.sourceShapeId;
    delete inheritedElement.sourceGroupShapeIds;
    delete inheritedElement.sourceOrder;
    return [
      {
        ...inheritedElement,
        id: `pptx_fallback_master_${element.id.replace(/^pptx_fallback_/, '')}`,
        imageRole: element.type === 'image' ? 'background' : element.imageRole,
      },
    ];
  });
}

function extractLayoutBackgroundGradientElement(
  layoutXml: string,
  deckSize: { width: number; height: number },
): SlideElementIR | undefined {
  const bgXml = firstTagXml(layoutXml, 'p:bg');
  const bgPrXml = firstTagXml(bgXml ?? '', 'p:bgPr');
  const fillGradient = extractGradientFill(bgPrXml);
  if (!fillGradient) return undefined;

  return {
    id: 'pptx_fallback_layout_background',
    type: 'shape',
    left: 0,
    top: 0,
    width: 1000,
    height: roundCanvasNumber(targetHeightFromWidth(1000, deckSize.width, deckSize.height)),
    rotate: 0,
    shapeType: 'rect',
    fillColor: 'transparent',
    fillGradient,
  };
}

async function extractBackgroundFromStyleXml(
  zip: JSZip,
  slidePath: string,
  styleXml: string,
  relationships: Map<string, PptxRelationshipEntry>,
  mediaContext?: PptxImportMediaContext,
): Promise<SlidePageIR['background'] | undefined> {
  const blipFillXml = firstTagXml(styleXml, 'a:blipFill');
  const blipXml = blipFillXml ? firstTagXml(blipFillXml, 'a:blip') : undefined;
  const relId = blipXml
    ? extractXmlAttr(blipXml, 'r:embed') || extractXmlAttr(blipXml, 'r:link')
    : undefined;
  const relationship = relId ? relationships.get(relId) : undefined;
  const asset = await loadRelationshipAsset(zip, slidePath, relationship, mediaContext);
  if (!asset) return undefined;
  const renderedAsset = await applyPptxImageColorChange(asset, blipXml);
  const src = await externalizeZipMediaAsset(
    renderedAsset.sourceKey,
    renderedAsset.bytes,
    renderedAsset.mimeType,
    'image',
    mediaContext,
    () =>
      `data:${renderedAsset.mimeType};base64,${Buffer.from(renderedAsset.bytes).toString('base64')}`,
  );
  const opacity = extractSolidFillOpacity(styleXml);

  return {
    type: 'image',
    src,
    ...(opacity != null ? { opacity } : {}),
  };
}

async function extractFallbackRenderableElements(
  zip: JSZip,
  slidePath: string,
  slideXml: string,
  relationships: Map<string, PptxRelationshipEntry>,
  deckSize: { width: number; height: number },
  mediaContext?: PptxImportMediaContext,
  themeStyle?: PptxThemeStyleContext,
): Promise<SlideElementIR[]> {
  const treeXml = firstTagXml(slideXml, 'p:spTree');
  if (!treeXml) return [];
  const mediaPlaybackTriggers = collectMediaPlaybackTriggers(slideXml);

  const targetHeight = targetHeightFromWidth(1000, deckSize.width, deckSize.height);
  const nodes = splitDirectXmlChildren(treeXml, [
    'p:sp',
    'p:pic',
    'p:cxnSp',
    'p:grpSp',
    'p:graphicFrame',
    'mc:AlternateContent',
  ]).filter((nodeXml) => !isNonRenderableInheritedPlaceholder(slidePath, nodeXml));

  const results: SlideElementIR[] = [];
  for (const [index, nodeXml] of nodes.entries()) {
    const elements = await flattenFallbackRenderableNode(
      zip,
      slidePath,
      nodeXml,
      relationships,
      deckSize,
      targetHeight,
      index,
      mediaPlaybackTriggers,
      undefined,
      mediaContext,
      [],
      themeStyle,
    );
    results.push(...elements);
  }
  return results;
}

function isNonRenderableInheritedPlaceholder(slidePath: string, nodeXml: string): boolean {
  if (!/^ppt\/slide(?:Layouts|Masters)\//i.test(slidePath) || !/^<p:sp\b/i.test(nodeXml)) {
    return false;
  }
  const placeholderXml = firstTagXml(firstTagXml(nodeXml, 'p:nvPr') ?? '', 'p:ph');
  // Master/layout placeholders are definitions; rendered instances belong to the slide.
  return Boolean(placeholderXml);
}

async function flattenFallbackRenderableNode(
  zip: JSZip,
  slidePath: string,
  nodeXml: string,
  relationships: Map<string, PptxRelationshipEntry>,
  deckSize: { width: number; height: number },
  targetHeight: number,
  index: number,
  mediaPlaybackTriggers: Map<string, MediaPlaybackTrigger>,
  transform: XmlAffineTransform = identityXmlTransform(),
  mediaContext?: PptxImportMediaContext,
  sourceGroupShapeIds: string[] = [],
  themeStyle?: PptxThemeStyleContext,
): Promise<SlideElementIR[]> {
  if (/^<p:grpSp\b/i.test(nodeXml)) {
    const nextTransform = combineXmlTransforms(transform, extractGroupTransform(nodeXml));
    const sourceShapeId = extractXmlAttr(firstTagXml(nodeXml, 'p:cNvPr') ?? '', 'id');
    const nextSourceGroupShapeIds = sourceShapeId
      ? [...sourceGroupShapeIds, sourceShapeId]
      : sourceGroupShapeIds;
    const children = splitDirectXmlChildren(nodeXml, [
      'p:sp',
      'p:pic',
      'p:cxnSp',
      'p:grpSp',
      'p:graphicFrame',
      'mc:AlternateContent',
    ]);
    const nested = await Promise.all(
      children.map((childXml, childIndex) =>
        flattenFallbackRenderableNode(
          zip,
          slidePath,
          childXml,
          relationships,
          deckSize,
          targetHeight,
          childIndex,
          mediaPlaybackTriggers,
          nextTransform,
          mediaContext,
          nextSourceGroupShapeIds,
          themeStyle,
        ),
      ),
    );
    return nested.flat();
  }

  if (/^<mc:AlternateContent\b/i.test(nodeXml)) {
    const choiceXml = firstTagXml(nodeXml, 'mc:Choice');
    const contentPartXml = firstTagXml(choiceXml ?? '', 'p:contentPart');
    if (contentPartXml) {
      const ink = await mapFallbackInkContentPart(
        zip,
        slidePath,
        contentPartXml,
        relationships,
        deckSize,
        targetHeight,
        transform,
        mediaContext,
      );
      if (ink) return [addSourceGroupShapeIds(ink, sourceGroupShapeIds)];
    }

    const fallbackXml = firstTagXml(nodeXml, 'mc:Fallback');
    if (!fallbackXml) return [];
    const children = splitDirectXmlChildren(fallbackXml, [
      'p:sp',
      'p:pic',
      'p:cxnSp',
      'p:grpSp',
      'p:graphicFrame',
    ]);
    const nested = await Promise.all(
      children.map((childXml, childIndex) =>
        flattenFallbackRenderableNode(
          zip,
          slidePath,
          childXml,
          relationships,
          deckSize,
          targetHeight,
          childIndex,
          mediaPlaybackTriggers,
          transform,
          mediaContext,
          sourceGroupShapeIds,
          themeStyle,
        ),
      ),
    );
    return nested.flat();
  }

  if (/^<p:graphicFrame\b/i.test(nodeXml)) {
    const frame = flattenChartFrameNodes(nodeXml, transform)[0];
    if (!frame) return [];
    const chartTarget = relationships.get(frame.relId)?.target;
    const chartPath = chartTarget ? resolveZipTarget(slidePath, chartTarget) : undefined;
    const chartXml = chartPath ? await readZipText(zip, chartPath) : undefined;
    const model = parseChartModel(chartXml);
    return [
      {
        id: `pptx_chart_${frame.id}`,
        sourceShapeId: frame.id,
        type: 'image',
        left: (frame.x / deckSize.width) * 1000,
        top: (frame.y / deckSize.height) * targetHeight,
        width: (frame.width / deckSize.width) * 1000,
        height: (frame.height / deckSize.height) * targetHeight,
        rotate: 0,
        src: renderChartFallbackSvgDataUrl(model, {
          width: Math.max(1, Math.round(frame.width)),
          height: Math.max(1, Math.round(frame.height)),
        }),
        imageRole: 'content',
      },
    ];
  }

  if (/^<p:pic\b/i.test(nodeXml)) {
    const media = await mapFallbackMediaPictureNode(
      zip,
      slidePath,
      nodeXml,
      relationships,
      deckSize,
      targetHeight,
      index,
      mediaPlaybackTriggers,
      transform,
      mediaContext,
    );
    if (media) return [addSourceGroupShapeIds(media, sourceGroupShapeIds)];

    const image = await mapFallbackPictureNode(
      zip,
      slidePath,
      nodeXml,
      relationships,
      deckSize,
      targetHeight,
      index,
      transform,
      mediaContext,
    );
    return image ? [addSourceGroupShapeIds(image, sourceGroupShapeIds)] : [];
  }

  if (/^<p:sp\b/i.test(nodeXml) || /^<p:cxnSp\b/i.test(nodeXml)) {
    const shape = await mapFallbackShapeNode(
      zip,
      slidePath,
      nodeXml,
      relationships,
      deckSize,
      targetHeight,
      index,
      transform,
      mediaContext,
      themeStyle,
    );
    return shape ? [addSourceGroupShapeIds(shape, sourceGroupShapeIds)] : [];
  }

  return [];
}

async function mapFallbackInkContentPart(
  zip: JSZip,
  slidePath: string,
  nodeXml: string,
  relationships: Map<string, PptxRelationshipEntry>,
  deckSize: { width: number; height: number },
  targetHeight: number,
  transform: XmlAffineTransform,
  mediaContext?: PptxImportMediaContext,
): Promise<SlideElementIR | undefined> {
  const relId = extractXmlAttr(nodeXml, 'r:id');
  const relationship = relId ? relationships.get(relId) : undefined;
  if (!relationship?.target || !/\/customXml$/i.test(relationship.type ?? '')) return undefined;

  const inkPath = resolveZipTarget(slidePath, relationship.target);
  const inkXml = await readZipText(zip, inkPath);
  const svg = inkXml ? renderInkMlSvg(inkXml) : undefined;
  if (!svg) return undefined;

  const xfrmXml = firstTagXml(nodeXml, 'p14:xfrm');
  const offXml = firstTagXml(xfrmXml ?? '', 'a:off');
  const extXml = firstTagXml(xfrmXml ?? '', 'a:ext');
  const x = Number(extractXmlAttr(offXml ?? '', 'x'));
  const y = Number(extractXmlAttr(offXml ?? '', 'y'));
  const width = Number(extractXmlAttr(extXml ?? '', 'cx'));
  const height = Number(extractXmlAttr(extXml ?? '', 'cy'));
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return undefined;
  }

  const frame = {
    x: emuToPt(transform.translateX + (x - transform.childOffsetX) * transform.scaleX),
    y: emuToPt(transform.translateY + (y - transform.childOffsetY) * transform.scaleY),
    width: emuToPt(width * transform.scaleX),
    height: emuToPt(height * transform.scaleY),
  };
  const normalized = normalizeViewportRect({
    ...frame,
    sourceWidth: deckSize.width,
    sourceHeight: deckSize.height,
    targetWidth: 1000,
    targetHeight,
  });
  const sourceShapeId = extractXmlAttr(firstTagXml(nodeXml, 'p14:cNvPr') ?? '', 'id');
  const svgBytes = Buffer.from(svg, 'utf8');
  const src = await externalizeZipMediaAsset(
    `${inkPath}.svg`,
    svgBytes,
    'image/svg+xml',
    'image',
    mediaContext,
    () => `data:image/svg+xml;base64,${svgBytes.toString('base64')}`,
  );

  return {
    id: `pptx_fallback_ink_${sanitizeIdPart(sourceShapeId || relId || inkPath)}`,
    ...(sourceShapeId ? { sourceShapeId } : {}),
    type: 'image',
    left: roundCanvasNumber(normalized.left),
    top: roundCanvasNumber(normalized.top),
    width: roundCanvasNumber(normalized.width),
    height: roundCanvasNumber(normalized.height),
    rotate: 0,
    src,
    imageRole: 'content',
  };
}

function renderInkMlSvg(xml: string): string | undefined {
  const resolution = Number(
    xml.match(
      /<inkml:channelProperty\b(?=[^>]*\bchannel="X")(?=[^>]*\bname="resolution")[^>]*\bvalue="([^"]+)"/i,
    )?.[1] ?? 1000,
  );
  const brushes = new Map<string, { color: string; width: number }>();
  for (const brushXml of collectXmlBlocks(xml, 'inkml:brush')) {
    const id = extractXmlAttr(brushXml, 'xml:id');
    if (!id) continue;
    const color =
      brushXml.match(/<inkml:brushProperty\b(?=[^>]*\bname="color")[^>]*\bvalue="([^"]+)"/i)?.[1] ??
      '#000000';
    const widthCm = Number(
      brushXml.match(/<inkml:brushProperty\b(?=[^>]*\bname="width")[^>]*\bvalue="([^"]+)"/i)?.[1] ??
        0.12,
    );
    brushes.set(id, {
      color: normalizeCssColor(color) ?? '#000000',
      width: Math.max(1, widthCm * (Number.isFinite(resolution) ? resolution : 1000)),
    });
  }

  const traces: Array<{ points: Array<{ x: number; y: number }>; color: string; width: number }> =
    [];
  for (const match of xml.matchAll(/<inkml:trace\b([^>]*)>([\s\S]*?)<\/inkml:trace>/gi)) {
    const attrs = match[1] ?? '';
    const brushId = extractXmlAttr(`<inkml:trace ${attrs}>`, 'brushRef')?.replace(/^#/, '');
    const brush = (brushId ? brushes.get(brushId) : undefined) ?? {
      color: '#000000',
      width: 120,
    };
    const points = decodeInkMlTrace(decodeXmlText(match[2] ?? ''));
    if (points.length > 1) traces.push({ points, ...brush });
  }
  if (traces.length === 0) return undefined;

  const allPoints = traces.flatMap((trace) => trace.points);
  const maxStroke = Math.max(...traces.map((trace) => trace.width));
  const minX = Math.min(...allPoints.map((point) => point.x)) - maxStroke / 2;
  const minY = Math.min(...allPoints.map((point) => point.y)) - maxStroke / 2;
  const maxX = Math.max(...allPoints.map((point) => point.x)) + maxStroke / 2;
  const maxY = Math.max(...allPoints.map((point) => point.y)) + maxStroke / 2;
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const paths = traces
    .map((trace) => {
      const path = trace.points
        .map(
          (point, index) =>
            `${index === 0 ? 'M' : 'L'} ${roundCanvasNumber(point.x)} ${roundCanvasNumber(point.y)}`,
        )
        .join(' ');
      return `<path d="${path}" fill="none" stroke="${escapeXml(trace.color)}" stroke-width="${roundCanvasNumber(trace.width)}" stroke-linecap="round" stroke-linejoin="round"/>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${roundCanvasNumber(minX)} ${roundCanvasNumber(minY)} ${roundCanvasNumber(width)} ${roundCanvasNumber(height)}" preserveAspectRatio="none">${paths}</svg>`;
}

function decodeInkMlTrace(value: string): Array<{ x: number; y: number }> {
  type ChannelState = { mode: 0 | 1 | 2; value: number; delta: number };
  const states: ChannelState[] = [];
  const points: Array<{ x: number; y: number }> = [];
  for (const sample of value.split(',')) {
    const tokens = [...sample.matchAll(/([!'\"]?)([-+]?(?:\d+(?:\.\d*)?|\.\d+))/g)];
    if (tokens.length < 2) continue;
    const decoded: number[] = [];
    for (const [index, token] of tokens.entries()) {
      const prefix = token[1] ?? '';
      const raw = Number(token[2]);
      const state = states[index] ?? { mode: 0 as const, value: 0, delta: 0 };
      const mode: 0 | 1 | 2 =
        prefix === "'" ? 1 : prefix === '"' ? 2 : prefix === '!' ? 0 : state.mode;
      if (mode === 0) {
        state.value = raw;
        state.delta = 0;
      } else if (mode === 1) {
        state.delta = raw;
        state.value += raw;
      } else {
        state.delta += raw;
        state.value += state.delta;
      }
      state.mode = mode;
      states[index] = state;
      decoded.push(state.value);
    }
    if (Number.isFinite(decoded[0]) && Number.isFinite(decoded[1])) {
      points.push({ x: decoded[0], y: decoded[1] });
    }
  }
  return points;
}

function addSourceGroupShapeIds(
  element: SlideElementIR,
  sourceGroupShapeIds: string[],
): SlideElementIR {
  return sourceGroupShapeIds.length > 0 ? { ...element, sourceGroupShapeIds } : element;
}

async function mapFallbackShapeNode(
  zip: JSZip,
  slidePath: string,
  nodeXml: string,
  relationships: Map<string, PptxRelationshipEntry>,
  deckSize: { width: number; height: number },
  targetHeight: number,
  index: number,
  transform: XmlAffineTransform,
  mediaContext?: PptxImportMediaContext,
  themeStyle?: PptxThemeStyleContext,
): Promise<SlideElementIR | undefined> {
  const frame = extractFallbackNodeFrame(nodeXml, transform);
  if (!frame) return undefined;

  const normalized = normalizeViewportRect({
    x: frame.x,
    y: frame.y,
    width: frame.width,
    height: frame.height,
    sourceWidth: deckSize.width,
    sourceHeight: deckSize.height,
    targetWidth: 1000,
    targetHeight,
  });

  const sourceShapeId = extractXmlAttr(firstTagXml(nodeXml, 'p:cNvPr') ?? '', 'id');
  const id = sourceShapeId || `${index + 1}`;
  const shapeType = extractXmlAttr(firstTagXml(nodeXml, 'a:prstGeom') ?? '', 'prst');
  const txBodyXml = firstTagXml(nodeXml, 'p:txBody') ?? '';
  const text = collectFallbackParagraphText(txBodyXml);
  const hardLineBreaks = collectFallbackHardLineBreaks(txBodyXml);
  const runPrXml = firstTagXml(nodeXml, 'a:rPr') ?? '';
  const endParaRunPrXml = firstTagXml(nodeXml, 'a:endParaRPr') ?? '';
  const bodyPrXml = firstTagXml(nodeXml, 'a:bodyPr') ?? '';
  const noWrap = extractXmlAttr(bodyPrXml, 'wrap') === 'none';
  const spPrXml = firstTagXml(nodeXml, 'p:spPr') ?? '';
  const styleXml = firstTagXml(nodeXml, 'p:style') ?? '';
  const solidFill = extractDirectSolidFillColor(spPrXml, themeStyle?.schemeColors);
  const fillOpacity = extractDirectSolidFillOpacity(spPrXml);
  const fillColor =
    solidFill && fillOpacity != null ? applyAlpha(solidFill, fillOpacity) : solidFill;
  const hasExplicitNoFill = Boolean(firstDirectChildTagXml(spPrXml, 'a:noFill'));
  const fillGradient = extractGradientFill(spPrXml);
  const keypoints = extractFallbackShapeKeypoints(spPrXml, shapeType);
  const directLineXml = firstTagXml(spPrXml, 'a:ln');
  const lineRefXml = firstTagXml(styleXml, 'a:lnRef');
  const lineRefIndex = normalizeNumber(extractXmlAttr(lineRefXml ?? '', 'idx'));
  const lineRefColor = extractColorFromSolidFillXml(lineRefXml, themeStyle?.schemeColors);
  const lineXml =
    directLineXml ??
    (lineRefIndex && lineRefIndex > 0 ? themeStyle?.lineStyles[lineRefIndex - 1] : undefined);
  const lineSchemeColors = lineRefColor
    ? { ...themeStyle?.schemeColors, phClr: lineRefColor }
    : themeStyle?.schemeColors;
  const lineColor = extractDirectSolidFillColor(lineXml, lineSchemeColors);
  const lineGradient = extractGradientFill(lineXml ?? '');
  const lineWidth = extractLineWidth(lineXml) ?? (lineGradient ? 1 : undefined);
  const lineType = extractLineType(lineXml);
  const points = extractLinePoints(lineXml);
  const rotate = extractNodeRotation(nodeXml);
  const flipH = extractNodeFlip(nodeXml, 'flipH');
  const flipV = extractNodeFlip(nodeXml, 'flipV');
  const defaultColor = extractSolidFillColor(runPrXml) ?? extractSolidFillColor(endParaRunPrXml);
  const fontFace =
    resolveFallbackFontFace(runPrXml, text) ?? resolveFallbackFontFace(endParaRunPrXml, text);
  const fontSize = normalizeNumber(
    extractXmlAttr(runPrXml, 'sz') ?? extractXmlAttr(endParaRunPrXml, 'sz'),
  );
  const fontWeight =
    (extractXmlAttr(runPrXml, 'b') ?? extractXmlAttr(endParaRunPrXml, 'b')) === '1'
      ? 'bold'
      : undefined;
  const verticalAlign = extractVerticalAlignFromBodyPr(bodyPrXml, Boolean(text));
  const lineHeight = extractParagraphLineHeight(firstTagXml(nodeXml, 'a:pPr') ?? '', fontSize);
  const autoFit = extractAutoFitFromBodyPr(bodyPrXml);
  const overflowVisible = extractOverflowVisibleFromBodyPr(bodyPrXml, Boolean(text), autoFit);
  const effectRefXml = firstTagXml(styleXml, 'a:effectRef');
  const effectRefIndex = normalizeNumber(extractXmlAttr(effectRefXml ?? '', 'idx'));
  const effectRefColor = extractColorFromSolidFillXml(effectRefXml, themeStyle?.schemeColors);
  const effectSchemeColors = effectRefColor
    ? { ...themeStyle?.schemeColors, phClr: effectRefColor }
    : themeStyle?.schemeColors;
  const directEffectXml = firstTagXml(spPrXml, 'a:effectLst');
  const effectXml =
    directEffectXml ??
    (effectRefIndex && effectRefIndex > 0
      ? themeStyle?.effectStyles[effectRefIndex - 1]
      : undefined);
  const shadow = extractOuterShadow(effectXml, effectSchemeColors, deckSize);
  const pattern = await extractFallbackShapePattern(
    zip,
    slidePath,
    nodeXml,
    relationships,
    mediaContext,
  );
  const patternCrop = extractPatternCropFromShapeNode(nodeXml);
  const patternScaleMode = extractPatternScaleModeFromShapeNode(nodeXml);
  const textInsets = text
    ? extractTextInsetsFromBodyPr(bodyPrXml, {
        rect: normalized,
        deckSize,
        hasVisualFill: Boolean(solidFill || fillGradient || pattern),
      })
    : undefined;
  const customGeometry = extractFallbackCustomGeometry(nodeXml);
  const presetGeometry =
    customGeometry ??
    extractFallbackPresetGeometry(nodeXml, shapeType, {
      width: normalized.width,
      height: normalized.height,
    });
  const mappedFontSize =
    fontSize != null ? roundCanvasNumber((fontSize / 100) * (1000 / deckSize.width)) : undefined;
  const resolvedOverflowVisible =
    overflowVisible ??
    (shouldPreserveSingleHanGlyphOverflow({
      content: text,
      autoFit,
      fontSize: mappedFontSize,
      width: normalized.width,
      textInsets,
    })
      ? true
      : undefined);
  const styledContent = text
    ? buildFallbackShapeTextContent(text, {
        color: defaultColor,
        fontFace: resolveImportedCssFontFamily(fontFace),
        fontSize: mappedFontSize,
        lineHeight,
        noWrap,
      })
    : undefined;

  // Bent connectors need to remain path-backed shapes in the fallback itself,
  // otherwise a parser failure would degrade them to diagonal lines. When the
  // parser does succeed, mergeSupplementElements adds their endpoint styles to
  // the parser's retained multi-segment paths.
  const isPathBackedBentConnector = Boolean(presetGeometry) && isBentConnectorPathShape(shapeType);
  const isLine =
    shapeType === 'line' ||
    (!isPathBackedBentConnector &&
      (/<p:cxnSp\b/i.test(nodeXml) ||
        /^(?:straightConnector|bentConnector|curvedConnector)/.test(shapeType ?? '')));
  if (isLine) {
    return {
      id: `pptx_fallback_shape_${sanitizeIdPart(id)}`,
      ...(sourceShapeId ? { sourceShapeId } : {}),
      type: 'line',
      left: roundCanvasNumber(normalized.left),
      top: roundCanvasNumber(normalized.top),
      width: roundCanvasNumber(normalized.width),
      height: roundCanvasNumber(normalized.height),
      rotate,
      ...(flipH ? { flipH: true } : {}),
      ...(flipV ? { flipV: true } : {}),
      ...(lineWidth != null ? { borderWidth: lineWidth } : {}),
      ...(lineColor ? { borderColor: lineColor } : {}),
      ...(points ? { points } : {}),
      // Keep the connector path in its authored local frame. The classroom
      // mapper applies the authored rotation/flip once when it creates the
      // drawable line endpoints.
      lineEnd: [normalized.width, normalized.height],
      borderType: lineType ?? 'solid',
    };
  }

  return {
    id: `pptx_fallback_shape_${sanitizeIdPart(id)}`,
    ...(sourceShapeId ? { sourceShapeId } : {}),
    type: 'shape',
    left: roundCanvasNumber(normalized.left),
    top: roundCanvasNumber(normalized.top),
    width: roundCanvasNumber(normalized.width),
    height: roundCanvasNumber(normalized.height),
    rotate,
    ...(flipH ? { flipH: true } : {}),
    ...(flipV ? { flipV: true } : {}),
    ...(styledContent ? { content: styledContent } : {}),
    ...(hardLineBreaks.length > 0 ? { hardLineBreaks } : {}),
    ...(shapeType ? { shapeType } : {}),
    ...(keypoints ? { keypoints } : {}),
    ...(points ? { points } : {}),
    ...(presetGeometry ? { path: presetGeometry.path, viewBox: presetGeometry.viewBox } : {}),
    ...(fillColor ? { fillColor } : hasExplicitNoFill ? { fillColor: 'transparent' } : {}),
    ...(fillGradient ? { fillGradient } : {}),
    ...(lineWidth != null ? { borderWidth: lineWidth } : {}),
    ...(lineColor ? { borderColor: lineColor } : {}),
    ...(lineType ? { borderType: lineType } : {}),
    ...(lineGradient ? { borderGradient: lineGradient } : {}),
    ...(pattern
      ? {
          pattern,
          patternScaleMode: patternScaleMode ?? ('stretch' as const),
          imageRole: 'shape_fill' as const,
        }
      : {}),
    ...(patternCrop ? { patternCrop } : {}),
    ...(defaultColor ? { defaultColor } : {}),
    ...(fontFace ? { defaultFontName: resolveImportedCssFontFamily(fontFace) ?? fontFace } : {}),
    ...(mappedFontSize != null ? { fontSize: mappedFontSize } : {}),
    ...(fontWeight ? { fontWeight } : {}),
    ...(lineHeight != null ? { lineHeight } : {}),
    ...(verticalAlign ? { verticalAlign } : {}),
    ...(textInsets ? { textInsets } : {}),
    ...(resolvedOverflowVisible != null ? { overflowVisible: resolvedOverflowVisible } : {}),
    ...(autoFit ? { autoFit } : {}),
    ...(shadow ? { shadow } : {}),
  };
}

function buildFallbackShapeTextContent(
  text: string,
  style: {
    color?: string;
    fontFace?: string;
    fontSize?: number;
    lineHeight?: number;
    noWrap?: boolean;
  },
): string {
  const paragraphStyles = [
    style.lineHeight != null ? `line-height: ${style.lineHeight}` : undefined,
    style.noWrap ? 'white-space: nowrap' : undefined,
    style.noWrap ? 'overflow-wrap: normal' : undefined,
    style.noWrap ? 'word-break: normal' : undefined,
    'margin-top: 0em',
    'margin-bottom: 0em',
  ]
    .filter(Boolean)
    .join(';');
  const spanStyles = [
    normalizeCssColor(style.color) ? `color: ${normalizeCssColor(style.color)}` : undefined,
    style.fontSize != null ? `font-size: ${style.fontSize}px` : undefined,
    style.fontFace
      ? `font-family: ${resolveImportedCssFontFamily(style.fontFace) ?? style.fontFace}`
      : undefined,
  ]
    .filter(Boolean)
    .join(';');
  // OOXML preserves authored spacer runs (for example the three spaces
  // between digits in a vertical calculation). HTML collapses ordinary
  // spaces, so materialize them as non-breaking spaces before the shared
  // imported-space metric pass turns them into fixed-width inline spans.
  const normalizedText = escapeXml(text.replace(/ /g, '\u00a0')).replace(/\n/g, '<br/>');

  return `<p data-pptx-source="true"${paragraphStyles ? ` style="${paragraphStyles};"` : ''}><span${spanStyles ? ` style="${spanStyles};"` : ''}>${normalizedText}</span></p>`;
}

function resolveFallbackFontFace(runPrXml: string, text: string): string | undefined {
  const latin = extractXmlAttr(firstTagXml(runPrXml, 'a:latin') ?? '', 'typeface');
  const eastAsian = extractXmlAttr(firstTagXml(runPrXml, 'a:ea') ?? '', 'typeface');
  return containsCjkText(text) ? eastAsian || latin || undefined : latin || eastAsian || undefined;
}

function resolveImportedCssFontFamily(fontFace?: string): string | undefined {
  const normalized = fontFace?.trim().toLowerCase() as PptxThemeFontToken | undefined;
  if (normalized && PPTX_THEME_FONT_TOKENS.has(normalized)) return normalized;
  return resolveCoursewareFontFamily(fontFace);
}

function containsCjkText(value: string): boolean {
  return /[\u3400-\u9fff\uf900-\ufaff]/u.test(value);
}

function applyCjkFontFamily(content: string | undefined, fontFace: string): string | undefined {
  if (!content) return content;
  return content.replace(/<span\b([^>]*)>([\s\S]*?)<\/span>/gi, (match, attrs, body) => {
    if (!containsCjkText(normalizeElementPlainText(body))) return match;
    const styleMatch = String(attrs).match(/\sstyle="([^"]*)"/i);
    const style = parseInlineStyle(styleMatch?.[1] ?? '');
    style['font-family'] = fontFace;
    const nextStyle = `style="${serializeInlineStyle(style)}"`;
    const nextAttrs = styleMatch
      ? String(attrs).replace(styleMatch[0], ` ${nextStyle}`)
      : `${attrs} ${nextStyle}`;
    return `<span${nextAttrs}>${body}</span>`;
  });
}

function applyFallbackHardLineBreaks(
  content: string | undefined,
  hardLineBreaks: string[] | undefined,
): string | undefined {
  if (!content || !hardLineBreaks?.length) return content;

  let hydrated = content;
  let searchFrom = 0;
  for (const line of hardLineBreaks) {
    const boundary = findHtmlTextBoundary(hydrated, line, searchFrom);
    if (boundary == null) continue;
    const suffix = hydrated.slice(boundary);
    const leadingMarkup = suffix.match(/^(?:(?:\s+|&nbsp;)|<[^>]+>)*/i)?.[0] ?? '';
    if (/<br\b|<\/?p\b/i.test(leadingMarkup)) {
      searchFrom = boundary;
      continue;
    }
    const markupWithoutWhitespace = [...leadingMarkup.matchAll(/<[^>]+>|&nbsp;|\s+/gi)]
      .map((token) => (token[0].startsWith('<') ? token[0] : ''))
      .join('');
    hydrated = `${hydrated.slice(0, boundary)}<br/>${markupWithoutWhitespace}${suffix.slice(leadingMarkup.length)}`;
    searchFrom = boundary + '<br/>'.length;
  }
  return hydrated;
}

function applyFallbackParagraphBreaks(
  content: string | undefined,
  paragraphStarts: string[] | undefined,
): string | undefined {
  if (!content || !paragraphStarts?.length) return content;

  let hydrated = content;
  let searchFrom = 0;
  for (const paragraphStart of paragraphStarts) {
    const boundary = findHtmlTextStart(hydrated, paragraphStart, searchFrom);
    if (boundary == null) continue;
    const prefix = hydrated.slice(0, boundary);
    const trailingMarkup = prefix.match(/(?:(?:\s+|&nbsp;)|<[^>]+>)*$/i)?.[0] ?? '';
    if (/<br\b|<\/?p\b/i.test(trailingMarkup)) {
      searchFrom = boundary;
      continue;
    }
    hydrated = `${prefix}<br/>${hydrated.slice(boundary)}`;
    searchFrom = boundary + '<br/>'.length;
  }
  return hydrated;
}

function findHtmlTextBoundary(
  content: string,
  text: string,
  fromIndex: number,
): number | undefined {
  let visibleText = '';
  const sourceEnds: number[] = [];
  for (let index = fromIndex; index < content.length; ) {
    if (content[index] === '<') {
      const end = content.indexOf('>', index);
      if (end < 0) break;
      const tag = content.slice(index, end + 1);
      if (/^<br\b|^<\/?p\b/i.test(tag)) {
        visibleText += '\n';
        sourceEnds.push(end + 1);
      }
      index = end + 1;
      continue;
    }
    if (content[index] === '&') {
      const end = content.indexOf(';', index);
      if (end >= 0) {
        const entity = content.slice(index, end + 1);
        const decoded = /^&nbsp;$/i.test(entity) ? ' ' : decodeXmlText(entity);
        for (let offset = 0; offset < decoded.length; offset += 1) {
          visibleText += decoded[offset];
          sourceEnds.push(end + 1);
        }
        index = end + 1;
        continue;
      }
    }
    visibleText += content[index];
    sourceEnds.push(index + 1);
    index += 1;
  }

  const visibleIndex = visibleText.indexOf(text);
  return visibleIndex >= 0 ? sourceEnds[visibleIndex + text.length - 1] : undefined;
}

function findHtmlTextStart(content: string, text: string, fromIndex: number): number | undefined {
  let visibleText = '';
  const sourceStarts: number[] = [];
  for (let index = fromIndex; index < content.length; ) {
    if (content[index] === '<') {
      const end = content.indexOf('>', index);
      if (end < 0) break;
      const tag = content.slice(index, end + 1);
      if (/^<br\b|^<\/?p\b/i.test(tag)) {
        visibleText += '\n';
        sourceStarts.push(end + 1);
      }
      index = end + 1;
      continue;
    }
    if (content[index] === '&') {
      const end = content.indexOf(';', index);
      if (end >= 0) {
        const entity = content.slice(index, end + 1);
        const decoded = /^&nbsp;$/i.test(entity) ? ' ' : decodeXmlText(entity);
        for (let offset = 0; offset < decoded.length; offset += 1) {
          visibleText += decoded[offset];
          sourceStarts.push(index);
        }
        index = end + 1;
        continue;
      }
    }
    visibleText += content[index];
    sourceStarts.push(index);
    index += 1;
  }

  const visibleIndex = visibleText.indexOf(text);
  return visibleIndex >= 0 ? sourceStarts[visibleIndex] : undefined;
}

async function extractFallbackShapePattern(
  zip: JSZip,
  slidePath: string,
  nodeXml: string,
  relationships: Map<string, PptxRelationshipEntry>,
  mediaContext?: PptxImportMediaContext,
): Promise<string | undefined> {
  const blipFillXml = firstTagXml(nodeXml, 'a:blipFill');
  const blipXml = blipFillXml ? firstTagXml(blipFillXml, 'a:blip') : undefined;
  const relId = extractXmlAttr(blipXml ?? '', 'r:embed') || extractXmlAttr(blipXml ?? '', 'r:link');
  const relationship = relId ? relationships.get(relId) : undefined;
  const asset = await loadRelationshipAsset(zip, slidePath, relationship, mediaContext);
  if (!asset) return undefined;
  return externalizeZipMediaAsset(
    asset.sourceKey,
    asset.bytes,
    asset.mimeType,
    'image',
    mediaContext,
    () => `data:${asset.mimeType};base64,${Buffer.from(asset.bytes).toString('base64')}`,
  );
}

async function mapFallbackPictureNode(
  zip: JSZip,
  slidePath: string,
  nodeXml: string,
  relationships: Map<string, PptxRelationshipEntry>,
  deckSize: { width: number; height: number },
  targetHeight: number,
  index: number,
  transform: XmlAffineTransform,
  mediaContext?: PptxImportMediaContext,
): Promise<SlideElementIR | undefined> {
  const frame = extractFallbackNodeFrame(nodeXml, transform);
  if (!frame) return undefined;
  const blipXml = firstTagXml(nodeXml, 'a:blip');
  const relId = extractXmlAttr(blipXml ?? '', 'r:embed') || extractXmlAttr(blipXml ?? '', 'r:link');
  const relationship = relId ? relationships.get(relId) : undefined;
  const asset = await loadRelationshipAsset(zip, slidePath, relationship, mediaContext);
  if (!asset) return undefined;
  const normalized = normalizeViewportRect({
    x: frame.x,
    y: frame.y,
    width: frame.width,
    height: frame.height,
    sourceWidth: deckSize.width,
    sourceHeight: deckSize.height,
    targetWidth: 1000,
    targetHeight,
  });
  const sourceShapeId = extractXmlAttr(firstTagXml(nodeXml, 'p:cNvPr') ?? '', 'id');
  const id = sourceShapeId || `${index + 1}`;
  const srcRectXml = firstTagXml(firstTagXml(nodeXml, 'p:blipFill') ?? '', 'a:srcRect');
  const clipRange = srcRectXml ? mapRectAttrsToRange(srcRectXml) : undefined;
  if (shouldSkipTinyFallbackPicture(normalized, clipRange)) {
    return undefined;
  }
  const shape = extractXmlAttr(firstTagXml(nodeXml, 'a:prstGeom') ?? '', 'prst') || 'rect';
  const rotate = extractNodeRotation(nodeXml);
  const flipH = extractNodeFlip(nodeXml, 'flipH');
  const flipV = extractNodeFlip(nodeXml, 'flipV');
  const opacity = extractBlipOpacity(blipXml);
  const renderedAsset = await applyPptxImageColorChange(asset, blipXml);
  const src = await externalizeZipMediaAsset(
    renderedAsset.sourceKey,
    renderedAsset.bytes,
    renderedAsset.mimeType,
    'image',
    mediaContext,
    () =>
      `data:${renderedAsset.mimeType};base64,${Buffer.from(renderedAsset.bytes).toString('base64')}`,
  );
  return {
    id: `pptx_fallback_image_${sanitizeIdPart(id)}`,
    ...(sourceShapeId ? { sourceShapeId } : {}),
    type: 'image',
    left: roundCanvasNumber(normalized.left),
    top: roundCanvasNumber(normalized.top),
    width: roundCanvasNumber(normalized.width),
    height: roundCanvasNumber(normalized.height),
    rotate,
    ...(flipH ? { flipH: true } : {}),
    ...(flipV ? { flipV: true } : {}),
    src,
    ...(renderedAsset.effectApplied ? { sourceEffectApplied: true } : {}),
    imageRole: 'content',
    ...(opacity != null ? { opacity } : {}),
    ...(clipRange ? { clip: { shape, range: clipRange } } : {}),
  };
}

async function mapFallbackMediaPictureNode(
  zip: JSZip,
  slidePath: string,
  nodeXml: string,
  relationships: Map<string, PptxRelationshipEntry>,
  deckSize: { width: number; height: number },
  targetHeight: number,
  index: number,
  mediaPlaybackTriggers: Map<string, MediaPlaybackTrigger>,
  transform: XmlAffineTransform,
  mediaContext?: PptxImportMediaContext,
): Promise<SlideElementIR | undefined> {
  const mediaNode = extractFallbackMediaNode(nodeXml, relationships);
  if (!mediaNode) return undefined;

  const mediaRel = relationships.get(mediaNode.relId);
  const asset = await loadRelationshipAsset(zip, slidePath, mediaRel, mediaContext);
  if (!asset) return undefined;

  const frame = extractFallbackNodeFrame(nodeXml, transform);
  if (!frame) return undefined;

  const mediaKind = resolveFallbackMediaKind(mediaNode.kind, asset.mimeType);
  if (!mediaKind) return undefined;

  const normalized = normalizeViewportRect({
    x: frame.x,
    y: frame.y,
    width: frame.width,
    height: frame.height,
    sourceWidth: deckSize.width,
    sourceHeight: deckSize.height,
    targetWidth: 1000,
    targetHeight,
  });
  const sourceShapeId = extractXmlAttr(firstTagXml(nodeXml, 'p:cNvPr') ?? '', 'id');
  const id = sourceShapeId || `${index + 1}`;
  const playback = mediaPlaybackTriggers.get(id) ?? { trigger: 'click' as const, loop: false };
  const trimXml = firstTagXml(nodeXml, 'p14:trim');
  const trimStartMs = normalizeNumber(extractXmlAttr(trimXml ?? '', 'st'));
  const trimEndMs = normalizeNumber(extractXmlAttr(trimXml ?? '', 'end'));
  const ext = normalizeMediaExtension(asset.assetPath);
  const src = await externalizeZipMediaAsset(
    asset.sourceKey,
    asset.bytes,
    asset.mimeType,
    mediaKind,
    mediaContext,
    () => `data:${asset.mimeType};base64,${Buffer.from(asset.bytes).toString('base64')}`,
  );

  if (mediaKind === 'video') {
    const poster = await extractFallbackPictureDataUrl(
      zip,
      slidePath,
      nodeXml,
      relationships,
      mediaContext,
    );
    return {
      id: `pptx_video_${sanitizeIdPart(id)}`,
      ...(sourceShapeId ? { sourceShapeId } : {}),
      type: 'video',
      left: roundCanvasNumber(normalized.left),
      top: roundCanvasNumber(normalized.top),
      width: roundCanvasNumber(normalized.width),
      height: roundCanvasNumber(normalized.height),
      rotate: 0,
      src,
      ...(poster ? { poster } : {}),
      autoplay: playback.trigger === 'auto',
      trigger: playback.trigger,
      ...(ext ? { ext } : {}),
    };
  }

  return {
    id: `pptx_audio_${sanitizeIdPart(id)}`,
    ...(sourceShapeId ? { sourceShapeId } : {}),
    type: 'audio',
    left: roundCanvasNumber(normalized.left),
    top: roundCanvasNumber(normalized.top),
    width: roundCanvasNumber(normalized.width),
    height: roundCanvasNumber(normalized.height),
    rotate: 0,
    src,
    autoplay: playback.trigger === 'auto',
    trigger: playback.trigger,
    loop: playback.loop,
    ...(trimStartMs != null && trimStartMs > 0 ? { trimStartMs } : {}),
    ...(trimEndMs != null && trimEndMs > 0 ? { trimEndMs } : {}),
    ...(ext ? { ext } : {}),
  };
}

function collectMediaPlaybackTriggers(slideXml: string): Map<string, MediaPlaybackTrigger> {
  const triggers = new Map<string, MediaPlaybackTrigger>();
  const mediaBlocks = [
    ...collectXmlBlocks(slideXml, 'p:video'),
    ...collectXmlBlocks(slideXml, 'p:audio'),
  ];

  for (const block of mediaBlocks) {
    const spTgt = firstTagXml(block, 'p:spTgt');
    const shapeId = spTgt ? extractXmlAttr(spTgt, 'spid') : undefined;
    if (!shapeId) continue;

    const hasClickCondition = /<p:cond\b[^>]*(evt="onClick"|event="onClick")/i.test(block);
    const hasAutomaticCondition = /<p:cond\b[^>]*delay="0"/i.test(block) && !hasClickCondition;
    const trigger: 'auto' | 'click' = hasAutomaticCondition ? 'auto' : 'click';
    const loop = /repeatCount="indefinite"|repeatCount="untilEnd"/i.test(block);

    triggers.set(shapeId, { trigger, loop });
  }

  return triggers;
}

function extractFallbackMediaNode(
  nodeXml: string,
  relationships: Map<string, PptxRelationshipEntry>,
): FallbackMediaNode | undefined {
  const videoXml = firstTagXml(nodeXml, 'a:videoFile');
  const videoRelId = videoXml
    ? extractXmlAttr(videoXml, 'r:link') || extractXmlAttr(videoXml, 'r:embed')
    : undefined;
  const videoNode = videoRelId ? { kind: 'video' as const, relId: videoRelId } : undefined;

  const audioXml = firstTagXml(nodeXml, 'a:audioFile');
  const audioRelId = audioXml
    ? extractXmlAttr(audioXml, 'r:link') || extractXmlAttr(audioXml, 'r:embed')
    : undefined;
  const audioNode = audioRelId ? { kind: 'audio' as const, relId: audioRelId } : undefined;

  const mediaXml = firstTagXml(nodeXml, 'p14:media');
  const mediaRelId = mediaXml
    ? extractXmlAttr(mediaXml, 'r:embed') || extractXmlAttr(mediaXml, 'r:link')
    : undefined;
  const mediaNode = mediaRelId ? { kind: 'unknown' as const, relId: mediaRelId } : undefined;
  const declaredNode = videoNode ?? audioNode;
  if (!declaredNode) return mediaNode;
  const declaredTarget = relationships.get(declaredNode.relId)?.target;
  return !declaredTarget || /^null$/i.test(declaredTarget)
    ? (mediaNode ?? declaredNode)
    : declaredNode;
}

function resolveFallbackMediaKind(
  declaredKind: FallbackMediaNode['kind'],
  mimeType: string,
): 'video' | 'audio' | undefined {
  if (declaredKind !== 'unknown') {
    return mimeType.startsWith(`${declaredKind}/`) ? declaredKind : undefined;
  }
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return undefined;
}

async function extractFallbackPictureDataUrl(
  zip: JSZip,
  slidePath: string,
  nodeXml: string,
  relationships: Map<string, PptxRelationshipEntry>,
  mediaContext?: PptxImportMediaContext,
): Promise<string | undefined> {
  const blipXml = firstTagXml(nodeXml, 'a:blip');
  const relId = blipXml
    ? extractXmlAttr(blipXml, 'r:embed') || extractXmlAttr(blipXml, 'r:link')
    : undefined;
  const relationship = relId ? relationships.get(relId) : undefined;
  const asset = await loadRelationshipAsset(zip, slidePath, relationship, mediaContext);
  if (!asset?.mimeType.startsWith('image/')) return undefined;
  const renderedAsset = await applyPptxImageColorChange(asset, blipXml);
  return externalizeZipMediaAsset(
    renderedAsset.sourceKey,
    renderedAsset.bytes,
    renderedAsset.mimeType,
    'image',
    mediaContext,
    () =>
      `data:${renderedAsset.mimeType};base64,${Buffer.from(renderedAsset.bytes).toString('base64')}`,
  );
}

async function applyPptxImageColorChange(
  asset: ResolvedRelationshipAsset,
  blipXml?: string,
): Promise<ResolvedRelationshipAsset & { effectApplied?: boolean }> {
  const colorChange = extractPptxImageColorChange(blipXml);
  if (!colorChange) return asset;

  try {
    const { data, info } = await sharp(asset.bytes)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let changed = false;
    for (let offset = 0; offset < data.length; offset += info.channels) {
      if (
        data[offset] !== colorChange.from[0] ||
        data[offset + 1] !== colorChange.from[1] ||
        data[offset + 2] !== colorChange.from[2]
      ) {
        continue;
      }
      data[offset] = colorChange.to[0];
      data[offset + 1] = colorChange.to[1];
      data[offset + 2] = colorChange.to[2];
      data[offset + 3] = colorChange.to[3];
      changed = true;
    }
    if (!changed) return asset;

    return {
      ...asset,
      sourceKey: `${asset.sourceKey}.clrchange.png`,
      mimeType: 'image/png',
      bytes: await sharp(data, {
        raw: {
          width: info.width,
          height: info.height,
          channels: 4,
        },
      })
        .png()
        .toBuffer(),
      effectApplied: true,
    };
  } catch (error) {
    log.warn(`PPTX 图片透明色处理失败: asset=${asset.assetPath}, error=${getErrorMessage(error)}`);
    return asset;
  }
}

function extractPptxImageColorChange(blipXml?: string): {
  from: [number, number, number];
  to: [number, number, number, number];
} | null {
  const colorChangeXml = firstTagXml(blipXml ?? '', 'a:clrChange');
  const fromXml = firstTagXml(firstTagXml(colorChangeXml ?? '', 'a:clrFrom') ?? '', 'a:srgbClr');
  const toXml = firstTagXml(firstTagXml(colorChangeXml ?? '', 'a:clrTo') ?? '', 'a:srgbClr');
  const from = parseRgbHex(extractXmlAttr(fromXml ?? '', 'val'));
  const to = parseRgbHex(extractXmlAttr(toXml ?? '', 'val'));
  if (!from || !to) return null;

  const alphaRaw = Number(
    extractXmlAttr(firstTagXml(toXml ?? '', 'a:alpha') ?? '', 'val') ?? '100000',
  );
  const alpha = Number.isFinite(alphaRaw)
    ? Math.round((Math.min(100000, Math.max(0, alphaRaw)) / 100000) * 255)
    : 255;
  return { from, to: [to[0], to[1], to[2], alpha] };
}

function parseRgbHex(value?: string): [number, number, number] | null {
  if (!value || !/^[0-9a-f]{6}$/i.test(value)) return null;
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

function shouldSkipTinyFallbackPicture(
  normalized: Pick<SlideElementIR, 'width' | 'height'>,
  clipRange?: NonNullable<SlideElementIR['clip']>['range'],
) {
  const area = Math.max(0, normalized.width) * Math.max(0, normalized.height);
  if (area > 160) return false;
  if (Math.max(normalized.width, normalized.height) > 20) return false;

  // Keep intentionally cropped icons; drop near-dot artifacts from PPT internals.
  return !clipRange;
}

function extractFallbackNodeFrame(
  nodeXml: string,
  transform: XmlAffineTransform,
):
  | {
      x: number;
      y: number;
      width: number;
      height: number;
    }
  | undefined {
  const xfrmXml = firstTagXml(nodeXml, 'a:xfrm') || firstTagXml(nodeXml, 'p:xfrm');
  const offXml = xfrmXml ? firstTagXml(xfrmXml, 'a:off') : undefined;
  const extXml = xfrmXml ? firstTagXml(xfrmXml, 'a:ext') : undefined;
  const x = Number(extractXmlAttr(offXml ?? '', 'x'));
  const y = Number(extractXmlAttr(offXml ?? '', 'y'));
  const width = Number(extractXmlAttr(extXml ?? '', 'cx'));
  const height = Number(extractXmlAttr(extXml ?? '', 'cy'));
  const isLineFrame =
    /<p:cxnSp\b/i.test(nodeXml) || /<a:prstGeom\b[^>]*\bprst="line"/i.test(nodeXml);
  if (
    ![x, y, width, height].every((value) => Number.isFinite(value)) ||
    width < 0 ||
    height < 0 ||
    (isLineFrame ? width <= 0 && height <= 0 : width <= 0 || height <= 0)
  ) {
    return undefined;
  }
  return {
    x: emuToPt(transform.translateX + (x - transform.childOffsetX) * transform.scaleX),
    y: emuToPt(transform.translateY + (y - transform.childOffsetY) * transform.scaleY),
    width: emuToPt(width * transform.scaleX),
    height: emuToPt(height * transform.scaleY),
  };
}

function extractFallbackShapeKeypoints(
  spPrXml: string,
  shapeType?: string,
): SlideElementIR['keypoints'] | undefined {
  if (shapeType !== 'roundRect') return undefined;
  const prstGeomXml = firstTagXml(spPrXml, 'a:prstGeom');
  const guideXml = firstTagXml(firstTagXml(prstGeomXml ?? '', 'a:avLst') ?? '', 'a:gd');
  if (extractXmlAttr(guideXml ?? '', 'name') !== 'adj') return undefined;

  const match = (extractXmlAttr(guideXml ?? '', 'fmla') ?? '').match(/val\s+(-?\d+(?:\.\d+)?)/i);
  const raw = match ? Number(match[1]) : NaN;
  if (!Number.isFinite(raw)) return undefined;

  // DrawingML preset geometry adjustments use 1/100000 of the shape size.
  // Keeping the original ratio is important when the mapper rebuilds the path.
  return [roundCanvasNumber(Math.max(0, Math.min(0.5, raw / 100000)))];
}

function collectTextNodes(xml: string): string[] {
  return [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/gi)]
    .map((match) => decodeXmlText(match[1] ?? ''))
    .filter(Boolean);
}

function extractTextHighlights(nodeXml: string): PptxTextHighlight[] {
  const txBodyXml = firstTagXml(nodeXml, 'p:txBody') ?? '';
  return [...txBodyXml.matchAll(/<a:r\b[\s\S]*?<\/a:r>/gi)].flatMap((match) => {
    const runXml = match[0];
    const color = extractGradientStopColor(firstTagXml(runXml, 'a:highlight') ?? '');
    const text = collectTextNodes(runXml).join('');
    return color && text ? [{ text, color }] : [];
  });
}

function extractEmptyParagraphFontSizes(
  nodeXml: string,
  slideWidthPt: number,
): Record<number, number> | undefined {
  const txBodyXml = firstTagXml(nodeXml, 'p:txBody');
  if (!txBodyXml || slideWidthPt <= 0) return undefined;

  const result: Record<number, number> = {};
  for (const [index, paragraphXml] of splitDirectXmlChildren(txBodyXml, ['a:p']).entries()) {
    if (/<a:t\b[^>]*>[\s\S]*?\S[\s\S]*?<\/a:t>/i.test(paragraphXml)) continue;
    const rawSize = Number(extractXmlAttr(firstTagXml(paragraphXml, 'a:endParaRPr') ?? '', 'sz'));
    if (Number.isFinite(rawSize) && rawSize > 0) {
      result[index] = roundCanvasNumber((rawSize / 100) * (1000 / slideWidthPt));
    }
  }

  return Object.keys(result).length ? result : undefined;
}

function extractParagraphAlignments(
  nodeXml: string,
): Record<number, PptxParagraphAlignment> | undefined {
  const txBodyXml = firstTagXml(nodeXml, 'p:txBody');
  if (!txBodyXml) return undefined;

  const listStyleXml = firstTagXml(txBodyXml, 'a:lstStyle') ?? '';
  const alignments: Record<number, PptxParagraphAlignment> = {};
  for (const [index, paragraphXml] of splitDirectXmlChildren(txBodyXml, ['a:p']).entries()) {
    const paragraphPropsXml = firstTagXml(paragraphXml, 'a:pPr') ?? '';
    const rawLevel = Number(extractXmlAttr(paragraphPropsXml, 'lvl'));
    const level = Number.isInteger(rawLevel) && rawLevel >= 0 && rawLevel <= 8 ? rawLevel : 0;
    const listLevelPropsXml = firstTagXml(listStyleXml, `a:lvl${level + 1}pPr`) ?? '';
    const defaultPropsXml = firstTagXml(listStyleXml, 'a:defPPr') ?? '';
    const alignment =
      extractXmlAttr(paragraphPropsXml, 'algn') ??
      extractXmlAttr(listLevelPropsXml, 'algn') ??
      extractXmlAttr(defaultPropsXml, 'algn');
    if (alignment === 'l') alignments[index] = 'left';
    if (alignment === 'ctr') alignments[index] = 'center';
    if (alignment === 'r') alignments[index] = 'right';
    if (alignment === 'just') alignments[index] = 'justify';
    if (alignment === 'dist' || alignment === 'thaiDist') alignments[index] = 'distributed';
  }
  return Object.keys(alignments).length ? alignments : undefined;
}

function extractParagraphLineHeights(
  nodeXml: string,
  slideWidthPt: number,
): Record<number, PptxParagraphLineHeight> | undefined {
  const txBodyXml = firstTagXml(nodeXml, 'p:txBody');
  if (!txBodyXml) return undefined;

  const lineHeights: Record<number, PptxParagraphLineHeight> = {};
  for (const [index, paragraphXml] of splitDirectXmlChildren(txBodyXml, ['a:p']).entries()) {
    const paragraphPropsXml = firstTagXml(paragraphXml, 'a:pPr') ?? '';
    const lineSpacingXml = firstTagXml(paragraphPropsXml, 'a:lnSpc') ?? '';
    const spacingPercent = Number(
      extractXmlAttr(firstTagXml(lineSpacingXml, 'a:spcPct') ?? '', 'val'),
    );
    if (Number.isFinite(spacingPercent) && spacingPercent > 0) {
      lineHeights[index] = drawingMlPercentageLineSpacingToCssLineHeight(spacingPercent);
      continue;
    }

    const spacingPoints = Number(
      extractXmlAttr(firstTagXml(lineSpacingXml, 'a:spcPts') ?? '', 'val'),
    );
    if (Number.isFinite(spacingPoints) && spacingPoints > 0 && slideWidthPt > 0) {
      // DrawingML stores fixed line spacing in hundredths of a point. Keep it
      // absolute instead of converting it with an arbitrary font: mixed-font
      // paragraphs must retain the same baseline distance as PowerPoint.
      const canvasPixels = roundCanvasNumber((spacingPoints / 100) * (1000 / slideWidthPt));
      lineHeights[index] = `${canvasPixels}px`;
    }
  }
  return Object.keys(lineHeights).length ? lineHeights : undefined;
}

function extractParagraphSpaceBefore(
  nodeXml: string,
  slideWidthPt: number,
): Record<number, PptxParagraphSpacing> | undefined {
  const txBodyXml = firstTagXml(nodeXml, 'p:txBody');
  if (!txBodyXml) return undefined;

  const spacing: Record<number, PptxParagraphSpacing> = {};
  for (const [index, paragraphXml] of splitDirectXmlChildren(txBodyXml, ['a:p']).entries()) {
    const paragraphPropsXml = firstTagXml(paragraphXml, 'a:pPr') ?? '';
    const spaceBeforeXml = firstTagXml(paragraphPropsXml, 'a:spcBef') ?? '';
    const spacingPercent = Number(
      extractXmlAttr(firstTagXml(spaceBeforeXml, 'a:spcPct') ?? '', 'val'),
    );
    if (Number.isFinite(spacingPercent) && spacingPercent >= 0) {
      spacing[index] = {
        unit: 'line-height',
        value: roundCanvasNumber(spacingPercent / 100000),
      };
      continue;
    }

    const spacingPoints = Number(
      extractXmlAttr(firstTagXml(spaceBeforeXml, 'a:spcPts') ?? '', 'val'),
    );
    if (Number.isFinite(spacingPoints) && spacingPoints >= 0 && slideWidthPt > 0) {
      spacing[index] = {
        unit: 'px',
        value: roundCanvasNumber((spacingPoints / 100) * (1000 / slideWidthPt)),
      };
    }
  }
  return Object.keys(spacing).length ? spacing : undefined;
}

function drawingMlPercentageLineSpacingToCssLineHeight(spacingPercent: number): number {
  // DrawingML percentages scale Office's normal line box, while a unitless CSS
  // line-height scales the em square directly. Office/WPS normal leading is 1.2em.
  return roundCanvasNumber((spacingPercent / 100000) * PPTX_NORMAL_LINE_HEIGHT);
}

function collectFallbackParagraphText(xml: string): string {
  const paragraphs = [...xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/gi)]
    .map((match) => collectFallbackParagraphRuns(match[1] ?? ''))
    .map((text) => text.trim())
    .filter(Boolean);
  return paragraphs.join('\n');
}

function collectFallbackHardLineBreaks(xml: string): string[] {
  return [...xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/gi)].flatMap((paragraph) => {
    const breaks: string[] = [];
    let line = '';
    const tokens = [
      ...(paragraph[1] ?? '').matchAll(
        /<a:t>([\s\S]*?)<\/a:t>|<a:br\b[^>]*(?:\/>|>[\s\S]*?<\/a:br>)/gi,
      ),
    ];
    for (const token of tokens) {
      if (token[0].toLowerCase().startsWith('<a:br')) {
        if (line.trim()) breaks.push(line.trim());
        line = '';
      } else {
        line += decodeXmlText(token[1] ?? '');
      }
    }
    return breaks;
  });
}

function collectFallbackParagraphRuns(paragraphXml: string): string {
  const tokens = [
    ...paragraphXml.matchAll(/<a:t>([\s\S]*?)<\/a:t>|<a:br\b[^>]*(?:\/>|>[\s\S]*?<\/a:br>)/gi),
  ].map((match) =>
    match[0].toLowerCase().startsWith('<a:br') ? '\n' : decodeXmlText(match[1] ?? ''),
  );

  return tokens.join('').replace(/\n{2,}/g, '\n');
}

function extractAutoFitFromShapeNode(nodeXml: string): SlideElementIR['autoFit'] | undefined {
  const bodyPrXml = firstTagXml(nodeXml, 'a:bodyPr');
  return extractAutoFitFromBodyPr(bodyPrXml);
}

function extractVerticalAlignFromShapeNode(
  nodeXml: string,
): SlideElementIR['verticalAlign'] | undefined {
  const bodyPrXml = firstTagXml(nodeXml, 'a:bodyPr');
  const text = collectFallbackParagraphText(firstTagXml(nodeXml, 'p:txBody') ?? '');
  return extractVerticalAlignFromBodyPr(bodyPrXml, Boolean(text));
}

function extractVerticalAlignFromBodyPr(
  bodyPrXml?: string,
  hasText = false,
): SlideElementIR['verticalAlign'] | undefined {
  if (!bodyPrXml) {
    return hasText ? 'top' : undefined;
  }
  const verticalAlign = mapVerticalAlign(extractXmlAttr(bodyPrXml, 'anchor'));
  return verticalAlign ?? (hasText ? 'top' : undefined);
}

function extractAutoFitFromBodyPr(bodyPrXml?: string): SlideElementIR['autoFit'] | undefined {
  if (!bodyPrXml) return undefined;

  if (/<a:spAutoFit\b/i.test(bodyPrXml)) {
    return { type: 'shape' };
  }

  if (/<a:noAutofit\b/i.test(bodyPrXml)) {
    return { type: 'fixed' };
  }

  const normAutoFitXml = firstTagXml(bodyPrXml, 'a:normAutofit');
  if (!normAutoFitXml) return undefined;

  const fontScale = normalizeNumber(extractXmlAttr(normAutoFitXml, 'fontScale'));
  const lnSpcReduction = normalizeNumber(extractXmlAttr(normAutoFitXml, 'lnSpcReduction'));
  return {
    type: 'shrink',
    ...(fontScale != null ? { fontScale: fontScale / 100000 } : {}),
    ...(lnSpcReduction != null ? { lnSpcReduction: lnSpcReduction / 100000 } : {}),
  };
}

function extractOverflowVisibleFromBodyPr(
  bodyPrXml?: string,
  hasText = false,
  autoFit = extractAutoFitFromBodyPr(bodyPrXml),
): boolean | undefined {
  if (!bodyPrXml || !hasText) return undefined;

  const verticalOverflow = extractXmlAttr(bodyPrXml, 'vertOverflow')?.toLowerCase();
  if (verticalOverflow === 'overflow') return true;
  if (verticalOverflow === 'clip' || verticalOverflow === 'ellipsis') return false;

  // DrawingML no-autofit text and shape-autofit text can both extend past the
  // saved transform. In particular, spAutoFit grows the shape at layout time;
  // retaining visible overflow prevents browser font metrics from clipping the
  // final line by a fraction of a pixel. normAutofit is the only implicit mode
  // that must remain constrained to the authored box.
  return !autoFit || autoFit.type === 'fixed' || autoFit.type === 'shape' ? true : undefined;
}

function parseRelationshipEntries(xml?: string): Map<string, PptxRelationshipEntry> {
  const result = new Map<string, PptxRelationshipEntry>();
  if (!xml) return result;
  for (const match of xml.matchAll(/<Relationship\b([^>]*?)(?:\/>|>)/gi)) {
    const attrs = match[1] ?? '';
    const id = extractXmlAttr(`<Relationship ${attrs} />`, 'Id');
    if (!id) continue;
    result.set(id, {
      id,
      target: extractXmlAttr(`<Relationship ${attrs} />`, 'Target'),
      type: extractXmlAttr(`<Relationship ${attrs} />`, 'Type'),
      targetMode: extractXmlAttr(`<Relationship ${attrs} />`, 'TargetMode'),
    });
  }
  return result;
}

async function readZipText(zip: JSZip, path: string): Promise<string | undefined> {
  const file = zip.file(path);
  if (!file) return undefined;
  return file.async('string');
}

function extractPresentationSlideSize(xml?: string): { width: number; height: number } {
  if (!xml) return { width: 960, height: 540 };
  const match = xml.match(/<p:sldSz\b[^>]*cx="(\d+)"[^>]*cy="(\d+)"/i);
  const widthEmu = Number(match?.[1] ?? 0);
  const heightEmu = Number(match?.[2] ?? 0);
  return {
    width: emuToPt(widthEmu) || 960,
    height: emuToPt(heightEmu) || 540,
  };
}

function extractSortedSlidePaths(zip: JSZip): string[] {
  return Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/i.test(path))
    .sort((left, right) => {
      const leftNo = Number(left.match(/slide(\d+)\.xml$/i)?.[1] ?? 0);
      const rightNo = Number(right.match(/slide(\d+)\.xml$/i)?.[1] ?? 0);
      return leftNo - rightNo;
    });
}

function extractSlideElementMetadata(
  slideXml: string,
  slideWidthPt: number,
  slideHeightPt: number,
): PptxSlideElementMetadata[] {
  const treeXml = firstTagXml(slideXml, 'p:spTree');
  if (!treeXml) return [];

  return splitDirectXmlChildren(treeXml, [
    'p:sp',
    'p:pic',
    'p:cxnSp',
    'p:grpSp',
    'mc:AlternateContent',
  ]).flatMap((nodeXml) => flattenSlideNodeMetadata(nodeXml, slideWidthPt, slideHeightPt));
}

function extractTableNoFillBySourceId(slideXml: string): Map<string, boolean[][]> {
  const treeXml = firstTagXml(slideXml, 'p:spTree');
  const result = new Map<string, boolean[][]>();
  if (!treeXml) return result;

  const visit = (nodeXml: string): void => {
    if (/^<p:grpSp\b/i.test(nodeXml)) {
      for (const child of splitDirectXmlChildren(nodeXml, [
        'p:sp',
        'p:pic',
        'p:cxnSp',
        'p:grpSp',
        'p:graphicFrame',
        'mc:AlternateContent',
      ])) {
        visit(child);
      }
      return;
    }

    if (/^<mc:AlternateContent\b/i.test(nodeXml)) {
      const fallbackXml = firstTagXml(nodeXml, 'mc:Fallback');
      if (fallbackXml) {
        for (const child of splitDirectXmlChildren(fallbackXml, [
          'p:sp',
          'p:pic',
          'p:cxnSp',
          'p:grpSp',
          'p:graphicFrame',
        ])) {
          visit(child);
        }
      }
      return;
    }

    if (!/^<p:graphicFrame\b/i.test(nodeXml)) return;
    const tableXml = firstTagXml(nodeXml, 'a:tbl');
    const sourceId = extractXmlAttr(firstTagXml(nodeXml, 'p:cNvPr') ?? '', 'id');
    if (!tableXml || !sourceId) return;

    const rows = splitDirectXmlChildren(tableXml, ['a:tr']).map((rowXml) =>
      splitDirectXmlChildren(rowXml, ['a:tc']).map((cellXml) => {
        const propertiesXml = firstDirectChildTagXml(cellXml, 'a:tcPr');
        return Boolean(propertiesXml && firstDirectChildTagXml(propertiesXml, 'a:noFill'));
      }),
    );
    if (rows.some((row) => row.some(Boolean))) result.set(sourceId, rows);
  };

  for (const nodeXml of splitDirectXmlChildren(treeXml, [
    'p:sp',
    'p:pic',
    'p:cxnSp',
    'p:grpSp',
    'p:graphicFrame',
    'mc:AlternateContent',
  ])) {
    visit(nodeXml);
  }
  return result;
}

function flattenSlideNodeMetadata(
  nodeXml: string,
  slideWidthPt: number,
  slideHeightPt: number,
): PptxSlideElementMetadata[] {
  if (/^<p:grpSp\b/i.test(nodeXml)) {
    return splitDirectXmlChildren(nodeXml, [
      'p:sp',
      'p:pic',
      'p:cxnSp',
      'p:grpSp',
      'mc:AlternateContent',
    ]).flatMap((childXml) => flattenSlideNodeMetadata(childXml, slideWidthPt, slideHeightPt));
  }

  if (/^<mc:AlternateContent\b/i.test(nodeXml)) {
    const fallbackXml = firstTagXml(nodeXml, 'mc:Fallback');
    if (!fallbackXml) return [];
    return splitDirectXmlChildren(fallbackXml, ['p:sp', 'p:pic', 'p:cxnSp', 'p:grpSp']).flatMap(
      (childXml) => flattenSlideNodeMetadata(childXml, slideWidthPt, slideHeightPt),
    );
  }

  if (!/^<p:(?:sp|cxnSp)\b/i.test(nodeXml)) {
    return [];
  }

  const sourceElementId = extractXmlAttr(firstTagXml(nodeXml, 'p:cNvPr') ?? '', 'id');
  if (/^<p:cxnSp\b/i.test(nodeXml)) {
    return [{ ...(sourceElementId ? { sourceElementId } : {}) }];
  }

  const textHighlights = extractTextHighlights(nodeXml);
  const emptyParagraphFontSizes = extractEmptyParagraphFontSizes(nodeXml, slideWidthPt);
  const paragraphAlignments = extractParagraphAlignments(nodeXml);
  const distributedParagraphIndexes = paragraphAlignments
    ? Object.entries(paragraphAlignments).flatMap(([index, alignment]) =>
        alignment === 'distributed' ? [Number(index)] : [],
      )
    : undefined;
  const paragraphLineHeights = extractParagraphLineHeights(nodeXml, slideWidthPt);
  const paragraphSpaceBefore = extractParagraphSpaceBefore(nodeXml, slideWidthPt);
  const paragraphBreaks = extractParagraphBreaks(nodeXml);
  const noWrap = extractXmlAttr(firstTagXml(nodeXml, 'a:bodyPr') ?? '', 'wrap') === 'none';
  const bodyPrXml = firstTagXml(nodeXml, 'a:bodyPr');
  const hasTextBody = Boolean(firstTagXml(nodeXml, 'p:txBody'));
  const textInsets = extractTextInsetsFromShapeNode(nodeXml, slideWidthPt);
  const patternCrop = extractPatternCropFromShapeNode(nodeXml);
  const patternScaleMode = extractPatternScaleModeFromShapeNode(nodeXml);
  const verticalAlign = extractVerticalAlignFromShapeNode(nodeXml);
  const autoFit = extractAutoFitFromShapeNode(nodeXml);
  const overflowVisible = extractOverflowVisibleFromBodyPr(bodyPrXml, hasTextBody, autoFit);
  const shapeType = extractXmlAttr(firstTagXml(nodeXml, 'a:prstGeom') ?? '', 'prst');
  const spPrXml = firstTagXml(nodeXml, 'p:spPr') ?? '';
  const keypoints = extractFallbackShapeKeypoints(spPrXml, shapeType);
  const borderWidth = extractSourceShapeLineWidth(nodeXml, spPrXml);
  const borderType = extractLineType(firstTagXml(spPrXml, 'a:ln'));

  return [
    {
      ...(sourceElementId ? { sourceElementId } : {}),
      ...(textHighlights.length > 0 ? { textHighlights } : {}),
      ...(emptyParagraphFontSizes ? { emptyParagraphFontSizes } : {}),
      ...(distributedParagraphIndexes ? { distributedParagraphIndexes } : {}),
      ...(paragraphAlignments ? { paragraphAlignments } : {}),
      ...(paragraphLineHeights ? { paragraphLineHeights } : {}),
      ...(paragraphSpaceBefore ? { paragraphSpaceBefore } : {}),
      ...(paragraphBreaks.length > 0 ? { paragraphBreaks } : {}),
      ...(noWrap ? { noWrap: true } : {}),
      ...(overflowVisible != null ? { overflowVisible } : {}),
      ...(textInsets ? { textInsets } : {}),
      ...(patternScaleMode ? { patternScaleMode } : {}),
      ...(patternCrop ? { patternCrop } : {}),
      ...(verticalAlign ? { verticalAlign } : {}),
      ...(autoFit ? { autoFit } : {}),
      ...(keypoints ? { keypoints } : {}),
      ...(borderWidth != null ? { borderWidth } : {}),
      ...(borderType ? { borderType } : {}),
    },
  ];
}

function extractParagraphBreaks(nodeXml: string): string[] {
  const textBodyXml = firstTagXml(nodeXml, 'p:txBody');
  if (!textBodyXml) return [];

  const paragraphs = [...textBodyXml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/gi)]
    .map((match) =>
      decodeXmlText(
        [...match[1].matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/gi)]
          .map((textMatch) => textMatch[1] ?? '')
          .join(''),
      ).trim(),
    )
    .filter(Boolean);

  return paragraphs.slice(1);
}

function extractSourceShapeLineWidth(nodeXml: string, spPrXml: string): number | undefined {
  const lineXml = firstTagXml(spPrXml, 'a:ln');
  if (lineXml) {
    return firstTagXml(lineXml, 'a:noFill') ? 0 : extractLineWidth(lineXml);
  }

  return firstTagXml(nodeXml, 'p:style') ? undefined : 0;
}

async function extractSlideFallbackElements(
  zip: JSZip,
  slidePath: string,
  slideXml: string,
  relationships: Map<string, PptxRelationshipEntry>,
  deckSize: { width: number; height: number },
  mediaContext?: PptxImportMediaContext,
  layoutContext?: PptxSlideLayoutContext,
  themeStyle?: PptxThemeStyleContext,
): Promise<SlideElementIR[]> {
  const treeXml = firstTagXml(slideXml, 'p:spTree');
  if (!treeXml) return [];

  const mediaPlaybackTriggers = collectMediaPlaybackTriggers(slideXml);
  const nodes = splitDirectXmlChildren(treeXml, [
    'p:sp',
    'p:pic',
    'p:cxnSp',
    'p:grpSp',
    'p:graphicFrame',
    'mc:AlternateContent',
  ]);
  const renderableElements: SlideElementIR[] = layoutContext
    ? await extractSlideLayoutRenderableElements(
        zip,
        layoutContext,
        deckSize,
        mediaContext,
        slideXml,
        themeStyle,
      )
    : [];
  const targetHeight = targetHeightFromWidth(1000, deckSize.width, deckSize.height);
  for (const [index, nodeXml] of nodes.entries()) {
    const elements = await flattenFallbackRenderableNode(
      zip,
      slidePath,
      nodeXml,
      relationships,
      deckSize,
      targetHeight,
      index,
      mediaPlaybackTriggers,
      undefined,
      mediaContext,
      [],
      themeStyle,
    );
    renderableElements.push(...elements);
  }

  const fallbackElements: SlideElementIR[] = renderableElements.map((element) =>
    unscaleSupplementElement(element, deckSize.width, deckSize.height, targetHeight),
  );
  return fallbackElements;
}

function unscaleSupplementElement(
  element: SlideElementIR,
  pageWidth: number,
  pageHeight: number,
  targetHeight: number,
): SlideElementIR {
  return {
    ...element,
    left: roundCanvasNumber((element.left / 1000) * pageWidth),
    top: roundCanvasNumber((element.top / targetHeight) * pageHeight),
    width: roundCanvasNumber((element.width / 1000) * pageWidth),
    height: roundCanvasNumber((element.height / targetHeight) * pageHeight),
  };
}

function flattenChartFrameNodes(
  nodeXml: string,
  transform: XmlAffineTransform = identityXmlTransform(),
): ChartFrameNode[] {
  if (/^<p:grpSp\b/i.test(nodeXml)) {
    const nextTransform = combineXmlTransforms(transform, extractGroupTransform(nodeXml));
    return splitDirectXmlChildren(nodeXml, [
      'p:sp',
      'p:pic',
      'p:cxnSp',
      'p:grpSp',
      'p:graphicFrame',
      'mc:AlternateContent',
    ]).flatMap((childXml) => flattenChartFrameNodes(childXml, nextTransform));
  }

  if (/^<mc:AlternateContent\b/i.test(nodeXml)) {
    const fallbackXml = firstTagXml(nodeXml, 'mc:Fallback');
    if (!fallbackXml) return [];
    return splitDirectXmlChildren(fallbackXml, [
      'p:sp',
      'p:pic',
      'p:cxnSp',
      'p:grpSp',
      'p:graphicFrame',
    ]).flatMap((childXml) => flattenChartFrameNodes(childXml, transform));
  }

  if (!/^<p:graphicFrame\b/i.test(nodeXml)) {
    return [];
  }

  const chartXml = firstTagXml(nodeXml, 'c:chart');
  const relId = chartXml ? extractXmlAttr(chartXml, 'r:id') : undefined;
  if (!relId) return [];

  const xfrmXml = firstTagXml(nodeXml, 'p:xfrm');
  const offXml = xfrmXml ? firstTagXml(xfrmXml, 'a:off') : undefined;
  const extXml = xfrmXml ? firstTagXml(xfrmXml, 'a:ext') : undefined;
  const x = Number(extractXmlAttr(offXml ?? '', 'x'));
  const y = Number(extractXmlAttr(offXml ?? '', 'y'));
  const width = Number(extractXmlAttr(extXml ?? '', 'cx'));
  const height = Number(extractXmlAttr(extXml ?? '', 'cy'));
  if (
    ![x, y, width, height].every((value) => Number.isFinite(value)) ||
    width <= 0 ||
    height <= 0
  ) {
    return [];
  }

  const id = extractXmlAttr(firstTagXml(nodeXml, 'p:cNvPr') ?? '', 'id') || relId;
  return [
    {
      id: sanitizeIdPart(id),
      relId,
      x: emuToPt(transform.translateX + (x - transform.childOffsetX) * transform.scaleX),
      y: emuToPt(transform.translateY + (y - transform.childOffsetY) * transform.scaleY),
      width: emuToPt(width * transform.scaleX),
      height: emuToPt(height * transform.scaleY),
    },
  ];
}

function extractTextInsetsFromShapeNode(
  nodeXml: string,
  slideWidthPt: number,
): SlideElementIR['textInsets'] | undefined {
  const bodyPrXml = firstTagXml(nodeXml, 'a:bodyPr');
  if (!bodyPrXml) return undefined;
  return extractPptxTextInsetsFromBodyPr(bodyPrXml, slideWidthPt);
}

function extractTextInsetsFromBodyPr(
  bodyPrXml: string,
  params: {
    rect: Pick<SlideElementIR, 'width' | 'height'>;
    deckSize: { width: number; height: number };
    hasVisualFill: boolean;
  },
): SlideElementIR['textInsets'] | undefined {
  return extractPptxTextInsetsFromBodyPr(bodyPrXml, params.deckSize.width);
}

function extractPptxTextInsetsFromBodyPr(
  bodyPrXml: string,
  slideWidthPt: number,
): SlideElementIR['textInsets'] {
  return {
    left: insetEmuAttrToCanvasPx(bodyPrXml, 'lIns', slideWidthPt, PPTX_DEFAULT_TEXT_INSET_EMU.left),
    right: insetEmuAttrToCanvasPx(
      bodyPrXml,
      'rIns',
      slideWidthPt,
      PPTX_DEFAULT_TEXT_INSET_EMU.right,
    ),
    top: insetEmuAttrToCanvasPx(bodyPrXml, 'tIns', slideWidthPt, PPTX_DEFAULT_TEXT_INSET_EMU.top),
    bottom: insetEmuAttrToCanvasPx(
      bodyPrXml,
      'bIns',
      slideWidthPt,
      PPTX_DEFAULT_TEXT_INSET_EMU.bottom,
    ),
  };
}

function normalizeTextInsets(
  params: {
    left?: number;
    right?: number;
    top?: number;
    bottom?: number;
    l?: number;
    r?: number;
    t?: number;
    b?: number;
  },
  scale = 1,
): SlideElementIR['textInsets'] | undefined {
  const scaleInset = (value: number | undefined) =>
    value == null ? undefined : roundCanvasNumber(value * scale);
  const left = scaleInset(params.left ?? params.l);
  const right = scaleInset(params.right ?? params.r);
  const top = scaleInset(params.top ?? params.t);
  const bottom = scaleInset(params.bottom ?? params.b);
  if (left == null && right == null && top == null && bottom == null) {
    return undefined;
  }

  return {
    ...(left != null ? { left } : {}),
    ...(right != null ? { right } : {}),
    ...(top != null ? { top } : {}),
    ...(bottom != null ? { bottom } : {}),
  };
}

function normalizeImportedMediaReference(
  value: unknown,
  elementId: string | undefined,
  assetType: 'image' | 'video' | 'audio',
  mediaContext?: PptxImportMediaContext,
): string | undefined {
  const dataUrl = normalizeDataUrl(value);
  if (!dataUrl) {
    if (typeof value !== 'string') return undefined;
    if (mediaContext?.resolveExternalMedia) return undefined;
    return /^(?:[a-z][a-z0-9+.-]*:|[\\/])/i.test(value.trim()) ? undefined : value;
  }
  void elementId;
  void assetType;
  void mediaContext;
  return dataUrl;
}

async function loadRelationshipAsset(
  zip: JSZip,
  slidePath: string,
  relationship: PptxRelationshipEntry | undefined,
  mediaContext?: PptxImportMediaContext,
): Promise<ResolvedRelationshipAsset | undefined> {
  const target = relationship?.target;
  if (!target) return undefined;

  if (relationship.targetMode?.toLowerCase() === 'external') {
    const resolution = mediaContext?.resolveExternalMedia
      ? await mediaContext.resolveExternalMedia(target)
      : classifyUnresolvedExternalMedia(target);
    if (resolution.status !== 'resolved') {
      recordExternalMediaWarning(mediaContext, slidePath, target, resolution);
      return undefined;
    }
    return {
      sourceKey: resolution.sourceKey,
      assetPath: resolution.assetPath,
      mimeType: resolution.mimeType,
      bytes: resolution.bytes,
    };
  }

  const assetPath = resolveZipTarget(slidePath, target);
  const file = zip.file(assetPath);
  if (!file) return undefined;
  return {
    sourceKey: assetPath,
    assetPath,
    mimeType: guessMimeTypeFromPath(assetPath),
    bytes: await file.async('uint8array'),
  };
}

function classifyUnresolvedExternalMedia(target: string): ExternalMediaResolution {
  if (/^(?:https?:)?\/\//i.test(target.trim())) {
    return { status: 'remote', basename: sanitizeExternalTargetBasename(target) };
  }
  if (!target.trim() || /^null$/i.test(target.trim())) {
    return { status: 'invalid', basename: sanitizeExternalTargetBasename(target) };
  }
  return { status: 'missing', basename: sanitizeExternalTargetBasename(target) };
}

function recordExternalMediaWarning(
  mediaContext: PptxImportMediaContext | undefined,
  slidePath: string,
  target: string,
  resolution: Exclude<ExternalMediaResolution, { status: 'resolved' }>,
): void {
  if (!mediaContext) return;
  const code =
    resolution.status === 'remote'
      ? 'REMOTE_EXTERNAL_MEDIA_SKIPPED'
      : resolution.status === 'missing'
        ? 'EXTERNAL_MEDIA_MISSING'
        : resolution.status === 'ambiguous'
          ? 'EXTERNAL_MEDIA_AMBIGUOUS'
          : 'EXTERNAL_MEDIA_INVALID';
  const basename = resolution.basename || sanitizeExternalTargetBasename(target) || '未知媒体';
  const key = `${code}:${slidePath}:${basename.toLowerCase()}`;
  if (mediaContext.warningKeys.has(key)) return;
  mediaContext.warningKeys.add(key);
  mediaContext.warnings.push({
    code,
    severity: 'warning',
    message: `${slidePath} 的外链媒体“${basename}”${describeExternalMediaWarning(resolution.status)}`,
  });
}

async function recordPptxAuxiliaryMasterWarnings(
  zip: JSZip,
  mediaContext?: PptxImportMediaContext,
): Promise<void> {
  if (!mediaContext) return;
  // Inspect package parts too: unreferenced masters can still contain user content.
  for (const path of Object.keys(zip.files).sort()) {
    const kind = path.match(/^ppt\/(notes|handout)Masters\/[^/]+\.xml$/)?.[1];
    if (!kind) continue;
    const code =
      kind === 'notes' ? 'PPTX_NOTES_MASTER_UNVERIFIED' : 'PPTX_HANDOUT_MASTER_UNVERIFIED';
    const key = `${code}:${path}`;
    if (mediaContext.warningKeys.has(key)) continue;
    const xml = await readZipText(zip, path);
    if (!xml) continue;
    const background = firstTagXml(xml, 'p:bgPr');
    const backgroundColor = firstTagXml(firstDirectChildTagXml(background ?? '', 'a:solidFill') ?? '', 'a:schemeClr') ?? '';
    const defaultBackground = extractXmlAttr(backgroundColor, 'val') === 'bg1' && !/<a:(?!schemeClr\b)/.test(backgroundColor);
    // shortcut: placeholder-only text/style changes remain review warnings; expand when master rendering is supported.
    const customContent = Boolean(
      background && !defaultBackground ||
      /<p:(?:pic|graphicFrame|cxnSp)\b/.test(xml) ||
      collectXmlBlocks(xml, 'p:sp').some((shape) => {
        if (!firstTagXml(shape, 'p:ph')) return true;
        const properties = firstTagXml(shape, 'p:spPr') ?? '';
        return ['a:solidFill', 'a:gradFill', 'a:blipFill', 'a:pattFill'].some((tag) =>
          Boolean(firstDirectChildTagXml(properties, tag)),
        );
      }),
    );
    const label = kind === 'notes' ? '备注母版' : '讲义母版';
    mediaContext.warningKeys.add(key);
    mediaContext.warnings.push({
      code,
      severity: customContent ? 'error' : 'warning',
      message: customContent
        ? `PPTX ${label}包含尚未还原的自定义背景或图形，须核对原稿后再发布`
        : `PPTX 包含${label}，当前仅提取逐页备注，未验证母版版式与样式的保留情况，须人工核对`,
    });
  }
}

async function recordPptxContentWarnings(
  zip: JSZip,
  slidePath: string,
  slideXml: string,
  relationships: Map<string, PptxRelationshipEntry>,
  pageIndex: number,
  mediaContext?: PptxImportMediaContext,
): Promise<void> {
  if (!mediaContext) return;
  const record = (code: string, detail: string) => {
    const key = `${code}:${slidePath}`;
    if (mediaContext.warningKeys.has(key)) return;
    mediaContext.warningKeys.add(key);
    mediaContext.warnings.push({
      code,
      pageIndex,
      severity: 'error',
      message: `PPTX 第 ${pageIndex + 1} 页${detail}，须核对原稿后再发布`,
    });
  };
  // Presence is conservative: an alternate picture may exist, but math fidelity is not verified.
  if (/<(?:[A-Za-z_][\w.-]*:)?oMath(?:Para)?\b/.test(slideXml)) {
    record('PPTX_NATIVE_MATH_UNVERIFIED', '包含尚未验证还原的原生 Office 公式');
  }
  if (/<(?:[A-Za-z_][\w.-]*:)?linkedTxbx\b/.test(slideXml)) {
    record('PPTX_LINKED_TEXT_UNVERIFIED', '包含尚未验证文本流顺序与溢出还原的链接文本框');
  }
  for (const frameXml of collectXmlBlocks(slideXml, 'p:graphicFrame')) {
    for (const frame of flattenChartFrameNodes(frameXml)) {
      const target = relationships.get(frame.relId)?.target;
      if (!target) continue;
      const chartXml = await readZipText(zip, resolveZipTarget(slidePath, target));
      if (parseChartModel(chartXml).chartType === 'summary') {
        record('PPTX_CHART_SUMMARY_ONLY', '包含仅转换为摘要图、未还原原始图表的内容');
      }
    }
  }
}

function recordPptxTimingWarning(
  mediaContext: PptxImportMediaContext | undefined,
  slidePath: string,
  pageIndex: number,
  code: string,
  partial: boolean,
): void {
  if (!mediaContext) return;
  const key = `${code}:${slidePath}:${partial ? 'partial' : 'page'}`;
  if (mediaContext.warningKeys.has(key)) return;
  mediaContext.warningKeys.add(key);
  mediaContext.warnings.push({
    code,
    pageIndex,
    severity: 'warning',
    message: partial
      ? `PPTX 第 ${pageIndex + 1} 页存在暂不支持的动画分支（${code}），已跳过该分支，其余可还原动画和页面内容正常导入`
      : `PPTX 第 ${pageIndex + 1} 页动画结构暂不支持（${code}），已按静态页面导入`,
  });
}

function describeExternalMediaWarning(
  status: Exclude<ExternalMediaResolution['status'], 'resolved'>,
) {
  if (status === 'remote') return '为 HTTP/HTTPS 远程资源，已跳过';
  if (status === 'ambiguous') return '在 ZIP 中存在多个同名候选，已跳过';
  if (status === 'missing') return '未在 ZIP 中找到，已跳过';
  return '地址无效，已跳过';
}

function sanitizeExternalTargetBasename(target: string): string | undefined {
  const clean = target.replace(/\\/g, '/').split(/[?#]/, 1)[0] ?? '';
  const value = clean.slice(clean.lastIndexOf('/') + 1).trim();
  try {
    return decodeURIComponent(value).normalize('NFC') || undefined;
  } catch {
    return value.normalize('NFC') || undefined;
  }
}

async function externalizeZipMediaAsset(
  assetPath: string,
  bytes: Uint8Array,
  mimeType: string,
  assetType: 'image' | 'video' | 'audio',
  mediaContext: PptxImportMediaContext | undefined,
  fallback: () => string,
): Promise<string> {
  const registry = mediaContext?.assetRegistry;
  if (!registry) {
    return fallback();
  }
  return registry.registerAsset({
    assetType,
    sourceKey: assetPath,
    mimeType,
    buffer: bytes,
    ext: normalizeMediaExtension(assetPath),
  });
}

function parseChartModel(chartXml?: string): ParsedChartModel {
  if (!chartXml) {
    return {
      chartType: 'summary',
      labels: [],
      legends: [],
      series: [],
      themeColors: DEFAULT_IMPORT_THEME.themeColors,
    };
  }

  const pieChartXml = firstTagXml(chartXml, 'c:pieChart');
  if (pieChartXml) {
    return parseSingleChartType(pieChartXml, 'pie');
  }
  const ringChartXml = firstTagXml(chartXml, 'c:doughnutChart');
  if (ringChartXml) {
    return parseSingleChartType(ringChartXml, 'ring');
  }
  const scatterChartXml = firstTagXml(chartXml, 'c:scatterChart');
  if (scatterChartXml) {
    return parseScatterOrBubbleChartType(chartXml, scatterChartXml, 'scatter');
  }
  const bubbleChartXml = firstTagXml(chartXml, 'c:bubbleChart');
  if (bubbleChartXml) {
    return parseScatterOrBubbleChartType(chartXml, bubbleChartXml, 'bubble');
  }
  const radarChartXml = firstTagXml(chartXml, 'c:radarChart');
  if (radarChartXml) {
    return parseSingleChartType(radarChartXml, 'radar');
  }

  const cartesianSeries = extractCartesianChartSeries(chartXml);
  if (cartesianSeries.length > 0) {
    const axes = extractChartAxes(chartXml);
    const chartStyle = extractChartStyle(chartXml);
    const labels = cartesianSeries.find((series) => series.labels.length > 0)?.labels ?? [];
    const legends = cartesianSeries.map((series, index) => series.legend || `系列 ${index + 1}`);
    const themeColors = cartesianSeries.map(
      (series, index) =>
        series.color ||
        DEFAULT_IMPORT_THEME.themeColors[index % DEFAULT_IMPORT_THEME.themeColors.length],
    );
    const uniqueTypes = Array.from(new Set(cartesianSeries.map((series) => series.type)));
    const primaryType =
      uniqueTypes.length === 1
        ? uniqueTypes[0]
        : uniqueTypes.includes('column')
          ? 'column'
          : uniqueTypes[0];
    const stack = /<c:grouping\b[^>]*val="stacked"/i.test(chartXml);
    const smooth = /<c:smooth\b[^>]*val="1"/i.test(chartXml);

    return {
      chartType: primaryType,
      labels,
      legends,
      series: cartesianSeries.map((series) => series.values),
      themeColors: themeColors.length > 0 ? themeColors : DEFAULT_IMPORT_THEME.themeColors,
      seriesTypes: cartesianSeries.map((series) => series.type),
      seriesShowValues: cartesianSeries.map((series) => series.showValues ?? true),
      seriesAxisIds: cartesianSeries.map((series) => series.axisId),
      seriesFormatCodes: cartesianSeries.map((series) => series.formatCode),
      seriesLineWidths: cartesianSeries.map((series) => series.lineWidth),
      seriesMarkerKinds: cartesianSeries.map((series) => series.markerKind),
      seriesMarkerSizes: cartesianSeries.map((series) => series.markerSize),
      ...(axes.primaryAxis ? { primaryAxis: axes.primaryAxis } : {}),
      ...(axes.secondaryAxis ? { secondaryAxis: axes.secondaryAxis } : {}),
      ...(chartStyle.chartBackgroundColor
        ? { chartBackgroundColor: chartStyle.chartBackgroundColor }
        : {}),
      ...(chartStyle.plotAreaBackgroundColor
        ? { plotAreaBackgroundColor: chartStyle.plotAreaBackgroundColor }
        : {}),
      ...(stack ? { stack: true } : {}),
      ...(smooth ? { smooth: true } : {}),
    };
  }

  const summarySeries = extractChartSeriesBlocks(chartXml);
  return {
    chartType: 'summary',
    labels: summarySeries
      .flatMap((series) => series.labels)
      .filter((value, index, arr) => value && arr.indexOf(value) === index)
      .slice(0, 6),
    legends: summarySeries.map((series, index) => series.legend || `系列 ${index + 1}`).slice(0, 4),
    series: summarySeries.map((series) => series.values.slice(0, 6)).slice(0, 4),
    themeColors: summarySeries.map(
      (series, index) =>
        series.color ||
        DEFAULT_IMPORT_THEME.themeColors[index % DEFAULT_IMPORT_THEME.themeColors.length],
    ),
  };
}

function extractCartesianChartSeries(chartXml: string): Array<{
  type: 'bar' | 'column' | 'line' | 'area';
  legend: string;
  labels: string[];
  values: number[];
  color?: string;
  showValues?: boolean;
  axisId?: string;
  formatCode?: string;
  lineWidth?: number;
  markerKind?: string;
  markerSize?: number;
}> {
  const candidates: Array<{ tagName: string; type: 'bar' | 'column' | 'line' | 'area' }> = [
    { tagName: 'c:barChart', type: 'column' },
    { tagName: 'c:lineChart', type: 'line' },
    { tagName: 'c:areaChart', type: 'area' },
  ];
  const result: Array<{
    type: 'bar' | 'column' | 'line' | 'area';
    legend: string;
    labels: string[];
    values: number[];
    color?: string;
    showValues?: boolean;
    axisId?: string;
    formatCode?: string;
    lineWidth?: number;
    markerKind?: string;
    markerSize?: number;
  }> = [];

  for (const candidate of candidates) {
    const chartBlocks = collectXmlBlocks(chartXml, candidate.tagName);
    for (const block of chartBlocks) {
      const blockType =
        candidate.tagName === 'c:barChart'
          ? extractXmlAttr(block, 'val') === 'bar'
            ? 'bar'
            : 'column'
          : candidate.type;
      const valueAxisId = extractChartBlockValueAxisId(block);
      const series = extractChartSeriesBlocks(block).map((item) => ({
        ...item,
        type: blockType,
        ...(valueAxisId ? { axisId: valueAxisId } : {}),
      }));
      result.push(...series);
    }
  }

  return result;
}

function parseSingleChartType(
  chartXml: string,
  chartType: ParsedChartModel['chartType'],
): ParsedChartModel {
  const series = extractChartSeriesBlocks(chartXml);
  const labels = series.find((item) => item.labels.length > 0)?.labels ?? [];
  const legends = series.map((item, index) => item.legend || `系列 ${index + 1}`);
  const themeColors = series.map(
    (item, index) =>
      item.color ||
      DEFAULT_IMPORT_THEME.themeColors[index % DEFAULT_IMPORT_THEME.themeColors.length],
  );
  const stack = /<c:grouping\b[^>]*val="stacked"/i.test(chartXml);
  const smooth = /<c:smooth\b[^>]*val="1"/i.test(chartXml);

  return {
    chartType,
    labels,
    legends,
    series: series.map((item) => item.values),
    themeColors: themeColors.length > 0 ? themeColors : DEFAULT_IMPORT_THEME.themeColors,
    ...(stack ? { stack: true } : {}),
    ...(smooth ? { smooth: true } : {}),
  };
}

function parseScatterOrBubbleChartType(
  fullChartXml: string,
  chartXml: string,
  chartType: 'scatter' | 'bubble',
): ParsedChartModel {
  const chartStyle = extractChartStyle(fullChartXml);
  const series = extractScatterSeriesBlocks(chartXml);
  const legends = series.map((item, index) => item.legend || `系列 ${index + 1}`);
  const themeColors = series.map(
    (item, index) =>
      item.color ||
      DEFAULT_IMPORT_THEME.themeColors[index % DEFAULT_IMPORT_THEME.themeColors.length],
  );
  return {
    chartType,
    labels: [],
    legends,
    series: series.map((item) => item.yValues),
    scatterXSeries: series.map((item) => item.xValues),
    ...(chartType === 'bubble'
      ? { bubbleSizes: series.map((item) => item.bubbleSizes ?? []) }
      : {}),
    themeColors: themeColors.length > 0 ? themeColors : DEFAULT_IMPORT_THEME.themeColors,
    seriesLineWidths: series.map((item) => item.lineWidth),
    seriesMarkerKinds: series.map((item) => item.markerKind),
    seriesMarkerSizes: series.map((item) => item.markerSize),
    ...(chartStyle.chartBackgroundColor
      ? { chartBackgroundColor: chartStyle.chartBackgroundColor }
      : {}),
    ...(chartStyle.plotAreaBackgroundColor
      ? { plotAreaBackgroundColor: chartStyle.plotAreaBackgroundColor }
      : {}),
  };
}

function extractChartSeriesBlocks(chartXml: string): Array<{
  legend: string;
  labels: string[];
  values: number[];
  color?: string;
  showValues?: boolean;
  formatCode?: string;
  lineWidth?: number;
  markerKind?: string;
  markerSize?: number;
}> {
  const blocks = collectXmlBlocks(chartXml, 'c:ser');
  return blocks
    .map((seriesXml) => {
      const legend = extractChartTextValues(firstTagXml(seriesXml, 'c:tx')).join(' ').trim();
      const labels = extractChartTextValues(firstTagXml(seriesXml, 'c:cat'));
      const valueXml = firstTagXml(seriesXml, 'c:val');
      const values = extractChartNumericValues(valueXml);
      const color = resolveChartSeriesColor(seriesXml);
      const dataLabelsXml = firstTagXml(seriesXml, 'c:dLbls');
      const deleteLabels = extractXmlAttr(
        firstTagXml(dataLabelsXml ?? '', 'c:delete') ?? '',
        'val',
      );
      const showValues = extractXmlAttr(firstTagXml(dataLabelsXml ?? '', 'c:showVal') ?? '', 'val');
      const formatCode = extractChartFormatCode(valueXml);
      const marker = extractChartMarker(seriesXml);
      const lineWidth = extractChartSeriesLineWidth(seriesXml);
      return {
        legend,
        labels,
        values,
        ...(color ? { color } : {}),
        ...(deleteLabels === '1' || showValues === '0' ? { showValues: false } : {}),
        ...(formatCode ? { formatCode } : {}),
        ...(lineWidth != null ? { lineWidth } : {}),
        ...(marker.kind ? { markerKind: marker.kind } : {}),
        ...(marker.size != null ? { markerSize: marker.size } : {}),
      };
    })
    .filter((series) => series.values.length > 0 || series.labels.length > 0 || series.legend);
}

function extractScatterSeriesBlocks(chartXml: string): Array<{
  legend: string;
  xValues: number[];
  yValues: number[];
  bubbleSizes?: number[];
  color?: string;
  lineWidth?: number;
  markerKind?: string;
  markerSize?: number;
}> {
  return collectXmlBlocks(chartXml, 'c:ser')
    .map((seriesXml) => {
      const legend = extractChartTextValues(firstTagXml(seriesXml, 'c:tx')).join(' ').trim();
      const xValues = extractChartNumericValues(firstTagXml(seriesXml, 'c:xVal'));
      const yValues = extractChartNumericValues(firstTagXml(seriesXml, 'c:yVal'));
      const bubbleSizes = extractChartNumericValues(firstTagXml(seriesXml, 'c:bubbleSize'));
      const color = resolveChartSeriesColor(seriesXml);
      const marker = extractChartMarker(seriesXml);
      const lineWidth = extractChartSeriesLineWidth(seriesXml);
      return {
        legend,
        xValues,
        yValues,
        ...(bubbleSizes.length > 0 ? { bubbleSizes } : {}),
        ...(color ? { color } : {}),
        ...(lineWidth != null ? { lineWidth } : {}),
        ...(marker.kind ? { markerKind: marker.kind } : {}),
        ...(marker.size != null ? { markerSize: marker.size } : {}),
      };
    })
    .filter((series) => series.xValues.length > 0 || series.yValues.length > 0 || series.legend);
}

function extractChartBlockValueAxisId(chartBlockXml: string): string | undefined {
  const axisIds = [...chartBlockXml.matchAll(/<c:axId\b[^>]*val="([^"]+)"/gi)]
    .map((match) => match[1])
    .filter(Boolean);
  return axisIds[1] ?? axisIds[0];
}

function extractChartAxes(chartXml: string): {
  primaryAxis?: ParsedChartAxis;
  secondaryAxis?: ParsedChartAxis;
} {
  const valueAxes = collectXmlBlocks(chartXml, 'c:valAx').map(parseChartValueAxis);
  if (valueAxes.length === 0) return {};
  const primaryAxis = valueAxes.find((axis) => axis.position !== 'right') ?? valueAxes[0];
  const secondaryAxis =
    valueAxes.find((axis) => axis.id !== primaryAxis?.id && axis.position === 'right') ??
    valueAxes.find((axis) => axis.id !== primaryAxis?.id);

  return {
    ...(primaryAxis ? { primaryAxis } : {}),
    ...(secondaryAxis ? { secondaryAxis } : {}),
  };
}

function parseChartValueAxis(axisXml: string): ParsedChartAxis {
  const scalingXml = firstTagXml(axisXml, 'c:scaling');
  const minXml = scalingXml ? firstTagXml(scalingXml, 'c:min') : undefined;
  const maxXml = scalingXml ? firstTagXml(scalingXml, 'c:max') : undefined;
  const crossesXml = firstTagXml(axisXml, 'c:crosses');
  const formatXml = firstTagXml(axisXml, 'c:numFmt');
  const id = extractXmlAttr(firstTagXml(axisXml, 'c:axId') ?? '', 'val');
  const crosses = extractXmlAttr(crossesXml ?? '', 'val');
  const min = normalizeNumber(extractXmlAttr(minXml ?? '', 'val'));
  const max = normalizeNumber(extractXmlAttr(maxXml ?? '', 'val'));
  const formatCode = extractXmlAttr(formatXml ?? '', 'formatCode');

  return {
    ...(id ? { id } : {}),
    ...(min != null ? { min } : {}),
    ...(max != null ? { max } : {}),
    ...(formatCode ? { formatCode: decodeXmlText(formatCode) } : {}),
    ...(firstTagXml(axisXml, 'c:majorGridlines') ? { showMajorGridlines: true } : {}),
    position: crosses === 'max' ? 'right' : 'left',
  };
}

function extractChartFormatCode(valueXml?: string): string | undefined {
  if (!valueXml) return undefined;
  const formatCodeXml = firstTagXml(valueXml, 'c:formatCode');
  if (formatCodeXml) {
    const match = formatCodeXml.match(/<c:formatCode\b[^>]*>([\s\S]*?)<\/c:formatCode>/i);
    const value = decodeXmlText(match?.[1] ?? '').trim();
    if (value) return value;
  }
  const numFmtXml = firstTagXml(valueXml, 'c:numFmt');
  const formatCode = extractXmlAttr(numFmtXml ?? '', 'formatCode');
  return formatCode ? decodeXmlText(formatCode) : undefined;
}

function extractChartStyle(chartXml: string): {
  chartBackgroundColor?: string;
  plotAreaBackgroundColor?: string;
} {
  const chartSpaceXml = firstTagXml(chartXml, 'c:chartSpace') ?? chartXml;
  const chartNodeXml = firstDirectChildTagXml(chartSpaceXml, 'c:chart');
  const plotAreaXml = firstTagXml(chartNodeXml ?? '', 'c:plotArea');
  const chartBackgroundColor = extractSolidFillColor(
    firstDirectChildTagXml(chartSpaceXml, 'c:spPr') ??
      firstDirectChildTagXml(chartNodeXml ?? '', 'c:spPr'),
  );
  const plotAreaBackgroundColor = extractSolidFillColor(
    firstDirectChildTagXml(plotAreaXml ?? '', 'c:spPr'),
  );
  return {
    ...(chartBackgroundColor ? { chartBackgroundColor } : {}),
    ...(plotAreaBackgroundColor ? { plotAreaBackgroundColor } : {}),
  };
}

function extractChartSeriesLineWidth(seriesXml: string): number | undefined {
  const lineXml = firstTagXml(seriesXml, 'a:ln');
  const raw = Number(extractXmlAttr(lineXml ?? '', 'w'));
  if (!Number.isFinite(raw) || raw <= 0) return undefined;
  return Math.max(1, roundCanvasNumber(emuToPt(raw)));
}

function extractChartMarker(seriesXml: string): {
  kind?: string;
  size?: number;
} {
  const markerXml = firstTagXml(seriesXml, 'c:marker');
  if (!markerXml) return {};
  const symbol = extractXmlAttr(firstTagXml(markerXml, 'c:symbol') ?? '', 'val');
  const size = normalizeNumber(extractXmlAttr(firstTagXml(markerXml, 'c:size') ?? '', 'val'));
  return {
    ...(symbol && symbol !== 'none' ? { kind: symbol } : {}),
    ...(size != null ? { size } : {}),
  };
}

function extractSolidFillColor(xml?: string): string | undefined {
  if (!xml) return undefined;
  const solidFillXml = firstTagXml(xml, 'a:solidFill');
  if (!solidFillXml) return undefined;
  return extractColorFromSolidFillXml(solidFillXml);
}

function extractDirectSolidFillColor(
  xml?: string,
  schemeColors?: Readonly<Record<string, string>>,
): string | undefined {
  if (!xml) return undefined;
  return extractColorFromSolidFillXml(firstDirectChildTagXml(xml, 'a:solidFill'), schemeColors);
}

function extractColorFromSolidFillXml(
  solidFillXml?: string,
  schemeColors?: Readonly<Record<string, string>>,
): string | undefined {
  if (!solidFillXml) return undefined;
  const srgb = extractXmlAttr(firstTagXml(solidFillXml, 'a:srgbClr') ?? '', 'val');
  const srgbXml = firstTagXml(solidFillXml, 'a:srgbClr');
  if (srgb) {
    return applyColorTransform(`#${srgb.replace(/^#/, '')}`, srgbXml);
  }
  const schemeXml = firstTagXml(solidFillXml, 'a:schemeClr');
  return applyColorTransform(
    mapSchemeColor(extractXmlAttr(schemeXml ?? '', 'val'), schemeColors),
    schemeXml,
  );
}

function extractOuterShadow(
  effectXml: string | undefined,
  schemeColors: Readonly<Record<string, string>> | undefined,
  deckSize: { width: number },
): SlideElementIR['shadow'] | undefined {
  const shadowXml = firstTagXml(effectXml ?? '', 'a:outerShdw');
  if (!shadowXml) return undefined;
  const colorXml =
    firstTagXml(shadowXml, 'a:srgbClr') ??
    firstTagXml(shadowXml, 'a:schemeClr') ??
    firstTagXml(shadowXml, 'a:prstClr');
  const color = extractColorFromSolidFillXml(shadowXml, schemeColors) ?? '#000000';
  const alpha = normalizeNumber(
    extractXmlAttr(firstTagXml(colorXml ?? '', 'a:alpha') ?? '', 'val'),
  );
  const distance =
    (emuToPt(normalizeNumber(extractXmlAttr(shadowXml, 'dist')) ?? 0) / deckSize.width) * 1000;
  const angle =
    (((normalizeNumber(extractXmlAttr(shadowXml, 'dir')) ?? 0) / 60000) * Math.PI) / 180;
  const blur =
    (emuToPt(normalizeNumber(extractXmlAttr(shadowXml, 'blurRad')) ?? 0) / deckSize.width) * 1000;
  return {
    h: roundCanvasNumber(Math.cos(angle) * distance),
    v: roundCanvasNumber(Math.sin(angle) * distance),
    blur: roundCanvasNumber(blur),
    color: alpha != null ? applyAlpha(color, alpha / 100000) : color,
  };
}

function extractSolidFillOpacity(xml?: string): number | undefined {
  if (!xml) return undefined;
  const solidFillXml = firstTagXml(xml, 'a:solidFill');
  return extractSolidFillOpacityFromXml(solidFillXml);
}

function extractDirectSolidFillOpacity(xml?: string): number | undefined {
  if (!xml) return undefined;
  return extractSolidFillOpacityFromXml(firstDirectChildTagXml(xml, 'a:solidFill'));
}

function extractSolidFillOpacityFromXml(solidFillXml?: string): number | undefined {
  if (!solidFillXml) return undefined;
  const srgbXml = firstTagXml(solidFillXml, 'a:srgbClr');
  const schemeXml = firstTagXml(solidFillXml, 'a:schemeClr');
  const alphaXml = firstTagXml(srgbXml ?? schemeXml ?? '', 'a:alpha');
  const raw = Number(extractXmlAttr(alphaXml ?? '', 'val'));
  if (!Number.isFinite(raw)) return undefined;
  return roundCanvasNumber(Math.max(0, Math.min(1, raw / 100000)));
}

function extractBlipOpacity(blipXml?: string): number | undefined {
  const alphaModFixXml = firstTagXml(blipXml ?? '', 'a:alphaModFix');
  const raw = Number(extractXmlAttr(alphaModFixXml ?? '', 'amt'));
  if (!Number.isFinite(raw)) return undefined;
  return roundCanvasNumber(Math.max(0, Math.min(1, raw / 100000)));
}

function extractNodeRotation(nodeXml: string): number {
  const xfrmXml = firstTagXml(nodeXml, 'a:xfrm') || firstTagXml(nodeXml, 'p:xfrm');
  const raw = Number(extractXmlAttr(xfrmXml ?? '', 'rot'));
  if (!Number.isFinite(raw)) return 0;
  return roundCanvasNumber(raw / 60000);
}

function extractNodeFlip(nodeXml: string, attribute: 'flipH' | 'flipV'): boolean {
  const xfrmXml = firstTagXml(nodeXml, 'a:xfrm') || firstTagXml(nodeXml, 'p:xfrm');
  return extractXmlAttr(xfrmXml ?? '', attribute) === '1';
}

function extractGradientFill(xml?: string): SlideElementIR['fillGradient'] | undefined {
  if (!xml) return undefined;
  const trimmed = xml.trim();
  const directChildren = splitDirectXmlChildren(xml, [
    'a:gradFill',
    'a:solidFill',
    'a:noFill',
    'a:ln',
    'a:effectLst',
    'a:xfrm',
    'a:prstGeom',
    'a:custGeom',
  ]);
  const gradFillXml = /^<a:gradFill\b/i.test(trimmed)
    ? trimmed
    : directChildren.find((childXml) => /^<a:gradFill\b/i.test(childXml));
  if (!gradFillXml) return undefined;

  const colors = collectXmlBlocks(gradFillXml, 'a:gs')
    .map((stopXml) => {
      const pos = normalizeGradientStopPosition(extractXmlAttr(stopXml, 'pos'));
      const color = extractGradientStopColor(stopXml);
      if (pos == null || !color) return null;
      return { pos, color };
    })
    .filter((item): item is { pos: number; color: string } => Boolean(item));

  if (colors.length <= 0) return undefined;

  const path = extractXmlAttr(firstTagXml(gradFillXml, 'a:path') ?? '', 'path');
  const linearXml = firstTagXml(gradFillXml, 'a:lin');
  const angle = normalizeNumber(extractXmlAttr(linearXml ?? '', 'ang'));

  return {
    type: path === 'circle' || path === 'rect' ? 'radial' : 'linear',
    colors,
    rotate: angle != null ? roundCanvasNumber(angle / 60000) : 0,
  };
}

function extractLineWidth(lineXml?: string): number | undefined {
  if (!lineXml) return undefined;
  if (firstTagXml(lineXml, 'a:noFill') || /^<a:ln\s*(?:\/>|>\s*<\/a:ln>)$/.test(lineXml)) {
    return 0;
  }
  const raw = Number(extractXmlAttr(lineXml, 'w'));
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  return Math.max(1, roundCanvasNumber(emuToPt(raw)));
}

function extractLineType(lineXml?: string): SlideElementIR['borderType'] {
  if (!lineXml) return undefined;
  const preset = extractXmlAttr(firstTagXml(lineXml, 'a:prstDash') ?? '', 'val');
  if (!preset || preset === 'solid') return preset === 'solid' ? 'solid' : undefined;
  if (preset === 'dot' || preset === 'sysDot') return 'dotted';
  return 'dashed';
}

function extractLinePoints(lineXml?: string): SlideElementIR['points'] | undefined {
  if (!lineXml) return undefined;
  const mapPoint = (type?: string): '' | 'arrow' | 'dot' => {
    if (type === 'oval') return 'dot';
    if (type === 'triangle' || type === 'stealth') return 'arrow';
    return '';
  };
  const points: NonNullable<SlideElementIR['points']> = [
    mapPoint(extractXmlAttr(firstTagXml(lineXml, 'a:headEnd') ?? '', 'type')),
    mapPoint(extractXmlAttr(firstTagXml(lineXml, 'a:tailEnd') ?? '', 'type')),
  ];
  return points[0] || points[1] ? points : undefined;
}

function extractParagraphLineHeight(
  paragraphPrXml?: string,
  fontSizeHundredthPoints?: number,
): number | undefined {
  if (!paragraphPrXml) return undefined;
  const lineSpacingXml = firstTagXml(paragraphPrXml, 'a:lnSpc');
  const pctXml = firstTagXml(lineSpacingXml ?? '', 'a:spcPct');
  const raw = normalizeNumber(extractXmlAttr(pctXml ?? '', 'val'));
  if (raw != null) return drawingMlPercentageLineSpacingToCssLineHeight(raw);

  const pointsXml = firstTagXml(lineSpacingXml ?? '', 'a:spcPts');
  const fixedPoints = normalizeNumber(extractXmlAttr(pointsXml ?? '', 'val'));
  if (fixedPoints == null || fontSizeHundredthPoints == null || fontSizeHundredthPoints <= 0) {
    return undefined;
  }
  return roundCanvasNumber(fixedPoints / fontSizeHundredthPoints);
}

function normalizeGradientStopPosition(value: string | undefined): number | undefined {
  const raw = normalizeNumber(value);
  if (raw == null) return undefined;
  const pos = raw > 100 ? raw / 1000 : raw;
  return clampPercent(pos);
}

function extractGradientStopColor(stopXml: string): string | undefined {
  const srgbXml = firstTagXml(stopXml, 'a:srgbClr');
  const schemeXml = firstTagXml(stopXml, 'a:schemeClr');
  const srgb = extractXmlAttr(srgbXml ?? '', 'val');
  const baseColor = srgb
    ? `#${srgb.replace(/^#/, '')}`
    : mapSchemeColor(extractXmlAttr(schemeXml ?? '', 'val'));
  if (!baseColor) return undefined;

  const alphaXml = firstTagXml(srgbXml ?? schemeXml ?? '', 'a:alpha');
  const alpha = normalizeGradientAlpha(extractXmlAttr(alphaXml ?? '', 'val'));
  return alpha == null ? baseColor : applyAlpha(baseColor, alpha);
}

function normalizeGradientAlpha(value: string | undefined): number | undefined {
  const raw = normalizeNumber(value);
  if (raw == null) return undefined;
  return Math.max(0, Math.min(1, raw / 100000));
}

function extractFallbackCustomGeometry(nodeXml: string): FallbackCustomGeometry | undefined {
  const custGeomXml = firstTagXml(nodeXml, 'a:custGeom');
  if (!custGeomXml) return undefined;
  const pathXml = firstTagXml(custGeomXml, 'a:path');
  if (!pathXml) return undefined;

  const width = Number(extractXmlAttr(pathXml, 'w'));
  const height = Number(extractXmlAttr(pathXml, 'h'));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return undefined;
  }

  const path = convertCustGeomPathToSvg(pathXml);
  if (!path) return undefined;

  return {
    path,
    viewBox: [width, height],
  };
}

function extractFallbackPresetGeometry(
  nodeXml: string,
  shapeType: string | undefined,
  size: { width: number; height: number },
): FallbackCustomGeometry | undefined {
  if (
    shapeType !== 'wedgeRoundRectCallout' &&
    shapeType !== 'wedgeRectCallout' &&
    shapeType !== 'wedgeEllipseCallout' &&
    shapeType !== 'bentConnector2' &&
    shapeType !== 'bentConnector3'
  ) {
    return undefined;
  }

  const { width, height } = size;
  if (!(width > 0 && height > 0)) return undefined;

  const adjustments = new Map<string, number>();
  const avListXml = firstTagXml(nodeXml, 'a:avLst') ?? '';
  for (const guideXml of collectXmlBlocks(avListXml, 'a:gd')) {
    const name = extractXmlAttr(guideXml, 'name');
    const formula = extractXmlAttr(guideXml, 'fmla');
    const rawValue = formula?.match(/(?:^|\s)val\s+(-?\d+(?:\.\d+)?)/i)?.[1];
    const value = rawValue == null ? undefined : Number(rawValue);
    if (name && Number.isFinite(value)) adjustments.set(name, value as number);
  }

  const n = roundCanvasNumber;
  const viewBox: [number, number] = [n(width), n(height)];
  if (shapeType === 'bentConnector2') {
    return {
      path: `M ${n(width)} 0 L ${n(width)} ${n(height)} L 0 ${n(height)}`,
      viewBox,
    };
  }
  if (shapeType === 'bentConnector3') {
    const elbowX = width * ((adjustments.get('adj1') ?? 50_000) / 100_000);
    return {
      path: `M 0 0 L ${n(elbowX)} 0 L ${n(elbowX)} ${n(height)} L ${n(width)} ${n(height)}`,
      viewBox,
    };
  }

  // DrawingML callout adjustments are offsets from the centre, expressed in
  // 1/100000 of the shape frame. Preserve the authored pointer direction and
  // allow it to extend beyond the frame, as PowerPoint does.
  const tipX = width * (0.5 + (adjustments.get('adj1') ?? -20_833) / 100_000);
  const tipY = height * (0.5 + (adjustments.get('adj2') ?? 62_500) / 100_000);

  if (shapeType === 'wedgeEllipseCallout') {
    const rx = width / 2;
    const ry = height / 2;
    const angle = Math.atan2((tipY - ry) / Math.max(ry, 0.001), (tipX - rx) / Math.max(rx, 0.001));
    const spread = Math.PI / 12;
    const first = {
      x: rx + rx * Math.cos(angle - spread),
      y: ry + ry * Math.sin(angle - spread),
    };
    const second = {
      x: rx + rx * Math.cos(angle + spread),
      y: ry + ry * Math.sin(angle + spread),
    };
    return {
      path: [
        `M ${roundCanvasNumber(first.x)} ${roundCanvasNumber(first.y)}`,
        `L ${roundCanvasNumber(tipX)} ${roundCanvasNumber(tipY)}`,
        `L ${roundCanvasNumber(second.x)} ${roundCanvasNumber(second.y)}`,
        `A ${roundCanvasNumber(rx)} ${roundCanvasNumber(ry)} 0 1 0 ${roundCanvasNumber(first.x)} ${roundCanvasNumber(first.y)}`,
        'Z',
      ].join(' '),
      viewBox,
    };
  }

  const rounded = shapeType === 'wedgeRoundRectCallout';
  const radius = rounded
    ? Math.min(width, height) *
      Math.max(0.04, Math.min(0.24, (adjustments.get('adj3') ?? 16_667) / 100_000))
    : 0;
  const distanceToSides = [
    { side: 'left' as const, distance: Math.abs(tipX) },
    { side: 'right' as const, distance: Math.abs(tipX - width) },
    { side: 'top' as const, distance: Math.abs(tipY) },
    { side: 'bottom' as const, distance: Math.abs(tipY - height) },
  ];
  const side = distanceToSides.sort((a, b) => a.distance - b.distance)[0]?.side ?? 'bottom';
  const halfBase = Math.max(Math.min(width, height) * 0.11, radius * 0.75);
  const parts: string[] = [];

  if (side === 'right') {
    const centre = Math.max(radius + halfBase, Math.min(height - radius - halfBase, tipY));
    parts.push(
      `M ${n(radius)} 0`,
      `H ${n(width - radius)}`,
      rounded ? `Q ${n(width)} 0 ${n(width)} ${n(radius)}` : `L ${n(width)} 0`,
      `V ${n(centre - halfBase)}`,
      `L ${n(tipX)} ${n(tipY)}`,
      `L ${n(width)} ${n(centre + halfBase)}`,
      `V ${n(height - radius)}`,
      rounded
        ? `Q ${n(width)} ${n(height)} ${n(width - radius)} ${n(height)}`
        : `L ${n(width)} ${n(height)}`,
      `H ${n(radius)}`,
      rounded ? `Q 0 ${n(height)} 0 ${n(height - radius)}` : `L 0 ${n(height)}`,
      `V ${n(radius)}`,
      rounded ? `Q 0 0 ${n(radius)} 0` : 'L 0 0',
      'Z',
    );
  } else if (side === 'left') {
    const centre = Math.max(radius + halfBase, Math.min(height - radius - halfBase, tipY));
    parts.push(
      `M ${n(radius)} 0`,
      `H ${n(width - radius)}`,
      rounded ? `Q ${n(width)} 0 ${n(width)} ${n(radius)}` : `L ${n(width)} 0`,
      `V ${n(height - radius)}`,
      rounded
        ? `Q ${n(width)} ${n(height)} ${n(width - radius)} ${n(height)}`
        : `L ${n(width)} ${n(height)}`,
      `H ${n(radius)}`,
      rounded ? `Q 0 ${n(height)} 0 ${n(height - radius)}` : `L 0 ${n(height)}`,
      `V ${n(centre + halfBase)}`,
      `L ${n(tipX)} ${n(tipY)}`,
      `L 0 ${n(centre - halfBase)}`,
      `V ${n(radius)}`,
      rounded ? `Q 0 0 ${n(radius)} 0` : 'L 0 0',
      'Z',
    );
  } else if (side === 'top') {
    const centre = Math.max(radius + halfBase, Math.min(width - radius - halfBase, tipX));
    parts.push(
      `M ${n(radius)} 0`,
      `H ${n(centre - halfBase)}`,
      `L ${n(tipX)} ${n(tipY)}`,
      `L ${n(centre + halfBase)} 0`,
      `H ${n(width - radius)}`,
      rounded ? `Q ${n(width)} 0 ${n(width)} ${n(radius)}` : `L ${n(width)} 0`,
      `V ${n(height - radius)}`,
      rounded
        ? `Q ${n(width)} ${n(height)} ${n(width - radius)} ${n(height)}`
        : `L ${n(width)} ${n(height)}`,
      `H ${n(radius)}`,
      rounded ? `Q 0 ${n(height)} 0 ${n(height - radius)}` : `L 0 ${n(height)}`,
      `V ${n(radius)}`,
      rounded ? `Q 0 0 ${n(radius)} 0` : 'L 0 0',
      'Z',
    );
  } else {
    const centre = Math.max(radius + halfBase, Math.min(width - radius - halfBase, tipX));
    parts.push(
      `M ${n(radius)} 0`,
      `H ${n(width - radius)}`,
      rounded ? `Q ${n(width)} 0 ${n(width)} ${n(radius)}` : `L ${n(width)} 0`,
      `V ${n(height - radius)}`,
      rounded
        ? `Q ${n(width)} ${n(height)} ${n(width - radius)} ${n(height)}`
        : `L ${n(width)} ${n(height)}`,
      `H ${n(centre + halfBase)}`,
      `L ${n(tipX)} ${n(tipY)}`,
      `L ${n(centre - halfBase)} ${n(height)}`,
      `H ${n(radius)}`,
      rounded ? `Q 0 ${n(height)} 0 ${n(height - radius)}` : `L 0 ${n(height)}`,
      `V ${n(radius)}`,
      rounded ? `Q 0 0 ${n(radius)} 0` : 'L 0 0',
      'Z',
    );
  }

  return { path: parts.join(' '), viewBox };
}

function convertCustGeomPathToSvg(pathXml: string): string | undefined {
  const commands = splitDirectXmlChildren(pathXml, [
    'a:moveTo',
    'a:lnTo',
    'a:cubicBezTo',
    'a:close',
  ]);

  const parts: string[] = [];
  for (const commandXml of commands) {
    if (/^<a:moveTo\b/i.test(commandXml)) {
      const point = extractCustGeomPoint(commandXml);
      if (!point) continue;
      parts.push(`M ${point.x} ${point.y}`);
      continue;
    }

    if (/^<a:lnTo\b/i.test(commandXml)) {
      const point = extractCustGeomPoint(commandXml);
      if (!point) continue;
      parts.push(`L ${point.x} ${point.y}`);
      continue;
    }

    if (/^<a:cubicBezTo\b/i.test(commandXml)) {
      const points = collectXmlBlocks(commandXml, 'a:pt')
        .map((pointXml) => extractCustGeomPoint(pointXml))
        .filter((point): point is { x: number; y: number } => Boolean(point));
      if (points.length !== 3) continue;
      parts.push(
        `C ${points[0].x} ${points[0].y} ${points[1].x} ${points[1].y} ${points[2].x} ${points[2].y}`,
      );
      continue;
    }

    if (/^<a:close\b/i.test(commandXml)) {
      parts.push('Z');
    }
  }

  return parts.length > 0 ? parts.join(' ') : undefined;
}

function extractCustGeomPoint(xml: string): { x: number; y: number } | undefined {
  const pointXml = /^<a:pt\b/i.test(xml) ? xml : firstTagXml(xml, 'a:pt');
  const x = Number(extractXmlAttr(pointXml ?? '', 'x'));
  const y = Number(extractXmlAttr(pointXml ?? '', 'y'));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return { x, y };
}

function extractChartTextValues(xml?: string): string[] {
  if (!xml) return [];
  const matches = [...xml.matchAll(/<c:v>([\s\S]*?)<\/c:v>/gi)];
  return matches
    .map((match) => decodeXmlText(match[1] ?? ''))
    .map((value) => value.trim())
    .filter(Boolean);
}

function extractChartNumericValues(xml?: string): number[] {
  return extractChartTextValues(xml)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
}

function resolveChartSeriesColor(seriesXml: string): string | undefined {
  const shapeProperties = firstTagXml(seriesXml, 'c:spPr') ?? seriesXml;
  const solidFill = firstTagXml(shapeProperties, 'a:solidFill');
  const color = extractColorFromSolidFillXml(solidFill);
  if (!color) return undefined;
  const opacity = extractSolidFillOpacityFromXml(solidFill);
  return opacity == null ? color : applyAlpha(color, opacity);
}

function renderChartFallbackSvgDataUrl(
  model: ParsedChartModel,
  viewport: { width: number; height: number },
): string {
  const svg = renderChartFallbackSvg(model, viewport.width, viewport.height);
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

function renderChartFallbackSvg(model: ParsedChartModel, width: number, height: number): string {
  const safeWidth = Math.max(200, width);
  const safeHeight = Math.max(120, height);

  switch (model.chartType) {
    case 'bar':
      return renderBarChartSvg(model, safeWidth, safeHeight, true);
    case 'column':
      return renderBarChartSvg(model, safeWidth, safeHeight, false);
    case 'line':
    case 'area':
      return renderLineChartSvg(model, safeWidth, safeHeight, model.chartType === 'area');
    case 'pie':
    case 'ring':
      return renderPieChartSvg(model, safeWidth, safeHeight, model.chartType === 'ring');
    case 'scatter':
      return renderScatterChartSvg(model, safeWidth, safeHeight, false);
    case 'bubble':
      return renderScatterChartSvg(model, safeWidth, safeHeight, true);
    case 'radar':
      return renderRadarChartSvg(model, safeWidth, safeHeight);
    default:
      return renderSummaryChartSvg(model, safeWidth, safeHeight);
  }
}

function insetEmuAttrToCanvasPx(
  xml: string,
  attr: 'lIns' | 'rIns' | 'tIns' | 'bIns',
  slideSizePt: number,
  defaultEmu?: number,
): number {
  const raw = extractXmlAttr(xml, attr);
  const value = raw == null ? defaultEmu : Number(raw);
  if (!Number.isFinite(value)) return 0;
  const scale = slideSizePt > 0 ? 1000 / slideSizePt : 1;
  return roundCanvasNumber(emuToPt(value ?? 0) * scale);
}

function extractPatternCropFromShapeNode(
  nodeXml: string,
): SlideElementIR['patternCrop'] | undefined {
  const blipFillXml = firstTagXml(nodeXml, 'a:blipFill');
  if (!blipFillXml) return undefined;

  const srcRectXml = firstTagXml(blipFillXml, 'a:srcRect');
  const fillRectXml = firstTagXml(blipFillXml, 'a:fillRect');
  const range = srcRectXml ? mapRectAttrsToRange(srcRectXml) : undefined;
  const fillRect = fillRectXml ? mapFillRectAttrs(fillRectXml) : undefined;

  if (!range && !fillRect) return undefined;
  return {
    ...(range ? { range } : {}),
    ...(fillRect ? { fillRect } : {}),
  };
}

function extractPatternScaleModeFromShapeNode(
  nodeXml: string,
): SlideElementIR['patternScaleMode'] | undefined {
  const blipFillXml = firstTagXml(nodeXml, 'a:blipFill');
  if (!blipFillXml) return undefined;

  if (/<a:stretch\b/i.test(blipFillXml)) return 'stretch';
  if (/<a:tile\b/i.test(blipFillXml)) return 'cover';
  return 'stretch';
}

function mapRectAttrsToRange(xml: string): [[number, number], [number, number]] | undefined {
  const left = clampPercent(Number(extractXmlAttr(xml, 'l') ?? 0) / 1000);
  const top = clampPercent(Number(extractXmlAttr(xml, 't') ?? 0) / 1000);
  const rightInset = clampPercent(Number(extractXmlAttr(xml, 'r') ?? 0) / 1000);
  const bottomInset = clampPercent(Number(extractXmlAttr(xml, 'b') ?? 0) / 1000);

  if (left === 0 && top === 0 && rightInset === 0 && bottomInset === 0) {
    return undefined;
  }

  return [
    [left, top],
    [clampPercent(100 - rightInset), clampPercent(100 - bottomInset)],
  ];
}

function mapFillRectAttrs(
  xml: string,
): NonNullable<NonNullable<SlideElementIR['patternCrop']>['fillRect']> | undefined {
  const left = extractPercentFromXmlAttr(xml, 'l');
  const top = extractPercentFromXmlAttr(xml, 't');
  const right = extractPercentFromXmlAttr(xml, 'r');
  const bottom = extractPercentFromXmlAttr(xml, 'b');

  if (left == null && top == null && right == null && bottom == null) {
    return undefined;
  }

  return {
    ...(left != null ? { left } : {}),
    ...(top != null ? { top } : {}),
    ...(right != null ? { right } : {}),
    ...(bottom != null ? { bottom } : {}),
  };
}

function renderBarChartSvg(
  model: ParsedChartModel,
  width: number,
  height: number,
  horizontal: boolean,
): string {
  const labels = model.labels.slice(0, 6);
  const seriesList = model.series
    .slice(0, 4)
    .map((series) => series.slice(0, labels.length || 6))
    .filter((series) => series.length > 0);
  const seriesAxisIds = model.seriesAxisIds ?? [];
  const secondaryAxisId = model.secondaryAxis?.id;
  const primarySeriesIndexes = seriesList
    .map((_, index) => index)
    .filter((index) => !secondaryAxisId || seriesAxisIds[index] !== secondaryAxisId);
  const secondarySeriesIndexes = seriesList
    .map((_, index) => index)
    .filter((index) => secondaryAxisId && seriesAxisIds[index] === secondaryAxisId);
  const primaryValues = (
    primarySeriesIndexes.length > 0 ? primarySeriesIndexes : seriesList.map((_, index) => index)
  ).flatMap((index) => seriesList[index] ?? []);
  const secondaryValues = secondarySeriesIndexes.flatMap((index) => seriesList[index] ?? []);
  const primaryMin = model.primaryAxis?.min ?? Math.min(...primaryValues, 0);
  const primaryMax = model.primaryAxis?.max ?? Math.max(...primaryValues, 0, 1);
  const secondaryMin = model.secondaryAxis?.min ?? Math.min(...secondaryValues, 0);
  const secondaryMax = model.secondaryAxis?.max ?? Math.max(...secondaryValues, 0, 1);
  const padding = {
    left: 54,
    right: secondarySeriesIndexes.length > 0 ? 54 : 20,
    top: 20,
    bottom: 34,
  };
  const plotWidth = Math.max(40, width - padding.left - padding.right);
  const plotHeight = Math.max(40, height - padding.top - padding.bottom);
  const barGap = 10;
  const categorySpan = horizontal
    ? plotHeight / Math.max(labels.length || seriesList[0]?.length || 1, 1)
    : plotWidth / Math.max(labels.length || seriesList[0]?.length || 1, 1);
  const groupThickness = Math.max(10, categorySpan - barGap);
  const seriesTypes = model.seriesTypes ?? seriesList.map(() => (horizontal ? 'bar' : 'column'));
  const barSeriesIndexes = seriesTypes
    .map((seriesType, index) => ({ seriesType, index }))
    .filter((item) => item.seriesType === 'bar' || item.seriesType === 'column')
    .map((item) => item.index);
  const lineSeriesIndexes = seriesTypes
    .map((seriesType, index) => ({ seriesType, index }))
    .filter((item) => item.seriesType === 'line' || item.seriesType === 'area')
    .map((item) => item.index);
  const seriesThickness = Math.max(
    6,
    groupThickness / Math.max(barSeriesIndexes.length || 1, 1) - 4,
  );
  const primaryTicks = buildAxisTicks(primaryMin, primaryMax);
  const secondaryTicks =
    secondarySeriesIndexes.length > 0 ? buildAxisTicks(secondaryMin, secondaryMax) : [];

  const bars = barSeriesIndexes
    .map((seriesIndex, barIndex) => {
      const series = seriesList[seriesIndex] ?? [];
      const color =
        model.themeColors[seriesIndex % model.themeColors.length] ||
        DEFAULT_IMPORT_THEME.themeColors[seriesIndex % DEFAULT_IMPORT_THEME.themeColors.length];
      const axis = resolveSeriesAxis(model, seriesIndex);
      const usesSecondaryAxis =
        Boolean(secondaryAxisId) && seriesAxisIds[seriesIndex] === secondaryAxisId;
      const axisMin = axis.min ?? (usesSecondaryAxis ? secondaryMin : primaryMin);
      const axisMax = axis.max ?? (usesSecondaryAxis ? secondaryMax : primaryMax);
      const denominator = Math.max(axisMax - axisMin, 1);
      const showValues = model.seriesShowValues?.[seriesIndex] ?? true;
      return series
        .map((value, index) => {
          const offsetWithinGroup =
            (groupThickness - seriesThickness * Math.max(barSeriesIndexes.length, 1)) / 2 +
            barIndex * seriesThickness;
          if (horizontal) {
            const barLength = ((value - axisMin) / denominator) * plotWidth;
            const y = padding.top + index * categorySpan + offsetWithinGroup;
            return `
          <rect x="${padding.left}" y="${roundCanvasNumber(y)}" width="${roundCanvasNumber(barLength)}" height="${roundCanvasNumber(seriesThickness - 2)}" rx="4" fill="${color}" />
          ${showValues ? `<text x="${roundCanvasNumber(padding.left + barLength + 6)}" y="${roundCanvasNumber(y + (seriesThickness - 2) / 2 + 4)}" font-size="11" fill="#334155">${escapeXml(formatChartValue(value, model.seriesFormatCodes?.[seriesIndex] ?? axis.formatCode))}</text>` : ''}
        `;
          }
          const barLength = ((value - axisMin) / denominator) * plotHeight;
          const x = padding.left + index * categorySpan + offsetWithinGroup;
          const y = padding.top + plotHeight - barLength;
          return `
        <rect x="${roundCanvasNumber(x)}" y="${roundCanvasNumber(y)}" width="${roundCanvasNumber(seriesThickness - 2)}" height="${roundCanvasNumber(barLength)}" rx="4" fill="${color}" />
        ${showValues ? `<text x="${roundCanvasNumber(x + (seriesThickness - 2) / 2)}" y="${roundCanvasNumber(y - 6)}" text-anchor="middle" font-size="11" fill="#334155">${escapeXml(formatChartValue(value, model.seriesFormatCodes?.[seriesIndex] ?? axis.formatCode))}</text>` : ''}
      `;
        })
        .join('');
    })
    .join('');

  const lineSeries = lineSeriesIndexes
    .map((seriesIndex) => {
      const values = seriesList[seriesIndex] ?? [];
      const color =
        model.themeColors[seriesIndex % model.themeColors.length] ||
        DEFAULT_IMPORT_THEME.themeColors[seriesIndex % DEFAULT_IMPORT_THEME.themeColors.length];
      const axis = resolveSeriesAxis(model, seriesIndex);
      const usesSecondaryAxis =
        Boolean(secondaryAxisId) && seriesAxisIds[seriesIndex] === secondaryAxisId;
      const axisMin = axis.min ?? (usesSecondaryAxis ? secondaryMin : primaryMin);
      const axisMax = axis.max ?? (usesSecondaryAxis ? secondaryMax : primaryMax);
      const denominator = Math.max(axisMax - axisMin, 1);
      const points = values.map((value, index) => {
        const x = padding.left + index * categorySpan + categorySpan / 2;
        const y = padding.top + plotHeight - ((value - axisMin) / denominator) * plotHeight;
        return [roundCanvasNumber(x), roundCanvasNumber(y)] as const;
      });
      const linePath = points
        .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point[0]} ${point[1]}`)
        .join(' ');
      const areaPath =
        seriesTypes[seriesIndex] === 'area' && points.length > 1
          ? `${linePath} L ${points[points.length - 1][0]} ${padding.top + plotHeight} L ${points[0][0]} ${padding.top + plotHeight} Z`
          : '';
      const dots = points
        .map((point) => `<circle cx="${point[0]}" cy="${point[1]}" r="3.5" fill="${color}" />`)
        .join('');
      return `
      ${areaPath ? `<path d="${areaPath}" fill="${applyAlpha(color, 0.14)}" stroke="none" />` : ''}
      <path d="${linePath}" fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
      ${dots}
    `;
    })
    .join('');
  const gridlines = model.primaryAxis?.showMajorGridlines
    ? primaryTicks
        .slice(1)
        .map((tick) => {
          const y =
            padding.top +
            plotHeight -
            ((tick - primaryMin) / Math.max(primaryMax - primaryMin, 1)) * plotHeight;
          return `<line x1="${padding.left}" y1="${roundCanvasNumber(y)}" x2="${width - padding.right}" y2="${roundCanvasNumber(y)}" stroke="#E2E8F0" stroke-width="1" stroke-dasharray="4 4"/>`;
        })
        .join('')
    : '';
  const primaryAxisLabels = primaryTicks
    .map((tick) => {
      const y =
        padding.top +
        plotHeight -
        ((tick - primaryMin) / Math.max(primaryMax - primaryMin, 1)) * plotHeight;
      return `<text x="${padding.left - 8}" y="${roundCanvasNumber(y + 4)}" text-anchor="end" font-size="11" fill="#64748B">${escapeXml(formatChartValue(tick, model.primaryAxis?.formatCode))}</text>`;
    })
    .join('');
  const secondaryAxisLabels = secondaryTicks
    .map((tick) => {
      const y =
        padding.top +
        plotHeight -
        ((tick - secondaryMin) / Math.max(secondaryMax - secondaryMin, 1)) * plotHeight;
      return `<text x="${width - padding.right + 8}" y="${roundCanvasNumber(y + 4)}" font-size="11" fill="#64748B">${escapeXml(formatChartValue(tick, model.secondaryAxis?.formatCode))}</text>`;
    })
    .join('');

  const labelNodes = labels
    .map((label, index) => {
      if (horizontal) {
        const y = padding.top + index * categorySpan + categorySpan / 2 + 4;
        return `<text x="14" y="${roundCanvasNumber(y)}" font-size="12" fill="#475569">${escapeXml(label)}</text>`;
      }
      const x = padding.left + index * categorySpan + categorySpan / 2;
      return `<text x="${roundCanvasNumber(x)}" y="${height - 10}" text-anchor="middle" font-size="12" fill="#475569">${escapeXml(label)}</text>`;
    })
    .join('');

  const legendNodes = renderChartLegend(model, width);

  return wrapChartSvg(
    width,
    height,
    `
    ${renderChartBackground(model, width, height, padding.left, padding.top, plotWidth, plotHeight)}
    ${gridlines}
    <line x1="${padding.left}" y1="${padding.top + plotHeight}" x2="${width - padding.right}" y2="${padding.top + plotHeight}" stroke="#CBD5E1" stroke-width="1"/>
    <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${padding.top + plotHeight}" stroke="#CBD5E1" stroke-width="1"/>
    ${secondarySeriesIndexes.length > 0 ? `<line x1="${width - padding.right}" y1="${padding.top}" x2="${width - padding.right}" y2="${padding.top + plotHeight}" stroke="#CBD5E1" stroke-width="1"/>` : ''}
    ${primaryAxisLabels}
    ${secondaryAxisLabels}
    ${bars}
    ${lineSeries}
    ${labelNodes}
    ${legendNodes}
  `,
  );
}

function renderLineChartSvg(
  model: ParsedChartModel,
  width: number,
  height: number,
  area: boolean,
): string {
  const labels = model.labels.slice(0, 6);
  const seriesList = model.series
    .slice(0, 4)
    .map((series) => series.slice(0, labels.length || 6))
    .filter((series) => series.length > 0);
  const flatValues = seriesList.flat();
  const maxValue = Math.max(...flatValues, 0, 1);
  const minValue = Math.min(...flatValues, 0);
  const padding = { left: 36, right: 20, top: 20, bottom: 30 };
  const plotWidth = Math.max(60, width - padding.left - padding.right);
  const plotHeight = Math.max(40, height - padding.top - padding.bottom);
  const denominator = Math.max(maxValue - minValue, 1);
  const seriesSvg = seriesList
    .map((values, seriesIndex) => {
      const points = values.map((value, index) => {
        const x = padding.left + (plotWidth * index) / Math.max(values.length - 1, 1);
        const y = padding.top + plotHeight - ((value - minValue) / denominator) * plotHeight;
        return [roundCanvasNumber(x), roundCanvasNumber(y)] as const;
      });
      const color =
        model.themeColors[seriesIndex % model.themeColors.length] ||
        DEFAULT_IMPORT_THEME.themeColors[seriesIndex % DEFAULT_IMPORT_THEME.themeColors.length];
      const linePath = points
        .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point[0]} ${point[1]}`)
        .join(' ');
      const areaPath =
        area && points.length > 1
          ? `${linePath} L ${points[points.length - 1][0]} ${padding.top + plotHeight} L ${points[0][0]} ${padding.top + plotHeight} Z`
          : '';
      const markerKind = model.seriesMarkerKinds?.[seriesIndex];
      const markerSize = model.seriesMarkerSizes?.[seriesIndex];
      const dots = points
        .map((point) => renderChartMarker(point[0], point[1], color, markerKind, markerSize))
        .join('');
      const valueLabels = points
        .map(
          (point, index) =>
            `<text x="${point[0]}" y="${roundCanvasNumber(point[1] - 8)}" text-anchor="middle" font-size="11" fill="#334155">${escapeXml(String(values[index] ?? ''))}</text>`,
        )
        .join('');
      const strokeWidth = normalizeChartStrokeWidth(model.seriesLineWidths?.[seriesIndex]);
      return `
      ${areaPath ? `<path d="${areaPath}" fill="${applyAlpha(color, 0.14)}" stroke="none" />` : ''}
      <path d="${linePath}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linejoin="round" stroke-linecap="round"/>
      ${dots}
      ${valueLabels}
    `;
    })
    .join('');
  const labelNodes = labels
    .map((label, index) => {
      const x = padding.left + (plotWidth * index) / Math.max(labels.length - 1, 1);
      return `<text x="${roundCanvasNumber(x)}" y="${height - 10}" text-anchor="middle" font-size="12" fill="#475569">${escapeXml(label)}</text>`;
    })
    .join('');
  const legendNodes = renderChartLegend(model, width);

  return wrapChartSvg(
    width,
    height,
    `
    ${renderChartBackground(model, width, height, padding.left, padding.top, plotWidth, plotHeight)}
    <line x1="${padding.left}" y1="${padding.top + plotHeight}" x2="${width - padding.right}" y2="${padding.top + plotHeight}" stroke="#CBD5E1" stroke-width="1"/>
    ${seriesSvg}
    ${labelNodes}
    ${legendNodes}
  `,
  );
}

function renderPieChartSvg(
  model: ParsedChartModel,
  width: number,
  height: number,
  ring: boolean,
): string {
  const labels = model.labels.slice(0, 6);
  const values = (model.series[0] ?? []).slice(0, labels.length || 6);
  const total = values.reduce((sum, value) => sum + Math.max(value, 0), 0) || 1;
  const cx = width * 0.34;
  const cy = height * 0.5;
  const radius = Math.min(width, height) * 0.24;
  const innerRadius = ring ? radius * 0.56 : 0;
  let currentAngle = -Math.PI / 2;
  const slices = values
    .map((value, index) => {
      const angle = (Math.max(value, 0) / total) * Math.PI * 2;
      const startAngle = currentAngle;
      const endAngle = currentAngle + angle;
      currentAngle = endAngle;
      return describeArcSlice(
        cx,
        cy,
        radius,
        innerRadius,
        startAngle,
        endAngle,
        model.themeColors[index % model.themeColors.length] ||
          DEFAULT_IMPORT_THEME.themeColors[index % DEFAULT_IMPORT_THEME.themeColors.length],
      );
    })
    .join('');
  const legend = labels
    .map((label, index) => {
      const y = 32 + index * 22;
      const color =
        model.themeColors[index % model.themeColors.length] ||
        DEFAULT_IMPORT_THEME.themeColors[index % DEFAULT_IMPORT_THEME.themeColors.length];
      const value = values[index] ?? 0;
      return `
      <rect x="${width * 0.6}" y="${y - 10}" width="10" height="10" rx="2" fill="${color}" />
      <text x="${width * 0.6 + 16}" y="${y}" font-size="12" fill="#334155">${escapeXml(label)} ${roundCanvasNumber((value / total) * 100)}% (${escapeXml(String(value))})</text>
    `;
    })
    .join('');

  return wrapChartSvg(width, height, `${slices}${legend}`);
}

function renderScatterChartSvg(
  model: ParsedChartModel,
  width: number,
  height: number,
  bubble: boolean,
): string {
  const xSeries = model.scatterXSeries ?? [];
  const ySeries = model.series;
  const allXValues = xSeries.flat();
  const allYValues = ySeries.flat();
  const allBubbleSizes = (model.bubbleSizes ?? []).flat();
  const xMin = Math.min(...allXValues, 0);
  const xMax = Math.max(...allXValues, 1);
  const yMin = Math.min(...allYValues, 0);
  const yMax = Math.max(...allYValues, 1);
  const maxBubbleSize = Math.max(...allBubbleSizes, 1);
  const padding = { left: 42, right: 18, top: 24, bottom: 32 };
  const plotWidth = Math.max(80, width - padding.left - padding.right);
  const plotHeight = Math.max(60, height - padding.top - padding.bottom);
  const xDenominator = Math.max(xMax - xMin, 1);
  const yDenominator = Math.max(yMax - yMin, 1);
  const seriesNodes = ySeries
    .slice(0, 4)
    .map((values, seriesIndex) => {
      const color =
        model.themeColors[seriesIndex % model.themeColors.length] ||
        DEFAULT_IMPORT_THEME.themeColors[seriesIndex % DEFAULT_IMPORT_THEME.themeColors.length];
      const xs = xSeries[seriesIndex] ?? [];
      const sizes = model.bubbleSizes?.[seriesIndex] ?? [];
      return values
        .map((value, index) => {
          const xValue = xs[index] ?? index;
          const cx = padding.left + ((xValue - xMin) / xDenominator) * plotWidth;
          const cy = padding.top + plotHeight - ((value - yMin) / yDenominator) * plotHeight;
          const radius = bubble
            ? Math.max(4, Math.min(18, ((sizes[index] ?? 1) / maxBubbleSize) * 14))
            : 4;
          return `<circle cx="${roundCanvasNumber(cx)}" cy="${roundCanvasNumber(cy)}" r="${roundCanvasNumber(radius)}" fill="${applyAlpha(color, bubble ? 0.62 : 0.9)}" stroke="${color}" stroke-width="1.5"/>`;
        })
        .join('');
    })
    .join('');
  const legendNodes = renderChartLegend(model, width);

  return wrapChartSvg(
    width,
    height,
    `
    ${renderChartBackground(model, width, height, padding.left, padding.top, plotWidth, plotHeight)}
    <line x1="${padding.left}" y1="${padding.top + plotHeight}" x2="${padding.left + plotWidth}" y2="${padding.top + plotHeight}" stroke="#CBD5E1" stroke-width="1"/>
    <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${padding.top + plotHeight}" stroke="#CBD5E1" stroke-width="1"/>
    <text x="${padding.left}" y="${height - 10}" font-size="11" fill="#64748B">${escapeXml(formatChartValue(xMin))}</text>
    <text x="${padding.left + plotWidth}" y="${height - 10}" text-anchor="end" font-size="11" fill="#64748B">${escapeXml(formatChartValue(xMax))}</text>
    <text x="${padding.left - 8}" y="${padding.top + 4}" text-anchor="end" font-size="11" fill="#64748B">${escapeXml(formatChartValue(yMax))}</text>
    ${seriesNodes}
    ${legendNodes}
  `,
  );
}

function renderRadarChartSvg(model: ParsedChartModel, width: number, height: number): string {
  const labels = model.labels.slice(0, 8);
  const seriesList = model.series
    .slice(0, 4)
    .map((series) => series.slice(0, labels.length || 8))
    .filter((series) => series.length > 0);
  const maxValue = Math.max(...seriesList.flat(), 1);
  const cx = width * 0.5;
  const cy = height * 0.5;
  const radius = Math.min(width, height) * 0.32;
  const axisCount = Math.max(labels.length || seriesList[0]?.length || 3, 3);
  const rings = [0.25, 0.5, 0.75, 1]
    .map((scale) => {
      const points = Array.from({ length: axisCount }, (_, index) => {
        const angle = -Math.PI / 2 + (Math.PI * 2 * index) / axisCount;
        return `${roundCanvasNumber(cx + Math.cos(angle) * radius * scale)},${roundCanvasNumber(cy + Math.sin(angle) * radius * scale)}`;
      }).join(' ');
      return `<polygon points="${points}" fill="none" stroke="#E2E8F0" stroke-width="1"/>`;
    })
    .join('');
  const axes = Array.from({ length: axisCount }, (_, index) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / axisCount;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    const labelX = cx + Math.cos(angle) * (radius + 14);
    const labelY = cy + Math.sin(angle) * (radius + 14);
    return `
      <line x1="${roundCanvasNumber(cx)}" y1="${roundCanvasNumber(cy)}" x2="${roundCanvasNumber(x)}" y2="${roundCanvasNumber(y)}" stroke="#CBD5E1" stroke-width="1"/>
      ${labels[index] ? `<text x="${roundCanvasNumber(labelX)}" y="${roundCanvasNumber(labelY + 4)}" text-anchor="middle" font-size="11" fill="#475569">${escapeXml(labels[index])}</text>` : ''}
    `;
  }).join('');
  const seriesNodes = seriesList
    .map((series, seriesIndex) => {
      const color =
        model.themeColors[seriesIndex % model.themeColors.length] ||
        DEFAULT_IMPORT_THEME.themeColors[seriesIndex % DEFAULT_IMPORT_THEME.themeColors.length];
      const points = Array.from({ length: axisCount }, (_, index) => {
        const value = series[index] ?? 0;
        const angle = -Math.PI / 2 + (Math.PI * 2 * index) / axisCount;
        const scaledRadius = (value / maxValue) * radius;
        return `${roundCanvasNumber(cx + Math.cos(angle) * scaledRadius)},${roundCanvasNumber(cy + Math.sin(angle) * scaledRadius)}`;
      }).join(' ');
      return `
      <polygon points="${points}" fill="${applyAlpha(color, 0.18)}" stroke="${color}" stroke-width="2"/>
      ${points
        .split(' ')
        .map((point) => {
          const [x, y] = point.split(',');
          return `<circle cx="${x}" cy="${y}" r="3" fill="${color}" />`;
        })
        .join('')}
    `;
    })
    .join('');
  const legendNodes = renderChartLegend(model, width);

  return wrapChartSvg(
    width,
    height,
    `
    ${renderChartBackground(model, width, height, cx - radius, cy - radius, radius * 2, radius * 2)}
    ${rings}
    ${axes}
    ${seriesNodes}
    ${legendNodes}
  `,
  );
}

function renderSummaryChartSvg(model: ParsedChartModel, width: number, height: number): string {
  const legends = model.legends.slice(0, 4);
  const rows = legends
    .map((legend, index) => {
      const y = 34 + index * 26;
      const values = model.series[index] ?? [];
      const labelText =
        values.length > 0
          ? `${escapeXml(legend)}: ${escapeXml(values.join(' / '))}`
          : escapeXml(legend);
      const color =
        model.themeColors[index % model.themeColors.length] ||
        DEFAULT_IMPORT_THEME.themeColors[index % DEFAULT_IMPORT_THEME.themeColors.length];
      return `
      <rect x="18" y="${y - 10}" width="10" height="10" rx="2" fill="${color}" />
      <text x="36" y="${y}" font-size="12" fill="#334155">${labelText}</text>
    `;
    })
    .join('');
  const title = model.chartType === 'summary' ? '组合图表已转为摘要图' : '图表';
  const labels = model.labels.slice(0, 5).join(' / ');
  return wrapChartSvg(
    width,
    height,
    `
    <text x="18" y="24" font-size="14" font-weight="700" fill="#0F172A">${title}</text>
    ${labels ? `<text x="18" y="${Math.min(height - 18, 54)}" font-size="12" fill="#64748B">${escapeXml(labels)}</text>` : ''}
    ${rows}
  `,
  );
}

function resolveSeriesAxis(model: ParsedChartModel, seriesIndex: number): ParsedChartAxis {
  const axisId = model.seriesAxisIds?.[seriesIndex];
  if (axisId && model.secondaryAxis?.id === axisId) {
    return model.secondaryAxis;
  }
  return model.primaryAxis ?? { min: 0 };
}

function buildAxisTicks(min: number, max: number, count = 4): number[] {
  const safeMin = Number.isFinite(min) ? min : 0;
  const safeMax = Number.isFinite(max) ? max : Math.max(safeMin, 1);
  const start = Math.min(safeMin, safeMax);
  const end = Math.max(safeMin, safeMax);
  const step = (end - start) / Math.max(count, 1);
  return Array.from({ length: count + 1 }, (_, index) => roundCanvasNumber(start + step * index));
}

function formatChartValue(value: number, formatCode?: string): string {
  if (!Number.isFinite(value)) return '';
  const normalized = (formatCode ?? '').trim();
  if (!normalized) {
    return roundCanvasNumber(value).toString();
  }
  if (normalized.includes('%')) {
    const digits =
      normalized.includes('0.0') || normalized.includes('0.00')
        ? (normalized.match(/0\.([0]+)/)?.[1]?.length ?? 0)
        : 0;
    return `${(value * 100).toFixed(digits)}%`;
  }
  const currencySymbol = normalized.includes('¥')
    ? '¥'
    : normalized.includes('$')
      ? '$'
      : normalized.includes('￥')
        ? '￥'
        : '';
  const decimals = normalized.match(/0\.([0]+)/)?.[1]?.length ?? 0;
  const formattedNumber = value.toLocaleString('zh-CN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  if (currencySymbol) {
    return `${currencySymbol}${formattedNumber}`;
  }
  return formattedNumber;
}

function renderChartLegend(model: ParsedChartModel, width: number): string {
  if (model.legends.length <= 1) return '';
  return model.legends
    .slice(0, 4)
    .map((legend, index) => {
      const color =
        model.themeColors[index % model.themeColors.length] ||
        DEFAULT_IMPORT_THEME.themeColors[index % DEFAULT_IMPORT_THEME.themeColors.length];
      const x = width - 110;
      const y = 24 + index * 18;
      return `
      <rect x="${x}" y="${y - 8}" width="10" height="10" rx="2" fill="${color}" />
      <text x="${x + 16}" y="${y}" font-size="11" fill="#475569">${escapeXml(legend)}</text>
    `;
    })
    .join('');
}

function renderChartBackground(
  model: ParsedChartModel,
  width: number,
  height: number,
  plotX: number,
  plotY: number,
  plotWidth: number,
  plotHeight: number,
): string {
  return `
    ${model.chartBackgroundColor ? `<rect width="${width}" height="${height}" rx="14" fill="${model.chartBackgroundColor}"/>` : ''}
    ${model.plotAreaBackgroundColor ? `<rect x="${plotX}" y="${plotY}" width="${plotWidth}" height="${plotHeight}" rx="8" fill="${model.plotAreaBackgroundColor}"/>` : ''}
  `;
}

function normalizeChartStrokeWidth(value?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 3;
  }
  return Math.max(1, Math.min(8, roundCanvasNumber(value)));
}

function renderChartMarker(
  x: number,
  y: number,
  color: string,
  markerKind?: string,
  markerSize?: number,
): string {
  const size = Math.max(3, Math.min(10, (markerSize ?? 7) / 2));
  switch ((markerKind || '').trim()) {
    case 'diamond':
      return `<path d="M ${roundCanvasNumber(x)} ${roundCanvasNumber(y - size)} L ${roundCanvasNumber(x + size)} ${roundCanvasNumber(y)} L ${roundCanvasNumber(x)} ${roundCanvasNumber(y + size)} L ${roundCanvasNumber(x - size)} ${roundCanvasNumber(y)} Z" fill="${color}" />`;
    case 'square':
      return `<rect x="${roundCanvasNumber(x - size)}" y="${roundCanvasNumber(y - size)}" width="${roundCanvasNumber(size * 2)}" height="${roundCanvasNumber(size * 2)}" fill="${color}" />`;
    case 'triangle':
      return `<path d="M ${roundCanvasNumber(x)} ${roundCanvasNumber(y - size)} L ${roundCanvasNumber(x + size)} ${roundCanvasNumber(y + size)} L ${roundCanvasNumber(x - size)} ${roundCanvasNumber(y + size)} Z" fill="${color}" />`;
    case 'x':
      return `
        <path d="M ${roundCanvasNumber(x - size)} ${roundCanvasNumber(y - size)} L ${roundCanvasNumber(x + size)} ${roundCanvasNumber(y + size)} M ${roundCanvasNumber(x + size)} ${roundCanvasNumber(y - size)} L ${roundCanvasNumber(x - size)} ${roundCanvasNumber(y + size)}" stroke="${color}" stroke-width="2" stroke-linecap="round"/>
      `;
    default:
      return `<circle cx="${roundCanvasNumber(x)}" cy="${roundCanvasNumber(y)}" r="${roundCanvasNumber(size * 0.7)}" fill="${color}" />`;
  }
}

function wrapChartSvg(width: number, height: number, body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
  <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    ${body}
  </svg>`;
}

function describeArcSlice(
  cx: number,
  cy: number,
  outerRadius: number,
  innerRadius: number,
  startAngle: number,
  endAngle: number,
  color: string,
): string {
  const largeArcFlag = endAngle - startAngle > Math.PI ? 1 : 0;
  const startOuter = polarToCartesian(cx, cy, outerRadius, endAngle);
  const endOuter = polarToCartesian(cx, cy, outerRadius, startAngle);

  if (innerRadius <= 0) {
    return `<path d="M ${cx} ${cy} L ${startOuter.x} ${startOuter.y} A ${outerRadius} ${outerRadius} 0 ${largeArcFlag} 0 ${endOuter.x} ${endOuter.y} Z" fill="${color}" />`;
  }

  const startInner = polarToCartesian(cx, cy, innerRadius, startAngle);
  const endInner = polarToCartesian(cx, cy, innerRadius, endAngle);
  return `<path d="M ${startOuter.x} ${startOuter.y} A ${outerRadius} ${outerRadius} 0 ${largeArcFlag} 0 ${endOuter.x} ${endOuter.y} L ${startInner.x} ${startInner.y} A ${innerRadius} ${innerRadius} 0 ${largeArcFlag} 1 ${endInner.x} ${endInner.y} Z" fill="${color}" />`;
}

function polarToCartesian(cx: number, cy: number, radius: number, angleInRadians: number) {
  return {
    x: roundCanvasNumber(cx + radius * Math.cos(angleInRadians)),
    y: roundCanvasNumber(cy + radius * Math.sin(angleInRadians)),
  };
}

function extractPercentFromXmlAttr(xml: string, attr: 'l' | 't' | 'r' | 'b'): number | undefined {
  const raw = extractXmlAttr(xml, attr);
  const value = Number(raw);
  if (!Number.isFinite(value)) return undefined;
  return clampPercent(value / 1000);
}

function identityXmlTransform(): XmlAffineTransform {
  return {
    translateX: 0,
    translateY: 0,
    scaleX: 1,
    scaleY: 1,
    childOffsetX: 0,
    childOffsetY: 0,
  };
}

function extractGroupTransform(nodeXml: string): XmlAffineTransform {
  const xfrmXml = firstTagXml(nodeXml, 'a:xfrm');
  const offXml = xfrmXml ? firstTagXml(xfrmXml, 'a:off') : undefined;
  const chOffXml = xfrmXml ? firstTagXml(xfrmXml, 'a:chOff') : undefined;
  const extXml = xfrmXml ? firstTagXml(xfrmXml, 'a:ext') : undefined;
  const chExtXml = xfrmXml ? firstTagXml(xfrmXml, 'a:chExt') : undefined;

  const offX = Number(extractXmlAttr(offXml ?? '', 'x'));
  const offY = Number(extractXmlAttr(offXml ?? '', 'y'));
  const childOffX = Number(extractXmlAttr(chOffXml ?? '', 'x'));
  const childOffY = Number(extractXmlAttr(chOffXml ?? '', 'y'));
  const extX = Number(extractXmlAttr(extXml ?? '', 'cx'));
  const extY = Number(extractXmlAttr(extXml ?? '', 'cy'));
  const childExtX = Number(extractXmlAttr(chExtXml ?? '', 'cx'));
  const childExtY = Number(extractXmlAttr(chExtXml ?? '', 'cy'));

  return {
    translateX: Number.isFinite(offX) ? offX : 0,
    translateY: Number.isFinite(offY) ? offY : 0,
    scaleX:
      Number.isFinite(extX) && Number.isFinite(childExtX) && childExtX !== 0 ? extX / childExtX : 1,
    scaleY:
      Number.isFinite(extY) && Number.isFinite(childExtY) && childExtY !== 0 ? extY / childExtY : 1,
    childOffsetX: Number.isFinite(childOffX) ? childOffX : 0,
    childOffsetY: Number.isFinite(childOffY) ? childOffY : 0,
  };
}

function combineXmlTransforms(
  parent: XmlAffineTransform,
  child: XmlAffineTransform,
): XmlAffineTransform {
  return {
    translateX: parent.translateX + (child.translateX - parent.childOffsetX) * parent.scaleX,
    translateY: parent.translateY + (child.translateY - parent.childOffsetY) * parent.scaleY,
    scaleX: parent.scaleX * child.scaleX,
    scaleY: parent.scaleY * child.scaleY,
    childOffsetX: child.childOffsetX,
    childOffsetY: child.childOffsetY,
  };
}

function getSlideRelsPath(slidePath: string): string {
  const lastSlash = slidePath.lastIndexOf('/');
  const dir = lastSlash >= 0 ? slidePath.slice(0, lastSlash) : '';
  const fileName = lastSlash >= 0 ? slidePath.slice(lastSlash + 1) : slidePath;
  return `${dir}/_rels/${fileName}.rels`;
}

function resolveZipTarget(basePath: string, target: string): string {
  const baseDir = basePath.slice(0, Math.max(0, basePath.lastIndexOf('/') + 1));
  const joined = `${baseDir}${target}`;
  const parts = joined.split('/');
  const normalized: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      normalized.pop();
      continue;
    }
    normalized.push(part);
  }
  return normalized.join('/');
}

function guessMimeTypeFromPath(path: string): string {
  const normalized = path.toLowerCase();
  if (normalized.endsWith('.png')) return 'image/png';
  if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg')) return 'image/jpeg';
  if (normalized.endsWith('.gif')) return 'image/gif';
  if (normalized.endsWith('.webp')) return 'image/webp';
  if (normalized.endsWith('.svg')) return 'image/svg+xml';
  if (normalized.endsWith('.bmp')) return 'image/bmp';
  if (normalized.endsWith('.tif') || normalized.endsWith('.tiff')) return 'image/tiff';
  if (normalized.endsWith('.mp4')) return 'video/mp4';
  if (normalized.endsWith('.webm')) return 'video/webm';
  if (normalized.endsWith('.mov')) return 'video/quicktime';
  if (normalized.endsWith('.m4v')) return 'video/mp4';
  if (normalized.endsWith('.mp3')) return 'audio/mpeg';
  if (normalized.endsWith('.wav')) return 'audio/wav';
  if (normalized.endsWith('.ogg')) return 'audio/ogg';
  if (normalized.endsWith('.aac')) return 'audio/aac';
  if (normalized.endsWith('.m4a')) return 'audio/mp4';
  return 'application/octet-stream';
}

function normalizeMediaExtension(value?: string): string | undefined {
  if (!value) return undefined;
  const clean = value.split('?')[0]?.split('#')[0] ?? value;
  const ext = clean.match(/\.([a-zA-Z0-9]+)$/)?.[1]?.toLowerCase();
  return ext || undefined;
}

function collectXmlBlocks(xml: string, tagName: string): string[] {
  const blocks: string[] = [];
  let cursor = 0;
  while (cursor < xml.length) {
    const start = xml.slice(cursor).search(new RegExp(`<${escapeRegExp(tagName)}\\b`, 'i'));
    if (start < 0) break;
    const actualStart = cursor + start;
    const end = findXmlElementEnd(xml, actualStart, tagName);
    if (end < 0) break;
    blocks.push(xml.slice(actualStart, end));
    cursor = end;
  }
  return blocks;
}

function mapSchemeColor(
  value?: string,
  schemeColors?: Readonly<Record<string, string>>,
): string | undefined {
  const normalized = (value || '').trim();
  if (schemeColors?.[normalized]) return schemeColors[normalized];
  switch (normalized) {
    case 'accent1':
      return DEFAULT_IMPORT_THEME.themeColors[0];
    case 'accent2':
      return DEFAULT_IMPORT_THEME.themeColors[1];
    case 'accent3':
      return DEFAULT_IMPORT_THEME.themeColors[2];
    case 'accent4':
      return DEFAULT_IMPORT_THEME.themeColors[3];
    case 'accent5':
      return DEFAULT_IMPORT_THEME.themeColors[4];
    case 'accent6':
      return '#70AD47';
    case 'tx1':
      return '#334155';
    case 'tx2':
      return '#64748B';
    case 'bg1':
      return '#FFFFFF';
    case 'bg2':
      return '#F8FAFC';
    default:
      return undefined;
  }
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function sanitizeIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_') || 'chart';
}

function applyAlpha(color: string, alpha: number): string {
  const normalized = color.trim();
  if (!/^#[0-9a-f]{6}$/i.test(normalized)) {
    return normalized;
  }
  const channel = Math.max(0, Math.min(255, Math.round(alpha * 255)))
    .toString(16)
    .padStart(2, '0');
  return `${normalized}${channel}`;
}

function applyColorTransform(color: string | undefined, colorXml?: string): string | undefined {
  if (!color || !/^#[0-9a-f]{6}$/i.test(color)) return color;
  const lumMod = normalizeNumber(
    extractXmlAttr(firstTagXml(colorXml ?? '', 'a:lumMod') ?? '', 'val'),
  );
  const lumOff = normalizeNumber(
    extractXmlAttr(firstTagXml(colorXml ?? '', 'a:lumOff') ?? '', 'val'),
  );
  if (lumMod == null && lumOff == null) return color;

  const factor = lumMod == null ? 1 : lumMod / 100000;
  const offset = lumOff == null ? 0 : lumOff / 100000;
  const channels = [1, 3, 5]
    .map((start) => Number.parseInt(color.slice(start, start + 2), 16))
    .map((channel) => Math.round(Math.max(0, Math.min(255, channel * factor + 255 * offset))))
    .map((channel) => channel.toString(16).padStart(2, '0'));
  return `#${channels.join('')}`;
}

function firstTagXml(xml: string, tagName: string): string | undefined {
  const start = xml.search(new RegExp(`<${escapeRegExp(tagName)}\\b`, 'i'));
  if (start < 0) return undefined;
  const end = findXmlElementEnd(xml, start, tagName);
  if (end < 0) return undefined;
  return xml.slice(start, end);
}

function firstDirectChildTagXml(xml: string, tagName: string): string | undefined {
  const openIndex = xml.indexOf('>');
  const closeIndex = xml.lastIndexOf('</');
  if (openIndex < 0 || closeIndex <= openIndex) return undefined;

  const content = xml.slice(openIndex + 1, closeIndex);
  let cursor = 0;
  while (cursor < content.length) {
    const nextTagIndex = content.indexOf('<', cursor);
    if (nextTagIndex < 0) return undefined;
    const actualStart = openIndex + 1 + nextTagIndex;
    const next = content[nextTagIndex + 1];
    if (next === '/' || next === '!' || next === '?') {
      cursor = nextTagIndex + 1;
      continue;
    }

    const match = content.slice(nextTagIndex).match(/^<([A-Za-z0-9_:-]+)\b/);
    const childTag = match?.[1];
    if (!childTag) {
      cursor = nextTagIndex + 1;
      continue;
    }
    const end = findXmlElementEnd(xml, actualStart, childTag);
    if (end < 0) return undefined;
    if (childTag.toLowerCase() === tagName.toLowerCase()) {
      return xml.slice(actualStart, end);
    }
    cursor = end - openIndex - 1;
  }

  return undefined;
}

function splitDirectXmlChildren(xml: string, tagNames: string[]): string[] {
  const results: string[] = [];
  const openIndex = xml.indexOf('>');
  const closeIndex = xml.lastIndexOf('</');
  if (openIndex < 0 || closeIndex <= openIndex) return results;

  const content = xml.slice(openIndex + 1, closeIndex);
  let cursor = 0;
  while (cursor < content.length) {
    const nextTagIndex = content.indexOf('<', cursor);
    if (nextTagIndex < 0) break;
    const tagName = tagNames.find((candidate) => hasXmlTagStart(content, nextTagIndex, candidate));
    if (!tagName) {
      cursor = nextTagIndex + 1;
      continue;
    }
    const end = findXmlElementEnd(content, nextTagIndex, tagName);
    if (end < 0) break;
    results.push(content.slice(nextTagIndex, end));
    cursor = end;
  }

  return results;
}

function hasXmlTagStart(xml: string, startIndex: number, tagName: string): boolean {
  if (!xml.startsWith(`<${tagName}`, startIndex)) return false;
  const nextChar = xml[startIndex + tagName.length + 1];
  return nextChar === '>' || nextChar === '/' || /\s/.test(nextChar ?? '');
}

function findXmlElementEnd(xml: string, startIndex: number, tagName: string): number {
  const selfClosingPattern = new RegExp(`<${escapeRegExp(tagName)}\\b[^>]*\\/\\s*>`, 'g');
  selfClosingPattern.lastIndex = startIndex;
  const selfClosing = selfClosingPattern.exec(xml);
  if (selfClosing?.index === startIndex) {
    return selfClosing.index + selfClosing[0].length;
  }

  const openPattern = new RegExp(`<${escapeRegExp(tagName)}\\b`, 'g');
  const closePattern = new RegExp(`</${escapeRegExp(tagName)}>`, 'g');
  let depth = 0;
  let cursor = startIndex;

  while (cursor < xml.length) {
    openPattern.lastIndex = cursor;
    closePattern.lastIndex = cursor;
    selfClosingPattern.lastIndex = cursor;

    const open = openPattern.exec(xml);
    const close = closePattern.exec(xml);
    const nestedSelfClosing = selfClosingPattern.exec(xml);

    const nextIndex = Math.min(
      open?.index ?? Number.POSITIVE_INFINITY,
      close?.index ?? Number.POSITIVE_INFINITY,
      nestedSelfClosing?.index ?? Number.POSITIVE_INFINITY,
    );
    if (!Number.isFinite(nextIndex)) return -1;

    if (nestedSelfClosing && nestedSelfClosing.index === nextIndex) {
      if (nestedSelfClosing.index === startIndex && depth === 0) {
        return nestedSelfClosing.index + nestedSelfClosing[0].length;
      }
      cursor = nestedSelfClosing.index + nestedSelfClosing[0].length;
      continue;
    }

    if (open && open.index === nextIndex) {
      depth += 1;
      cursor = open.index + 1;
      continue;
    }

    if (close && close.index === nextIndex) {
      depth -= 1;
      const end = close.index + close[0].length;
      cursor = end;
      if (depth === 0) return end;
    }
  }

  return -1;
}

function extractXmlAttr(xml: string, attrName: string): string | undefined {
  const match = xml.match(new RegExp(`${escapeRegExp(attrName)}="([^"]*)"`, 'i'));
  return match?.[1];
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emuToPt(value: number): number {
  return value / 12700;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeOpacity(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

async function loadPptxParseFunction(): Promise<PptxParseFunction> {
  const cjsModule = await import('../../../../../vendor/pptxtojson/index.cjs');
  const cjsParse = getPptxParseFunction(cjsModule);
  if (cjsParse) {
    return cjsParse;
  }

  throw new Error('pptxtojson parse() is not available');
}

function getPptxParseFunction(module: unknown): PptxParseFunction | null {
  if (module && typeof module === 'object') {
    if ('parse' in module && typeof (module as { parse?: unknown }).parse === 'function') {
      return (module as { parse: (input: ArrayBuffer) => Promise<PptxToJsonResult> }).parse;
    }
    if (
      'default' in module &&
      module.default &&
      typeof module.default === 'object' &&
      'parse' in module.default &&
      typeof (module.default as { parse?: unknown }).parse === 'function'
    ) {
      return (module.default as { parse: (input: ArrayBuffer) => Promise<PptxToJsonResult> }).parse;
    }
  }
  return null;
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '');
}
