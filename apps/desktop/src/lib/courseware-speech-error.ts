export function speechGenerationError(error: unknown, insufficientPoints: string): string {
  const message = String(error);
  return /INSUFFICIENT_(?:POINTS|BALANCE)|积分不足/u.test(message) ? insufficientPoints : message;
}
