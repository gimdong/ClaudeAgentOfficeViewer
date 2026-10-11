import type { ProcStartMatcher, SessionRecord } from "../collectors/sessions";
import { PAUSED_REASON, preToolDeny } from "../decisions/protocol";
import { errInfo, getLogger } from "../log";
import { EXEMPT_TOOLS } from "../policy/tools";

export type TerminateError = "ended" | "self" | "pid-reused" | "unverified";
export type TerminateResult = { ok: true; signal: "SIGTERM" | "SIGKILL"; sent: boolean } | { ok: false; error: TerminateError };
export interface FloorView { paused: boolean; pausedDenied: number; terminating: boolean }
export interface FloorStats { paused: number; hidden: number; terminating: number }
type Sig = "SIGTERM" | "SIGKILL";

/**
 * 층 관리(Phase 4a 스펙 3장): 일시정지·종료 중·숨김. 서버 메모리만(껐다 켜면 모두 영업 중, 숨긴 층도 다시 보인다).
 * 신호는 주입받은 signal로만 보낸다 — 실제 process.kill은 server/index.ts에서만 묶는다(테스트는 가짜만 쓴다).
 * 로그에는 세션 id·도구 이름·신호 이름만 남긴다(tool_input·cwd는 읽지 않는다)
 */
export class FloorControl {
  private readonly paused = new Set<string>();
  private readonly pausedDenied = new Map<string, number>();
  private readonly hidden = new Set<string>();
  private readonly terminating = new Map<string, { sentAt: number; force: boolean }>();
  /** 로그에 쓰는 세션 순번(처음 본 순서, B123 — Phase 2 큐의 sessionNo와 같은 방식). 세션 id는 로그에 남기지 않는다 */
  private readonly sessionNo = new Map<string, number>();
  private readonly signal: (pid: number, sig: Sig) => void;
  private readonly matchProcStart: ProcStartMatcher;
  private readonly selfPid: number;
  private readonly now: () => number;
  private readonly onChange?: () => void;

  constructor(o: { signal: (pid: number, sig: Sig) => void; matchProcStart: ProcStartMatcher; selfPid?: number; now?: () => number; onChange?: () => void }) {
    this.signal = o.signal;
    this.matchProcStart = o.matchProcStart;
    this.selfPid = o.selfPid ?? process.pid;
    this.now = o.now ?? Date.now;
    this.onChange = o.onChange;
  }

  /** 일시정지 deny(스펙 4.2). 판정과 적용을 나누지 않는다 — 관문 맨 앞이라 뒤 관문이 먼저 답할 일이 없다(B116). 던지지 않는다 */
  preToolUse(input: Record<string, unknown>): object | null {
    try {
      if (input.hook_event_name !== "PreToolUse") return null;
      const sessionId = input.session_id;
      const tool = input.tool_name;
      if (typeof sessionId !== "string" || typeof tool !== "string" || !tool) return null;
      if (!this.paused.has(sessionId) || EXEMPT_TOOLS.has(tool)) return null;
      this.pausedDenied.set(sessionId, (this.pausedDenied.get(sessionId) ?? 0) + 1);
      // warn이라 같은 도구의 되풀이 deny는 로거가 10분 동안 한 줄로 묶는다(B125, Phase 3 정책 deny와 같다)
      getLogger().warn("floors", `paused-deny ${tool}`, { session: this.no(sessionId), tool });
      this.changed();
      return preToolDeny(PAUSED_REASON);
    } catch (e) {
      getLogger().error("floors", "pause check failed", { error: errInfo(e) });
      return null;
    }
  }

  pause(sessionId: string): void {
    if (this.paused.has(sessionId)) return;
    this.paused.add(sessionId);
    getLogger().info("floors", "pause", { session: this.no(sessionId) });
    this.changed();
  }

  resume(sessionId: string): void {
    if (!this.paused.delete(sessionId)) return;
    getLogger().info("floors", "resume", { session: this.no(sessionId) });
    this.changed();
  }

  isPaused(sessionId: string): boolean {
    return this.paused.has(sessionId);
  }

  /**
   * 스펙 5.1의 순서: 살아 있음 → 서버 자신 아님 → procStart 일치(확인 불가면 보내지 않는다) → 멱등.
   * 생존 판정은 "살아 있는 쪽"으로 기울지만, 신호는 "보내지 않는 쪽"으로 기운다
   */
  async terminate(record: SessionRecord | undefined, force: boolean): Promise<TerminateResult> {
    if (!record?.alive) return { ok: false, error: "ended" };
    if (record.pid === this.selfPid) return { ok: false, error: "self" };
    // 0·1·음수·소수는 프로세스 그룹·init 등을 가리킨다. 신호도 matcher도 부르지 않는다(B123)
    if (!Number.isInteger(record.pid) || record.pid <= 1) return { ok: false, error: "unverified" };
    let match: boolean | undefined;
    try {
      match = record.procStart ? await this.matchProcStart(record.pid, record.procStart) : undefined;
    } catch {
      match = undefined;
    }
    if (match === false) return { ok: false, error: "pid-reused" };
    if (match !== true) return { ok: false, error: "unverified" };
    const sig: Sig = force ? "SIGKILL" : "SIGTERM";
    const id = record.sessionId;
    if (!force && this.terminating.has(id)) return { ok: true, signal: sig, sent: false };
    try {
      this.signal(record.pid, sig);
    } catch (e) {
      // ESRCH: 그 사이 이미 끝났다. 그 밖(EPERM 등)은 확인하지 못한 것으로 본다. 어느 쪽이든 종료 중으로 두지 않는다
      getLogger().warn("floors", "terminate failed", { session: this.no(id), signal: sig, error: errInfo(e) });
      return { ok: false, error: (e as { code?: string }).code === "ESRCH" ? "ended" : "unverified" };
    }
    this.terminating.set(id, { sentAt: this.now(), force });
    getLogger().info("floors", "terminate", { session: this.no(id), signal: sig });
    this.changed();
    return { ok: true, signal: sig, sent: true };
  }

  hide(sessionId: string): void {
    if (this.hidden.has(sessionId)) return;
    this.hidden.add(sessionId);
    getLogger().info("floors", "hide", { session: this.no(sessionId) });
    this.changed();
  }

  unhideAll(): void {
    if (this.hidden.size === 0) return;
    this.hidden.clear();
    getLogger().info("floors", "unhide");
    this.changed();
  }

  isHidden(sessionId: string): boolean {
    return this.hidden.has(sessionId);
  }

  hiddenCount(): number {
    return this.hidden.size;
  }

  /** 스냅샷 빌드마다(B118): 끝난 세션은 일시정지·횟수·종료 중에서, 목록에 없는 세션은 숨김에서 지우고, 살아 있는 세션은 숨김에서 뺀다 */
  sweep(sessions: readonly SessionRecord[]): void {
    const alive = new Set<string>();
    const listed = new Set<string>();
    for (const s of sessions) {
      listed.add(s.sessionId);
      if (s.alive) alive.add(s.sessionId);
    }
    for (const id of [...this.paused, ...this.pausedDenied.keys(), ...this.terminating.keys()]) {
      if (alive.has(id)) continue;
      this.paused.delete(id);
      this.pausedDenied.delete(id);
      this.terminating.delete(id);
    }
    for (const id of this.hidden) if (!listed.has(id) || alive.has(id)) this.hidden.delete(id);
  }

  view(sessionId: string): FloorView {
    return { paused: this.paused.has(sessionId), pausedDenied: this.pausedDenied.get(sessionId) ?? 0, terminating: this.terminating.has(sessionId) };
  }

  stats(): FloorStats {
    return { paused: this.paused.size, hidden: this.hidden.size, terminating: this.terminating.size };
  }

  private no(sessionId: string): number {
    let n = this.sessionNo.get(sessionId);
    if (n === undefined) this.sessionNo.set(sessionId, (n = this.sessionNo.size + 1));
    return n;
  }

  private changed(): void {
    try {
      this.onChange?.();
    } catch {
      /* 화면 갱신 실패로 hook 응답을 막지 않는다 */
    }
  }
}
