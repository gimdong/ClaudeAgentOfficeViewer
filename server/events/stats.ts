import { getLogger } from "../log";

export type Rejected = "403" | "415" | "413" | "400";
export interface HookStatsView { total: number; byEvent: Record<string, number>; lastAt: string | null; rejected: Record<Rejected, number>; last10min: number }

const TEN_MIN = 10 * 60_000;

/** hook 수신 통계(스펙 5장 4번). 메모리에만 두고, 요약은 summarize()가 바뀌었을 때만 로그에 남긴다. */
export class HookStats {
  private byEvent: Record<string, number> = {};
  private rejected: Record<Rejected, number> = { "403": 0, "415": 0, "413": 0, "400": 0 };
  private times: number[] = []; // 최근 10분 수신 시각
  private total = 0;
  private lastAt: number | null = null;
  private lastSummary = "";

  constructor(private readonly now: () => number = Date.now) {}

  accept(eventName: string): void {
    const t = this.now();
    this.byEvent[eventName] = (this.byEvent[eventName] ?? 0) + 1;
    this.total++;
    this.lastAt = t;
    this.times.push(t);
    while (this.times.length && this.times[0] < t - TEN_MIN) this.times.shift();
  }

  reject(kind: Rejected): void {
    this.rejected[kind]++;
  }

  view(): HookStatsView {
    const since = this.now() - TEN_MIN;
    return {
      total: this.total,
      byEvent: { ...this.byEvent },
      lastAt: this.lastAt === null ? null : new Date(this.lastAt).toISOString(),
      rejected: { ...this.rejected },
      last10min: this.times.filter((t) => t >= since).length,
    };
  }

  summarize(): void {
    const v = this.view();
    const key = JSON.stringify([v.total, v.rejected]);
    if (key === this.lastSummary) return;
    this.lastSummary = key;
    getLogger().info("hooks", "summary", { ...v });
  }
}
