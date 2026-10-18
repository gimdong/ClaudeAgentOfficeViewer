import { getLogger } from "../log";

import type { HookStatsView } from "../../src/shared/types";

export type Rejected = keyof HookStatsView["rejected"];
export type { HookStatsView }; // 화면과 같이 쓰도록 src/shared/types.ts로 옮겼다

const TEN_MIN = 10 * 60_000;
/** plugins/claude-office/hooks/hooks.json이 보내는 이벤트. 나머지는 "other" 한 칸에 센다(키가 무한히 늘지 않게) */
export const KNOWN_EVENTS: ReadonlySet<string> = new Set([
  "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
  "PermissionRequest", "PermissionDenied", "Notification", "SubagentStart", "SubagentStop", "TeammateIdle", "Stop",
]);

/** hook 수신 통계(스펙 5장 4번). 메모리에만 두고, 요약은 summarize()가 바뀌었을 때만 로그에 남긴다. */
export class HookStats {
  private byEvent: Record<string, number> = {};
  // 403-uid: 같은 계정 검사(Phase 5 §2)가 막은 접속. 모든 경로에서 센다
  private rejected: Record<Rejected, number> = { "403": 0, "415": 0, "413": 0, "400": 0, "403-uid": 0 };
  private times: number[] = []; // 최근 10분 수신 시각
  private total = 0;
  private lastAt: number | null = null;
  private lastSummary = "";

  constructor(private readonly now: () => number = Date.now) {}

  accept(eventName: string): void {
    const t = this.now();
    const key = KNOWN_EVENTS.has(eventName) ? eventName : "other";
    this.byEvent[key] = (this.byEvent[key] ?? 0) + 1;
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
