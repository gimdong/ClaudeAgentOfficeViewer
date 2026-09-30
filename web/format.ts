import type { MemberState } from "../src/shared/types";

export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return "--";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function remainingPct(used: number, budget: number): number {
  if (!(budget > 0) || !Number.isFinite(used)) return 0;
  return Math.max(0, Math.min(100, 100 - (used / budget) * 100));
}

const LABELS: Record<MemberState, string> = { working: "작업 중", idle: "대기", mail: "메시지 수신", offline: "종료" };

export function stateLabel(s: MemberState): string {
  return LABELS[s];
}
