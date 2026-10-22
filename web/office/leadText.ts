import { CH_TEXT } from "../floors/ChannelDialogs";

/**
 * Phase 6b 팀리더 일 화면의 글자와 화면용 모양(디자인 docs/design/phase6b/SPEC.md §9).
 * 모양(ReportView 등)은 developer가 src/shared/types.ts에 같은 필드로 둘 때까지 여기 둔다(B318)
 */

/** 화면 모양은 shared로 옮김(developer Task 4). 여기서 다시 내보내 기존 import를 그대로 둔다 */
export type { FolderView, LeadChannel, ReportState, ReportView } from "../../src/shared/types";
import type { LeadChannel, ReportState } from "../../src/shared/types";
/** 대화 질문 화면 모양은 shared로 옮김(4c8e70d). 여기서 다시 내보내 기존 import를 그대로 둔다 */
export type { ChatQuestionView } from "../../src/shared/types";

export const LEAD_MAX = 4_000;

export const LEAD_TEXT = {
  // 지시 통로가 없을 때(B312·SPEC §1.2). 연결 없음은 기존 CH_TEXT.notConnected를 그대로 쓴다
  notLaunched: "작업 지시 켜기(옮겨 열기)로 연결하면 쓸 수 있습니다",
  notConnected: CH_TEXT.notConnected,
  failed: CH_TEXT.failed,
  close: "닫기",
  back: "목록으로",
  // 서류철(§3)
  folderChip: "서류철",
  folderSub: (pending: number, all: number) => `대기 ${pending} · 모두 ${all}`,
  stamp: { pending: "대기", approved: "승인됨", revise: "수정 요청", started: "시작함" } as Record<ReportState, string>,
  stampHandoverPending: "시작 전",
  // 휴업 중 결재(스펙 12장 l): 보낼 때까지 도장은 "보관됨", 위 줄에 무엇을 보관했는지
  stampHeld: "보관됨",
  heldLine: { approve: "승인을 보관했습니다 — 재개할 때 확인하고 보냅니다", revise: "수정 요청을 보관했습니다 — 재개할 때 확인하고 보냅니다" },
  seal: { approved: "승인", revise: "수정 요청" } as Partial<Record<ReportState, string>>,
  kindReport: (at: string) => `보고서 · ${at}`,
  kindHandover: (member: string, at: string) => `인수인계 · ${member} · ${at}`,
  handoverTitle: (member: string) => `${member} 인수인계`,
  untitled: "(제목 없음)",
  empty: '아직 받은 보고서가 없습니다. 리드 패널의 "보고 요청"으로 보고를 받아 보세요.',
  archive: (n: number) => `보관함 ${n}`,
  archiveNote: "오래된 대기 보고서는 보관함으로 옮겨집니다",
  approve: "승인",
  reviseOpen: "수정 사항 적기",
  reviseLabel: "수정 사항",
  reviseSend: "수정 요청 보내기",
  cancel: "취소",
  approvedAt: (at: string) => `${at}에 승인했습니다`,
  revisedAt: (at: string) => `${at}에 수정을 요청했습니다`,
  rehire: "새 팀원 시작",
  rehireHelp: "같은 이름으로 새 팀원을 띄우고 이 메모를 첫 지시로 줍니다",
  rehiredAt: (at: string) => `${at}에 새 팀원을 시작했습니다`,
  sending: "보내는 중…",
  // 답 칸(§4)
  chipAsk: "대화 질문",
  chipAwait: "답을 기다립니다",
  memberNote: (name: string) => `${name}의 질문입니다. 답은 리드를 거쳐 보냅니다`,
  options: "제안된 선택지",
  optionsHelp: "질문한 쪽이 쓴 선택지입니다. 고르면 번호만 보냅니다",
  optionLabel: (n: number, text: string) => `선택지 ${n}번, ${text}`,
  free: "직접 답하기",
  send: "보내기",
  replyOff: "터미널에서 답하거나, 작업 지시 켜기(옮겨 열기)로 연결하세요",
  held: "보관한 답이 있습니다. 재개할 때 확인하고 보냅니다",
  answeredTerminal: "이미 터미널에서 답했습니다",
  superseded: "새 질문이 와서 이 질문은 닫혔습니다",
  showNewer: "새 질문 보기",
  count: (n: number) => `(${n.toLocaleString("en-US")}/4,000)`,
  // 퇴사 창(§5)
  retireTitle: (name: string) => `${name} 퇴사를 진행할까요?`,
  retireBody: (name: string) => `${name}의 기억은 새 팀원에게 이어지지 않고, 인수인계 메모만 넘어갑니다. 대화 기록은 지우지 않습니다.`,
  retireHelp: '인수인계 메모가 서류철에 오면(팀원이 쓰지 못하면 리드가 대신 씁니다) "새 팀원 시작"을 누를 수 있습니다.',
  retireGo: "퇴사 진행",
} as const;

const pad = (n: number) => String(n).padStart(2, "0");
/** 화면 시각 `MM-DD HH:mm`(로컬). 읽을 수 없는 값은 그대로 */
export function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function channelWhy(ch: LeadChannel): string | null {
  return ch === "not-launched" ? LEAD_TEXT.notLaunched : ch === "not-connected" ? LEAD_TEXT.notConnected : null;
}
