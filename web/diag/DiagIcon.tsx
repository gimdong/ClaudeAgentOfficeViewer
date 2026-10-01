import { spriteRects } from "../pixel/sprites";

// 진단 아이콘 (7×7, 디자인 9장). Phase 1 ICONS와 같은 형식이고 같은 방식으로 그린다.
// Phase 1 ICONS 목록(아이콘 수를 고정해 검사함)에 섞지 않고 여기 둔다
export const DIAG_ICONS = {
  diag: [".......", "..x....", "..x....", "..xx...", "xx.x.xx", "...xx..", "....x.."],
  ok: [".......", "......x", ".....x.", "x...x..", ".x.x...", "..x....", "......."],
  warn: ["...x...", "..xxx..", "..x.x..", ".xx.xx.", ".xxxxx.", "xxx.xxx", "xxxxxxx"],
  fail: ["xxxxxxx", "x.xxx.x", "xx.x.xx", "xxx.xxx", "xx.x.xx", "x.xxx.x", "xxxxxxx"],
  reload: ["..xxxx.", ".x....x", "x......", "x....xx", "x....x.", ".x...x.", "..xxx.."],
  down: ["...x...", "...x...", "...x...", "x..x..x", ".x.x.x.", "..xxx..", "xxxxxxx"],
} satisfies Record<string, string[]>;

export type DiagIconName = keyof typeof DIAG_ICONS;

export function DiagIcon({ name, ink = "currentColor", className = "" }: { name: DiagIconName; ink?: string; className?: string }) {
  return (
    <svg className={`px icon ${className}`.trim()} viewBox="0 0 7 7" width={14} height={14} shapeRendering="crispEdges" aria-hidden="true">
      {spriteRects(DIAG_ICONS[name], { x: ink }).map((r, i) => (
        <rect key={i} x={r.x} y={r.y} width={1} height={1} fill={r.c} />
      ))}
    </svg>
  );
}
