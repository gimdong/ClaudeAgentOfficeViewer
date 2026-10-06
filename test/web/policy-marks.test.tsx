// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionView, Member, MemberPolicy, PolicyRules, Snapshot } from "../../src/shared/types";
import { Desk } from "../../web/office/Desk";
import { makeMember, makeSession, makeSnapshot } from "./fixtures";

const state = vi.hoisted(() => ({ value: { snapshot: null as unknown, live: true, unauthorized: false, markUnauthorized: () => {} } }));
vi.mock("../../web/useSnapshot", async (orig) => ({ ...(await orig<typeof import("../../web/useSnapshot")>()), useSnapshot: () => state.value }));

import { App } from "../../web/App";

const T0 = Date.UTC(2026, 9, 7, 3, 0, 0);
let fetchMock: ReturnType<typeof vi.fn>;
const DIAG = { doctor: [], hooks: { total: 0, byEvent: {}, lastAt: null, rejected: { "403": 0, "415": 0, "413": 0, "400": 0 }, last10min: 0 }, errorsLastHour: 0, logDir: "l", diagDir: "d" };
beforeEach(() => {
  fetchMock = vi.fn(async (url: string) => (String(url).startsWith("/api/decisions") ? { ok: true, status: 200, json: async () => ({ state: "answered-dashboard" }) } : { ok: true, status: 200, json: async () => DIAG }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const own: MemberPolicy = { source: "own", rules: { bash: "deny" }, denied: 0, asked: 0 };
const lead = (p: Partial<Member> = {}) => makeMember({ name: "team-lead", role: "lead", ...p });
function snap(members: Member[], o: { decisions?: DecisionView[]; targets?: Record<string, PolicyRules>; counts?: Record<string, { denied: number; asked: number }> } = {}): Snapshot {
  return makeSnapshot({
    sessions: [makeSession({ id: "s1", members })],
    decisions: o.decisions ?? [],
    ...(o.targets || o.counts ? { policy: { targets: o.targets ?? {}, counts: o.counts ?? {} } } : {}),
  });
}
const show = (s: Snapshot) => (state.value = { ...state.value, snapshot: s });
const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
};
function dv(p: Partial<DecisionView> = {}): DecisionView {
  return {
    id: "d1", sessionId: "s1", agent: "reviewer", kind: "permission", toolName: "Bash", state: "pending",
    createdAt: new Date(T0).toISOString(), deadline: new Date(T0 + 590_000).toISOString(), detail: { command: "ls" }, answerable: true, ...p,
  };
}
const withDecision = (m: Member, d: DecisionView): Member => ({ ...m, state: "decision", decision: { kind: d.kind, since: d.createdAt, id: d.id, deadline: d.deadline } });

describe("자물쇠(§6.2)", () => {
  it("규칙이 걸린 캐릭터에 자물쇠가 보이고 aria-label에 '권한 정책 있음'이 더해진다", () => {
    show(snap([lead(), makeMember({ name: "reviewer", role: "reviewer", policy: own }), makeMember({ name: "qa", role: "qa", policy: { ...own, source: "others" } }), makeMember({ name: "docs", role: "docs" })]));
    render(<App />);
    for (const n of ["reviewer", "qa"]) {
      const desk = screen.getByTestId(`desk-${n}`);
      expect(within(desk).getByTestId("lock")).toBeTruthy();
      expect(desk.getAttribute("aria-label")).toBe(`${n}, 대기, 권한 정책 있음. 권한 정하기`);
    }
    const docs = screen.getByTestId("desk-docs");
    expect(within(docs).queryByTestId("lock")).toBeNull();
    expect(docs.getAttribute("aria-label")).toBe("docs, 대기. 권한 정하기");
  });

  it("결정 대기 중인 캐릭터도 자물쇠가 보인다", () => {
    const d = dv();
    show(snap([lead(), withDecision(makeMember({ name: "reviewer", role: "reviewer", policy: own }), d)], { decisions: [d] }));
    render(<App />);
    const desk = screen.getByTestId("desk-reviewer");
    expect(within(desk).getByTestId("lock")).toBeTruthy();
    expect(desk.getAttribute("aria-label")).toBe("reviewer, 결정 필요, 권한 정책 있음. 결정 보고서 열기");
  });

  it("컨텍스트 없는 div 책상에도 자물쇠와 덧붙임", () => {
    render(<Desk member={makeMember({ state: "working", policy: own })} />);
    const desk = screen.getByTestId("desk-developer");
    expect(desk.tagName).toBe("DIV");
    expect(desk.getAttribute("aria-label")).toBe("developer, 작업 중, 권한 정책 있음");
    expect(within(desk).getByTestId("lock")).toBeTruthy();
  });

  it("방금 막힘은 색만으로 알리지 않는다: 모양이 다른 자물쇠와 aria 덧붙임, 손은 들지 않는다", () => {
    const at = new Date(T0).toISOString();
    show(snap([lead(), makeMember({ name: "reviewer", role: "reviewer", policy: own, policyDenied: { group: "bash", at } }), makeMember({ name: "qa", role: "qa", policy: own })]));
    render(<App />);
    const desk = screen.getByTestId("desk-reviewer");
    expect(desk.getAttribute("aria-label")).toBe("reviewer, 대기, 권한 정책 있음, 방금 정책으로 막힘. 권한 정하기");
    const denied = within(desk).getByTestId("lock");
    const normal = within(screen.getByTestId("desk-qa")).getByTestId("lock");
    expect(denied.getAttribute("data-shape")).toBe("denied");
    expect(normal.getAttribute("data-shape")).toBe("normal");
    expect(denied.querySelectorAll("rect").length).not.toBe(normal.querySelectorAll("rect").length);
    expect(desk.className).not.toContain("desk--decision");
    expect(desk.querySelector(".qmark")).toBeNull();
  });
});

describe("패널 횟수(§1.5)", () => {
  it("리드 패널의 서브에이전트 절에서 sub:Explore를 고르면 그 대상의 횟수", () => {
    show(snap([lead({ subTypes: ["Explore"] })], { targets: { "sub:Explore": { edit: "deny" } }, counts: { "sub:Explore": { denied: 1204, asked: 5 } } }));
    render(<App />);
    fireEvent.click(screen.getByTestId("desk-team-lead"));
    const p = () => document.getElementById("agent-panel")!;
    const btn = within(p()).getByRole("button", { name: "서브에이전트(Explore) 권한 정하기" });
    expect(btn.querySelector("svg")).not.toBeNull(); // 규칙이 있는 종류 앞에 자물쇠 아이콘
    fireEvent.click(btn);
    expect(p().textContent).toContain("켠 뒤로 금지 1,204번 · 질문 5번");
  });
});

describe("결정 보고서(§6.4)", () => {
  it("byPolicy 권한 결정의 이유 줄", () => {
    const d = dv({ byPolicy: true });
    show(snap([lead(), withDecision(makeMember({ name: "reviewer", role: "reviewer" }), d)], { decisions: [d] }));
    render(<App />);
    fireEvent.click(screen.getByTestId("desk-reviewer"));
    expect(document.querySelector(".rp-why")?.textContent).toBe("권한 정책이 매번 확인하도록 정해 둔 도구입니다");
  });

  it.each([
    ["팀원 권한 요청", dv(), "reviewer", "reviewer"],
    ["팀원 요청(team)", dv({ kind: "team", toolName: "SendMessage", answerable: false }), "reviewer", "reviewer"],
    ["리드(서브에이전트의 요청 포함)", dv({ agent: "team-lead" }), "리드", "리드"],
  ])("'권한' 버튼은 보고서를 닫고 그 에이전트의 패널을 연다 — %s", async (_l, d, label, heading) => {
    const members = [lead(), makeMember({ name: "reviewer", role: "reviewer" })];
    const i = members.findIndex((m) => m.name === d.agent);
    members[i] = withDecision(members[i], d);
    show(snap(members, { decisions: [d] }));
    render(<App />);
    fireEvent.click(screen.getByTestId(`desk-${d.agent}`));
    fireEvent.click(within(document.getElementById("decision-report")!).getByRole("button", { name: `${label} 권한 정하기` }));
    await flush();
    expect(document.getElementById("decision-report")).toBeNull();
    const p = document.getElementById("agent-panel")!;
    expect(p).not.toBeNull();
    expect(within(p).getByRole("heading", { level: 2 }).textContent).toBe(heading);
    // 패널을 닫으면 그 에이전트의 책상으로 돌아간다(§7.2)
    fireEvent.click(within(p).getByRole("button", { name: "닫기" }));
    expect(document.activeElement).toBe(screen.getByTestId(`desk-${d.agent}`));
  });

  it("대시보드에서 허용해도 정책은 바뀌지 않는다(요청은 결정 하나뿐)", async () => {
    const d = dv({ byPolicy: true });
    show(snap([lead(), withDecision(makeMember({ name: "reviewer", role: "reviewer" }), d)], { decisions: [d] }));
    render(<App />);
    fireEvent.click(screen.getByTestId("desk-reviewer"));
    fireEvent.click(within(document.getElementById("decision-report")!).getByRole("button", { name: "허용" }));
    await flush();
    const urls = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/decisions") || u.startsWith("/api/policy"));
    expect(urls).toEqual(["/api/decisions/d1"]);
  });
});
