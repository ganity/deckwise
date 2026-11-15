import { useEffect, useRef, useState } from 'react';
import type { Slide } from '../../lib/types/slides';
import { FixedSlide } from './FixedSlide';

/** The playback slide renderer, sized to its authoring preview container. */
export function MaicSlidePreview({ canvas }: { canvas: Slide }) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  return <div ref={container} style={{ width: '100%', aspectRatio: String(1 / canvas.viewportRatio) }}>
    {width > 0 && <FixedSlide slide={canvas} width={width} mode="idle" cues={[]} animations={[]}
      ducked={false} onError={() => {}} />}
  </div>;
}
