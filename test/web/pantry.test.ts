// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IDLE_WALK_MS, MAX_WALKERS, planPantry, WALK_MS, type PantryMember, type PantryState } from "../../web/office/pantryPlan";
import { usePantry } from "../../web/office/usePantry";

// Phase 7 Task 6(계약 SPEC §3 탕비실 걷기, MOTION.md §2·§3.1): 쉼 30초 → 탕비실, 층마다 동시에 걸어 나가는 사람 2명까지
const T0 = 1_000_000;
const idle = (name: string, since = T0): PantryMember => ({ name, state: "idle", idleSince: since });
const spots = (s: PantryState) => Object.fromEntries(Object.entries(s).map(([n, v]) => [n, v.spot]));

describe("planPantry", () => {
  it("상수는 계약 값", () => {
    expect([IDLE_WALK_MS, MAX_WALKERS, WALK_MS]).toEqual([30_000, 2, 3_120]);
  });

  it("쉼 29초 → desk, 30초 → walking-out(since = 지금)", () => {
    expect(spots(planPantry({}, [idle("a")], T0 + 29_000, false))).toEqual({ a: "desk" });
    const s = planPantry({}, [idle("a")], T0 + 30_000, false);
    expect(s.a).toEqual({ spot: "walking-out", since: T0 + 30_000 });
  });

  it("셋이 동시에 30초 → 둘만 walking-out(오래 쉰 사람 먼저), 셋째는 앞 사람이 도착한 다음 차례", () => {
    const m = [idle("b", T0), idle("a", T0), idle("c", T0 - 5_000)];
    const s1 = planPantry({}, m, T0 + 30_000, false);
    expect(spots(s1)).toEqual({ a: "walking-out", b: "desk", c: "walking-out" });
    const s2 = planPantry(s1, m, T0 + 30_000 + WALK_MS - 1, false);
    expect(spots(s2)).toEqual({ a: "walking-out", b: "desk", c: "walking-out" });
    const s3 = planPantry(s2, m, T0 + 30_000 + WALK_MS + 500, false);
    expect(spots(s3)).toEqual({ a: "pantry", b: "walking-out", c: "pantry" });
    expect(s3.a.since).toBe(T0 + 30_000 + WALK_MS); // 도착한 시각(다시 계획한 시각이 아니라)
  });

  it("walking-back은 2명 제한 밖: 둘이 돌아가는 중이어도 셋째가 걸어 나간다", () => {
    const prev: PantryState = { a: { spot: "walking-back", since: T0 }, b: { spot: "walking-back", since: T0 } };
    const m: PantryMember[] = [{ name: "a", state: "working" }, { name: "b", state: "working" }, idle("c", T0 - 30_000), idle("d", T0 - 30_000)];
    expect(spots(planPantry(prev, m, T0 + 1, false))).toEqual({ a: "walking-back", b: "walking-back", c: "walking-out", d: "walking-out" });
  });

  it("걷는 중 working → walking-back, 걸은 만큼만 되돌아옴(방향만)", () => {
    const prev: PantryState = { a: { spot: "walking-out", since: T0 } };
    const s = planPantry(prev, [{ name: "a", state: "working" }], T0 + 1_000, false);
    expect(s.a.spot).toBe("walking-back");
    expect(spots(planPantry(s, [{ name: "a", state: "working" }], T0 + 1_999, false))).toEqual({ a: "walking-back" });
    expect(spots(planPantry(s, [{ name: "a", state: "working" }], T0 + 2_000, false))).toEqual({ a: "desk" });
  });

  it("탕비실에서 working → walking-back(끝까지 걸음) → desk", () => {
    const prev: PantryState = { a: { spot: "pantry", since: T0 } };
    const s = planPantry(prev, [{ name: "a", state: "working" }], T0 + 60_000, false);
    expect(s.a).toEqual({ spot: "walking-back", since: T0 + 60_000 });
    expect(spots(planPantry(s, [{ name: "a", state: "working" }], T0 + 60_000 + WALK_MS, false))).toEqual({ a: "desk" });
  });

  it("탕비실에서 손듦(decision) → 그 자리(pantry 그대로, 화면은 hand_up_stand)", () => {
    const prev: PantryState = { a: { spot: "pantry", since: T0 } };
    const s = planPantry(prev, [{ name: "a", state: "decision" }], T0 + 60_000, false);
    expect(s.a).toEqual({ spot: "pantry", since: T0 });
  });

  it("걸어 나가는 중 손듦 → walking-back(책상에서 hand_up)", () => {
    const prev: PantryState = { a: { spot: "walking-out", since: T0 } };
    expect(spots(planPantry(prev, [{ name: "a", state: "decision" }], T0 + 500, false))).toEqual({ a: "walking-back" });
  });

  it("reduced → 걷기 단계 없이 바로 pantry, 일 시작이면 바로 desk", () => {
    const s = planPantry({}, [idle("a")], T0 + 30_000, true);
    expect(s.a).toEqual({ spot: "pantry", since: T0 + 30_000 });
    expect(spots(planPantry(s, [{ name: "a", state: "working" }], T0 + 31_000, true))).toEqual({ a: "desk" });
    const walking: PantryState = { b: { spot: "walking-out", since: T0 } };
    expect(spots(planPantry(walking, [idle("b", T0 - 30_000)], T0 + 1, true))).toEqual({ b: "pantry" });
  });

  it("duty off·offline은 대상 아님. 탕비실에 있다가 퇴근하면 걷지 않고 바로 desk", () => {
    const m: PantryMember[] = [{ ...idle("a", T0 - 60_000), duty: "off" }, { name: "b", state: "offline", idleSince: T0 - 60_000 }];
    expect(spots(planPantry({}, m, T0, false))).toEqual({ a: "desk", b: "desk" });
    const prev: PantryState = { a: { spot: "pantry", since: T0 } };
    expect(spots(planPantry(prev, [{ ...idle("a", T0 - 60_000), duty: "off" }], T0 + 1, false))).toEqual({ a: "desk" });
  });

  it("idleSince가 없으면 걷지 않고, 목록에서 빠진 사람은 상태에서도 빠진다, 바뀐 것이 없으면 prev 그대로", () => {
    const prev = planPantry({}, [{ name: "a", state: "idle" }, idle("gone")], T0, false);
    expect(spots(prev)).toEqual({ a: "desk", gone: "desk" });
    const next = planPantry(prev, [{ name: "a", state: "idle" }], T0 + 60_000, false);
    expect(spots(next)).toEqual({ a: "desk" });
    expect(planPantry(next, [{ name: "a", state: "idle" }], T0 + 90_000, false)).toBe(next);
  });
});

describe("usePantry", () => {
  afterEach(() => vi.useRealTimers());

  it("가짜 타이머: 30초 뒤 walking-out, 3.12초 더 지나면 pantry", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const members = [idle("a", T0)];
    const { result } = renderHook(() => usePantry(members, false));
    expect(result.current.a.spot).toBe("desk");
    act(() => vi.advanceTimersByTime(30_000));
    expect(result.current.a.spot).toBe("walking-out");
    act(() => vi.advanceTimersByTime(WALK_MS));
    expect(result.current.a.spot).toBe("pantry");
  });

  it("가짜 타이머: 셋째는 앞 사람이 도착하는 순간 출발, 일이 시작되면 바로 돌아섬", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const three = [idle("a"), idle("b"), idle("c")];
    const { result, rerender } = renderHook(({ m }) => usePantry(m, false), { initialProps: { m: three } });
    act(() => vi.advanceTimersByTime(30_000));
    expect(spots(result.current)).toEqual({ a: "walking-out", b: "walking-out", c: "desk" });
    act(() => vi.advanceTimersByTime(WALK_MS));
    expect(spots(result.current)).toEqual({ a: "pantry", b: "pantry", c: "walking-out" });
    act(() => vi.advanceTimersByTime(1_000));
    rerender({ m: [idle("a"), idle("b"), { name: "c", state: "working" }] });
    expect(result.current.c.spot).toBe("walking-back");
    act(() => vi.advanceTimersByTime(1_000));
    expect(result.current.c.spot).toBe("desk");
  });
});
