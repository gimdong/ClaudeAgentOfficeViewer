import { useEffect, useRef, useState } from "react";
import type { Snapshot } from "../src/shared/types";

/** 새 결정이 생기면 스크린 리더에 한 번 알릴 문장(디자인 11장 HUD 결정 칩) */
export function useDecisionAnnouncer(snapshot: Snapshot | null): string {
  const seen = useRef<Set<string> | null>(null);
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (!snapshot) return;
    const now = new Map<string, string>();
    for (const s of snapshot.sessions)
      for (const m of s.members) if (m.state === "decision" && m.decision) now.set(`${s.id}:${m.name}:${m.decision.since}`, `${s.floor}F ${m.name}이(가) 결정을 기다립니다`);
    const prev = seen.current;
    seen.current = new Set(now.keys());
    if (!prev) return; // 첫 스냅샷은 알리지 않는다(이미 있던 결정)
    const fresh = [...now].find(([k]) => !prev.has(k));
    if (fresh) setMessage(fresh[1]);
  }, [snapshot]);
  return message;
}
