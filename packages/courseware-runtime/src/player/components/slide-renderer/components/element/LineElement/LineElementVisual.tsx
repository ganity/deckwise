import { useMemo } from "react";
import type { PPTLineElement } from "../../../../../lib/types/slides";
import { getLineElementPath } from "../../../../../lib/utils/element";
import { useElementShadow } from "../hooks/useElementShadow";
import { LinePointMarker } from "./LinePointMarker";

interface LineElementVisualProps {
  readonly elementInfo: PPTLineElement;
  readonly drawComplete?: boolean;
  readonly pathRef?: React.Ref<SVGPathElement>;
  readonly interactive?: boolean;
  readonly onMouseDown?: React.MouseEventHandler<HTMLDivElement>;
  readonly onTouchStart?: React.TouchEventHandler<HTMLDivElement>;
}

export function LineElementVisual({
  elementInfo,
  drawComplete = true,
  pathRef,
  interactive = false,
  onMouseDown,
  onTouchStart,
}: LineElementVisualProps) {
  const { shadowStyle } = useElementShadow(elementInfo.shadow);
  const svgWidth = useMemo(
    () => Math.max(24, Math.abs(elementInfo.start[0] - elementInfo.end[0])),
    [elementInfo.start, elementInfo.end],
  );
  const svgHeight = useMemo(
    () => Math.max(24, Math.abs(elementInfo.start[1] - elementInfo.end[1])),
    [elementInfo.start, elementInfo.end],
  );
  const lineDashArray = useMemo(() => {
    const size = elementInfo.width;
    if (elementInfo.style === "dashed")
      return size <= 8
        ? `${size * 5} ${size * 2.5}`
        : `${size * 5} ${size * 1.5}`;
    if (elementInfo.style === "dotted")
      return size <= 8
        ? `${size * 1.8} ${size * 1.6}`
        : `${size * 1.5} ${size * 1.2}`;
    return "0 0";
  }, [elementInfo.width, elementInfo.style]);
  const path = useMemo(() => getLineElementPath(elementInfo), [elementInfo]);
  const cursorClass = elementInfo.lock ? "cursor-default" : "cursor-move";

  return (
    <div
      className="element-content relative w-full h-full"
      style={{ filter: shadowStyle ? `drop-shadow(${shadowStyle})` : "" }}
      onMouseDown={onMouseDown}
      onTouchStart={onTouchStart}
    >
      <svg
        overflow="visible"
        width={svgWidth}
        height={svgHeight}
        className="transform-origin-[0_0] overflow-visible"
      >
        <defs>
          {elementInfo.points[0] ? (
            <LinePointMarker
              id={elementInfo.id}
              position="start"
              type={elementInfo.points[0]}
              color={elementInfo.color}
              baseSize={elementInfo.width}
            />
          ) : null}
          {elementInfo.points[1] ? (
            <LinePointMarker
              id={elementInfo.id}
              position="end"
              type={elementInfo.points[1]}
              color={elementInfo.color}
              baseSize={elementInfo.width}
            />
          ) : null}
        </defs>
        <path
          ref={pathRef}
          className={
            interactive
              ? `line-point pointer-events-auto ${cursorClass}`
              : undefined
          }
          d={path}
          stroke={elementInfo.color}
          strokeWidth={elementInfo.width}
          strokeDasharray={lineDashArray}
          fill="none"
          markerStart={
            drawComplete && elementInfo.points[0]
              ? `url(#${elementInfo.id}-${elementInfo.points[0]}-start)`
              : ""
          }
          markerEnd={
            drawComplete && elementInfo.points[1]
              ? `url(#${elementInfo.id}-${elementInfo.points[1]}-end)`
              : ""
          }
        />
        {interactive ? (
          <path
            className={`line-path pointer-events-auto ${cursorClass}`}
            d={path}
            stroke="transparent"
            strokeWidth="20"
            fill="none"
          />
        ) : null}
      </svg>
    </div>
  );
}
