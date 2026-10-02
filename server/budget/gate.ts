import type { BudgetView, DecisionView } from "../../src/shared/types";
import { budgetReason, inputHash as hashOf, preToolAsk } from "../decisions/protocol";
import type { BudgetStore } from "./store";

/** PermissionRequest가 관문 호출을 찾을 수 있는 시간(Ruling B48) */
export const CLAIM_MS = 10_000;
/**
 * 관문 기록을 남겨 두는 시간(Ruling B54). claim은 10초 안의 기록만 보지만, 터미널에서 몇 분 뒤 허용해도
 * PostToolUse로 "계속"을 알아봐야 하므로(B35) PermissionRequest timeout(600초)보다 넉넉히 둔다
 */
export const GATE_KEEP_MS = 30 * 60_000;
/** 세션마다 기억하는 관문 호출 수 */
const KEEP_CALLS = 20;
/** 사용자와의 대화이지 실행이 아니므로 관문을 걸지 않는다(Ruling B35) */
const NOT_GATED = new Set(["AskUserQuestion", "ExitPlanMode"]);

/** 관문을 건 PreToolUse 한 건. tool_input 원문은 두지 않고 정규 직렬화의 해시만 둔다 */
interface GateCall {
  toolName: string;
  hash: string;
  promptId?: string;
  toolUseId?: string;
  at: number;
  claimed: boolean;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/**
 * 예산 관문(스펙 5.3 기본 방식, Ruling B39). 사용량이 nextGateAt에 닿은 세션의 다음 PreToolUse에 즉시 ask를 돌려주고,
 * 이어 오는 같은 호출의 PermissionRequest를 budget 결정으로 큐에 넣게 한다(claim).
 * preToolUse·claim은 메모리 값만 보는 동기 함수이고 던지지 않는다(hook을 막지 않는다).
 */
export class BudgetGate {
  private readonly usageBy = new Map<string, number>();
  private readonly calls = new Map<string, GateCall[]>();
  private readonly now: () => number;
  private readonly demote?: (sessionId: string) => void;

  constructor(
    private readonly store: Pick<BudgetStore, "get" | "raise">,
    o: { now?: () => number; demote?: (sessionId: string) => void } = {},
  ) {
    this.now = o.now ?? Date.now;
    this.demote = o.demote;
  }

  /** SnapshotBuilder가 빌드마다 부른다(세션 구성원 tokens.total의 합) */
  setUsage(sessionId: string, usedTokens: number): void {
    this.usageBy.set(sessionId, usedTokens);
  }

  usage(sessionId: string): number {
    return this.usageBy.get(sessionId) ?? 0;
  }

  view(sessionId: string): BudgetView | undefined {
    const e = this.store.get(sessionId);
    if (!e) return undefined;
    const usedTokens = this.usage(sessionId);
    return { ...e, usedTokens, reached: usedTokens >= e.nextGateAt };
  }

  preToolUse(input: Record<string, unknown>): object | null {
    try {
      this.prune();
      const sessionId = str(input.session_id);
      const toolName = str(input.tool_name);
      if (!sessionId || !toolName || NOT_GATED.has(toolName)) return null;
      const e = this.store.get(sessionId);
      if (!e || this.usage(sessionId) < e.nextGateAt) return null;
      const call: GateCall = { toolName, hash: hashOf(input.tool_input), promptId: str(input.prompt_id), toolUseId: str(input.tool_use_id), at: this.now(), claimed: false };
      const list = this.calls.get(sessionId) ?? [];
      list.push(call);
      if (list.length > KEEP_CALLS) list.splice(0, list.length - KEEP_CALLS);
      this.calls.set(sessionId, list);
      return preToolAsk(budgetReason(e.budgetTokens));
    } catch {
      return null;
    }
  }

  /** Ruling B48: 같은 세션·도구·입력 해시(양쪽에 있으면 prompt_id도)의 관문 호출이 10초 안에 있으면 한 번만 값을 준다 */
  claim(input: Record<string, unknown>): { budgetTokens: number; usedTokens: number } | null {
    try {
      this.prune();
      const sessionId = str(input.session_id);
      const list = sessionId ? this.calls.get(sessionId) : undefined;
      const e = sessionId ? this.store.get(sessionId) : undefined;
      if (!sessionId || !list || !e) return null;
      const toolName = str(input.tool_name);
      const promptId = str(input.prompt_id);
      const hash = hashOf(input.tool_input);
      const now = this.now();
      const call = list.find(
        (c) => !c.claimed && now - c.at <= CLAIM_MS && c.toolName === toolName && c.hash === hash && (!c.promptId || !promptId || c.promptId === promptId),
      );
      if (!call) return null;
      call.claimed = true;
      return { budgetTokens: e.budgetTokens, usedTokens: this.usage(sessionId) };
    } catch {
      return null;
    }
  }

  /** 터미널에서 관문 호출을 허용하면(그 tool_use_id로 PostToolUse가 옴) "계속"으로 본다(Ruling B35). 거부·실패는 그대로 */
  onEvent(input: Record<string, unknown>): void {
    try {
      this.prune();
      if (input.hook_event_name !== "PostToolUse") return;
      const sessionId = str(input.session_id);
      const toolUseId = str(input.tool_use_id);
      if (sessionId && toolUseId && this.calls.get(sessionId)?.some((c) => c.toolUseId === toolUseId)) this.continue(sessionId);
    } catch {
      /* hook 처리를 막지 않는다 */
    }
  }

  /** 큐의 onResolve. 대시보드에서 예산 결정에 "계속"을 누르면 올린다. "중단"은 그대로(다음 호출도 다시 묻는다) */
  resolved(v: DecisionView): void {
    if (v.kind === "budget" && v.outcome === "continue") this.continue(v.sessionId);
  }

  /** 모든 세션에서 30분 넘은 기록을 지우고, 비면 세션 키도 지운다(끝난 세션의 기록이 남지 않게) */
  private prune(): void {
    const cutoff = this.now() - GATE_KEEP_MS;
    for (const [id, list] of this.calls) {
      const kept = list.filter((c) => c.at >= cutoff);
      if (kept.length === 0) this.calls.delete(id);
      else if (kept.length !== list.length) this.calls.set(id, kept);
    }
  }

  /** nextGateAt을 올리고, 이 세션의 관문 호출 기록을 비우고(같은 관문을 두 번 올리지 않게), 남은 예산 결정을 permission으로 바꾼다 */
  private continue(sessionId: string): void {
    this.store.raise(sessionId, this.usage(sessionId));
    this.calls.delete(sessionId);
    this.demote?.(sessionId);
  }
}
