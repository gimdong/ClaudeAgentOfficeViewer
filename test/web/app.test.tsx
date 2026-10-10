// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeMember, makeSession, makeSnapshot } from "./fixtures";

const state = vi.hoisted(() => ({ value: { snapshot: null as unknown, live: false } }));
vi.mock("../../web/useSnapshot", () => ({ useSnapshot: () => state.value }));

import { App } from "../../web/App";

afterEach(cleanup);

describe("App", () => {
  it("스냅샷을 받기 전에는 로딩 문구", () => {
    state.value = { snapshot: null, live: false };
    render(<App />);
    expect(screen.getByText("사무실 불 켜는 중...")).toBeTruthy();
  });

  it("FB-7: 서버 버전이 화면과 다르거나(옛 서버) 없으면 \"다시 켜 주세요\" 띠를 띄우고, 같으면 띄우지 않는다", () => {
    const note = "새 버전이 설치됐습니다. 대시보드를 껐다 다시 켜 주세요(지금 화면은 새 버전, 서버는 이전 버전입니다).";
    state.value = { snapshot: makeSnapshot({ serverVersion: undefined, sessions: [makeSession()] }), live: true };
    const { rerender, unmount } = render(<App />);
    expect(screen.getByTestId("upgrade-note").textContent).toBe(note);
    expect(screen.getByTestId("upgrade-note").getAttribute("role")).toBeNull(); // status는 하나뿐(phase2 §9.5)
    state.value = { snapshot: makeSnapshot({ serverVersion: "0.0.1", sessions: [makeSession()] }), live: true };
    rerender(<App />);
    expect(screen.getByTestId("upgrade-note").textContent).toBe(note);
    unmount();
    state.value = { snapshot: makeSnapshot({ sessions: [makeSession()] }), live: true }; // fixture 기본값 = 화면 버전
    render(<App />);
    expect(screen.queryByTestId("upgrade-note")).toBeNull();
  });

  it("error가 있으면 배너를 띄우고 HUD와 사무실을 그린다", () => {
    state.value = { snapshot: makeSnapshot({ error: "Claude 데이터 폴더를 읽을 수 없습니다: /x", sessions: [makeSession()] }), live: true };
    render(<App />);
    expect(screen.getByRole("alert").textContent).toContain("/x");
    expect(screen.getByText("● LIVE")).toBeTruthy();
    expect(screen.getAllByTestId("floor")).toHaveLength(1);
    expect(screen.getByTestId("vacant-floor")).toBeTruthy();
  });

  it("새 결정이 생기면 같은 상태 알림 노드의 글자가 바뀐다(Ruling P16 수정 — aria-live는 같은 노드의 내용 변경에만 반응)", () => {
    const base = makeSession({ id: "a", floor: 3, members: [makeMember({ name: "reviewer" })] });
    state.value = { snapshot: makeSnapshot({ sessions: [base] }), live: true };
    const { rerender } = render(<App />);
    const before = screen.getByRole("status");
    const beforeText = before.textContent;

    const decided = makeSession({ id: "a", floor: 3, members: [makeMember({ name: "reviewer", state: "decision", decision: { kind: "permission", since: "2026-10-01T05:00:00Z" } })] });
    state.value = { snapshot: makeSnapshot({ sessions: [decided], decisionCount: 1 }), live: true };
    rerender(<App />);
    const after = screen.getByRole("status");

    expect(after).toBe(before); // 같은 노드를 유지한다
    expect(after.textContent).not.toBe(beforeText); // 글자 자체는 바뀐다
    expect(after.textContent!.trim()).toBe("3F reviewer이(가) 결정을 기다립니다");
  });

  it("같은 사람의 두 번째 결정도 노드 텍스트가 이전과 다르고, trim하면 같은 문장이다(Ruling P16 — NBSP)", () => {
    const none = makeSession({ id: "a", floor: 3, members: [makeMember({ name: "reviewer" })] });
    const decided = (since: string) =>
      makeSession({ id: "a", floor: 3, members: [makeMember({ name: "reviewer", state: "decision", decision: { kind: "permission", since } })] });

    state.value = { snapshot: makeSnapshot({ sessions: [none] }), live: true };
    const { rerender } = render(<App />);

    state.value = { snapshot: makeSnapshot({ sessions: [decided("2026-10-01T05:00:00Z")], decisionCount: 1 }), live: true };
    rerender(<App />);
    const afterFirst = screen.getByRole("status").textContent;

    state.value = { snapshot: makeSnapshot({ sessions: [none] }), live: true }; // 해제
    rerender(<App />);
    state.value = { snapshot: makeSnapshot({ sessions: [decided("2026-10-01T05:10:00Z")], decisionCount: 1 }), live: true }; // 다시 결정
    rerender(<App />);
    const afterSecond = screen.getByRole("status").textContent;

    expect(afterSecond).not.toBe(afterFirst);
    expect(afterFirst!.trim()).toBe("3F reviewer이(가) 결정을 기다립니다");
    expect(afterSecond!.trim()).toBe("3F reviewer이(가) 결정을 기다립니다");
    // 끝에 붙는 한 글자가 일반 공백이 아니라 NBSP(U+00A0)인지 직접 확인한다(최종 리뷰 Important 1) —
    // n=1(첫 결정, 홀수)은 NBSP가 붙고 n=2(두 번째 결정, 짝수)는 안 붙는다. 이걸 일반 공백으로
    // 바꾸면 endsWith("\u00A0")가 false가 되어 이 단언이 회귀를 잡아낸다.
    expect(afterFirst!.endsWith("\u00A0")).toBe(true);
    expect(afterSecond!.endsWith("\u00A0")).toBe(false);
    expect(afterFirst).not.toMatch(/ $/);
  });
});
