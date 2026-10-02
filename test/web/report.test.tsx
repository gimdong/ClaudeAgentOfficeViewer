// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionView, Member, Snapshot } from "../../src/shared/types";
import { makeMember, makeSession, makeSnapshot } from "./fixtures";

const state = vi.hoisted(() => ({ value: { snapshot: null as unknown, live: true, unauthorized: false, markUnauthorized: () => {} } }));
vi.mock("../../web/useSnapshot", () => ({ useSnapshot: () => state.value }));

import { App } from "../../web/App";
import { metaLine } from "../../web/office/activityText";
import { budgetLabel, remaining, resultLine, whyLine } from "../../web/report/text";

const T0 = Date.UTC(2026, 9, 2, 3, 0, 0);
const NBSP = "\u00A0";

function dv(p: Partial<DecisionView> = {}): DecisionView {
  const created = p.createdAt ?? new Date(T0).toISOString();
  return {
    id: "d1",
    sessionId: "s1",
    agent: "developer",
    kind: "permission",
    toolName: "Bash",
    state: "pending",
    createdAt: created,
    deadline: new Date(Date.parse(created) + 590_000).toISOString(),
    detail: { command: "npm run test -- --run web/", description: "웹 테스트 실행" },
    answerable: true,
    ...p,
  };
}

/** 결정에 맞춰 구성원 결정(손들기)도 붙인 스냅샷 */
function snap(decisions: DecisionView[], extra: Partial<Snapshot> = {}): Snapshot {
  const members: Member[] = [makeMember({ name: "team-lead", role: "lead" }), makeMember({ name: "developer" }), makeMember({ name: "reviewer" })];
  for (const v of decisions) {
    const m = members.find((x) => x.name === v.agent);
    if (m && v.state === "pending" && !m.decision) Object.assign(m, { state: "decision", decision: { kind: v.kind, since: v.createdAt, id: v.id, deadline: v.deadline } });
  }
  return makeSnapshot({
    sessions: [makeSession({ id: "s1", name: "claude_project", floor: 3, members })],
    decisions,
    decisionCount: decisions.filter((v) => v.state === "pending").length,
    ...extra,
  });
}

let fetchMock: ReturnType<typeof vi.fn>;
const okResponse = (status: number, body: unknown = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const DIAG = { doctor: [], hooks: { total: 0, byEvent: {}, lastAt: null, rejected: { "403": 0, "415": 0, "413": 0, "400": 0 }, last10min: 0 }, errorsLastHour: 0, logDir: "l", diagDir: "d" };
/** 결정 API의 응답(테스트마다 바꾼다). HUD 진단 칩이 처음에 /api/diagnostics를 읽으므로 그 응답은 따로 준다 */
let reply: () => Promise<unknown>;
/** 결정 API로 보낸 호출만 */
const posts = () => fetchMock.mock.calls.filter((c) => String(c[0]).startsWith("/api/decisions")) as Array<[string, { body: string }]>;
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.setSystemTime(T0);
  reply = async () => okResponse(200, { state: "answered-dashboard" });
  fetchMock = vi.fn(async (url: string) => (String(url).startsWith("/api/decisions") ? reply() : okResponse(200, DIAG)));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function show(s: Snapshot) {
  state.value = { ...state.value, snapshot: s };
}
const status = () => screen.getByRole("status");
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe("결정 보고서 열기", () => {
  it("손 든 책상은 버튼이고 누르면 그 결정의 보고서가 열린다", () => {
    show(snap([dv()]));
    render(<App />);
    const desk = screen.getByRole("button", { name: "developer, 결정 필요. 결정 보고서 열기" });
    expect(desk.getAttribute("aria-haspopup")).toBe("dialog");
    fireEvent.click(desk);
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("false");
    expect(dialog.textContent).toContain("3F claude_project · developer");
    expect(dialog.textContent).toContain("도구 Bash");
    expect(dialog.textContent).toContain("npm run test -- --run web/");
    expect(dialog.textContent).toContain("웹 테스트 실행");
    expect(within(dialog).getByRole("heading", { level: 2 }).textContent).toBe("이 명령을 실행해도 될까요?");
    expect(dialog.textContent).toContain("이 명령을 실행해도 될지 묻고 있습니다");
    expect(dialog.textContent).toContain("권한 요청");
    expect(dialog.textContent).toContain("1 / 1");
    expect(dialog.textContent).toContain("9:50 남음 · 지나면 터미널에서 묻습니다");
  });

  it("권한 보고서를 열면 포커스가 거부 버튼에 있다", () => {
    show(snap([dv()]));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /developer, 결정 필요/ }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "거부" }));
  });

  it("HUD 칩을 누르면 가장 오래 기다린 결정이 열린다", () => {
    show(snap([dv({ id: "new", agent: "reviewer", createdAt: new Date(T0 + 5000).toISOString() }), dv({ id: "old", createdAt: new Date(T0).toISOString() })]));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "결정 대기 2건, 다음 요청 열기" }));
    expect(screen.getByRole("dialog").textContent).toContain("3F claude_project · developer");
    expect(screen.getByRole("dialog").textContent).toContain("1 / 2");
  });

  it("구성원과 짝이 없는 결정도 칩으로 열린다", () => {
    // 큐의 agent가 화면 구성원에 없다(예: 팀 정보가 아직 없는 세션의 팀원)
    show(snap([dv({ id: "x", agent: "ghost", sessionId: "unknown-session" })]));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "결정 대기 1건, 다음 요청 열기" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("ghost");
    expect(dialog.textContent).toContain("1 / 1");
  });

  it("‹ ›로 결정을 넘긴다", () => {
    show(snap([dv({ id: "a" }), dv({ id: "b", agent: "reviewer", toolName: "Write", detail: { filePath: "/x/b.ts" }, createdAt: new Date(T0 + 1000).toISOString() })]));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "결정 대기 2건, 다음 요청 열기" }));
    const prev = screen.getByRole("button", { name: "이전 결정" }) as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "다음 결정" }));
    expect(screen.getByRole("dialog").textContent).toContain("2 / 2");
    expect(within(screen.getByRole("dialog")).getByRole("heading", { level: 2 }).textContent).toBe("이 파일을 만들어도 될까요?");
    expect((screen.getByRole("button", { name: "다음 결정" }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement?.id).toBe("rp-title"); // 끝에 닿으면 제목으로
    fireEvent.click(screen.getByRole("button", { name: "이전 결정" }));
    expect(screen.getByRole("dialog").textContent).toContain("1 / 2");
  });

  it("Esc로 닫고 연 책상으로 포커스를 되돌린다", () => {
    show(snap([dv()]));
    render(<App />);
    const desk = screen.getByRole("button", { name: /developer, 결정 필요/ });
    desk.focus();
    fireEvent.click(desk);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(desk);
  });

  it("진단 서랍을 열면 보고서가 닫힌다", () => {
    show(snap([dv()]));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /developer, 결정 필요/ }));
    expect(screen.getByRole("dialog", { name: "이 명령을 실행해도 될까요?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /진단 열기/ }));
    expect(screen.queryByRole("dialog", { name: "이 명령을 실행해도 될까요?" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "진단" })).toBeTruthy();
    // 보고서를 다시 열면 진단 서랍이 닫힌다
    fireEvent.click(screen.getByRole("button", { name: /developer, 결정 필요/ }));
    expect(screen.queryByRole("dialog", { name: "진단" })).toBeNull();
  });
});

describe("답 보내기", () => {
  const open = () => fireEvent.click(screen.getByRole("button", { name: /developer, 결정 필요/ }));

  it("허용을 누르면 POST /api/decisions/<id>에 {action:\"allow\"}를 JSON으로 보낸다", async () => {
    show(snap([dv({ id: "d 1" })]));
    render(<App />);
    open();
    fireEvent.click(screen.getByRole("button", { name: "허용" }));
    expect(posts()).toEqual([["/api/decisions/d%201", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"action":"allow"}' }]]);
    await flush();
  });

  it("거부 이유는 200자까지이고 함께 보낸다", async () => {
    show(snap([dv()]));
    render(<App />);
    open();
    const input = screen.getByLabelText("거부 이유 (선택, Claude에게 전달됩니다)") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "테스트 폴더만 써 주세요" } });
    expect(screen.getByRole("dialog").textContent).toContain("13/200");
    fireEvent.click(screen.getByRole("button", { name: "거부" }));
    expect(JSON.parse(posts()[0][1].body)).toEqual({ action: "deny", reason: "테스트 폴더만 써 주세요" });
    await flush();
  });

  it("거부 이유는 서버와 같이 글자(그래핌)로 센다: 이모지가 섞인 200자가 들어가고 카운터가 200", async () => {
    show(snap([dv()]));
    render(<App />);
    open();
    const input = screen.getByLabelText("거부 이유 (선택, Claude에게 전달됩니다)") as HTMLInputElement;
    const text = "😀".repeat(100) + "가".repeat(100);
    fireEvent.change(input, { target: { value: text } });
    expect(input.value).toBe(text);
    expect(screen.getByRole("dialog").textContent).toContain("200/200");
    fireEvent.change(input, { target: { value: text + "👍🏽나" } });
    expect(input.value).toBe(text); // 201번째 글자부터는 들어가지 않는다
    fireEvent.click(screen.getByRole("button", { name: "거부" }));
    expect(JSON.parse(posts()[0][1].body)).toEqual({ action: "deny", reason: text });
    await flush();
  });

  it.each([
    ["200", (res: (v: unknown) => void) => res(okResponse(200, { state: "answered-dashboard" }))],
    ["409", (res: (v: unknown) => void) => res(okResponse(409, { state: "closed-terminal" }))],
    ["네트워크 실패", (_res: (v: unknown) => void, rej: (e: unknown) => void) => rej(new Error("network"))],
  ] as const)("보내는 중에 다른 결정을 열면 늦게 온 응답(%s)을 새 결정에 붙이지 않는다", async (_label, settle) => {
    let resolve!: (v: unknown) => void;
    let reject!: (e: unknown) => void;
    reply = () => new Promise((r, j) => ((resolve = r), (reject = j)));
    show(snap([dv({ id: "d1" }), dv({ id: "d2", agent: "reviewer", createdAt: new Date(T0 + 1000).toISOString() })]));
    render(<App />);
    open();
    fireEvent.click(screen.getByRole("button", { name: "허용" }));
    fireEvent.click(screen.getByRole("button", { name: "다음 결정" }));
    expect(screen.getByRole("dialog").textContent).toContain("3F claude_project · reviewer");
    settle(resolve, reject);
    await flush();
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("3F claude_project · reviewer");
    expect(dialog.textContent).not.toContain("대시보드에서 허용함");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(dialog.querySelector(".rp-banner")).toBeNull();
    expect(screen.getByRole("button", { name: "허용" }).getAttribute("aria-disabled")).toBeNull();
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.getByRole("dialog").textContent).toContain("3F claude_project · reviewer"); // 건너뛰지 않는다
    expect(posts().map((c) => c[0])).toEqual(["/api/decisions/d1"]);
  });

  it("자동으로 다음 결정이 열린 뒤 0.5초 동안은 답 입력을 무시한다", async () => {
    show(snap([dv({ id: "a" }), dv({ id: "b", agent: "reviewer", createdAt: new Date(T0 + 1000).toISOString() })]));
    render(<App />);
    open();
    fireEvent.click(screen.getByRole("button", { name: "허용" }));
    await flush();
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByRole("dialog").textContent).toContain("3F claude_project · reviewer");
    fireEvent.click(screen.getByRole("button", { name: "거부" }));
    fireEvent.keyDown(screen.getByLabelText("거부 이유 (선택, Claude에게 전달됩니다)"), { key: "Enter" });
    expect(posts()).toHaveLength(1);
    act(() => vi.advanceTimersByTime(500));
    fireEvent.click(screen.getByRole("button", { name: "거부" }));
    expect(posts()).toHaveLength(2);
    expect(posts()[1][0]).toBe("/api/decisions/b");
    await flush();
  });

  it("이유 입력에서 Enter는 거부를 보낸다(한글 조합 중 제외)", async () => {
    show(snap([dv()]));
    render(<App />);
    open();
    const input = screen.getByLabelText("거부 이유 (선택, Claude에게 전달됩니다)");
    fireEvent.change(input, { target: { value: "아니요" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(posts()).toHaveLength(0);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(JSON.parse(posts()[0][1].body)).toEqual({ action: "deny", reason: "아니요" });
    await flush();
  });

  it("보낸 뒤 배너 \"대시보드에서 허용함\", 3초 뒤 다음 결정으로 넘어간다", async () => {
    show(snap([dv({ id: "a" }), dv({ id: "b", agent: "reviewer", createdAt: new Date(T0 + 1000).toISOString() })]));
    render(<App />);
    open();
    fireEvent.click(screen.getByRole("button", { name: "허용" }));
    expect(screen.getByRole("dialog").textContent).toContain("보내는 중…");
    await flush();
    expect(screen.getByRole("dialog").textContent).toContain("대시보드에서 허용함");
    expect(status().textContent!.trim()).toBe("대시보드에서 허용함");
    act(() => vi.advanceTimersByTime(2999));
    expect(screen.getByRole("dialog").textContent).toContain("3F claude_project · developer");
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("dialog").textContent).toContain("3F claude_project · reviewer");
    expect(status().textContent!.trim()).toBe("다음 결정: claude_project reviewer, 권한 요청");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "거부" }));
  });

  it("다음이 없으면 닫고 포커스를 연 책상으로 되돌린다", async () => {
    show(snap([dv()]));
    render(<App />);
    const desk = screen.getByRole("button", { name: /developer, 결정 필요/ });
    fireEvent.click(desk);
    fireEvent.click(screen.getByRole("button", { name: "허용" }));
    await flush();
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(desk);
  });

  it("입력란에 포커스가 있으면 자동으로 넘기지 않고 [닫기]만 둔다(Ruling B46)", async () => {
    show(snap([dv()]));
    render(<App />);
    open();
    const input = screen.getByLabelText("거부 이유 (선택, Claude에게 전달됩니다)");
    fireEvent.change(input, { target: { value: "이유" } });
    input.focus();
    fireEvent.keyDown(input, { key: "Enter" });
    await flush();
    expect(screen.getByRole("dialog").textContent).toContain("대시보드에서 거부함");
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(within(screen.getByRole("dialog").querySelector<HTMLElement>(".rp-banner")!).getByRole("button", { name: "닫기" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("409면 \"이미 터미널에서 답했습니다\"", async () => {
    reply = async () => okResponse(409, { state: "closed-terminal" });
    show(snap([dv()]));
    render(<App />);
    open();
    fireEvent.click(screen.getByRole("button", { name: "허용" }));
    await flush();
    expect(screen.getByRole("dialog").textContent).toContain("이미 터미널에서 답했습니다");
  });

  it("409 본문이 answered-dashboard면 대시보드 문구를 보여 준다", async () => {
    reply = async () => okResponse(409, { state: "answered-dashboard" });
    show(snap([dv()]));
    render(<App />);
    open();
    fireEvent.click(screen.getByRole("button", { name: "허용" }));
    await flush();
    expect(screen.getByRole("dialog").textContent).toContain("다른 창에서 이미 답했습니다");
  });

  it("요청이 실패하면 \"보내지 못했습니다\"와 다시 시도, 입력한 이유가 남아 있다", async () => {
    reply = async () => {
      throw new Error("network");
    };
    show(snap([dv()]));
    render(<App />);
    open();
    const input = screen.getByLabelText("거부 이유 (선택, Claude에게 전달됩니다)") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "남아 있어야 함" } });
    const deny = screen.getByRole("button", { name: "거부" });
    deny.focus();
    fireEvent.click(deny);
    await flush();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("보내지 못했습니다. 서버 연결을 확인하고 다시 시도해 주세요.");
    expect(input.value).toBe("남아 있어야 함");
    expect(document.activeElement).toBe(deny); // 누른 버튼에 그대로
    reply = async () => okResponse(200, { state: "answered-dashboard" });
    fireEvent.click(within(alert).getByRole("button", { name: "다시 시도" }));
    expect(JSON.parse(posts()[1][1].body)).toEqual({ action: "deny", reason: "남아 있어야 함" });
    await flush();
    expect(screen.getByRole("dialog").textContent).toContain("대시보드에서 거부함");
  });

  it("키보드만으로 허용과 거부를 할 수 있다", async () => {
    show(snap([dv({ id: "a" }), dv({ id: "b", agent: "reviewer", createdAt: new Date(T0 + 1000).toISOString() })]));
    render(<App />);
    const desk = screen.getByRole("button", { name: /developer, 결정 필요/ });
    desk.focus();
    fireEvent.keyDown(desk, { key: "Enter" });
    fireEvent.click(desk); // 버튼의 Enter는 브라우저가 click으로 바꾼다
    const deny = screen.getByRole("button", { name: "거부" });
    expect(document.activeElement).toBe(deny);
    // DOM 순서: 이유 입력 → 허용 → 거부. Shift+Tab 한 번이면 허용
    const order = [...screen.getByRole("dialog").querySelectorAll<HTMLElement>("input, button:not([disabled])")].map((e) => e.textContent || e.getAttribute("aria-label") || e.tagName);
    expect(order.slice(-3)).toEqual(["INPUT", "허용", "거부"]);
    fireEvent.click(deny);
    expect(JSON.parse(posts()[0][1].body)).toEqual({ action: "deny" });
    await flush();
  });

  it("보내는 중과 잠금 상태에서는 다시 보내지 않는다", async () => {
    let resolve!: (v: unknown) => void;
    reply = () => new Promise((r) => (resolve = r));
    show(snap([dv()]));
    render(<App />);
    open();
    fireEvent.click(screen.getByRole("button", { name: "허용" }));
    fireEvent.click(screen.getByRole("button", { name: "허용" }));
    fireEvent.click(screen.getByRole("button", { name: "거부" }));
    expect(posts()).toHaveLength(1);
    expect(screen.getByRole("button", { name: "허용" }).getAttribute("aria-disabled")).toBe("true");
    resolve(okResponse(200, { state: "answered-dashboard" }));
    await flush();
  });
});

describe("열어 둔 결정이 바뀔 때", () => {
  const open = () => fireEvent.click(screen.getByRole("button", { name: /developer, 결정 필요/ }));

  it("열어 둔 결정이 목록에서 사라지면 닫힘 배너를 보여 준다", () => {
    show(snap([dv()]));
    const { rerender } = render(<App />);
    open();
    show(snap([dv({ state: "closed-terminal" })]));
    rerender(<App />);
    expect(screen.getByRole("dialog").textContent).toContain("터미널에서 이미 답함");
    expect(status().textContent!.trim()).toBe("터미널에서 이미 답함");

    show(snap([dv({ state: "expired" })]));
    rerender(<App />);
    expect(screen.getByRole("dialog").textContent).toContain("시간이 지나 터미널로 넘어감");

    show(snap([]));
    rerender(<App />);
    expect(screen.getByRole("dialog").textContent).toContain("이 요청은 끝났습니다. 터미널을 확인해 주세요");
  });

  it("다른 탭이 답하면(answered-dashboard) outcome별 대시보드 문구", () => {
    show(snap([dv()]));
    const { rerender } = render(<App />);
    open();
    show(snap([dv({ state: "answered-dashboard", outcome: "deny" })]));
    rerender(<App />);
    expect(screen.getByRole("dialog").textContent).toContain("대시보드에서 거부함");
  });

  it("화면에 role=status는 하나뿐이다", async () => {
    show(snap([dv()]));
    render(<App />);
    open();
    fireEvent.click(screen.getByRole("button", { name: "허용" }));
    await flush();
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("dialog").querySelector("[role=status]")).toBeNull();
  });

  it("같은 문장을 두 번 알려도 텍스트가 바뀐다(endsWith로 NBSP 확인)", () => {
    show(snap([dv()]));
    const { rerender } = render(<App />);
    open();
    show(snap([dv({ state: "closed-terminal" })]));
    rerender(<App />);
    const first = status().textContent!;
    // 다시 열고 같은 문장이 한 번 더 나오게 한다
    show(snap([dv({ id: "d2" })]));
    rerender(<App />);
    fireEvent.click(screen.getAllByRole("button", { name: "닫기" })[0]);
    open();
    show(snap([dv({ id: "d2", state: "closed-terminal" })]));
    rerender(<App />);
    const second = status().textContent!;
    expect(first.trim()).toBe("터미널에서 이미 답함");
    expect(second.trim()).toBe("터미널에서 이미 답함");
    expect(first).not.toBe(second);
    expect([first, second].some((t) => t.endsWith(NBSP))).toBe(true);
  });
});

describe("남은 시간", () => {
  it("남은 시간은 deadline 기준으로 줄어든다", () => {
    show(snap([dv()]));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /developer, 결정 필요/ }));
    expect(screen.getByRole("timer").textContent).toBe("9:50 남음 · 지나면 터미널에서 묻습니다");
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByRole("timer").textContent).toBe("9:49 남음 · 지나면 터미널에서 묻습니다");
  });

  it("60초가 남으면 \"1분 남았습니다\"를 알리고, 10초에 한 번 더, 0이면 시간이 지남 배너", () => {
    vi.setSystemTime(T0 + 590_000 - 61_000);
    show(snap([dv()]));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /developer, 결정 필요/ }));
    act(() => vi.advanceTimersByTime(1000));
    expect(status().textContent!.trim()).toBe("1분 남았습니다");
    expect(screen.getByRole("timer").className).toContain("urgent");
    act(() => vi.advanceTimersByTime(50_000));
    expect(status().textContent!.trim()).toBe("10초 남았습니다");
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.getByRole("dialog").textContent).toContain("시간이 지나 터미널로 넘어감");
  });
});

describe("종류별 보고서", () => {
  it("팀원 요청과 answerable:false는 버튼이 없고 \"터미널(리드 세션)에서 답해 주세요\"", () => {
    show(snap([dv({ id: "team:s1:developer:1", kind: "team", toolName: "SendMessage", detail: { description: "[결정 필요] 포트를 무엇으로 할까요" }, answerable: false })]));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /developer, 결정 필요/ }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { level: 2 }).textContent).toBe("팀원이 결정을 기다립니다");
    expect(dialog.textContent).toContain("[결정 필요] 포트를 무엇으로 할까요");
    expect(dialog.textContent).toContain("터미널(리드 세션)에서 답해 주세요");
    expect(dialog.textContent).toContain("리드가 이 팀원에게 메시지를 보내거나 30분이 지나면 손을 내립니다");
    expect(within(dialog).queryByRole("button", { name: /허용|거부|계속|중단|승인/ })).toBeNull();
    expect(within(dialog).queryByRole("timer")).toBeNull();
    expect(document.activeElement?.id).toBe("rp-title");
    expect(dialog.textContent).not.toContain("도구 SendMessage"); // 팀원 요청에는 도구 줄이 없다(명세 §1.4)
  });

  it("아바타 셔츠는 책상과 같은 색(구성원 color)", () => {
    const v = dv({ agent: "quill" });
    const s = snap([v]);
    s.sessions[0].members.push({ ...s.sessions[0].members[1], name: "quill", role: "quill", color: "orange", state: "decision", decision: { kind: "permission", since: v.createdAt, id: v.id, deadline: v.deadline } });
    show(s);
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /quill, 결정 필요/ }));
    const fills = [...screen.getByRole("dialog").querySelectorAll(".rp-avatar rect")].map((r) => r.getAttribute("fill"));
    expect(fills).toContain("#ffb86b");
  });

  it("계획은 보고서만(Ruling B40): 미리보기와 \"터미널에서 답해 주세요\", 버튼 없음", () => {
    show(snap([dv({ kind: "plan", toolName: "ExitPlanMode", detail: {}, plan: "1. 파일 만들기\n2. 확인", answerable: false })]));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /developer, 결정 필요/ }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { level: 2 }).textContent).toBe("계획 승인을 기다리고 있습니다");
    expect(within(dialog).getByRole("region", { name: "계획 미리보기" }).textContent).toContain("1. 파일 만들기\n2. 확인");
    expect(dialog.textContent).toContain("터미널에서 답해 주세요");
    expect(within(dialog).queryByRole("button", { name: /승인|거부/ })).toBeNull();
    expect(document.activeElement?.id).toBe("rp-title");
  });

  it("planTruncated면 잘림 안내 줄이 보인다", () => {
    show(snap([dv({ kind: "plan", toolName: "ExitPlanMode", detail: {}, plan: "가".repeat(4000), planTruncated: true, answerable: false })]));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /developer, 결정 필요/ }));
    expect(screen.getByRole("region", { name: "계획 미리보기" }).textContent).toContain("… 계획이 길어 앞부분만 보여 줍니다. 전체는 터미널에서 볼 수 있습니다");
  });

  it("예산 보고서: 계속은 {action:\"continue\"}, 중단은 {action:\"stop\"}, 예산과 사용량 숫자가 보인다", async () => {
    show(snap([dv({ kind: "budget", budget: { budgetTokens: 500_000, usedTokens: 512_340 } }), dv({ id: "d2", agent: "reviewer", kind: "budget", budget: { budgetTokens: 500_000, usedTokens: 512_340 }, createdAt: new Date(T0 + 1).toISOString() })]));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /developer, 결정 필요/ }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { level: 2 }).textContent).toBe("예산에 도달했습니다. 계속할까요?");
    expect(dialog.textContent).toContain("예산 50만 토큰에 도달했습니다");
    expect(dialog.textContent).toContain("512,340 토큰");
    expect(dialog.textContent).toContain("계속을 누르면 이 도구 실행도 함께 허용됩니다");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "중단" }));
    fireEvent.click(screen.getByRole("button", { name: "계속" }));
    expect(JSON.parse(posts()[0][1].body)).toEqual({ action: "continue" });
    await flush();
    expect(screen.getByRole("dialog").textContent).toContain("대시보드에서 계속함");
    act(() => vi.advanceTimersByTime(3000));
    act(() => vi.advanceTimersByTime(500)); // 자동으로 넘어간 직후 0.5초는 답 입력을 무시한다
    fireEvent.click(screen.getByRole("button", { name: "중단" }));
    expect(JSON.parse(posts()[1][1].body)).toEqual({ action: "stop" });
    await flush();
    expect(screen.getByRole("dialog").textContent).toContain("대시보드에서 중단함");
  });

  it("질문은 머리와 문구, 질문 수를 보여 준다(폼은 Task 9)", () => {
    show(snap([dv({ kind: "question", toolName: "AskUserQuestion", detail: {}, questions: [{ question: "Q?", multiSelect: false, options: [{ label: "a" }] }] })]));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /developer, 결정 필요/ }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { level: 2 }).textContent).toBe("질문에 답해 주세요");
    expect(dialog.textContent).toContain("작업을 이어 가려면 답이 필요합니다");
    expect(dialog.textContent).toContain("질문1개");
    expect(document.activeElement?.id).toBe("rp-title");
  });

  it("요약 값이 없으면 \"입력 요약이 없습니다\"", () => {
    show(snap([dv({ toolName: "Agent", detail: {} })]));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /developer, 결정 필요/ }));
    expect(screen.getByRole("dialog").textContent).toContain("입력 요약이 없습니다");
    expect(within(screen.getByRole("dialog")).getByRole("heading", { level: 2 }).textContent).toBe("이 도구를 써도 될까요?");
  });
});

describe("문구 함수", () => {
  it("budgetLabel·remaining·whyLine·resultLine", () => {
    expect(budgetLabel(500_000)).toBe("50만 토큰");
    expect(budgetLabel(100_000_000)).toBe("1억 토큰");
    expect(budgetLabel(123_456)).toBe("123,456 토큰");
    expect(remaining(new Date(T0 + 590_000).toISOString(), T0)).toBe("9:50");
    expect(remaining(new Date(T0 + 5_000).toISOString(), T0)).toBe("0:05");
    expect(remaining(new Date(T0 - 5_000).toISOString(), T0)).toBe("0:00");
    expect(whyLine(dv({ toolName: "Edit" }))).toBe("이 파일을 바꿔도 될지 묻고 있습니다");
    expect(resultLine(dv({ kind: "plan", state: "answered-dashboard", outcome: "allow" }))).toBe("대시보드에서 승인함");
    expect(resultLine(dv({ state: "answered-dashboard", outcome: "answer" }))).toBe("대시보드에서 답함");
  });

  it("말풍선 보조 줄: 열 수 있는 결정(id 있음)은 \"누르면 결정 보고서가 열립니다\"", () => {
    expect(metaLine(makeMember({ state: "decision", decision: { kind: "permission", since: "t", id: "d1" } }), T0)).toBe("누르면 결정 보고서가 열립니다");
  });
});

describe("자동 넘김 직후 Esc(#180)", () => {
  it("다음 결정이 그려진 바로 그 순간에 Esc를 눌러도 포커스는 연 책상으로(포커스 이동이 늦게 실행되지 않는다)", async () => {
    vi.useRealTimers();
    show(snap([dv({ id: "a" }), dv({ id: "b", agent: "reviewer", createdAt: new Date(T0 + 1000).toISOString() })]));
    render(<App />);
    const desk = screen.getByRole("button", { name: /developer, 결정 필요/ });
    desk.focus();
    fireEvent.click(desk);
    fireEvent.click(screen.getByRole("button", { name: "허용" }));
    // 3초 자동 넘김으로 다음 결정(reviewer)이 DOM에 붙는 커밋 직후에 Esc를 누른다. 늦게 도는 포커스 effect가 남아 있으면 여기서 드러난다
    const drawn = new Promise<void>((resolve) => {
      const mo = new MutationObserver(() => {
        if (document.querySelector(".rp-who")?.textContent?.includes("reviewer")) {
          mo.disconnect();
          resolve();
        }
      });
      mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    await drawn;
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(desk);
  }, 10_000);
});
