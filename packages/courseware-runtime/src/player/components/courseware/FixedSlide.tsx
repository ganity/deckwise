"use client";

import type { PPTElement, Slide } from "../../lib/types/slides";
import type { EngineMode } from "../../lib/playback/types";
import { SlideViewport } from "../slide-renderer/components/SlideViewport";
import { BaseTextElement } from "../slide-renderer/components/element/TextElement/BaseTextElement";
import { BaseShapeElement } from "../slide-renderer/components/element/ShapeElement/BaseShapeElement";
import { BaseLineElement } from "../slide-renderer/components/element/LineElement/BaseLineElement";
import { BaseTableElement } from "../slide-renderer/components/element/TableElement/BaseTableElement";
import { BaseChartElement } from "../slide-renderer/components/element/ChartElement/BaseChartElement";
import { BaseLatexElement } from "../slide-renderer/components/element/LatexElement/BaseLatexElement";
import { ImageElementVisual } from "../slide-renderer/components/element/ImageElement/ImageElementVisual";
import type { FixedVisualCue } from "../../lib/courseware/load-fixed-build";
import { fixedAnimationStyles } from "../../lib/courseware/fixed-animation-style";
import { FixedVisualEffects } from "./FixedVisualEffects";
import { FixedMediaElement } from "./FixedMediaElement";

function FixedElement({
  element,
  mode,
  ducked,
  onError,
}: {
  element: PPTElement;
  mode: EngineMode;
  ducked: boolean;
  onError: (error: Error) => void;
}) {
  switch (element.type) {
    case "text":
      return <BaseTextElement elementInfo={element} />;
    case "shape":
      return <BaseShapeElement elementInfo={element} />;
    case "line":
      return <BaseLineElement elementInfo={element} />;
    case "table":
      return <BaseTableElement elementInfo={element} />;
    case "chart":
      return <BaseChartElement elementInfo={element} />;
    case "latex":
      return <BaseLatexElement elementInfo={element} />;
    case "audio":
    case "video":
      return (
        <FixedMediaElement
          element={element}
          mode={mode}
          ducked={ducked}
          onError={onError}
        />
      );
    case "image":
      return (
        <div
          style={{
            position: "absolute",
            left: element.left,
            top: element.top,
            width: element.width,
            height: element.height,
            transform: `rotate(${element.rotate}deg)`,
          }}
        >
          <ImageElementVisual elementInfo={element} src={element.src} />
        </div>
      );
  }
}
export function FixedSlide({
  cues,
  animations,
  slide,
  width,
  mode,
  ducked,
  onError,
  nativeTargets,
  nativeVisible,
  nativeGroups,
}: {
  slide: Slide;
  cues: readonly FixedVisualCue[];
  animations: readonly { cue: FixedVisualCue; timeMs: number }[];
  width: number;
  mode: EngineMode;
  ducked: boolean;
  onError: (error: Error) => void;
  nativeTargets?: ReadonlySet<string>;
  nativeVisible?: ReadonlySet<string>;
  nativeGroups?: readonly { elementId: string; children: readonly string[] }[];
}) {
  const styles = fixedAnimationStyles(animations);
  const effectSlide = {
    ...slide,
    elements: slide.elements
      .filter(
        (e) => !styles.get(e.id)?.hidden && styles.get(e.id)?.opacity !== 0,
      )
      .map((e) => {
        const scale = styles.get(e.id)?.scale ?? 1;
        return e.type === "line" || scale === 1
          ? e
          : {
              ...e,
              left: e.left + (e.width * (1 - scale)) / 2,
              top: e.top + (e.height * (1 - scale)) / 2,
              width: e.width * scale,
              height: e.height * scale,
            };
      }),
  };
  const groupById = new Map(nativeGroups?.map(group => [group.elementId, group]));
  const parentById = new Map(nativeGroups?.flatMap(group => group.children.map(id => [id, group.elementId] as const)));
  const rootId = (id: string) => { let parent: string | undefined; while ((parent = parentById.get(id))) id = parent; return id; };
  const orderOf = (id: string): number => {
    const group = groupById.get(id);
    return group ? Math.min(...group.children.map(orderOf)) : slide.elements.findIndex(element => element.id === id);
  };
  const roots = [...new Set(slide.elements.map(element => rootId(element.id)))].sort((a, b) => orderOf(a) - orderOf(b));
  const renderElement = (id: string): import('react').ReactNode => {
    const element = slide.elements.find(element => element.id === id)!;
    const group = groupById.get(id);
    const index = orderOf(id);
    return (
          <div
            key={element.id}
            data-slide-render-element-id={element.id}
            aria-hidden={styles.get(element.id)?.hidden || undefined}
            style={{
              position: "relative",
              zIndex: index + 1,
              opacity: nativeTargets?.has(element.id) && !nativeVisible?.has(element.id) ? 0 : styles.get(element.id)?.opacity,
              visibility: styles.get(element.id)?.hidden ? "hidden" : undefined,
              scale: styles.get(element.id)?.scale,
              translate: styles.get(element.id)?.translateX ? `${styles.get(element.id)!.translateX}% 0` : undefined,
              rotate: styles.get(element.id)?.rotate ? `${styles.get(element.id)!.rotate}deg` : undefined,
              transformOrigin:
                element.type === "line"
                  ? undefined
                  : `${element.left + element.width / 2}px ${element.top + element.height / 2}px`,
            }}
          >
            {group ? [...group.children].sort((a, b) => orderOf(a) - orderOf(b)).map(renderElement) : <FixedElement
              element={element}
              mode={mode}
              ducked={ducked}
              onError={onError}
            />}
          </div>
);
  };
  return (
    <div
      style={{
        position: "relative",
        width,
        height: width * slide.viewportRatio,
      }}
      onErrorCapture={(event) => {
        // Native media errors belong to the source effect's lifetime.
        if (!(event.target instanceof HTMLMediaElement))
          onError(new Error("Slide resource failed to load. Retry this page."));
      }}
    >
      <SlideViewport
        slide={slide}
        scale={width / slide.viewportSize}
        mode="preview"
      >
        {roots.map(renderElement)}
        <FixedVisualEffects slide={effectSlide} cues={cues} />
      </SlideViewport>
    </div>
  );
}
