import { access } from "node:fs/promises";
import { basename, join } from "node:path";
import type { FloorStatus, Member, MemberState, SessionView, Snapshot } from "../src/shared/types";
import { emptySum } from "../src/shared/tokens";
import type { OfficeConfig } from "./config";
import { contextInfo } from "./collectors/context";
import { deriveAgent, lastSentence, type Derived } from "./events/derive";
import type { EventStore } from "./events/store";
import { readLimits } from "./collectors/limits";
import { pidAlive, readSessions, type SessionRecord } from "./collectors/sessions";
import { findTeamNameForSession, memberState, readTeams, withTranscriptsFor, type TeamRecord } from "./collectors/teams";
import { UsageCollector } from "./collectors/usage";
import { errInfo, getLogger, warnCaught } from "./log";
import { readLastEntry } from "./lib/jsonlTail";

export interface BuilderOptions {
  claudeHome: string;
  config: OfficeConfig;
  isAlive?: (pid: number) => boolean;
  /** hook 이벤트 저장소. 없으면 v1과 같이 파일로만 판정한다 */
  events?: Pick<EventStore, "agents" | "prune">;
}

const iso = (ms: number) => new Date(ms).toISOString();

export function emptySnapshot(now: number, config: OfficeConfig, error?: string): Snapshot {
  return {
    generatedAt: iso(now),
    ...(error ? { error } : {}),
    usage: { today: emptySum(), last5h: emptySum(), last7d: emptySum(), byModel: [], hourly: new Array(24).fill(0) },
    budget: config.budget,
    limits: null,
    sessions: [],
    decisionCount: 0,
    decisions: [],
  };
}

/** 이벤트로 유도한 상태를 v1 파일 판정 위에 얹는다(스펙 6장). 결정 > 진행 중 도구 > v1 판정 순 */
function withEvents(m: Member, d: Derived | undefined, alive: boolean, said?: string, saidAt?: string): Member {
  const out: Member = { ...m };
  if (d?.activity) out.activity = d.activity;
  else if (said && saidAt) out.activity = { kind: "said", target: said, startedAt: saidAt };
  if (!alive) return { ...out, state: "offline" };
  if (d?.decision) return { ...out, decision: d.decision, state: "decision" };
  if (d?.toolRunning) return { ...out, state: "working" };
  return out;
}

function floorStatusOf(alive: boolean, members: Member[]): FloorStatus {
  if (!alive) return "ended";
  return members.some((m) => m.state === "working" || m.state === "decision") ? "working" : "idle";
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
        getLogger().warn("snapshot", `${label} collect failed, using previous value`, { error: errInfo(e) });
        stale = true;
        return fallback;
      }
    };

    await guard("usage", () => this.usage.refresh(), undefined);
    const sessions = (this.prevSessions = await guard("sessions", () => readSessions(claudeHome, now, this.opts.isAlive ?? pidAlive), this.prevSessions));
    const teams = (this.prevTeams = await guard("teams", () => readTeams(claudeHome), this.prevTeams));
    // readLimits에 now를 넘겨, 스냅샷이 판단하는 "현재 시각"과 rate limit 창의 만료 판정 기준을 맞춘다
    // (Task 7 fix round 1에서 readLimits가 now를 받아 이미 지난 창을 걸러내도록 바뀌었다).
    const limits = await readLimits(claudeHome, now).catch((e) => (warnCaught("snapshot", "limits collect failed", e), null));
    this.opts.events?.prune(now);

    const byStart = [...sessions].sort((a, b) => a.startedAt - b.startedAt || a.sessionId.localeCompare(b.sessionId));
    const floorOf = new Map(byStart.map((s, i) => [s.sessionId, i + 1]));
    const ordered = [...sessions].sort((a, b) => Number(b.alive) - Number(a.alive) || b.updatedAt - a.updatedAt);
    const currentId = ordered.find((s) => s.alive)?.sessionId;
    const projectsDir = join(claudeHome, "projects");
    const teamFor = async (sessionId: string): Promise<TeamRecord | undefined> => {
      const direct = teams.find((t) => t.leadSessionId === sessionId);
      if (direct) return direct;
      // leadSessionId로 못 찾으면, 이 세션 자신의 subagents meta에 적힌 teamName으로 역으로 찾는다
      // (Ruling P19) — 그 팀의 transcript는 이 세션 폴더 기준으로 다시 찾는다.
      const teamName = await findTeamNameForSession(projectsDir, sessionId, new Set(teams.map((t) => t.name)));
      const byName = teamName ? teams.find((t) => t.name === teamName) : undefined;
      return byName ? withTranscriptsFor(byName, projectsDir, sessionId) : undefined;
    };
    const views = await Promise.all(
      ordered.map(async (s) =>
        this.sessionView(s, await teamFor(s.sessionId), now, s.sessionId === currentId, stale, floorOf.get(s.sessionId) ?? 0),
      ),
    );
    const decisionCount = views.reduce((n, v) => n + v.members.filter((m) => m.state === "decision").length, 0);

    return { ...emptySnapshot(now, config), usage: this.usage.summary(now), limits, sessions: views, decisionCount };
  }

  private async sessionView(
    s: SessionRecord,
    team: TeamRecord | undefined,
    now: number,
    isCurrent: boolean,
    stale: boolean,
    floor: number,
  ): Promise<SessionView> {
    const leadFile = this.usage.findFile((p) => basename(p) === `${s.sessionId}.jsonl`);
    const last = leadFile ? this.usage.lastUsage(leadFile) : undefined;
    const status: MemberState = !s.alive ? "offline" : s.status === "busy" ? "working" : "idle";
    const agents = this.opts.events?.agents(s.sessionId);
    const derived = (name: string) => {
      const list = agents?.get(name);
      return list ? deriveAgent(list, now) : undefined;
    };

    const leadEntry = leadFile ? await readLastEntry(leadFile).catch((e) => void warnCaught("snapshot", "cannot read last entry", e, "transcript")) : undefined;
    const leadAt = s.updatedAt ? iso(s.updatedAt) : undefined;
    const members: Member[] = [
      withEvents(
        {
          name: "team-lead",
          role: "lead",
          model: last?.model,
          state: status,
          unread: 0,
          tokens: leadFile ? this.usage.fileTotal(leadFile) : emptySum(),
          lastActivityAt: leadAt,
        },
        derived("team-lead"),
        s.alive,
        lastSentence(leadEntry),
        leadAt,
      ),
    ];
    for (const m of team?.members ?? []) {
      const mtime = m.transcript ? this.usage.mtime(m.transcript) : undefined;
      const lastEntry = m.transcript ? await readLastEntry(m.transcript).catch((e) => void warnCaught("snapshot", "cannot read last entry", e, "transcript")) : undefined;
      const at = mtime ? iso(mtime) : undefined;
      members.push(
        withEvents(
          {
            name: m.name,
            role: m.name,
            model: m.model,
            color: m.color,
            state: memberState({ sessionAlive: s.alive, unread: m.unread, transcriptMtime: mtime, lastEntry, now }),
            unread: m.unread,
            tokens: m.transcript ? this.usage.fileTotal(m.transcript) : emptySum(),
            lastActivityAt: at,
          },
          derived(m.name),
          s.alive,
          lastSentence(lastEntry),
          at,
        ),
      );
    }

    return {
      id: s.sessionId,
      name: s.name,
      cwd: s.cwd,
      alive: s.alive,
      isCurrent,
      status,
      floor,
      floorStatus: floorStatusOf(s.alive, members),
      ...(s.startedAt ? { startedAt: iso(s.startedAt) } : {}),
      ...(!s.alive && s.updatedAt ? { endedAt: iso(s.updatedAt) } : {}),
      ...(stale ? { stale: true } : {}),
      context: contextInfo(last, this.opts.config.contextWindows),
      members,
    };
  }
}
