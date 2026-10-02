import { access } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Decision, DecisionView, FloorStatus, Member, MemberState, SessionView, Snapshot } from "../src/shared/types";
import { emptySum } from "../src/shared/tokens";
import type { OfficeConfig } from "./config";
import type { BudgetGate } from "./budget/gate";
import type { BudgetStore } from "./budget/store";
import type { DecisionQueue } from "./decisions/queue";
import { contextInfo } from "./collectors/context";
import { deriveAgent, lastSentence, type Derived } from "./events/derive";
import type { EventStore } from "./events/store";
import { readLimits } from "./collectors/limits";
import { TEAM_REQUEST_TTL, readTeamRequests, type TeamRequest } from "./collectors/teamRequests";
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
  /** 결정 큐(Phase 2). 연결되면 손들기는 큐의 pending만 본다(Ruling B28·B40) — derive의 decision은 쓰지 않는다 */
  decisions?: Pick<DecisionQueue, "list">;
  /** 층 예산(Phase 2 스펙 5장). 빌드마다 사용량을 관문에 넣고 처음 본 세션을 저장소에 알린다 */
  budget?: { gate: Pick<BudgetGate, "setUsage" | "usage" | "view">; store: Pick<BudgetStore, "touch" | "defaultTokens"> };
}

const iso = (ms: number) => new Date(ms).toISOString();

/** 그 구성원의 가장 오래된 pending 결정(list()는 pending을 오래된 것부터 준다) */
function queuedDecision(list: readonly DecisionView[], sessionId: string, agent: string): Decision | undefined {
  const v = list.find((d) => d.state === "pending" && d.sessionId === sessionId && d.agent === agent);
  if (!v) return undefined;
  const summary = v.detail.command ?? v.detail.filePath ?? v.questions?.[0]?.question ?? v.toolName;
  return { kind: v.kind, since: v.createdAt, ...(summary ? { summary } : {}), id: v.id, deadline: v.deadline };
}

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
    // 빌드마다 부른다 — list()가 30초 지난 끝난 결정을 정리한다(Task 3 리뷰 M4)
    const decisions = this.opts.decisions?.list();
    const teamItems: DecisionView[] = [];
    const views = await Promise.all(
      ordered.map(async (s) =>
        this.sessionView(s, await teamFor(s.sessionId), now, s.sessionId === currentId, stale, floorOf.get(s.sessionId) ?? 0, decisions, teamItems),
      ),
    );
    const budget = this.opts.budget;
    if (budget) {
      for (const v of views) budget.gate.setUsage(v.id, v.members.reduce((n, m) => n + m.tokens.total, 0));
      budget.store.touch(views.filter((v) => v.alive).map((v) => v.id), (id) => budget.gate.usage(id));
      for (const v of views) {
        const b = budget.gate.view(v.id);
        if (b) v.budget = b;
      }
    }
    const defaultBudgetTokens = budget?.store.defaultTokens();
    // 팀원 요청(보고서만)도 손을 든 만큼 센다
    const decisionCount = decisions
      ? decisions.filter((d) => d.state === "pending").length + teamItems.length
      : views.reduce((n, v) => n + v.members.filter((m) => m.state === "decision").length, 0);

    return { ...emptySnapshot(now, config), usage: this.usage.summary(now), limits, sessions: views, decisionCount, decisions: [...(decisions ?? []), ...teamItems], ...(defaultBudgetTokens !== undefined ? { defaultBudgetTokens } : {}) };
  }

  private async sessionView(
    s: SessionRecord,
    team: TeamRecord | undefined,
    now: number,
    isCurrent: boolean,
    stale: boolean,
    floor: number,
    decisions?: readonly DecisionView[],
    teamItems: DecisionView[] = [],
  ): Promise<SessionView> {
    const leadFile = this.usage.findFile((p) => basename(p) === `${s.sessionId}.jsonl`);
    const last = leadFile ? this.usage.lastUsage(leadFile) : undefined;
    const status: MemberState = !s.alive ? "offline" : s.status === "busy" ? "working" : "idle";
    const agents = this.opts.events?.agents(s.sessionId);
    // 팀원 "[결정 필요]"(스펙 6장): 리드 대화 기록의 끝부분에서 찾는다. 실패하면 요청 없음
    const teamRequests: TeamRequest[] =
      s.alive && leadFile && (team?.members.length ?? 0) > 0
        ? await readTeamRequests(leadFile, now).catch((e) => (warnCaught("snapshot", "cannot read team requests", e, "transcript"), []))
        : [];
    const derived = (name: string): Derived | undefined => {
      const list = agents?.get(name);
      let d = list ? deriveAgent(list, now) : undefined;
      if (decisions) {
        // 큐가 연결되면 결정은 큐에서만 온다. 진행 중 도구·활동은 이벤트 그대로
        const { decision: _derived, ...rest } = d ?? { toolRunning: false };
        const decision = queuedDecision(decisions, s.sessionId, name);
        d = decision ? { ...rest, decision } : rest;
      }
      if (d?.decision) return d; // 큐(또는 Phase 1 derive)가 먼저
      const req = teamRequests.find((r) => r.from === name);
      if (!req) return d;
      const since = iso(req.at);
      const id = `team:${s.sessionId}:${name}:${req.at}`;
      const deadline = iso(req.at + TEAM_REQUEST_TTL);
      teamItems.push({
        id,
        sessionId: s.sessionId,
        agent: name,
        kind: "team",
        toolName: "SendMessage",
        state: "pending",
        createdAt: since,
        deadline,
        detail: { description: req.summary },
        answerable: false,
      });
      // id가 있어야 책상이 보고서를 여는 버튼이 된다(Ruling B55, 디자인 phase2 §9.2)
      return { ...(d ?? { toolRunning: false }), decision: { kind: "team", since, summary: req.summary, id, deadline } };
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
