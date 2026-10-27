// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Member } from "../../src/shared/types";
import { Building } from "../../web/building/Building";
import { RIDE_FLOOR_MS, rideMs } from "../../web/building/elevatorPlan";
import { CAFE_FLOOR, LOBBY_FLOOR } from "../../web/building/useCafe";
import { LONG_IDLE_MS, WALK_MS } from "../../web/office/pantryPlan";
import { makeMember, makeSession } from "./fixtures";

// Phase 7b Task 8 2단계(계약 SPEC §2b, MOTION §3.2·§3.3): 1시간 쉰 팀원이 엘리베이터로 카페에 가고, 일·손들기면 엘리베이터로 돌아온다.
// 책상 버튼·이름표·접근 이름은 제자리, 카페에 앉은 사람의 이름표는 aria-hidden 복제. 시각은 조금씩 어긋나게
const T0 = Date.parse("2026-10-27T03:00:00.000Z");
const ago = (ms: number) => new Date(T0 - ms).toISOString();
const lead = makeMember({ name: "team-lead", role: "lead", state: "working", lastActivityAt: ago(1_000) });
const rest = (name: string, ms: number) => makeMember({ name, state: "idle", lastActivityAt: ago(ms) });
const floor1 = (members: Member[]) => makeSession({ id: "s1", floor: 1, members: [lead, ...members] });
const rider = () => document.querySelector(".elevator-car")?.getAttribute("data-rider") ?? null;
const seated = () => [...document.querySelectorAll(".cafe-seat")].map((s) => s.querySelector(".character")?.getAttribute("data-name") ?? null);
const tagOf = (n: string) => screen.getByTestId(`desk-${n}`).querySelector(".nametag")!.textContent;
const step = (ms: number) => act(() => vi.advanceTimersByTime(ms));
// 문 앞에 닿아야 탄다(jsdom은 배치가 없어 걷는 시간은 기본 WALK_MS). 1층 → 카페: 상자가 로비에서 1층으로 올라와 태우고 카페로(로비 -1, 카페 0)
const TO_DOOR = WALK_MS + 10;
const UP = rideMs(LOBBY_FLOOR, { name: "", from: 1, to: CAFE_FLOOR, dir: "out", enq: 0 });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("카페 오래 쉬기(엘리베이터)", () => {
  it("1시간 쉰 팀원: 빈 책상 \"카페 ↑\" → 엘리베이터에 타고 → 카페 자리에 앉음(이름표 복제는 aria-hidden). 책상 접근 이름은 그대로", () => {
    render(<Building sessions={[floor1([rest("dev", LONG_IDLE_MS + 700)])]} />);
    const label = screen.getByTestId("desk-dev").getAttribute("aria-label");
    step(10);
    expect(tagOf("dev")).toContain("카페 ↑");
    expect(rider()).toBeNull(); // 아직 문까지 걷는 중
    step(TO_DOOR);
    expect(rider()).toBe("s1\ndev");
    step(UP);
    expect(rider()).toBeNull();
    expect(seated()).toEqual(["dev", null]);
    const seat = document.querySelector('.cafe-seat[data-seat="1"]')!;
    expect(seat.textContent).toContain("dev");
    expect(seat.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(screen.getByTestId("desk-dev").getAttribute("aria-label")).toBe(label);
  });

  it("카페에서 손들면 책상 결정 표시는 첫 렌더부터, 사람은 엘리베이터로 돌아온다(카페에서 손들지 않음)", () => {
    const { rerender } = render(<Building sessions={[floor1([rest("dev", LONG_IDLE_MS + 700)])]} />);
    step(TO_DOOR);
    step(UP);
    expect(seated()).toEqual(["dev", null]);
    rerender(<Building sessions={[floor1([makeMember({ name: "dev", state: "decision", decision: { since: ago(0) } as Member["decision"] })])]} />);
    expect(screen.getByTestId("desk-dev").className).toContain("desk--decision");
    step(TO_DOOR); // 자리에서 문까지 걸은 뒤 탄다
    expect(rider()).toBe("s1\ndev");
    expect(document.querySelector(".cafe-seat .character")?.getAttribute("data-action")).not.toBe("hand_up");
  });

  it("셋째의 1시간이 다른 사람이 타는 중에 와도(자리 꽉 참, 바뀐 것 없음) 탑승은 끝까지 이어진다(7a C1 교훈)", () => {
    // a·b는 이미 1시간, c는 a가 타는 도중 1시간이 된다. 카페 자리는 둘이라 c는 받지 못한다
    render(<Building sessions={[floor1([rest("a", LONG_IDLE_MS + 900), rest("b", LONG_IDLE_MS + 400), rest("c", LONG_IDLE_MS - 2_300)])]} />);
    step(TO_DOOR);
    expect(rider()).toBe("s1\na");
    for (let t = 0; t < UP + 50; t += 250) step(250);
    expect(seated()[0]).toBe("a");
    expect(rider()).toBe("s1\nb");
  });

  it("카페로 타고 가는 중에 일이 생기면 카페에 앉지 않고, 기다리던 out보다 먼저 back으로 바로 돌아온다(P7b-7)", () => {
    const { rerender } = render(<Building sessions={[floor1([rest("a", LONG_IDLE_MS + 900), rest("b", LONG_IDLE_MS + 400)])]} />);
    step(TO_DOOR);
    expect(rider()).toBe("s1\na"); // b는 문 앞에서 기다림
    step(4_000);
    rerender(<Building sessions={[floor1([makeMember({ name: "a", state: "working", lastActivityAt: ago(0) }), rest("b", LONG_IDLE_MS + 400)])]} />);
    for (let t = 0; t < UP; t += 250) step(250);
    expect(rider()).toBe("s1\na");
    expect(seated()).toEqual([null, null]);
  });

  it("로비 「2F ▲」 화살표는 지금 구간 방향: 태우러 올라가는 동안 ▲, 태우고 카페로 내려가는 동안 ▼(reviewer m1)", () => {
    render(<Building sessions={[floor1([rest("dev", LONG_IDLE_MS + 700)])]} />);
    const lift = () => document.querySelector('[data-testid="lift-no"]')!.textContent;
    step(TO_DOOR);
    expect(lift()).toBe("1F ▲"); // 로비 → 1층으로 태우러
    step(RIDE_FLOOR_MS * 2 + 50); // 로비 → 카페 → 1층(2층) 지남
    expect(lift()).toBe("카페 ▼");
  });

  it("움직임 줄이기: 타지 않고 바로 카페 자리", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ media: q, matches: q.includes("reduced-motion"), addEventListener() {}, removeEventListener() {} }));
    render(<Building sessions={[floor1([rest("dev", LONG_IDLE_MS + 700)])]} />);
    step(10);
    expect(rider()).toBeNull();
    expect(seated()).toEqual(["dev", null]);
  });
});
