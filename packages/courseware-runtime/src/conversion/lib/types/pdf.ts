/**
 * PDF parsing result types
 * Extended to support advanced features from providers like MinerU
 */

export interface PdfPageImage {
  id: string;
  src: string;
  pageNumber: number;
  width?: number;
  height?: number;
}

export interface DocumentVisionSheet {
  id: string;
  src: string;
  pageNumbers: number[];
  width: number;
  height: number;
}

/**
 * Parsed PDF content with text and images
 */
export interface ParsedPdfContent {
  /** Extracted text content from the PDF */
  text: string;

  /** Array of images as base64 data URLs */
  images: string[];

  /** Extracted tables (MinerU feature) */
  tables?: Array<{
    page: number;
    data: string[][];
    caption?: string;
  }>;

  /** Extracted formulas (MinerU feature) */
  formulas?: Array<{
    page: number;
    latex: string;
    position?: { x: number; y: number; width: number; height: number };
  }>;

  /** Layout analysis (MinerU feature) */
  layout?: Array<{
    page: number;
    type: 'title' | 'text' | 'image' | 'table' | 'formula';
    content: string;
    position?: { x: number; y: number; width: number; height: number };
  }>;

  /** Rich layout raw output for import pipeline */
  rawContentList?: Array<Record<string, unknown>>;

  /** Page metrics for import/classification */
  pageMetrics?: Array<{
    page: number;
    width?: number;
    height?: number;
  }>;

  /** Metadata about the PDF */
  metadata?: {
    fileName?: string;
    fileSize?: number;
    pageCount: number;
    parser?: string; // 'unpdf' | 'mineru'
    processingTime?: number;
    taskId?: string; // MinerU task ID
    /** Image ID to base64 URL mapping (used in generation pipeline) */
    imageMapping?: Record<string, string>; // e.g., { "img_1": "data:image/png;base64,..." }
    /** PdfImage array with page numbers (used in generation pipeline) */
    pdfImages?: Array<{
      id: string;
      src: string;
      pageNumber: number;
      description?: string;
      width?: number;
      height?: number;
    }>;
    /** Full-page rendered images, used as fallback backgrounds for low-coverage PPT-like PDF imports */
    pageImages?: PdfPageImage[];
    /** MinerU parser health marker for degraded extraction results */
    parserDegraded?: boolean;
    /** Short parser health summary for debugging */
    parserHealth?: string;
    resultUrl?: string;
    [key: string]: unknown;
  };
}

/**
 * Request parameters for PDF parsing
 */
export interface ParsePdfRequest {
  /** PDF file to parse */
  pdf: File;
}

/**
 * Response from PDF parsing API
 */
export interface ParsePdfResponse {
  success: boolean;
  data?: ParsedPdfContent;
  error?: string;
}
