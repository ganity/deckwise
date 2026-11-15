"use client";

import { useRef, useState, useEffect } from "react";
import type { PPTLineElement } from "../../../../../lib/types/slides";
import { LineElementVisual } from "./LineElementVisual";

export interface BaseLineElementProps {
  elementInfo: PPTLineElement;
  animate?: boolean;
}

/** Duration of the stroke-drawing animation in ms */
const DRAW_ANIMATION_MS = 600;

/**
 * Base line element for read-only/playback mode.
 * When animate=true, plays a stroke-drawing animation on mount.
 */
export function BaseLineElement({
  elementInfo,
  animate,
}: BaseLineElementProps) {
  const pathRef = useRef<SVGPathElement>(null);
  const [drawComplete, setDrawComplete] = useState(!animate);

  // Stroke-drawing animation on mount (whiteboard only)
  useEffect(() => {
    if (!animate) return;
    const pathEl = pathRef.current;
    if (!pathEl) return;

    const length = pathEl.getTotalLength();
    if (length === 0) {
      // Zero-length path — skip animation, reveal markers on next tick
      const t = setTimeout(() => setDrawComplete(true), 0);
      return () => clearTimeout(t);
    }

    // Initial state: line fully hidden via dash offset
    pathEl.style.strokeDasharray = `${length}`;
    pathEl.style.strokeDashoffset = `${length}`;
    pathEl.style.transition = "none";

    // Force reflow so the browser registers the initial state
    pathEl.getBoundingClientRect();

    // Animate: draw the line from start to end
    pathEl.style.transition = `stroke-dashoffset ${DRAW_ANIMATION_MS}ms ease-out`;
    pathEl.style.strokeDashoffset = "0";

    // After animation, restore the original dash style (for dashed/dotted lines)
    // and show endpoint markers
    const timer = setTimeout(() => {
      pathEl.style.transition = "none";
      pathEl.style.strokeDasharray = "";
      pathEl.style.strokeDashoffset = "";
      setDrawComplete(true);
    }, DRAW_ANIMATION_MS + 50);

    return () => clearTimeout(timer);
  }, [animate]);

  return (
    <div
      className="base-element-line absolute"
      style={{
        top: `${elementInfo.top}px`,
        left: `${elementInfo.left}px`,
      }}
    >
      <LineElementVisual
        elementInfo={elementInfo}
        pathRef={pathRef}
        drawComplete={drawComplete}
      />
    </div>
  );
}
