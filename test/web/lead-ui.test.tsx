// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatQuestionView, SessionView, Snapshot } from "../../src/shared/types";
import { Floor } from "../../web/building/Floor";
import { CH_TEXT } from "../../web/floors/ChannelDialogs";
import { Desk } from "../../web/office/Desk";
import { CMD_TEXT } from "../../web/office/leadCmdText";
import { LEAD_TEXT, shortTime } from "../../web/office/leadText";
import { LeadCommands, LeadDrawers, OpenLeadContext, channelOf, useLead, type LeadOpener } from "../../web/office/LeadUi";
import { useEffect } from "react";
import { makeMember, makeSession, makeSnapshot } from "./fixtures";

// Phase 6b Task 4 연결(designer SPEC docs/design/phase6b/SPEC.md §1·§2·§4·§6)
let fetchMock: ReturnType<typeof vi.fn>;
let calls: Array<{ url: string; body: unknown }>;
let reply: (url: string) => { status: number; body: unknown };
beforeEach(() => {
  calls = [];
  reply = () => ({ status: 200, body: { requestId: "r-00000001", id: "i", state: "sent" } });
  fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    const r = reply(url);
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const opener = (): LeadOpener & { calls: unknown[][] } => {
  const c: unknown[][] = [];
  return { calls: c, openFolder: (...a) => void c.push(["folder", ...a]), openReply: (...a) => void c.push(["reply", ...a]), openRetire: (...a) => void c.push(["retire", ...a]) };
};
const q = (p: Partial<ChatQuestionView> = {}): ChatQuestionView => ({ id: "q-aaaaaaaa", source: "ask", owner: "team-lead", ownerIsLead: true, text: "어느 쪽?", options: ["A", "B"], state: "open", ...p });
const connected = { channel: { connected: true, tmux: "co-1", held: 0 } } satisfies Partial<SessionView>;

describe("책상 표시(§2)", () => {
  it("퇴근함은 팻말 빈 의자·화면 꺼짐·이름표 흐림, 접근 이름은 '{이름}, 퇴근함. 열기'", () => {
    render(<Desk member={makeMember({ name: "tester", state: "working", duty: "off" })} floorId="s1" />);
    expect(screen.getByTestId("empty-chair")).toBeTruthy();
    expect(screen.getByTestId("offduty-sign").textContent).toBe(CMD_TEXT.offSign);
    expect(screen.getByTestId("desk-tester").className).toContain("desk--offduty");
  });

  it("이름표 아래 한 줄은 늘 있고(비어 있어도), 퇴사 진행 > 퇴근 요청함 > 오래 쉼 순서로 하나만", () => {
    const line = (p: object) => {
      cleanup();
      render(<Desk member={makeMember({ name: "tester", ...p })} />);
      return screen.getByTestId("extra-line").textContent;
    };
    expect(line({})).toBe("");
    expect(line({ longIdle: true })).toBe(CMD_TEXT.statusLongIdle);
    expect(line({ longIdle: true, duty: "requested" })).toBe(CMD_TEXT.statusOffRequested);
    expect(line({ longIdle: true, duty: "requested", retiring: { since: "x" } })).toBe(CMD_TEXT.statusRetiring);
  });

  it("스펙 12장 m(SPEC §2.6 W2a): 퇴사 중인데 연결이 없으면 책상 줄은 그대로, title·aria에 ', 연결되면 이어 갑니다'", () => {
    const tail = `, ${CMD_TEXT.retireResume}`;
    render(<Desk member={makeMember({ name: "tester", retiring: { since: "x" } })} retireWait />);
    expect(screen.getByTestId("extra-line").textContent).toBe(CMD_TEXT.statusRetiring);
    expect(screen.getByTestId("extra-line").querySelector(".desk-status")!.getAttribute("title")).toBe(`${CMD_TEXT.statusRetiring}${tail}`);
    expect(screen.getByTestId("desk-tester").getAttribute("aria-label")).toContain(tail);
    cleanup();
    render(<Desk member={makeMember({ name: "tester" })} retireWait />);
    expect(screen.getByTestId("desk-tester").getAttribute("aria-label")).not.toContain(tail);
    cleanup();
    render(<Floor session={makeSession({ members: [makeMember({ name: "team-lead", role: "lead" }), makeMember({ name: "tester", retiring: { since: "x" } })] })} />);
    expect(screen.getByTestId("desk-tester").getAttribute("aria-label")).toContain(tail);
    cleanup();
    render(<Floor session={makeSession({ channel: { connected: true, tmux: "co-1", held: 0 }, members: [makeMember({ name: "team-lead", role: "lead" }), makeMember({ name: "tester", retiring: { since: "x" } })] })} />);
    expect(screen.getByTestId("desk-tester").getAttribute("aria-label")).not.toContain(tail);
  });

  it("스펙 12장 m(SPEC §1.1): 패널 [퇴사 진행 중] 아래 이유 줄은 연결이 없으면 '연결되면 이어 갑니다'", () => {
    const member = makeMember({ name: "tester", retiring: { since: "x" } });
    render(<LeadCommands session={makeSession({ channel: { connected: false, tmux: "co-1", held: 0 }, members: [makeMember({ name: "team-lead", role: "lead" }), member] })} member={member} announce={() => {}} lead={opener()} />);
    expect(screen.getByText(CMD_TEXT.retireResume)).toBeTruthy();
  });

  it("리드 책상: 결재 대기가 있으면 '결재 {n}' 칩과 서류철 그림(노랑), 보고서만 있으면 그림만", () => {
    render(<Desk member={makeMember({ name: "team-lead", role: "lead" })} folder={{ pending: 2, total: 3 }} />);
    expect(screen.getByTestId("extra-line").textContent).toBe(CMD_TEXT.deskFolder(2));
    expect(screen.getByTestId("folder-mark")).toBeTruthy();
    cleanup();
    render(<Desk member={makeMember({ name: "team-lead", role: "lead" })} folder={{ pending: 0, total: 1 }} />);
    expect(screen.getByTestId("extra-line").textContent).toBe("");
    expect(screen.getByTestId("folder-mark")).toBeTruthy();
  });

  it("답을 기다립니다(await)는 하늘 말머리, 누르면 답 칸 — ask_user(chat 결정)도 결정 보고서 대신 답 칸", () => {
    const lead = opener();
    const decisionOpen = vi.fn();
    render(
      <OpenLeadContext.Provider value={lead}>
        <Desk member={makeMember({ name: "team-lead", role: "lead", awaitingReply: q({ source: "await", options: [] }) })} floorId="s1" />
      </OpenLeadContext.Provider>,
    );
    expect(screen.getByTestId("await-bubble")).toBeTruthy();
    const desk = screen.getByTestId("desk-team-lead");
    expect(desk.getAttribute("aria-label")).toBe(CMD_TEXT.aria.await("team-lead", ""));
    fireEvent.click(desk);
    cleanup();
    render(
      <OpenLeadContext.Provider value={lead}>
        <Desk member={makeMember({ name: "tester", state: "decision", decision: { kind: "chat", since: "2026-10-21T00:00:00Z", id: "q-bbbbbbbb" }, awaitingReply: q({ id: "q-bbbbbbbb", owner: "tester", ownerIsLead: false }) })} floorId="s1" />
      </OpenLeadContext.Provider>,
    );
    expect(screen.queryByTestId("await-bubble")).toBeNull();
    fireEvent.click(screen.getByTestId("desk-tester"));
    expect(decisionOpen).not.toHaveBeenCalled();
    expect(lead.calls.map((c) => c.slice(0, 4))).toEqual([["reply", "s1", "team-lead", "q-aaaaaaaa"], ["reply", "s1", "tester", "q-bbbbbbbb"]]);
  });
});

describe("B335 — 답을 기다립니다 글자·서류철 따로 열기", () => {
  const awaitQ = () => q({ source: "await", options: [] });
  it("① await 말머리는 '답을 기다립니다' 글자(말줄임 상자)", () => {
    render(<Desk member={makeMember({ name: "team-lead", role: "lead", awaitingReply: awaitQ() })} />);
    expect(screen.getByTestId("await-bubble").textContent).toBe(CMD_TEXT.awaiting);
  });

  it("② 결재 칩·서류철 그림은 책상 버튼 밖 형제 버튼 — 누르면 서류철, 책상 접근 이름에 결재 대기", () => {
    const lead = opener();
    render(
      <OpenLeadContext.Provider value={lead}>
        <Desk member={makeMember({ name: "team-lead", role: "lead", awaitingReply: awaitQ() })} floorId="s1" folder={{ pending: 2, total: 3 }} />
      </OpenLeadContext.Provider>,
    );
    const desk = screen.getByTestId("desk-team-lead");
    expect(desk.getAttribute("aria-label")).toBe(CMD_TEXT.aria.await("team-lead", CMD_TEXT.aria.folder(2)));
    const chip = screen.getByRole("button", { name: CMD_TEXT.aria.folderOpen(2) });
    expect(chip.textContent).toBe(CMD_TEXT.deskFolder(2));
    expect(desk.contains(chip)).toBe(false);
    expect(chip.parentElement).toBe(desk.parentElement);
    expect(screen.getByTestId("extra-line").textContent).toBe(""); // 칩은 책상 안에 두 번 그리지 않는다
    fireEvent.click(chip);
    fireEvent.click(screen.getByTestId("folder-hit"));
    expect(lead.calls.map((c) => c.slice(0, 2))).toEqual([["folder", "s1"], ["folder", "s1"]]);
    expect(screen.getByTestId("folder-hit").getAttribute("tabindex")).toBe("-1");
    cleanup();
    // 대기가 없으면 칩 버튼 없음(그림만), 서류철이 비면 둘 다 없음
    render(
      <OpenLeadContext.Provider value={lead}>
        <Desk member={makeMember({ name: "team-lead", role: "lead" })} floorId="s1" folder={{ pending: 0, total: 1 }} />
      </OpenLeadContext.Provider>,
    );
    expect(screen.queryByRole("button", { name: /서류철 열기/ })).toBeNull();
    expect(screen.getByTestId("folder-hit")).toBeTruthy();
  });

  it("② 답 칸에 대기 보고서가 있으면 '서류철 열기 · 대기 n건'(B336) → 서류철로", async () => {
    expect(CMD_TEXT.replyFolder(1)).toBe("서류철 열기 · 대기 1건");
    expect(CMD_TEXT.aria.folderOpen(2)).toBe("서류철 열기, 결재 대기 2건");
    const snapshot = makeSnapshot({ sessions: [makeSession({ id: "s1", ...connected, folder: { pending: 1, total: 1 }, members: [makeMember({ name: "team-lead", role: "lead", awaitingReply: awaitQ() })] })] });
    function Harness() {
      const lead = useLead();
      useEffect(() => lead.api.openReply("s1", "team-lead", "q-aaaaaaaa"), []); // eslint-disable-line react-hooks/exhaustive-deps
      return <LeadDrawers lead={lead} snapshot={snapshot} announce={() => {}} />;
    }
    reply = (url) => ({ status: 200, body: url.endsWith("/reports") ? { reports: [], archived: [] } : {} });
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: CMD_TEXT.replyFolder(1) }));
    await waitFor(() => expect(document.getElementById("rf-title")).toBeTruthy()); // 서류철 서랍
    expect(calls.some((c) => c.url === "/api/floors/s1/reports")).toBe(true);
  });
});

describe("#658 다시 연결하는 중", () => {
  const recon = { channel: { connected: false, tmux: "co-1", held: 0, reconnecting: true } } satisfies Partial<SessionView>;
  it("채널 상태는 reconnecting — 패널 지시 절은 버튼을 끄고 '다시 연결하는 중' 이유만(옮겨 열기·확인 창 안내 없음)", () => {
    expect(LEAD_TEXT.reconnecting).toBe("다시 연결하는 중입니다 — 잠시 뒤 저절로 쓸 수 있습니다. 10분이 지나도 안 되면 작업 지시 켜기(옮겨 열기)로 다시 연결하세요."); // B341 qa 확정
    expect(channelOf(recon)).toBe("reconnecting");
    const s = makeSession({ ...recon, members: [makeMember({ name: "team-lead", role: "lead" }), makeMember({ name: "tester" })] });
    render(<LeadCommands session={s} member={s.members[1]} announce={() => {}} lead={opener()} />);
    expect(document.querySelector(".ap-cmd-why")!.textContent).toBe(LEAD_TEXT.reconnecting);
    expect(screen.getByRole("button", { name: CMD_TEXT.offduty }).getAttribute("aria-disabled")).toBe("true");
    // 곧바로 옮겨 열기를 권하는 글(W3)·확인 창 글은 없다 — 10분 뒤의 조건부 안내만(B341)
    expect(document.body.textContent).not.toContain(LEAD_TEXT.notLaunched);
    expect(document.body.textContent).not.toContain(CH_TEXT.notConnected);
  });
});

describe("지시 절(§1)", () => {
  const cmds = (session: SessionView, member = session.members[0], lead = opener(), announce = vi.fn()) => {
    render(<LeadCommands session={session} member={member} announce={announce} lead={lead} />);
    return { lead, announce };
  };

  it("리드: [보고 요청]·[서류철 · 대기 n], 보내면 lead API로 report를 보내고 '리드에게 보냈습니다'", async () => {
    const { lead, announce } = cmds(makeSession({ ...connected, folder: { pending: 2, total: 5 } }));
    fireEvent.click(screen.getByText(CMD_TEXT.report));
    await waitFor(() => expect(screen.getByText(CMD_TEXT.sent)).toBeTruthy());
    expect(calls[0]).toEqual({ url: "/api/floors/s1/lead", body: { kind: "report" } });
    expect(announce).toHaveBeenCalledWith(CMD_TEXT.sent);
    fireEvent.click(screen.getByText(CMD_TEXT.folderPending(2)));
    expect(lead.calls[0].slice(0, 2)).toEqual(["folder", "s1"]);
  });

  it("팀원: 상태마다 버튼이 바뀐다(퇴근·출근·퇴근 요청함·퇴사 진행 중), 리드 패널엔 퇴근·퇴사가 없다", () => {
    const s = makeSession({ ...connected, members: [makeMember({ name: "team-lead", role: "lead" }), makeMember({ name: "tester" })] });
    const names = (m: object) => {
      cleanup();
      cmds(s, makeMember({ name: "tester", ...m }));
      return screen.getAllByRole("button").map((b) => b.textContent);
    };
    expect(names({})).toEqual([CMD_TEXT.offduty, CMD_TEXT.retire]);
    expect(names({ duty: "off" })).toEqual([CMD_TEXT.onduty, CMD_TEXT.retire]);
    expect(names({ duty: "requested" })).toEqual([CMD_TEXT.offRequested, CMD_TEXT.retire]);
    expect(names({ retiring: { since: "x" } })).toEqual([CMD_TEXT.retiring]);
    cleanup();
    cmds(s);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).not.toContain(CMD_TEXT.retire);
  });

  it("터미널에서 연 층은 aria-disabled + B312 이유, 연결 없음은 CH_TEXT.notConnected, 휴업은 활성 + instructPaused. 서류철은 늘 열 수 있다", () => {
    cmds(makeSession({}));
    const report = screen.getByText(CMD_TEXT.report).closest("button")!;
    expect(report.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("작업 지시 켜기(옮겨 열기)로 연결하면 쓸 수 있습니다")).toBeTruthy();
    fireEvent.click(report);
    expect(calls).toEqual([]);
    expect(screen.getByText(CMD_TEXT.folder).closest("button")!.getAttribute("aria-disabled")).toBeNull();
    cleanup();
    cmds(makeSession({ channel: { connected: false, tmux: "t", held: 0 } }));
    expect(screen.getByText(CH_TEXT.notConnected)).toBeTruthy();
    cleanup();
    cmds(makeSession({ ...connected, floorStatus: "paused" }));
    expect(screen.getByText(CMD_TEXT.report).closest("button")!.getAttribute("aria-disabled")).toBeNull();
    expect(screen.getByText(CH_TEXT.instructPaused)).toBeTruthy();
    expect(channelOf(makeSession({}))).toBe("not-launched");
  });

  it("보관(held)이면 '보관했습니다 — …', 실패 not-connected면 CH_TEXT.notConnected(alert), 10분 무응답 줄", async () => {
    reply = () => ({ status: 200, body: { requestId: "r", id: "i", state: "held" } });
    cmds(makeSession({ ...connected, folder: { pending: 0, total: 0, overdue: true } }));
    expect(screen.getByText(CMD_TEXT.overdue)).toBeTruthy();
    fireEvent.click(screen.getByText(CMD_TEXT.report));
    await waitFor(() => expect(screen.getByText(CMD_TEXT.held)).toBeTruthy());
    cleanup();
    reply = () => ({ status: 409, body: { error: "not-connected" } });
    cmds(makeSession(connected));
    fireEvent.click(screen.getByText(CMD_TEXT.report));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(CH_TEXT.notConnected));
  });
});

describe("답 칸 연결(§4)", () => {
  const snap = (awaitingReply?: ChatQuestionView): Snapshot =>
    makeSnapshot({ sessions: [makeSession({ ...connected, members: [makeMember({ name: "team-lead", role: "lead" }), makeMember({ name: "tester", awaitingReply })] })] });
  const lead = (qid = "q-aaaaaaaa") => ({ open: { kind: "reply" as const, floor: "s1", member: "tester", qid }, api: opener(), close: vi.fn() });

  it("팀원의 질문에 답하면 questionId·member·choice·사용자 글만 보낸다(질문·선택지 글은 싣지 않음)", async () => {
    const l = lead();
    render(<LeadDrawers lead={l} snapshot={snap(q({ owner: "tester", ownerIsLead: false }))} announce={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /선택지 2번/ }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "단, 테스트 먼저" } });
    fireEvent.click(screen.getByRole("button", { name: "보내기" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ url: "/api/floors/s1/lead", body: { kind: "reply", questionId: "q-aaaaaaaa", member: "tester", choice: 2, text: "단, 테스트 먼저" } });
    await waitFor(() => expect(l.close).toHaveBeenCalled());
  });

  it("열어 둔 사이 같은 책상에 새 질문이 오면 잠기고 [새 질문 보기], 질문이 없어지면 '이미 터미널에서 답했습니다'", () => {
    const l = lead();
    const { rerender } = render(<LeadDrawers lead={l} snapshot={snap(q({ owner: "tester", ownerIsLead: false }))} announce={vi.fn()} />);
    rerender(<LeadDrawers lead={l} snapshot={snap(q({ id: "q-cccccccc", owner: "tester", ownerIsLead: false }))} announce={vi.fn()} />);
    expect(screen.getByText("새 질문이 와서 이 질문은 닫혔습니다")).toBeTruthy();
    fireEvent.click(screen.getByText("새 질문 보기"));
    expect(l.api.calls[0].slice(0, 4)).toEqual(["reply", "s1", "tester", "q-cccccccc"]);
    rerender(<LeadDrawers lead={l} snapshot={snap(undefined)} announce={vi.fn()} />);
    expect(screen.getByText("이미 터미널에서 답했습니다")).toBeTruthy();
  });
});

describe("서류철 연결(§3)", () => {
  it("열면 GET /api/floors/:id/reports를 그리고, 승인하면 approve + reportId", async () => {
    reply = (url) =>
      url.endsWith("/reports")
        ? { status: 200, body: { reports: [{ id: "r-11111111", kind: "report", title: "주간 보고", from: "team-lead", body: "## 한 일\n<b>x</b>", at: "2026-10-21T01:00:00Z", state: "pending" }], archived: [] } }
        : { status: 200, body: { requestId: "r", id: "i", state: "sent" } };
    const announce = vi.fn();
    render(<LeadDrawers lead={{ open: { kind: "folder", floor: "s1" }, api: opener(), close: vi.fn() }} snapshot={makeSnapshot({ sessions: [makeSession({ ...connected, folder: { pending: 1, total: 1 } })] })} announce={announce} />);
    await waitFor(() => expect(screen.getByText("주간 보고")).toBeTruthy());
    fireEvent.click(screen.getByText("주간 보고"));
    expect(screen.getByText(/<b>x<\/b>/)).toBeTruthy(); // 글자로만
    fireEvent.click(screen.getByRole("button", { name: "승인" }));
    await waitFor(() => expect(calls.some((c) => (c.body as { kind?: string })?.kind === "approve")).toBe(true));
    expect(calls.find((c) => (c.body as { kind?: string })?.kind === "approve")!.body).toEqual({ kind: "approve", reportId: "r-11111111" });
    await waitFor(() => expect(announce).toHaveBeenCalledWith(CMD_TEXT.announce.approve));
  });
});

describe("전임자 서랍(§6)", () => {
  it("전임자가 있으면 방 안에 접힌 <details>, 이름과 퇴사 시각만. 없으면 그리지 않는다", () => {
    render(<Floor session={makeSession({ predecessors: [{ name: "designer", retiredAt: "2026-10-21T05:05:00Z" }] })} />);
    const d = document.querySelector("details.predecessors")!;
    expect(d.querySelector("summary")!.getAttribute("aria-label")).toBe(CMD_TEXT.predecessorsAria(1));
    expect(d.textContent).toContain("designer");
    cleanup();
    render(<Floor session={makeSession({})} />);
    expect(document.querySelector("details.predecessors")).toBeNull();
  });

  it("B323: 시작 시각이 있으면 `{시작} ~ {퇴사}`, 없으면 `퇴사 {시각}`. 모두 없으면 머리 줄 `일한 기간`을 그리지 않는다", () => {
    const retiredAt = "2026-10-21T05:05:00Z";
    const startedAt = "2026-10-21T01:00:00Z";
    render(<Floor session={makeSession({ predecessors: [{ name: "designer", retiredAt }] })} />);
    expect(document.querySelector(".pd-head")).toBeNull();
    expect(document.querySelector(".pd-time")!.textContent).toBe(`${CMD_TEXT.retiredAt} ${shortTime(retiredAt)}`);
    cleanup();
    render(<Floor session={makeSession({ predecessors: [{ name: "designer", retiredAt, startedAt }, { name: "designer", retiredAt }] })} />);
    expect(document.querySelector(".pd-head")!.textContent).toBe(CMD_TEXT.period);
    expect([...document.querySelectorAll(".pd-time")].map((e) => e.textContent)).toEqual([`${shortTime(startedAt)} ~ ${shortTime(retiredAt)}`, `${CMD_TEXT.retiredAt} ${shortTime(retiredAt)}`]);
  });
});

void act;
