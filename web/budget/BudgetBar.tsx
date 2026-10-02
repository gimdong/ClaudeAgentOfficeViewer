import { forwardRef } from "react";
import type { BudgetView } from "../../src/shared/types";
import { barLevel } from "../hud/HeartBar";
import { NEON } from "../pixel/palette";
import { Icon } from "../pixel/Icon";
import { ICONS, spriteRects } from "../pixel/sprites";
import { usageLabel } from "../report/text";

/** 꺼진 경광등의 등 색(phase2 §0 --pink-dim) */
const PINK_DIM = "#7a2a50";

function Dots({ rows, colors, className }: { rows: string[]; colors: Record<string, string>; className?: string }) {
  return (
    <g className={className}>
      {spriteRects(rows, colors).map((r, i) => (
        <rect key={i} x={r.x} y={r.y} width={1} height={1} fill={r.c} />
      ))}
    </g>
  );
}

/** 경광등(§7): 켜짐·꺼짐 두 프레임을 0.5초마다 번갈아 보인다. 움직임 줄이기면 켜짐에 멈춘다(CSS) */
export function Siren() {
  return (
    <svg className="siren" viewBox="0 0 7 7" width={14} height={14} shapeRendering="crispEdges" aria-hidden="true">
      <Dots rows={ICONS.siren} colors={{ x: NEON.pink, a: NEON.ink, b: NEON.desk }} className="siren-on" />
      <Dots rows={ICONS.siren} colors={{ x: PINK_DIM, a: PINK_DIM, b: NEON.desk }} className="siren-off" />
    </svg>
  );
}

/** 남은 양 %(§6.1): (nextGateAt − 사용량) / 예산 × 100을 0–100으로 자르고 반올림 */
export function budgetRemaining(b: BudgetView): number {
  if (b.reached) return 0;
  return Math.round(Math.min(100, Math.max(0, ((b.nextGateAt - b.usedTokens) / b.budgetTokens) * 100)));
}

/** 층 머리의 예산 자리(§6.1): Phase 1 미니 바 모양 + 설정 버튼 */
export const BudgetBar = forwardRef<HTMLButtonElement, { budget?: BudgetView; floorName: string; onOpenSettings(): void }>(function BudgetBar(
  { budget, floorName, onOpenSettings },
  ref,
) {
  let bar;
  if (!budget) {
    bar = (
      <span className="mini none">
        예산 <span className="val">없음</span>
      </span>
    );
  } else {
    const v = budgetRemaining(budget);
    const level = barLevel(v);
    bar = (
      <span
        className={`mini${level === "ok" ? "" : ` ${level}`}`}
        role="meter"
        aria-label="예산 남은 양"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={v}
        aria-valuetext={`남은 양 ${v}%, ${usageLabel(budget.usedTokens)} 사용`}
        title={`${budget.usedTokens.toLocaleString("en-US")} / ${budget.nextGateAt.toLocaleString("en-US")} 토큰`}
      >
        예산
        <span className="track">
          <span className="fill" style={{ width: `${v}%` }} />
        </span>
        <span className="val">{v}%</span>
      </span>
    );
  }
  return (
    <span className="budget">
      {bar}
      <button ref={ref} type="button" className="budget-set" aria-label={`${floorName} 예산 설정`} aria-haspopup="dialog" onClick={onOpenSettings}>
        <Icon name="settings" />
      </button>
    </span>
  );
});
