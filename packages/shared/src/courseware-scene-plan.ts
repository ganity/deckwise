export type CoursewareScenePlanPage = {
  pageId: string;
  sourceHash: string;
  title: string;
  visibleText: string[];
  visualIntent: string;
  narration: string;
};

/** A validated generation draft, not the authoritative teaching of an open PPTX. */
export type CoursewareScenePlanSnapshot = {
  relativePath: string;
  sha256: string;
  approvedSha256: string | null;
  title: string;
  pages: CoursewareScenePlanPage[];
};

/** A page visual request pinned to an approved draft, before Office page identity exists. */
export type CoursewareSceneImageAsset = {
  sha256: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  byteLength: number;
  width: number;
  height: number;
  normalizedBoundingBox?: [number, number, number, number];
  sourceZIndex?: number;
};

export type CoursewareSceneImageTarget =
  | { kind: "visualMaster" | "cleanPlate" }
  | { kind: "layer"; name: string };

export function isCoursewareSceneImageTarget(value: unknown): value is CoursewareSceneImageTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).sort().join(",");
  if (v.kind === "visualMaster" || v.kind === "cleanPlate") return keys === "kind";
  return v.kind === "layer" && keys === "kind,name" && typeof v.name === "string" &&
    v.name.length > 0 && v.name.length <= 80 && v.name === v.name.trim() && !/[\u0000-\u001f\u007f-\u009f]/u.test(v.name);
}

export type CoursewareSceneImageView = {
  decomposition?: boolean;
  referenceImage?: { intentId: string; sha256: string; mimeType: "image/png" | "image/jpeg"; byteLength: number };
  intentId: string;
  planSha256: string;
  pageId: string;
  target: CoursewareSceneImageTarget;
  model: string;
  prompt: string;
  phase: "prepared" | "submission-unknown" | "submitted" | "rejected";
  current: boolean;
  asset: CoursewareSceneImageAsset | null;
  selected: boolean;
  task: { state: string; feeState: string; reservedPoints: number; actualPoints: number | null; errorCode: string | null } | null;
};

export type CoursewareSceneImagePreview = { image: CoursewareSceneImageView; dataUrl: string };

export type CoursewareSceneImageQuoteView = {
  quoteId: string;
  intentId: string;
  model: string;
  maxPoints: number;
  maxChars: number;
  expiresAt: string;
};
