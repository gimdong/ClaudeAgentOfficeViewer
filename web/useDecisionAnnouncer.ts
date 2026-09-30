import { useEffect, useRef, useState } from "react";
import type { Snapshot } from "../src/shared/types";

/**
 * 새 결정이 생기면 스크린 리더에 한 번 알릴 문장(디자인 11장 HUD 결정 칩).
 * 같은 사람이 같은 층에서 다시 결정을 기다리면 문장이 이전과 똑같을 수 있다 — setState(같은 문자열)은
 * React가 변경으로 안 보므로 role=status 텍스트가 안 바뀐다(Ruling P16). n을 새 결정마다 올려서
 * 호출 쪽(App)이 key={n}으로 상태 요소를 다시 마운트하게 한다.
 */
export function useDecisionAnnouncer(snapshot: Snapshot | null): { text: string; n: number } {
  const seen = useRef<Set<string> | null>(null);
  const [state, setState] = useState({ text: "", n: 0 });
  useEffect(() => {
    if (!snapshot) return;
    const now = new Map<string, string>();
    for (const s of snapshot.sessions)
      for (const m of s.members) if (m.state === "decision" && m.decision) now.set(`${s.id}:${m.name}:${m.decision.since}`, `${s.floor}F ${m.name}이(가) 결정을 기다립니다`);
    const prev = seen.current;
    seen.current = new Set(now.keys());
    if (!prev) return; // 첫 스냅샷은 알리지 않는다(이미 있던 결정)
    const fresh = [...now].find(([k]) => !prev.has(k));
    if (fresh) setState((s) => ({ text: fresh[1], n: s.n + 1 }));
  }, [snapshot]);
  return state;
}
