import type { MemberState } from "../src/shared/types";

export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return "--";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** claude-opus-5-5 → "Opus 5.5", claude-haiku-4-5-20251001 → "Haiku 4.5", opus → "Opus". 모르는 모양은 그대로 */
export function modelLabel(raw: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(raw);
  const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
  if (m) return `${cap(m[1])} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
  return /^[a-z]+$/.test(raw) ? cap(raw) : raw;
}

export function remainingPct(used: number, budget: number): number {
  if (!(budget > 0) || !Number.isFinite(used)) return 0;
  return Math.max(0, Math.min(100, 100 - (used / budget) * 100));
}

const LABELS: Record<MemberState, string> = { decision: "결정 필요", working: "작업 중", idle: "대기", mail: "메시지 수신", offline: "종료" };

export function stateLabel(s: MemberState): string {
  return LABELS[s];
}
