import type { PPTElement, Slide } from "../types/slides";
import type { PercentageGeometry } from "../types/action";

const DEFAULT_VIEWPORT_SIZE = 1000;
const DEFAULT_VIEWPORT_RATIO = 0.5625;

export function getSlideViewportMetrics(
  slide: Pick<Slide, "viewportSize" | "viewportRatio">,
) {
  const width =
    Number.isFinite(slide.viewportSize) && slide.viewportSize > 0
      ? slide.viewportSize
      : DEFAULT_VIEWPORT_SIZE;
  const ratio =
    Number.isFinite(slide.viewportRatio) && slide.viewportRatio > 0
      ? slide.viewportRatio
      : DEFAULT_VIEWPORT_RATIO;

  return { width, height: width * ratio, ratio };
}

export function getCenteredElementPosition(
  slide: Pick<Slide, "viewportSize" | "viewportRatio">,
  element: { width: number; height: number },
) {
  const viewport = getSlideViewportMetrics(slide);

  return {
    left: (viewport.width - element.width) / 2,
    top: (viewport.height - element.height) / 2,
  };
}

/**
 * Calculate percentage coordinates (0-100) for an element
 *
 * @param element - PPT element
 * @param viewportSize - Viewport width base, default 1000px
 * @param viewportRatio - Viewport aspect ratio, default 16:9
 * @returns Percentage geometry info, or null if the element has no position info
 */
export function getElementPercentageGeometry(
  element: PPTElement,
  viewportSize: number = DEFAULT_VIEWPORT_SIZE,
  viewportRatio: number = DEFAULT_VIEWPORT_RATIO,
): PercentageGeometry | null {
  // Only positioned elements have left/top/width/height
  if (
    !("left" in element) ||
    !("top" in element) ||
    !("width" in element) ||
    !("height" in element)
  ) {
    return null;
  }

  const { left, top, width, height } = element;
  const viewport = getSlideViewportMetrics({ viewportSize, viewportRatio });

  // Calculate percentage coordinates (relative to viewportSize)
  const x = (left / viewport.width) * 100;
  const y = (top / viewport.height) * 100;
  const w = (width / viewport.width) * 100;
  const h = (height / viewport.height) * 100;

  // Calculate center point
  const centerX = x + w / 2;
  const centerY = y + h / 2;

  return {
    x,
    y,
    w,
    h,
    centerX,
    centerY,
  };
}

/**
 * Find percentage geometry info by scene and element ID
 *
 * @param scene - Scene object
 * @param elementId - Element ID
 * @param viewportSize - Optional viewport width override; otherwise use the scene canvas
 * @param viewportRatio - Optional viewport ratio override; otherwise use the scene canvas
 * @returns Percentage geometry info, or null if element is not found or has no position info
 */
export function findElementGeometry(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- scene can be old or new format with different shapes
  scene: Record<string, any>,
  elementId: string,
  viewportSize?: number,
  viewportRatio?: number,
): PercentageGeometry | null {
  // Support two scene structures:
  // 1. scene.elements (old format)
  // 2. scene.content.canvas.elements (new format)
  let elements: PPTElement[] | undefined;

  if (scene.type === "slide") {
    if (scene.elements) {
      // Old format
      elements = scene.elements;
    } else if (scene.content?.canvas?.elements) {
      // New format
      elements = scene.content.canvas.elements;
    }
  }

  if (!elements) {
    return null;
  }

  const element = elements.find((el: PPTElement) => el.id === elementId);
  if (!element) {
    return null;
  }

  return getElementPercentageGeometry(
    element,
    viewportSize ??
      scene.content?.canvas?.viewportSize ??
      DEFAULT_VIEWPORT_SIZE,
    viewportRatio ??
      scene.content?.canvas?.viewportRatio ??
      DEFAULT_VIEWPORT_RATIO,
  );
}

/**
 * Calculate which corner has the shortest distance to the element center
 *
 * @param geometry - Percentage geometry info
 * @returns Nearest corner coordinates { x: 0-100, y: 0-100 }
 */
export function findNearestCorner(geometry: PercentageGeometry): {
  x: number;
  y: number;
} {
  const { centerX, centerY } = geometry;

  // Coordinates of the four corners
  const corners = [
    { x: 0, y: 0 }, // Top-left
    { x: 100, y: 0 }, // Top-right
    { x: 0, y: 100 }, // Bottom-left
    { x: 100, y: 100 }, // Bottom-right
  ];

  // Calculate distances and find the nearest corner
  let minDistance = Infinity;
  let nearestCorner = corners[0];

  for (const corner of corners) {
    const distance = Math.sqrt(
      Math.pow(corner.x - centerX, 2) + Math.pow(corner.y - centerY, 2),
    );
    if (distance < minDistance) {
      minDistance = distance;
      nearestCorner = corner;
    }
  }

  return nearestCorner;
}
