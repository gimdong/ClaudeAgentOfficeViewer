import { NEON } from "../pixel/palette";

/** 방 왼쪽 창문(88×64, viewBox 22×16, 디자인 5.1) */
export function Backdrop() {
  return (
    <svg className="px backdrop" viewBox="0 0 22 16" shapeRendering="crispEdges" aria-hidden="true">
      <rect x={0} y={0} width={22} height={16} fill={NEON.desk} />
      <rect x={1} y={1} width={20} height={14} fill="#0b0a1a" />
      <rect x={11} y={1} width={1} height={14} fill={NEON.desk} />
      <rect x={2} y={9} width={3} height={6} fill="#241f40" />
      <rect x={6} y={6} width={4} height={9} fill="#241f40" />
      <rect x={13} y={8} width={3} height={7} fill="#241f40" />
      <rect x={17} y={4} width={3} height={11} fill="#241f40" />
      <rect x={3} y={10} width={1} height={1} fill={NEON.yellow} />
      <rect x={7} y={8} width={1} height={1} fill={NEON.cyan} />
      <rect x={8} y={11} width={1} height={1} fill={NEON.yellow} />
      <rect x={18} y={6} width={1} height={1} fill={NEON.pink} />
      <rect x={14} y={10} width={1} height={1} fill={NEON.yellow} />
    </svg>
  );
}
