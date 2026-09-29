import type { Rect } from "./sprites";

export function PixelSprite({ rects, x = 0, y = 0, className }: { rects: Rect[]; x?: number; y?: number; className?: string }) {
  return (
    <g transform={`translate(${x},${y})`} className={className}>
      {rects.map((r, i) => (
        <rect key={i} x={r.x} y={r.y} width={1} height={1} fill={r.c} />
      ))}
    </g>
  );
}
