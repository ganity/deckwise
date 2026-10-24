import { sanitizeSlideHtml } from "../../../../../lib/sanitize-slide-html";
import { useLayoutEffect, useRef, useState } from "react";
import type { PPTLatexElement } from "../../../../../lib/types/slides";

interface LatexElementVisualProps {
  readonly elementInfo: PPTLatexElement;
  readonly className?: string;
  readonly onMouseDown?: React.MouseEventHandler<HTMLDivElement>;
  readonly onTouchStart?: React.TouchEventHandler<HTMLDivElement>;
}

const ALIGN_MAP = {
  left: "flex-start",
  center: "center",
  right: "flex-end",
} as const;

export function LatexElementVisual({
  elementInfo,
  className,
  onMouseDown,
  onTouchStart,
}: LatexElementVisualProps) {
  return (
    <div
      className={`element-content relative w-full h-full ${className ?? ""}`}
      style={{ color: elementInfo.color }}
      onMouseDown={onMouseDown}
      onTouchStart={onTouchStart}
    >
      {elementInfo.html ? (
        <KatexContent
          html={elementInfo.html}
          width={elementInfo.width}
          height={elementInfo.height}
          align={elementInfo.align}
        />
      ) : null}
      {!elementInfo.html && elementInfo.path && elementInfo.viewBox ? (
        <svg
          overflow="visible"
          width={elementInfo.width}
          height={elementInfo.height}
          stroke={elementInfo.color}
          strokeWidth={elementInfo.strokeWidth}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="transform-origin-[0_0] overflow-visible"
        >
          <g
            transform={`scale(${elementInfo.width / elementInfo.viewBox[0]}, ${elementInfo.height / elementInfo.viewBox[1]}) translate(0,0) matrix(1,0,0,1,0,0)`}
          >
            <path d={elementInfo.path} />
          </g>
        </svg>
      ) : null}
    </div>
  );
}

function KatexContent({
  html,
  width,
  height,
  align = "center",
}: {
  html: string;
  width: number;
  height: number;
  align?: "left" | "center" | "right";
}) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    if (!innerRef.current) return;
    const naturalW = innerRef.current.scrollWidth;
    const naturalH = innerRef.current.scrollHeight;
    if (naturalW > 0 && naturalH > 0)
      setScale(Math.min(width / naturalW, height / naturalH));
  }, [html, width, height]);

  const origin =
    align === "left"
      ? "left center"
      : align === "right"
        ? "right center"
        : "center center";

  return (
    <div
      style={{
        width,
        height,
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        justifyContent: ALIGN_MAP[align],
      }}
    >
      <div
        ref={innerRef}
        className="[&_.katex-display]:!m-0"
        style={{
          transformOrigin: origin,
          transform: `scale(${scale})`,
          whiteSpace: "nowrap",
        }}
        dangerouslySetInnerHTML={{ __html: sanitizeSlideHtml(html) }}
      />
    </div>
  );
}
