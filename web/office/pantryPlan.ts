import type { Member, MemberState } from "../../src/shared/types";

/** 쉼이 이만큼 이어지면 탕비실로(SPEC §3, MOTION §3.1) */
export const IDLE_WALK_MS = 30_000;
/** 한 층에서 동시에 걸어 나가는 사람 수(돌아가는 걷기는 세지 않음) */
export const MAX_WALKERS = 2;
/** 책상 ↔ 탕비실 기본 걷는 시간(MOTION §3 스토리보드 78칸, 25칸/초). 화면이 실제 거리로 멤버마다 walkMs를 줄 수 있다(§3.1a) */
export const WALK_MS = 3_120;
/** 탕비실 자리(계약 SPEC §2 pantry): 커피 x14·소파 x57 둘뿐. 출발할 때 빈 자리를 앞에서부터 정해 그 자리로 걷는다(돌아올 때도 그 자리에서) */
export const PANTRY_SEATS = ["coffee", "sofa"] as const;
export type PantrySeat = (typeof PANTRY_SEATS)[number];

/** 쉼이 이만큼 이어지면 엘리베이터로 카페(longIdle, SPEC §2b) */
export const LONG_IDLE_MS = 3_600_000;
/** 카페 층 팀원 자리(계약 §2 러그 위 테이블 둘). 건물 전체에서 2명, 나머지는 자기 층 탕비실에 남는다 */
export const CAFE_SEATS = 2;

/** to-cafe = 카페로 가려 엘리베이터를 기다리거나 타는 중, from-cafe = 카페에서 돌아가려 기다리거나 타는 중(문 안팎 걷기는 화면 몫) */
export type PantrySpot = "desk" | "walking-out" | "pantry" | "walking-back" | "to-cafe" | "cafe" | "from-cafe";
export type PantryState = Record<string, { spot: PantrySpot; since: number; seat?: PantrySeat }>;
/**
 * walkMs = 커피 자리까지, sofaWalkMs = 소파 자리까지 걷는 시간(실제 거리, §3.1a). 없으면 WALK_MS.
 * doorWalkMs = 엘리베이터 문 ↔ 책상(자리 없이 돌아오는 걷기 = 엘리베이터에서 내린 뒤). cafe = 건물이 카페 자리를 줌(cafeGuests), boarded·rideDone = 그 사람의 마지막 엘리베이터 탄 시각·내린 시각(elevatorPlan)
 */
export interface PantryMember { name: string; state: MemberState; idleSince?: number; duty?: Member["duty"]; walkMs?: number; sofaWalkMs?: number; doorWalkMs?: number; cafe?: boolean; boarded?: number; rideDone?: number }

const CAFE_SPOTS: readonly PantrySpot[] = ["to-cafe", "cafe", "from-cafe"];
const after = (t: number | undefined, since: number) => t !== undefined && t > since;

const walkOf = (m: PantryMember, seat?: PantrySeat) => (seat === "sofa" ? m.sofaWalkMs : seat ? undefined : m.doorWalkMs) ?? m.walkMs ?? WALK_MS;

/**
 * 한 층의 탕비실 걷기 계획(순수). 걷기는 WALK_MS 뒤 도착하고, 가다가 돌아서면 걸은 만큼만 되돌아온다.
 * 일(working)이 시작되면 곧바로 자리로, 걸어 나가는 중 손들기도 자리로(책상에서 hand_up), 탕비실에서 손들기는 그 자리.
 * 퇴근·offline은 걷지 않고 바로 자리. reduced면 걷기 단계 없이 바로 옮긴다. 바뀐 것이 없으면 prev를 그대로 돌려준다.
 * 카페(Phase 7b): 카페 자리를 받으면 to-cafe → 내리면 cafe. 일·손들기면 from-cafe(카페에서는 손들지 않음) → 내리면 걸어서 자리.
 * 타기 전에 일이 시작되면 엘리베이터 없이 걸어서 자리로, 탄 뒤면 카페에 내렸다 곧바로 돌아온다
 */
export function planPantry(prev: PantryState, members: PantryMember[], now: number, reduced: boolean): PantryState {
  const next: PantryState = {};
  const out: PantryMember[] = [];
  for (const m of members) {
    const cur = prev[m.name] ?? { spot: "desk", since: now };
    const off = m.state === "offline" || m.duty === "off";
    const back = m.state === "working" || off;
    const walk = walkOf(m, cur.seat);
    let { spot, since } = cur;
    if (CAFE_SPOTS.includes(spot)) {
      const leave = m.state !== "idle" || off || !m.cafe;
      if (spot === "to-cafe" && reduced) [spot, since] = leave ? ["desk", now] : ["cafe", now];
      else if (spot === "to-cafe" && after(m.rideDone, since)) [spot, since] = ["cafe", m.rideDone!];
      else if (spot === "to-cafe" && leave && !(m.boarded !== undefined && m.boarded >= since)) [spot, since] = off ? ["desk", now] : ["walking-back", now];
      if (spot === "cafe" && leave) [spot, since] = off || reduced ? ["desk", now] : ["from-cafe", now];
      else if (spot === "from-cafe" && (off || reduced)) [spot, since] = ["desk", now];
      else if (spot === "from-cafe" && after(m.rideDone, since)) [spot, since] = ["walking-back", m.rideDone!];
    }
    if (spot === "walking-out" && now - since >= walk) [spot, since] = ["pantry", since + walk];
    if (spot === "walking-back" && now - since >= walk) [spot, since] = ["desk", since + walk];
    if (CAFE_SPOTS.includes(spot)) {
      // 카페 단계는 위에서 끝
    } else if (off || reduced) {
      // 걸어 나가는 중 손들기는 걷지 않아도 책상으로(SPEC §3)
      if ((back || (spot === "walking-out" && m.state === "decision")) && spot !== "desk") [spot, since] = ["desk", now];
      else if (spot === "walking-out") spot = "pantry";
      else if (spot === "walking-back") spot = "desk";
    } else if (spot === "walking-out" && (back || m.state === "decision")) [spot, since] = ["walking-back", 2 * now - since - walk];
    else if (spot === "pantry" && back) [spot, since] = ["walking-back", now];
    if ((spot === "desk" || spot === "pantry") && m.cafe && m.state === "idle" && !off) [spot, since] = [reduced ? "cafe" : "to-cafe", now];
    // to-cafe는 떠난 탕비실 자리를 출발점으로만 기억한다(정원에는 세지 않음)
    next[m.name] = (spot === "walking-out" || spot === "pantry" || spot === "walking-back" || spot === "to-cafe") && cur.seat ? { spot, since, seat: cur.seat } : { spot, since };
    if (spot === "desk" && !off && m.state === "idle" && m.idleSince !== undefined && now - m.idleSince >= IDLE_WALK_MS) out.push(m);
  }
  // 30초가 된 사람: 오래 쉰 사람 → 이름 순. 걸어 나가는 사람 + 탕비실에 있는 사람이 자리 수(2)면 나머지는 책상에서 기다린다
  out.sort((a, b) => a.idleSince! - b.idleSince! || a.name.localeCompare(b.name));
  const holding = () => Object.values(next).filter((v) => v.spot === "walking-out" || v.spot === "pantry");
  let taken = holding().length;
  const used = new Set(holding().map((v) => v.seat));
  for (const m of out) {
    if (taken >= Math.min(MAX_WALKERS, PANTRY_SEATS.length)) break;
    const seat = PANTRY_SEATS.find((s) => !used.has(s))!;
    used.add(seat);
    next[m.name] = { spot: reduced ? "pantry" : "walking-out", since: now, seat };
    taken++;
  }
  // 자리 없이 탕비실에 있는 사람(자리를 모르던 이전 상태)에게 빈 자리를 도착 순(같으면 이름 순)으로
  const arrived = Object.entries(next).filter(([, v]) => v.spot === "pantry" && !v.seat);
  arrived.sort(([a, x], [b, y]) => x.since - y.since || a.localeCompare(b));
  for (const [, v] of arrived) used.add((v.seat = PANTRY_SEATS.find((s) => !used.has(s))));
  const same = Object.keys(next).length === Object.keys(prev).length && Object.entries(next).every(([n, v]) => prev[n]?.spot === v.spot && prev[n].since === v.since && prev[n].seat === v.seat);
  return same ? prev : next;
}

/** 다음에 계획이 바뀔 수 있는 시각(도착·30초 됨, 지금보다 뒤). 차례를 기다리는 사람은 앞 사람 도착 때 다시 본다. 없으면 Infinity */
export function nextChange(state: PantryState, members: PantryMember[], now: number): number {
  let t = Infinity;
  for (const m of members) {
    const v = state[m.name];
    if (v?.spot === "walking-out" || v?.spot === "walking-back") t = Math.min(t, v.since + walkOf(m, v.seat));
    const due = (m.idleSince ?? -Infinity) + IDLE_WALK_MS;
    if (state[m.name]?.spot === "desk" && m.state === "idle" && due > now) t = Math.min(t, due);
  }
  return t;
}

type GuestMember = Pick<PantryMember, "name" | "state" | "duty" | "idleSince"> & { spot: PantrySpot };
const isLongIdle = (m: GuestMember, now: number) => m.state === "idle" && m.duty !== "off" && m.idleSince !== undefined && now - m.idleSince >= LONG_IDLE_MS;

/**
 * 건물의 카페 자리(순수, CAFE_SEATS개). 이름 → 자리 번호. 1시간 쉰 사람에게 오래 쉰 순(같으면 이름 순)으로 주고,
 * 카페로 가거나 카페에 있거나 돌아가려 기다리는 동안 그대로 둔다. 탑승 행이 없는 테마(canRide false)는 아무도 가지 않는다.
 * 바뀐 것이 없으면 prev를 그대로 돌려준다
 */
export function cafeGuests(prev: Record<string, number>, members: GuestMember[], now: number, canRide: boolean): Record<string, number> {
  const next: Record<string, number> = {};
  if (canRide) {
    for (const m of members) if (prev[m.name] !== undefined && (CAFE_SPOTS.includes(m.spot) || isLongIdle(m, now))) next[m.name] = prev[m.name];
    const wait = members.filter((m) => next[m.name] === undefined && isLongIdle(m, now)).sort((a, b) => a.idleSince! - b.idleSince! || a.name.localeCompare(b.name));
    for (let seat = 0; seat < CAFE_SEATS; seat++) if (!Object.values(next).includes(seat) && wait.length) next[wait.shift()!.name] = seat;
  }
  const same = Object.keys(next).length === Object.keys(prev).length && Object.entries(next).every(([n, v]) => prev[n] === v);
  return same ? prev : next;
}

/** 다음에 누군가 1시간이 되는 시각(지금보다 뒤). 없으면 Infinity */
export function nextGuestChange(guests: Record<string, number>, members: GuestMember[], now: number): number {
  let t = Infinity;
  for (const m of members) if (guests[m.name] === undefined && m.state === "idle" && m.duty !== "off" && m.idleSince !== undefined && m.idleSince + LONG_IDLE_MS > now) t = Math.min(t, m.idleSince + LONG_IDLE_MS);
  return t;
}
