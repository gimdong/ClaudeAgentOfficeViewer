import { describe, expect, it } from "vitest";
import { DOOR_FRAME_MS, HUD_FLOOR_MS, HUD_MAX_MS, hudMoveMs, nextElevatorChange, planElevator, RIDE_FLOOR_MS, rideMs, type ElevatorState, type Ride } from "../../web/building/elevatorPlan";
import { ACTIONS } from "../../web/office/Character";
import { CAFE_SEATS, cafeGuests, LONG_IDLE_MS, nextGuestChange, planPantry, WALK_MS, type PantryMember, type PantryState } from "../../web/office/pantryPlan";

// Phase 7b Task 8(계약 SPEC §2b, MOTION §3.2·§3.3): 오래 쉬면(1시간) 엘리베이터로 카페, 한 번에 1명, 돌아가는 사람이 먼저, HUD 이동이 먼저
// 시각은 일부러 조금씩 어긋나게(7a 교훈: 같은 시각만 쓰면 "깼는데 바뀐 것 없음"을 놓친다)
const T0 = 5_000_000;
const CAFE = -1;
const out = (name: string, from: number, enq: number): Ride => ({ name, from, to: CAFE, dir: "out", enq });
const back = (name: string, to: number, enq: number): Ride => ({ name, from: CAFE, to, dir: "back", enq });
const start = (car = 0): ElevatorState => ({ car, settled: 0, done: {} });

describe("elevatorPlan", () => {
  it("상수는 계획 값, 문은 3프레임, 출발·도착 흔들림은 시트 ride_lurch 한 바퀴", () => {
    expect([RIDE_FLOOR_MS, HUD_FLOOR_MS, HUD_MAX_MS, DOOR_FRAME_MS]).toEqual([2_640, 120, 600, 100]);
    // 빈 상자가 3층 → 2층(1층) + 태우고 2층 → 카페(-1, 3층) = 4층 이동, 문 세 번(열림·닫힘·도착 열림), 흔들림 두 번
    expect(rideMs(3, out("a", 2, 0))).toBe(4 * 2_640 + 3 * 3 * DOOR_FRAME_MS + 2 * ACTIONS.ride_lurch.ms);
  });

  it("HUD 층 이동 시간 = min(층 수 × 120ms, 600ms)", () => {
    expect(hudMoveMs({ from: 1, to: 3, start: 0 })).toBe(240);
    expect(hudMoveMs({ from: 9, to: 1, start: 0 })).toBe(600);
  });

  it("한 번에 1명: 둘째는 첫째가 내린 뒤 그 층에서 출발", () => {
    const wants = [out("b", 2, T0 + 7), out("a", 1, T0)];
    const s1 = planElevator(start(0), wants, null, T0 + 13);
    expect(s1.active).toMatchObject({ name: "a", start: T0 + 13, pick: 0 });
    const endA = T0 + 13 + rideMs(0, wants[1]);
    expect(planElevator(s1, wants, null, endA - 1)).toBe(s1);
    const s2 = planElevator(s1, wants, null, endA + 5);
    expect(s2.done.a).toBe(endA);
    expect(s2.active).toMatchObject({ name: "b", start: endA + 5, pick: CAFE });
  });

  it("돌아가는 사람(back)이 가는 사람(out)보다 먼저, 같으면 먼저 기다린 사람", () => {
    const s = planElevator(start(0), [out("a", 1, T0), back("c", 3, T0 + 40), back("b", 2, T0 + 20)], null, T0 + 51);
    expect(s.active?.name).toBe("b");
  });

  it("HUD 이동 중이면 타려던 사람은 기다리고, 끝나면 상자는 HUD가 간 층에서 출발", () => {
    const hud = { from: 0, to: 4, start: T0 + 3 };
    const wants = [out("a", 1, T0)];
    const s1 = planElevator(start(0), wants, hud, T0 + 100);
    expect(s1.active).toBeUndefined();
    expect(nextElevatorChange(s1, wants, hud, T0 + 100)).toBe(T0 + 3 + 480);
    const s2 = planElevator(s1, wants, hud, T0 + 3 + 480);
    expect(s2.active).toMatchObject({ name: "a", pick: 4 });
  });

  it("내린 시각에 다시 타는 돌아가기(enq = 내린 시각)는 새 탑승이다", () => {
    const wants = [out("a", 1, T0)];
    const s1 = planElevator(start(1), wants, null, T0 + 9);
    const end = T0 + 9 + rideMs(1, wants[0]);
    const s2 = planElevator(s1, [back("a", 1, end)], null, end);
    expect(s2.done.a).toBe(end);
    expect(s2.active).toMatchObject({ name: "a", dir: "back" });
  });

  it("상자가 비고 HUD도 없는데 기다리는 사람이 있으면 다음 바뀔 시각은 지금이고, 그 시각에 계획하면 반드시 태운다(0ms 고리 없음)", () => {
    const hud = { from: 0, to: 2, start: T0 };
    const wants = [out("a", 1, T0 + 3)];
    const s1 = planElevator(start(0), wants, hud, T0 + 100);
    expect(s1.active).toBeUndefined();
    const at = nextElevatorChange(s1, wants, hud, T0 + 100);
    expect(at).toBe(T0 + 240);
    const s2 = planElevator(s1, wants, hud, at);
    expect(s2.active?.name).toBe("a");
    expect(nextElevatorChange(planElevator(start(0), [], null, T0), wants, null, T0 + 7)).toBe(T0 + 7);
    expect(planElevator(start(0), wants, null, T0 + 7).active?.name).toBe("a");
  });

  it("바뀐 것이 없으면 같은 객체, 탈 사람이 없으면 다음 바뀔 시각 Infinity", () => {
    const s = start(2);
    expect(planElevator(s, [], null, T0)).toBe(s);
    expect(nextElevatorChange(s, [], null, T0)).toBe(Infinity);
  });
});

const longIdle = (name: string, since: number, p: Partial<PantryMember> = {}): PantryMember => ({ name, state: "idle", idleSince: since, ...p });
const spots = (s: PantryState) => Object.fromEntries(Object.entries(s).map(([n, v]) => [n, v.spot]));

describe("cafeGuests(건물 단위 카페 자리)", () => {
  it("1시간 쉰 사람만, 자리 2개를 오래 쉰 순으로. 셋째는 받지 못해 탕비실에 남는다", () => {
    expect(CAFE_SEATS).toBe(2);
    expect(LONG_IDLE_MS).toBe(3_600_000);
    const now = T0 + LONG_IDLE_MS;
    const m = [{ ...longIdle("c", T0 - 30), spot: "pantry" as const }, { ...longIdle("a", T0 - 90), spot: "pantry" as const }, { ...longIdle("b", T0 - 60), spot: "desk" as const }, { ...longIdle("d", T0 + 1), spot: "pantry" as const }];
    expect(cafeGuests({}, m, now, true)).toEqual({ a: 0, b: 1 });
    expect(nextGuestChange({ a: 0, b: 1 }, m, now)).toBe(T0 + 1 + LONG_IDLE_MS); // d가 1시간 되는 때
  });

  it("탑승 행이 없는 테마는 카페로 가지 않는다", () => {
    expect(cafeGuests({}, [{ ...longIdle("a", T0), spot: "pantry" }], T0 + LONG_IDLE_MS, false)).toEqual({});
  });

  it("자리는 카페에 있거나 돌아가려 기다리는 동안 그대로, 돌아가는 엘리베이터를 내리면 빈다", () => {
    const g = { a: 1 };
    expect(cafeGuests(g, [{ name: "a", state: "working", spot: "from-cafe" }], T0, true)).toBe(g);
    expect(cafeGuests(g, [{ name: "a", state: "working", spot: "walking-back" }], T0, true)).toEqual({});
  });
});

describe("planPantry 카페 단계", () => {
  const T = T0 + 17;
  it("카페 자리를 받으면 to-cafe → 내리면 cafe → 일 시작 → from-cafe → 내리면 walking-back → desk", () => {
    const m = longIdle("a", T0, { cafe: true });
    const s1 = planPantry({ a: { spot: "pantry", since: T0, seat: "coffee" } }, [m], T, false);
    expect(s1.a).toEqual({ spot: "to-cafe", since: T, seat: "coffee" }); // 탕비실 자리는 출발점으로만(정원에 세지 않음)
    const s2 = planPantry(s1, [{ ...m, boarded: T + 3, rideDone: T + 9_000 }], T + 9_001, false);
    expect(s2.a).toEqual({ spot: "cafe", since: T + 9_000 });
    const w: PantryMember = { name: "a", state: "working", rideDone: T + 9_000 };
    const s3 = planPantry(s2, [w], T + 20_011, false);
    expect(s3.a).toEqual({ spot: "from-cafe", since: T + 20_011 });
    const s4 = planPantry(s3, [{ ...w, boarded: T + 20_020, rideDone: T + 29_000 }], T + 29_003, false);
    expect(s4.a).toEqual({ spot: "walking-back", since: T + 29_000 });
    expect(spots(planPantry(s4, [w], T + 29_000 + WALK_MS, false))).toEqual({ a: "desk" });
  });

  it("카페에서 손들면 그 자리에서 손들지 않고 from-cafe(엘리베이터로 돌아와 책상에서 hand_up)", () => {
    const s = planPantry({ a: { spot: "cafe", since: T0 } }, [{ name: "a", state: "decision" }], T, false);
    expect(s.a).toEqual({ spot: "from-cafe", since: T });
  });

  it("타기 전에 일이 시작되면 엘리베이터 없이 걸어서 자리로, 탄 뒤면 카페에 내렸다가 곧바로 돌아온다", () => {
    const prev: PantryState = { a: { spot: "to-cafe", since: T0 } };
    expect(planPantry(prev, [{ name: "a", state: "working" }], T, false).a).toEqual({ spot: "walking-back", since: T });
    const riding = { name: "a", state: "working" as const, boarded: T0 + 5 };
    expect(planPantry(prev, [riding], T, false)).toBe(prev);
    expect(planPantry(prev, [{ ...riding, rideDone: T0 + 8_000 }], T0 + 8_004, false).a).toEqual({ spot: "from-cafe", since: T0 + 8_004 });
  });

  it("카페에 간 사람은 탕비실 정원(2)에 세지 않는다", () => {
    const prev: PantryState = { a: { spot: "cafe", since: T0 }, b: { spot: "to-cafe", since: T0 } };
    const m = [longIdle("a", T0 - LONG_IDLE_MS, { cafe: true }), longIdle("b", T0 - LONG_IDLE_MS, { cafe: true }), longIdle("c", T0 - 40_000), longIdle("d", T0 - 35_000)];
    expect(spots(planPantry(prev, m, T, false))).toEqual({ a: "cafe", b: "to-cafe", c: "walking-out", d: "walking-out" });
  });

  it("reduced: 자리를 받으면 바로 cafe, 일이 시작되면 바로 desk. 카페에서 퇴근해도 바로 desk", () => {
    const s = planPantry({}, [longIdle("a", T0, { cafe: true })], T, true);
    expect(s.a).toEqual({ spot: "cafe", since: T });
    expect(planPantry(s, [{ name: "a", state: "working" }], T + 3, true).a).toEqual({ spot: "desk", since: T + 3 });
    expect(planPantry(s, [{ name: "a", state: "idle", duty: "off" }], T + 5, false).a).toEqual({ spot: "desk", since: T + 5 });
  });
});
