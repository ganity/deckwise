"use client";

import type { PPTLatexElement } from "../../../../../lib/types/slides";
import { LatexElementVisual } from "./LatexElementVisual";

export interface BaseLatexElementProps {
  elementInfo: PPTLatexElement;
}

/**
 * Base latex element for read-only/playback mode.
 * Renders KaTeX HTML if available, falls back to legacy SVG path.
 */
export function BaseLatexElement({ elementInfo }: BaseLatexElementProps) {
  return (
    <div
      className="base-element-latex absolute"
      style={{
        top: `${elementInfo.top}px`,
        left: `${elementInfo.left}px`,
        width: `${elementInfo.width}px`,
        height: `${elementInfo.height}px`,
      }}
    >
      <div
        className="rotate-wrapper w-full h-full"
        style={{ transform: `rotate(${elementInfo.rotate}deg)` }}
      >
        <LatexElementVisual elementInfo={elementInfo} />
      </div>
    </div>
  );
}
