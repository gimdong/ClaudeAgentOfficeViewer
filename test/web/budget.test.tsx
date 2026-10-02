// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BudgetView, SessionView, Snapshot } from "../../src/shared/types";
import { makeMember, makeSession, makeSnapshot } from "./fixtures";

const state = vi.hoisted(() => ({ value: { snapshot: null as unknown, live: true, unauthorized: false } }));
vi.mock("../../web/useSnapshot", async (orig) => ({ ...(await orig<object>()), useSnapshot: () => state.value }));

import { App } from "../../web/App";
import { Floor } from "../../web/building/Floor";
import { BudgetSettingsContext } from "../../web/budget/BudgetDialog";
import { Elevator } from "../../web/hud/Elevator";

// jsdom에는 <dialog>.showModal이 없다 — 테스트에서만 최소한으로 채운다(구현은 실제 브라우저 API를 그대로 쓴다)
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
}

const budget = (p: Partial<BudgetView> = {}): BudgetView => ({ budgetTokens: 1_000_000, usedTokens: 250_000, nextGateAt: 1_000_000, reached: false, ...p });
const floor = (p: Partial<SessionView> = {}) => makeSession({ id: "s1", name: "claude_project", floor: 3, ...p });

let fetchMock: ReturnType<typeof vi.fn>;
let putStatus = 204;
const puts = () => fetchMock.mock.calls.filter((c) => c[0] === "/api/budget") as Array<[string, { method: string; headers: Record<string, string>; body: string }]>;
let announced: string[];

class FakeNotification {
  static permission: NotificationPermission = "default";
  static requestPermission = vi.fn(async () => FakeNotification.permission);
  static shown: Array<{ title: string; body?: string }> = [];
  constructor(title: string, o?: { body?: string }) {
    FakeNotification.shown.push({ title, body: o?.body });
  }
}

beforeEach(() => {
  putStatus = 204;
  announced = [];
  fetchMock = vi.fn(async (url: string) => (url === "/api/budget" ? { ok: putStatus < 300, status: putStatus, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({}) }));
  vi.stubGlobal("fetch", fetchMock);
  FakeNotification.permission = "default";
  FakeNotification.requestPermission.mockClear();
  FakeNotification.shown = [];
  vi.stubGlobal("Notification", FakeNotification);
  try {
    localStorage.clear();
  } catch {
    /* 없으면 넘어간다 */
  }
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderFloor(s: SessionView, defaultTokens?: number) {
  return render(
    <BudgetSettingsContext.Provider value={{ defaultTokens, announce: (t) => announced.push(t) }}>
      <Floor session={s} />
    </BudgetSettingsContext.Provider>,
  );
}
const flush = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
const openSettings = () => fireEvent.click(screen.getByRole("button", { name: "claude_project 예산 설정" }));

describe("층 머리의 예산 막대(§6.1)", () => {
  it("예산이 없으면 \"예산 없음\"과 설정 버튼", () => {
    renderFloor(floor());
    const f = screen.getByTestId("floor");
    expect(f.textContent).toContain("예산 없음");
    expect(within(f).queryByRole("meter", { name: "예산 남은 양" })).toBeNull();
    const btn = within(f).getByRole("button", { name: "claude_project 예산 설정" });
    expect(btn.getAttribute("aria-haspopup")).toBe("dialog");
  });

  it("있으면 남은 양 %와 meter", () => {
    renderFloor(floor({ budget: budget({ budgetTokens: 500_000, usedTokens: 512_340, nextGateAt: 1_000_000 }) }));
    const m = screen.getByRole("meter", { name: "예산 남은 양" });
    // (1,000,000 − 512,340) / 500,000 × 100 = 97.5 → 0–100으로 자른 뒤 반올림
    expect(m.getAttribute("aria-valuenow")).toBe("98");
    expect(m.getAttribute("aria-valuetext")).toBe("남은 양 98%, 512,340 토큰 사용");
    expect(m.getAttribute("title")).toBe("512,340 / 1,000,000 토큰");
    expect(m.textContent).toContain("예산");
    expect(m.textContent).toContain("98%");
  });

  it("남은 양 색 규칙(A3): 50 이상 기본, 20 이상 warn, 그 아래 danger, 닿으면 0%", () => {
    const { rerender } = renderFloor(floor({ budget: budget({ budgetTokens: 100, usedTokens: 70, nextGateAt: 100 }) }));
    expect(screen.getByRole("meter", { name: "예산 남은 양" }).className).toContain("warn");
    rerender(
      <BudgetSettingsContext.Provider value={{}}>
        <Floor session={floor({ budget: budget({ budgetTokens: 100, usedTokens: 120, nextGateAt: 100, reached: true }) })} />
      </BudgetSettingsContext.Provider>,
    );
    const m = screen.getByRole("meter", { name: "예산 남은 양" });
    expect(m.className).toContain("danger");
    expect(m.getAttribute("aria-valuenow")).toBe("0");
  });

  it("종료 층에는 막대를 두지 않는다", () => {
    renderFloor(floor({ floorStatus: "ended", alive: false, budget: budget() }));
    expect(screen.queryByRole("button", { name: "claude_project 예산 설정" })).toBeNull();
  });
});

describe("경광등(§7)", () => {
  it("닿은 층에 경광등 클래스와 \"예산 도달\" 칩이 붙는다", () => {
    renderFloor(floor({ budget: budget({ usedTokens: 1_000_000, reached: true }) }));
    const f = screen.getByTestId("floor");
    expect(f.className).toContain("floor--alarm");
    expect(f.querySelector(".chip--budget")!.textContent).toBe("예산 도달");
    expect(f.querySelector(".shaft .led")!.className).toContain("led--budget");
    expect(f.querySelector(".shaft .siren")).not.toBeNull();
  });

  it("결정 대기가 함께 있으면 LED는 결정(노랑)이 먼저이고, 예산 도달 칩은 결정 칩 앞에 둔다", () => {
    renderFloor(floor({ budget: budget({ reached: true }), members: [makeMember({ name: "dev", state: "decision", decision: { kind: "permission", since: "t" } })] }));
    const f = screen.getByTestId("floor");
    expect(f.querySelector(".shaft .led")!.className).toContain("led--decision");
    const chips = [...f.querySelectorAll(".chip--budget, .chip--decision")].map((c) => c.className);
    expect(chips[0]).toContain("chip--budget");
    expect(chips[1]).toContain("chip--decision");
  });

  it("층 바로가기 LED도 예산 도달이면 led--budget, 결정 대기가 있으면 결정이 먼저", () => {
    render(
      <Elevator
        sessions={[
          floor({ id: "a", floor: 1, name: "a", budget: budget({ reached: true }) }),
          floor({ id: "b", floor: 2, name: "b", budget: budget({ reached: true }), members: [makeMember({ name: "dev", state: "decision", decision: { kind: "permission", since: "t" } })] }),
          floor({ id: "c", floor: 3, name: "c", budget: budget() }),
        ]}
      />,
    );
    const led = (name: string) => screen.getByRole("button", { name: new RegExp(`${name}`) }).querySelector(".led")!.className;
    expect(led("1층 a")).toContain("led--budget");
    expect(led("2층 b")).toContain("led--decision");
    expect(led("3층 c")).not.toContain("led--budget");
  });

  it("닿지 않은 층에는 경광등이 없다", () => {
    renderFloor(floor({ budget: budget() }));
    const f = screen.getByTestId("floor");
    expect(f.className).not.toContain("floor--alarm");
    expect(f.querySelector(".siren")).toBeNull();
    expect(f.querySelector(".chip--budget")).toBeNull();
  });
});

describe("설정 창(§6.2)", () => {
  it("설정 창에서 저장하면 PUT /api/budget에 {sessionId, budgetTokens}를 보낸다", async () => {
    renderFloor(floor({ budget: budget({ budgetTokens: 500_000, usedTokens: 512_340 }) }));
    openSettings();
    const dialog = screen.getByRole("dialog", { name: "claude_project 예산" });
    const own = within(dialog).getByLabelText("이 층의 예산") as HTMLInputElement;
    expect(own.value).toBe("500,000");
    expect(document.activeElement).toBe(own);
    expect(dialog.textContent).toContain("지금까지 쓴 양 512,340 토큰");
    fireEvent.change(own, { target: { value: "1,200,000" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "저장" }));
    expect(within(dialog).getByRole("button", { name: "저장하는 중…" }).hasAttribute("disabled")).toBe(true);
    await flush();
    expect(puts()).toEqual([["/api/budget", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: "s1", budgetTokens: 1_200_000 }) }]]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(announced).toEqual(["예산을 저장했습니다"]);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "claude_project 예산 설정" }));
  });

  it("빈 값은 null", async () => {
    renderFloor(floor({ budget: budget() }));
    openSettings();
    fireEvent.change(screen.getByLabelText("이 층의 예산"), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await flush();
    expect(JSON.parse(puts()[0][1].body)).toEqual({ sessionId: "s1", budgetTokens: null });
  });

  it("기본값은 sessionId 없이, 바뀐 칸만 보낸다", async () => {
    renderFloor(floor(), 300_000);
    openSettings();
    const def = screen.getByLabelText("새 층의 기본값") as HTMLInputElement;
    expect(def.value).toBe("300,000");
    fireEvent.change(def, { target: { value: "50000" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await flush();
    expect(puts().map((c) => JSON.parse(c[1].body))).toEqual([{ budgetTokens: 50_000 }]);
  });

  it("범위 밖·소수·글자는 저장하지 않고 안내한다", () => {
    renderFloor(floor());
    openSettings();
    const own = screen.getByLabelText("이 층의 예산");
    for (const bad of ["999", "1000000001", "1.5", "abc", "-5000"]) {
      fireEvent.change(own, { target: { value: bad } });
      fireEvent.click(screen.getByRole("button", { name: "저장" }));
      expect(puts()).toHaveLength(0);
      expect(own.getAttribute("aria-invalid")).toBe("true");
      const err = document.getElementById(own.getAttribute("aria-describedby")!.split(" ").find((id) => document.getElementById(id)?.textContent?.includes("사이의 정수"))!);
      expect(err!.textContent).toBe("1,000에서 1,000,000,000 사이의 정수를 입력해 주세요");
    }
    fireEvent.change(own, { target: { value: "1,000" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    expect(puts()).toHaveLength(1);
  });

  it("저장 실패면 창을 닫지 않고 안내한다", async () => {
    putStatus = 500;
    renderFloor(floor());
    openSettings();
    fireEvent.change(screen.getByLabelText("이 층의 예산"), { target: { value: "5000" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await flush();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("저장하지 못했습니다. 다시 시도해 주세요.");
    expect(announced).toEqual([]);
  });

  it("PUT이 401이면 401 이벤트를 보낸다", async () => {
    putStatus = 401;
    const seen = vi.fn();
    window.addEventListener("claude-office:unauthorized", seen);
    renderFloor(floor());
    openSettings();
    fireEvent.change(screen.getByLabelText("이 층의 예산"), { target: { value: "5000" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await flush();
    window.removeEventListener("claude-office:unauthorized", seen);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("처음 저장할 때만 알림 권한을 묻는다", async () => {
    renderFloor(floor());
    for (let i = 0; i < 2; i++) {
      openSettings();
      fireEvent.change(screen.getByLabelText("이 층의 예산"), { target: { value: `${5000 + i}` } });
      fireEvent.click(screen.getByRole("button", { name: "저장" }));
      await flush();
    }
    expect(puts()).toHaveLength(2);
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
  });

  it("Notification이 없어도 저장된다", async () => {
    vi.stubGlobal("Notification", undefined);
    renderFloor(floor());
    openSettings();
    expect(screen.getByRole("dialog").textContent).toContain("이 브라우저는 알림을 지원하지 않아 층 경광등만 켜집니다.");
    fireEvent.change(screen.getByLabelText("이 층의 예산"), { target: { value: "5000" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await flush();
    expect(puts()).toHaveLength(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("알림 안내 한 줄은 권한에 따라 다르다", () => {
    FakeNotification.permission = "denied";
    renderFloor(floor());
    openSettings();
    expect(screen.getByRole("dialog").textContent).toContain("브라우저 알림이 꺼져 있어 층 경광등만 켜집니다.");
  });

  it("창을 Esc로 닫으면 설정 버튼으로 포커스가 돌아온다", () => {
    renderFloor(floor());
    openSettings();
    const dialog = screen.getByRole("dialog");
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "claude_project 예산 설정" }));
    expect(puts()).toHaveLength(0);
  });

  it("취소로 닫아도 설정 버튼으로 돌아오고 보내지 않는다", () => {
    renderFloor(floor());
    openSettings();
    fireEvent.change(screen.getByLabelText("이 층의 예산"), { target: { value: "5000" } });
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "claude_project 예산 설정" }));
    expect(puts()).toHaveLength(0);
  });
});

describe("예산 알람(useBudgetAlarm)", () => {
  const snap = (b?: BudgetView, name = "claude_project"): Snapshot => makeSnapshot({ sessions: [floor({ name, budget: b })] });
  function show(s: Snapshot) {
    state.value = { ...state.value, snapshot: s };
  }

  it("예산에 닿는 순간 알림을 한 번 보낸다", () => {
    FakeNotification.permission = "granted";
    show(snap(budget()));
    const { rerender } = render(<App />);
    show(snap(budget({ usedTokens: 1_000_000, reached: true })));
    rerender(<App />);
    expect(FakeNotification.shown).toEqual([{ title: "예산에 도달했습니다", body: "claude_project — 계속할지 정해 주세요" }]);
    expect(screen.getByRole("status").textContent!.trim()).toBe("claude_project 층이 예산에 도달했습니다");
  });

  it("같은 nextGateAt으로는 다시 보내지 않고, 계속으로 nextGateAt이 오른 뒤 다시 닿으면 또 보낸다", () => {
    FakeNotification.permission = "granted";
    show(snap(budget()));
    const { rerender } = render(<App />);
    show(snap(budget({ usedTokens: 1_000_000, reached: true })));
    rerender(<App />);
    show(snap(budget({ usedTokens: 1_100_000, reached: true })));
    rerender(<App />);
    expect(FakeNotification.shown).toHaveLength(1);
    show(snap(budget({ usedTokens: 1_100_000, nextGateAt: 2_000_000, reached: false })));
    rerender(<App />);
    show(snap(budget({ usedTokens: 2_000_000, nextGateAt: 2_000_000, reached: true })));
    rerender(<App />);
    expect(FakeNotification.shown).toHaveLength(2);
  });

  it("첫 스냅샷에 이미 닿아 있으면 보내지 않는다", () => {
    FakeNotification.permission = "granted";
    show(snap(budget({ usedTokens: 1_000_000, reached: true })));
    const { rerender } = render(<App />);
    show(snap(budget({ usedTokens: 1_000_001, reached: true })));
    rerender(<App />);
    expect(FakeNotification.shown).toEqual([]);
  });

  it("권한이 denied면 브라우저 알림은 보내지 않고 화면 알림만 한다", () => {
    FakeNotification.permission = "denied";
    show(snap(budget()));
    const { rerender } = render(<App />);
    show(snap(budget({ usedTokens: 1_000_000, reached: true })));
    rerender(<App />);
    expect(FakeNotification.shown).toEqual([]);
    expect(screen.getByRole("status").textContent!.trim()).toBe("claude_project 층이 예산에 도달했습니다");
  });
});
