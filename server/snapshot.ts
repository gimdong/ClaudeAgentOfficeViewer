import { access } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Member, MemberState, SessionView, Snapshot } from "../src/shared/types";
import { emptySum } from "../src/shared/tokens";
import type { OfficeConfig } from "./config";
import { contextInfo } from "./collectors/context";
import { readLimits } from "./collectors/limits";
import { pidAlive, readSessions, type SessionRecord } from "./collectors/sessions";
import { memberState, readTeams, type TeamRecord } from "./collectors/teams";
import { UsageCollector } from "./collectors/usage";
import { readLastEntry } from "./lib/jsonlTail";

export interface BuilderOptions {
  claudeHome: string;
  config: OfficeConfig;
  isAlive?: (pid: number) => boolean;
}

const iso = (ms: number) => new Date(ms).toISOString();

function emptySnapshot(now: number, config: OfficeConfig, error?: string): Snapshot {
  return {
    generatedAt: iso(now),
    ...(error ? { error } : {}),
    usage: { today: emptySum(), last5h: emptySum(), last7d: emptySum(), byModel: [], hourly: new Array(24).fill(0) },
    budget: config.budget,
    limits: null,
    sessions: [],
  };
}

export class SnapshotBuilder {
  private readonly usage: UsageCollector;
  private prevSessions: SessionRecord[] = [];
  private prevTeams: TeamRecord[] = [];

  constructor(private readonly opts: BuilderOptions) {
    this.usage = new UsageCollector(join(opts.claudeHome, "projects"));
  }

  async build(now = Date.now()): Promise<Snapshot> {
    const { claudeHome, config } = this.opts;
    try {
      await access(claudeHome);
    } catch {
      return emptySnapshot(now, config, `Claude 데이터 폴더를 읽을 수 없습니다: ${claudeHome}`);
    }

    let stale = false;
    const guard = async <T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await fn();
      } catch (e) {
        console.warn(`[snapshot] ${label} 수집 실패, 직전 값을 씁니다: ${(e as Error).message}`);
        stale = true;
        return fallback;
      }
    };

    await guard("usage", () => this.usage.refresh(), undefined);
    const sessions = (this.prevSessions = await guard("sessions", () => readSessions(claudeHome, now, this.opts.isAlive ?? pidAlive), this.prevSessions));
    const teams = (this.prevTeams = await guard("teams", () => readTeams(claudeHome), this.prevTeams));
    // readLimits에 now를 넘겨, 스냅샷이 판단하는 "현재 시각"과 rate limit 창의 만료 판정 기준을 맞춘다
    // (Task 7 fix round 1에서 readLimits가 now를 받아 이미 지난 창을 걸러내도록 바뀌었다).
    const limits = await readLimits(claudeHome, now).catch(() => null);

    const ordered = [...sessions].sort((a, b) => Number(b.alive) - Number(a.alive) || b.updatedAt - a.updatedAt);
    const currentId = ordered.find((s) => s.alive)?.sessionId;
    const views = await Promise.all(
      ordered.map((s) => this.sessionView(s, teams.find((t) => t.leadSessionId === s.sessionId), now, s.sessionId === currentId, stale)),
    );

    return { ...emptySnapshot(now, config), usage: this.usage.summary(now), limits, sessions: views };
  }

  private async sessionView(s: SessionRecord, team: TeamRecord | undefined, now: number, isCurrent: boolean, stale: boolean): Promise<SessionView> {
    const leadFile = this.usage.findFile((p) => basename(p) === `${s.sessionId}.jsonl`);
    const last = leadFile ? this.usage.lastUsage(leadFile) : undefined;
    const status: MemberState = !s.alive ? "offline" : s.status === "busy" ? "working" : "idle";

    const members: Member[] = [
      {
        name: "team-lead",
        role: "lead",
        model: last?.model,
        state: status,
        unread: 0,
        tokens: leadFile ? this.usage.fileTotal(leadFile) : emptySum(),
        lastActivityAt: s.updatedAt ? iso(s.updatedAt) : undefined,
      },
    ];
    for (const m of team?.members ?? []) {
      const mtime = m.transcript ? this.usage.mtime(m.transcript) : undefined;
      const lastEntry = m.transcript ? await readLastEntry(m.transcript).catch(() => undefined) : undefined;
      members.push({
        name: m.name,
        role: m.name,
        model: m.model,
        color: m.color,
        state: memberState({ sessionAlive: s.alive, unread: m.unread, transcriptMtime: mtime, lastEntry, now }),
        unread: m.unread,
        tokens: m.transcript ? this.usage.fileTotal(m.transcript) : emptySum(),
        lastActivityAt: mtime ? iso(mtime) : undefined,
      });
    }

    return {
      id: s.sessionId,
      name: s.name,
      cwd: s.cwd,
      alive: s.alive,
      isCurrent,
      status,
      ...(stale ? { stale: true } : {}),
      context: contextInfo(last, this.opts.config.contextWindows),
      members,
    };
  }
}
