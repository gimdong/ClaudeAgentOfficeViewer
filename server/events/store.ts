import { agentOf, summarize, type ToolSummary } from "./summarize";

export interface StoredEvent {
  /** 서버가 받은 시각(ms). hook 입력에는 시각이 없다 */
  at: number;
  event: string;
  sub: boolean;
  /** 합친 서브에이전트의 agent_type */
  subType?: string;
  tool?: string;
  toolUseId?: string;
  summary: ToolSummary;
  /** 암호화 입구(/hooks/v2)로 온 이벤트 — 지시 수신 판정은 이것만 센다(B344, 옛 /hooks/event는 다른 플러그인일 수 있음) */
  v2?: true;
}

export const PER_AGENT = 20;
const DAY = 86_400_000;

interface SessionBucket {
  agents: Map<string, StoredEvent[]>;
  lastAt: number;
  endedAt?: number;
}

/** hook 이벤트의 요약을 세션·에이전트별 원형 버퍼로 보관한다. 메모리에만 둔다(스펙 5장). */
export class EventStore {
  private readonly sessions = new Map<string, SessionBucket>();

  constructor(private readonly perAgent = PER_AGENT) {}

  /** 검증된 hook 입력 하나를 요약해 저장한다. 저장하지 않았으면 false */
  add(input: Record<string, unknown>, now: number, v2 = false): boolean {
    const sessionId = input.session_id;
    const event = input.hook_event_name;
    if (typeof sessionId !== "string" || typeof event !== "string") return false;
    const agent = agentOf(input);
    if (!agent) return false;

    const tool = typeof input.tool_name === "string" && input.tool_name ? input.tool_name : undefined;
    const toolUseId = typeof input.tool_use_id === "string" && input.tool_use_id ? input.tool_use_id : undefined;
    const e: StoredEvent = {
      at: now,
      event,
      sub: agent.sub,
      ...(agent.subType ? { subType: agent.subType } : {}),
      ...(tool ? { tool } : {}),
      ...(toolUseId ? { toolUseId } : {}),
      summary: summarize(tool, input.tool_input),
      ...(v2 ? { v2: true as const } : {}),
    };

    let bucket = this.sessions.get(sessionId);
    if (!bucket) {
      bucket = { agents: new Map(), lastAt: now };
      this.sessions.set(sessionId, bucket);
    }
    bucket.lastAt = now;
    if (event === "SessionEnd") bucket.endedAt = now;
    const list = bucket.agents.get(agent.name) ?? [];
    list.push(e);
    if (list.length > this.perAgent) list.splice(0, list.length - this.perAgent);
    bucket.agents.set(agent.name, list);
    return true;
  }

  agents(sessionId: string): ReadonlyMap<string, readonly StoredEvent[]> {
    return this.sessions.get(sessionId)?.agents ?? new Map();
  }

  /** 세션이 끝난 뒤(끝난 적이 없으면 마지막 이벤트 뒤) 24시간이 지난 세션을 버린다 */
  prune(now: number): void {
    for (const [id, b] of this.sessions) if (now - (b.endedAt ?? b.lastAt) > DAY) this.sessions.delete(id);
  }

  sessionCount(): number {
    return this.sessions.size;
  }
}
