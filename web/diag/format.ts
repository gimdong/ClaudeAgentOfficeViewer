import type { DoctorItem, DoctorStatus, HookStatsView } from "../../src/shared/types";

const RANK: Record<DoctorStatus, number> = { fail: 0, warn: 1, ok: 2 };

/** fail → warn → ok, 같은 상태끼리는 doctor 순서 그대로(디자인 가정 D5) */
export const sortItems = (items: DoctorItem[]): DoctorItem[] =>
  items.map((x, i) => ({ x, i })).sort((a, b) => RANK[a.x.status] - RANK[b.x.status] || a.i - b.i).map(({ x }) => x);

export function verdict(items: DoctorItem[]): { status: DoctorStatus; text: string } {
  const f = items.filter((x) => x.status === "fail").length;
  const w = items.filter((x) => x.status === "warn").length;
  if (f) return { status: "fail", text: `문제 ${f}개를 찾았습니다` };
  if (w) return { status: "warn", text: `확인할 항목이 ${w}개 있습니다` };
  return { status: "ok", text: "모두 정상입니다" };
}

/** 60초 미만 방금, 60분 미만 N분 전, 그 이상 N시간 전(내림, Phase 1 경과 시간과 같은 규칙) */
function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  return s < 60 ? "방금" : s < 3600 ? `${Math.floor(s / 60)}분 전` : `${Math.floor(s / 3600)}시간 전`;
}

/** 디자인 5장: 최근 10분 {N}건, 마지막 수신 {ago|없음}, 거부 {N}건 */
export function hookLine(h: HookStatsView, now = Date.now()): string {
  const rejected = Object.values(h.rejected).reduce((a, b) => a + b, 0);
  return `최근 10분 ${h.last10min}건, ${h.lastAt ? `마지막 수신 ${ago(h.lastAt, now)}` : "마지막 수신 없음"}, 거부 ${rejected}건`;
}

const pad = (n: number) => String(n).padStart(2, "0");
export const hhmm = (ms: number) => `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`;
