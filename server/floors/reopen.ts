import type { SessionRecord } from "../collectors/sessions";
import { getLogger } from "../log";
import type { TerminateError, TerminateResult } from "./control";

/** 끝났는지 보는 간격과 상한(Ruling B201). 넘으면 다시 열지 않는다 — 같은 대화를 두 프로세스가 쓰면 기록이 섞인다 */
export const REOPEN_POLL_MS = 250;
export const REOPEN_WAIT_MS = 15_000;

export type ReopenMode = "subagents" | "team" | undefined;
export type ReopenLaunch = (record: SessionRecord, mode: ReopenMode) => Promise<{ ok: true; tmux: string } | { ok: false; error: "limit" | "tmux" }>;
/** before: 신호를 보내기 전에 멈춘 실패(세션은 그대로 살아 있다) */
export type ReopenResult = { ok: true; tmux: string } | { ok: false; error: TerminateError | "busy" | "ancestor" | "still-running" | "limit" | "tmux" | "cwd"; before?: true };

/** ppid 사슬의 깊이 상한(B205 ④) */
export const ANCESTOR_DEPTH = 32;

/**
 * start의 조상 pid들(부모부터 1까지, 최대 32개). 중간에 ppid를 읽지 못하면 undefined — 호출자는 "조상일 수 있음"으로 보고
 * 신호를 보내지 않는다(B205 ④). ppidOf는 주입한다(실제 ps는 index.ts에서만)
 */
export function ancestorsOf(start: number, ppidOf: (pid: number) => number | undefined, depth = ANCESTOR_DEPTH): Set<number> | undefined {
  const out = new Set<number>();
  let p = ppidOf(start);
  while (out.size < depth) {
    if (p === undefined || !Number.isInteger(p) || p < 0) return undefined;
    out.add(p);
    if (p <= 1) break;
    p = ppidOf(p);
  }
  return out;
}

/**
 * "작업 지시 켜기(옮겨 열기)": 대시보드가 띄우지 않은 층을 SIGTERM으로 끄고, 그 pid가 끝난 것을 본 뒤에만 같은 대화를
 * channel과 함께 다시 연다(brief 설계 3). 더 센 신호(SIGKILL)는 보내지 않는다. 신호는 4a terminate(검사 포함)만 쓴다
 */
export class Reopener {
  private readonly running = new Set<string>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly o: {
      terminate(record: SessionRecord): Promise<TerminateResult>;
      /** 레코드 pid가 살아 있는지(kill(pid,0)) */
      alive(pid: number): boolean;
      launch: ReopenLaunch;
      /** 대상 pid가 대시보드 서버의 조상인지. true·undefined(확인 불가)면 끄지 않는다 — 끄면 서버도 죽어 다시 열 수 없다(B205 ④) */
      isAncestor?: (pid: number) => boolean | undefined;
      /** 신호 전에 미리 알 수 있는 실패(B212 I1): 원래 폴더 검사·launched 자리 예약. 성공이면 예약을 반납할 함수 */
      precheck?: (record: SessionRecord, mode: ReopenMode) => { ok: true; release(): void } | { ok: false; error: "limit" | "cwd" };
      /** pid 종료를 본 뒤 그 id의 종료 중·멈춤을 지운다(B212 M1) */
      forget?: (sessionId: string) => void;
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  isBusy(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  async reopen(record: SessionRecord, mode: ReopenMode): Promise<ReopenResult> {
    const id = record.sessionId;
    if (this.running.has(id)) return { ok: false, error: "busy" };
    if (this.o.isAncestor && this.o.isAncestor(record.pid) !== false) return { ok: false, error: "ancestor" };
    const pre = this.o.precheck?.(record, mode) ?? { ok: true as const, release: () => {} };
    if (!pre.ok) return { ok: false, error: pre.error, before: true };
    let held = true;
    const release = () => {
      if (held) (held = false), pre.release();
    };
    this.running.add(id);
    try {
      const t = await this.o.terminate(record);
      if (!t.ok) return t;
      const until = this.now() + REOPEN_WAIT_MS;
      while (this.o.alive(record.pid)) {
        if (this.now() >= until) {
          getLogger().warn("floors", "reopen still-running");
          return { ok: false, error: "still-running" };
        }
        await this.sleep(REOPEN_POLL_MS);
      }
      this.o.forget?.(id);
      release(); // 다시 열기가 그 자리에 등록한다
      return await this.o.launch(record, mode);
    } finally {
      release();
      this.running.delete(id);
    }
  }
}
