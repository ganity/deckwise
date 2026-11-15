import type { PPTShapeElement } from "../../../../../lib/types/slides";

const RECT_EPSILON = 1e-6;

export function shouldRenderRectangularPatternAsImage(
  element: PPTShapeElement,
): boolean {
  if (!element.pattern || element.patternScaleMode !== "stretch") return false;
  if (element.subPaths?.length) return false;
  if (hasMeaningfulPatternCrop(element.patternCrop)) return false;

  return isAxisAlignedRectanglePath(element.path, element.viewBox);
}

export function RectangularPatternImage({
  element,
}: {
  element: PPTShapeElement;
}) {
  if (!element.pattern) return null;

  return (
    <img
      data-pptx-rectangular-pattern-image="true"
      src={element.pattern}
      draggable={false}
      alt=""
      className="pointer-events-none absolute inset-0 block"
      style={{
        width: "100%",
        height: "100%",
        maxWidth: "none",
        maxHeight: "none",
        objectFit: "fill",
      }}
      onDragStart={(event) => event.preventDefault()}
    />
  );
}

function hasMeaningfulPatternCrop(
  crop: PPTShapeElement["patternCrop"],
): boolean {
  if (!crop) return false;

  const range = crop.range;
  if (
    range &&
    (!nearlyEqual(range[0][0], 0) ||
      !nearlyEqual(range[0][1], 0) ||
      !nearlyEqual(range[1][0], 100) ||
      !nearlyEqual(range[1][1], 100))
  ) {
    return true;
  }

  return Object.values(crop.fillRect ?? {}).some(
    (value) =>
      typeof value === "number" &&
      Number.isFinite(value) &&
      !nearlyEqual(value, 0),
  );
}

function isAxisAlignedRectanglePath(
  path: string,
  viewBox: [number, number],
): boolean {
  const [width, height] = viewBox;
  if (!(width > 0 && height > 0)) return false;

  const commands = path.match(/[A-DF-Za-df-z]+/g) ?? [];
  if (
    commands.some(
      (command) => !["M", "L", "Z", "m", "l", "z"].includes(command),
    )
  ) {
    return false;
  }

  const values = path
    .match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g)
    ?.map(Number);
  if (!values || (values.length !== 8 && values.length !== 10)) return false;

  const expected =
    values.length === 10
      ? [0, 0, width, 0, width, height, 0, height, 0, 0]
      : [0, 0, width, 0, width, height, 0, height];
  const tolerance = Math.max(
    RECT_EPSILON,
    Math.max(width, height) * RECT_EPSILON,
  );

  return values.every(
    (value, index) =>
      Number.isFinite(value) && Math.abs(value - expected[index]) <= tolerance,
  );
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= RECT_EPSILON;
}
