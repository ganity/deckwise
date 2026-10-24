interface PatternDefsProps {
  id: string;
  src: string;
  scaleMode?: "cover" | "contain" | "stretch";
  crop?: {
    range?: [[number, number], [number, number]];
    fillRect?: {
      left?: number;
      top?: number;
      right?: number;
      bottom?: number;
    };
  };
}

function mapPreserveAspectRatio(
  scaleMode: PatternDefsProps["scaleMode"],
): string {
  if (scaleMode === "contain") return "xMidYMid meet";
  if (scaleMode === "stretch") return "none";
  return "xMidYMid slice";
}

export function PatternDefs({
  id,
  src,
  scaleMode = "cover",
  crop,
}: PatternDefsProps) {
  const source = cropRangeToBox(crop?.range);
  const fillRect = crop?.fillRect;
  const destinationLeft = (fillRect?.left ?? 0) / 100;
  const destinationTop = (fillRect?.top ?? 0) / 100;
  const destinationRight = (fillRect?.right ?? 0) / 100;
  const destinationBottom = (fillRect?.bottom ?? 0) / 100;
  const destinationWidth = Math.max(
    1e-6,
    1 - destinationLeft - destinationRight,
  );
  const destinationHeight = Math.max(
    1e-6,
    1 - destinationTop - destinationBottom,
  );

  // DrawingML srcRect describes the retained source region. Expand the full
  // image so that this region lands exactly inside the destination fillRect.
  const contentWidth = roundPatternNumber(destinationWidth / source.width);
  const contentHeight = roundPatternNumber(destinationHeight / source.height);
  const imageX = roundPatternNumber(
    destinationLeft - source.left * contentWidth,
  );
  const imageY = roundPatternNumber(
    destinationTop - source.top * contentHeight,
  );

  return (
    <pattern
      id={id}
      patternContentUnits="objectBoundingBox"
      patternUnits="objectBoundingBox"
      width="1"
      height="1"
    >
      <image
        href={src}
        x={imageX}
        y={imageY}
        width={contentWidth}
        height={contentHeight}
        preserveAspectRatio={mapPreserveAspectRatio(scaleMode)}
      />
    </pattern>
  );
}

function roundPatternNumber(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function cropRangeToBox(range?: [[number, number], [number, number]]) {
  if (!range) {
    return {
      left: 0,
      top: 0,
      width: 1,
      height: 1,
    };
  }

  const left = range[0][0] / 100;
  const top = range[0][1] / 100;
  const right = range[1][0] / 100;
  const bottom = range[1][1] / 100;

  return {
    left,
    top,
    width: Math.max(1e-6, right - left),
    height: Math.max(1e-6, bottom - top),
  };
}
