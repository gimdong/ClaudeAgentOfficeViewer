import type { DecisionKind, DecisionState, DecisionView } from "../../src/shared/types";
import { LEAD_TEXT } from "../office/leadText";

/** 결정 보고서 문구(디자인 phase2 §2·§3·§9). 값은 표의 글자 그대로다 */

/** 사용자가 보는 글자(그래핌) 단위. 서버가 거부 이유·기타 답을 이 단위로 센다(server/events/summarize toGraphemes) */
export const graphemes: (s: string) => string[] = (() => {
  try {
    const seg = new Intl.Segmenter("ko", { granularity: "grapheme" });
    return (s: string) => Array.from(seg.segment(s), (x) => x.segment);
  } catch {
    return (s: string) => Array.from(s);
  }
})();
export const cutGraphemes = (s: string, max: number): string => {
  const g = graphemes(s);
  return g.length > max ? g.slice(0, max).join("") : s;
};

export const KIND_CHIP: Record<DecisionKind, string> = {
  permission: "권한 요청",
  question: "질문",
  plan: "계획 승인",
  budget: "예산 도달",
  team: "팀원 요청",
  chat: LEAD_TEXT.chipAsk, // ask_user(Phase 6b) — designer 글자
};

const FILE_TOOLS = new Set(["Edit", "MultiEdit", "NotebookEdit", "Write"]);

/** 예산 표기(§2.4): 1억·1만으로 나누어떨어지면 그 단위, 아니면 쉼표 */
export function budgetLabel(n: number): string {
  if (n > 0 && n % 100_000_000 === 0) return `${n / 100_000_000}억 토큰`;
  if (n > 0 && n % 10_000 === 0) return `${n / 10_000}만 토큰`;
  return `${n.toLocaleString("en-US")} 토큰`;
}

/** 사용량 표기(§2.4): 항상 정확한 값 */
export const usageLabel = (n: number): string => `${n.toLocaleString("en-US")} 토큰`;

export function titleOf(v: DecisionView): string {
  switch (v.kind) {
    case "permission":
      if (v.toolName === "Bash") return "이 명령을 실행해도 될까요?";
      if (v.toolName === "Edit" || v.toolName === "MultiEdit" || v.toolName === "NotebookEdit") return "이 파일을 고쳐도 될까요?";
      if (v.toolName === "Write") return "이 파일을 만들어도 될까요?";
      if (v.toolName === "WebFetch") return "이 페이지를 열어도 될까요?";
      return "이 도구를 써도 될까요?";
    case "question":
    case "chat": // 결정 큐에는 오지 않는다(ask_user는 ReplyDialog) — 같은 글자
      return "질문에 답해 주세요";
    case "plan":
      return v.answerable ? "이 계획대로 진행할까요?" : "계획 승인을 기다리고 있습니다";
    case "budget":
      return "예산에 도달했습니다. 계속할까요?";
    case "team":
      return "팀원이 결정을 기다립니다";
  }
}

/** 종류별 "이유" 한 줄(§2) */
export function whyLine(v: DecisionView): string {
  switch (v.kind) {
    case "permission":
      // 정책 ask로 뜬 권한 요청(phase3 §6.4, B84)
      if (v.byPolicy) return "권한 정책이 매번 확인하도록 정해 둔 도구입니다";
      if (v.toolName === "Bash") return "이 명령을 실행해도 될지 묻고 있습니다";
      if (FILE_TOOLS.has(v.toolName)) return "이 파일을 바꿔도 될지 묻고 있습니다";
      return "이 도구를 써도 될지 묻고 있습니다";
    case "question":
    case "chat":
      return "작업을 이어 가려면 답이 필요합니다";
    case "plan":
      return v.answerable ? "승인하면 계획을 마치고 파일을 고치기 시작합니다" : "이 계획은 터미널에서 승인할 수 있습니다";
    case "budget":
      return `예산 ${budgetLabel(v.budget?.budgetTokens ?? 0)}에 도달했습니다`;
    case "team":
      return "팀원이 리드에게 [결정 필요] 메시지를 보냈습니다";
  }
}

const OUTCOME: Record<string, string> = {
  allow: "대시보드에서 허용함",
  deny: "대시보드에서 거부함",
  answer: "대시보드에서 답함",
  continue: "대시보드에서 계속함",
  stop: "대시보드에서 중단함",
};

/** 대시보드에서 답한 결과 한 줄(§3). 계획 허용은 "승인함" */
export function outcomeLine(kind: DecisionKind, outcome: string | undefined): string {
  if (outcome === "allow" && kind === "plan") return "대시보드에서 승인함";
  return OUTCOME[outcome ?? ""] ?? "대시보드에서 답함";
}

export const TERMINAL_DONE = "터미널에서 이미 답함";
export const EXPIRED = "시간이 지나 터미널로 넘어감";
export const VANISHED = "이 요청은 끝났습니다. 터미널을 확인해 주세요";
export const SEND_FAILED = "보내지 못했습니다. 서버 연결을 확인하고 다시 시도해 주세요.";

/** 결정이 끝났을 때의 한 줄(§3 닫힘 문구). pending이면 빈 문자열 */
export function resultLine(v: DecisionView): string {
  if (v.state === "answered-dashboard") return outcomeLine(v.kind, v.outcome);
  if (v.state === "closed-terminal") return TERMINAL_DONE;
  if (v.state === "expired") return EXPIRED;
  return "";
}

/** 409 본문의 state로 고르는 문구(§3 409 규칙) */
export function conflictLine(state: DecisionState | undefined): string {
  if (state === "answered-dashboard") return "다른 창에서 이미 답했습니다";
  if (state === "expired") return EXPIRED;
  return "이미 터미널에서 답했습니다";
}

/** 남은 시간 "m:ss"(Ruling B29: deadline까지) */
export function remaining(deadline: string, now: number): string {
  const s = remainingSeconds(deadline, now);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function remainingSeconds(deadline: string, now: number): number {
  return Math.max(0, Math.ceil((Date.parse(deadline) - now) / 1000));
}

/** 요약 코드 상자의 값(§1.4): 처음 있는 것 하나 */
export function summaryOf(v: DecisionView): string | undefined {
  const d = v.detail;
  return d.command ?? d.filePath ?? d.pattern ?? d.query ?? d.domain ?? d.to;
}
