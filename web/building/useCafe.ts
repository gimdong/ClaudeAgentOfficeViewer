import { createContext, useCallback, useEffect, useMemo, useState } from "react";
import type { SessionView } from "../../src/shared/types";
import { cafeGuests, nextGuestChange, type PantryState } from "../office/pantryPlan";
import { DOOR_FRAME_MS, hudMoveMs, nextElevatorChange, planElevator, rideMs, type ElevatorState, type HudMove, type Ride } from "./elevatorPlan";
import { listenHudMove } from "./hudMove";

/** 엘리베이터가 쓰는 층 번호: 세션 층은 그 번호(1부터), 카페 0, 로비 -1(상자가 처음 서 있는 곳) */
export const CAFE_FLOOR = 0;
export const LOBBY_FLOOR = -1;
/** 건물 단위 이름(층마다 같은 팀원 이름이 있을 수 있다) */
export const cafeKey = (floorId: string, name: string) => `${floorId}\n${name}`;

export interface CafeView {
  /** cafeKey → 카페 자리 번호(0·1) */
  guests: Record<string, number>;
  elevator: ElevatorState;
  /** 사용자가 HUD로 옮긴 마지막 상자 이동(그동안 새로 타지 않음, HUD 먼저) */
  hud: HudMove | null;
  /** 카페 자리마다 그 자리 사람(cafeKey)과 단계: cafe = 내려서 자리로 걷거나 앉음, from-cafe = 자리에서 문으로 걷거나 상자를 기다림 */
  seats: Array<{ key: string; spot: "cafe" | "from-cafe"; since: number } | undefined>;
  /** 층이 자기 탕비실 계획을 알린다(누가 카페로 가는지·돌아가는지). atDoor = 카페로 가는 사람이 엘리베이터 문 앞에 닿는 시각 */
  report(floorId: string, state: PantryState, atDoor: Record<string, number>): void;
}
export const CafeContext = createContext<CafeView | null>(null);

/**
 * 건물의 카페 자리와 엘리베이터(Phase 7b Task 8, SPEC §2b). 층들이 알린 계획에서 탈 사람을 모아 planElevator로 한 번에 1명씩 태운다.
 * 다음 바뀔 시각(1시간 됨·내림)에 타이머가 깨면, 계획이 바뀌지 않아도(자리가 꽉 차 기다림 등) 효과를 다시 돌려 다음 타이머를 건다(7a C1)
 */
/** cafeWalkMs = 카페 자리마다 자리 ↔ 문 걷는 시간(돌아갈 사람이 문 앞에 닿는 때) */
export function useCafe(sessions: SessionView[], canRide: boolean, reduced: boolean, cafeWalkMs: number[] = []): CafeView {
  const [spots, setSpots] = useState<Record<string, { state: PantryState; atDoor: Record<string, number> }>>({});
  const report = useCallback(
    (id: string, state: PantryState, atDoor: Record<string, number>) => setSpots((p) => (p[id]?.state === state && JSON.stringify(p[id].atDoor) === JSON.stringify(atDoor) ? p : { ...p, [id]: { state, atDoor } })),
    [],
  );
  const people = sessions.flatMap((s) =>
    s.members.map((m) => {
      const v = spots[s.id]?.state[m.name];
      const idle = m.state === "idle" && m.lastActivityAt ? Date.parse(m.lastActivityAt) : NaN;
      return { name: cafeKey(s.id, m.name), state: m.state, duty: m.duty, idleSince: Number.isFinite(idle) ? idle : undefined, spot: v?.spot ?? ("desk" as const), since: v?.since ?? 0, floor: s.floor, atDoor: spots[s.id]?.atDoor[m.name] };
    }),
  );
  // 엘리베이터는 문 앞에 닿은 사람만 태운다(enq = 문 앞 도착, MOTION §3.2): 층에서 걸어오는 사람은 층이 알린 시각, 카페에서 돌아갈 사람은 자리 → 문 걷기 뒤.
  // 카페에 앉지 않고 내린 그 시각에 돌아가는 사람(상자 안에서 일이 생김)은 문 앞이라 내린 시각(P7b-7)
  const [plan, setPlan] = useState(() => ({ guests: cafeGuests({}, people, Date.now(), canRide), elevator: { car: LOBBY_FLOOR, settled: 0, done: {} } as ElevatorState }));
  const riding = plan.elevator.active;
  const wants: Ride[] = people.flatMap((p): Ride[] =>
    p.spot === "to-cafe"
      ? [
          { name: p.name, from: p.floor, to: CAFE_FLOOR, dir: "out", enq: p.atDoor ?? p.since },
          // 상자 안에서 일·손들기가 생겼으면 내리는 그 순간 이어서 back(층이 계획을 다시 알리기 전에 다른 사람을 태우지 않게, P7b-7)
          ...(riding?.name === p.name && p.state !== "idle" && p.state !== "offline" && p.duty !== "off" ? [{ name: p.name, from: CAFE_FLOOR, to: p.floor, dir: "back" as const, enq: riding.start + rideMs(riding.pick, riding) }] : []),
        ]
      : p.spot === "from-cafe"
        ? [{ name: p.name, from: CAFE_FLOOR, to: p.floor, dir: "back", enq: p.since === plan.elevator.done[p.name] ? p.since : p.since + (cafeWalkMs[plan.guests[p.name] ?? 0] ?? 0) }]
        : [],
  );
  const key = JSON.stringify([people, wants, canRide]);
  const [wake, setWake] = useState(0);
  // HUD 층 버튼: 상자가 빈 때만 그 층으로 간다(탄 사람이 있으면 스크롤만). 움직임 줄이기면 그 자리에 바로(이동 0)
  const [hud, setHud] = useState<HudMove | null>(null);
  useEffect(
    () =>
      listenHudMove((to) => {
        if (plan.elevator.active) return 0;
        const from = reduced ? to : plan.elevator.car;
        const h = { from, to, start: Date.now() };
        setHud(h);
        return from === to ? 0 : hudMoveMs(h) + 2 * DOOR_FRAME_MS;
      }),
    [plan.elevator, reduced],
  );
  useEffect(() => {
    const now = Date.now();
    const guests = cafeGuests(plan.guests, people, now, canRide);
    const elevator = planElevator(plan.elevator, wants, hud, now);
    if (guests !== plan.guests || elevator !== plan.elevator) return setPlan({ guests, elevator });
    const at = Math.min(nextGuestChange(guests, people, now), nextElevatorChange(elevator, wants, hud, now));
    if (at === Infinity) return;
    const t = setTimeout(() => setWake((w) => w + 1), Math.max(0, at - now));
    return () => clearTimeout(t);
  }, [key, plan, wake, hud]); // people·wants·canRide는 key에 담겼다
  const seats: CafeView["seats"] = [];
  for (const p of people) {
    const i = plan.guests[p.name];
    if (i !== undefined && (p.spot === "cafe" || p.spot === "from-cafe")) seats[i] = { key: p.name, spot: p.spot, since: p.since };
  }
  const seatKey = JSON.stringify(seats);
  return useMemo(() => ({ guests: plan.guests, elevator: plan.elevator, hud, seats, report }), [plan, hud, report, seatKey]); // seats는 seatKey로
}
