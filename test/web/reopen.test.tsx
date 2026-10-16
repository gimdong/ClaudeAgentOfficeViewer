// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Member, SessionView, Snapshot } from "../../src/shared/types";
import { makeMember, makeSession, makeSnapshot } from "./fixtures";

const state = vi.hoisted(() => ({ value: { snapshot: null as unknown, live: true, unauthorized: false, markUnauthorized: () => {} } }));
vi.mock("../../web/useSnapshot", async (orig) => ({ ...(await orig<typeof import("../../web/useSnapshot")>()), useSnapshot: () => state.value }));

import { App } from "../../web/App";
import { CH_TEXT } from "../../web/floors/ChannelDialogs";
import { RE_TEXT, resetReopen } from "../../web/floors/ReopenDialog";
import { FLOOR_TEXT } from "../../web/floors/useFloors";

// 옮겨 열기 화면(docs/design/phase4b/REOPEN.md). 서버는 가짜 fetch — 실제 세션·신호 없음
const DIAG = { doctor: [], hooks: { total: 0, byEvent: {}, lastAt: null, rejected: { "403": 0, "415": 0, "413": 0, "400": 0 }, last10min: 0 }, errorsLastHour: 0, logDir: "l", diagDir: "d" };
type Reply = { status: number; body: unknown };
let reply: Reply | "hold";
let release: ((r: Reply) => void) | null;
let fetchMock: ReturnType<typeof vi.fn>;
const reopens = () => fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/reopen")).map((c) => [String(c[0]), (c[1] as { body?: string }).body]);

beforeEach(() => {
  resetReopen();
  reply = { status: 200, body: { tmux: "co-abcd1234" } };
  release = null;
  fetchMock = vi.fn(async (url: string) => {
    if (String(url).startsWith("/api/diagnostics")) return { ok: true, status: 200, json: async () => DIAG };
    if (!String(url).endsWith("/reopen")) return { ok: true, status: 200, json: async () => ({}) };
    const r = reply === "hold" ? await new Promise<Reply>((res) => (release = res)) : reply;
    return { ok: r.status < 300, status: r.status, json: async () => r.body };
  });
  vi.stubGlobal("fetch", fetchMock);
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const lead = (p: Partial<Member> = {}) => makeMember({ name: "team-lead", role: "lead", ...p });
const fl = (p: Partial<SessionView> = {}) => makeSession({ id: "s1", name: "fake-shop", cwd: "/Users/fakeuser/Code/fake-shop", floorStatus: "idle", reopen: "ok", members: [lead(), makeMember({ name: "dev" })], ...p });
const snap = (...s: SessionView[]): Snapshot => makeSnapshot({ sessions: s, experimental: { channels: true, available: true } });
const show = (s: Snapshot) => (state.value = { ...state.value, snapshot: s });
const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
};
const btn = () => screen.queryByRole("button", { name: "fake-shop 층 작업 지시 켜기" });
const dialog = () => screen.queryByRole("dialog");

describe("버튼(§1)", () => {
  it("ok: 작업 지시 자리에 누를 수 있는 '작업 지시 켜기'(aria-haspopup, title)", () => {
    show(snap(fl()));
    render(<App />);
    const b = btn()!;
    expect(b.textContent).toContain(RE_TEXT.button);
    expect([b.getAttribute("aria-disabled"), b.getAttribute("aria-haspopup"), b.getAttribute("title"), b.getAttribute("data-floor-action")]).toEqual([null, "dialog", RE_TEXT.title, "reopen"]);
    expect(screen.queryByRole("button", { name: /^작업 지시$/ })).toBeNull();
  });

  it.each([
    ["merged", RE_TEXT.titleMerged],
    ["ancestor", RE_TEXT.titleAncestor],
    ["paused", RE_TEXT.titlePaused],
    ["busy", RE_TEXT.titleMoving],
  ] as const)("%s: 막힘(aria-disabled) + 이유 title, 눌러도 창이 열리지 않는다", (reopen, title) => {
    show(snap(fl({ reopen, ...(reopen === "paused" ? { floorStatus: "paused", pausedDenied: 0 } : {}) })));
    render(<App />);
    const b = btn()!;
    expect([b.getAttribute("aria-disabled"), b.getAttribute("title")]).toEqual(["true", title]);
    fireEvent.click(b);
    expect(dialog()).toBeNull();
  });

  it("화면이 멈춤으로 보이는 층(스냅샷 값이 아직 ok)도 멈춘 층 제목으로 막힌다(B202)", () => {
    show(snap(fl({ reopen: "ok", floorStatus: "paused", pausedDenied: 0 })));
    render(<App />);
    expect([btn()!.getAttribute("aria-disabled"), btn()!.getAttribute("title")]).toEqual(["true", RE_TEXT.titlePaused]);
  });

  it("launched·필드 없음: 지금처럼 4b '작업 지시'", () => {
    show(snap(fl({ reopen: "launched", channel: { connected: true, tmux: "co-1", held: 0 } }), fl({ id: "s2", name: "other", floor: 2, reopen: undefined })));
    render(<App />);
    expect(btn()).toBeNull();
    expect(screen.queryByRole("button", { name: "other 층 작업 지시 켜기" })).toBeNull();
    expect(screen.getAllByRole("button", { name: /작업 지시/ }).length).toBeGreaterThanOrEqual(2);
  });
});

describe("확인 창(§2)", () => {
  it("제목·폴더(~)·구성원·본문, 경고 없음, 방식 라디오(서브에이전트 기본)·안내, 포커스 [취소]", () => {
    show(snap(fl()));
    render(<App />);
    fireEvent.click(btn()!);
    const d = dialog()!;
    expect(within(d).getByRole("heading").textContent).toBe(RE_TEXT.dlgTitle("fake-shop"));
    expect(d.textContent).toContain("~/Code/fake-shop");
    expect(d.textContent).toContain(FLOOR_TEXT.members(2, 0));
    expect(d.textContent).toContain(RE_TEXT.body);
    expect(d.querySelectorAll(".td-warn")).toHaveLength(0);
    expect((within(d).getByRole("radio", { name: CH_TEXT.modeSub }) as HTMLInputElement).checked).toBe(true);
    expect(d.textContent).toContain(RE_TEXT.modeHint);
    expect(document.activeElement?.textContent).toBe(FLOOR_TEXT.cancel);
  });

  it("작업 중이면 ⚠ 경고, ★ 현재 세션이면 그 아래 ★ 경고. agent team을 고르면 설명 묶음", () => {
    show(snap(fl({ floorStatus: "working", isCurrent: true, members: [lead({ state: "working" })] })));
    render(<App />);
    fireEvent.click(btn()!);
    const warns = [...dialog()!.querySelectorAll(".td-warn")].map((w) => w.textContent);
    expect(warns).toEqual([RE_TEXT.workingWarn, `★ ${FLOOR_TEXT.currentWarn}`]);
    fireEvent.click(within(dialog()!).getByRole("radio", { name: CH_TEXT.modeTeam }));
    expect(screen.getByTestId("team-note")).toBeTruthy();
  });

  it("[취소]는 요청 없이 닫고 포커스를 그 층 버튼으로", async () => {
    show(snap(fl()));
    render(<App />);
    fireEvent.click(btn()!);
    fireEvent.click(within(dialog()!).getByRole("button", { name: FLOOR_TEXT.cancel }));
    await flush();
    expect(dialog()).toBeNull();
    expect(reopens()).toEqual([]);
    expect(document.activeElement).toBe(btn());
  });
});

describe("요청과 결과(§2.1·§2.2·§3)", () => {
  it("[옮겨 열기] → POST(방식), 요청 중 '옮기는 중…'·기다림 줄·[닫기], 성공하면 붙는 단계와 알림", async () => {
    reply = "hold";
    show(snap(fl()));
    render(<App />);
    fireEvent.click(btn()!);
    fireEvent.click(within(dialog()!).getByRole("radio", { name: CH_TEXT.modeTeam }));
    fireEvent.click(within(dialog()!).getByRole("button", { name: RE_TEXT.go }));
    await flush();
    expect(reopens()).toEqual([["/api/floors/s1/reopen", JSON.stringify({ mode: "team" })]]);
    const go = within(dialog()!).getByRole("button", { name: RE_TEXT.going });
    expect([go.getAttribute("aria-disabled"), go.getAttribute("aria-busy")]).toEqual(["true", "true"]);
    expect(screen.getByTestId("reopen-wait").textContent).toBe(RE_TEXT.waiting);
    expect(within(dialog()!).getByRole("button", { name: RE_TEXT.close })).toBeTruthy();
    fireEvent.click(go); // 다시 눌러도 한 번
    await act(async () => release!({ status: 200, body: { tmux: "co-abcd1234" } }));
    await flush();
    expect(reopens()).toHaveLength(1);
    const d = dialog()!;
    expect(within(d).getByRole("heading").textContent).toBe(CH_TEXT.attachTitle);
    expect(d.textContent).toContain(RE_TEXT.attachBody);
    expect(screen.getByTestId("reopen-cmd").textContent).toBe("tmux attach -t co-abcd1234");
    expect(screen.getByRole("status").textContent).toContain(RE_TEXT.done("fake-shop"));
  });

  it("요청 중 [닫기]로 닫아도 서버는 이어 가고, 그동안 층의 버튼·스위치·종료가 막히고 칩은 '종료 중'. 끝나면 창이 저절로 다시 열린다", async () => {
    reply = "hold";
    show(snap(fl()));
    const { rerender } = render(<App />);
    fireEvent.click(btn()!);
    fireEvent.click(within(dialog()!).getByRole("button", { name: RE_TEXT.go }));
    await flush();
    fireEvent.click(within(dialog()!).getByRole("button", { name: RE_TEXT.close }));
    await flush();
    expect(dialog()).toBeNull();
    const floor = screen.getByTestId("floor");
    expect([btn()!.getAttribute("aria-disabled"), btn()!.getAttribute("aria-busy"), btn()!.getAttribute("title")]).toEqual(["true", "true", RE_TEXT.titleMoving]);
    const sw = within(floor).getByRole("switch");
    expect([sw.getAttribute("aria-disabled"), sw.getAttribute("title"), sw.hasAttribute("aria-busy")]).toEqual(["true", RE_TEXT.titleMoving, false]);
    const term = within(floor).getByRole("button", { name: FLOOR_TEXT.terminateLabel("fake-shop") });
    expect([term.getAttribute("aria-disabled"), term.getAttribute("title")]).toEqual(["true", RE_TEXT.titleMoving]);
    fireEvent.click(sw);
    fireEvent.click(term);
    await flush();
    expect(dialog()).toBeNull();
    expect(fetchMock.mock.calls.some((c) => /\/(pause|resume|terminate)$/.test(String(c[0])))).toBe(false); // 막힌 버튼은 요청을 보내지 않는다
    expect(floor.querySelector(".chip--terminating")?.textContent).toBe(FLOOR_TEXT.terminating);
    // SIGTERM 뒤 층이 목록에서 잠깐 사라져도(B142) 창은 끝나면 열린다
    show(snap());
    rerender(<App />);
    await act(async () => release!({ status: 409, body: { error: "still-running", resumeId: "conv-1" } }));
    await flush();
    const d = dialog()!;
    expect(within(d).getByRole("alert").textContent).toBe(RE_TEXT.stillRunning);
    expect(screen.getByTestId("reopen-cmd").textContent).toBe("claude --resume conv-1");
    expect(within(d).getByRole("button", { name: RE_TEXT.go }).getAttribute("aria-disabled")).toBeNull(); // 다시 누를 수 있음
  });

  it.each([
    ["launch 실패(tmux)", { status: 502, body: { error: "tmux", resumeId: "conv-1" } }, RE_TEXT.launchFailed, "claude --resume conv-1", true],
    ["launch 실패(limit)", { status: 429, body: { error: "limit", resumeId: "conv-1" } }, RE_TEXT.launchFailed, "claude --resume conv-1", true],
    ["ancestor", { status: 409, body: { error: "ancestor" } }, RE_TEXT.titleAncestor, null, true],
    ["busy", { status: 409, body: { error: "busy" } }, RE_TEXT.busy, null, true],
    ["ended", { status: 409, body: { error: "ended" } }, FLOOR_TEXT.terminateEnded, null, true],
    ["unverified", { status: 409, body: { error: "unverified" } }, FLOOR_TEXT.terminateUnverified, null, false],
    ["404", { status: 404, body: {} }, FLOOR_TEXT.hideNotFound, null, true],
    ["실험 기능 꺼짐", { status: 403, body: { error: "off" } }, CH_TEXT.offTitle, null, true],
    ["네트워크·5xx", { status: 500, body: {} }, CH_TEXT.failed, null, false],
  ] as const)("실패: %s → 실패 줄(명령 상자), 다시 누를 수 있는지", async (_l, r, text, cmd, stop) => {
    reply = r;
    show(snap(fl()));
    render(<App />);
    fireEvent.click(btn()!);
    fireEvent.click(within(dialog()!).getByRole("button", { name: RE_TEXT.go }));
    await flush();
    const d = dialog()!;
    expect(within(d).getByRole("alert").textContent).toBe(text);
    expect(screen.queryByTestId("reopen-cmd")?.textContent ?? null).toBe(cmd);
    expect(within(d).getByRole("button", { name: RE_TEXT.go }).getAttribute("aria-disabled")).toBe(stop ? "true" : null);
    expect(within(d).getByRole("button", { name: stop ? RE_TEXT.close : FLOOR_TEXT.cancel })).toBeTruthy();
  });

  it("다른 탭에서 옮겨 여는 중(스냅샷 busy): 스위치·종료도 막힌다", () => {
    show(snap(fl({ reopen: "busy" })));
    render(<App />);
    const floor = screen.getByTestId("floor");
    expect(within(floor).getByRole("switch").getAttribute("aria-disabled")).toBe("true");
    expect(within(floor).getByRole("button", { name: FLOOR_TEXT.terminateLabel("fake-shop") }).getAttribute("title")).toBe(RE_TEXT.titleMoving);
  });
});
