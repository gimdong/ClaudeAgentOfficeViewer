// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Member, SessionView, Snapshot } from "../../src/shared/types";
import { makeMember, makeSession, makeSnapshot } from "./fixtures";

const state = vi.hoisted(() => ({ value: { snapshot: null as unknown, live: true, unauthorized: false, markUnauthorized: () => {} } }));
vi.mock("../../web/useSnapshot", async (orig) => ({ ...(await orig<typeof import("../../web/useSnapshot")>()), useSnapshot: () => state.value }));

import { App } from "../../web/App";
import { FLOOR_TEXT } from "../../web/floors/useFloors";

// jsdom에는 <dialog>.showModal이 없다 — 테스트에서만 최소한으로 채운다(budget.test.tsx와 같음)
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
}

const NBSP = " ";
type Reply = { status: number; body?: unknown } | "network" | "hold";
let reply: Reply;
let release: (() => void) | null;
let fetchMock: ReturnType<typeof vi.fn>;
const DIAG = { doctor: [], hooks: { total: 0, byEvent: {}, lastAt: null, rejected: { "403": 0, "415": 0, "413": 0, "400": 0 }, last10min: 0 }, errorsLastHour: 0, logDir: "l", diagDir: "d" };
const calls = () => fetchMock.mock.calls.filter((c) => String(c[0]).startsWith("/api/floors")) as Array<[string, { method: string; body: string }]>;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  reply = { status: 200, body: { signal: "SIGTERM" } };
  release = null;
  fetchMock = vi.fn(async (url: string) => {
    if (!String(url).startsWith("/api/floors")) return { ok: true, status: 200, json: async () => DIAG };
    if (reply === "network") throw new TypeError("network");
    if (reply === "hold") await new Promise<void>((r) => (release = r));
    const r = reply === "hold" ? { status: 200, body: { signal: "SIGTERM" } } : reply;
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
const fl = (p: Partial<SessionView> = {}) =>
  makeSession({ id: "s1", name: "fake-shop", cwd: "/Users/fakeuser/Code/fake-shop", floorStatus: "working", members: [lead({ state: "working" }), makeMember({ name: "dev", state: "idle" }), makeMember({ name: "qa", state: "idle" })], ...p });
const snap = (...s: SessionView[]): Snapshot => makeSnapshot({ sessions: s });
const show = (s: Snapshot) => (state.value = { ...state.value, snapshot: s });
const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
};
const termBtn = () => within(screen.getByTestId("floor")).getByRole("button", { name: "fake-shop 층 종료" });
const dialog = () => screen.queryByRole("dialog");
const status = () => screen.getByRole("status").textContent?.replace(NBSP, "");
const advance = async (ms: number) => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
};

describe("첫 창(§3.2)", () => {
  it('"종료"를 누르면 확인 창에 층 이름·폴더·구성원·스펙 문장이 있고 포커스는 [취소]', () => {
    show(snap(fl()));
    render(<App />);
    expect(termBtn().getAttribute("aria-haspopup")).toBe("dialog");
    fireEvent.click(termBtn());
    const d = dialog()!;
    expect(within(d).getByRole("heading").textContent).toBe("fake-shop 층을 끌까요?");
    expect(d.textContent).toContain("~/Code/fake-shop");
    expect(d.textContent).toContain("팀원 3명 · 작업 중 1명");
    expect(d.textContent).toContain(FLOOR_TEXT.terminateBody);
    expect(d.textContent).not.toContain(FLOOR_TEXT.currentWarn);
    expect(document.activeElement?.textContent).toBe("취소");
  });

  it("현재 세션(isCurrent)이면 ★ 경고 한 줄", () => {
    show(snap(fl({ isCurrent: true })));
    render(<App />);
    fireEvent.click(termBtn());
    expect(dialog()!.querySelector(".td-warn")?.textContent).toBe(`★ ${FLOOR_TEXT.currentWarn}`);
  });

  it("[끄기]를 누르면 terminate(force 없음)를 보내고 창이 닫히며 status로 알린다, 칩은 바로 종료 중", async () => {
    show(snap(fl()));
    render(<App />);
    fireEvent.click(termBtn());
    fireEvent.click(within(dialog()!).getByRole("button", { name: "끄기" }));
    await flush();
    expect(calls().map((c) => [c[0], c[1].body])).toEqual([["/api/floors/s1/terminate", "{}"]]);
    expect(dialog()).toBeNull();
    expect(status()).toBe("fake-shop 층에 끄기 신호를 보냈습니다");
    expect(screen.getByTestId("floor").querySelector(".chip")?.textContent).toBe("종료 중");
    expect(document.activeElement).toBe(termBtn());
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("[취소]·Esc는 요청 없이 닫히고 포커스가 종료 버튼으로", () => {
    show(snap(fl()));
    render(<App />);
    fireEvent.click(termBtn());
    fireEvent.click(within(dialog()!).getByRole("button", { name: "취소" }));
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(termBtn());
    fireEvent.click(termBtn());
    fireEvent(dialog()!, new Event("cancel", { cancelable: true }));
    expect(dialog()).toBeNull();
    expect(calls()).toHaveLength(0);
  });

  it.each([
    ["409 ended", { status: 409, body: { error: "ended" } } as Reply, FLOOR_TEXT.terminateEnded],
    ["409 pid-reused", { status: 409, body: { error: "pid-reused" } } as Reply, FLOOR_TEXT.terminateUnverified],
    ["409 unverified", { status: 409, body: { error: "unverified" } } as Reply, FLOOR_TEXT.terminateUnverified],
    ["400 self", { status: 400, body: { error: "self" } } as Reply, FLOOR_TEXT.terminateUnverified],
    ["네트워크", "network" as Reply, FLOOR_TEXT.terminateFailed],
  ])("실패(%s)면 창은 열린 채 role=alert 안내, 다시 누를 수 있다", async (_l, r, text) => {
    reply = r;
    show(snap(fl()));
    render(<App />);
    fireEvent.click(termBtn());
    fireEvent.click(within(dialog()!).getByRole("button", { name: "끄기" }));
    await flush();
    expect(within(dialog()!).getByRole("alert").textContent).toBe(text);
    expect(within(dialog()!).getByRole("button", { name: "끄기" }).getAttribute("aria-disabled")).toBeNull();
  });

  it("요청 중에는 [끄기]가 aria-disabled·aria-busy·'끄는 중…'이고 다시 눌러도 한 번", async () => {
    reply = "hold";
    show(snap(fl()));
    render(<App />);
    fireEvent.click(termBtn());
    fireEvent.click(within(dialog()!).getByRole("button", { name: "끄기" }));
    const b = within(dialog()!).getByRole("button", { name: "끄는 중…" });
    expect([b.getAttribute("aria-disabled"), b.getAttribute("aria-busy")]).toEqual(["true", "true"]);
    fireEvent.click(b);
    await act(async () => release?.());
    await flush();
    expect(calls()).toHaveLength(1);
  });
});

describe("둘째 창(§3.3)과 타이머(Review Focus 1)", () => {
  const sendFirst = async () => {
    fireEvent.click(termBtn());
    fireEvent.click(within(dialog()!).getByRole("button", { name: "끄기" }));
    await flush();
  };

  it("10초 뒤에도 alive면 둘째 창(스펙 문장), [강제로 끄기]는 { force: true }", async () => {
    show(snap(fl()));
    const { rerender } = render(<App />);
    await sendFirst();
    show(snap(fl({ terminating: true })));
    rerender(<App />);
    await advance(9_999);
    expect(dialog()).toBeNull();
    await advance(2);
    const d = dialog()!;
    expect(within(d).getByRole("heading").textContent).toBe("fake-shop 층이 아직 끝나지 않았습니다");
    expect(d.textContent).toContain(FLOOR_TEXT.forceBody);
    expect(document.activeElement?.textContent).toBe("취소");
    reply = { status: 200, body: { signal: "SIGKILL" } };
    fireEvent.click(within(d).getByRole("button", { name: "강제로 끄기" }));
    await flush();
    expect(calls().map((c) => c[1].body)).toEqual(["{}", '{"force":true}']);
    expect(dialog()).toBeNull();
    expect(status()).toBe("fake-shop 층을 강제로 끄는 신호를 보냈습니다");
  });

  it("예산 설정 창이 열려 있으면 닫힐 때까지 둘째 창을 미룬다(B131)", async () => {
    show(snap(fl()));
    const { rerender } = render(<App />);
    await sendFirst();
    show(snap(fl({ terminating: true })));
    rerender(<App />);
    fireEvent.click(within(screen.getByTestId("floor")).getByRole("button", { name: "fake-shop 예산 설정" }));
    await advance(11_000);
    expect(screen.queryAllByRole("dialog").map((d) => d.querySelector("h2")?.textContent)).toEqual(["fake-shop 예산"]);
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true })); // 예산 창 닫기(Esc)
    await flush();
    expect(within(dialog()!).getByRole("heading").textContent).toBe("fake-shop 층이 아직 끝나지 않았습니다");
  });

  it("다른 층의 종료 창이 열려 있어도 닫힐 때까지 미룬다(B133 g)", async () => {
    show(snap(fl(), fl({ id: "s2", name: "other", floor: 2 })));
    const { rerender } = render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "fake-shop 층 종료" }));
    fireEvent.click(within(dialog()!).getByRole("button", { name: "끄기" }));
    await flush();
    show(snap(fl({ terminating: true }), fl({ id: "s2", name: "other", floor: 2 })));
    rerender(<App />);
    fireEvent.click(screen.getByRole("button", { name: "other 층 종료" }));
    await advance(11_000);
    expect(screen.queryAllByRole("dialog").map((d) => d.querySelector("h2")?.textContent)).toEqual([FLOOR_TEXT.terminateTitle("other")]);
    fireEvent.click(within(dialog()!).getByRole("button", { name: "취소" }));
    await advance(500);
    expect(within(dialog()!).getByRole("heading").textContent).toBe("fake-shop 층이 아직 끝나지 않았습니다");
  });

  it("10초 안에 다시 연 둘째 창을 [취소]하거나 [강제로 끄기]하면 옛 10초 타이머가 다시 창을 띄우지 않는다(B133 e)", async () => {
    for (const how of ["취소", "강제로 끄기"]) {
      reply = { status: 200, body: { signal: "SIGTERM" } };
      show(snap(fl()));
      const { rerender, unmount } = render(<App />);
      await sendFirst();
      show(snap(fl({ terminating: true })));
      rerender(<App />);
      await advance(3_000);
      fireEvent.click(termBtn());
      fireEvent.click(within(dialog()!).getByRole("button", { name: how }));
      await flush();
      await advance(8_000);
      expect(dialog(), how).toBeNull();
      unmount();
    }
  });

  it("10초 전에 층이 끝나면 둘째 창이 뜨지 않고, 이 화면에서 끈 층이 끝나면 '꺼짐'을 알린다(B124 ⑧)", async () => {
    show(snap(fl()));
    const { rerender } = render(<App />);
    await sendFirst();
    await advance(5_000);
    show(snap(fl({ alive: false, floorStatus: "ended", endedAt: new Date().toISOString(), members: [lead({ state: "offline" })] })));
    rerender(<App />);
    await advance(10_000);
    expect(dialog()).toBeNull();
    expect(status()).toBe("fake-shop 층이 꺼졌습니다");
  });

  it("층이 목록에서 사라져도 둘째 창이 뜨지 않는다", async () => {
    show(snap(fl()));
    const { rerender } = render(<App />);
    await sendFirst();
    show(snap());
    rerender(<App />);
    await advance(11_000);
    expect(dialog()).toBeNull();
  });

  it("[끄기] 요청 중에 [취소]로 닫으면 요청이 성공해도 10초 타이머를 시작하지 않고, 다시 누르면 둘째 창부터", async () => {
    reply = "hold";
    show(snap(fl()));
    const { rerender } = render(<App />);
    fireEvent.click(termBtn());
    fireEvent.click(within(dialog()!).getByRole("button", { name: "끄기" }));
    fireEvent.click(within(dialog()!).getByRole("button", { name: "취소" }));
    await act(async () => release?.());
    await flush();
    show(snap(fl({ terminating: true })));
    rerender(<App />);
    await advance(11_000);
    expect(dialog()).toBeNull();
    fireEvent.click(termBtn());
    expect(within(dialog()!).getByRole("heading").textContent).toBe("fake-shop 층이 아직 끝나지 않았습니다");
  });

  it("종료 중(terminating·alive)인 층에서 종료를 누르면 둘째 창부터", () => {
    show(snap(fl({ terminating: true })));
    render(<App />);
    fireEvent.click(termBtn());
    expect(within(dialog()!).getByRole("button", { name: "강제로 끄기" })).toBeTruthy();
  });

  it("둘째 창이 떠 있는 동안 층이 끝나면 창을 닫지 않고 '이미 끝난 층입니다.'(B124 ⑦)", async () => {
    show(snap(fl({ terminating: true })));
    const { rerender } = render(<App />);
    fireEvent.click(termBtn());
    show(snap(fl({ alive: false, floorStatus: "ended", endedAt: new Date().toISOString(), members: [lead({ state: "offline" })] })));
    rerender(<App />);
    const d = dialog()!;
    expect(within(d).getByRole("alert").textContent).toBe(FLOOR_TEXT.terminateEnded);
    expect(within(d).getByRole("button", { name: "강제로 끄기" }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(within(d).getByRole("button", { name: "강제로 끄기" }));
    expect(calls()).toHaveLength(0);
    fireEvent.click(within(d).getByRole("button", { name: "취소" }));
    expect(dialog()).toBeNull();
    // 층이 끝나 종료 버튼이 삭제로 바뀌었으면 그 층의 삭제 버튼으로
    expect(document.activeElement?.textContent).toBe("삭제");
  });

  it("종료 중 칩은 스냅샷이 terminating을 싣지 않으면 6초 뒤 사라진다(B127)", async () => {
    show(snap(fl()));
    const { rerender } = render(<App />);
    await sendFirst();
    expect(screen.getByTestId("floor").querySelector(".chip")?.textContent).toBe("종료 중");
    await advance(6_001);
    show(snap(fl()));
    rerender(<App />);
    expect(screen.getByTestId("floor").querySelector(".chip")?.textContent).toBe("작업 중");
  });
});
