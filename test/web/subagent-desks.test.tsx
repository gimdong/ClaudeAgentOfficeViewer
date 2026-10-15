// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentDesk } from "../../src/shared/types";
import { Floor } from "../../web/building/Floor";
import { TEXT as POLICY_TEXT } from "../../web/policy/text";
import { makeMember, makeSession } from "./fixtures";

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const sub = (p: Partial<SubagentDesk> = {}): SubagentDesk => ({ id: "a0000000000000001", type: "Explore", description: "API 문서 조사", model: "claude-sonnet-5-5", tokens: 12_300, working: true, ...p });
const floor = (subagents: SubagentDesk[] | undefined, p: Parameters<typeof makeSession>[0] = {}) =>
  makeSession({ members: [makeMember({ name: "team-lead", role: "lead" }), makeMember({ name: "developer" })], ...(subagents ? { subagents } : {}), ...p });
const subDesks = () => [...document.querySelectorAll<HTMLElement>(".desk--sub")];

describe("임시 책상(서브에이전트 임시 책상 SPEC)", () => {
  it("리드 바로 오른쪽 묶음, 누를 수 없는 그림(role=img, tabindex 없음), 이름표·두 줄·aria·툴팁 세 줄(§1·§5·§6)", () => {
    render(<Floor session={floor([sub(), sub({ id: "a0000000000000002", description: "테스트 로그\n  정리", type: "general-purpose", model: undefined, tokens: 800, working: false })])} />);
    const group = document.querySelector(".sub-desks")!;
    expect(group.previousElementSibling?.getAttribute("data-testid")).toBe("desk-team-lead");
    expect(group.nextElementSibling?.getAttribute("data-testid")).toBe("desk-developer");
    const [w, e] = subDesks();
    for (const d of [w, e]) {
      expect(d.tagName).toBe("DIV");
      expect(d.getAttribute("role")).toBe("img");
      expect(d.hasAttribute("tabindex")).toBe(false);
      expect(d.querySelector(".sub-tag")!.textContent).toBe("임시");
    }
    expect(w.querySelector(".nametag")!.textContent).toBe("API 문서 조사");
    expect([...w.querySelectorAll(".desk-meta > span")].map((x) => x.textContent)).toEqual(["Explore", "Sonnet 5.5 · 12.3k"]);
    expect(w.getAttribute("aria-label")).toBe("임시 책상, 서브에이전트 Explore, 일하는 중, 맡긴 일: API 문서 조사, Sonnet 5.5, 토큰 12.3k");
    expect(w.getAttribute("title")).toBe("서브에이전트(리드가 잠깐 부른 도우미)\n맡긴 일: API 문서 조사\nExplore · Sonnet 5.5 · 토큰 12.3k");
    expect(w.className).toContain("state-working");
    // 끝남: 빈 의자, 1줄 끝 "· 끝남", 줄바꿈·연속 공백은 공백 하나로
    expect(e.className).toContain("desk--sub-done");
    expect(e.querySelector('[data-testid="empty-chair"]')).not.toBeNull();
    expect(e.querySelector(".nametag")!.textContent).toBe("테스트 로그 정리");
    expect([...e.querySelectorAll(".desk-meta > span")].map((x) => x.textContent)).toEqual(["general-purpose · 끝남", "800"]);
    expect(e.getAttribute("aria-label")).toBe("임시 책상, 서브에이전트 general-purpose, 맡긴 일: 테스트 로그 정리, 끝남");
    expect(e.getAttribute("title")).toBe("서브에이전트(리드가 잠깐 부른 도우미)\n맡긴 일: 테스트 로그 정리\ngeneral-purpose · 토큰 800 · 끝남");
  });

  it("최대 4개, 넘치면 `+N` 칩(누를 수 없음, '서브에이전트 N명 더')(§7)", () => {
    render(<Floor session={floor(Array.from({ length: 6 }, (_, i) => sub({ id: `a00000000000000${i}`, description: `일 ${i}` })))} />);
    expect(subDesks().map((d) => d.querySelector(".nametag")!.textContent)).toEqual(["일 0", "일 1", "일 2", "일 3"]);
    const chip = document.querySelector<HTMLElement>(".sub-more")!;
    expect(chip.textContent).toBe("+2");
    expect([chip.getAttribute("role"), chip.getAttribute("aria-label"), chip.getAttribute("title"), chip.hasAttribute("tabindex")]).toEqual(["img", "서브에이전트 2명 더", "서브에이전트 2명 더", false]);
    expect(subDesks().at(-1)!.nextElementSibling).toBe(chip);
  });

  it("값이 없을 때: 맡긴 일·종류 없음 → '서브에이전트'·'종류 모름', 모델 없고 토큰 0 → 둘째 줄 없음", () => {
    render(<Floor session={floor([sub({ type: "", description: "", model: undefined, tokens: 0 })])} />);
    const [d] = subDesks();
    expect(d.querySelector(".nametag")!.textContent).toBe("서브에이전트");
    expect([...d.querySelectorAll(".desk-meta > span")].map((x) => x.textContent)).toEqual(["종류 모름"]);
    expect(d.getAttribute("aria-label")).toBe("임시 책상, 서브에이전트 종류 모름, 일하는 중");
    expect(d.getAttribute("title")).toBe("서브에이전트(리드가 잠깐 부른 도우미)\n종류 모름");
  });

  it("맡긴 일이 없으면 종류가 이름표", () => {
    render(<Floor session={floor([sub({ description: "" })])} />);
    expect(subDesks()[0].querySelector(".nametag")!.textContent).toBe("Explore");
  });

  it("휴업 층: working이어도 빈 의자, 모니터 꺼짐, 타이핑 없음(§4)", () => {
    render(<Floor session={floor([sub()], { floorStatus: "paused", pausedDenied: 0 })} />);
    const [d] = subDesks();
    expect(d.querySelector('[data-testid="empty-chair"]')).not.toBeNull();
    expect(d.querySelector(".frame-b")).toBeNull();
    expect(d.className).not.toContain("state-working");
    // 그림이 빈 의자이므로 "일하는 중"이라 읽지 않는다. 휴업 층 책상(Desk)의 그림 상태와 같은 말(B177 M3)
    expect(d.getAttribute("aria-label")).toBe("임시 책상, 서브에이전트 Explore, 대기, 맡긴 일: API 문서 조사, Sonnet 5.5, 토큰 12.3k");
  });

  it("서브에이전트가 없으면 묶음이 없다", () => {
    render(<Floor session={floor(undefined)} />);
    expect(document.querySelector(".sub-desks")).toBeNull();
    cleanup();
    render(<Floor session={floor([])} />);
    expect(document.querySelector(".sub-desks")).toBeNull();
  });

  it("호버·포커스해도 말풍선을 띄우지 않는다(리드 말풍선에 합쳐 보임)", () => {
    const bubble = { enter: vi.fn(), leave: vi.fn(), focus: vi.fn(), blur: vi.fn() };
    render(<Floor session={floor([sub()])} bubble={bubble as never} />);
    const [d] = subDesks();
    fireEvent.mouseEnter(d);
    fireEvent.focus(d);
    expect(bubble.enter).not.toHaveBeenCalled();
    expect(bubble.focus).not.toHaveBeenCalled();
    expect(within(screen.getByTestId("floor")).getAllByRole("img", { name: /^임시 책상/ })).toHaveLength(1);
  });

  it("리드 패널의 서브에이전트 설명이 임시 책상을 가리킨다(B174 F1)", () => {
    expect(POLICY_TEXT.subsHelp).toBe("리드가 띄운 서브에이전트는 일하는 동안 리드 책상 옆 임시 책상에 보입니다. 종류마다 따로 정할 수 있습니다.");
  });
});
