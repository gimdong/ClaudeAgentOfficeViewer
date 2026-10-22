import type { Snapshot } from "../../src/shared/types";
import { remainingPct } from "../format";

/** HUD 하트 바의 빈 글(디자인 phase6b §11.4). 빌딩 정보 창도 같은 글을 쓴다 */
export const BAR_EMPTY = { needSetup: "-- 설정 필요", planNone: "-- 요금제가 알려 주지 않음", planOff: "-- statusline 연결이 꺼져 있음(다시 설치할 때 켤 수 있음)", planUnsupported: "-- Windows에서는 statusline 연결을 지원하지 않음" } as const;
/** PLAN 바가 빌 때의 글(W33, 스펙 12장 j·B331·B332): 연결됐는데 값 없음 / Windows는 지원하지 않음 / 그 밖(꺼짐·상태를 모르는 옛 서버)은 꺼져 있음 */
export const planEmptyText = (snapshot: Pick<Snapshot, "statusline">) => (snapshot.statusline === "on" ? BAR_EMPTY.planNone : snapshot.statusline === "unsupported" ? BAR_EMPTY.planUnsupported : BAR_EMPTY.planOff);

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
