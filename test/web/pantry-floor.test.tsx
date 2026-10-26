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

describe("Floor 탕비실 걷기", () => {
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
    expect(screen.getByTestId("desk-dev").querySelector(".character")).toBeNull();
    act(() => vi.advanceTimersByTime(WALK_MS));
    expect(walkers()).toEqual([]);
    expect(inPantry()).toEqual(["coffee"]);
    expect(screen.getByTestId("desk-dev").getAttribute("aria-label")).toBe(label);
    expect(deskOrder()).toEqual(order);
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
