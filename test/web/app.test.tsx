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

  it("error가 있으면 배너를 띄우고 HUD와 사무실을 그린다", () => {
    state.value = { snapshot: makeSnapshot({ error: "Claude 데이터 폴더를 읽을 수 없습니다: /x", sessions: [makeSession()] }), live: true };
    render(<App />);
    expect(screen.getByRole("alert").textContent).toContain("/x");
    expect(screen.getByText("● LIVE")).toBeTruthy();
    expect(screen.getAllByTestId("floor")).toHaveLength(1);
    expect(screen.getByTestId("vacant-floor")).toBeTruthy();
  });

  it("새 결정이 생기면 상태 알림 영역이 새 노드로 바뀐다(Ruling P16)", () => {
    const base = makeSession({ id: "a", floor: 3, members: [makeMember({ name: "reviewer" })] });
    state.value = { snapshot: makeSnapshot({ sessions: [base] }), live: true };
    const { rerender } = render(<App />);
    const before = screen.getByRole("status");

    const decided = makeSession({ id: "a", floor: 3, members: [makeMember({ name: "reviewer", state: "decision", decision: { kind: "permission", since: "2026-10-01T05:00:00Z" } })] });
    state.value = { snapshot: makeSnapshot({ sessions: [decided], decisionCount: 1 }), live: true };
    rerender(<App />);
    const after = screen.getByRole("status");

    expect(after).not.toBe(before);
    expect(after.textContent).toBe("3F reviewer이(가) 결정을 기다립니다");
  });
});
