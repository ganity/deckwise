import { forwardRef } from "react";
import type { PPTTextElement } from "../../../../../lib/types/slides";
import { resolveImportedSlideFontStack } from "../../../../../lib/imported-slide-fonts";
import { useElementShadow } from "../hooks/useElementShadow";
import { ElementOutline } from "../ElementOutline";
import {
  resolveTextFrameLetterSpacing,
  shouldPreserveSourceSingleGlyphOverflow,
} from "../StaticTextContent";

interface TextElementFrameProps {
  readonly elementInfo: PPTTextElement;
  readonly children: React.ReactNode;
  readonly className?: string;
  readonly onMouseDown?: React.MouseEventHandler<HTMLDivElement>;
  readonly onTouchStart?: React.TouchEventHandler<HTMLDivElement>;
  readonly onDoubleClick?: React.MouseEventHandler<HTMLDivElement>;
}

export const TextElementFrame = forwardRef<
  HTMLDivElement,
  TextElementFrameProps
>(
  (
    {
      elementInfo,
      children,
      className,
      onMouseDown,
      onTouchStart,
      onDoubleClick,
    },
    ref,
  ) => {
    const { shadowStyle } = useElementShadow(elementInfo.shadow);
    const fixedLayout = elementInfo.fixedBox || Boolean(elementInfo.autoFit);
    const verticalAlign =
      elementInfo.verticalAlign ?? elementInfo.vAlign ?? "top";
    const preserveSourceGlyphOverflow = shouldPreserveSourceSingleGlyphOverflow(
      {
        content: elementInfo.content,
        autoFit: elementInfo.autoFit,
        boxWidth: elementInfo.width,
        paddingLeft: elementInfo.paddingLeft ?? 10,
        paddingRight: elementInfo.paddingRight ?? 10,
      },
    );

    return (
      <div
        ref={ref}
        className={`element-content relative leading-[1.5] break-words ${className ?? ""}`}
        style={{
          width:
            elementInfo.vertical && !fixedLayout
              ? "auto"
              : `${elementInfo.width}px`,
          height:
            !elementInfo.vertical && !fixedLayout
              ? "auto"
              : `${elementInfo.height}px`,
          backgroundColor: elementInfo.fill,
          opacity: elementInfo.opacity,
          textShadow: shadowStyle,
          // Legacy PPT imports stored absolute pt values in this multiplier field.
          lineHeight:
            elementInfo.lineHeight && elementInfo.lineHeight > 3
              ? `${elementInfo.lineHeight}pt`
              : elementInfo.lineHeight,
          letterSpacing: `${resolveTextFrameLetterSpacing(
            elementInfo.content,
            elementInfo.wordSpace,
          )}px`,
          color: elementInfo.defaultColor,
          textAlign: elementInfo.textAlign,
          userSelect: "text",
          fontFamily: resolveImportedSlideFontStack(
            elementInfo.defaultFontName,
          ),
          writingMode: elementInfo.vertical ? "vertical-rl" : "horizontal-tb",
          overflow:
            elementInfo.overflowVisible || preserveSourceGlyphOverflow
              ? "visible"
              : fixedLayout
                ? "hidden"
                : "visible",
          boxSizing: "border-box",
          display: fixedLayout ? "flex" : undefined,
          flexDirection: fixedLayout ? "column" : undefined,
          justifyContent: fixedLayout
            ? verticalAlign === "middle"
              ? "center"
              : verticalAlign === "bottom"
                ? "flex-end"
                : "flex-start"
            : undefined,
          paddingLeft: `${elementInfo.paddingLeft ?? 10}px`,
          paddingRight: `${elementInfo.paddingRight ?? 10}px`,
          paddingTop: `${elementInfo.paddingTop ?? 10}px`,
          paddingBottom: `${elementInfo.paddingBottom ?? 10}px`,
          // @ts-expect-error - CSS custom property
          "--paragraphSpace": `${elementInfo.paragraphSpace === undefined ? 5 : elementInfo.paragraphSpace}px`,
        }}
        onMouseDown={onMouseDown}
        onTouchStart={onTouchStart}
        onDoubleClick={onDoubleClick}
      >
        <ElementOutline
          width={elementInfo.width}
          height={elementInfo.height}
          outline={elementInfo.outline}
        />
        {children}
      </div>
    );
  },
);

TextElementFrame.displayName = "TextElementFrame";
