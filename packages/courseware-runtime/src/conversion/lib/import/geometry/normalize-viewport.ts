export function normalizeViewportRect(params: {
  x: number;
  y: number;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  targetWidth: number;
  targetHeight: number;
}) {
  const {
    x,
    y,
    width,
    height,
    sourceWidth,
    sourceHeight,
    targetWidth,
    targetHeight,
  } = params;

  return {
    left: (x / sourceWidth) * targetWidth,
    top: (y / sourceHeight) * targetHeight,
    width: (width / sourceWidth) * targetWidth,
    height: (height / sourceHeight) * targetHeight,
  };
}

export function targetHeightFromWidth(targetWidth: number, sourceWidth: number, sourceHeight: number): number {
  if (!sourceWidth || !sourceHeight) {
    return targetWidth * 0.5625;
  }
  return (sourceHeight / sourceWidth) * targetWidth;
}
