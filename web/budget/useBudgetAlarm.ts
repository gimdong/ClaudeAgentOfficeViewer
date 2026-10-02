import { useEffect, useRef } from "react";
import type { Snapshot } from "../../src/shared/types";

/**
 * 층이 예산에 닿는 순간 한 번 알린다(디자인 phase2 §7·§9.5, 계획 Task 10). (sessionId, nextGateAt)마다 한 번이고,
 * 첫 스냅샷에 이미 닿아 있던 층은 알리지 않는다. 화면 알림은 App의 status로, 브라우저 알림은 권한이 granted일 때만. 소리는 없다
 */
export function useBudgetAlarm(snapshot: Snapshot | null, announce?: (text: string) => void): void {
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!snapshot) return;
    const reached = snapshot.sessions.filter((s) => s.budget?.reached).map((s) => ({ key: `${s.id}:${s.budget!.nextGateAt}`, name: s.name }));
    if (!seen.current) {
      seen.current = new Set(reached.map((r) => r.key));
      return;
    }
    for (const r of reached) {
      if (seen.current.has(r.key)) continue;
      seen.current.add(r.key);
      announce?.(`${r.name} 층이 예산에 도달했습니다`);
      const N = (globalThis as { Notification?: { permission?: string; new (title: string, o?: { body?: string }): unknown } }).Notification;
      if (N?.permission === "granted") {
        try {
          new N("예산에 도달했습니다", { body: `${r.name} — 계속할지 정해 주세요` });
        } catch {
          /* 알림을 만들 수 없는 환경(일부 모바일)은 경광등만 */
        }
      }
    }
  }, [snapshot, announce]);
}
