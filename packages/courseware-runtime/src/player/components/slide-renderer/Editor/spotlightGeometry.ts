export interface SpotlightRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function mergeSpotlightRects(rects: SpotlightRect[]): SpotlightRect[] {
  const merged: SpotlightRect[] = [];

  for (const rect of rects) {
    let next = rect;
    let mergedExisting = true;

    while (mergedExisting) {
      mergedExisting = false;
      for (let index = 0; index < merged.length; index += 1) {
        const current = merged[index];
        if (!rectsOverlapOrTouch(current, next)) continue;

        next = unionRects(current, next);
        merged.splice(index, 1);
        mergedExisting = true;
        break;
      }
    }

    merged.push(next);
  }

  return merged;
}

export function buildEvenOddPath(rects: SpotlightRect[]): string {
  const outer = 'M 0 0 H 100 V 100 H 0 Z';
  const holes = mergeSpotlightRects(rects)
    .map((rect) => {
      const right = rect.x + rect.w;
      const bottom = rect.y + rect.h;
      return `M ${rect.x} ${rect.y} H ${right} V ${bottom} H ${rect.x} Z`;
    })
    .join(' ');

  return `${outer} ${holes}`;
}

function rectsOverlapOrTouch(a: SpotlightRect, b: SpotlightRect): boolean {
  return a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;
}

function unionRects(a: SpotlightRect, b: SpotlightRect): SpotlightRect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.w, b.x + b.w);
  const bottom = Math.max(a.y + a.h, b.y + b.h);

  return {
    x,
    y,
    w: right - x,
    h: bottom - y,
  };
}
