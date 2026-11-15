import { SVGPathData } from "svg-pathdata";
import type { PPTShapeElement } from "../../../../../lib/types/slides";

interface ShapePathBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface ShapePathTransform {
  scaleX: number;
  scaleY: number;
  translateX: number;
  translateY: number;
  normalizedLegacyViewBox: boolean;
}

const MAX_LEGACY_VIEWBOX_FILL_RATIO = 0.985;
const MIN_LEGACY_VIEWBOX_FILL_RATIO = 0.55;

function getShapePathBounds(path: string): ShapePathBounds | null {
  try {
    const pathData = new SVGPathData(path).toAbs();
    if (pathData.commands.some((command) => command.type === SVGPathData.ARC)) {
      const { minX, minY, maxX, maxY } = pathData.getBounds();
      if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null;
      return { minX, minY, maxX, maxY };
    }

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const command of pathData.commands) {
      for (const [x, y] of [
        [
          "x" in command ? command.x : undefined,
          "y" in command ? command.y : undefined,
        ],
        [
          "x1" in command ? command.x1 : undefined,
          "y1" in command ? command.y1 : undefined,
        ],
        [
          "x2" in command ? command.x2 : undefined,
          "y2" in command ? command.y2 : undefined,
        ],
      ] as const) {
        if (typeof x === "number" && Number.isFinite(x)) {
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
        }
        if (typeof y === "number" && Number.isFinite(y)) {
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      }
    }
    if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null;
    return { minX, minY, maxX, maxY };
  } catch {
    return null;
  }
}

function getFirstClosedSubpathBounds(path: string): ShapePathBounds | null {
  try {
    const commands = new SVGPathData(path).toAbs().commands;
    let started = false;
    let closed = false;
    const subpathCommands: typeof commands = [];

    for (const command of commands) {
      if (command.type === SVGPathData.MOVE_TO) {
        if (started) break;
        started = true;
      }
      if (!started) continue;
      subpathCommands.push(command);
      if (command.type === SVGPathData.CLOSE_PATH) {
        closed = true;
        break;
      }
    }

    if (!closed) return null;
    return getShapePathBounds(new SVGPathData(subpathCommands).encode());
  } catch {
    return null;
  }
}

function isSimpleClosedEllipsePath(path: string): boolean {
  try {
    const commands = new SVGPathData(path).toAbs().commands;
    return (
      commands.length === 4 &&
      commands[0]?.type === SVGPathData.MOVE_TO &&
      commands[1]?.type === SVGPathData.ARC &&
      commands[2]?.type === SVGPathData.ARC &&
      commands[3]?.type === SVGPathData.CLOSE_PATH
    );
  } catch {
    return false;
  }
}

export function isIntegratedEllipseCalloutPath(
  element: Pick<PPTShapeElement, "path" | "viewBox" | "sourceShapeId">,
): boolean {
  if (!element.sourceShapeId || !element.path) return false;
  const [width, height] = element.viewBox;
  if (!(width > 0 && height > 0)) return false;

  try {
    const commands = new SVGPathData(element.path).toAbs().commands;
    const move = commands[0];
    const pointer = commands[1];
    const secondConnection = commands[2];
    const bodyArc = commands[3];
    if (
      commands.length !== 5 ||
      move?.type !== SVGPathData.MOVE_TO ||
      pointer?.type !== SVGPathData.LINE_TO ||
      secondConnection?.type !== SVGPathData.LINE_TO ||
      bodyArc?.type !== SVGPathData.ARC ||
      commands[4]?.type !== SVGPathData.CLOSE_PATH
    ) {
      return false;
    }

    const pointerOutsideBody =
      pointer.x < -width * 0.05 ||
      pointer.x > width * 1.05 ||
      pointer.y < -height * 0.05 ||
      pointer.y > height * 1.05;
    const connectionsInsideBody = [move, secondConnection].every(
      (command) =>
        command.x >= -0.01 &&
        command.x <= width + 0.01 &&
        command.y >= -0.01 &&
        command.y <= height + 0.01,
    );
    const arcMatchesEllipseBody =
      Math.abs(bodyArc.rX - width / 2) <= width * 0.01 &&
      Math.abs(bodyArc.rY - height / 2) <= height * 0.01 &&
      Math.abs(bodyArc.x - move.x) <= 0.01 &&
      Math.abs(bodyArc.y - move.y) <= 0.01;

    return pointerOutsideBody && connectionsInsideBody && arcMatchesEllipseBody;
  } catch {
    return false;
  }
}

export function resolveShapePathTransform(
  element: Pick<
    PPTShapeElement,
    "path" | "viewBox" | "width" | "height" | "sourceShapeId"
  >,
): ShapePathTransform {
  const [storedWidth, storedHeight] = element.viewBox;
  const fallback = {
    scaleX: element.width / storedWidth,
    scaleY: element.height / storedHeight,
    translateX: 0,
    translateY: 0,
    normalizedLegacyViewBox: false,
  };

  if (!element.path || !(storedWidth > 0 && storedHeight > 0)) {
    return fallback;
  }

  const bounds = getShapePathBounds(element.path);
  if (!bounds) return fallback;

  const firstSubpathBounds = getFirstClosedSubpathBounds(element.path);
  if (firstSubpathBounds) {
    const bodyWidth = firstSubpathBounds.maxX - firstSubpathBounds.minX;
    const bodyHeight = firstSubpathBounds.maxY - firstSubpathBounds.minY;
    const bodyStartsAtOrigin =
      Math.abs(firstSubpathBounds.minX) <= 0.01 &&
      Math.abs(firstSubpathBounds.minY) <= 0.01;
    const bodyAspectMatchesFrame =
      bodyWidth > 0 &&
      bodyHeight > 0 &&
      Math.abs(bodyWidth / bodyHeight / (element.width / element.height) - 1) <=
        0.02;
    const pathExtendsOutsideBody =
      bounds.minX < firstSubpathBounds.minX - 0.01 ||
      bounds.minY < firstSubpathBounds.minY - 0.01 ||
      bounds.maxX > firstSubpathBounds.maxX + 0.01 ||
      bounds.maxY > firstSubpathBounds.maxY + 0.01;

    if (
      bodyStartsAtOrigin &&
      bodyAspectMatchesFrame &&
      pathExtendsOutsideBody
    ) {
      return {
        scaleX: element.width / bodyWidth,
        scaleY: element.height / bodyHeight,
        translateX: 0,
        translateY: 0,
        normalizedLegacyViewBox:
          Math.abs(storedWidth - bodyWidth) > 0.01 ||
          Math.abs(storedHeight - bodyHeight) > 0.01,
      };
    }
  }

  const hasNegativeOrigin = bounds.minX < -0.01 || bounds.minY < -0.01;
  const fullPathWidth = bounds.maxX - bounds.minX;
  const fullPathHeight = bounds.maxY - bounds.minY;
  const sourceEllipseOverflowsViewBox =
    Boolean(element.sourceShapeId) &&
    !hasNegativeOrigin &&
    isSimpleClosedEllipsePath(element.path) &&
    fullPathWidth > 0 &&
    fullPathHeight > 0 &&
    (bounds.maxX > storedWidth * 1.001 || bounds.maxY > storedHeight * 1.001);

  if (sourceEllipseOverflowsViewBox) {
    return {
      scaleX: element.width / fullPathWidth,
      scaleY: element.height / fullPathHeight,
      translateX: Math.abs(bounds.minX) > 0.000001 ? -bounds.minX : 0,
      translateY: Math.abs(bounds.minY) > 0.000001 ? -bounds.minY : 0,
      normalizedLegacyViewBox: true,
    };
  }

  if (element.sourceShapeId && !hasNegativeOrigin) return fallback;

  const positiveWidthFill = bounds.maxX / storedWidth;
  const positiveHeightFill = bounds.maxY / storedHeight;
  const sourceCalloutOverflowsViewBox =
    Boolean(element.sourceShapeId) &&
    hasNegativeOrigin &&
    (fullPathWidth > storedWidth * 1.001 ||
      fullPathHeight > storedHeight * 1.001) &&
    positiveWidthFill >= 0.75 &&
    positiveWidthFill <= 1.1 &&
    positiveHeightFill >= 0.75 &&
    positiveHeightFill <= 1.1;

  if (sourceCalloutOverflowsViewBox) {
    return {
      scaleX: element.width / bounds.maxX,
      scaleY: element.height / bounds.maxY,
      translateX: 0,
      translateY: 0,
      normalizedLegacyViewBox: true,
    };
  }

  const pathWidth = hasNegativeOrigin
    ? bounds.maxX - bounds.minX
    : Math.max(bounds.maxX, bounds.maxX - bounds.minX);
  const pathHeight = hasNegativeOrigin
    ? bounds.maxY - bounds.minY
    : Math.max(bounds.maxY, bounds.maxY - bounds.minY);
  if (!(pathWidth > 0 && pathHeight > 0)) return fallback;

  const fillX = pathWidth / storedWidth;
  const fillY = pathHeight / storedHeight;
  const hasLegacyPadding =
    fillX >= MIN_LEGACY_VIEWBOX_FILL_RATIO &&
    fillY >= MIN_LEGACY_VIEWBOX_FILL_RATIO &&
    fillX <= 1.001 &&
    fillY <= 1.001 &&
    (hasNegativeOrigin ||
      fillX < MAX_LEGACY_VIEWBOX_FILL_RATIO ||
      fillY < MAX_LEGACY_VIEWBOX_FILL_RATIO);
  if (!hasLegacyPadding) return fallback;

  return {
    scaleX: element.width / pathWidth,
    scaleY: element.height / pathHeight,
    translateX:
      hasNegativeOrigin && Math.abs(bounds.minX) > 0.000001 ? -bounds.minX : 0,
    translateY:
      hasNegativeOrigin && Math.abs(bounds.minY) > 0.000001 ? -bounds.minY : 0,
    normalizedLegacyViewBox: true,
  };
}
