"use client";

import type { Slide } from "../../lib/types/slides";
import type { FixedVisualCue } from "../../lib/courseware/load-fixed-build";
import { getRectRotatedRange } from "../../lib/utils/element";
import { buildEvenOddPath } from "../slide-renderer/Editor/spotlightGeometry";

/** Player overlays only; these do not implement Office animations or change slide objects. */
export function FixedVisualEffects({
  slide,
  cues,
}: {
  slide: Slide;
  cues: readonly FixedVisualCue[];
}) {
  const spotlight = cues.findLast((c) => c.effect.kind === "spotlight");
  const targets = (ids: string[]) =>
    slide.elements
      .filter((e) => e.type !== "line")
      .filter((e) => ids.includes(e.id) && e.width > 0 && e.height > 0);
  const effect = spotlight?.effect;
  const spotlightIds =
    effect?.kind === "spotlight"
      ? [effect.targetId, ...(effect.elementIds ?? [])]
      : [];
  const rects = targets(spotlightIds).map((e) => {
    const { xRange, yRange } = getRectRotatedRange({
      ...e,
      rotate: e.rotate ?? 0,
    });
    return {
      x: (xRange[0] / slide.viewportSize) * 100 - 0.4,
      y: (yRange[0] / (slide.viewportSize * slide.viewportRatio)) * 100 - 0.6,
      w: ((xRange[1] - xRange[0]) / slide.viewportSize) * 100 + 0.8,
      h:
        ((yRange[1] - yRange[0]) / (slide.viewportSize * slide.viewportRatio)) *
          100 +
        1.2,
    };
  });
  return (
    <div
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 1000,
        pointerEvents: "none",
      }}
    >
      {rects.length > 0 && effect?.kind === "spotlight" && (
        <svg
          data-fixed-effect="spotlight"
          data-cue-id={spotlight?.id}
          data-target-ids={spotlightIds.join(",")}
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
          }}
        >
          <path
            d={buildEvenOddPath(rects)}
            fill={`rgba(0,0,0,${effect.dimOpacity ?? 0.6})`}
            fillRule="evenodd"
          />
        </svg>
      )}
      {cues.map(
        (cue) =>
          cue.effect.kind === "highlight" &&
          targets(cue.effect.targetIds).map((e) => {
            const effect = cue.effect;
            if (effect.kind !== "highlight") return null;
            const color = effect.color ?? "#f59e0b";
            return (
              <div
                key={`${cue.id}:${e.id}`}
                data-fixed-effect="highlight"
                data-cue-id={cue.id}
                data-target-ids={e.id}
                style={{
                  position: "absolute",
                  left: e.left - 3,
                  top: e.top - 3,
                  width: e.width + 6,
                  height: e.height + 6,
                  transform: `rotate(${e.rotate ?? 0}deg)`,
                  border: `3px solid ${color}`,
                  boxSizing: "border-box",
                  opacity: effect.opacity ?? 0.8,
                  background: effect.style === "fill" ? color : undefined,
                  boxShadow:
                    effect.style === "glow"
                      ? `0 0 18px 6px ${color}`
                      : undefined,
                }}
              />
            );
          }),
      )}
      {cues.flatMap(cue => cue.effect.kind === 'laser' ? targets([cue.effect.targetId]).map(e => <div key={`${cue.id}:${e.id}`}
        data-fixed-effect="laser" data-target-ids={e.id} style={{ position: 'absolute', left: e.left + e.width / 2 - 5,
          top: e.top + e.height / 2 - 5, width: 10, height: 10, borderRadius: '50%',
          background: cue.effect.kind === 'laser' ? cue.effect.color ?? '#ff0000' : undefined, boxShadow: '0 0 12px #f00' }} />) : [])}
    </div>
  );
}
