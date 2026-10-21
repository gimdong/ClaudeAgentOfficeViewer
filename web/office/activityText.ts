import type { DecisionKind, Member } from "../../src/shared/types";
import { formatTokens } from "../format";
import type { IconName } from "../pixel/sprites";
import { GROUP_LABEL } from "../policy/text";

/** 「」 안 값의 최대 글자 수(디자인 7.3) */
export const CLIP = 28;

const SEGMENTER: Intl.Segmenter | undefined =
  typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter("ko", { granularity: "grapheme" }) : undefined;

/**
 * 글자 단위로 나눈다. Segmenter가 없으면 코드포인트 단위로 대체한다.
 * 기본 매개변수(`= SEGMENTER`)만 쓰면 호출부가 undefined를 "명시적으로" 넘겨도 기본값으로
 * 치환돼 버려("생략함"과 구분이 안 됨) 코드포인트 대체 경로를 강제로 쓸 방법이 없다.
 * arguments.length로 실제로 두 번째 인자를 넘겼는지를 구분한다.
 */
export function chars(s: string, segmenter?: Intl.Segmenter): string[] {
  const seg = arguments.length >= 2 ? segmenter : SEGMENTER;
  return seg ? Array.from(seg.segment(s), (x) => x.segment) : Array.from(s);
}

export function squash(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function clipEnd(s: string, n = CLIP): string {
  const c = chars(squash(s));
  return c.length <= n ? c.join("") : c.slice(0, n - 1).join("") + "…";
}

/** 가운데를 "…"로 줄여 앞부분과 확장자를 살린다. 예: 2026-09-28-cla…ice-design.md */
export function clipMiddle(s: string, n = CLIP): string {
  const c = chars(squash(s));
  if (c.length <= n) return c.join("");
  const head = Math.ceil((n - 1) / 2);
  const tail = Math.floor((n - 1) / 2);
  return c.slice(0, head).join("") + "…" + c.slice(c.length - tail).join("");
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export interface Line {
  icon: IconName;
  text: string;
  /** 결정 대기 문장이면 말풍선 테두리를 노랑으로 바꾼다 */
  decision: boolean;
  /** 정책으로 막힘(phase3 §6.3): 아이콘을 분홍 자물쇠로. 테두리는 그대로 */
  blocked?: true;
}

// 조사가 받침에 따라 바뀌지 않도록 변하는 값은 「」로 감싸고 뒤에 고정 명사를 붙인다(디자인 7.2)
const q = (s: string) => `「${clipEnd(s)}」`;
const qf = (path: string) => `「${clipMiddle(fileName(path))}」`;
const line = (icon: IconName, text: string, decision = false): Line => ({ icon, text, decision });

const WAITING_FOR: Record<DecisionKind, string> = {
  permission: "명령 실행 허락을",
  question: "질문에 대한 답을",
  plan: "계획 승인을",
  budget: "예산 추가 여부를",
  team: "팀 리드의 결정을",
  chat: "질문에 대한 답을", // ask_user(Phase 6b) — question과 같은 글자
};

/** 작업 중 + 방금 쓴 문장(사용자 결정 2026-10-16, B193) */
const WORKING_SAID = (s: string) => `저는 지금 ${q(s)}라고 쓰며 일하고 있습니다`;

const other = (tool: string) => line("bash", `저는 지금 ${q(tool || "알 수 없는")} 도구를 쓰고 있습니다`);

function toolLine(tool = "", target?: string): Line {
  // 요약 필드가 비어 대상이 없으면 "그 밖의 도구" 틀을 쓴다(스펙 9장)
  if (target === undefined) return other(tool);
  switch (tool) {
    case "Bash":
      return line("bash", `저는 지금 ${q(target)} 명령을 실행하고 있습니다`);
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return line("edit", `저는 지금 ${qf(target)} 파일을 고치고 있습니다`);
    case "Write":
      return line("edit", `저는 지금 ${qf(target)} 파일을 만들고 있습니다`);
    case "Read":
      return line("read", `저는 지금 ${qf(target)} 파일을 읽고 있습니다`);
    case "Grep":
    case "Glob":
      return line("search", `저는 지금 ${q(target)} 패턴을 찾고 있습니다`);
    case "WebSearch":
      return line("web", `저는 지금 ${q(target)} 자료를 찾아보고 있습니다`);
    case "WebFetch":
      return line("web", `저는 지금 ${q(target)} 페이지를 읽고 있습니다`);
    case "SendMessage":
      return line("team", `저는 지금 ${clipEnd(target)}에게 메시지를 보내고 있습니다`);
    case "Agent":
    case "Task":
      return line("team", `저는 지금 ${q(target)} 일을 맡기고 있습니다`);
    default:
      return other(tool);
  }
}

/** 디자인 7.2 표. 우선순위: 결정 → 휴업 → 퇴근 → 도구 → activeForm → 메시지 → 마지막 문장 → 대기 */
export function activityLine(m: Member, opts: { paused?: boolean } = {}): Line {
  if (m.state === "decision" && m.decision) return line("ask", `저는 지금 ${WAITING_FOR[m.decision.kind]} 기다리고 있습니다`, true);
  // 결정 대기 다음이 정책으로 막힘(phase3 §6.3). 손은 들지 않는다(decision: false)
  if (m.policyDenied) return { icon: "lock", text: `정책으로 막힘: ${GROUP_LABEL[m.policyDenied.group]}`, decision: false, blocked: true };
  // 멈춘 층도 쉬는 것이 아니라 도구만 막힌 채 기다린다(phase4a B126, Phase 1 7.2 문장 교정)
  if (opts.paused) return line("pause", "저는 지금 휴업 중이라 도구를 쓰지 않고 기다립니다");
  if (m.state === "offline") return line("wait", "저는 퇴근했습니다");
  const a = m.activity;
  if (a?.kind === "tool") return toolLine(a.tool, a.target);
  if (a?.kind === "todo" && a.target) return line("read", `저는 지금 할 일 목록의 ${q(a.target)} 항목을 진행하고 있습니다`);
  if (m.unread > 0) return line("team", `저는 지금 읽지 않은 메시지가 ${m.unread}통 있습니다`);
  // 작업 중이면 기다림 문장으로 떨어지지 않는다(버그 1, B193). 문장은 사용자 결정(2026-10-16)
  if (m.state === "working") return a?.kind === "said" && a.target ? line("team", WORKING_SAID(a.target)) : line("edit", "저는 지금 생각하며 답을 쓰고 있습니다");
  if (a?.kind === "said" && a.target) return line("team", `저는 방금 ${q(a.target)}라고 말했습니다`);
  return line("wait", "저는 지금 다음 지시를 기다리고 있습니다");
}

/** 경과 시간 단위(디자인 7.1, SPEC 7.1): 60초 미만 N초째, 60분 미만 N분째, 그 이상 N시간째. 모두 내림 */
function elapsedLabel(secs: number): string {
  if (secs < 60) return `${secs}초째`;
  if (secs < 3600) return `${Math.floor(secs / 60)}분째`;
  return `${Math.floor(secs / 3600)}시간째`;
}

/** 보조 줄(디자인 7.1): {모델} · 토큰 {n} · {경과}. 결정 대기와 퇴근은 따로 */
export function metaLine(m: Member, now: number): string {
  // 보고서를 열 수 있는 결정(큐의 id가 있음)이면 Phase 2 문구(phase2 §9.2). id가 없으면 열리지 않으므로 Phase 1 문구 그대로
  if (m.state === "decision") return m.decision?.id ? "누르면 결정 보고서가 열립니다" : "결정 보고서는 다음 버전에서 열립니다";
  if (m.state === "offline") return "";
  const parts: string[] = [];
  // 디자인 7.1: 리드에 합친 서브에이전트가 한 일이면 앞머리에 "서브에이전트" 또는 "서브에이전트({agent_type})"
  // 정책으로 막힌 것이 서브에이전트면 그 종류를 앞머리로(phase3 §6.3). 도구 활동의 앞머리보다 먼저다
  if (m.policyDenied?.subType) parts.push(`서브에이전트(${m.policyDenied.subType})`);
  else if (m.activity?.sub) parts.push(m.activity.subType ? `서브에이전트(${m.activity.subType})` : "서브에이전트");
  if (m.model) parts.push(m.model);
  parts.push(`토큰 ${formatTokens(m.tokens.total)}`);
  if (m.activity && m.activity.kind !== "said") {
    const secs = Math.floor((now - Date.parse(m.activity.startedAt)) / 1000);
    if (Number.isFinite(secs) && secs >= 0) parts.push(elapsedLabel(secs));
  }
  return parts.join(" · ");
}
