"use client";

import type { PPTTextElement } from "../../../../../lib/types/slides";
import { TextElementFrame } from "./TextElementFrame";
import { StaticTextContent } from "../StaticTextContent";

export interface BaseTextElementProps {
  elementInfo: PPTTextElement;
  target?: string;
  isPptxEntranceAnimationTarget?: boolean;
}

/**
 * Base text element component (read-only)
 * Renders static text content with styling
 */
export function BaseTextElement({
  elementInfo,
  target,
  isPptxEntranceAnimationTarget = false,
}: BaseTextElementProps) {
  return (
    <div
      className="base-element-text absolute"
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
        <TextElementFrame elementInfo={elementInfo}>
          <StaticTextContent
            className={`text ProseMirror-static relative ${target === "thumbnail" ? "pointer-events-none" : ""}`}
            content={elementInfo.content}
            isPptxEntranceAnimationTarget={isPptxEntranceAnimationTarget}
            autoFit={elementInfo.autoFit}
            recoverLegacyFixedBoxOverflow={
              Boolean(elementInfo.fixedBox) &&
              !elementInfo.overflowVisible &&
              !elementInfo.autoFit &&
              elementInfo.paddingLeft == null &&
              elementInfo.paddingRight == null &&
              elementInfo.paddingTop == null &&
              elementInfo.paddingBottom == null
            }
            boxWidth={elementInfo.width}
            boxHeight={elementInfo.height}
            paddingLeft={elementInfo.paddingLeft ?? 10}
            paddingRight={elementInfo.paddingRight ?? 10}
            paddingTop={elementInfo.paddingTop ?? 10}
            paddingBottom={elementInfo.paddingBottom ?? 10}
            lineHeight={elementInfo.lineHeight}
            paragraphSpace={elementInfo.paragraphSpace}
          />
        </TextElementFrame>
      </div>
    </div>
  );
}
