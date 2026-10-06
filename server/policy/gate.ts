import type { PolicyGroup, PolicyValue } from "../../src/shared/types";
import { CLAIM_MS } from "../budget/gate";
import { inputHash, policyAskReason, policyDenyReason, preToolAsk, preToolDeny } from "../decisions/protocol";
import { agentOf, toGraphemes } from "../events/summarize";
import { errInfo, getLogger } from "../log";
import { MAX_NAME, isTargetKey, type PolicyStore, type TargetKind } from "./store";
import { groupOf, ruleLabel } from "./tools";

/** "방금 막힘"을 화면에 싣는 시간(Ruling B85) */
export const POLICY_DENIED_SHOW_MS = 30_000;
/** 횟수 표·방금 막힘·ask 기록을 든 세션의 상한(Review Focus 4). 넘으면 가장 오래 안 쓰인 것부터 버린다 */
export const MAX_COUNT_KEYS = 500;
/** 세션마다 기억하는 정책 ask 호출 수 */
const KEEP_CALLS = 20;

/** 정책 대상(key)과 이유 문구에 쓸 화면 이름(who). name은 agentOf의 캐릭터 이름(서브에이전트는 "team-lead") */
export interface AgentKey { key: string; kind: TargetKind; who: string; name: string; subType?: string }
export interface PolicyVerdict { decision: PolicyValue; respond(): object }
export interface PolicyTotals { deny: number; ask: number }

/** ask를 돌려준 호출. tool_input 원문은 두지 않고 정규 직렬화의 해시만 둔다(B48과 같은 방식) */
interface AskCall { agentKey: string; toolName: string; hash: string; promptId?: string; at: number; claimed: boolean }

const cutName = (s: string) => toGraphemes(s).slice(0, MAX_NAME).join("");
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** hook 입력의 정책 대상(Ruling B75). 리드는 agent_id가 없는 입력으로만 가른다 — 이름이 "team-lead"인 팀원은 agent:team-lead */
export function agentKeyOf(input: Record<string, unknown>): AgentKey | null {
  const ref = agentOf(input);
  if (!ref) return null;
  if (ref.sub) {
    const key = ref.subType ? `sub:${ref.subType}` : "others";
    const ok = !!ref.subType && isTargetKey(key);
    return { key: ok ? key : "others", kind: ok ? "sub" : "others", who: ref.subType ? `서브에이전트(${cutName(ref.subType)})` : "서브에이전트", name: ref.name, ...(ref.subType ? { subType: ref.subType } : {}) };
  }
  if (!str(input.agent_id)) return { key: "lead", kind: "lead", who: "리드", name: ref.name };
  return { key: memberKeyOf(ref.name, false), kind: isTargetKey(`agent:${ref.name}`) ? "agent" : "others", who: cutName(ref.name), name: ref.name };
}

/** 화면 구성원의 대상 키. agentKeyOf와 같은 규칙이다: 리드는 "lead", 이름이 대상 이름 규칙에 맞으면 "agent:<이름>", 아니면 "others" */
export function memberKeyOf(name: string, isLead: boolean): string {
  if (isLead) return "lead";
  const key = `agent:${name}`;
  return isTargetKey(key) ? key : "others";
}

/** Map을 LRU로 쓴다: 다시 넣을 때 맨 뒤로 옮기고, 넘치면 맨 앞(가장 오래 안 쓰인 것)부터 버린다 */
function touch<K, V>(m: Map<K, V>, k: K, v: V, max: number): void {
  m.delete(k);
  m.set(k, v);
  while (m.size > max) m.delete(m.keys().next().value as K);
}

/**
 * 권한 정책 관문(스펙 4.2·6장). preToolUse는 메모리의 표만 보고 판정하며 부작용이 없다(Ruling B78) —
 * 횟수·로그·ask 짝 찾기 기록·방금 막힘은 respond()를 부를 때만 남긴다. 판정은 tool_input을 읽지 않는다(D3).
 * 어느 메서드도 던지지 않는다(hook을 막지 않는다)
 */
export class PolicyGate {
  private readonly countBy = new Map<string, { denied: number; asked: number }>();
  private readonly lastDeny = new Map<string, { group: PolicyGroup; at: number; subType?: string }>();
  private readonly asks = new Map<string, AskCall[]>();
  private readonly total: PolicyTotals = { deny: 0, ask: 0 };
  private readonly now: () => number;
  private readonly onChange?: () => void;

  constructor(
    private readonly store: Pick<PolicyStore, "resolve">,
    o: { now?: () => number; onChange?: () => void } = {},
  ) {
    this.now = o.now ?? Date.now;
    this.onChange = o.onChange;
  }

  preToolUse(input: Record<string, unknown>): PolicyVerdict | null {
    try {
      const tool = input.tool_name;
      const sessionId = input.session_id;
      if (typeof tool !== "string" || !tool || typeof sessionId !== "string") return null;
      const group = groupOf(tool);
      if (!group) return null;
      const a = agentKeyOf(input);
      if (!a) return null;
      const r = this.store.resolve(a.key);
      const decision = r?.rules[group] ?? r?.rules.all;
      if (!r || !decision) return null;
      // 이유 문구에는 "걸린 규칙"의 묶음을 쓴다(Ruling B90): all 규칙으로 막혔는데 "명령 실행 금지"라고 하면
      // Claude가 다른 도구를 차례로 시도하며 계속 막힌다. 로그·횟수·말풍선은 도구의 묶음(group) 그대로
      const ruleGroup: PolicyGroup = r.rules[group] ? group : "all";
      const logKind: TargetKind = r.source === "others" ? "others" : a.kind;
      return { decision, respond: () => this.apply(decision, group, ruleGroup, a, logKind, sessionId, tool, input) };
    } catch (e) {
      getLogger().error("policy", "check failed", { error: errInfo(e) });
      return null;
    }
  }

  /** Ruling B48 + B94: 같은 에이전트·세션·도구 이름·입력 해시(양쪽에 있으면 prompt_id도)의 ask가 10초 안에 있으면 한 번만 true */
  claim(input: Record<string, unknown>): boolean {
    try {
      const sessionId = str(input.session_id);
      const list = sessionId ? this.asks.get(sessionId) : undefined;
      if (!sessionId || !list) return false;
      const agentKey = agentKeyOf(input)?.key;
      const toolName = str(input.tool_name);
      const promptId = str(input.prompt_id);
      const hash = inputHash(input.tool_input);
      const now = this.now();
      const call = list.find(
        (c) => !c.claimed && now - c.at <= CLAIM_MS && c.agentKey === agentKey && c.toolName === toolName && c.hash === hash && (!c.promptId || !promptId || c.promptId === promptId),
      );
      if (!call) return false;
      call.claimed = true;
      return true;
    } catch {
      return false;
    }
  }

  countsOf(agentKey: string): { denied: number; asked: number } {
    return { ...(this.countBy.get(agentKey) ?? { denied: 0, asked: 0 }) };
  }

  counts(): Record<string, { denied: number; asked: number }> {
    const out = Object.create(null) as Record<string, { denied: number; asked: number }>;
    for (const [k, v] of this.countBy) out[k] = { ...v };
    return out;
  }

  lastDenied(sessionId: string, agentName: string): { group: PolicyGroup; at: number; subType?: string } | undefined {
    const d = this.lastDeny.get(`${sessionId}\u0000${agentName}`);
    return d && this.now() - d.at < POLICY_DENIED_SHOW_MS ? { ...d } : undefined;
  }

  totals(): PolicyTotals {
    return { ...this.total };
  }

  /** ask 짝 찾기 기록을 든 세션 수(상한 확인용) */
  pendingSessions(): number {
    this.pruneAsks();
    return this.asks.size;
  }

  private apply(decision: PolicyValue, group: PolicyGroup, ruleGroup: PolicyGroup, a: AgentKey, logKind: TargetKind, sessionId: string, tool: string, input: Record<string, unknown>): object {
    const c = this.countBy.get(a.key) ?? { denied: 0, asked: 0 };
    if (decision === "deny") c.denied++;
    else c.asked++;
    touch(this.countBy, a.key, c, MAX_COUNT_KEYS);
    this.total[decision]++;
    // 로그에는 대상 이름을 적지 않는다(스펙 9장, Ruling B81). deny는 warn이라 같은 종류·묶음이 10분 동안 한 줄로 묶인다
    const data = { outcome: decision, group, target: logKind };
    let out: object;
    if (decision === "deny") {
      getLogger().warn("policy", `deny ${group} ${logKind}`, data);
      const now = this.now();
      for (const [k, d] of this.lastDeny) if (now - d.at >= POLICY_DENIED_SHOW_MS) this.lastDeny.delete(k);
      touch(this.lastDeny, `${sessionId}\u0000${a.name}`, { group, at: now, ...(a.subType ? { subType: a.subType } : {}) }, MAX_COUNT_KEYS);
      out = preToolDeny(policyDenyReason(a.who, ruleLabel(ruleGroup, "deny")));
    } else {
      getLogger().info("policy", `ask ${group} ${logKind}`, data);
      this.remember(sessionId, a.key, tool, input);
      out = preToolAsk(policyAskReason(a.who, ruleLabel(ruleGroup, "ask")));
    }
    try {
      this.onChange?.();
    } catch {
      /* 화면 갱신 실패로 hook 응답을 막지 않는다 */
    }
    return out;
  }

  /** inputHash는 ask를 적용할 때만 부른다. 해시를 못 만들면 기록 없이 넘어간다 */
  private remember(sessionId: string, agentKey: string, toolName: string, input: Record<string, unknown>): void {
    let hash: string;
    try {
      hash = inputHash(input.tool_input);
    } catch {
      return;
    }
    this.pruneAsks();
    const list = this.asks.get(sessionId) ?? [];
    list.push({ agentKey, toolName, hash, promptId: str(input.prompt_id), at: this.now(), claimed: false });
    if (list.length > KEEP_CALLS) list.splice(0, list.length - KEEP_CALLS);
    touch(this.asks, sessionId, list, MAX_COUNT_KEYS);
  }

  /** 10초 지난 기록과 빈 세션을 지운다 */
  private pruneAsks(): void {
    const cutoff = this.now() - CLAIM_MS;
    for (const [id, list] of this.asks) {
      const kept = list.filter((c) => c.at >= cutoff);
      if (kept.length === 0) this.asks.delete(id);
      else if (kept.length !== list.length) this.asks.set(id, kept);
    }
  }
}
