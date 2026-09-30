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
}

interface Raised {
  kind: DecisionKind;
  at: number;
  tool?: string;
  sub: boolean;
  summary?: string;
}

const TURN_END = new Set(["Stop", "SubagentStop", "TeammateIdle", "SessionEnd"]);
const CLOSES_TOOL = new Set(["PostToolUse", "PostToolUseFailure", "PermissionDenied"]);

export function deriveAgent(events: readonly StoredEvent[], now: number): Derived {
  let pending: Pending[] = [];
  let decision: Raised | undefined;
  let todo: { text: string; at: number } | undefined;

  const raise = (e: StoredEvent) => {
    const kind = decisionKindOf(e.tool);
    decision = { kind, at: e.at, tool: e.tool, sub: e.sub, summary: decisionSummary(kind, e) };
  };

  for (const e of events) {
    if (e.event === "PreToolUse") {
      decision = undefined; // 새 도구 호출이 시작되면 앞선 결정은 끝났다
      pending.push({ at: e.at, tool: e.tool, toolUseId: e.toolUseId, sub: e.sub, subType: e.subType, target: targetOf(e.tool, e.summary) });
      if (e.tool === "AskUserQuestion" || e.tool === "ExitPlanMode") raise(e);
      if (e.summary.activeForm !== undefined) todo = e.summary.activeForm === null ? undefined : { text: e.summary.activeForm, at: e.at };
    } else if (CLOSES_TOOL.has(e.event)) {
      const i = e.toolUseId ? pending.findIndex((p) => p.toolUseId === e.toolUseId) : pending.findIndex((p) => !p.toolUseId);
      if (i >= 0) pending.splice(i, 1); // 짝이 없는 Post는 무시한다
      decision = undefined;
    } else if (e.event === "PermissionRequest") {
      // 질문·계획은 PreToolUse에서 이미 올라가 있다. 같은 도구의 권한 요청이 종류를 덮어쓰지 않게 한다(Ruling P6)
      if (!(decision && decision.tool === e.tool)) raise(e);
    } else if (TURN_END.has(e.event)) {
      // 합쳐진 서브에이전트가 끝나면 그 서브에이전트가 연 것만 닫는다(Ruling P3)
      pending = e.sub ? pending.filter((p) => !p.sub) : [];
      if (!e.sub || decision?.sub) decision = undefined;
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
