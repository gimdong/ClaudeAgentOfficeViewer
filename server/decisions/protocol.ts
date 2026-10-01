/**
 * Claude Code hook 응답 형식(스펙 2장). 형식은 이 파일 한 곳에만 두고 test/server/protocol.test.ts로 글자 그대로 고정한다 —
 * 연구 프리뷰라 버전마다 바뀔 수 있다(스펙 12장).
 */
import { toGraphemes } from "../events/summarize";

/** 서버가 붙잡은 응답을 빈 200으로 놓아주는 시간. hooks.json의 PermissionRequest timeout(600초)보다 짧다 */
export const HOLD_MS = 590_000;
export const DENY_DEFAULT = "대시보드에서 사용자가 거부했습니다";
export const BUDGET_STOP = "예산에 도달해 사용자가 중단했습니다";
export const REASON_MAX = 200;
export const OTHER_MAX = 500;
export const PLAN_MAX = 4000;

export function permissionResponse(behavior: "allow" | "deny", extra: { message?: string; updatedInput?: Record<string, unknown> } = {}): object {
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior, ...extra } } };
}

const preTool = (permissionDecision: "ask" | "deny", reason: string) => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason: reason },
});
export const preToolAsk = (reason: string): object => preTool("ask", reason);
export const preToolDeny = (reason: string): object => preTool("deny", reason);

export function budgetReason(budgetTokens: number): string {
  return `예산(${budgetTokens.toLocaleString("en-US")}토큰)에 도달했습니다. 대시보드나 이 창에서 계속할지 정해 주세요`;
}

type Answer = { labels: number[] } | { other: string };

/**
 * AskUserQuestion의 answers 객체를 만든다(Ruling B30). 키는 질문 원문, 값은 선택지 label 원문(다중 선택은 ", "로 잇기)
 * 또는 자유 입력. 화면에는 가린 질문을 보냈어도 Claude Code는 원문 키로 찾으므로 여기서는 원문을 쓴다.
 * 개수·인덱스·형식이 하나라도 어긋나면 null.
 */
export function buildAnswers(toolInput: unknown, answers: Answer[]): Record<string, string> | null {
  const qs = (toolInput as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(qs) || !Array.isArray(answers) || answers.length !== qs.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < qs.length; i++) {
    const q = qs[i] as { question?: unknown; multiSelect?: unknown; options?: unknown } | null;
    const a = answers[i] as Partial<{ labels: unknown; other: unknown }> | null;
    if (typeof q?.question !== "string" || !a || typeof a !== "object") return null;
    if ("other" in a && !("labels" in a)) {
      if (typeof a.other !== "string" || !a.other.trim() || toGraphemes(a.other).length > OTHER_MAX) return null;
      out[q.question] = a.other;
      continue;
    }
    const labels = a.labels;
    const options = Array.isArray(q.options) ? q.options : [];
    if (!Array.isArray(labels) || labels.length === 0 || new Set(labels).size !== labels.length) return null;
    if (q.multiSelect !== true && labels.length !== 1) return null;
    const picked: string[] = [];
    for (const j of labels) {
      const label = Number.isInteger(j) ? (options[j as number] as { label?: unknown } | undefined)?.label : undefined;
      if (typeof label !== "string") return null;
      picked.push(label);
    }
    out[q.question] = picked.join(", ");
  }
  return out;
}
