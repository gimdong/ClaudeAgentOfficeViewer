// @vitest-environment jsdom
// Phase 6b Review Focus 3: 모델이 만든 보고서·질문 글과 사용자가 정한 빌딩 이름은 화면에서 글자로만 그린다(HTML·마크다운 해석 없음)
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BuildingInfo } from "../../web/building/BuildingInfo";
import type { ChatQuestionView, ReportView } from "../../web/office/leadText";
import { ReplyDialog } from "../../web/office/ReplyDialog";
import { ReportFolder } from "../../web/office/ReportFolder";

if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
}
afterEach(cleanup);

const EVIL = `<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script><a href="javascript:window.__pwned=3">링크</a>[md](javascript:alert(1)) <b>굵게</b>`;
const noActiveContent = () => {
  // 화면 부품 자신의 아이콘(svg)은 있어도 된다. 글에서 생긴 요소만 없어야 한다
  for (const sel of ["img", "script", "a[href]", "b", "iframe", "svg [onerror]"]) expect(document.querySelectorAll(sel).length, sel).toBe(0);
  expect((window as { __pwned?: number }).__pwned).toBeUndefined();
};

describe("Review Focus 3: 화면은 글자로만", () => {
  it("보고서 제목·본문·인수인계 이름", () => {
    const rep: ReportView = { id: "r-1", kind: "report", title: `보고 ${EVIL}`, from: "team-lead", body: `본문\n${EVIL}`, at: "2026-10-21T05:05:00.000Z", state: "pending" };
    const hand: ReportView = { id: "h-1", kind: "handover", member: "designer", from: "designer", body: EVIL, at: "2026-10-21T05:06:00.000Z", state: "pending" };
    render(<ReportFolder floorName={`층 ${EVIL}`} folder={{ reports: [rep, hand], archived: [] }} channel="ok" sending={false} error={null} onApprove={vi.fn()} onRevise={vi.fn()} onRehire={vi.fn()} onClose={vi.fn()} />);
    noActiveContent();
    fireEvent.click(screen.getByRole("button", { name: /보고 / }));
    noActiveContent();
    expect(document.body.textContent).toContain("<script>");
  });

  it("질문 글·선택지(ask_user·Stop 경로 모두 모델 글)", () => {
    const q: ChatQuestionView = { id: "q-1", source: "ask", owner: "team-lead", ownerIsLead: true, text: `할까요? ${EVIL}`, options: [EVIL, "아니요"], state: "open" };
    render(<ReplyDialog question={q} channel="ok" sending={false} error={null} onSend={vi.fn()} onClose={vi.fn()} />);
    noActiveContent();
    expect(document.body.textContent).toContain("onerror");
  });

  it("빌딩 이름", () => {
    render(<BuildingInfo userName={EVIL.slice(0, 40)} usage={{ today: 0, todayCacheRead: 0, last5h: 0, last7d: 0 }} remaining={{ five: null, week: null, plan: null }} floors={0} members={0} appVersion="t" onSave={async () => true} onClose={vi.fn()} />);
    noActiveContent();
  });
});
