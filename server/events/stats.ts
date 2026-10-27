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

/** Notification의 notification_type 중 이름을 아는 것. 이 밖은 짧은 [a-z_]만, 칸 수 상한 안에서 받는다(위조 hook 입력 대비) */
const KNOWN_NOTIFICATIONS: ReadonlySet<string> = new Set(["permission_prompt", "worker_permission_prompt", "idle_prompt", "auth_success", "elicitation_dialog"]);
const NOTIFICATION_NAME = /^[a-z_]{1,40}$/;
const MAX_NOTIFICATION_KEYS = 20;

/** hook 수신 통계(스펙 5장 4번). 메모리에만 두고, 요약은 summarize()가 바뀌었을 때만 로그에 남긴다. */
export class HookStats {
  private byEvent: Record<string, number> = {};
  // 종류 이름과 수만. 본문(message)·경로는 받지 않는다
  private byNotification = new Map<string, number>();
  // 403-uid: 같은 계정 검사(Phase 5 §2)가 막은 접속. 모든 경로에서 센다
  // 401-v2: 암호화 입구(/hooks/v2, Phase 6a §4)가 거절한 요청(형식·kid·복호화·ts·재전송 모두)
  private rejected: Record<Rejected, number> = { "403": 0, "415": 0, "413": 0, "400": 0, "403-uid": 0, "401-v2": 0 };
  private v2 = 0; // /hooks/v2로 받은 수
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

  /** Notification의 notification_type 수. /hooks/v2로 온 것만 부른다(B344와 같은 원칙, Ruling D-3) — 옛 입구 위조로 "받은 적 있음"이 보이지 않게 */
  acceptNotification(n: unknown): void {
    // 화면·번들에서 객체 키가 되므로 __proto__·constructor 같은 이름은 받지 않는다
    const named =
      typeof n === "string" && NOTIFICATION_NAME.test(n) && !(n in {}) &&
      (KNOWN_NOTIFICATIONS.has(n) || this.byNotification.has(n) || this.byNotification.size < MAX_NOTIFICATION_KEYS);
    const kind = named ? n : "other";
    this.byNotification.set(kind, (this.byNotification.get(kind) ?? 0) + 1);
  }

  acceptV2(): void {
    this.v2++;
  }

  reject(kind: Rejected): void {
    this.rejected[kind]++;
  }

  view(): HookStatsView {
    const since = this.now() - TEN_MIN;
    return {
      total: this.total,
      byEvent: { ...this.byEvent },
      byNotification: Object.fromEntries(this.byNotification),
      lastAt: this.lastAt === null ? null : new Date(this.lastAt).toISOString(),
      rejected: { ...this.rejected },
      v2: this.v2,
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
