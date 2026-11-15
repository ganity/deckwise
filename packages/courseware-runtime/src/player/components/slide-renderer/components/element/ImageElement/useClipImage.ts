import { useMemo } from 'react';
import type { PPTImageElement } from '../../../../../lib/types/slides';
import { CLIPPATHS, ClipPathTypes } from '../../../../../configs/image-clip';

export function resolveClipShape(shape: string | null | undefined, radius: number | null | undefined) {
  const baseClipShape = (shape && CLIPPATHS[shape]) ? CLIPPATHS[shape] : CLIPPATHS.rect;

  if (baseClipShape.radius !== undefined && radius) {
    return {
      ...baseClipShape,
      radius: `${radius}px`,
      style: `inset(0 round ${radius}px)`,
    };
  }

  return baseClipShape;
}

/**
 * Calculate image clip shape and position
 * @param element Image element
 */
export function useClipImage(element: PPTImageElement) {
  const clipShape = useMemo(() => {
    const shape = element.clip?.shape || ClipPathTypes.RECT;
    return resolveClipShape(shape, element.radius);
  }, [element.clip, element.radius]);

  const imgPosition = useMemo(() => {
    if (!element.clip || !element.clip.range) {
      return {
        top: '0',
        left: '0',
        width: '100%',
        height: '100%',
      };
    }

    const [start, end] = element.clip.range;

    const widthScale = (end[0] - start[0]) / 100;
    const heightScale = (end[1] - start[1]) / 100;
    const left = start[0] / widthScale;
    const top = start[1] / heightScale;

    return {
      left: -left + '%',
      top: -top + '%',
      width: 100 / widthScale + '%',
      height: 100 / heightScale + '%',
    };
  }, [element.clip]);

  return {
    clipShape,
    imgPosition,
  };
}
