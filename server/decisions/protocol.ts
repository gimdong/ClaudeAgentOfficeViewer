/**
 * Claude Code hook 응답 형식(스펙 2장). 형식은 이 파일 한 곳에만 두고 test/server/protocol.test.ts로 글자 그대로 고정한다 —
 * 연구 프리뷰라 버전마다 바뀔 수 있다(스펙 12장).
 */
import type { DecisionAnswer } from "../../src/shared/types";
import { createHash } from "node:crypto";
import { toGraphemes } from "../events/summarize";

/**
 * tool_input의 정규 직렬화(키를 재귀적으로 정렬) sha256. 원문은 보관하지 않고 이 값만 비교한다.
 * PreToolUse·PermissionRequest·PostToolUse의 같은 호출은 같은 값이다(스파이크 S4d). 예산 관문(B48)과 큐의 터미널 판정(B70)이 함께 쓴다
 */
const canonical = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])])) : v;
export const inputHash = (input: unknown): string => createHash("sha256").update(JSON.stringify(canonical(input)) ?? "").digest("hex");

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

export function preToolAsk(reason: string): object {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: reason } };
}

export function preToolDeny(reason: string): object {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}

/** who는 대상 화면 이름, rule은 걸린 규칙의 이름(ruleLabel, 예: "명령 실행 금지"). 도구 입력은 넣지 않는다(스펙 6.1, 문구는 Ruling B92) */
export const policyDenyReason = (who: string, rule: string): string =>
  `대시보드 권한 정책: ${who}에게는 "${rule}"가 정해져 있어 이 도구를 쓸 수 없습니다. 꼭 필요하면 사용자에게 알려 주세요.`;
export const policyAskReason = (who: string, rule: string): string =>
  `대시보드 권한 정책: ${who}에게는 "${rule}"이 정해져 있어 이 도구는 매번 확인합니다.`;

/** 일시정지 deny의 이유(Phase 4a 스펙 4.2·B122, 설명서·테스트가 글자까지 대조) */
export const PAUSED_REASON = '대시보드 일시정지: 사용자가 대시보드에서 이 세션을 일시정지해 지금은 이 도구를 쓸 수 없습니다. 사용자가 대시보드에서 스위치를 "영업 중"으로 돌리면 다시 쓸 수 있습니다. 기다리거나 사용자에게 알려 주세요.';

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
  // 질문 원문이 "__proto__"여도 키로 남게 프로토타입 없는 객체를 쓴다
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
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

/** 질문 답의 개수·선택지 수 상한(AskUserQuestion은 질문 몇 개뿐이다). 넘으면 모양이 틀린 것으로 본다 */
const MAX_ANSWERS = 20;
const MAX_LABELS = 50;
const own = (o: object) => Object.keys(o);
const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** POST /api/decisions/:id 본문을 DecisionAnswer로 좁힌다. 모르는 키·타입·크기가 하나라도 있으면 null(→ 400) */
export function parseAnswer(body: unknown): DecisionAnswer | null {
  if (!isPlain(body)) return null;
  const keys = own(body);
  const only = (...allowed: string[]) => keys.every((k) => allowed.includes(k));
  switch (body.action) {
    case "allow":
    case "continue":
    case "stop":
      return only("action") ? { action: body.action } : null;
    case "deny":
      if (!only("action", "reason") || (body.reason !== undefined && typeof body.reason !== "string")) return null;
      return body.reason === undefined ? { action: "deny" } : { action: "deny", reason: body.reason };
    case "answer": {
      const a = body.answers;
      if (!only("action", "answers") || !Array.isArray(a) || a.length > MAX_ANSWERS) return null;
      const answers: Array<{ labels: number[] } | { other: string }> = [];
      for (const x of a) {
        if (!isPlain(x) || own(x).length !== 1) return null;
        if (Object.hasOwn(x, "labels")) {
          const l = x.labels;
          if (!Array.isArray(l) || l.length > MAX_LABELS || !l.every((n) => Number.isInteger(n))) return null;
          answers.push({ labels: l as number[] });
        } else if (Object.hasOwn(x, "other") && typeof x.other === "string") answers.push({ other: x.other });
        else return null;
      }
      return { action: "answer", answers };
    }
    default:
      return null;
  }
}
