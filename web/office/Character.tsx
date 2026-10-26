import { useContext, type CSSProperties } from "react";
import type { EffortLevel } from "../../src/shared/types";
import { auraRow } from "../themes/aura";
import { ThemeContext } from "../themes/ThemeContext";

/** 캐릭터 시트 행(계약 SPEC §3, MOTION.md a4b45bc). 순서가 행 번호다. ms = 한 바퀴 시간 */
export const ACTIONS = {
  walk_left: { row: 0, frames: 4, ms: 480 },
  walk_right: { row: 1, frames: 4, ms: 480 },
  sit_down: { row: 2, frames: 3, ms: 300 },
  type: { row: 3, frames: 2, ms: 400 },
  think: { row: 4, frames: 2, ms: 1200 },
  idle: { row: 5, frames: 4, ms: 800 },
  hand_up: { row: 6, frames: 2, ms: 900 },
  coffee: { row: 7, frames: 4, ms: 2800 },
  hand_up_stand: { row: 8, frames: 2, ms: 900 },
  walk_down: { row: 9, frames: 4, ms: 480 },
  walk_up: { row: 10, frames: 4, ms: 480 },
  ride: { row: 11, frames: 2, ms: 1200 },
  ride_lurch: { row: 12, frames: 2, ms: 200 },
} as const;
export type ActionName = keyof typeof ACTIONS;

/** 팀원 모습(목업 motion.js와 같은 셋): 머리 모양 + 안경. 오라 4단계에서 type이면 머리를 금색 판으로(빌드 때 만든 PNG) */
export const LOOKS = [{ hair: "short" }, { hair: "bob", glasses: true }, { hair: "spiky" }] as const;

/** 이름 해시로 고른 모습 번호(다시 그려도 같음). count가 0이면 0 */
export function memberVariant(name: string, count: number): number {
  if (count <= 0) return 0;
  return [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % count;
}

interface Props {
  name: string;
  action: ActionName;
  facing?: "left" | "right";
  effort?: EffortLevel;
  variantIndex: number;
}

/**
 * 캐릭터 하나 = div 하나(§3·§7). 층 시트를 background-image 여러 장으로 겹치고(앞 → 뒤: prop·glasses·hair·hands·outfit·body),
 * 행은 --row, 프레임은 steps(--frames)로 background-position만 옮긴다. 오라(type일 때만)는 바로 뒤 형제 div. 둘 다 장식(aria-hidden)
 */
export function Character({ name, action, facing, effort, variantIndex }: Props) {
  const { theme } = useContext(ThemeContext);
  const look = LOOKS[variantIndex % LOOKS.length] as { hair: string; glasses?: boolean };
  const aura = action === "type" ? auraRow(effort) : 0;
  const hair = `layers/hair-${look.hair}${aura === 4 ? "-gold" : ""}.png`;
  const layers = ["layers/prop.png", look.glasses && "layers/glasses.png", hair, "layers/hands.png", "layers/outfit.png", "layers/body.png"];
  const a = ACTIONS[action];
  const style = {
    "--row": a.row,
    "--frames": a.frames,
    "--ms": `${a.ms}ms`,
    backgroundImage: layers.flatMap((f) => (f && theme.sheets[f] ? [`url(${theme.sheets[f]})`] : [])).join(", "),
  } as CSSProperties;
  return (
    <>
      {aura > 0 && <div className="aura" data-aura={aura} aria-hidden="true" style={{ "--aura": aura, backgroundImage: `url(${theme.sheets["aura.png"]})` } as CSSProperties} />}
      <div className="character" data-name={name} data-action={action} data-facing={facing} aria-hidden="true" style={style} />
    </>
  );
}
