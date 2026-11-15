import type { GradientColor, GradientType } from "../../../../../lib/types/slides";

interface GradientDefsProps {
  id: string;
  type: GradientType;
  colors: GradientColor[];
  rotate?: number;
}

export function GradientDefs({
  id,
  type,
  colors,
  rotate = 0,
}: GradientDefsProps) {
  // Office can serialize gradient stops in reverse order. SVG clamps a later
  // smaller offset to the previous stop, turning a broad gradient into a solid fill.
  const orderedColors = colors
    .map((color, index) => ({ color, index }))
    .sort((a, b) => a.color.pos - b.color.pos || a.index - b.index)
    .map(({ color }) => color);
  if (type === "linear") {
    return (
      <linearGradient
        id={id}
        x1="0%"
        y1="0%"
        x2="100%"
        y2="0%"
        gradientTransform={`rotate(${rotate},0.5,0.5)`}
      >
        {orderedColors.map((item, index) => (
          <stop key={index} offset={`${item.pos}%`} stopColor={item.color} />
        ))}
      </linearGradient>
    );
  }

  return (
    <radialGradient id={id}>
      {orderedColors.map((item, index) => (
        <stop key={index} offset={`${item.pos}%`} stopColor={item.color} />
      ))}
    </radialGradient>
  );
}
