// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionView, Member, PolicyRules, Snapshot } from "../../src/shared/types";
import { makeMember, makeSession, makeSnapshot } from "./fixtures";

const state = vi.hoisted(() => ({ value: { snapshot: null as unknown, live: true, unauthorized: false, markUnauthorized: () => {} } }));
vi.mock("../../web/useSnapshot", async (orig) => ({ ...(await orig<typeof import("../../web/useSnapshot")>()), useSnapshot: () => state.value }));

import { App } from "../../web/App";
import { LIST_TEXT, TEXT, parseNewTarget } from "../../web/policy/text";

const NBSP = " ";
type Reply = { status: number; body?: unknown } | "network";
let reply: Reply;
let fetchMock: ReturnType<typeof vi.fn>;
const DIAG = { doctor: [], hooks: { total: 0, byEvent: {}, lastAt: null, rejected: { "403": 0, "415": 0, "413": 0, "400": 0 }, last10min: 0 }, errorsLastHour: 0, logDir: "l", diagDir: "d" };
const policyCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]).startsWith("/api/policy")) as Array<[string, { method: string; body: string }]>;

beforeEach(() => {
  reply = { status: 200, body: { saved: true } };
  fetchMock = vi.fn(async (url: string) => {
    if (!String(url).startsWith("/api/policy")) return { ok: true, status: 200, json: async () => DIAG };
    if (reply === "network") throw new TypeError("network");
    const r = reply;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body ?? {} };
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const lead = (p: Partial<Member> = {}) => makeMember({ name: "team-lead", role: "lead", ...p });
function snap(o: { members?: Member[]; targets?: Record<string, PolicyRules>; unreadable?: boolean; decisions?: DecisionView[]; noSessions?: boolean } = {}): Snapshot {
  const members = o.members ?? [lead(), makeMember({ name: "reviewer", role: "reviewer" })];
  return makeSnapshot({
    sessions: o.noSessions ? [] : [makeSession({ id: "s1", members })],
    decisions: o.decisions ?? [],
    ...(o.targets || o.unreadable ? { policy: { targets: o.targets ?? {}, counts: {}, ...(o.unreadable ? { unreadable: true as const } : {}) } } : {}),
  });
}
function show(s: Snapshot) {
  state.value = { ...state.value, snapshot: s };
}
const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
};
const chip = () => screen.getByRole("button", { name: /^권한 정책 열기/ });
const list = () => document.getElementById("pl-panel")!;
const rows = () => [...list().querySelectorAll(".pl-row")].map((r) => r.querySelector(".pl-label")?.textContent);
const row = (label: string) => [...list().querySelectorAll<HTMLElement>(".pl-row")].find((r) => r.querySelector(".pl-label")?.textContent === label)!;
const status = () => screen.getByRole("status").textContent?.replace(NBSP, "");
const openList = () => fireEvent.click(chip());

describe("HUD 권한 정책 버튼(§5)", () => {
  it("정책이 하나라도 있으면 개수를 보여 주고, aria-expanded가 서랍을 따른다", () => {
    show(snap());
    const { rerender } = render(<App />);
    expect(chip().getAttribute("aria-label")).toBe("권한 정책 열기");
    expect(chip().querySelector(".pc-count")).toBeNull();
    show(snap({ targets: { lead: { bash: "deny" }, "agent:a": { bash: "deny" }, "sub:Explore": { edit: "deny" } } }));
    rerender(<App />);
    expect(chip().getAttribute("aria-label")).toBe("권한 정책 열기, 대상 3개");
    expect(chip().querySelector(".pc-count")?.textContent).toBe("3");
    expect(chip().getAttribute("aria-expanded")).toBe("false");
    openList();
    expect(chip().getAttribute("aria-expanded")).toBe("true");
    expect(chip().getAttribute("aria-controls")).toBe("pl-panel");
  });
});

describe("읽지 못한 정책 파일(B101)", () => {
  it("목록 맨 위에 경고가 보이고 HUD 버튼에 표시가 붙는다", () => {
    show(snap({ unreadable: true }));
    render(<App />);
    expect(chip().getAttribute("aria-label")).toBe("권한 정책 열기, 정책 파일을 읽지 못함");
    expect(chip().querySelector(".pc-warn")).not.toBeNull();
    openList();
    const box = list().querySelector(".pl-unread")!;
    expect(box.textContent).toContain(LIST_TEXT.unreadHead);
    expect(box.textContent).toContain(LIST_TEXT.unreadBody);
    expect(box.getAttribute("role")).toBeNull();
    expect(box.nextElementSibling?.textContent).toBe(LIST_TEXT.limitLine);
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("대상이 있을 때의 aria-label", () => {
    show(snap({ unreadable: true, targets: { lead: { bash: "deny" } } }));
    render(<App />);
    expect(chip().getAttribute("aria-label")).toBe("권한 정책 열기, 대상 1개, 정책 파일을 읽지 못함");
  });

  it("unreadable이 없으면 둘 다 없다", () => {
    show(snap());
    render(<App />);
    expect(chip().querySelector(".pc-warn")).toBeNull();
    openList();
    expect(list().querySelector(".pl-unread")).toBeNull();
  });
});

describe("목록 서랍(§4)", () => {
  it("버튼을 누르면 목록 서랍이 열리고 맨 위에 한계 한 줄이 늘 있다", () => {
    show(snap());
    render(<App />);
    openList();
    expect(list().getAttribute("role")).toBe("dialog");
    expect(list().textContent).toContain("대시보드가 켜져 있을 때만 적용됩니다.");
    expect(document.activeElement?.id).toBe("pl-title");
  });

  it("리드와 그 밖의 모든 행은 규칙이 없어도 늘 있다(B95)", () => {
    show(snap({ noSessions: true }));
    render(<App />);
    openList();
    expect(rows()).toEqual(["리드", "그 밖의 모든 팀원·서브에이전트"]);
    for (const l of ["리드", "그 밖의 모든 팀원·서브에이전트"]) {
      expect(row(l).textContent).toContain("정한 것 없음");
      within(row(l)).getByRole("button", { name: `${l} 정책 고치기` });
      expect(within(row(l)).queryByRole("button", { name: `${l} 정책 지우기` })).toBeNull();
    }
    expect(list().textContent).toContain(LIST_TEXT.empty);
    expect(chip().getAttribute("aria-label")).toBe("권한 정책 열기");
  });

  it("저장된 모든 대상이 보이고(화면에 없는 이름 포함) 행 순서는 lead → agent → sub → others", () => {
    show(snap({ targets: { others: { web: "ask" }, "sub:Plan": { bash: "deny" }, "agent:zeta": { bash: "deny" }, "agent:ghost": { bash: "deny", edit: "deny" }, "sub:Explore": { edit: "deny" }, lead: { bash: "ask" } } }));
    render(<App />);
    openList();
    expect(rows()).toEqual(["리드", "ghost", "zeta", "서브에이전트(Explore)", "서브에이전트(Plan)", "그 밖의 모든 팀원·서브에이전트"]);
    const g = row("ghost");
    expect(g.textContent).toContain("명령 실행 금지 · 파일 고치기 금지");
    expect(g.textContent).toContain("지금 없음");
    within(g).getByRole("button", { name: "ghost 정책 고치기" });
    within(g).getByRole("button", { name: "ghost 정책 지우기" });
    expect(list().textContent).not.toContain(LIST_TEXT.empty);
  });

  it("[고치기]는 그 대상의 에이전트 패널을 열고, ‹는 목록으로, ×는 HUD 버튼으로", () => {
    show(snap({ targets: { "agent:ghost": { bash: "deny" }, "agent:reviewer": { web: "ask" } } }));
    render(<App />);
    openList();
    fireEvent.click(within(row("ghost")).getByRole("button", { name: "ghost 정책 고치기" }));
    expect(document.getElementById("pl-panel")).toBeNull();
    const p = document.getElementById("agent-panel")!;
    expect(p.textContent).toContain(TEXT.notOnScreen);
    fireEvent.click(within(p).getByRole("button", { name: "정책 목록으로 돌아가기" }));
    expect(document.activeElement?.getAttribute("aria-label")).toBe("ghost 정책 고치기");
    // 책상이 화면에 있는 대상도 목록에서 열었으면 닫을 때 HUD 버튼으로(B95)
    fireEvent.click(within(row("reviewer")).getByRole("button", { name: "reviewer 정책 고치기" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.getElementById("agent-panel")).toBeNull();
    expect(document.activeElement).toBe(chip());
  });

  it("[지우기]는 확인을 거쳐 DELETE를 보낸다", async () => {
    show(snap({ targets: { "agent:ghost": { bash: "deny" } } }));
    render(<App />);
    openList();
    fireEvent.click(within(row("ghost")).getByRole("button", { name: "ghost 정책 지우기" }));
    expect(row("ghost").textContent).toContain(LIST_TEXT.confirmNamed);
    expect(document.activeElement?.textContent).toBe("취소");
    expect(policyCalls()).toHaveLength(0);
    fireEvent.click(within(row("ghost")).getByRole("button", { name: "지우기" }));
    await flush();
    expect(policyCalls()[0][0]).toBe("/api/policy/targets/agent%3Aghost");
    expect(policyCalls()[0][1].method).toBe("DELETE");
    expect(status()).toBe("ghost 권한 정책을 지웠습니다");
  });

  it("지우는 중의 버튼은 disabled가 아니라 aria-disabled·aria-busy이고 요청은 한 번(d09c91d §4.3)", async () => {
    let finish!: (v: unknown) => void;
    fetchMock.mockImplementation(async (url: string) => {
      if (!String(url).startsWith("/api/policy")) return { ok: true, status: 200, json: async () => DIAG };
      await new Promise((r) => (finish = r));
      return { ok: true, status: 200, json: async () => ({ saved: true }) };
    });
    show(snap({ targets: { "agent:ghost": { bash: "deny" } } }));
    render(<App />);
    openList();
    fireEvent.click(within(row("ghost")).getByRole("button", { name: "ghost 정책 지우기" }));
    fireEvent.click(within(row("ghost")).getByRole("button", { name: "지우기" }));
    const btn = within(row("ghost")).getByRole("button", { name: LIST_TEXT.deleting }) as HTMLButtonElement;
    expect([btn.disabled, btn.getAttribute("aria-disabled"), btn.getAttribute("aria-busy")]).toEqual([false, "true", "true"]);
    fireEvent.click(btn);
    await act(async () => finish(null));
    await flush();
    expect(policyCalls()).toHaveLength(1);
  });

  it("리드·그 밖의 모든을 지울 때는 다른 확인 문구", () => {
    show(snap({ targets: { lead: { bash: "deny" } } }));
    render(<App />);
    openList();
    fireEvent.click(within(row("리드")).getByRole("button", { name: "리드 정책 지우기" }));
    expect(row("리드").textContent).toContain(LIST_TEXT.confirmFixed);
  });

  it("지우기가 실패하면 행이 남고 role=alert 문구, 취소는 원래 모양으로", async () => {
    reply = "network";
    show(snap({ targets: { "agent:ghost": { bash: "deny" } } }));
    render(<App />);
    openList();
    fireEvent.click(within(row("ghost")).getByRole("button", { name: "ghost 정책 지우기" }));
    fireEvent.click(within(row("ghost")).getByRole("button", { name: "지우기" }));
    await flush();
    expect(within(row("ghost")).getByRole("alert").textContent).toBe(LIST_TEXT.deleteFailed);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("ghost 정책 지우기");
    fireEvent.click(within(row("ghost")).getByRole("button", { name: "ghost 정책 지우기" }));
    fireEvent.click(within(row("ghost")).getByRole("button", { name: "취소" }));
    expect(row("ghost").textContent).toContain("명령 실행 금지");
  });

  it("[대상 추가]: 이름을 넣으면 권한 칸이 열리고 [저장]해야 만들어진다", async () => {
    show(snap());
    render(<App />);
    openList();
    fireEvent.click(within(list()).getByRole("button", { name: "대상 추가" }));
    fireEvent.change(within(list()).getByLabelText("팀원 이름"), { target: { value: "  docs " } });
    fireEvent.click(within(list()).getByRole("button", { name: "열기" }));
    const p = document.getElementById("agent-panel")!;
    expect(within(p).getByRole("heading", { level: 2 }).textContent).toBe("docs");
    expect(policyCalls()).toHaveLength(0);
    fireEvent.click(within(within(p).getByRole("radiogroup", { name: "명령 실행" })).getByRole("radio", { name: "금지" }));
    fireEvent.click(within(p).getByRole("button", { name: /^저장/ }));
    await flush();
    expect(policyCalls()[0][0]).toBe("/api/policy/targets/agent%3Adocs");
  });

  it("서브에이전트 종류로 추가하면 sub: 대상이 열린다", () => {
    show(snap());
    render(<App />);
    openList();
    fireEvent.click(within(list()).getByRole("button", { name: "대상 추가" }));
    fireEvent.click(within(list()).getByRole("radio", { name: "서브에이전트" }));
    fireEvent.change(within(list()).getByLabelText("서브에이전트 종류"), { target: { value: "Explore" } });
    fireEvent.keyDown(within(list()).getByLabelText("서브에이전트 종류"), { key: "Enter" });
    expect(within(document.getElementById("agent-panel")!).getByRole("heading", { level: 2 }).textContent).toBe("서브에이전트(Explore)");
  });

  it.each([
    ["빈 이름", "", LIST_TEXT.errEmpty],
    ["공백만", "   ", LIST_TEXT.errEmpty],
    ["101자", "가".repeat(101), LIST_TEXT.errLong],
    ["제어 문자", "a\tb", LIST_TEXT.errControl],
    ["예약어", "__proto__", LIST_TEXT.errReserved],
  ])("틀린 이름은 안내하고 열지 않는다 — %s", (_l, name, text) => {
    show(snap());
    render(<App />);
    openList();
    fireEvent.click(within(list()).getByRole("button", { name: "대상 추가" }));
    const input = within(list()).getByLabelText("팀원 이름");
    fireEvent.change(input, { target: { value: name } });
    fireEvent.click(within(list()).getByRole("button", { name: "열기" }));
    expect(document.getElementById("agent-panel")).toBeNull();
    expect(list().textContent).toContain(text);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(input);
  });

  it("parseNewTarget는 앞뒤 공백을 자르고 서버 규칙을 따른다", () => {
    expect(parseNewTarget("agent", " rev ")).toEqual({ key: "agent:rev" });
    expect(parseNewTarget("sub", "Explore")).toEqual({ key: "sub:Explore" });
    expect(parseNewTarget("agent", "가".repeat(100))).toEqual({ key: `agent:${"가".repeat(100)}` });
    expect(parseNewTarget("agent", "constructor")).toEqual({ error: LIST_TEXT.errReserved });
  });

  it("이미 있는 대상을 추가하면 그 대상의 패널이 기존 값으로 열린다", () => {
    show(snap({ targets: { "agent:docs": { web: "ask" } } }));
    render(<App />);
    openList();
    fireEvent.click(within(list()).getByRole("button", { name: "대상 추가" }));
    fireEvent.change(within(list()).getByLabelText("팀원 이름"), { target: { value: "docs" } });
    fireEvent.click(within(list()).getByRole("button", { name: "열기" }));
    const p = document.getElementById("agent-panel")!;
    const checked = (within(within(p).getByRole("radiogroup", { name: "웹 접근" })).getAllByRole("radio") as HTMLInputElement[]).find((r) => r.checked);
    expect(checked?.value).toBe("ask");
  });

  it("대상이 200개면 [대상 추가]를 누를 때 상한 안내를 보여 준다", () => {
    const targets: Record<string, PolicyRules> = {};
    for (let i = 0; i < 200; i++) targets[`agent:a${i}`] = { bash: "deny" };
    show(snap({ targets }));
    render(<App />);
    openList();
    fireEvent.click(within(list()).getByRole("button", { name: "대상 추가" }));
    expect(list().textContent).toContain(TEXT.limit);
    expect(within(list()).queryByLabelText("팀원 이름")).toBeNull();
    expect(chip().querySelector(".pc-count")?.textContent).toBe("200");
  });

  it("대상이 50개여도 모든 행이 DOM에 있다", () => {
    const targets: Record<string, PolicyRules> = {};
    for (let i = 0; i < 50; i++) targets[`agent:a${String(i).padStart(2, "0")}`] = { bash: "deny" };
    show(snap({ targets }));
    render(<App />);
    openList();
    expect(rows()).toHaveLength(52);
  });

  it("Esc로 닫히고 포커스가 HUD 버튼으로 돌아간다, role=status는 하나", () => {
    show(snap());
    render(<App />);
    chip().focus();
    openList();
    expect(screen.getAllByRole("status")).toHaveLength(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.getElementById("pl-panel")).toBeNull();
    expect(document.activeElement).toBe(chip());
  });

  it("Esc는 지우기 확인과 대상 추가 칸을 먼저 닫는다", () => {
    show(snap({ targets: { "agent:ghost": { bash: "deny" } } }));
    render(<App />);
    openList();
    fireEvent.click(within(row("ghost")).getByRole("button", { name: "ghost 정책 지우기" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(row("ghost").textContent).not.toContain(LIST_TEXT.confirmNamed);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("ghost 정책 지우기");
    fireEvent.click(within(list()).getByRole("button", { name: "대상 추가" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(within(list()).queryByLabelText("팀원 이름")).toBeNull();
    expect(document.getElementById("pl-panel")).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.getElementById("pl-panel")).toBeNull();
  });

  it("서랍은 한 번에 하나: 목록·보고서·진단·에이전트 패널", async () => {
    const d1: DecisionView = {
      id: "d1", sessionId: "s1", agent: "developer", kind: "permission", toolName: "Bash", state: "pending",
      createdAt: new Date().toISOString(), deadline: new Date(Date.now() + 590_000).toISOString(), detail: { command: "ls" }, answerable: true,
    };
    show(snap({ members: [lead(), makeMember({ name: "reviewer", role: "reviewer" }), makeMember({ name: "developer", state: "decision", decision: { kind: "permission", since: d1.createdAt, id: "d1", deadline: d1.deadline } })], decisions: [d1] }));
    render(<App />);
    fireEvent.click(screen.getByTestId("desk-developer"));
    openList();
    await flush();
    expect(document.getElementById("decision-report")).toBeNull();
    expect(document.getElementById("pl-panel")).not.toBeNull();
    fireEvent.click(screen.getByTestId("desk-reviewer"));
    await flush();
    expect(document.getElementById("pl-panel")).toBeNull();
    openList();
    fireEvent.click(screen.getByRole("button", { name: /^진단/ }));
    await flush();
    expect(document.getElementById("pl-panel")).toBeNull();
    openList();
    await flush();
    expect(document.querySelector(".diag-panel")).toBeNull();
    fireEvent.click(screen.getByTestId("desk-developer"));
    await flush();
    expect(document.getElementById("pl-panel")).toBeNull();
    expect(document.getElementById("decision-report")).not.toBeNull();
  });
});
