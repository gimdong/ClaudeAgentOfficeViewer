import type { SessionRecord } from "../collectors/sessions";
import { getLogger } from "../log";
import type { TerminateError, TerminateResult } from "./control";

/** 끝났는지 보는 간격과 상한(Ruling B201). 넘으면 다시 열지 않는다 — 같은 대화를 두 프로세스가 쓰면 기록이 섞인다 */
export const REOPEN_POLL_MS = 250;
export const REOPEN_WAIT_MS = 15_000;

export type ReopenMode = "subagents" | "team" | undefined;
export type ReopenLaunch = (record: SessionRecord, mode: ReopenMode) => Promise<{ ok: true; tmux: string } | { ok: false; error: "limit" | "tmux" }>;
export type ReopenResult = { ok: true; tmux: string } | { ok: false; error: TerminateError | "busy" | "still-running" | "limit" | "tmux" };

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
      return await this.o.launch(record, mode);
    } finally {
      this.running.delete(id);
    }
  }
}
