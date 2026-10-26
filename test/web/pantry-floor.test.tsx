// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Member } from "../../src/shared/types";
import { Floor } from "../../web/building/Floor";
import { IDLE_WALK_MS, WALK_MS } from "../../web/office/pantryPlan";
import { makeMember, makeSession } from "./fixtures";

// Phase 7 T6b(계약 SPEC §3 탕비실 걷기): 층이 usePantry로 걷는 그림·탕비실 자리를 그린다. 책상 버튼·이름표·접근 이름은 제자리
const T0 = Date.parse("2026-10-26T00:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();
const lead = makeMember({ name: "team-lead", role: "lead", state: "working" });
const floor = (members: Member[], p = {}) => makeSession({ members: [lead, ...members], ...p });
const resting = (name = "dev") => makeMember({ name, state: "idle", lastActivityAt: at(0) });
const walkers = () => [...document.querySelectorAll(".walk-layer .character")].map((c) => c.getAttribute("data-action"));
const inPantry = () => [...document.querySelectorAll(".pantry-scene .character")].map((c) => c.getAttribute("data-action"));
const deskOrder = () => [...document.querySelectorAll('[data-testid^="desk-"]')].map((d) => d.getAttribute("data-testid"));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// jsdom은 배치가 없으니 칸 위치를 정해 준다: 방 (0,0), 탕비실 (500,10), 책상 data-member마다 x
function fakeLayout(desks: Record<string, number>) {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const el = this as HTMLElement;
    const x = el.classList.contains("pantry-scene") ? 500 : el.classList.contains("desk-scene") ? (desks[el.dataset.member ?? ""] ?? 0) : 0;
    return { left: x, top: el.classList.contains("pantry-scene") ? 10 : 0, right: x, bottom: 0, width: 0, height: 0, x, y: 0, toJSON: () => ({}) } as DOMRect;
  });
}
const walkTo = () => [...document.querySelectorAll<HTMLElement>(".walk-layer .walker")].map((w) => /translate\((-?\d+)px/.exec(w.style.transform)?.[1]).sort();

describe("Floor 탕비실 걷기", () => {
  afterEach(() => vi.restoreAllMocks());

  it("둘이 걸어 나가면 먼저 닿을 사람은 커피 자리(x+2), 다음은 소파 자리(x+88)로 걷는다(designer-motion I1)", () => {
    fakeLayout({ a: 0, b: 150 });
    render(<Floor session={floor([resting("a"), resting("b")])} />);
    act(() => vi.advanceTimersByTime(IDLE_WALK_MS));
    act(() => vi.advanceTimersByTime(300));
    expect(walkTo()).toEqual(["502", "588"]);
    const tx = (n: string) => document.querySelector<HTMLElement>(`.walker[data-name="${n}"]`)!.style.transform;
    expect(tx("b")).toContain("502px"); // b가 더 가까워 먼저 닿는다
    expect(tx("a")).toContain("588px");
  });

  it("일어서기·앉기(I2): 출발하면 300ms 책상에서 sit_down 거꾸로, 돌아오면 300ms sit_down 뒤 type. 빈 책상에 z z 없음(M2)", () => {
    const { rerender } = render(<Floor session={floor([resting()])} />);
    const deskAct = () => screen.getByTestId("desk-dev").querySelector(".character")?.getAttribute("data-action") ?? null;
    act(() => vi.advanceTimersByTime(IDLE_WALK_MS));
    expect(deskAct()).toBe("sit_down");
    expect(screen.getByTestId("desk-dev").querySelector(".desk-scene")!.getAttribute("data-shift")).toBe("stand");
    act(() => vi.advanceTimersByTime(300));
    expect(deskAct()).toBeNull();
    expect(screen.getByTestId("desk-dev").querySelector('[data-testid="bubble"]')).toBeNull();
    act(() => vi.advanceTimersByTime(WALK_MS));
    rerender(<Floor session={floor([makeMember({ name: "dev", state: "working" })])} />);
    act(() => vi.advanceTimersByTime(WALK_MS));
    expect(deskAct()).toBe("sit_down");
    expect(screen.getByTestId("desk-dev").querySelector(".desk-scene")!.getAttribute("data-shift")).toBe("sit");
    act(() => vi.advanceTimersByTime(300));
    expect(deskAct()).toBe("type");
  });

  it("쉼 30초 → 책상은 빈 의자, 걷는 층에 walk_*; 도착하면 커피 자리 coffee. 책상 버튼·접근 이름·순서는 그대로", () => {
    render(<Floor session={floor([resting()])} />);
    const desk = screen.getByTestId("desk-dev");
    const label = desk.getAttribute("aria-label");
    const order = deskOrder();
    expect(walkers()).toEqual([]);
    act(() => vi.advanceTimersByTime(IDLE_WALK_MS));
    expect(walkers()).toHaveLength(1);
    expect(walkers()[0]).toMatch(/^walk_(left|right)$/);
    expect(document.querySelector(".walk-layer")!.getAttribute("aria-hidden")).toBe("true");
    act(() => vi.advanceTimersByTime(300)); // 일어서기(I2) 뒤 빈 의자
    expect(screen.getByTestId("desk-dev").querySelector(".character")).toBeNull();
    act(() => vi.advanceTimersByTime(WALK_MS - 300));
    expect(walkers()).toEqual([]);
    expect(inPantry()).toEqual(["coffee"]);
    expect(screen.getByTestId("desk-dev").getAttribute("aria-label")).toBe(label);
    expect(deskOrder()).toEqual(order);
  });

  it("걸어 나간 팀원의 빈 책상은 점선 이름표 \"탕비실 →\"(테마 낱말), 접근 이름은 그대로(P7a-14 ①)", () => {
    render(<Floor session={floor([resting()])} />);
    const tag = () => screen.getByTestId("desk-dev").querySelector(".nametag")!;
    expect(tag().textContent).toContain("dev");
    const label = screen.getByTestId("desk-dev").getAttribute("aria-label");
    act(() => vi.advanceTimersByTime(IDLE_WALK_MS));
    expect(tag().className).toContain("nametag--away");
    expect(tag().textContent).toContain("탕비실 →");
    expect(screen.getByTestId("desk-dev").getAttribute("aria-label")).toBe(label);
  });

  it("탕비실 자리는 둘: 먼저 온 사람 커피, 다음 소파, 셋째는 책상에서 기다림", () => {
    render(<Floor session={floor([resting("a"), resting("b"), resting("c")])} />);
    act(() => vi.advanceTimersByTime(IDLE_WALK_MS));
    act(() => vi.advanceTimersByTime(WALK_MS));
    expect(inPantry()).toEqual(["idle", "coffee"]); // 문서 순서: 소파(뒤) → 커피 자리(앞)
    expect(walkers()).toEqual([]);
    expect(screen.getByTestId("desk-c").querySelector(".character")).not.toBeNull();
  });

  it("움직임 줄이기가 바뀌면 바로 따라간다(matchMedia change, P7a-14 ②): 걷던 사람은 바로 탕비실", () => {
    let reduce = false;
    const listeners = new Set<(e: { matches: boolean }) => void>();
    vi.stubGlobal("matchMedia", (q: string) => ({
      media: q,
      get matches() {
        return q.includes("reduced-motion") ? reduce : false;
      },
      addEventListener: (_t: string, f: (e: { matches: boolean }) => void) => void listeners.add(f),
      removeEventListener: (_t: string, f: (e: { matches: boolean }) => void) => void listeners.delete(f),
    }));
    render(<Floor session={floor([resting()])} />);
    act(() => vi.advanceTimersByTime(IDLE_WALK_MS));
    expect(walkers()).toHaveLength(1);
    reduce = true;
    act(() => listeners.forEach((f) => f({ matches: true })));
    expect(walkers()).toEqual([]);
    expect(inPantry()).toEqual(["coffee"]);
    vi.unstubAllGlobals();
  });

  it("탕비실에서 손듦 → 그 자리 hand_up_stand, 책상 결정 표시는 바로", () => {
    const { rerender } = render(<Floor session={floor([resting()])} />);
    act(() => vi.advanceTimersByTime(IDLE_WALK_MS));
    act(() => vi.advanceTimersByTime(WALK_MS));
    rerender(<Floor session={floor([makeMember({ name: "dev", state: "decision", decision: { since: at(0) } as Member["decision"] })])} />);
    expect(inPantry()).toEqual(["hand_up_stand"]);
    expect(screen.getByTestId("desk-dev").className).toContain("desk--decision");
  });

  it("휴업 층 팀원은 계획기에서 뺀다: 오래 쉬어도 걷지 않고 탕비실에 아무도 없음", () => {
    render(<Floor session={floor([resting()], { floorStatus: "paused" })} />);
    act(() => vi.advanceTimersByTime(IDLE_WALK_MS));
    act(() => vi.advanceTimersByTime(WALK_MS));
    expect(walkers()).toEqual([]);
    expect(inPantry()).toEqual([]);
  });

  it("내용이 같은 새 스냅샷이 와도 계획 타이머를 다시 맞추지 않는다(members useMemo)", () => {
    const { rerender } = render(<Floor session={floor([resting()])} />);
    const clear = vi.spyOn(globalThis, "clearTimeout");
    rerender(<Floor session={floor([resting()])} />);
    rerender(<Floor session={floor([resting()])} />);
    expect(clear).not.toHaveBeenCalled();
  });
});
