import { ICONS, spriteRects, type IconName } from "./sprites";

/** 7×7 도트 아이콘을 14×14로 그린다. 뜻은 옆 글자나 버튼의 aria-label로 전한다(디자인 4.5) */
export function Icon({ name, ink = "currentColor", accent }: { name: IconName; ink?: string; accent?: string }) {
  return (
    <svg className="px icon" viewBox="0 0 7 7" width={14} height={14} shapeRendering="crispEdges" aria-hidden="true">
      {spriteRects(ICONS[name], { x: ink, a: accent ?? ink }).map((r, i) => (
        <rect key={i} x={r.x} y={r.y} width={1} height={1} fill={r.c} />
      ))}
    </svg>
  );
}
