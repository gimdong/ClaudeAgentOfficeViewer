// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Desk } from "../../web/office/Desk";
import { OpenDecisionContext } from "../../web/report/useDecisions";
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

  it("결정 대기(Phase 2): 큐의 id가 있으면 보고서를 여는 버튼이고, 손든 캐릭터와 ?, QRING, 켜진 모니터, 말머리 없음", () => {
    const opened: Array<[string, HTMLElement | null | undefined]> = [];
    render(
      <OpenDecisionContext.Provider value={(id, el) => opened.push([id, el])}>
        <Desk member={makeMember({ state: "decision", decision: { kind: "permission", since: "t", id: "d1", deadline: "2999-01-01T00:00:00.000Z" } })} />
      </OpenDecisionContext.Provider>,
    );
    const desk = screen.getByTestId("desk-developer");
    expect(desk.tagName).toBe("BUTTON");
    expect(desk.getAttribute("type")).toBe("button");
    expect(desk.getAttribute("role")).toBeNull();
    expect(desk.className).toContain("desk--decision");
    expect(desk.className).toContain("state-decision");
    expect(desk.getAttribute("aria-label")).toBe("developer, 결정 필요. 결정 보고서 열기");
    expect(desk.getAttribute("aria-haspopup")).toBe("dialog");
    expect(desk.getAttribute("title")).toBeNull();
    expect(desk.querySelector(".hand .hop")).not.toBeNull();
    expect(desk.querySelector(".qmark")).not.toBeNull();
    expect(desk.querySelector(".q-ring")).not.toBeNull();
    expect(desk.querySelector(".nametag")!.textContent).toBe("developer · 열기");
    expect(within(desk).queryByTestId("bubble")).toBeNull();
    expect(within(desk).getByTestId("screen").getAttribute("fill")).toBe(NEON.screenOn);
    fireEvent.click(desk);
    expect(opened).toEqual([["d1", desk]]);
  });

  it("id가 없는 결정 대기(큐 없이 만든 스냅샷)는 누를 수 없는 div로 둔다", () => {
    render(<Desk member={makeMember({ state: "decision", decision: { kind: "permission", since: "t" } })} />);
    const desk = screen.getByTestId("desk-developer");
    expect(desk.tagName).toBe("DIV");
    expect(desk.getAttribute("role")).toBe("img");
    expect(desk.getAttribute("tabindex")).toBe("0");
    expect(desk.getAttribute("aria-label")).toBe("developer, 결정 필요");
    expect(desk.getAttribute("aria-haspopup")).toBeNull();
    expect(desk.querySelector(".q-ring")).toBeNull();
    expect(desk.querySelector(".qmark")).not.toBeNull();
  });

  it("남은 시간이 60초 이하이면 급함(urgent) 표시이고 ?가 분홍 팔레트다", () => {
    const soon = new Date(Date.now() + 30_000).toISOString();
    render(<Desk member={makeMember({ state: "decision", decision: { kind: "permission", since: "t", id: "d1", deadline: soon } })} />);
    const desk = screen.getByTestId("desk-developer");
    expect(desk.className).toContain("urgent");
    const fills = new Set([...desk.querySelectorAll(".qmark rect")].map((r) => r.getAttribute("fill")));
    expect(fills).toEqual(new Set([NEON.pink, NEON.pinkDeep]));
  });

  it("급하지 않으면 ?는 노랑 팔레트다", () => {
    const later = new Date(Date.now() + 300_000).toISOString();
    render(<Desk member={makeMember({ state: "decision", decision: { kind: "permission", since: "t", id: "d1", deadline: later } })} />);
    const fills = new Set([...screen.getByTestId("desk-developer").querySelectorAll(".qmark rect")].map((r) => r.getAttribute("fill")));
    expect(fills).toEqual(new Set([NEON.yellow, NEON.yellowDeep]));
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
