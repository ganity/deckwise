"use client";

import { forwardRef, useEffect, useMemo, useState } from "react";
import {
  COURSEWARE_DEFAULT_FONT,
  createCoursewareFontSample,
  ensureCoursewareFontsLoaded,
} from "../../../lib/courseware-fonts";
import { getSlideViewportMetrics } from "../../../lib/utils/geometry";
import type { Slide } from "../../../lib/types/slides";
import { ViewportBackground } from "../Editor/Canvas/ViewportBackground";

export interface SlideViewportProps {
  readonly slide: Slide;
  readonly scale: number;
  readonly mode: "edit" | "preview" | "thumbnail";
  readonly children: React.ReactNode;
  readonly className?: string;
  readonly style?: React.CSSProperties;
  readonly sceneId?: string;
}

export const SlideViewport = forwardRef<HTMLDivElement, SlideViewportProps>(
  ({ slide, scale, mode, children, className, style, sceneId }, ref) => {
    const { width, height } = getSlideViewportMetrics(slide);
    const [fontsReady, setFontsReady] = useState(false);
    const [layoutRevision, setLayoutRevision] = useState(0);
    const fontSample = useMemo(
      () => createCoursewareFontSample(slide),
      [slide],
    );

    useEffect(() => {
      let cancelled = false;
      void ensureCoursewareFontsLoaded(fontSample)
        .then(() => {
          if (!cancelled) setFontsReady(true);
        })
        .catch((error: unknown) => {
          console.error("Courseware fonts failed to load", error);
        });
      return () => {
        cancelled = true;
      };
    }, [fontSample]);

    useEffect(() => {
      if (!fontsReady) return;

      let firstFrame = 0;
      let secondFrame = 0;
      firstFrame = window.requestAnimationFrame(() => {
        firstFrame = 0;
        secondFrame = window.requestAnimationFrame(() => {
          secondFrame = 0;
          setLayoutRevision((revision) => revision + 1);
        });
      });

      return () => {
        window.cancelAnimationFrame(firstFrame);
        window.cancelAnimationFrame(secondFrame);
      };
    }, [fontsReady, height, mode, scale, width]);

    return (
      <div
        ref={ref}
        className={`slide-viewport relative overflow-hidden origin-top-left ${className ?? ""}`}
        data-slide-viewport
        data-scene-id={sceneId}
        data-slide-viewport-mode={mode}
        data-courseware-fonts-ready={fontsReady ? "true" : "false"}
        data-slide-layout-ready={
          fontsReady && layoutRevision > 0 ? "true" : "false"
        }
        data-slide-layout-revision={layoutRevision}
        style={{
          width: `${width}px`,
          height: `${height}px`,
          transform: `scale(${scale})`,
          ...style,
          fontFamily: COURSEWARE_DEFAULT_FONT,
        }}
      >
        {fontsReady ? (
          <>
            <ViewportBackground background={slide.background} />
            {children}
          </>
        ) : null}
      </div>
    );
  },
);

SlideViewport.displayName = "SlideViewport";
