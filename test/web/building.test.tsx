// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Building } from "../../web/building/Building";
import { Floor } from "../../web/building/Floor";
import { makeMember, makeSession } from "./fixtures";

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Building", () => {
  it("옥상 아래 빈 층, 그 아래로 층 번호가 큰 층부터, 맨 아래 카페·로비(Task 7)", () => {
    render(<Building sessions={[makeSession({ id: "a", name: "first", floor: 1 }), makeSession({ id: "c", name: "third", floor: 3 }), makeSession({ id: "b", name: "second", floor: 2 })]} />);
    const tower = screen.getByTestId("vacant-floor").parentElement!;
    const order = [...tower.querySelectorAll(":scope > section")].map((s) => (s.getAttribute("data-testid") === "vacant-floor" ? "빈" : s.getAttribute("data-row") === "roof" ? "옥상" : s.querySelector(".fl-no")!.textContent));
    expect(order).toEqual(["옥상", "빈", "3F", "2F", "1F", "카페", "로비"]);
    // 간판 처음 값(디자인 phase6b §11.1, W28). snapshot이 없으면 버튼이 아니다
    expect(screen.getByText("User의 회사")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /빌딩 정보 열기/ })).toBeNull();
  });

  it("세션이 없으면 빈 층과 안내 문구 (v1 OfficeGrid 안내 대체)", () => {
    render(<Building sessions={[]} />);
    expect(screen.getByTestId("vacant-floor")).toBeTruthy();
    expect(screen.getByText("빌딩이 비어 있습니다. 빈 층에서 새 세션을 시작하세요")).toBeTruthy();
    expect(screen.queryAllByTestId("floor")).toHaveLength(0);
  });

  it("빈 층: 팻말, 안내, 비활성 '새 세션 시작'", () => {
    render(<Building sessions={[]} />);
    const v = screen.getByTestId("vacant-floor");
    expect(v.getAttribute("aria-label")).toBe("빈 층");
    expect(v.textContent).toContain("폴더와 첫 지시를 정하면 이 층에서 새 세션을 엽니다");
    const btn = within(v).getByRole("button", { name: "새 세션 시작" });
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    expect(btn.getAttribute("title")).toBe("아직 사용할 수 없습니다");
  });
});

describe("Floor 머리", () => {
  it("층 번호, 현재 세션 별표, CTX 남은 양, 추정 표시, 예산 없음 (v1 OfficeTile 별표·CTX 테스트 대체)", () => {
    render(<Floor session={makeSession({ floor: 3, isCurrent: true, context: { used: 60000, window: 200000, pct: 30, estimated: true } })} />);
    const floor = screen.getByTestId("floor");
    expect(floor.querySelector(".fl-no")!.textContent).toBe("3F");
    expect(within(floor).getByLabelText("지금 이 세션").textContent).toBe("★");
    const ctx = within(floor).getByRole("meter", { name: "CTX 남은 양 (추정)" });
    expect(ctx.getAttribute("aria-valuenow")).toBe("70");
    expect(ctx.textContent).toContain("추정");
    expect(floor.textContent).toContain("예산 없음");
  });

  it("context가 없으면 CTX --", () => {
    render(<Floor session={makeSession({ context: null })} />);
    expect(screen.getByTestId("floor").textContent).toContain("CTX --");
    expect(screen.queryByRole("meter")).toBeNull();
  });

  it("상태 칩: 작업 중 / 대기, 섹션은 층 이름으로 이름 붙음", () => {
    render(<Floor session={makeSession({ id: "w", name: "working-floor", floorStatus: "working" })} />);
    const floor = screen.getByTestId("floor");
    expect(floor.className).toContain("floor--working");
    expect(floor.querySelector(".chip--working")!.textContent).toBe("작업 중");
    expect(floor.getAttribute("aria-labelledby")).toBe("floor-w-name");
    expect(document.getElementById("floor-w-name")!.textContent).toBe("working-floor");
    cleanup();
    render(<Floor session={makeSession({ floorStatus: "idle" })} />);
    expect(screen.getByTestId("floor").querySelector(".chip--idle")!.textContent).toBe("대기");
  });

  it("결정이 있으면 '? 결정 N' 칩과 노란 LED", () => {
    const d = { kind: "permission" as const, since: "t" };
    render(<Floor session={makeSession({ members: [makeMember({ name: "team-lead", state: "decision", decision: d }), makeMember({ name: "dev", state: "decision", decision: d })] })} />);
    const floor = screen.getByTestId("floor");
    expect(floor.querySelector(".chip--decision")!.textContent).toBe("? 결정 2");
    expect(floor.querySelector(".shaft .led")!.className).toContain("led--decision");
  });

  it("수집기 실패(stale)면 '⚠ 갱신 지연' (v1 OfficeTile stale 테스트 대체)", () => {
    render(<Floor session={makeSession({ stale: true })} />);
    expect(screen.getByTestId("floor").querySelector(".stale")!.textContent).toBe("⚠ 갱신 지연");
  });

  it("컨트롤: 스위치·종료는 동작하고(Phase 4a), 작업 지시는 아직 비활성 표시", () => {
    render(<Floor session={makeSession({ name: "alpha", floorStatus: "working" })} />);
    const floor = screen.getByTestId("floor");
    const sw = within(floor).getByRole("switch", { name: "alpha 영업" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    // B121: 스위치·종료의 aria-disabled·title이 떨어졌다(단언 수는 그대로)
    const stop = within(floor).getByRole("button", { name: "alpha 층 종료" });
    for (const el of [sw, stop]) {
      expect(el.getAttribute("aria-disabled")).toBeNull();
      expect(el.getAttribute("title")).toBeNull();
    }
    // Phase 4b: 대시보드가 띄우지 않은 층은 작업 지시 비활성 + 이유(Claude Code 제약)
    for (const el of [within(floor).getByRole("button", { name: "작업 지시" })]) {
      expect(el.getAttribute("aria-disabled")).toBe("true");
      expect(el.getAttribute("title")).toBe("대시보드가 띄운 층에만 지시할 수 있습니다(Claude Code 제약)");
    }
    expect(within(floor).queryByRole("button", { name: "숨기기" })).toBeNull();
  });
});

describe("종료된 층 (v1 OfficeTile off 테스트 대체)", () => {
  const ended = () =>
    makeSession({ id: "e", alive: false, floorStatus: "ended", endedAt: new Date(2026, 9, 1, 14, 32).toISOString(), members: [makeMember({ name: "team-lead", state: "offline" }), makeMember({ name: "dev", state: "offline" })] });

  it("'종료됨 HH:MM' 칩, 숨기기 버튼만, 바 없음, 처음에는 접혀 있고 요약을 보여준다", () => {
    render(<Floor session={ended()} />);
    const floor = screen.getByTestId("floor");
    expect(floor.className).toContain("floor--ended");
    expect(floor.className).toContain("collapsed");
    expect(floor.querySelector(".chip--ended")!.textContent).toBe("종료됨 14:32");
    expect(within(floor).getByRole("button", { name: /층 숨기기\(목록에서만\)$/ }).getAttribute("aria-disabled")).toBeNull(); // Task 7(B121): 모양만 → 활성
    expect(within(floor).queryByRole("switch")).toBeNull();
    expect(floor.querySelector(".bars")).toBeNull();
    expect(floor.querySelector(".summary")!.textContent).toBe("팀원 2 · 작업 중 0");
    expect(within(floor).getByRole("button", { name: "펼치기" }).getAttribute("aria-expanded")).toBe("false");
  });
});

describe("접기", () => {
  it("접기 버튼은 방을 가리키고, 누르면 접히고 localStorage에 기억한다", () => {
    render(<Floor session={makeSession({ id: "f1" })} />);
    const fold = screen.getByRole("button", { name: "접기" });
    expect(fold.getAttribute("aria-controls")).toBe("floor-f1-room");
    expect(document.getElementById("floor-f1-room")).not.toBeNull();
    fireEvent.click(fold);
    expect(screen.getByTestId("floor").className).toContain("collapsed");
    expect(screen.getByRole("button", { name: "펼치기" }).getAttribute("aria-expanded")).toBe("false");
    expect(localStorage.getItem("claude-office:fold:f1")).toBe("1");
  });

  it("기억된 상태를 따른다(종료 층도 펼쳐 둔 것을 기억)", () => {
    localStorage.setItem("claude-office:fold:e", "0");
    render(<Floor session={makeSession({ id: "e", alive: false, floorStatus: "ended" })} />);
    expect(screen.getByTestId("floor").className).not.toContain("collapsed");
  });

  it("localStorage가 예외를 던져도 층을 그린다", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    render(<Floor session={makeSession({ id: "x" })} />);
    fireEvent.click(screen.getByRole("button", { name: "접기" }));
    expect(screen.getByTestId("floor").className).toContain("collapsed");
  });
});

describe("방", () => {
  it("팀원 수만큼 책상을 그린다 (v1 OfficeTile 책상 테스트 대체)", () => {
    render(<Floor session={makeSession({ members: [makeMember({ name: "team-lead" }), makeMember({ name: "developer" }), makeMember({ name: "reviewer" })] })} />);
    expect(screen.getAllByTestId(/^desk-/)).toHaveLength(3);
  });
});
