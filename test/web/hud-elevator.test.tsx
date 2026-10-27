// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Building } from "../../web/building/Building";
import { DOOR_FRAME_MS, hudMoveMs } from "../../web/building/elevatorPlan";
import { LOBBY_FLOOR } from "../../web/building/useCafe";
import { Elevator } from "../../web/hud/Elevator";
import { makeMember, makeSession } from "./fixtures";

// Phase 7b Task 8 2b(SPEC §2b 엘리베이터): HUD 층 버튼 → 장면의 상자가 그 층까지 칸 단위로(층당 0.12초, 최대 0.6초) → 문 열림 2프레임 뒤 스크롤.
// 포커스는 바로 그 층 접기 버튼(키보드 사용자가 기다리지 않게). 움직임 줄이기면 바로
const sessions = () => [makeSession({ id: "a", name: "alpha", floor: 1, members: [makeMember({ name: "team-lead", state: "working" })] }), makeSession({ id: "b", name: "beta", floor: 2, members: [makeMember({ name: "team-lead", state: "working" })] })];
const car = () => document.querySelector(".elevator-car")!;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("HUD 층 바로가기와 장면 엘리베이터", () => {
  it("상자가 로비에서 2층까지 칸 이동한 뒤 문이 2프레임 열리고 그다음 스크롤, 포커스는 바로", () => {
    const s = sessions();
    render(
      <>
        <Elevator sessions={s} />
        <Building sessions={s} />
      </>,
    );
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    fireEvent.click(screen.getByRole("button", { name: "2층 beta" }));
    expect(document.activeElement).toBe(document.getElementById("floor-b")!.querySelector(".fold"));
    expect(car().getAttribute("data-hud-to")).toBe("2");
    const wait = hudMoveMs({ from: LOBBY_FLOOR, to: 2, start: 0 }) + 2 * DOOR_FRAME_MS;
    act(() => vi.advanceTimersByTime(wait - 1));
    expect(scroll).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0]).toBe(document.getElementById("floor-b"));
    act(() => vi.advanceTimersByTime(50));
    expect(car().getAttribute("data-floor")).toBe("2"); // 계획 상태가 원본: 다 간 뒤 상자는 2층
  });

  it("움직임 줄이기면 상자는 바로 그 층, 스크롤도 바로", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q }));
    const s = sessions();
    render(
      <>
        <Elevator sessions={s} />
        <Building sessions={s} />
      </>,
    );
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    fireEvent.click(screen.getByRole("button", { name: "1층 alpha" }));
    expect(scroll).toHaveBeenCalledWith({ block: "start", behavior: "auto" });
    act(() => vi.advanceTimersByTime(1));
    expect(car().getAttribute("data-floor")).toBe("1");
  });
});
