import type { Activity, Decision, DecisionKind } from "../../src/shared/types";
import type { StoredEvent } from "./store";
import type { ToolSummary } from "./summarize";

export const TOOL_TTL = 10 * 60_000;
export const DECISION_TTL = 30 * 60_000;

export interface Derived {
  activity?: Activity;
  decision?: Decision;
  /** 이벤트로 확인된 작업 중(짝 없는 PreToolUse가 10분 안에 있음). v1 파일 판정보다 우선한다 */
  toolRunning: boolean;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** 말풍선 「」 안에 들어갈 원문을 도구별로 고른다(디자인 7.2). 모르는 도구는 undefined — UI가 도구 이름을 쓴다 */
export function targetOf(tool: string | undefined, s: ToolSummary): string | undefined {
  switch (tool) {
    case "Bash":
      return s.description ?? s.command;
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
    case "Write":
    case "Read":
      return s.filePath;
    case "Grep":
    case "Glob":
      return s.pattern;
    case "WebSearch":
      return s.query;
    case "WebFetch":
      return s.domain;
    case "SendMessage":
      return s.to;
    case "Agent":
    case "Task":
      return s.description;
    default:
      return undefined;
  }
}

function decisionKindOf(tool: string | undefined): DecisionKind {
  if (tool === "AskUserQuestion") return "question";
  if (tool === "ExitPlanMode") return "plan";
  return "permission";
}

function decisionSummary(kind: DecisionKind, e: StoredEvent): string | undefined {
  if (kind === "question") return e.summary.question;
  if (kind === "permission") return e.summary.command ?? e.summary.filePath ?? e.tool;
  return undefined;
}

interface Pending {
  at: number;
  tool?: string;
  toolUseId?: string;
  sub: boolean;
  subType?: string;
  target?: string;
  /** PermissionRequest가 같은 도구 호출을 찾을 때 대조하는 값(target과 별도로 둔다 — Bash는 target이 description일 수 있다) */
  command?: string;
  filePath?: string;
}

interface Raised {
  kind: DecisionKind;
  at: number;
  tool?: string;
  sub: boolean;
  summary?: string;
  /** 이 결정이 묶인 도구 호출(Pending 객체 참조). 그 호출이 pending 배열에서 사라지면(닫히면) 묶임이 풀린다(Ruling P12) */
  pending?: Pending;
}

const TURN_END = new Set(["Stop", "SubagentStop", "TeammateIdle", "SessionEnd"]);
const CLOSES_TOOL = new Set(["PostToolUse", "PostToolUseFailure", "PermissionDenied"]);

/** e와 같은 tool·sub인 pending 중, summary.command/filePath가 같은 것을 우선해 가장 최근 것을 고른다. 없으면 undefined(묶을 짝 없음) */
function pickPending(pending: readonly Pending[], e: StoredEvent): Pending | undefined {
  const candidates = pending.filter((p) => p.tool === e.tool && p.sub === e.sub);
  if (candidates.length === 0) return undefined;
  const { command, filePath } = e.summary;
  const matching = candidates.filter((p) => (command !== undefined && p.command === command) || (filePath !== undefined && p.filePath === filePath));
  return (matching.length > 0 ? matching : candidates).at(-1);
}

export function deriveAgent(events: readonly StoredEvent[], now: number): Derived {
  let pending: Pending[] = [];
  let decision: Raised | undefined;
  let todo: { text: string; at: number } | undefined;

  // 결정이 묶인 도구 호출이 아직 pending 배열에 있으면(안 닫혔으면) true. 묶을 짝이 없었으면(unbound) false
  const bound = (d: Raised | undefined): boolean => d?.pending !== undefined && pending.includes(d.pending);

  const raise = (e: StoredEvent, boundTo?: Pending) => {
    const kind = decisionKindOf(e.tool);
    decision = { kind, at: e.at, tool: e.tool, sub: e.sub, summary: decisionSummary(kind, e), pending: boundTo ?? pickPending(pending, e) };
  };

  for (const e of events) {
    if (e.event === "PreToolUse") {
      // 새 도구 호출이 시작되면, 어느 진행 중 호출에도 묶이지 않은 결정만 끝난다(Ruling P12)
      if (!bound(decision)) decision = undefined;
      const p: Pending = { at: e.at, tool: e.tool, toolUseId: e.toolUseId, sub: e.sub, subType: e.subType, target: targetOf(e.tool, e.summary), command: e.summary.command, filePath: e.summary.filePath };
      pending.push(p);
      if (e.tool === "AskUserQuestion" || e.tool === "ExitPlanMode") raise(e, p); // 방금 올린 그 호출에 바로 묶는다
      if (e.summary.activeForm !== undefined) todo = e.summary.activeForm === null ? undefined : { text: e.summary.activeForm, at: e.at };
    } else if (CLOSES_TOOL.has(e.event)) {
      const i = e.toolUseId ? pending.findIndex((p) => p.toolUseId === e.toolUseId) : pending.findIndex((p) => !p.toolUseId);
      if (i >= 0) pending.splice(i, 1); // 짝이 없는 Post는 무시한다
      if (!bound(decision)) decision = undefined; // 묶인 호출이 닫혔거나, 애초에 묶이지 않았으면 내린다
    } else if (e.event === "PermissionRequest") {
      // 질문·계획은 PreToolUse에서 이미 올라가 있다. 묶여 있는 question/plan만 건너뛴다(Ruling P13 — P6을 좁힘).
      // permission은 매번 다시 올려 pickPending이 이번 요청에 맞는 호출(보통 방금 연 두 번째 시도)에 새로 묶게 한다.
      const skip = decision !== undefined && bound(decision) && (decision.kind === "question" || decision.kind === "plan");
      if (!skip) raise(e);
    } else if (TURN_END.has(e.event)) {
      // 합쳐진 서브에이전트가 끝나면 그 서브에이전트가 연 것만 닫는다(Ruling P3)
      pending = e.sub ? pending.filter((p) => !p.sub) : [];
      if (!e.sub || decision?.sub) decision = undefined;
    } else if (e.event === "UserPromptSubmit" && !e.sub) {
      // 리드의 새 턴 시작(Ruling P13) — 터미널에서 권한을 거부하면 Post/Failure/Denied/Stop이 전혀 오지 않아
      // 거부된 Pre가 영원히 pending에 남을 수 있다. 사용자가 다음 메시지를 보내면 이전 턴은 끝난 것으로 본다.
      pending = [];
      decision = undefined;
    }
  }

  const live = pending.filter((p) => now - p.at <= TOOL_TTL);
  const cur = live.at(-1);
  const out: Derived = { toolRunning: live.length > 0 };
  if (cur) {
    out.activity = {
      kind: "tool",
      ...(cur.tool ? { tool: cur.tool } : {}),
      ...(cur.target ? { target: cur.target } : {}),
      startedAt: iso(cur.at),
      ...(cur.sub ? { sub: true } : {}),
      ...(cur.sub && cur.subType ? { subType: cur.subType } : {}),
    };
  } else if (todo) {
    out.activity = { kind: "todo", target: todo.text, startedAt: iso(todo.at) };
  }
  if (decision && now - decision.at <= DECISION_TTL) {
    out.decision = { kind: decision.kind, since: iso(decision.at), ...(decision.summary ? { summary: decision.summary } : {}) };
  }
  return out;
}
