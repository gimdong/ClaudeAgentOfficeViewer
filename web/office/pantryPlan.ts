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

export type PantrySpot = "desk" | "walking-out" | "pantry" | "walking-back";
export type PantryState = Record<string, { spot: PantrySpot; since: number; seat?: PantrySeat }>;
/** walkMs = 커피 자리까지, sofaWalkMs = 소파 자리까지 걷는 시간(실제 거리, §3.1a). 없으면 WALK_MS */
export interface PantryMember { name: string; state: MemberState; idleSince?: number; duty?: Member["duty"]; walkMs?: number; sofaWalkMs?: number }

const walkOf = (m: PantryMember, seat?: PantrySeat) => (seat === "sofa" ? m.sofaWalkMs : undefined) ?? m.walkMs ?? WALK_MS;

/**
 * 한 층의 탕비실 걷기 계획(순수). 걷기는 WALK_MS 뒤 도착하고, 가다가 돌아서면 걸은 만큼만 되돌아온다.
 * 일(working)이 시작되면 곧바로 자리로, 걸어 나가는 중 손들기도 자리로(책상에서 hand_up), 탕비실에서 손들기는 그 자리.
 * 퇴근·offline은 걷지 않고 바로 자리. reduced면 걷기 단계 없이 바로 옮긴다. 바뀐 것이 없으면 prev를 그대로 돌려준다
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
    if (spot === "walking-out" && now - since >= walk) [spot, since] = ["pantry", since + walk];
    if (spot === "walking-back" && now - since >= walk) [spot, since] = ["desk", since + walk];
    if (off || reduced) {
      // 걸어 나가는 중 손들기는 걷지 않아도 책상으로(SPEC §3)
      if ((back || (spot === "walking-out" && m.state === "decision")) && spot !== "desk") [spot, since] = ["desk", now];
      else if (spot === "walking-out") spot = "pantry";
      else if (spot === "walking-back") spot = "desk";
    } else if (spot === "walking-out" && (back || m.state === "decision")) [spot, since] = ["walking-back", 2 * now - since - walk];
    else if (spot === "pantry" && back) [spot, since] = ["walking-back", now];
    next[m.name] = spot !== "desk" && cur.seat ? { spot, since, seat: cur.seat } : { spot, since };
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
