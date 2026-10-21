import type { Snapshot } from "../../src/shared/types";
import { remainingPct } from "../format";

/** HUD 하트 바의 빈 글(디자인 phase6b §11.4). 빌딩 정보 창도 같은 글을 쓴다 */
export const BAR_EMPTY = { needSetup: "-- 설정 필요", planNone: "-- 요금제가 알려 주지 않음" } as const;

/**
 * 5H·WEEK(예산 대비)·PLAN(statusline 한도) 잔여 %. HUD와 빌딩 정보 창이 같은 값을 보이도록 한 곳에서 센다.
 * PLAN은 "더 급한"(더 많이 쓴) 창을 보여 준다. 두 값이 같으면 5H를 먼저 넣어 두는 것만으로 5H가 이긴다(엄격한 >)
 */
export function remainingOf(snapshot: Pick<Snapshot, "usage" | "budget" | "limits">): { five: number | null; week: number | null; plan: number | null; planHint?: "5H" | "WEEK" | "SPEND" } {
  const { usage, budget, limits } = snapshot;
  const five = budget.fiveHour ? remainingPct(usage.last5h.total, budget.fiveHour) : null;
  const week = budget.weekly ? remainingPct(usage.last7d.total, budget.weekly) : null;
  const c: Array<{ pct: number; hint: "5H" | "WEEK" | "SPEND" }> = [];
  if (limits?.fiveHourPct !== undefined) c.push({ pct: limits.fiveHourPct, hint: "5H" });
  if (limits?.weeklyPct !== undefined) c.push({ pct: limits.weeklyPct, hint: "WEEK" });
  if (limits?.spendPct !== undefined) c.push({ pct: limits.spendPct, hint: "SPEND" });
  const worst = c.reduce<(typeof c)[number] | undefined>((acc, x) => (!acc || x.pct > acc.pct ? x : acc), undefined);
  return { five, week, plan: worst ? 100 - worst.pct : null, ...(worst ? { planHint: worst.hint } : {}) };
}
