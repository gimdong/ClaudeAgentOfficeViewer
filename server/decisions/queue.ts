import { randomUUID } from "node:crypto";
import type { DecisionAnswer, DecisionDetail, DecisionKind, DecisionState, DecisionView, QuestionView } from "../../src/shared/types";
import { MAX_FIELD, agentOf, redact, summarize, toGraphemes } from "../events/summarize";
import { getLogger } from "../log";
import { BUDGET_STOP, DENY_DEFAULT, HOLD_MS, PLAN_MAX, REASON_MAX, buildAnswers, permissionResponse } from "./protocol";

/** 붙잡는 결정의 상한. 가짜 hook이 폭주해도 메모리와 화면이 버티게 한다(Review Focus 1) */
export const MAX_PENDING = 50;
/** 끝난 결정을 화면 목록에 남기는 시간(결과 한 줄을 보여 줄 수 있게) */
export const RESOLVED_KEEP_MS = 30_000;

export interface HeldResponse {
  writableEnded: boolean;
  on(event: "close", fn: () => void): unknown;
  status(code: number): { json(body: unknown): unknown; end(): unknown };
}
export type AnswerResult = { ok: true; state: DecisionState } | { ok: false; status: 400 | 404 | 409; state?: DecisionState };
export interface DecisionStats { byKind: Record<string, number>; byState: Record<DecisionState, number> }

interface Entry {
  view: DecisionView;
  /** 원래 tool_input. 질문 답(updatedInput)을 만들 때만 쓰고, 끝나면 버린다. 화면·로그로 나가지 않는다 */
  raw?: unknown;
  res?: HeldResponse;
  timer?: NodeJS.Timeout;
  startedAt: number;
  resolvedMs?: number;
}

const cut = (s: unknown, max = MAX_FIELD): string | undefined => (typeof s === "string" ? toGraphemes(redact(s)).slice(0, max).join("") : undefined);

function detailOf(tool: string, input: unknown): DecisionDetail {
  const { activeForm: _a, question: _q, ...detail } = summarize(tool, input);
  return detail;
}

function questionsOf(input: unknown): QuestionView[] {
  const qs = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(qs)) return [];
  return qs.map((q: { question?: unknown; header?: unknown; multiSelect?: unknown; options?: unknown } | null) => ({
    question: cut(q?.question) ?? "",
    ...(typeof q?.header === "string" ? { header: cut(q.header) } : {}),
    multiSelect: q?.multiSelect === true,
    options: (Array.isArray(q?.options) ? q.options : []).map((o: { label?: unknown; description?: unknown } | null) => ({
      label: cut(o?.label) ?? "",
      ...(typeof o?.description === "string" ? { description: cut(o.description) } : {}),
    })),
  }));
}

function planOf(input: unknown): Pick<DecisionView, "plan" | "planTruncated"> {
  const plan = (input as { plan?: unknown } | null)?.plan;
  if (typeof plan !== "string") return {};
  const g = toGraphemes(redact(plan));
  return g.length > PLAN_MAX ? { plan: g.slice(0, PLAN_MAX).join(""), planTruncated: true } : { plan: g.join("") };
}

/** 대시보드 답을 hook 응답 본문과 outcome으로 바꾼다. 종류에 맞지 않거나 형식이 틀리면 null(→ 400) */
function responseFor(e: Entry, a: DecisionAnswer): { body: object; outcome: string } | null {
  if (!a || typeof a !== "object") return null;
  const kind = e.view.kind;
  if (kind === "permission") {
    if (a.action === "allow") return { body: permissionResponse("allow"), outcome: "allow" };
    if (a.action === "deny") {
      const reason = (a as { reason?: unknown }).reason;
      if (reason !== undefined && typeof reason !== "string") return null;
      if (reason && toGraphemes(reason).length > REASON_MAX) return null;
      return { body: permissionResponse("deny", { message: reason?.trim() || DENY_DEFAULT }), outcome: "deny" };
    }
  } else if (kind === "question" && a.action === "answer") {
    const answers = buildAnswers(e.raw, a.answers);
    if (!answers) return null;
    return { body: permissionResponse("allow", { updatedInput: { ...(e.raw as Record<string, unknown>), answers } }), outcome: "answer" };
  } else if (kind === "budget") {
    if (a.action === "continue") return { body: permissionResponse("allow"), outcome: "continue" };
    if (a.action === "stop") return { body: permissionResponse("deny", { message: BUDGET_STOP }), outcome: "stop" };
  }
  return null; // plan(보고서만, Ruling B40)과 그 밖의 조합
}

/**
 * PermissionRequest hook의 응답을 붙잡아 두고 대시보드의 답을 기다린다(스펙 3.2).
 * pending → answered-dashboard(대시보드 답) | closed-terminal(연결 끊김: 터미널 선답·Claude Code timeout) | expired(590초, 빈 200).
 * 서버를 다시 시작하면 붙잡던 결정은 사라지고 Claude Code 쪽 연결도 끊겨 터미널 창이 남는다.
 */
export class DecisionQueue {
  private readonly entries = new Map<string, Entry>();
  private readonly sessionNo = new Map<string, number>();
  private readonly byKind: Record<string, number> = {};
  private readonly byState: Record<Exclude<DecisionState, "pending">, number> = { "answered-dashboard": 0, "closed-terminal": 0, expired: 0 };
  private readonly now: () => number;
  private readonly holdMs: number;

  constructor(private readonly opts: { now?: () => number; holdMs?: number; onChange?: () => void; onResolve?: (v: DecisionView) => void } = {}) {
    this.now = opts.now ?? Date.now;
    this.holdMs = opts.holdMs ?? HOLD_MS;
  }

  /** PermissionRequest 입력과 그 응답을 붙잡는다. 상한을 넘으면 빈 200으로 놓아주고 null */
  hold(input: Record<string, unknown>, res: HeldResponse, o: { kind?: "budget"; budget?: { budgetTokens: number; usedTokens: number } } = {}): DecisionView | null {
    if (this.pendingCount() >= MAX_PENDING) {
      res.status(200).end();
      return null;
    }
    const tool = typeof input.tool_name === "string" ? input.tool_name : "";
    const sessionId = String(input.session_id);
    const kind: DecisionKind = tool === "AskUserQuestion" ? "question" : tool === "ExitPlanMode" ? "plan" : o.kind === "budget" ? "budget" : "permission";
    const t = this.now();
    const view: DecisionView = {
      id: randomUUID(),
      sessionId,
      agent: agentOf(input)?.name ?? "team-lead",
      kind,
      toolName: tool,
      state: "pending",
      createdAt: new Date(t).toISOString(),
      deadline: new Date(t + this.holdMs).toISOString(),
      detail: detailOf(tool, input.tool_input),
      ...(kind === "question" ? { questions: questionsOf(input.tool_input) } : {}),
      ...(kind === "plan" ? planOf(input.tool_input) : {}),
      ...(kind === "budget" && o.budget ? { budget: { ...o.budget } } : {}),
      answerable: kind !== "plan", // Ruling B40: 계획은 보고서만
    };
    if (!this.sessionNo.has(sessionId)) this.sessionNo.set(sessionId, this.sessionNo.size + 1);
    this.byKind[kind] = (this.byKind[kind] ?? 0) + 1;

    const e: Entry = { view, raw: input.tool_input, res, startedAt: t };
    e.timer = setTimeout(() => {
      this.resolve(e, "expired");
      try {
        res.status(200).end();
      } catch {
        /* 이미 끊긴 연결 */
      }
    }, this.holdMs);
    // req의 close는 본문을 다 읽으면 항상 오므로 res의 close + writableEnded로 판정한다(Phase 0 T0.3)
    res.on("close", () => {
      if (!res.writableEnded) this.resolve(e, "closed-terminal");
    });
    this.entries.set(view.id, e);
    this.opts.onChange?.();
    return { ...view };
  }

  answer(id: string, a: DecisionAnswer): AnswerResult {
    const e = this.entries.get(id);
    if (!e) return { ok: false, status: 404 };
    if (e.view.state !== "pending") return { ok: false, status: 409, state: e.view.state };
    const r = responseFor(e, a);
    if (!r) return { ok: false, status: 400 };
    const res = e.res;
    e.view.outcome = r.outcome;
    this.resolve(e, "answered-dashboard");
    try {
      res?.status(200).json(r.body);
    } catch {
      /* 쓰는 순간 끊긴 연결. 터미널 창이 결정한다 */
    }
    return { ok: true, state: "answered-dashboard" };
  }

  /** 같은 세션의 pending budget 결정을 permission으로 바꾼다(Ruling B35) */
  demoteBudget(sessionId: string): void {
    let changed = false;
    for (const e of this.entries.values()) {
      if (e.view.sessionId !== sessionId || e.view.kind !== "budget" || e.view.state !== "pending") continue;
      e.view.kind = "permission";
      delete e.view.budget;
      changed = true;
    }
    if (changed) this.opts.onChange?.();
  }

  /** pending(오래된 것부터) + 최근 30초 안에 끝난 것 */
  list(): DecisionView[] {
    const now = this.now();
    const pending: Entry[] = [];
    const done: Entry[] = [];
    for (const [id, e] of this.entries) {
      if (e.view.state === "pending") pending.push(e);
      else if (now - e.resolvedMs! > RESOLVED_KEEP_MS) this.entries.delete(id);
      else done.push(e);
    }
    const order = (a: Entry, b: Entry) => a.startedAt - b.startedAt;
    return [...pending.sort(order), ...done.sort((a, b) => a.resolvedMs! - b.resolvedMs!)].map((e) => ({ ...e.view }));
  }

  stats(): DecisionStats {
    return { byKind: { ...this.byKind }, byState: { pending: this.pendingCount(), ...this.byState } };
  }

  /** 테스트용: 원래 입력을 아직 들고 있는 결정 수 */
  rawCount(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.raw !== undefined) n++;
    return n;
  }

  stop(): void {
    for (const e of this.entries.values()) clearTimeout(e.timer);
  }

  private pendingCount(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.view.state === "pending") n++;
    return n;
  }

  private resolve(e: Entry, state: Exclude<DecisionState, "pending">): void {
    if (e.view.state !== "pending") return;
    const t = this.now();
    clearTimeout(e.timer);
    e.view.state = state;
    e.view.resolvedAt = new Date(t).toISOString();
    e.resolvedMs = t;
    e.raw = undefined;
    e.res = undefined;
    this.byState[state]++;
    // 도구 입력·이유·답·세션 id는 남기지 않는다(스펙 8장). 세션은 큐 안의 순번
    getLogger().info("decisions", "resolved", { kind: e.view.kind, state, ms: t - e.startedAt, session: this.sessionNo.get(e.view.sessionId) });
    this.opts.onChange?.();
    this.opts.onResolve?.({ ...e.view });
  }
}
