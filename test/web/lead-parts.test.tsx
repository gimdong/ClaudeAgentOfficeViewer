// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BuildingInfo, BUILDING_TEXT } from "../../web/building/BuildingInfo";
import { CH_TEXT } from "../../web/floors/ChannelDialogs";
import { LEAD_TEXT, type ChatQuestionView, type FolderView, type ReportView } from "../../web/office/leadText";
import { ReplyDialog } from "../../web/office/ReplyDialog";
import { ReportFolder } from "../../web/office/ReportFolder";
import { RetireDialog } from "../../web/office/RetireDialog";

// jsdom에는 <dialog>.showModal이 없다 — 테스트에서만 최소한으로 채운다(budget.test.tsx와 같음)
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
}
afterEach(cleanup);

const rep = (p: Partial<ReportView> = {}): ReportView => ({ id: "r-1", kind: "report", title: "이번 주 진행 보고", from: "team-lead", body: "## 한 일\n- <b>문서</b> 정리", at: "2026-10-21T05:05:00.000Z", state: "pending", ...p });
const folder = (reports: ReportView[], archived: ReportView[] = []): FolderView => ({ reports, archived });
const folderProps = (f: FolderView, extra: Partial<Parameters<typeof ReportFolder>[0]> = {}) => ({
  floorName: "fake-shop",
  folder: f,
  channel: "ok" as const,
  sending: false,
  error: null,
  onApprove: vi.fn(),
  onRevise: vi.fn(),
  onRehire: vi.fn(),
  onClose: vi.fn(),
  ...extra,
});

describe("ReportFolder", () => {
  it("목록: 도장·제목·종류, 머리 대기 수(보관함 포함)", () => {
    render(<ReportFolder {...folderProps(folder([rep(), rep({ id: "r-2", state: "approved", title: "어제 한 일" }), rep({ id: "h-1", kind: "handover", member: "designer", title: undefined })], [rep({ id: "r-0", title: "지난달" })]))} />);
    expect(screen.getByText(LEAD_TEXT.folderSub(3, 4))).toBeTruthy();
    expect(screen.getByText("승인됨")).toBeTruthy();
    // 인수인계 미시작은 결재 "대기"와 다른 글자(qa B11)
    expect(screen.getByText(LEAD_TEXT.stampHandoverPending)).toBeTruthy();
    expect(screen.getByText("designer 인수인계")).toBeTruthy();
    expect(screen.getByText(LEAD_TEXT.archive(1))).toBeTruthy();
    expect(screen.getByText(LEAD_TEXT.archiveNote)).toBeTruthy();
  });

  it("빈 서류철 안내", () => {
    render(<ReportFolder {...folderProps(folder([]))} />);
    expect(screen.getByText(LEAD_TEXT.empty)).toBeTruthy();
  });

  it("본문은 글자로만 — <b>가 요소로 바뀌지 않고 그대로 보인다", () => {
    render(<ReportFolder {...folderProps(folder([rep()]))} />);
    fireEvent.click(screen.getByRole("button", { name: /이번 주 진행 보고/ }));
    const paper = screen.getByTestId("rf-paper");
    expect(paper.textContent).toContain("<b>문서</b>");
    expect(paper.querySelector("b")).toBeNull();
  });

  it("승인 → onApprove(id)", () => {
    const p = folderProps(folder([rep()]));
    render(<ReportFolder {...p} />);
    fireEvent.click(screen.getByRole("button", { name: /이번 주 진행 보고/ }));
    fireEvent.click(screen.getByRole("button", { name: LEAD_TEXT.approve }));
    expect(p.onApprove).toHaveBeenCalledWith("r-1");
  });

  it("#658: 다시 연결하는 중이면 결재 버튼은 꺼지고 이유는 '다시 연결하는 중'(재시작 안내·옮겨 열기 없음)", () => {
    render(<ReportFolder {...folderProps(folder([rep()]), { channel: "reconnecting" })} />);
    fireEvent.click(screen.getByRole("button", { name: /이번 주 진행 보고/ }));
    expect(screen.getByText(LEAD_TEXT.reconnecting)).toBeTruthy();
    expect(screen.getByRole("button", { name: LEAD_TEXT.approve }).getAttribute("aria-disabled")).toBe("true");
    expect(document.body.textContent).not.toContain("옮겨 열기");
  });

  it("channel 없음: 결재 버튼 비활성 + 이유, 눌러도 부르지 않음", () => {
    const p = folderProps(folder([rep()]), { channel: "not-launched" });
    render(<ReportFolder {...p} />);
    fireEvent.click(screen.getByRole("button", { name: /이번 주 진행 보고/ }));
    // B335 ④: 서류철에 보고서가 있으면 전에 연결됐던 층 — 다시 켠 뒤 끊긴 것으로 알린다
    expect(screen.getByText(LEAD_TEXT.notLaunchedRestart)).toBeTruthy();
    expect(LEAD_TEXT.notLaunchedRestart).toBe("연결이 끊겨 결재를 보낼 수 없습니다(대시보드를 다시 켰거나 층이 끝남). 층이 살아 있으면 작업 지시 켜기(옮겨 열기)로 다시 연결하세요."); // B336
    const approve = screen.getByRole("button", { name: LEAD_TEXT.approve });
    expect(approve.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(approve);
    fireEvent.click(screen.getByRole("button", { name: LEAD_TEXT.reviseOpen }));
    expect(p.onApprove).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("수정 사항: 빈 글·4,000자 초과는 못 보냄, 쓰면 onRevise(id, 글)", () => {
    const p = folderProps(folder([rep()]));
    render(<ReportFolder {...p} />);
    fireEvent.click(screen.getByRole("button", { name: /이번 주 진행 보고/ }));
    fireEvent.click(screen.getByRole("button", { name: LEAD_TEXT.reviseOpen }));
    const send = screen.getByRole("button", { name: LEAD_TEXT.reviseSend });
    fireEvent.click(send);
    expect(p.onRevise).not.toHaveBeenCalled();
    const box = screen.getByRole("textbox", { name: /수정 사항/ });
    fireEvent.change(box, { target: { value: "가".repeat(4001) } });
    expect(send.getAttribute("aria-disabled")).toBe("true");
    fireEvent.change(box, { target: { value: "환불 경우도 넣어 주세요" } });
    fireEvent.click(send);
    expect(p.onRevise).toHaveBeenCalledWith("r-1", "환불 경우도 넣어 주세요");
  });

  it("Esc: 수정 칸이 먼저 닫히고, 다음 Esc에 서랍을 닫는다", () => {
    const p = folderProps(folder([rep()]));
    render(<ReportFolder {...p} />);
    fireEvent.click(screen.getByRole("button", { name: /이번 주 진행 보고/ }));
    fireEvent.click(screen.getByRole("button", { name: LEAD_TEXT.reviseOpen }));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(p.onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("button", { name: LEAD_TEXT.reviseOpen }), { key: "Escape" });
    expect(p.onClose).toHaveBeenCalled();
  });

  it("결재 뒤: 버튼 대신 시각 줄과 도장", () => {
    render(<ReportFolder {...folderProps(folder([rep({ state: "revise", decidedAt: "2026-10-21T05:20:00.000Z" })]))} />);
    fireEvent.click(screen.getByRole("button", { name: /이번 주 진행 보고/ }));
    expect(screen.queryByRole("button", { name: LEAD_TEXT.approve })).toBeNull();
    expect(screen.getByText(/에 수정을 요청했습니다$/)).toBeTruthy();
  });

  it("휴업 중 보관된 결재: 도장 \"보관됨\", 무엇을 보관했는지 한 줄, 다시 누를 수 있음(스펙 12장 l)", () => {
    const p = folderProps(folder([{ ...rep(), state: "held", held: "revise" } as ReportView]));
    render(<ReportFolder {...p} />);
    expect(screen.getByText(LEAD_TEXT.stampHeld).className).toContain("held");
    fireEvent.click(screen.getByRole("button", { name: /이번 주 진행 보고/ }));
    expect(screen.getByText(LEAD_TEXT.heldLine.revise)).toBeTruthy();
    expect(screen.queryByTestId("rf-paper")!.querySelector(".rf-seal")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: LEAD_TEXT.approve }));
    expect(p.onApprove).toHaveBeenCalledWith("r-1");
  });

  it("보관된 결재인데 무엇을 보관했는지 모르면 공통 줄", () => {
    render(<ReportFolder {...folderProps(folder([rep({ state: "held" })]))} />);
    fireEvent.click(screen.getByRole("button", { name: /이번 주 진행 보고/ }));
    expect(screen.getByText(LEAD_TEXT.heldLineAny)).toBeTruthy();
  });

  it("인수인계: 새 팀원 시작 → onRehire(id)", () => {
    const p = folderProps(folder([rep({ id: "h-1", kind: "handover", member: "designer", title: undefined })]));
    render(<ReportFolder {...p} />);
    fireEvent.click(screen.getByRole("button", { name: /designer 인수인계/ }));
    expect(screen.getByText(LEAD_TEXT.rehireHelp)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: LEAD_TEXT.rehire }));
    expect(p.onRehire).toHaveBeenCalledWith("h-1");
  });
});

const q = (p: Partial<ChatQuestionView> = {}): ChatQuestionView => ({ id: "q-1", source: "ask", owner: "team-lead", ownerIsLead: true, text: "배포를 오늘 할까요?", options: ["오늘", "내일"], state: "open", ...p });
const replyProps = (question: ChatQuestionView, extra: Partial<Parameters<typeof ReplyDialog>[0]> = {}) => ({ question, channel: "ok" as const, sending: false, error: null, onSend: vi.fn(), onClose: vi.fn(), ...extra });

describe("ReplyDialog", () => {
  it("#658: 다시 연결하는 중이면 답 칸도 그 이유만(옮겨 열기 권유 없음)", () => {
    render(<ReplyDialog {...replyProps(q(), { channel: "reconnecting" })} />);
    expect(document.querySelector(".rd-off")!.textContent).toBe(LEAD_TEXT.reconnecting);
    expect(document.body.textContent).not.toContain("옮겨 열기");
  });

  it("제안된 선택지: 번호를 붙여 보이고, 고른 번호만 보낸다", () => {
    const p = replyProps(q());
    render(<ReplyDialog {...p} />);
    expect(screen.getByText(LEAD_TEXT.options)).toBeTruthy();
    expect(screen.getByText(LEAD_TEXT.optionsHelp)).toBeTruthy();
    const second = screen.getByRole("button", { name: LEAD_TEXT.optionLabel(2, "내일") });
    expect(second.textContent).toBe("2. 내일");
    const send = screen.getByRole("button", { name: LEAD_TEXT.send });
    expect(send.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(second);
    expect(second.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(send);
    expect(p.onSend).toHaveBeenCalledWith({ choice: 2, text: "" });
  });

  it("다시 누르면 고름이 풀리고, 글만 써도 보낼 수 있다(Ctrl+Enter)", () => {
    const p = replyProps(q());
    render(<ReplyDialog {...p} />);
    const first = screen.getByRole("button", { name: LEAD_TEXT.optionLabel(1, "오늘") });
    fireEvent.click(first);
    fireEvent.click(first);
    expect(first.getAttribute("aria-pressed")).toBe("false");
    const box = screen.getByRole("textbox", { name: /직접 답하기/ });
    fireEvent.change(box, { target: { value: "금요일에" } });
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    expect(p.onSend).toHaveBeenCalledWith({ text: "금요일에" });
  });

  it("질문 글은 글자로만", () => {
    render(<ReplyDialog {...replyProps(q({ text: "<img src=x onerror=alert(1)> 할까요?" }))} />);
    const box = screen.getByTestId("rd-question");
    expect(box.textContent).toContain("<img");
    expect(box.querySelector("img")).toBeNull();
  });

  it("팀원 질문은 리드를 거친다는 줄", () => {
    render(<ReplyDialog {...replyProps(q({ owner: "developer", ownerIsLead: false }))} />);
    expect(screen.getByText(LEAD_TEXT.memberNote("developer"))).toBeTruthy();
  });

  it("channel 없음: 글은 보이고 보내기는 비활성 + 안내", () => {
    const p = replyProps(q({ source: "await" }), { channel: "not-launched" });
    render(<ReplyDialog {...p} />);
    expect(screen.getByText(LEAD_TEXT.chipAwait)).toBeTruthy();
    expect(screen.getByText(LEAD_TEXT.replyOff)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: LEAD_TEXT.optionLabel(1, "오늘") }));
    fireEvent.click(screen.getByRole("button", { name: LEAD_TEXT.send }));
    expect(p.onSend).not.toHaveBeenCalled();
  });

  it("보관됨·터미널에서 답함·지나감: 띠 + 잠김", () => {
    const { rerender } = render(<ReplyDialog {...replyProps(q({ state: "held" }))} />);
    expect(screen.getByText(LEAD_TEXT.held)).toBeTruthy();
    rerender(<ReplyDialog {...replyProps(q({ state: "answered-terminal" }))} />);
    expect(screen.getByText(LEAD_TEXT.answeredTerminal)).toBeTruthy();
    const onShowNewer = vi.fn();
    const p = replyProps(q({ state: "superseded" }), { onShowNewer });
    rerender(<ReplyDialog {...p} />);
    expect(screen.getByText(LEAD_TEXT.superseded)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: LEAD_TEXT.optionLabel(1, "오늘") }));
    fireEvent.click(screen.getByRole("button", { name: LEAD_TEXT.send }));
    expect(p.onSend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: LEAD_TEXT.showNewer }));
    expect(onShowNewer).toHaveBeenCalled();
  });
});

describe("RetireDialog", () => {
  it("스펙 7장 1번 문장, 포커스는 [취소], [퇴사 진행] → onConfirm", () => {
    const onConfirm = vi.fn();
    render(<RetireDialog member="designer" sending={false} error={null} onConfirm={onConfirm} onClose={() => {}} />);
    const dlg = screen.getByRole("dialog", { name: LEAD_TEXT.retireTitle("designer") });
    expect(within(dlg).getByText("designer의 기억은 새 팀원에게 이어지지 않고, 인수인계 메모만 넘어갑니다. 대화 기록은 지우지 않습니다.")).toBeTruthy();
    expect(document.activeElement?.textContent).toBe(LEAD_TEXT.cancel);
    fireEvent.click(within(dlg).getByRole("button", { name: LEAD_TEXT.retireGo }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("보내는 중에는 다시 부르지 않음", () => {
    const onConfirm = vi.fn();
    render(<RetireDialog member="qa" sending error={null} onConfirm={onConfirm} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: LEAD_TEXT.sending }));
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("BuildingInfo", () => {
  const base = (extra: Partial<Parameters<typeof BuildingInfo>[0]> = {}) => ({
    userName: "User",
    usage: { today: 1_240_000, todayCacheRead: 820_000, last5h: 312_000, last7d: 4_800_000 },
    remaining: { five: null, week: 42.6, plan: null },
    floors: 3,
    members: 9,
    serverVersion: "2.0.0-beta.15",
    appVersion: "2.0.0-beta.15",
    onSave: vi.fn(async () => true),
    onClose: vi.fn(),
    ...extra,
  });

  it("정보: HUD와 같은 형식의 숫자, PLAN 없음 + 이유", () => {
    render(<BuildingInfo {...base()} />);
    expect(screen.getByText("1.24M")).toBeTruthy();
    expect(screen.getByText(BUILDING_TEXT.cacheRead("820.0k"))).toBeTruthy();
    expect(screen.getByText("43%")).toBeTruthy();
    // B332: statusline 상태를 모르면(옛 서버) 꺼짐과 같은 글
    expect(screen.getByText(BUILDING_TEXT.planOff)).toBeTruthy();
    expect(screen.getByText(BUILDING_TEXT.planWhyOff)).toBeTruthy();
    expect(screen.getByText(BUILDING_TEXT.floorsValue(3, 9))).toBeTruthy();
  });

  it("이름: 비우면 오류·저장 불가, 바꾸면 앞뒤 공백을 지워 저장", async () => {
    const p = base();
    render(<BuildingInfo {...p} />);
    const input = screen.getByRole("textbox", { name: /이름/ });
    const save = screen.getByRole("button", { name: BUILDING_TEXT.save });
    expect(save.getAttribute("aria-disabled")).toBe("true"); // 바꾸지 않음
    fireEvent.change(input, { target: { value: "  " } });
    expect(screen.getByText(BUILDING_TEXT.empty)).toBeTruthy();
    fireEvent.change(input, { target: { value: " gimdong " } });
    expect(screen.getByText(BUILDING_TEXT.signHelp("gimdong"))).toBeTruthy();
    await act(async () => {
      fireEvent.click(save);
    });
    expect(p.onSave).toHaveBeenCalledWith("gimdong");
    expect(screen.getByText(BUILDING_TEXT.saved)).toBeTruthy();
  });

  it("40자 넘으면 저장 불가, 저장 실패는 기존 실패 문구", async () => {
    const p = base({ onSave: vi.fn(async () => false) });
    render(<BuildingInfo {...p} />);
    const input = screen.getByRole("textbox", { name: /이름/ });
    const save = screen.getByRole("button", { name: BUILDING_TEXT.save });
    fireEvent.change(input, { target: { value: "가".repeat(41) } });
    fireEvent.click(save);
    expect(p.onSave).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "새 이름" } });
    await act(async () => {
      fireEvent.click(save);
    });
    expect(screen.getByText(CH_TEXT.failed)).toBeTruthy();
  });
});
