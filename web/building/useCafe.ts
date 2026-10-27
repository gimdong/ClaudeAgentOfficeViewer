import { createContext, useCallback, useEffect, useMemo, useState } from "react";
import type { SessionView } from "../../src/shared/types";
import { cafeGuests, nextGuestChange, type PantryState } from "../office/pantryPlan";
import { nextElevatorChange, planElevator, type ElevatorState, type Ride } from "./elevatorPlan";

/** 엘리베이터가 쓰는 층 번호: 세션 층은 그 번호(1부터), 카페 0, 로비 -1(상자가 처음 서 있는 곳) */
export const CAFE_FLOOR = 0;
export const LOBBY_FLOOR = -1;
/** 건물 단위 이름(층마다 같은 팀원 이름이 있을 수 있다) */
export const cafeKey = (floorId: string, name: string) => `${floorId}\n${name}`;

export interface CafeView {
  /** cafeKey → 카페 자리 번호(0·1) */
  guests: Record<string, number>;
  elevator: ElevatorState;
  /** 카페 자리마다 그 자리 사람(cafeKey)과 단계: cafe = 내려서 자리로 걷거나 앉음, from-cafe = 자리에서 문으로 걷거나 상자를 기다림 */
  seats: Array<{ key: string; spot: "cafe" | "from-cafe"; since: number } | undefined>;
  /** 층이 자기 탕비실 계획을 알린다(누가 카페로 가는지·돌아가는지) */
  report(floorId: string, state: PantryState): void;
}
export const CafeContext = createContext<CafeView | null>(null);

/**
 * 건물의 카페 자리와 엘리베이터(Phase 7b Task 8, SPEC §2b). 층들이 알린 계획에서 탈 사람을 모아 planElevator로 한 번에 1명씩 태운다.
 * 다음 바뀔 시각(1시간 됨·내림)에 타이머가 깨면, 계획이 바뀌지 않아도(자리가 꽉 차 기다림 등) 효과를 다시 돌려 다음 타이머를 건다(7a C1)
 */
export function useCafe(sessions: SessionView[], canRide: boolean): CafeView {
  const [spots, setSpots] = useState<Record<string, PantryState>>({});
  const report = useCallback((id: string, s: PantryState) => setSpots((p) => (p[id] === s ? p : { ...p, [id]: s })), []);
  const people = sessions.flatMap((s) =>
    s.members.map((m) => {
      const v = spots[s.id]?.[m.name];
      const idle = m.state === "idle" && m.lastActivityAt ? Date.parse(m.lastActivityAt) : NaN;
      return { name: cafeKey(s.id, m.name), state: m.state, duty: m.duty, idleSince: Number.isFinite(idle) ? idle : undefined, spot: v?.spot ?? ("desk" as const), since: v?.since ?? 0, floor: s.floor };
    }),
  );
  const wants: Ride[] = people.flatMap((p): Ride[] =>
    p.spot === "to-cafe" ? [{ name: p.name, from: p.floor, to: CAFE_FLOOR, dir: "out", enq: p.since }] : p.spot === "from-cafe" ? [{ name: p.name, from: CAFE_FLOOR, to: p.floor, dir: "back", enq: p.since }] : [],
  );
  const key = JSON.stringify([people, wants, canRide]);
  const [plan, setPlan] = useState(() => ({ guests: cafeGuests({}, people, Date.now(), canRide), elevator: { car: LOBBY_FLOOR, settled: 0, done: {} } as ElevatorState }));
  const [wake, setWake] = useState(0);
  useEffect(() => {
    const now = Date.now();
    const guests = cafeGuests(plan.guests, people, now, canRide);
    const elevator = planElevator(plan.elevator, wants, null, now);
    if (guests !== plan.guests || elevator !== plan.elevator) return setPlan({ guests, elevator });
    const at = Math.min(nextGuestChange(guests, people, now), nextElevatorChange(elevator, wants, null, now));
    if (at === Infinity) return;
    const t = setTimeout(() => setWake((w) => w + 1), Math.max(0, at - now));
    return () => clearTimeout(t);
  }, [key, plan, wake]); // people·wants·canRide는 key에 담겼다
  const seats: CafeView["seats"] = [];
  for (const p of people) {
    const i = plan.guests[p.name];
    if (i !== undefined && (p.spot === "cafe" || p.spot === "from-cafe")) seats[i] = { key: p.name, spot: p.spot, since: p.since };
  }
  const seatKey = JSON.stringify(seats);
  return useMemo(() => ({ guests: plan.guests, elevator: plan.elevator, seats, report }), [plan, report, seatKey]); // seats는 seatKey로
}
