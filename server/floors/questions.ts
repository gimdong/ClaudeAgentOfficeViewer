import { randomBytes } from "node:crypto";
import type { ChatQuestionView } from "../../src/shared/types";
import { detectAsk, tailText } from "../events/askHeuristic";
import { agentOf, type AgentRef } from "../events/summarize";
import { errInfo, getLogger } from "../log";

interface Q extends ChatQuestionView { conv: string; at: number }

/**
 * 대화 질문(Phase 6b 스펙 4장·11장 b c·12장 d e). 책상(주인 이름)마다 하나 — 새 질문이 오면 옛것을 대체한다.
 * - ask_user: 주인은 PreToolUse 짝짓기(B311), 서브에이전트가 부르면 리드 책상, hook 없이 제출만 오면 리드
 * - Stop 대체 경로: 팀리더 본인(sub 아님)의 /hooks/v2 Stop만, 마지막 글은 서버가 아는 그 대화 기록 뒤쪽에서(이벤트 글·경로는 쓰지 않음)
 * - 해제: 팀리더 본인의 UserPromptSubmit·PreToolUse(v2), 또는 대시보드 답이 실제로 보내졌을 때(B308). 휴업 중 답은 "held"로 두고
 *   실제로 보낼 때 지우며, 보관한 답을 지우면 다시 "open"(B309). 메모리에만 — 대시보드를 다시 켜면 사라진다
 * 키는 대화 키(conv, hook의 정규화된 session_id) — 스냅샷이 층의 이벤트를 찾는 키와 같다
 */
export class QuestionBoard {
  private readonly byConv = new Map<string, Map<string, Q>>();
  constructor(private readonly o: { lastText?: (conv: string) => Promise<string | null>; onChange?: () => void; now?: () => number } = {}) {}

  private changed(): void {
    try {
      this.o.onChange?.();
    } catch (e) {
      getLogger().error("questions", "poke failed", { error: errInfo(e) });
    }
  }
  private put(conv: string, q: Omit<Q, "id" | "conv" | "at" | "state">): string {
    const id = `q-${randomBytes(4).toString("hex")}`;
    let desks = this.byConv.get(conv);
    if (!desks) this.byConv.set(conv, (desks = new Map()));
    desks.set(q.owner, { ...q, id, conv, at: (this.o.now ?? Date.now)(), state: "open" });
    this.changed();
    return id;
  }

  /** ask_user 제출. 주인 책상에 붙이고 질문 id를 돌려준다 */
  ask(conv: string, owner: AgentRef, question: string, options: string[]): string {
    const lead = owner.name === "team-lead";
    return this.put(conv, { source: "ask", owner: owner.name, ownerIsLead: lead && !owner.sub, text: question, options });
  }

  /** /hooks/v2 이벤트만 넘긴다(옛 http 입구 이벤트는 해제·판정에 쓰지 않는다, 12장 d) */
  async onEvent(input: Record<string, unknown>): Promise<void> {
    const conv = input.session_id;
    const agent = agentOf(input);
    if (typeof conv !== "string" || !agent || agent.name !== "team-lead" || agent.sub) return;
    const ev = input.hook_event_name;
    if (ev === "UserPromptSubmit" || ev === "PreToolUse") {
      const desks = this.byConv.get(conv);
      let n = 0;
      for (const [k, q] of desks ?? []) if (q.state === "open") desks!.delete(k), n++;
      if (n) this.changed();
      return;
    }
    if (ev !== "Stop" || !this.o.lastText) return;
    const text = await this.o.lastText(conv).catch(() => null);
    if (!text) return;
    const d = detectAsk(text);
    if (d.asks) this.put(conv, { source: "await", owner: "team-lead", ownerIsLead: true, text: tailText(text), options: d.options });
  }

  private find(id: string): Q | undefined {
    for (const desks of this.byConv.values()) for (const q of desks.values()) if (q.id === id) return q;
    return undefined;
  }
  private drop(q: Q): void {
    this.byConv.get(q.conv)?.delete(q.owner);
    this.changed();
  }
  /** 대시보드 답(reply) 결과 */
  onReply(id: string, state: "sent" | "held"): void {
    const q = this.find(id);
    if (!q) return;
    if (state === "sent") return this.drop(q);
    q.state = "held";
    this.changed();
  }
  /** 보관한 지시가 나가거나(sent) 지워졌을 때(ChannelHub) — 답(lead:reply:q-…)만 본다 */
  heldGone(key: string, sent: boolean): void {
    const id = /^lead:reply:(q-[0-9a-f]{8})$/.exec(key)?.[1];
    const q = id ? this.find(id) : undefined;
    if (!q) return;
    if (sent) return this.drop(q);
    q.state = "open";
    this.changed();
  }
  list(conv: string): ChatQuestionView[] {
    return [...(this.byConv.get(conv)?.values() ?? [])].map(({ conv: _c, at, ...v }) => ({ ...v, since: new Date(at).toISOString() }));
  }
}
