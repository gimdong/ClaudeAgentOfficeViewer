import { useEffect, useState } from "react";
import { nextChange, planPantry, type PantryMember, type PantryState } from "./pantryPlan";

/**
 * 한 층의 탕비실 걷기 상태(Phase 7 Task 6). 팀원·움직임 줄이기가 바뀌면 바로, 그 밖에는 다음 바뀔 시각(도착·30초 됨)에 한 번 다시 계획한다.
 * 시계는 Date.now·setTimeout만 써서 가짜 타이머로 시험할 수 있다
 */
export function usePantry(members: PantryMember[], reduced: boolean): PantryState {
  const [state, setState] = useState<PantryState>(() => planPantry({}, members, Date.now(), reduced));
  useEffect(() => {
    const now = Date.now();
    const planned = planPantry(state, members, now, reduced);
    if (planned !== state) return setState(planned);
    const at = nextChange(state, members, now);
    if (at === Infinity) return;
    const t = setTimeout(() => setState((p) => planPantry(p, members, Date.now(), reduced)), at - now);
    return () => clearTimeout(t);
  }, [state, members, reduced]);
  return state;
}

const QUERY = "(prefers-reduced-motion: reduce)";
const reducedNow = () => typeof matchMedia === "function" && matchMedia(QUERY).matches;

/** 움직임 줄이기 설정. 바뀌면 바로 따라간다(useVariant와 같은 방식, P7a-14 ②) */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(reducedNow);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia(QUERY);
    const on = (e: { matches: boolean }) => setReduced(e.matches);
    setReduced(mq.matches);
    // 옛 브라우저·시험의 가짜 matchMedia는 addEventListener가 없을 수 있다
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return reduced;
}
