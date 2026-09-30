// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { placeBubble } from "../../web/bubble/place";
import { makeMember, makeSession, makeSnapshot } from "./fixtures";

const state = vi.hoisted(() => ({ value: { snapshot: null as unknown, live: true } }));
vi.mock("../../web/useSnapshot", () => ({ useSnapshot: () => state.value }));

import { App } from "../../web/App";

describe("placeBubble (디자인 7.4)", () => {
  const base = { deskLeft: 400, deskTop: 500, w: 200, h: 40, viewportW: 1200, hudBottom: 100 };

  it("캐릭터 머리 위 가운데", () => {
    expect(placeBubble(base)).toEqual({ left: 336, top: 478, below: false, tailX: 100 });
  });

  it("화면 가장자리에서 8px 안쪽으로 밀고, 꼬리는 캐릭터를 가리킨다", () => {
    expect(placeBubble({ ...base, deskLeft: 0 })).toMatchObject({ left: 8, tailX: 28 });
    expect(placeBubble({ ...base, deskLeft: 1150 })).toMatchObject({ left: 992, tailX: 188 });
  });

  it("HUD 아래 4px보다 위로 올라가면 캐릭터 아래로 뒤집는다", () => {
    expect(placeBubble({ ...base, deskTop: 120 })).toEqual({ left: 336, top: 206, below: true, tailX: 100 });
  });

  it("꼬리는 말풍선 양 끝 12px 안쪽", () => {
    expect(placeBubble({ ...base, deskLeft: -100 }).tailX).toBe(12);
  });
});

describe("ActivityBubble (디자인 7.5)", () => {
  const T = Date.parse("2026-10-01T05:00:00Z");
  const snap = (dev = makeMember({ name: "dev", state: "working", model: "m", activity: { kind: "tool", tool: "Bash", target: "테스트 실행", startedAt: new Date(T - 3000).toISOString() } })) =>
    makeSnapshot({ sessions: [makeSession({ id: "s1", members: [makeMember({ name: "team-lead", state: "idle" }), dev] })] });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T);
    state.value = { snapshot: snap(), live: true };
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const say = () => document.getElementById("say");

  it("마우스를 올리면 150ms 뒤에 문장과 보조 줄을 보여주고, 내리면 100ms 뒤에 숨긴다", () => {
    render(<App />);
    const desk = screen.getByTestId("desk-dev");
    fireEvent.mouseEnter(desk);
    act(() => vi.advanceTimersByTime(149));
    expect(say()).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(say()!.getAttribute("role")).toBe("tooltip");
    expect(say()!.querySelector(".text")!.textContent).toBe("저는 지금 「테스트 실행」 명령을 실행하고 있습니다");
    expect(say()!.querySelector(".meta")!.textContent).toBe("m · 토큰 0 · 3초째");
    expect(desk.getAttribute("aria-describedby")).toBe("say");
    fireEvent.mouseLeave(desk);
    act(() => vi.advanceTimersByTime(99));
    expect(say()).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(say()).toBeNull();
    expect(desk.getAttribute("aria-describedby")).toBeNull();
  });

  it("보이는 중에 다른 캐릭터로 옮기면 바로 바뀐다", () => {
    render(<App />);
    fireEvent.mouseEnter(screen.getByTestId("desk-dev"));
    act(() => vi.advanceTimersByTime(150));
    fireEvent.mouseLeave(screen.getByTestId("desk-dev"));
    fireEvent.mouseEnter(screen.getByTestId("desk-team-lead"));
    expect(say()!.querySelector(".text")!.textContent).toBe("저는 지금 다음 지시를 기다리고 있습니다");
    expect(document.querySelectorAll("#say")).toHaveLength(1);
  });

  it("키보드 포커스는 즉시 보이고, 포커스를 잃거나 Esc·스크롤이면 숨긴다", () => {
    render(<App />);
    const desk = screen.getByTestId("desk-dev");
    fireEvent.focus(desk);
    expect(say()).not.toBeNull();
    fireEvent.blur(desk);
    expect(say()).toBeNull();
    fireEvent.focus(desk);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(say()).toBeNull();
    fireEvent.focus(desk);
    fireEvent.scroll(window);
    expect(say()).toBeNull();
  });

  it("보이는 중에 스냅샷이 바뀌면 문장만 바꾼다", () => {
    const { rerender } = render(<App />);
    fireEvent.focus(screen.getByTestId("desk-dev"));
    state.value = { snapshot: snap(makeMember({ name: "dev", state: "working", activity: { kind: "tool", tool: "Read", target: "/x/SPEC.md", startedAt: new Date(T).toISOString() } })), live: true };
    rerender(<App />);
    expect(say()!.querySelector(".text")!.textContent).toBe("저는 지금 「SPEC.md」 파일을 읽고 있습니다");
  });

  it("결정 대기면 노란 말풍선(q)과 안내 보조 줄", () => {
    state.value = { snapshot: snap(makeMember({ name: "dev", state: "decision", decision: { kind: "question", since: new Date(T).toISOString() } })), live: true };
    render(<App />);
    fireEvent.focus(screen.getByTestId("desk-dev"));
    expect(say()!.className).toContain("q");
    expect(say()!.querySelector(".text")!.textContent).toBe("저는 지금 질문에 대한 답을 기다리고 있습니다");
    expect(say()!.querySelector(".meta")!.textContent).toBe("결정 보고서는 다음 버전에서 열립니다");
  });

  it("경과 초는 1초마다 바뀐다", () => {
    render(<App />);
    fireEvent.focus(screen.getByTestId("desk-dev"));
    act(() => vi.advanceTimersByTime(2000));
    expect(say()!.querySelector(".meta")!.textContent).toBe("m · 토큰 0 · 5초째");
  });

  it("대상 캐릭터가 스냅샷에서 사라지면 숨긴다", () => {
    const { rerender } = render(<App />);
    fireEvent.focus(screen.getByTestId("desk-dev"));
    state.value = { snapshot: makeSnapshot({ sessions: [makeSession({ id: "s1", members: [makeMember({ name: "team-lead" })] })] }), live: true };
    rerender(<App />);
    expect(say()).toBeNull();
  });

  it("터치 탭을 두 번 눌러도(멱등) 같은 결과다 (Task 10 이월 확인)", () => {
    render(<App />);
    const desk = screen.getByTestId("desk-dev");
    fireEvent.pointerDown(desk, { pointerType: "touch" });
    fireEvent.pointerDown(desk, { pointerType: "touch" });
    expect(document.querySelectorAll("#say")).toHaveLength(1);
    expect(say()!.querySelector(".text")!.textContent).toBe("저는 지금 「테스트 실행」 명령을 실행하고 있습니다");
    expect(desk.getAttribute("aria-describedby")).toBe("say");
  });
});
