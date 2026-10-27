/** 탑승자가 있는 상자의 층 하나 이동(MOTION §3.2: 층 44칸, 프레임마다 2칸, 120ms → 2.64초). 빈 상자가 태우러 갈 때도 같은 속도 */
export const RIDE_FLOOR_MS = 2_640;
/** HUD 층 바로가기의 상자 이동: 층마다 0.12초, 최대 0.6초(SPEC §2b — 탑승 이동과 다른 값) */
export const HUD_FLOOR_MS = 120;
export const HUD_MAX_MS = 600;
/** 문 한 프레임(닫힘 → 반 → 열림, steps(3)) */
export const DOOR_FRAME_MS = 100;
const DOOR_MS = 3 * DOOR_FRAME_MS;
/** 출발·도착 ride_lurch 한 바퀴(캐릭터 시트 행 12, ACTIONS.ride_lurch.ms) */
export const LURCH_MS = 200;
/** 문이 열린 뒤 상자 칸까지(또는 상자에서 문 밖까지) 걷는 마지막 4프레임(MOTION §3.2: 프레임마다 3칸, 120ms) */
export const BOARD_MS = 4 * 120;

/** 한 사람의 탑승. from·to는 층 번호(카페 층 포함, 번호는 화면이 정함). enq = 문 앞에 닿아 기다리기 시작한 시각(그 전에는 타지 않음) */
export interface Ride { name: string; from: number; to: number; dir: "out" | "back"; enq: number }
/** 사용자가 HUD로 옮긴 상자 이동 */
export interface HudMove { from: number; to: number; start: number }
/**
 * 엘리베이터 상태(건물에 하나). car = 멈춰 있는 층, settled = 거기 선 시각, active = 지금 탄 사람(pick = 출발할 때 상자가 있던 층),
 * done = 사람마다 마지막으로 내린 시각. 상자 위치의 원본은 이 상태다(화면 글자를 읽지 않음)
 */
export interface ElevatorState { car: number; settled: number; active?: Ride & { start: number; pick: number }; done: Record<string, number> }

export const hudMoveMs = (h: HudMove) => Math.min(Math.abs(h.to - h.from) * HUD_FLOOR_MS, HUD_MAX_MS);

/**
 * 탑승 한 번의 시각들(시작 기준 ms, MOTION §3.2): 빈 상자가 태우러 감(pick) → 문 열림 → 걸어 들어감 → 문 닫힘(close) → 흔들림 → 이동(go)
 * → 흔들림(land) → 도착(arrive) 문 열림 → 걸어 나감 → 끝(end)
 */
export function ridePhases(pick: number, r: Ride) {
  const p = Math.abs(r.from - pick) * RIDE_FLOOR_MS;
  const close = p + DOOR_MS + BOARD_MS;
  const go = close + DOOR_MS + LURCH_MS;
  const arrive = go + Math.abs(r.to - r.from) * RIDE_FLOOR_MS + LURCH_MS;
  return { pick: p, close, go, land: arrive - LURCH_MS, arrive, end: arrive + DOOR_MS + BOARD_MS };
}
export const rideMs = (pick: number, r: Ride) => ridePhases(pick, r).end;

const rideEnd = (a: NonNullable<ElevatorState["active"]>) => a.start + rideMs(a.pick, a);

/**
 * 엘리베이터 계획(순수, 계약 SPEC §2b·MOTION §3.2). 한 번에 1명. 기다리는 사람 중 돌아가는 사람(back)이 먼저, 같으면 먼저 기다린 사람 → 이름 순.
 * HUD 이동 중이면 새로 타지 않고 기다렸다가, 끝나면 HUD가 간 층에서 출발한다. wants는 지금 타려는 사람들(이미 그 뒤에 내린 사람은 뺀다).
 * 바뀐 것이 없으면 prev를 그대로 돌려준다
 */
export function planElevator(prev: ElevatorState, wants: Ride[], hud: HudMove | null, now: number): ElevatorState {
  let { car, settled, active, done } = prev;
  if (active && now >= rideEnd(active)) {
    [car, settled, done] = [active.to, rideEnd(active), { ...done, [active.name]: rideEnd(active) }];
    active = undefined;
  }
  // ponytail: 탑승 중에 누른 HUD 이동은 상자를 옮기지 않는다(그 사람이 내린 뒤의 상자 자리가 맞다). 화면 스크롤만
  const hudBusy = !!hud && now < hud.start + hudMoveMs(hud);
  if (!active && hud && !hudBusy && hud.start >= settled && car !== hud.to) [car, settled] = [hud.to, hud.start + hudMoveMs(hud)];
  if (!active && !hudBusy) {
    const next = wants
      .filter((r) => r.enq <= now && !((done[r.name] ?? -Infinity) > r.enq))
      .sort((a, b) => (a.dir === b.dir ? 0 : a.dir === "back" ? -1 : 1) || a.enq - b.enq || a.name.localeCompare(b.name))[0];
    if (next) active = { ...next, start: now, pick: car };
  }
  if (car === prev.car && settled === prev.settled && active === prev.active && done === prev.done) return prev;
  return { car, settled, done, ...(active ? { active } : {}) };
}

/** 다음에 계획이 바뀔 수 있는 시각(내림·HUD 이동 끝·누가 문 앞에 닿음). 상자가 비고 HUD가 없는데 문 앞에 기다리는 사람이 있으면 now */
export function nextElevatorChange(state: ElevatorState, wants: Ride[], hud: HudMove | null, now: number): number {
  if (state.active) return rideEnd(state.active);
  if (hud && now < hud.start + hudMoveMs(hud)) return hud.start + hudMoveMs(hud);
  const waiting = wants.filter((r) => !((state.done[r.name] ?? -Infinity) > r.enq));
  return waiting.length ? Math.max(now, Math.min(...waiting.map((r) => r.enq))) : Infinity;
}
