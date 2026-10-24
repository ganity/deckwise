"use client";

import { useId } from "react";
import { bilingualShapeContent } from "../../../../../lib/bilingual/embedded-text";
import type { PPTShapeElement, ShapeText } from "../../../../../lib/types/slides";
import { resolveImportedSlideFontStack } from "../../../../../lib/imported-slide-fonts";
import {
  getStrokeDashArray,
  useElementOutline,
} from "../hooks/useElementOutline";
import { useElementShadow } from "../hooks/useElementShadow";
import { useElementFlip } from "../hooks/useElementFlip";
import { getElementFill } from "../hooks/useElementFill";
import { GradientDefs } from "./GradientDefs";
import { PatternDefs } from "./PatternDefs";
import { LinePointMarker } from "../LineElement/LinePointMarker";
import {
  RectangularPatternImage,
  shouldRenderRectangularPatternAsImage,
} from "./RectangularPatternImage";
import {
  resolveTextFrameLetterSpacing,
  shouldPreserveSourceSingleGlyphOverflow,
  StaticTextContent,
} from "../StaticTextContent";
import { resolveShapePathTransform } from "./shape-path-transform";
import { resolveShapeTextLayout } from "./shape-text-layout";

export interface BaseShapeElementProps {
  elementInfo: PPTShapeElement;
  isPptxEntranceAnimationTarget?: boolean;
}

/**
 * Base shape element for read-only/playback mode
 */
export function BaseShapeElement({
  elementInfo,
  isPptxEntranceAnimationTarget = false,
}: BaseShapeElementProps) {
  const instanceId = useId().replace(/[^A-Za-z0-9_-]/g, "_");
  const patternId = `base-pattern-${elementInfo.id}-${instanceId}`;
  const gradientId = `base-gradient-${elementInfo.id}-${instanceId}`;
  const fill = getElementFill(elementInfo, { patternId, gradientId });
  const renderPatternAsImage =
    shouldRenderRectangularPatternAsImage(elementInfo);
  const { outlineWidth, outlineColor, strokeDashArray } = useElementOutline(
    elementInfo.outline,
  );
  const { shadowStyle } = useElementShadow(elementInfo.shadow);
  const { flipStyle } = useElementFlip(elementInfo.flipH, elementInfo.flipV);
  const pathTransform = resolveShapePathTransform(elementInfo);
  const [startPoint, endPoint] = elementInfo.points ?? ["", ""];

  const text: ShapeText = elementInfo.text || {
    content: "",
    align: "middle",
    defaultFontName: "Microsoft YaHei",
    defaultColor: "#333333",
  };
  const textLayout = resolveShapeTextLayout(elementInfo, {
    ...text,
    content: bilingualShapeContent(text),
  });
  const preserveSourceGlyphOverflow = shouldPreserveSourceSingleGlyphOverflow({
    content: textLayout.content,
    autoFit: text.autoFit,
    boxWidth: elementInfo.width,
    paddingLeft: textLayout.paddingLeft,
    paddingRight: textLayout.paddingRight,
  });

  return (
    <div
      className="base-element-shape absolute"
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
        <div
          className="element-content relative w-full h-full"
          style={{
            opacity: elementInfo.opacity,
            filter: shadowStyle ? `drop-shadow(${shadowStyle})` : "",
            transform: flipStyle,
            color: text.defaultColor,
            fontFamily: resolveImportedSlideFontStack(text.defaultFontName),
          }}
        >
          {renderPatternAsImage && (
            <RectangularPatternImage element={elementInfo} />
          )}

          <svg
            overflow="visible"
            width={elementInfo.width}
            height={elementInfo.height}
            className="transform-origin-[0_0] overflow-visible block"
          >
            <defs>
              {elementInfo.pattern && !renderPatternAsImage && (
                <PatternDefs
                  id={patternId}
                  src={elementInfo.pattern}
                  scaleMode={elementInfo.patternScaleMode}
                  crop={elementInfo.patternCrop}
                />
              )}
              {elementInfo.gradient && (
                <GradientDefs
                  id={gradientId}
                  type={elementInfo.gradient.type}
                  colors={elementInfo.gradient.colors}
                  rotate={elementInfo.gradient.rotate}
                />
              )}
              {startPoint && (
                <LinePointMarker
                  id={elementInfo.id}
                  position="start"
                  type={startPoint}
                  baseSize={outlineWidth}
                  color={outlineColor}
                />
              )}
              {endPoint && (
                <LinePointMarker
                  id={elementInfo.id}
                  position="end"
                  type={endPoint}
                  baseSize={outlineWidth}
                  color={outlineColor}
                />
              )}
            </defs>
            <g
              data-pptx-legacy-viewbox-normalized={
                pathTransform.normalizedLegacyViewBox ? "true" : undefined
              }
              transform={`scale(${pathTransform.scaleX}, ${pathTransform.scaleY}) translate(${pathTransform.translateX},${pathTransform.translateY}) matrix(1,0,0,1,0,0)`}
            >
              {elementInfo.subPaths?.length ? (
                elementInfo.subPaths.map((subPath, index) => {
                  const subPathWidth = subPath.outline?.width ?? 0;
                  return (
                    <path
                      key={`${elementInfo.id}-subpath-${index}`}
                      vectorEffect="non-scaling-stroke"
                      strokeLinecap="butt"
                      strokeMiterlimit="8"
                      d={subPath.path}
                      fill={subPath.fill ?? "transparent"}
                      stroke={subPath.outline?.color ?? "transparent"}
                      strokeWidth={subPathWidth}
                      strokeDasharray={getStrokeDashArray(
                        subPath.outline?.style,
                        subPathWidth,
                      )}
                    />
                  );
                })
              ) : (
                <path
                  vectorEffect="non-scaling-stroke"
                  strokeLinecap="butt"
                  strokeMiterlimit="8"
                  d={elementInfo.path}
                  fill={renderPatternAsImage ? "transparent" : fill}
                  stroke={outlineColor}
                  strokeWidth={outlineWidth}
                  strokeDasharray={strokeDashArray}
                  markerStart={
                    startPoint
                      ? `url(#${elementInfo.id}-${startPoint}-start)`
                      : undefined
                  }
                  markerEnd={
                    endPoint
                      ? `url(#${elementInfo.id}-${endPoint}-end)`
                      : undefined
                  }
                />
              )}
            </g>
          </svg>

          <div
            className={`shape-text flex flex-col leading-relaxed break-words absolute inset-0 ${
              text.align === "top"
                ? "justify-start"
                : text.align === "bottom"
                  ? "justify-end"
                  : "justify-center"
            }`}
            style={{
              transform: flipStyle,
              textAlign: text.textAlign,
              lineHeight: text.lineHeight,
              letterSpacing: `${resolveTextFrameLetterSpacing(
                textLayout.content,
                text.wordSpace,
              )}px`,
              boxSizing: "border-box",
              paddingLeft: `${textLayout.paddingLeft}px`,
              paddingRight: `${textLayout.paddingRight}px`,
              paddingTop: `${textLayout.paddingTop}px`,
              paddingBottom: `${textLayout.paddingBottom}px`,
              overflow:
                text.overflowVisible || preserveSourceGlyphOverflow
                  ? "visible"
                  : text.fixedBox || text.autoFit
                    ? "hidden"
                    : "visible",
            }}
          >
            <StaticTextContent
              className="ProseMirror-static"
              content={textLayout.content}
              isPptxEntranceAnimationTarget={isPptxEntranceAnimationTarget}
              autoFit={text.autoFit}
              boxWidth={elementInfo.width}
              boxHeight={elementInfo.height}
              paddingLeft={textLayout.paddingLeft}
              paddingRight={textLayout.paddingRight}
              paddingTop={textLayout.paddingTop}
              paddingBottom={textLayout.paddingBottom}
              lineHeight={text.lineHeight}
              paragraphSpace={text.paragraphSpace}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
