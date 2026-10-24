"use client";

import { useEffect, useRef } from "react";
import type { PPTAudioElement, PPTVideoElement } from "../../lib/types/slides";
import { bindMediaTrim } from "../../lib/utils/media-trim";
import { bindMediaDucking } from "../../lib/utils/media-ducking";
import type { EngineMode } from "../../lib/playback/types";

/** Fixed media has no task, settings or editor store. Native controls own click behaviour. */
export function FixedMediaElement({
  element,
  mode,
  ducked,
  onError,
}: {
  element: PPTAudioElement | PPTVideoElement;
  mode: EngineMode;
  ducked: boolean;
  onError: (error: Error) => void;
}) {
  const ref = useRef<HTMLMediaElement | null>(null);
  const resume = useRef(false);
  const errorHandler = useRef(onError);
  errorHandler.current = onError;
  useEffect(() => {
    const media = ref.current;
    if (!media) return;
    let active = true;
    // Effect replay reuses the node after cleanup has released its source.
    media.src = element.src;
    const failed = () => {
      if (active && media.getAttribute("src") === element.src)
        errorHandler.current(new Error(`Media failed to load: ${element.id}`));
    };
    media.addEventListener("error", failed);
    const cleanup = bindMediaTrim(
      media,
      element.type === "audio" ? element : {},
    );
    return () => {
      active = false;
      media.removeEventListener("error", failed);
      cleanup();
      media.pause();
      media.removeAttribute("src");
      media.load();
    };
  }, [element]);
  useEffect(() => {
    const media = ref.current;
    if (!media) return;
    let active = true;
    if (mode === "paused") {
      resume.current = !media.paused;
      media.pause();
    } else if (mode === "playing" && resume.current) {
      resume.current = false;
      void media.play().catch((error) => {
        if (active) onError(error);
      });
    }
    return () => {
      active = false;
    };
  }, [mode, onError, element]);
  useEffect(() => {
    if (ducked && ref.current) return bindMediaDucking(ref.current);
  }, [ducked]);
  const props = {
    src: element.src,
    controls: true,
    preload: "metadata",
    loop: element.type === "audio" ? element.loop : false,
    style: { width: "100%", height: "100%", objectFit: "contain" as const },
    onPlay: () => {
      if (mode === "paused") ref.current?.pause();
    },
  };
  return (
    <div
      data-media-element
      style={{
        position: "absolute",
        left: element.left,
        top: element.top,
        width: element.width,
        height: element.height,
        transform: `rotate(${element.rotate}deg)`,
      }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {element.type === "video" ? (
        <video
          {...props}
          poster={element.poster}
          ref={(node) => {
            ref.current = node;
          }}
        />
      ) : (
        <audio
          {...props}
          ref={(node) => {
            ref.current = node;
          }}
        />
      )}
    </div>
  );
}
