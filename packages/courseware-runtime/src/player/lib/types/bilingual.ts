export interface BilingualTextRecord {
  pairId: string;
  sourcePairId?: string;
  zhText: string;
  ruText: string;
  sourceLanguage?: "zh-CN" | "ru-RU";
  sourceVersion: number;
  translationVersion: number;
  translationStatus: "pending" | "translated" | "failed";
  quality?: {
    riskScore: number;
    riskReasons: string[];
    checkedBy: string[];
    reverseText?: string;
    reviewThreshold?: number;
  };
}
