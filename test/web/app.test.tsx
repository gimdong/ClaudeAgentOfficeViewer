// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeSession, makeSnapshot } from "./fixtures";

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
});
