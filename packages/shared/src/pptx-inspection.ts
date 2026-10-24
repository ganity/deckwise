export type PptxInspection = {
  checkId: string;
  revision: number;
  sourceSha256: string;
} & (
  | { status: "RUNNING" }
  | { status: "SUCCEEDED"; pages: number; warningCount: number; errorCount: number; warnings: PptxInspectionWarning[] }
  | { status: "FAILED"; message: string }
  | { status: "CANCELED" }
);
export type PptxInspectionWarning = {
  code: string;
  message: string;
  severity: "info" | "warning" | "error" | "unknown";
  pageIndex?: number;
};
