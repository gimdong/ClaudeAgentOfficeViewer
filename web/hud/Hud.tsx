import type { Snapshot } from "../../src/shared/types";
import { formatTokens, remainingPct } from "../format";
import { HeartBar } from "./HeartBar";
import { TokenCounter } from "./TokenCounter";

export function Hud({ snapshot, live }: { snapshot: Snapshot; live: boolean }) {
  const { usage, budget, limits } = snapshot;
  const five = budget.fiveHour ? remainingPct(usage.last5h.total, budget.fiveHour) : null;
  const week = budget.weekly ? remainingPct(usage.last7d.total, budget.weekly) : null;
  const planUsed = limits?.fiveHourPct ?? limits?.weeklyPct;
  const plan = planUsed === undefined ? null : 100 - planUsed;
  const planHint = limits?.fiveHourPct !== undefined ? "5H" : limits?.weeklyPct !== undefined ? "WEEK" : undefined;

  return (
    <header className="hud">
      <TokenCounter label="TODAY" value={usage.today.total} sub={`캐시 읽기 ${formatTokens(usage.today.cacheRead)}`} />
      <TokenCounter label="5H" value={usage.last5h.total} hint="추정" />
      <TokenCounter label="WEEK" value={usage.last7d.total} hint="추정" />
      <HeartBar label="5H" remaining={five} emptyText="-- 설정 필요" />
      <HeartBar label="WEEK" remaining={week} emptyText="-- 설정 필요" />
      <HeartBar label="PLAN" remaining={plan} emptyText="-- 데이터 없음" hint={planHint} />
      <span className={`live ${live ? "on" : "off"}`}>{live ? "● LIVE" : "○ 재연결 중"}</span>
    </header>
  );
}
