/**
 * Phase 6b 책상·지시 절·알림 글자(designer SPEC docs/design/phase6b/SPEC.md §9 W1–W27, qa 검토 글자). 부품 안 글자는 leadText.ts(LEAD_TEXT)
 * 휴업 글자는 기존 CH_TEXT.instructPaused, 실패는 CH_TEXT.failed·notConnected를 그대로 쓴다(새 글자를 만들지 않음)
 */
export const CMD_TEXT = {
  title: "지시",
  report: "보고 요청",
  folder: "서류철",
  folderPending: (n: number) => `서류철 · 대기 ${n}`,
  offduty: "퇴근",
  onduty: "출근",
  retire: "퇴사",
  offRequested: "퇴근 요청함",
  retiring: "퇴사 진행 중",
  sending: "보내는 중…",
  sent: "리드에게 보냈습니다",
  held: "보관했습니다 — 재개할 때 확인하고 보냅니다",
  overdue: "보고 요청 뒤 10분 넘게 답이 없습니다",
  // 책상(§2)
  deskFolder: (n: number) => `결재 ${n}`,
  statusRetiring: "인수인계 쓰는 중",
  statusOffRequested: "퇴근 요청함",
  statusLongIdle: "오래 쉬는 중",
  offSign: "퇴근",
  awaiting: "답을 기다립니다",
  awaitHeld: "답을 보관했습니다 — 재개할 때 확인하고 보냅니다",
  // 전임자(§6)
  predecessors: (n: number) => `전임자 ${n}`,
  predecessorsAria: (n: number) => `전임자 ${n}명`,
  period: "일한 기간",
  retiredAt: "퇴사",
  // 알림(W26)
  announce: {
    approve: "승인을 리드에게 보냈습니다",
    revise: "수정 사항을 리드에게 보냈습니다",
    reply: "답을 리드에게 보냈습니다",
    replyHeld: "답을 보관했습니다 — 재개할 때 확인하고 보냅니다",
    retire: "퇴사를 리드에게 보냈습니다",
  },
  // 접근 이름(§8)
  aria: {
    folder: (n: number) => `, 결재 대기 ${n}건`,
    await: (name: string) => `${name}, 답을 기다립니다. 답하기 열기`,
    off: (name: string) => `${name}, 퇴근함. 열기`,
    longIdle: (name: string) => `${name}, 오래 쉬는 중. 열기`,
  },
} as const;
