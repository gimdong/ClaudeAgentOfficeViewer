// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionView, Member, PolicyRules, Snapshot } from "../../src/shared/types";
import { memberKeyOf } from "../../server/policy/gate";
import { GROUP_KEYS, GROUPS, ruleLabel } from "../../server/policy/tools";
import { makeMember, makeSession, makeSnapshot } from "./fixtures";

const state = vi.hoisted(() => ({ value: { snapshot: null as unknown, live: true, unauthorized: false, markUnauthorized: () => {} } }));
vi.mock("../../web/useSnapshot", async (orig) => ({ ...(await orig<typeof import("../../web/useSnapshot")>()), useSnapshot: () => state.value }));

import { App } from "../../web/App";
import { UNAUTHORIZED_EVENT } from "../../web/useSnapshot";
import { GROUP_LABEL, GROUP_ORDER, TEMPLATES, TEXT, countsLine, summaryOf, targetKeyOf } from "../../web/policy/text";

const T0 = Date.UTC(2026, 9, 7, 3, 0, 0);
const NBSP = " ";

type Reply = { status: number; body?: unknown } | "network";
let reply: Reply;
let fetchMock: ReturnType<typeof vi.fn>;
const DIAG = { doctor: [], hooks: { total: 0, byEvent: {}, lastAt: null, rejected: { "403": 0, "415": 0, "413": 0, "400": 0 }, last10min: 0 }, errorsLastHour: 0, logDir: "l", diagDir: "d" };
const policyCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]).startsWith("/api/policy")) as Array<[string, { method: string; headers: Record<string, string>; body: string }]>;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.setSystemTime(T0);
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const lead = (p: Partial<Member> = {}) => makeMember({ name: "team-lead", role: "lead", ...p });
function snap(o: { members?: Member[]; targets?: Record<string, PolicyRules>; counts?: Record<string, { denied: number; asked: number }>; decisions?: DecisionView[] } = {}): Snapshot {
  const members = o.members ?? [lead(), makeMember({ name: "reviewer", role: "reviewer" }), makeMember({ name: "developer" })];
  return makeSnapshot({
    sessions: [makeSession({ id: "s1", members })],
    decisions: o.decisions ?? [],
    ...(o.targets || o.counts ? { policy: { targets: o.targets ?? {}, counts: o.counts ?? {} } } : {}),
  });
}
function show(s: Snapshot) {
  state.value = { ...state.value, snapshot: s };
}
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};
const panel = () => screen.getByRole("dialog", { name: /./ });
const radio = (group: string, value: string) => within(within(panel()).getByRole("radiogroup", { name: group })).getByRole("radio", { name: value }) as HTMLInputElement;
const checkedOf = (group: string) => (within(within(panel()).getByRole("radiogroup", { name: group })).getAllByRole("radio") as HTMLInputElement[]).find((r) => r.checked)?.value;
const saveBtn = () => within(panel()).getByRole("button", { name: /^저장/ });
const openDesk = (name: string) => fireEvent.click(screen.getByTestId(`desk-${name}`));
const status = () => screen.getByRole("status").textContent?.replace(NBSP, "");

describe("문구와 정의(서버와 맞춤)", () => {
  it("화면의 묶음 이름·순서가 서버 정의와 같다", () => {
    expect(GROUP_ORDER).toEqual([...GROUP_KEYS]);
    for (const k of GROUP_KEYS) expect(GROUP_LABEL[k]).toBe(GROUPS[k].label);
  });

  it("템플릿(스펙 5.3, B80)", () => {
    expect(TEMPLATES.map((t) => [t.label, t.rules])).toEqual([
      ["읽기 전용", { bash: "deny", edit: "deny" }],
      ["명령은 물어보고", { bash: "ask" }],
      ["제한 없음", {}],
    ]);
  });

  it("규칙 하나의 요약은 서버의 ruleLabel과 글자까지 같다(B92)", () => {
    for (const g of GROUP_KEYS) for (const v of ["ask", "deny"] as const) expect(summaryOf({ [g]: v })).toBe(ruleLabel(g, v));
  });

  it("summaryOf와 countsLine", () => {
    expect(summaryOf({ edit: "deny", bash: "deny" })).toBe("명령 실행 금지 · 파일 고치기 금지");
    expect(summaryOf({ web: "ask" })).toBe("웹 접근 항상 질문");
    expect(summaryOf({})).toBe("정한 것 없음");
    expect(countsLine(3, 5)).toBe("켠 뒤로 금지 3번 · 질문 5번");
    expect(countsLine(1204, 0)).toBe("켠 뒤로 금지 1,204번 · 질문 0번");
  });

  it("화면의 대상 키는 서버와 같은 규칙이다(B95)", () => {
    for (const name of ["rev", "검토 담당", "가".repeat(100), "가".repeat(101), "__proto__", " rev", "rev ", "a:b", "a\nb"]) {
      expect(targetKeyOf({ name, role: name })).toBe(memberKeyOf(name, false));
    }
    expect(targetKeyOf({ name: "team-lead", role: "lead" })).toBe("lead");
  });
});

describe("에이전트 패널 열기", () => {
  it("결정이 없는 캐릭터를 누르면 에이전트 패널이 열린다", () => {
    show(snap());
    render(<App />);
    const desk = screen.getByTestId("desk-reviewer");
    expect(desk.tagName).toBe("BUTTON");
    expect(desk.getAttribute("aria-haspopup")).toBe("dialog");
    expect(desk.getAttribute("aria-label")).toBe("reviewer, 대기. 권한 정하기");
    fireEvent.click(desk);
    const p = panel();
    expect(p.getAttribute("aria-modal")).toBe("false");
    expect(within(p).getByRole("heading", { name: "reviewer" })).toBeTruthy();
    expect(p.textContent).toContain("팀원");
    expect(p.textContent).toContain("이 이름의 정책은 다른 세션의 같은 이름에도 적용됩니다");
    expect(document.activeElement?.id).toBe("ap-title");
  });

  it("결정이 있는 캐릭터는 지금처럼 보고서가 먼저 열린다", () => {
    const d: DecisionView = {
      id: "d1", sessionId: "s1", agent: "reviewer", kind: "permission", toolName: "Bash", state: "pending",
      createdAt: new Date(T0).toISOString(), deadline: new Date(T0 + 590_000).toISOString(), detail: { command: "ls" }, answerable: true,
    };
    show(snap({ members: [lead(), makeMember({ name: "reviewer", role: "reviewer", state: "decision", decision: { kind: "permission", since: d.createdAt, id: "d1", deadline: d.deadline } })], decisions: [d] }));
    render(<App />);
    openDesk("reviewer");
    expect(document.getElementById("decision-report")).not.toBeNull();
    expect(document.getElementById("agent-panel")).toBeNull();
  });

  it("권한 칸: 묶음 일곱 줄, 줄마다 라디오 세 개, 처음 선택은 저장된 값", () => {
    show(snap({ targets: { "agent:reviewer": { bash: "deny", web: "ask" } } }));
    render(<App />);
    openDesk("reviewer");
    const groups = within(panel()).getAllByRole("radiogroup");
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual(GROUP_ORDER.map((g) => GROUP_LABEL[g]));
    for (const g of groups) expect(within(g).getAllByRole("radio").map((r) => r.closest("label")?.textContent)).toEqual(["기본", "항상 질문", "금지"]);
    expect([checkedOf("명령 실행"), checkedOf("웹 접근"), checkedOf("파일 고치기")]).toEqual(["deny", "ask", "default"]);
  });

  it("키보드로 고른다(같은 name의 네이티브 라디오)", () => {
    show(snap());
    render(<App />);
    openDesk("reviewer");
    const r = within(within(panel()).getByRole("radiogroup", { name: "명령 실행" })).getAllByRole("radio") as HTMLInputElement[];
    expect(new Set(r.map((x) => x.name)).size).toBe(1);
    expect(r.every((x) => x.type === "radio")).toBe(true);
    fireEvent.click(r[2]);
    expect(checkedOf("명령 실행")).toBe("deny");
  });
});

describe("편집과 저장", () => {
  it("템플릿을 누르면 표 전체가 바뀌고 [저장] 전에는 요청이 없다", () => {
    show(snap({ targets: { "agent:reviewer": { web: "ask" } } }));
    render(<App />);
    openDesk("reviewer");
    fireEvent.click(within(panel()).getByRole("button", { name: "읽기 전용" }));
    expect(GROUP_ORDER.map((g) => checkedOf(GROUP_LABEL[g]))).toEqual(["deny", "deny", "default", "default", "default", "default", "default"]);
    expect(policyCalls()).toHaveLength(0);
  });

  it("바꾼 값이 있으면 저장하지 않았다고 알리고, 저장 전에는 PUT이 없다", () => {
    show(snap());
    render(<App />);
    openDesk("reviewer");
    expect(saveBtn().getAttribute("aria-disabled")).toBe("true");
    expect(panel().textContent).not.toContain(TEXT.unsaved);
    fireEvent.click(radio("명령 실행", "금지"));
    expect(panel().textContent).toContain(TEXT.unsaved);
    expect(saveBtn().getAttribute("aria-disabled")).toBeNull();
    expect(policyCalls()).toHaveLength(0);
    fireEvent.click(radio("명령 실행", "기본"));
    expect(panel().textContent).not.toContain(TEXT.unsaved);
  });

  it("[저장]은 그 대상의 규칙 전체를 PUT한다", async () => {
    show(snap());
    render(<App />);
    openDesk("reviewer");
    fireEvent.click(radio("명령 실행", "금지"));
    fireEvent.click(saveBtn());
    await flush();
    const [[url, init]] = policyCalls();
    expect(url).toBe("/api/policy/targets/agent%3Areviewer");
    expect(init.method).toBe("PUT");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ rules: { bash: "deny" } });
    expect(panel().textContent).toContain("저장했습니다");
    expect(status()).toBe("reviewer 권한 정책을 저장했습니다");
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("모두 기본으로 저장하면 빈 rules를 보낸다(대상이 지워진다)", async () => {
    show(snap({ targets: { "agent:reviewer": { bash: "deny" } } }));
    render(<App />);
    openDesk("reviewer");
    fireEvent.click(within(panel()).getByRole("button", { name: "제한 없음" }));
    fireEvent.click(saveBtn());
    await flush();
    expect(JSON.parse(policyCalls()[0][1].body)).toEqual({ rules: {} });
    expect(panel().textContent).toContain("정책을 지웠습니다");
    expect(status()).toBe("reviewer 권한 정책을 지웠습니다");
  });

  it("저장 중에는 [저장]이 비활성이고 두 번 눌러도 요청은 한 번", async () => {
    show(snap());
    render(<App />);
    openDesk("reviewer");
    fireEvent.click(radio("명령 실행", "금지"));
    fireEvent.click(saveBtn());
    expect(saveBtn().textContent).toBe("저장하는 중…");
    // disabled는 실제 브라우저에서 포커스를 body로 떨어뜨린다(B105). aria-disabled + aria-busy, 이중 전송은 ref가 막는다
    expect((saveBtn() as HTMLButtonElement).disabled).toBe(false);
    expect(saveBtn().getAttribute("aria-disabled")).toBe("true");
    expect(saveBtn().getAttribute("aria-busy")).toBe("true");
    fireEvent.click(saveBtn());
    await flush();
    expect(policyCalls()).toHaveLength(1);
  });

  it("값을 되돌려 바꾼 것이 없어지면 그 사이 바뀐 서버 값을 따라간다(B105)", () => {
    show(snap({ targets: { "agent:reviewer": { web: "ask" } } }));
    const { rerender } = render(<App />);
    openDesk("reviewer");
    fireEvent.click(radio("명령 실행", "금지"));
    show(snap({ targets: { "agent:reviewer": { web: "deny" } } }));
    rerender(<App />);
    expect(checkedOf("웹 접근")).toBe("ask"); // 바꾸는 중에는 덮지 않는다
    fireEvent.click(radio("명령 실행", "기본"));
    expect(checkedOf("웹 접근")).toBe("deny");
    expect(panel().textContent).not.toContain(TEXT.unsaved);
  });

  it("저장 직후 아직 예전 스냅샷이어도 방금 저장한 값이 그대로다", async () => {
    show(snap());
    render(<App />);
    openDesk("reviewer");
    fireEvent.click(radio("명령 실행", "금지"));
    fireEvent.click(saveBtn());
    await flush();
    expect(checkedOf("명령 실행")).toBe("deny");
    expect(panel().textContent).toContain("저장했습니다");
  });

  it("저장 중에 닫으면 버렸다고 알리지 않는다(B105)", async () => {
    let finish!: (v: unknown) => void;
    fetchMock.mockImplementation(async (url: string) => {
      if (!String(url).startsWith("/api/policy")) return { ok: true, status: 200, json: async () => DIAG };
      await new Promise((r) => (finish = r));
      return { ok: true, status: 200, json: async () => ({ saved: true }) };
    });
    show(snap());
    render(<App />);
    openDesk("reviewer");
    fireEvent.click(radio("명령 실행", "금지"));
    fireEvent.click(saveBtn());
    fireEvent.click(within(panel()).getByRole("button", { name: "닫기" }));
    expect(status()).not.toBe(TEXT.discarded);
    await act(async () => finish(null));
    await flush();
    expect(status()).toBe("reviewer 권한 정책을 저장했습니다");
  });

  it("편집 중에 스냅샷이 다시 와도 고른 값이 그대로다", async () => {
    show(snap({ targets: { "agent:reviewer": { web: "ask" } } }));
    const { rerender } = render(<App />);
    openDesk("reviewer");
    fireEvent.click(radio("명령 실행", "금지"));
    show(snap({ targets: { "agent:reviewer": { web: "deny", edit: "ask" } } }));
    rerender(<App />);
    expect([checkedOf("명령 실행"), checkedOf("웹 접근"), checkedOf("파일 고치기")]).toEqual(["deny", "ask", "default"]);
    // 저장에 성공하면 그 뒤로는 서버 값을 기준으로 맞춘다
    fireEvent.click(saveBtn());
    await flush();
    show(snap({ targets: { "agent:reviewer": { bash: "deny", web: "ask", mcp: "deny" } } }));
    rerender(<App />);
    expect([checkedOf("명령 실행"), checkedOf("외부 도구(MCP)")]).toEqual(["deny", "deny"]);
    expect(panel().textContent).not.toContain(TEXT.unsaved);
  });

  it.each([
    ["400", { status: 400, body: {} }, TEXT.invalid],
    ["400 limit", { status: 400, body: { reason: "limit" } }, TEXT.limit],
    ["500", { status: 500 }, TEXT.failed],
    ["네트워크", "network", TEXT.failed],
    ["saved: false", { status: 200, body: { saved: false } }, TEXT.notPersisted],
  ] as Array<[string, Reply, string]>)("저장 실패는 패널을 닫지 않고 문구로 알린다 — %s", async (_l, r, text) => {
    reply = r;
    show(snap());
    render(<App />);
    openDesk("reviewer");
    fireEvent.click(radio("명령 실행", "금지"));
    fireEvent.click(saveBtn());
    await flush();
    expect(within(panel()).getByRole("alert").textContent).toBe(text);
    expect(checkedOf("명령 실행")).toBe("deny");
    expect(saveBtn().getAttribute("aria-disabled")).toBeNull();
  });

  it("지금만 적용됨(saved: false) 뒤에는 [저장]이 눌리는 채로 남아 같은 규칙을 다시 보낼 수 있다", async () => {
    reply = { status: 200, body: { saved: false } };
    show(snap());
    const { rerender } = render(<App />);
    openDesk("reviewer");
    fireEvent.click(radio("명령 실행", "금지"));
    fireEvent.click(saveBtn());
    await flush();
    // 서버는 메모리에 적용했으므로 스냅샷도 같은 값이 된다
    show(snap({ targets: { "agent:reviewer": { bash: "deny" } } }));
    rerender(<App />);
    expect(saveBtn().getAttribute("aria-disabled")).toBeNull();
    reply = { status: 200, body: { saved: true } };
    fireEvent.click(saveBtn());
    await flush();
    expect(policyCalls().map((c) => JSON.parse(c[1].body))).toEqual([{ rules: { bash: "deny" } }, { rules: { bash: "deny" } }]);
    expect(panel().textContent).toContain("저장했습니다");
    expect(saveBtn().getAttribute("aria-disabled")).toBe("true");
  });

  it("401이면 열쇠 안내 화면으로 간다(UNAUTHORIZED_EVENT)", async () => {
    reply = { status: 401 };
    const heard = vi.fn();
    window.addEventListener(UNAUTHORIZED_EVENT, heard);
    show(snap());
    render(<App />);
    openDesk("reviewer");
    fireEvent.click(radio("명령 실행", "금지"));
    fireEvent.click(saveBtn());
    await flush();
    window.removeEventListener(UNAUTHORIZED_EVENT, heard);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("저장하지 않고 닫으면 live region에 버렸다고 알린다", () => {
    show(snap());
    render(<App />);
    openDesk("reviewer");
    fireEvent.click(radio("명령 실행", "금지"));
    fireEvent.click(within(panel()).getByRole("button", { name: "닫기" }));
    expect(status()).toBe("저장하지 않은 변경을 버렸습니다");
  });
});

describe("대상 종류별 패널", () => {
  it("101자 이름의 책상을 누르면 others 패널이 열린다", () => {
    const long = "가".repeat(101);
    show(snap({ members: [lead(), makeMember({ name: long, role: long })] }));
    render(<App />);
    openDesk(long);
    expect(within(panel()).getByRole("heading", { level: 2 }).textContent).toBe("그 밖의 모든 팀원·서브에이전트");
  });

  it('"그 밖의 모든" 패널에는 횟수 줄이 없다', () => {
    show(snap({ targets: { others: { web: "ask" } }, counts: { others: { denied: 2, asked: 0 } } }));
    render(<App />);
    openDesk("reviewer");
    fireEvent.click(within(panel()).getByRole("button", { name: TEXT.othersLink }));
    const p = panel();
    expect(within(p).getByRole("heading", { level: 2 }).textContent).toBe("그 밖의 모든 팀원·서브에이전트");
    expect(p.textContent).toContain(TEXT.scopeOthers);
    expect(p.textContent).not.toContain("켠 뒤로");
  });

  it("others를 따르는 중이면 그 사실을 보여 준다", () => {
    show(snap({ targets: { others: { bash: "deny" } }, counts: { "agent:reviewer": { denied: 3, asked: 5 } } }));
    render(<App />);
    openDesk("reviewer");
    const p = panel();
    expect(p.textContent).toContain('정한 것이 없어 "그 밖의 모든"을 따릅니다');
    expect(p.textContent).toContain("켠 뒤로 금지 3번 · 질문 5번");
    expect(GROUP_ORDER.every((g) => checkedOf(GROUP_LABEL[g]) === "default")).toBe(true);
    // others 링크 → 그 밖의 모든 패널, ‹로 돌아온다
    fireEvent.click(within(p).getByRole("button", { name: TEXT.othersLink }));
    fireEvent.click(within(panel()).getByRole("button", { name: "reviewer 권한으로 돌아가기" }));
    expect(within(panel()).getByRole("heading", { level: 2 }).textContent).toBe("reviewer");
  });

  it("횟수가 0이면 0 문구", () => {
    show(snap());
    render(<App />);
    openDesk("reviewer");
    expect(panel().textContent).toContain(TEXT.countsZero);
  });

  it("리드 패널의 서브에이전트 절", async () => {
    show(snap({ members: [lead({ subTypes: ["Explore", "Plan"] }), makeMember({ name: "reviewer", role: "reviewer" })] }));
    render(<App />);
    openDesk("team-lead");
    expect(within(panel()).getByRole("heading", { level: 2 }).textContent).toBe("리드");
    expect(panel().textContent).toContain(TEXT.scopeLead);
    within(panel()).getByRole("button", { name: "서브에이전트(Plan) 권한 정하기" });
    within(panel()).getByRole("button", { name: "그 밖의 모든 팀원·서브에이전트 권한 정하기" });
    fireEvent.click(within(panel()).getByRole("button", { name: "서브에이전트(Explore) 권한 정하기" }));
    expect(within(panel()).getByRole("heading", { level: 2 }).textContent).toBe("서브에이전트(Explore)");
    expect(document.activeElement?.id).toBe("ap-title");
    expect(within(panel()).queryByRole("button", { name: /권한 정하기$/ })).toBeNull(); // 한 단계만
    fireEvent.click(radio("파일 고치기", "금지"));
    fireEvent.click(saveBtn());
    await flush();
    expect(policyCalls()[0][0]).toBe("/api/policy/targets/sub%3AExplore");
    fireEvent.click(within(panel()).getByRole("button", { name: "리드 권한으로 돌아가기" }));
    expect(within(panel()).getByRole("heading", { level: 2 }).textContent).toBe("리드");
  });

  it("팀원 패널에는 서브에이전트 절이 없다", () => {
    show(snap({ members: [lead({ subTypes: ["Explore"] }), makeMember({ name: "reviewer", role: "reviewer" })] }));
    render(<App />);
    openDesk("reviewer");
    expect(within(panel()).queryByRole("button", { name: "서브에이전트(Explore) 권한 정하기" })).toBeNull();
  });

  it("긴 이름(100자)도 패널 머리에 전부 들어 있다", () => {
    const name = "가".repeat(50) + "a".repeat(50);
    show(snap({ members: [lead(), makeMember({ name, role: name })] }));
    render(<App />);
    openDesk(name);
    expect(within(panel()).getByRole("heading", { level: 2 }).textContent).toBe(name);
  });
});

describe("서랍 관계와 포커스", () => {
  const d1: DecisionView = {
    id: "d1", sessionId: "s1", agent: "developer", kind: "permission", toolName: "Bash", state: "pending",
    createdAt: new Date(T0).toISOString(), deadline: new Date(T0 + 590_000).toISOString(), detail: { command: "ls" }, answerable: true,
  };
  const withDecision = () =>
    snap({ members: [lead(), makeMember({ name: "reviewer", role: "reviewer" }), makeMember({ name: "developer", state: "decision", decision: { kind: "permission", since: d1.createdAt, id: "d1", deadline: d1.deadline } })], decisions: [d1] });

  it("서랍은 한 번에 하나: 패널을 열면 보고서가 닫히고, 보고서를 열면 패널이 닫힌다", async () => {
    show(withDecision());
    render(<App />);
    openDesk("developer");
    expect(document.getElementById("decision-report")).not.toBeNull();
    openDesk("reviewer");
    await flush();
    expect(document.getElementById("decision-report")).toBeNull();
    expect(document.getElementById("agent-panel")).not.toBeNull();
    openDesk("developer");
    await flush();
    expect(document.getElementById("agent-panel")).toBeNull();
    expect(document.getElementById("decision-report")).not.toBeNull();
  });

  it("진단 서랍을 열면 패널이 닫히고, 패널을 열면 진단 서랍이 닫힌다", async () => {
    show(snap());
    render(<App />);
    openDesk("reviewer");
    fireEvent.click(screen.getByRole("button", { name: /진단/ }));
    await flush();
    expect(document.getElementById("agent-panel")).toBeNull();
    openDesk("reviewer");
    await flush();
    expect(document.getElementById("agent-panel")).not.toBeNull();
    expect(document.querySelector(".diag-panel")).toBeNull();
  });

  it("Esc로 닫히고 포커스가 연 책상으로 돌아간다", () => {
    show(snap());
    render(<App />);
    const desk = screen.getByTestId("desk-reviewer");
    desk.focus();
    fireEvent.click(desk);
    expect(document.activeElement?.id).toBe("ap-title");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.getElementById("agent-panel")).toBeNull();
    expect(document.activeElement).toBe(desk);
  });

  it("말풍선이 떠 있으면 첫 Esc는 패널을 닫지 않는다", () => {
    show(snap());
    render(<App />);
    openDesk("reviewer");
    const tip = document.createElement("div");
    tip.className = "say";
    tip.setAttribute("role", "tooltip");
    document.body.appendChild(tip);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.getElementById("agent-panel")).not.toBeNull();
    tip.remove();
  });

  it("role=status는 화면에 하나다", async () => {
    show(snap());
    render(<App />);
    openDesk("reviewer");
    fireEvent.click(radio("명령 실행", "금지"));
    fireEvent.click(saveBtn());
    await flush();
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });
});
