// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Member, SessionView, Snapshot } from "../../src/shared/types";
import { activityLine } from "../../web/office/activityText";
import { makeMember, makeSession, makeSnapshot } from "./fixtures";

const state = vi.hoisted(() => ({ value: { snapshot: null as unknown, live: true, unauthorized: false, markUnauthorized: () => {} } }));
vi.mock("../../web/useSnapshot", async (orig) => ({ ...(await orig<typeof import("../../web/useSnapshot")>()), useSnapshot: () => state.value }));

import { App } from "../../web/App";
import { UNAUTHORIZED_EVENT } from "../../web/useSnapshot";
import { FLOOR_TEXT } from "../../web/floors/useFloors";

const NBSP = " ";
type Reply = { status: number; body?: unknown } | "network" | "hold";
let reply: Reply;
let release: (() => void) | null;
let fetchMock: ReturnType<typeof vi.fn>;
const DIAG = { doctor: [], hooks: { total: 0, byEvent: {}, lastAt: null, rejected: { "403": 0, "415": 0, "413": 0, "400": 0 }, last10min: 0 }, errorsLastHour: 0, logDir: "l", diagDir: "d" };
const floorCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]).startsWith("/api/floors")) as Array<[string, { method: string; headers: Record<string, string>; body: string }]>;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  reply = { status: 200, body: { paused: true } };
  release = null;
  fetchMock = vi.fn(async (url: string) => {
    if (!String(url).startsWith("/api/floors")) return { ok: true, status: 200, json: async () => DIAG };
    if (reply === "network") throw new TypeError("network");
    if (reply === "hold") await new Promise<void>((r) => (release = r));
    const r = reply === "hold" ? { status: 200, body: { paused: true } } : reply;
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
const floorOf = (p: Partial<SessionView> = {}) => makeSession({ id: "s1", name: "alpha", floorStatus: "working", members: [lead({ state: "working" }), makeMember({ name: "dev", state: "working" })], ...p });
const snap = (s: SessionView): Snapshot => makeSnapshot({ sessions: [s] });
const show = (s: Snapshot) => (state.value = { ...state.value, snapshot: s });
const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
};
const sw = () => screen.getByRole("switch", { name: "alpha 영업" });
const floor = () => screen.getByTestId("floor");
const status = () => screen.getByRole("status").textContent?.replace(NBSP, "");

describe("스위치(§1.1·§1.2)", () => {
  it("영업 중이면 aria-checked=true·라벨 '영업 중', 일시정지면 false·'멈춤', aria-label은 '{층 이름} 영업'", () => {
    show(snap(floorOf()));
    const { rerender } = render(<App />);
    expect([sw().getAttribute("aria-checked"), sw().textContent]).toEqual(["true", "영업 중"]);
    expect(sw().getAttribute("aria-disabled")).toBeNull();
    show(snap(floorOf({ floorStatus: "paused", pausedDenied: 0 })));
    rerender(<App />);
    expect([sw().getAttribute("aria-checked"), sw().textContent]).toEqual(["false", "멈춤"]);
  });

  it("누르면 pause를 보내고, 요청 중에는 aria-busy이고 다시 눌러도 요청은 한 번, 응답이 오면 잠금이 풀린다", async () => {
    reply = "hold";
    show(snap(floorOf()));
    render(<App />);
    fireEvent.click(sw());
    expect(sw().getAttribute("aria-busy")).toBe("true");
    expect((sw() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(sw());
    const [[url, init]] = floorCalls();
    expect([floorCalls().length, url, init.method, init.headers["Content-Type"], init.body]).toEqual([1, "/api/floors/s1/pause", "POST", "application/json", "{}"]);
    await act(async () => release?.());
    await flush();
    expect(sw().getAttribute("aria-busy")).toBeNull();
    expect(sw().getAttribute("aria-checked")).toBe("false");
  });

  it("일시정지 층에서 누르면 resume", async () => {
    reply = { status: 200, body: { paused: false } };
    show(snap(floorOf({ floorStatus: "paused", pausedDenied: 0 })));
    render(<App />);
    fireEvent.click(sw());
    await flush();
    expect(floorCalls()[0][0]).toBe("/api/floors/s1/resume");
    expect(sw().getAttribute("aria-checked")).toBe("true");
  });

  it.each([
    ["409 ended", { status: 409, body: { error: "ended" } } as Reply, FLOOR_TEXT.switchEnded],
    ["네트워크", "network" as Reply, FLOOR_TEXT.switchFailed],
    ["500", { status: 500 } as Reply, FLOOR_TEXT.switchFailed],
  ])("실패(%s)하면 스위치가 되돌아가고 안내가 role=alert로, 10초 뒤 사라진다", async (_l, r, text) => {
    reply = r;
    show(snap(floorOf()));
    render(<App />);
    fireEvent.click(sw());
    await flush();
    expect(sw().getAttribute("aria-checked")).toBe("true");
    expect(within(floor()).getByRole("alert").textContent).toBe(text);
    await act(async () => vi.advanceTimersByTime(10_001));
    expect(within(floor()).queryByRole("alert")).toBeNull();
  });

  it("401이면 열쇠 안내 화면으로(UNAUTHORIZED_EVENT)", async () => {
    reply = { status: 401 };
    const heard = vi.fn();
    window.addEventListener(UNAUTHORIZED_EVENT, heard);
    show(snap(floorOf()));
    render(<App />);
    fireEvent.click(sw());
    await flush();
    window.removeEventListener(UNAUTHORIZED_EVENT, heard);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(within(floor()).queryByRole("alert")).toBeNull();
  });

  it("스위치 상태 변경은 status 하나로 알린다", async () => {
    show(snap(floorOf()));
    render(<App />);
    fireEvent.click(sw());
    await flush();
    expect(status()).toBe("alpha 층을 멈췄습니다");
    reply = { status: 200, body: { paused: false } };
    fireEvent.click(sw());
    await flush();
    expect(status()).toBe("alpha 층을 다시 영업 중으로 돌렸습니다");
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("응답 값을 스냅샷이 따라올 때까지 들고 있되 최대 6초(B117·B127)", async () => {
    show(snap(floorOf()));
    const { rerender } = render(<App />);
    fireEvent.click(sw());
    await flush();
    // 스냅샷이 아직 옛 상태(영업 중)여도 응답 값(멈춤)을 들고 있는다. 칩·셔터도 따른다
    show(snap(floorOf()));
    rerender(<App />);
    expect(sw().getAttribute("aria-checked")).toBe("false");
    expect(floor().querySelector(".chip")?.textContent).toBe("멈춤");
    expect(floor().querySelector(".shutter")).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(6_001));
    show(snap(floorOf()));
    rerender(<App />);
    expect(sw().getAttribute("aria-checked")).toBe("true");
    expect(floor().querySelector(".shutter")).toBeNull();
  });
});

describe("일시정지 층(§1.5·§1.6·§2)", () => {
  it("floor--paused, 셔터와 팻말, 칩 '멈춤'(title은 한계 2), 스위치의 aria-describedby, 책상이 paused로", () => {
    show(snap(floorOf({ floorStatus: "paused", pausedDenied: 12 })));
    render(<App />);
    const f = floor();
    expect(f.className).toContain("floor--paused");
    const shutter = f.querySelector(".shutter")!;
    expect(shutter.getAttribute("aria-hidden")).toBe("true");
    expect(shutter.querySelector(".shutter-sign")?.textContent).toBe("휴업잠시 쉬는 중");
    expect(shutter.className).not.toContain("shutter-down"); // 처음 렌더는 애니메이션 없이
    const chip = f.querySelector(".chip")!;
    expect([chip.textContent, chip.className.includes("chip--paused"), chip.getAttribute("title")]).toEqual(["멈춤", true, FLOOR_TEXT.pauseNote]);
    const describedBy = sw().getAttribute("aria-describedby")!;
    expect(document.getElementById(describedBy)?.textContent).toBe(FLOOR_TEXT.pauseNote);
    expect(f.querySelector(".led")?.getAttribute("title")).toBe("멈춤");
    const desk = within(f).getByTestId("desk-dev");
    expect(desk.className).toContain("state-idle");
    expect(desk.querySelector(".frame-b")).toBeNull();
  });

  it("막힌 호출 N은 칩 바로 뒤, 접혀도 보이고, 0이면 없다, 쉼표", () => {
    show(snap(floorOf({ floorStatus: "paused", pausedDenied: 1204 })));
    const { rerender } = render(<App />);
    const blocked = floor().querySelector(".fl-blocked")!;
    expect(blocked.textContent).toBe("· 막힌 호출 1,204");
    expect(blocked.previousElementSibling?.className).toContain("chip--paused");
    fireEvent.click(within(floor()).getByRole("button", { name: "접기" }));
    expect(floor().querySelector(".fl-blocked")).not.toBeNull();
    show(snap(floorOf({ floorStatus: "paused", pausedDenied: 0 })));
    rerender(<App />);
    expect(floor().querySelector(".fl-blocked")).toBeNull();
  });

  it("영업 중 → 멈춤으로 바뀌면 셔터에 shutter-down", () => {
    show(snap(floorOf()));
    const { rerender } = render(<App />);
    show(snap(floorOf({ floorStatus: "paused", pausedDenied: 0 })));
    rerender(<App />);
    expect(floor().querySelector(".shutter")?.className).toContain("shutter-down");
  });

  it("셔터 애니메이션 클래스는 animationend 뒤 내려 접었다 펼쳐도 다시 내려오지 않는다(B129 M2)", () => {
    show(snap(floorOf()));
    const { rerender } = render(<App />);
    show(snap(floorOf({ floorStatus: "paused", pausedDenied: 0 })));
    rerender(<App />);
    const shutter = floor().querySelector(".shutter")!;
    expect(shutter.className).toContain("shutter-down");
    // jsdom에는 AnimationEvent가 없어 React가 접두사 이름(webkitAnimationEnd)으로 듣는다 — 둘 다 보낸다
    act(() => {
      shutter.dispatchEvent(new Event("animationend", { bubbles: true }));
      shutter.dispatchEvent(new Event("webkitAnimationEnd", { bubbles: true }));
    });
    expect(floor().querySelector(".shutter")!.className).not.toContain("shutter-down");
    // 접기 상태는 세션 id별로 기억되므로(앞 테스트) 이름 대신 접기 버튼을 두 번 누른다
    fireEvent.click(floor().querySelector<HTMLElement>(".fold")!);
    fireEvent.click(floor().querySelector<HTMLElement>(".fold")!);
    expect(floor().querySelector(".shutter")!.className).not.toContain("shutter-down");
  });

  it("멈춘 층의 결정 대기 책상만 셔터 위로(B130)", () => {
    const css = readFileSync(join(__dirname, "../../web/styles.css"), "utf8");
    expect(css.includes(".floor--paused .desk--decision { position: relative; z-index: 3; }")).toBe(true);
  });

  it("말풍선은 스위치를 누른 직후(스냅샷 전)에도 들고 있는 값으로 휴업 줄을 쓴다(B129 M1)", async () => {
    show(snap(floorOf()));
    render(<App />);
    fireEvent.click(sw());
    await flush();
    fireEvent.mouseEnter(within(floor()).getByTestId("desk-dev"));
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByRole("tooltip").textContent).toContain("저는 지금 휴업 중이라 도구를 쓰지 않고 기다립니다");
  });

  it("말풍선의 휴업 줄(B126)", () => {
    expect(activityLine(makeMember(), { paused: true }).text).toBe("저는 지금 휴업 중이라 도구를 쓰지 않고 기다립니다");
  });

  it("말풍선은 일시정지 층의 구성원에 휴업 줄을 쓴다", () => {
    show(snap(floorOf({ floorStatus: "paused", pausedDenied: 0 })));
    render(<App />);
    fireEvent.mouseEnter(within(floor()).getByTestId("desk-dev"));
    act(() => vi.advanceTimersByTime(1_000)); // 말풍선 지연
    expect(screen.getByRole("tooltip").textContent).toContain("저는 지금 휴업 중이라 도구를 쓰지 않고 기다립니다");
  });

  it("종료 중이면 칩 '종료 중' 하나(멈춤이어도), 셔터는 멈춤일 때만", () => {
    show(snap(floorOf({ terminating: true })));
    const { rerender } = render(<App />);
    expect([...floor().querySelectorAll(".chip")].map((c) => c.textContent)).toEqual(["종료 중"]);
    expect(floor().querySelector(".chip")?.className).toContain("chip--terminating");
    expect(floor().querySelector(".shutter")).toBeNull();
    show(snap(floorOf({ terminating: true, floorStatus: "paused", pausedDenied: 0 })));
    rerender(<App />);
    expect([...floor().querySelectorAll(".chip")].map((c) => c.textContent)).toEqual(["종료 중"]);
    expect(floor().querySelector(".shutter")).not.toBeNull();
  });
});

describe("버튼(§1.4)", () => {
  it("작업 지시는 여전히 aria-disabled이고 제목이 '아직 사용할 수 없습니다'", () => {
    show(snap(floorOf({ floorStatus: "paused", pausedDenied: 0 })));
    render(<App />);
    const b = within(floor()).getByRole("button", { name: "작업 지시" });
    expect([b.getAttribute("aria-disabled"), b.getAttribute("title")]).toEqual(["true", "아직 사용할 수 없습니다"]);
  });

  it("끝난 층에는 삭제 버튼만", () => {
    show(snap(floorOf({ alive: false, floorStatus: "ended", members: [lead({ state: "offline" })] })));
    render(<App />);
    expect(within(floor()).queryByRole("switch")).toBeNull();
    expect(within(floor().querySelector<HTMLElement>(".controls")!).getAllByRole("button").map((b) => b.textContent)).toEqual(["삭제"]);
  });
});
