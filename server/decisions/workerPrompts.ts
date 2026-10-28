/**
 * 팀원 권한 질문 표시(안 A, spike 2026-10-27 · 회사 PC 실측 2026-10-28).
 * agent team 팀원의 권한 질문은 리드 터미널 대화상자로 바로 가고 PermissionRequest hook을 거치지 않는다.
 * 대신 리드 세션이 Notification(notification_type "worker_permission_prompt", message "<팀원> needs permission for <도구>")을 보낸다.
 * 이것으로 손만 든다(답은 리드 터미널에서 — 대시보드는 그 대화상자에 끼어들 수 없다). /hooks/v2로 온 것만 받는다(B344와 같은 규칙).
 * message는 문서에 없는 내부 글이라 형식이 바뀌면 이름 없이(리드 책상에) 표시한다. 메모리에만 둔다
 */
export const WORKER_PROMPT_TTL = 10 * 60_000;

export interface WorkerPrompt {
  /** 글에서 꺼낸 팀원 이름. 형식을 모르면 없음 */
  name?: string;
  /** 도구 이름, 네트워크 질문은 "network", 모르면 "?" */
  tool: string;
  /** 네트워크 질문의 호스트 */
  target?: string;
  at: number;
}

const PERMISSION = /^(\S.{0,63}?) needs permission for (\S{1,40})$/;
const NETWORK = /^(\S.{0,63}?) needs network access to (\S{1,253})$/;

export function parseWorkerPrompt(message: unknown): Omit<WorkerPrompt, "at"> {
  if (typeof message !== "string") return { tool: "?" };
  const p = PERMISSION.exec(message);
  if (p) return { name: p[1], tool: p[2] };
  const n = NETWORK.exec(message);
  if (n) return { name: n[1], tool: "network", target: n[2] };
  return { tool: "?" };
}

export class WorkerPrompts {
  private readonly byConv = new Map<string, WorkerPrompt[]>();

  /** conv: 리드 대화 키(hook의 session_id를 대화 키로 바꾼 값) */
  note(conv: string, message: unknown, at: number): void {
    const p = { ...parseWorkerPrompt(message), at };
    // 같은 팀원(이름 모름끼리도)의 새 질문이 옛것을 대체한다 — 한 팀원은 한 번에 하나만 묻는다
    const list = (this.byConv.get(conv) ?? []).filter((x) => x.name !== p.name);
    list.push(p);
    this.byConv.set(conv, list);
  }

  /** 아직 손을 들고 있는 것. 시간이 지났거나 알림 뒤 그 팀원의 이벤트가 왔으면(답을 받아 다시 일함) 지운다 */
  open(conv: string, now: number, events: ReadonlyMap<string, readonly { at: number }[]>): WorkerPrompt[] {
    const list = this.byConv.get(conv);
    if (!list) return [];
    const keep = list.filter((p) => now - p.at <= WORKER_PROMPT_TTL && !(p.name && events.get(p.name)?.some((e) => e.at > p.at)));
    if (keep.length) this.byConv.set(conv, keep);
    else this.byConv.delete(conv);
    return keep;
  }
}
