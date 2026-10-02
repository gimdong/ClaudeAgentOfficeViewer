// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Building } from "../../web/building/Building";
import { DecisionChip } from "../../web/hud/DecisionChip";
import { Elevator } from "../../web/hud/Elevator";
import { decisionQueue } from "../../web/hud/nav";
import { useDecisionAnnouncer } from "../../web/useDecisionAnnouncer";
import { makeMember, makeSession, makeSnapshot } from "./fixtures";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const decide = (name: string, since: string) => makeMember({ name, state: "decision", decision: { kind: "permission", since } });
const sessions = () => [
  makeSession({ id: "a", name: "alpha", floor: 1, members: [makeMember({ name: "team-lead" }), decide("dev", "2026-10-01T05:00:10Z")] }),
  makeSession({ id: "b", name: "beta", floor: 2, members: [decide("team-lead", "2026-10-01T05:00:00Z")] }),
];

describe("decisionQueue", () => {
  it("오래 기다린 결정이 먼저", () => {
    expect(decisionQueue(sessions()).map((q) => `${q.session.id}:${q.member.name}`)).toEqual(["b:team-lead", "a:dev"]);
  });
});

describe("DecisionChip", () => {
  it("결정이 없으면 그리지 않는다", () => {
    render(<DecisionChip snapshot={makeSnapshot({ sessions: [makeSession()], decisionCount: 0 })} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("'결정 대기 N'과 접근성 이름, 누르면 가장 오래 기다린 결정의 보고서를 연다(Phase 2, Ruling P8 되돌림)", () => {
    const s = sessions();
    const opened: HTMLElement[] = [];
    render(
      <>
        <DecisionChip snapshot={makeSnapshot({ sessions: s, decisionCount: 2 })} onOpen={(el) => opened.push(el)} />
        <Building sessions={s} />
      </>,
    );
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const chip = screen.getByRole("button", { name: "결정 대기 2건, 다음 요청 열기" });
    expect(chip.textContent).toBe("결정 대기 2");
    expect(chip.getAttribute("aria-haspopup")).toBe("dialog");
    fireEvent.click(chip);
    expect(opened).toEqual([chip]);
    expect(scroll).not.toHaveBeenCalled();
  });

  it("보고서 없이 그린 칩(onOpen 없음)은 가장 오래 기다린 층으로 스크롤만 한다", () => {
    const s = sessions();
    render(
      <>
        <DecisionChip snapshot={makeSnapshot({ sessions: s, decisionCount: 2 })} />
        <Building sessions={s} />
      </>,
    );
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const chip = screen.getByRole("button", { name: "결정 대기 2건, 다음 요청 열기" });
    expect(chip.textContent).toBe("결정 대기 2");
    chip.focus();
    fireEvent.click(chip);
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0]).toBe(document.getElementById("floor-b"));
    expect(scroll).toHaveBeenCalledWith({ block: "start", behavior: "smooth" });
    expect(document.activeElement).toBe(chip);
  });
});

describe("Elevator", () => {
  it("층마다 버튼(위층부터), 결정 대기 층은 노란 LED와 이름에 표시, 누르면 그 층 접기 버튼에 포커스", () => {
    const s = sessions();
    render(
      <>
        <Elevator sessions={s} />
        <Building sessions={s} />
      </>,
    );
    Element.prototype.scrollIntoView = vi.fn();
    const nav = screen.getByRole("navigation", { name: "층 바로가기" });
    const buttons = [...nav.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["2F", "1F"]);
    expect(buttons[0].getAttribute("aria-label")).toBe("2층 beta, 결정 대기");
    expect(buttons[0].querySelector(".led")!.className).toContain("led--decision");
    fireEvent.click(buttons[1]);
    expect(document.activeElement).toBe(document.getElementById("floor-a")!.querySelector(".fold"));
  });

  it("움직임 줄이기면 즉시 이동", () => {
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
    fireEvent.click(screen.getByRole("button", { name: "1층 alpha, 결정 대기" }));
    expect(scroll).toHaveBeenCalledWith({ block: "start", behavior: "auto" });
    vi.unstubAllGlobals();
  });
});

describe("useDecisionAnnouncer", () => {
  it("새 결정이 생길 때만 한 번 알린다", () => {
    const one = makeSnapshot({ sessions: [makeSession({ id: "a", floor: 3, members: [makeMember({ name: "team-lead" })] })] });
    const two = makeSnapshot({ sessions: [makeSession({ id: "a", floor: 3, members: [decide("team-lead", "2026-10-01T05:00:00Z")] })], decisionCount: 1 });
    const { result, rerender } = renderHook(({ s }) => useDecisionAnnouncer(s), { initialProps: { s: one } });
    expect(result.current.text).toBe("");
    act(() => rerender({ s: two }));
    expect(result.current.text).toBe("3F team-lead이(가) 결정을 기다립니다");
    act(() => rerender({ s: { ...two, generatedAt: "later" } }));
    expect(result.current.text).toBe("3F team-lead이(가) 결정을 기다립니다");
  });

  it("같은 사람의 두 번째 결정도 다시 알린다(Ruling P16 — 텍스트가 같아도 n이 늘어난다)", () => {
    const none = makeSnapshot({ sessions: [makeSession({ id: "a", floor: 3, members: [makeMember({ name: "reviewer" })] })] });
    const withDecision = (since: string) => makeSnapshot({ sessions: [makeSession({ id: "a", floor: 3, members: [decide("reviewer", since)] })], decisionCount: 1 });
    const { result, rerender } = renderHook(({ s }) => useDecisionAnnouncer(s), { initialProps: { s: none } });
    expect(result.current).toEqual({ text: "", n: 0 });
    act(() => rerender({ s: withDecision("2026-10-01T05:00:00Z") }));
    expect(result.current.text).toBe("3F reviewer이(가) 결정을 기다립니다");
    expect(result.current.n).toBe(1);
    act(() => rerender({ s: none })); // 해제
    act(() => rerender({ s: withDecision("2026-10-01T05:10:00Z") })); // 다시 결정 — 문장은 같지만 n이 늘어야 한다
    expect(result.current.text).toBe("3F reviewer이(가) 결정을 기다립니다");
    expect(result.current.n).toBe(2);
  });
});
