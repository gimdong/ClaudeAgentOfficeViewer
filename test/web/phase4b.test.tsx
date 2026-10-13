// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Member, SessionView, Snapshot } from "../../src/shared/types";
import { makeMember, makeSession, makeSnapshot } from "./fixtures";

const state = vi.hoisted(() => ({ value: { snapshot: null as unknown, live: true, unauthorized: false, markUnauthorized: () => {} } }));
vi.mock("../../web/useSnapshot", async (orig) => ({ ...(await orig<typeof import("../../web/useSnapshot")>()), useSnapshot: () => state.value }));

import { App } from "../../web/App";
import { CH_TEXT } from "../../web/floors/ChannelDialogs";

const DIAG = { doctor: [], hooks: { total: 0, byEvent: {}, lastAt: null, rejected: { "403": 0, "415": 0, "413": 0, "400": 0 }, last10min: 0 }, errorsLastHour: 0, logDir: "l", diagDir: "d" };
let replies: Record<string, { status: number; body: unknown }>;
let fetchMock: ReturnType<typeof vi.fn>;
const calls = () => fetchMock.mock.calls.filter((c) => !String(c[0]).startsWith("/api/diagnostics")).map((c) => [String(c[0]), (c[1] as { method?: string } | undefined)?.method ?? "GET", (c[1] as { body?: string } | undefined)?.body] as const);

beforeEach(() => {
  replies = {};
  fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    const r = replies[key] ?? (String(url).startsWith("/api/diagnostics") ? { status: 200, body: DIAG } : { status: 200, body: {} });
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
const floorOf = (p: Partial<SessionView> = {}) => makeSession({ id: "s1", name: "alpha", floorStatus: "idle", members: [lead()], ...p });
const show = (sessions: SessionView[], exp: Snapshot["experimental"] = { channels: true, available: true }) => (state.value = { ...state.value, snapshot: makeSnapshot({ sessions, experimental: exp }) });
const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
};
const instructBtn = () => within(screen.getByTestId("floor")).getByRole("button", { name: /작업 지시/ });

describe("새 층(스펙 4장)", () => {
  it("실험 기능이 꺼져 있으면 비활성 + 이유, 켜져 있으면 창에서 띄우고 붙는 명령을 보인다", async () => {
    show([], { channels: false, available: true });
    const { rerender } = render(<App />);
    const btn = () => within(screen.getByTestId("vacant-floor")).getByRole("button", { name: /새 세션 시작/ });
    expect(btn().getAttribute("aria-disabled")).toBe("true");
    expect(btn().getAttribute("title")).toBe(CH_TEXT.offTitle);
    show([]);
    rerender(<App />);
    fireEvent.click(btn());
    replies["POST /api/floors/launch"] = { status: 200, body: { sessionId: "n1", tmux: "co-1234abcd" } };
    fireEvent.change(screen.getByLabelText(CH_TEXT.fCwd), { target: { value: " ~/work " } });
    fireEvent.change(screen.getByLabelText(CH_TEXT.fPrompt), { target: { value: "README 읽어 줘" } });
    fireEvent.click(screen.getByRole("button", { name: CH_TEXT.launch }));
    await flush();
    expect(calls()).toContainEqual(["/api/floors/launch", "POST", JSON.stringify({ cwd: "~/work", prompt: "README 읽어 줘" })]);
    expect(screen.getByTestId("attach-cmd").textContent).toBe("tmux attach -t co-1234abcd");
  });

  it("오류 코드는 사람이 읽는 문장으로", async () => {
    show([]);
    render(<App />);
    fireEvent.click(within(screen.getByTestId("vacant-floor")).getByRole("button", { name: /새 세션 시작/ }));
    replies["POST /api/floors/launch"] = { status: 400, body: { error: "cwd" } };
    fireEvent.click(screen.getByRole("button", { name: CH_TEXT.launch }));
    await flush();
    expect(screen.getByRole("alert").textContent).toBe(CH_TEXT.errors.cwd);
  });
});

describe("작업 지시(스펙 6장)", () => {
  it("대시보드가 띄우지 않은 층·연결 전 층은 비활성 + 이유", () => {
    show([floorOf()]);
    const { rerender } = render(<App />);
    expect(instructBtn().getAttribute("title")).toBe(CH_TEXT.notLaunched);
    show([floorOf({ channel: { connected: false, tmux: "co-1", held: 0 } })]);
    rerender(<App />);
    expect(instructBtn().getAttribute("title")).toBe(CH_TEXT.notConnected);
    expect(screen.getByTestId("channel-chip").textContent).toBe("대시보드가 띄움 · 연결 전");
  });

  it("연결된 층: 창에서 보내면 POST instruct, 작업 중이면 안내 한 줄, 칩은 전달됨", async () => {
    show([floorOf({ floorStatus: "working", members: [lead({ state: "working" })], channel: { connected: true, tmux: "co-1", held: 0, last: "delivered" } })]);
    render(<App />);
    expect(screen.getByTestId("channel-chip").textContent).toBe("대시보드가 띄움 · 연결됨 · 전달됨");
    fireEvent.click(instructBtn());
    expect(screen.getByText(CH_TEXT.instructBusy)).toBeTruthy();
    replies["POST /api/floors/s1/instruct"] = { status: 200, body: { id: "i1", state: "sent" } };
    fireEvent.change(screen.getByRole("textbox", { name: CH_TEXT.instruct }), { target: { value: "테스트 돌려 줘" } });
    fireEvent.click(screen.getByRole("button", { name: CH_TEXT.send }));
    await flush();
    expect(calls()).toContainEqual(["/api/floors/s1/instruct", "POST", JSON.stringify({ text: "테스트 돌려 줘" })]);
    expect(screen.queryByRole("button", { name: CH_TEXT.send })).toBeNull();
  });
});

describe("재개 브리핑(스펙 7장)", () => {
  const paused = () => floorOf({ floorStatus: "paused", pausedDenied: 0, channel: { connected: true, tmux: "co-1", held: 2 } });
  beforeEach(() => {
    replies["GET /api/floors/s1/held"] = { status: 200, body: { held: [{ id: "h1", text: "첫째", at: "t" }, { id: "h2", text: "둘째", at: "t" }] } };
  });

  it("보관 지시가 있는 층의 스위치는 바로 재개하지 않고 브리핑 창을 연다. [취소]면 재개 요청 없음", async () => {
    show([paused()]);
    render(<App />);
    expect(screen.getByTestId("channel-chip").textContent).toBe("대시보드가 띄움 · 연결됨 · 보관 2");
    fireEvent.click(screen.getByRole("switch", { name: "alpha 영업" }));
    await flush();
    expect(screen.getAllByTestId("held-item").map((li) => li.querySelector(".held-text")?.textContent)).toEqual(["첫째", "둘째"]);
    fireEvent.click(screen.getByRole("button", { name: CH_TEXT.cancel }));
    expect(calls().some(([u]) => u.endsWith("/resume"))).toBe(false);
  });

  it("고치고 지운 뒤 [보내고 재개]는 resume { sendHeld: true }", async () => {
    show([paused()]);
    render(<App />);
    fireEvent.click(screen.getByRole("switch", { name: "alpha 영업" }));
    await flush();
    fireEvent.click(within(screen.getAllByTestId("held-item")[0]).getByRole("button", { name: CH_TEXT.edit }));
    fireEvent.change(screen.getByRole("textbox", { name: CH_TEXT.edit }), { target: { value: "첫째(고침)" } });
    fireEvent.click(screen.getByRole("button", { name: CH_TEXT.save }));
    await flush();
    expect(calls()).toContainEqual(["/api/floors/s1/held/h1", "PUT", JSON.stringify({ text: "첫째(고침)" })]);
    fireEvent.click(within(screen.getAllByTestId("held-item")[1]).getByRole("button", { name: CH_TEXT.remove }));
    await flush();
    expect(calls()).toContainEqual(["/api/floors/s1/held/h2", "DELETE", "{}"]);
    replies["POST /api/floors/s1/resume"] = { status: 200, body: { paused: false, sent: 2 } };
    fireEvent.click(screen.getByRole("button", { name: CH_TEXT.sendResume }));
    await flush();
    expect(calls()).toContainEqual(["/api/floors/s1/resume", "POST", JSON.stringify({ sendHeld: true })]);
  });

  it("보관 지시가 없는 층은 4a대로 바로 재개", async () => {
    show([floorOf({ floorStatus: "paused", pausedDenied: 0, channel: { connected: true, tmux: "co-1", held: 0 } })]);
    render(<App />);
    replies["POST /api/floors/s1/resume"] = { status: 200, body: { paused: false } };
    fireEvent.click(screen.getByRole("switch", { name: "alpha 영업" }));
    await flush();
    expect(calls()).toContainEqual(["/api/floors/s1/resume", "POST", "{}"]);
  });
});

describe("실험 기능 창(스펙 3장)", () => {
  it("동의해야 켤 수 있고, 켜면 PUT /api/experimental", async () => {
    show([], { channels: false, available: true });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: CH_TEXT.expButton }));
    const on = screen.getByRole("button", { name: CH_TEXT.expOn });
    expect(on.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByRole("checkbox"));
    replies["PUT /api/experimental"] = { status: 200, body: { saved: true } };
    fireEvent.click(screen.getByRole("button", { name: CH_TEXT.expOn }));
    await flush();
    expect(calls()).toContainEqual(["/api/experimental", "PUT", JSON.stringify({ channels: true })]);
  });

  it("쓸 수 없는 환경이면 이유와 비활성 [켜기]", () => {
    show([], { channels: false, available: false, reason: "tmux" });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: CH_TEXT.expButton }));
    expect(screen.getByText(CH_TEXT.expUnavailable)).toBeTruthy();
    expect(screen.getByRole("button", { name: CH_TEXT.expOn }).getAttribute("aria-disabled")).toBe("true");
  });
});
