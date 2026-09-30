// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Desk } from "../../web/office/Desk";
import { OfficeGrid } from "../../web/office/OfficeGrid";
import { OfficeTile } from "../../web/office/OfficeTile";
import { NEON } from "../../web/pixel/palette";
import { makeMember, makeSession } from "./fixtures";

afterEach(cleanup);

describe("Desk", () => {
  it("working: ⌨ 말풍선, 켜진 모니터, 타이핑 프레임", () => {
    render(<Desk member={makeMember({ state: "working" })} />);
    const desk = screen.getByTestId("desk-developer");
    expect(desk.className).toContain("state-working");
    expect(within(desk).getByTestId("bubble").textContent).toBe("⌨");
    expect(within(desk).getByTestId("screen").getAttribute("fill")).toBe(NEON.screenOn);
    expect(desk.querySelector(".frame-b")).not.toBeNull();
  });

  it("idle: z z 말풍선, 꺼진 모니터, 타이핑 프레임 없음", () => {
    render(<Desk member={makeMember({ state: "idle" })} />);
    const desk = screen.getByTestId("desk-developer");
    expect(within(desk).getByTestId("bubble").textContent).toBe("z z");
    expect(within(desk).getByTestId("screen").getAttribute("fill")).toBe(NEON.screenOff);
    expect(desk.querySelector(".frame-b")).toBeNull();
  });

  it("mail: ✉와 안 읽은 개수", () => {
    render(<Desk member={makeMember({ state: "mail", unread: 2 })} />);
    expect(within(screen.getByTestId("desk-developer")).getByTestId("bubble").textContent).toBe("✉2");
  });

  it("offline: 빈 의자, 말풍선 없음", () => {
    render(<Desk member={makeMember({ state: "offline" })} />);
    const desk = screen.getByTestId("desk-developer");
    expect(within(desk).queryByTestId("bubble")).toBeNull();
    expect(within(desk).getByTestId("empty-chair")).toBeTruthy();
  });

  it("팝오버를 그리지 않는다(디자인 A4) — 모델·토큰은 말풍선 보조 줄로 옮겼다", () => {
    render(<Desk member={makeMember({ model: "sonnet" })} />);
    const desk = screen.getByTestId("desk-developer");
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(desk.querySelector(".popover")).toBeNull();
    expect(desk.querySelector(".nametag")!.textContent).toBe("developer");
  });

  it("평소 책상은 포커스 가능한 img이고 aria-label이 '{이름}, {상태}'", () => {
    render(<Desk member={makeMember({ state: "working" })} />);
    const desk = screen.getByTestId("desk-developer");
    expect(desk.tagName).toBe("DIV");
    expect(desk.getAttribute("role")).toBe("img");
    expect(desk.getAttribute("tabindex")).toBe("0");
    expect(desk.getAttribute("aria-label")).toBe("developer, 작업 중");
  });

  it("결정 대기(Phase 1): 누를 수 있다는 신호 없이 손든 캐릭터와 ?, 켜진 모니터, 말머리 없음", () => {
    render(<Desk member={makeMember({ state: "decision", decision: { kind: "permission", since: "t" } })} />);
    const desk = screen.getByTestId("desk-developer");
    expect(desk.tagName).toBe("DIV");
    expect(desk.getAttribute("role")).toBe("img");
    expect(desk.getAttribute("tabindex")).toBe("0");
    expect(desk.className).toContain("desk--decision");
    expect(desk.className).toContain("state-decision");
    expect(desk.getAttribute("aria-label")).toBe("developer, 결정 필요");
    expect(desk.getAttribute("aria-haspopup")).toBeNull();
    expect(desk.getAttribute("title")).toBeNull();
    expect(desk.querySelector(".hand .hop")).not.toBeNull();
    expect(desk.querySelector(".qmark")).not.toBeNull();
    expect(desk.querySelector(".q-ring")).toBeNull();
    expect(within(desk).queryByTestId("bubble")).toBeNull();
    expect(within(desk).getByTestId("screen").getAttribute("fill")).toBe(NEON.screenOn);
  });

  it("손든 캐릭터는 BODY_UP이다: 8번째 열 0행(손)이 피부색", () => {
    render(<Desk member={makeMember({ state: "decision", decision: { kind: "question", since: "t" } })} />);
    const hop = screen.getByTestId("desk-developer").querySelector(".hop")!;
    const hand = [...hop.querySelectorAll("rect")].find((r) => r.getAttribute("x") === "7" && r.getAttribute("y") === "0");
    expect(hand?.getAttribute("fill")).toBe(NEON.skin);
  });

  it("CSS로 움직이는 .hop, .qmark 그룹에는 transform 속성이 없다", () => {
    render(<Desk member={makeMember({ state: "decision", decision: { kind: "plan", since: "t" } })} />);
    const desk = screen.getByTestId("desk-developer");
    expect(desk.querySelector(".hop")!.getAttribute("transform")).toBeNull();
    expect(desk.querySelector(".qmark")!.getAttribute("transform")).toBeNull();
  });

  it("휴업이면 말머리를 숨기고 모니터를 끄고 idle 모습", () => {
    render(<Desk member={makeMember({ state: "working" })} paused />);
    const desk = screen.getByTestId("desk-developer");
    expect(desk.className).toContain("state-idle");
    expect(within(desk).queryByTestId("bubble")).toBeNull();
    expect(within(desk).getByTestId("screen").getAttribute("fill")).toBe(NEON.screenOff);
    expect(desk.querySelector(".frame-b")).toBeNull();
  });

  it("마우스·포커스·터치를 말풍선 핸들러에 key와 함께 넘긴다", () => {
    const bubble = { enter: vi.fn(), leave: vi.fn(), focus: vi.fn(), blur: vi.fn() };
    render(<Desk member={makeMember()} bubbleKey="s1:developer" bubble={bubble} />);
    const desk = screen.getByTestId("desk-developer");
    fireEvent.mouseEnter(desk);
    fireEvent.mouseLeave(desk);
    fireEvent.focus(desk);
    fireEvent.blur(desk);
    fireEvent.pointerDown(desk, { pointerType: "touch" });
    expect(bubble.enter).toHaveBeenCalledWith(desk, "s1:developer");
    expect(bubble.leave).toHaveBeenCalledTimes(1);
    expect(bubble.focus).toHaveBeenCalledTimes(2);
    expect(bubble.blur).toHaveBeenCalledTimes(1);
  });
});

describe("OfficeTile", () => {
  it("현재 세션 별표, CTX 잔여 바, 추정 표시", () => {
    render(<OfficeTile session={makeSession({ isCurrent: true, context: { used: 60000, window: 200000, pct: 30, estimated: true } })} />);
    const tile = screen.getByTestId("office");
    expect(tile.textContent).toContain("★");
    expect(within(tile).getByRole("meter").getAttribute("aria-valuenow")).toBe("70");
    expect(tile.textContent).toContain("추정");
  });

  it("종료된 세션은 off 클래스, stale이면 경고, context가 없으면 --", () => {
    render(<OfficeTile session={makeSession({ alive: false, stale: true, context: null })} />);
    const tile = screen.getByTestId("office");
    expect(tile.className).toContain("off");
    expect(tile.textContent).toContain("갱신 지연");
    expect(tile.textContent).toContain("CTX --");
  });

  it("팀원 수만큼 책상을 그린다", () => {
    render(<OfficeTile session={makeSession({ members: [makeMember({ name: "team-lead" }), makeMember({ name: "developer" }), makeMember({ name: "reviewer" })] })} />);
    expect(screen.getAllByTestId(/^desk-/)).toHaveLength(3);
  });
});

describe("OfficeGrid", () => {
  it("세션이 없으면 안내 문구", () => {
    render(<OfficeGrid sessions={[]} />);
    expect(screen.getByText("실행 중인 Claude Code 세션이 없습니다")).toBeTruthy();
  });

  it("세션 순서대로 타일을 그린다", () => {
    render(<OfficeGrid sessions={[makeSession({ id: "a", name: "first" }), makeSession({ id: "b", name: "second" })]} />);
    expect(screen.getAllByTestId("office").map((t) => t.getAttribute("aria-label"))).toEqual(["first 사무실", "second 사무실"]);
  });
});
