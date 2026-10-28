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

/** 도구 이름은 mcp__<서버>__<도구>처럼 길 수 있다(리뷰 #2-4) */
const PERMISSION = /^(\S.{0,63}?) needs permission for (\S{1,128})$/;
const NETWORK = /^(\S.{0,63}?) needs network access to (\S{1,253})$/;

export function parseWorkerPrompt(message: unknown): Omit<WorkerPrompt, "at"> {
  if (typeof message !== "string") return { tool: "?" };
  const p = PERMISSION.exec(message);
  if (p) return { name: p[1], tool: p[2] };
  const n = NETWORK.exec(message);
  if (n) return { name: n[1], tool: "network", target: n[2] };
  return { tool: "?" };
}

/** 그 도구 호출이 끝남 */
const DONE: ReadonlySet<string> = new Set(["PostToolUse", "PostToolUseFailure", "PermissionDenied"]);
/** 다음 일로 넘어감 */
const RESUME: ReadonlySet<string> = new Set(["PreToolUse", "Stop", "TeammateIdle"]);

/** ponytail: byConv는 open()이 불리는 살아 있는 층에서만 정리된다 — 끝난 층에는 대화당 팀원 수만큼 남는다(리뷰 #2-7). 늘면 prune을 스냅샷 sweep에 붙인다 */
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

  /**
   * 아직 손을 들고 있는 것. 시간이 지났거나, 알림 뒤 그 팀원이 다시 일한 흔적이 오면 지운다: 그 도구의 Post·Failure·PermissionDenied,
   * 새 PreToolUse·Stop·TeammateIdle. 같은 메시지에서 병렬로 돌던 다른 도구의 Post는 세지 않는다(리뷰 #2-3). 같은 호출의 PreToolUse는 hook이 동기라 알림보다 먼저 저장된다.
   * ponytail: 이벤트는 리드 대화 키로 쌓인 것만 본다 — in-process 팀원만 여기로 오고, 별도 프로세스(tmux) 팀원의 hook은 자기 세션으로 와서 시간(TTL)으로만 내린다(리뷰 #2-2).
   * 그 팀원의 세션 id를 알게 되면(회사 진단 파일) 층 안 이름으로 세션을 넘어 짝짓는다
   */
  open(conv: string, now: number, events: ReadonlyMap<string, readonly { at: number; event: string; tool?: string }[]>): WorkerPrompt[] {
    const list = this.byConv.get(conv);
    if (!list) return [];
    const resumed = (p: WorkerPrompt, e: { at: number; event: string; tool?: string }) =>
      e.at > p.at && (RESUME.has(e.event) || (DONE.has(e.event) && (e.tool === p.tool || p.tool === "network" || p.tool === "?")));
    const keep = list.filter((p) => now - p.at <= WORKER_PROMPT_TTL && !(p.name && events.get(p.name)?.some((e) => resumed(p, e))));
    if (keep.length) this.byConv.set(conv, keep);
    else this.byConv.delete(conv);
    return keep;
  }
}
