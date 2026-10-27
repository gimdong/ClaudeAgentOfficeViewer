// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Member, SessionView, Snapshot } from "../../src/shared/types";
import { makeMember, makeSession, makeSnapshot } from "./fixtures";

const state = vi.hoisted(() => ({ value: { snapshot: null as unknown, live: true, unauthorized: false, markUnauthorized: () => {} } }));
vi.mock("../../web/useSnapshot", async (orig) => ({ ...(await orig<typeof import("../../web/useSnapshot")>()), useSnapshot: () => state.value }));

import { App } from "../../web/App";
import { FLOOR_TEXT } from "../../web/floors/useFloors";

const NBSP = " ";
type Reply = { status: number; body?: unknown } | "network";
let reply: Reply;
let fetchMock: ReturnType<typeof vi.fn>;
const DIAG = { doctor: [], hooks: { total: 0, byEvent: {}, lastAt: null, rejected: { "403": 0, "415": 0, "413": 0, "400": 0 }, last10min: 0 }, errorsLastHour: 0, logDir: "l", diagDir: "d" };
const calls = () => fetchMock.mock.calls.filter((c) => String(c[0]).startsWith("/api/floors")) as Array<[string, { method: string; headers: Record<string, string>; body: string }]>;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  reply = { status: 200, body: { hidden: 1 } };
  fetchMock = vi.fn(async (url: string) => {
    if (!String(url).startsWith("/api/floors")) return { ok: true, status: 200, json: async () => DIAG };
    if (reply === "network") throw new TypeError("network");
    const r = reply;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body ?? {} };
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const lead = (p: Partial<Member> = {}) => makeMember({ name: "team-lead", role: "lead", ...p });
const ended = (id: string, name: string, floor: number) =>
  makeSession({ id, name, floor, alive: false, floorStatus: "ended", endedAt: new Date(2026, 9, 11, 14, 0).toISOString(), members: [lead({ state: "offline" })] });
const live = (id: string, name: string, floor: number) => makeSession({ id, name, floor, floorStatus: "idle", members: [lead()] });
const snap = (sessions: SessionView[], hiddenFloors = 0): Snapshot => makeSnapshot({ sessions, hiddenFloors });
const show = (s: Snapshot) => (state.value = { ...state.value, snapshot: s });
const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
};
const floorNamed = (name: string) => screen.queryAllByTestId("floor").find((f) => f.querySelector(".floor-name")?.textContent?.includes(name));
const delBtn = (name: string) => within(floorNamed(name)!).getByRole("button", { name: `${name} 층 숨기기(목록에서만)` });
const status = () => screen.getByRole("status").textContent?.replace(NBSP, "");
const bar = () => document.querySelector(".hidden-bar");

describe("삭제(숨김, §4.1·§4.2)", () => {
  it("끝난 층의 삭제를 누르면 확인 창 없이 hide를 보내고 바로 사라진다, 살아 있는 층에는 삭제 버튼이 없다", async () => {
    show(snap([live("a", "alpha", 2), ended("b", "beta", 1)]));
    render(<App />);
    expect(within(floorNamed("alpha")!).queryByRole("button", { name: /숨기기/ })).toBeNull();
    expect(delBtn("beta").getAttribute("title")).toBe(FLOOR_TEXT.hideTitle);
    fireEvent.click(delBtn("beta"));
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
    const [[url, init]] = calls();
    expect([url, init.method, init.headers["Content-Type"], init.body]).toEqual(["/api/floors/b/hide", "POST", "application/json", "{}"]);
    expect(floorNamed("beta")).toBeUndefined();
    expect(status()).toBe("beta 층을 목록에서 숨겼습니다");
    // 포커스는 숨긴 층 줄의 "모두 보이기" 버튼
    expect(document.activeElement?.textContent).toBe("숨긴 층 1개 · 모두 보이기");
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it.each([
    ["409 alive", { status: 409, body: { error: "alive" } } as Reply, FLOOR_TEXT.hideAlive],
    ["404 not-found", { status: 404 } as Reply, FLOOR_TEXT.hideNotFound],
    ["네트워크", "network" as Reply, FLOOR_TEXT.hideFailed],
  ])("실패(%s)면 층을 그대로 두고 그 층 머리에 안내, 포커스는 그대로", async (_l, r, text) => {
    reply = r;
    show(snap([ended("b", "beta", 1)]));
    render(<App />);
    delBtn("beta").focus();
    fireEvent.click(delBtn("beta"));
    await flush();
    expect(within(floorNamed("beta")!).getByRole("alert").textContent).toBe(text);
    expect(document.activeElement).toBe(delBtn("beta"));
  });

  it("숨긴 층은 스냅샷이 뺄 때까지 화면이 숨기되 최대 6초이고, alive로 오면 즉시 다시 보인다(B127)", async () => {
    show(snap([ended("b", "beta", 1)]));
    const { rerender } = render(<App />);
    fireEvent.click(delBtn("beta"));
    await flush();
    show(snap([ended("b", "beta", 1)])); // 스냅샷이 아직 옛 목록
    rerender(<App />);
    expect(floorNamed("beta")).toBeUndefined();
    await act(async () => vi.advanceTimersByTime(6_001));
    show(snap([ended("b", "beta", 1)]));
    rerender(<App />);
    expect(floorNamed("beta")).toBeDefined();
    // 다시 숨긴 뒤 --resume으로 살아나면 즉시 보인다
    fireEvent.click(delBtn("beta"));
    await flush();
    show(snap([live("b", "beta", 1)]));
    rerender(<App />);
    expect(floorNamed("beta")).toBeDefined();
  });
});

describe("숨긴 층 줄(§4.3·§4.4)", () => {
  it("hiddenFloors가 0이면 줄이 없고, N이면 '숨긴 층 N개 · 모두 보이기'", () => {
    show(snap([live("a", "alpha", 1)]));
    const { rerender } = render(<App />);
    expect(bar()).toBeNull();
    show(snap([live("a", "alpha", 1)], 3));
    rerender(<App />);
    expect(within(bar() as HTMLElement).getByRole("button").textContent).toBe("숨긴 층 3개 · 모두 보이기");
    // 탑 아래, 거리 위(Task 7: 땅 → 거리)
    expect(bar()!.previousElementSibling?.className).toBe("tower");
    expect(bar()!.nextElementSibling?.classList.contains("street")).toBe(true);
  });

  it("누르면 DELETE /api/floors/hidden, '다시 불러오는 중' 줄에 포커스, 층이 돌아오면 1F 접기 버튼으로", async () => {
    reply = { status: 200, body: { hidden: 0 } };
    show(snap([live("a", "alpha", 1)], 2));
    const { rerender } = render(<App />);
    fireEvent.click(within(bar() as HTMLElement).getByRole("button"));
    await flush();
    const [[url, init]] = calls();
    expect([url, init.method, init.body]).toEqual(["/api/floors/hidden", "DELETE", "{}"]);
    expect(bar()!.textContent).toBe(FLOOR_TEXT.reloading);
    expect(document.activeElement).toBe(bar());
    expect(status()).toBe("숨긴 층을 모두 다시 보이게 했습니다");
    show(snap([live("a", "alpha", 2), ended("b", "beta", 1)], 0));
    rerender(<App />);
    expect(bar()).toBeNull();
    expect(document.activeElement).toBe(floorNamed("beta")!.querySelector(".fold"));
  });

  it("모든 층을 숨겼으면 빈 빌딩 안내 없이 줄만(B135 ①)", () => {
    show(snap([], 2));
    render(<App />);
    expect(screen.queryByText(/빌딩이 비어 있습니다/)).toBeNull();
    expect(within(bar() as HTMLElement).getByRole("button").textContent).toBe("숨긴 층 2개 · 모두 보이기");
  });

  it("다시 불러오는 동안 포커스를 다른 곳으로 옮겼으면 층이 돌아와도 포커스를 옮기지 않는다(B135 ②)", async () => {
    reply = { status: 200, body: { hidden: 0 } };
    show(snap([live("a", "alpha", 1)], 2));
    const { rerender } = render(<App />);
    fireEvent.click(within(bar() as HTMLElement).getByRole("button"));
    await flush();
    const mine = floorNamed("alpha")!.querySelector<HTMLElement>(".fold")!;
    act(() => mine.focus());
    show(snap([live("a", "alpha", 2), ended("b", "beta", 1)], 0));
    rerender(<App />);
    expect(document.activeElement).toBe(mine);
  });

  it("모두 보이기 실패면 버튼 옆에 안내, 포커스는 버튼에", async () => {
    reply = "network";
    show(snap([live("a", "alpha", 1)], 2));
    render(<App />);
    const b = within(bar() as HTMLElement).getByRole("button");
    b.focus();
    fireEvent.click(b);
    await flush();
    expect(within(bar() as HTMLElement).getByRole("alert").textContent).toBe(FLOOR_TEXT.hideFailed);
    expect(document.activeElement).toBe(within(bar() as HTMLElement).getByRole("button"));
  });

  it("'다시 불러오는 중' 줄은 최대 6초", async () => {
    reply = { status: 200, body: { hidden: 0 } };
    show(snap([live("a", "alpha", 1)], 2));
    const { rerender } = render(<App />);
    fireEvent.click(within(bar() as HTMLElement).getByRole("button"));
    await flush();
    await act(async () => vi.advanceTimersByTime(6_001));
    show(snap([live("a", "alpha", 1)], 2)); // 서버가 끝내 따라오지 않음
    rerender(<App />);
    expect(within(bar() as HTMLElement).getByRole("button").textContent).toBe("숨긴 층 2개 · 모두 보이기");
  });
});
