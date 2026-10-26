import type { Member, MemberState } from "../../src/shared/types";

/** 쉼이 이만큼 이어지면 탕비실로(SPEC §3, MOTION §3.1) */
export const IDLE_WALK_MS = 30_000;
/** 한 층에서 동시에 걸어 나가는 사람 수(돌아가는 걷기는 세지 않음) */
export const MAX_WALKERS = 2;
/** 책상 ↔ 탕비실 걷는 시간(MOTION §3 스토리보드 78칸, 25칸/초) */
export const WALK_MS = 3_120;

export type PantrySpot = "desk" | "walking-out" | "pantry" | "walking-back";
export type PantryState = Record<string, { spot: PantrySpot; since: number }>;
export interface PantryMember { name: string; state: MemberState; idleSince?: number; duty?: Member["duty"] }

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
    let { spot, since } = cur;
    if (spot === "walking-out" && now - since >= WALK_MS) [spot, since] = ["pantry", since + WALK_MS];
    if (spot === "walking-back" && now - since >= WALK_MS) [spot, since] = ["desk", since + WALK_MS];
    if (off || reduced) {
      if (back && spot !== "desk") [spot, since] = ["desk", now];
      else if (spot === "walking-out") spot = "pantry";
      else if (spot === "walking-back") spot = "desk";
    } else if (spot === "walking-out" && (back || m.state === "decision")) [spot, since] = ["walking-back", 2 * now - since - WALK_MS];
    else if (spot === "pantry" && back) [spot, since] = ["walking-back", now];
    next[m.name] = { spot, since };
    if (spot === "desk" && !off && m.state === "idle" && m.idleSince !== undefined && now - m.idleSince >= IDLE_WALK_MS) out.push(m);
  }
  // 30초가 된 사람: 오래 쉰 사람 → 이름 순. 걸어 나가는 사람이 2명이면 나머지는 자리에서 기다린다(reduced는 걷지 않으니 제한 없음)
  out.sort((a, b) => a.idleSince! - b.idleSince! || a.name.localeCompare(b.name));
  let walkers = Object.values(next).filter((v) => v.spot === "walking-out").length;
  for (const m of out) {
    if (reduced) next[m.name] = { spot: "pantry", since: now };
    else if (walkers < MAX_WALKERS) (next[m.name] = { spot: "walking-out", since: now }), walkers++;
  }
  const same = Object.keys(next).length === Object.keys(prev).length && Object.entries(next).every(([n, v]) => prev[n]?.spot === v.spot && prev[n].since === v.since);
  return same ? prev : next;
}

/** 다음에 계획이 바뀔 수 있는 시각(도착·30초 됨, 지금보다 뒤). 차례를 기다리는 사람은 앞 사람 도착 때 다시 본다. 없으면 Infinity */
export function nextChange(state: PantryState, members: PantryMember[], now: number): number {
  let t = Infinity;
  for (const v of Object.values(state)) if (v.spot === "walking-out" || v.spot === "walking-back") t = Math.min(t, v.since + WALK_MS);
  for (const m of members) {
    const due = (m.idleSince ?? -Infinity) + IDLE_WALK_MS;
    if (state[m.name]?.spot === "desk" && m.state === "idle" && due > now) t = Math.min(t, due);
  }
  return t;
}
