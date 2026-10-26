// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Desk } from "../../web/office/Desk";
import { OpenDecisionContext } from "../../web/report/useDecisions";
import { NEON } from "../../web/pixel/palette";
import { loadTheme } from "../../web/themes/registry";
import { makeMember, makeSession } from "./fixtures";

afterEach(cleanup);
// Phase 7 Task 5: 캐릭터는 층 시트 div(.character[data-action]), 모니터는 책상 그림 칸(.desk-front.monitor-<상태>)
const act = (d: HTMLElement) => d.querySelector(".character")?.getAttribute("data-action") ?? null;
const monitor = (d: HTMLElement) => /monitor-(\w+)/.exec(d.querySelector(".desk-front")?.getAttribute("class") ?? "")?.[1];

describe("Desk", () => {
  it("working: ⌨ 말풍선, 일하는 모니터, type 동작과 오라", () => {
    render(<Desk member={makeMember({ state: "working" })} />);
    const desk = screen.getByTestId("desk-developer");
    expect(desk.className).toContain("state-working");
    expect(within(desk).getByTestId("bubble").textContent).toBe("⌨");
    expect(monitor(desk)).toBe("work");
    expect(act(desk)).toBe("type");
    expect(desk.querySelector(".aura")).not.toBeNull();
  });

  it("idle: z z 말풍선, 쉬는 모니터, idle 동작, 오라 없음", () => {
    render(<Desk member={makeMember({ state: "idle" })} />);
    const desk = screen.getByTestId("desk-developer");
    expect(within(desk).getByTestId("bubble").textContent).toBe("z z");
    expect(monitor(desk)).toBe("rest");
    expect(act(desk)).toBe("idle");
    expect(desk.querySelector(".aura")).toBeNull();
  });

  it("mail: ✉와 안 읽은 개수, think 동작·모니터", () => {
    render(<Desk member={makeMember({ state: "mail", unread: 2 })} />);
    const desk = screen.getByTestId("desk-developer");
    expect(within(desk).getByTestId("bubble").textContent).toBe("✉2");
    expect([act(desk), monitor(desk)]).toEqual(["think", "think"]);
  });

  it("offline: 빈 의자, 말풍선 없음", () => {
    render(<Desk member={makeMember({ state: "offline" })} />);
    const desk = screen.getByTestId("desk-developer");
    expect(within(desk).queryByTestId("bubble")).toBeNull();
    expect(within(desk).getByTestId("empty-chair")).toBeTruthy();
    expect(act(desk)).toBeNull();
    expect(monitor(desk)).toBe("rest");
  });

  it("장면 그림(의자·책상·캐릭터)은 aria-hidden 칸 안이고 책상 접근 이름은 그대로", () => {
    render(<Desk member={makeMember({ state: "working" })} />);
    const desk = screen.getByTestId("desk-developer");
    const scene = desk.querySelector(".desk-scene")!;
    expect(scene.getAttribute("aria-hidden")).toBe("true");
    for (const q of [".chair", ".character", ".desk-front"]) expect(scene.querySelector(q), q).not.toBeNull();
    // 겹침 순서(뒤 → 앞): 의자 → 오라 → 캐릭터 → 책상
    expect([...scene.children].map((e) => e.classList[1] ?? e.classList[0])).toEqual(["chair", "aura", "character", "desk-front"]);
    expect(desk.getAttribute("aria-label")).toBe("developer, 작업 중");
  });

  it("책상 그림은 장면 시트 칸 좌표로 자르고, 리드 책상은 리드 칸", () => {
    const layout = loadTheme("office").slots.desk.day.layout!;
    render(<Desk member={makeMember({ state: "decision", decision: { kind: "permission", since: "t" } })} lead />);
    const front = screen.getByTestId("desk-developer").querySelector(".desk-front") as HTMLElement;
    const [x, y, w, h] = layout.slots["desk-lead-ask"];
    expect([front.style.getPropertyValue("--sx"), front.style.getPropertyValue("--sy"), front.style.getPropertyValue("--sw"), front.style.getPropertyValue("--sh")]).toEqual([`${x}`, `${y}`, `${w}`, `${h}`]);
    const chair = screen.getByTestId("desk-developer").querySelector(".chair") as HTMLElement;
    expect(chair.className).toContain("chair-lead");
    expect(chair.style.getPropertyValue("--sx")).toBe(`${layout.slots["chair-lead"][0]}`);
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
    expect(act(desk)).toBe("hand_up");
    expect(desk.querySelector(".qmark")).not.toBeNull();
    expect(desk.querySelector(".q-ring")).not.toBeNull();
    expect(desk.querySelector(".nametag")!.textContent).toBe("developer · 열기");
    expect(within(desk).queryByTestId("bubble")).toBeNull();
    expect(monitor(desk)).toBe("ask");
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

  it("같은 이름은 다시 그려도 같은 모습(variantIndex)", () => {
    const look = () => (screen.getByTestId("desk-developer").querySelector(".character") as HTMLElement).style.backgroundImage;
    const { rerender } = render(<Desk member={makeMember({ state: "idle" })} />);
    const first = look();
    rerender(<Desk member={makeMember({ state: "mail" })} />);
    expect(look()).toBe(first);
  });

  it("CSS로 움직이는 .qmark 그룹에는 transform 속성이 없다", () => {
    render(<Desk member={makeMember({ state: "decision", decision: { kind: "plan", since: "t" } })} />);
    const desk = screen.getByTestId("desk-developer");
    expect(desk.querySelector(".qmark")!.getAttribute("transform")).toBeNull();
  });

  it("휴업이면 말머리를 숨기고 모니터를 끄고 빈 의자", () => {
    render(<Desk member={makeMember({ state: "working" })} paused />);
    const desk = screen.getByTestId("desk-developer");
    expect(desk.className).toContain("state-idle");
    expect(within(desk).queryByTestId("bubble")).toBeNull();
    expect(monitor(desk)).toBe("rest");
    expect(act(desk)).toBeNull();
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
