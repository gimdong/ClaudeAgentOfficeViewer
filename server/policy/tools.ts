import type { PolicyGroup, PolicyValue } from "../../src/shared/types";

/** 묶음 정의(스펙 5.2). 화면과 설명서는 테스트로 이 표와 맞춘다 */
export const GROUPS: Record<PolicyGroup, { label: string }> = {
  bash: { label: "명령 실행" },
  edit: { label: "파일 고치기" },
  web: { label: "웹 접근" },
  agent: { label: "팀원·서브에이전트 만들기" },
  mcp: { label: "외부 도구(MCP)" },
  other: { label: "그 밖의 도구" },
  all: { label: "모든 도구" },
};
export const VALUE_LABELS: Record<PolicyValue, string> = { ask: "항상 질문", deny: "금지" };
/** 규칙 하나의 이름("명령 실행 금지"). Claude가 받는 이유 문구의 따옴표 안과 정책 목록의 요약이 이 글자다(Ruling B92) */
export const ruleLabel = (group: PolicyGroup, value: PolicyValue): string => `${GROUPS[group].label} ${VALUE_LABELS[value]}`;
export const GROUP_KEYS = ["bash", "edit", "web", "agent", "mcp", "other", "all"] as const satisfies readonly PolicyGroup[];

/** 옛 이름(Task, MultiEdit)도 같은 묶음이다(Ruling B86) */
const BY_TOOL = new Map<string, Exclude<PolicyGroup, "all">>([
  ["Bash", "bash"],
  ["Edit", "edit"], ["Write", "edit"], ["NotebookEdit", "edit"], ["MultiEdit", "edit"],
  ["WebFetch", "web"], ["WebSearch", "web"],
  ["Agent", "agent"], ["Task", "agent"],
]);

/**
 * 답하기·팀 통신 도구. 어떤 규칙도 적용하지 않는다 — 막으면 에이전트가 갇히고 "막혔다"는 보고도 못 한다(스펙 5.2).
 * SubagentHandback은 서브에이전트가 결과를 리드에게 돌려주는 도구다(스파이크 2.1.291, Ruling B94). TaskStop·ToolSearch는 여기 넣지 않는다(other)
 */
export const EXEMPT_TOOLS: ReadonlySet<string> = new Set(["AskUserQuestion", "ExitPlanMode", "SendMessage", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "SubagentHandback", "TaskStop"]); // TaskStop: 리드가 "모든 도구 금지"여도 팀을 내릴 수 있게(사용자 결정 2026-10-11)

/** 도구 이름(대소문자 그대로, 스파이크 S6)의 묶음. 빼는 도구면 null */
export function groupOf(toolName: string): Exclude<PolicyGroup, "all"> | null {
  if (EXEMPT_TOOLS.has(toolName)) return null;
  return BY_TOOL.get(toolName) ?? (toolName.startsWith("mcp__") ? "mcp" : "other");
}

export const isGroup = (v: unknown): v is PolicyGroup => typeof v === "string" && (GROUP_KEYS as readonly string[]).includes(v);
export const isValue = (v: unknown): v is PolicyValue => v === "ask" || v === "deny";
