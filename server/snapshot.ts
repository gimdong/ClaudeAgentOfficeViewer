import { access } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Decision, DecisionView, FloorStatus, Member, MemberState, SessionView, Snapshot, SubagentDesk } from "../src/shared/types";
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
import { defaultProcStartMatcher, pidAlive, readSessions, type ProcStartMatcher, type SessionRecord } from "./collectors/sessions";
import { readSubagents, type SubagentTracker } from "./collectors/subagents";
import { findTeamNameForSession, memberState, readTeams, withTranscriptsFor, type TeamRecord } from "./collectors/teams";
import { UsageCollector } from "./collectors/usage";
import { errInfo, getLogger, warnCaught } from "./log";
import { readLastEntry } from "./lib/jsonlTail";
import { POLICY_DENIED_SHOW_MS, memberKeyOf, type PolicyGate } from "./policy/gate";
import type { PolicyStore } from "./policy/store";
import type { FloorControl } from "./floors/control";
import type { ChannelHub } from "./floors/channels";

export interface BuilderOptions {
  claudeHome: string;
  config: OfficeConfig;
  isAlive?: (pid: number) => boolean;
  /** pid 재사용 확인(Phase 4a B128). 테스트는 가짜를 넣는다. 기본은 실제 ps */
  matchProcStart?: ProcStartMatcher;
  /** hook 이벤트 저장소. 없으면 v1과 같이 파일로만 판정한다 */
  events?: Pick<EventStore, "agents" | "prune">;
  /** 결정 큐(Phase 2). 연결되면 손들기는 큐의 pending만 본다(Ruling B28·B40) — derive의 decision은 쓰지 않는다 */
  decisions?: Pick<DecisionQueue, "list">;
  /** 층 예산(Phase 2 스펙 5장). 빌드마다 사용량을 관문에 넣고 처음 본 세션을 저장소에 알린다 */
  budget?: { gate: Pick<BudgetGate, "setUsage" | "usage" | "view">; store: Pick<BudgetStore, "touch" | "defaultTokens"> };
  /** 서버 버전(package.json). 스냅샷에 실어 화면이 자기 버전과 비교한다(FB-7) */
  version?: string;
  /** 권한 정책(Phase 3 스펙 7.4). 구성원마다 걸린 규칙·횟수·방금 막힘을 싣고, 스냅샷에 정책 전체를 싣는다(Ruling B77) */
  /** 층 관리(Phase 4a): 일시정지·종료 중·숨김. 빌드마다 sweep으로 끝난 세션을 정리한다 */
  floors?: Pick<FloorControl, "sweep" | "view" | "isHidden" | "hiddenCount">;
  /** Phase 4b: 대시보드가 띄운 층의 channel 상태와 실험 기능 스위치 */
  channels?: Pick<ChannelHub, "view" | "enabled" | "available" | "sweep">;
  policy?: { store: Pick<PolicyStore, "resolve" | "all" | "unreadable">; gate: Pick<PolicyGate, "countsOf" | "counts" | "lastDenied"> };
  /** 마지막 hook이 보낸 플러그인 버전(Phase 5 §3). null이면 아직 받지 않음 */
  plugin?: () => string | null;
  /** 옛 http 입구로 온 세션이 남아 있는지(Phase 6a §4) */
  pluginLegacy?: () => boolean;
  /** 작업 지시 켜기(B205 ④): 대상 pid가 대시보드 서버의 조상인지(확인 불가 = undefined) */
  reopen?: { isAncestor(pid: number): boolean | undefined; busy?(sessionId: string): boolean };
  /** 서브에이전트 시작·끝 기록기(B171). 없으면 대화 기록 mtime만으로 판정한다 */
  subagents?: SubagentTracker;
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
    hiddenFloors: 0,
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

/** 구성원에 정책 필드를 얹는다. 키는 hook 쪽과 같은 memberKeyOf로 만든다(Task 4) */
function policyFields(
  m: Member,
  p: NonNullable<BuilderOptions["policy"]>,
  sessionId: string,
  now: number,
  leadEvents?: ReadonlyMap<string, readonly { subType?: string }[]>,
): Member {
  const key = memberKeyOf(m.name, m.role === "lead");
  const r = p.store.resolve(key);
  const d = p.gate.lastDenied(sessionId, m.name);
  const subTypes = leadEvents ? [...new Set((leadEvents.get("team-lead") ?? []).flatMap((e) => (e.subType ? [e.subType] : [])))].sort() : [];
  return {
    ...m,
    // 이름이 대상 이름 규칙에 안 맞으면 키가 "others"다 — 그 구성원에게는 "그 밖의 모든"을 따르는 것이다
    ...(r ? { policy: { source: key === "others" ? "others" : r.source, rules: { ...r.rules }, ...p.gate.countsOf(key) } } : {}),
    ...(d && now - d.at <= POLICY_DENIED_SHOW_MS ? { policyDenied: { group: d.group, at: new Date(d.at).toISOString(), ...(d.subType ? { subType: d.subType } : {}) } } : {}),
    ...(subTypes.length ? { subTypes } : {}),
  };
}

export class SnapshotBuilder {
  private readonly usage: UsageCollector;
  private prevSessions: SessionRecord[] = [];
  /** 대화 키(convId) → 층 id(B192). 마지막 빌드의 합친 층만 */
  private aliases = new Map<string, string>();
  private prevTeams: TeamRecord[] = [];

  constructor(private readonly opts: BuilderOptions) {
    this.usage = new UsageCollector(join(opts.claudeHome, "projects"));
  }

  private versionField(): Pick<Snapshot, "serverVersion" | "plugin"> {
    const p = this.opts.plugin?.();
    return { ...(this.opts.version ? { serverVersion: this.opts.version } : {}), ...(p ? { plugin: { version: p, match: p === this.opts.version, ...(this.opts.pluginLegacy?.() ? { legacy: true as const } : {}) } } : {}) };
  }

  async build(now = Date.now()): Promise<Snapshot> {
    const { claudeHome, config } = this.opts;
    try {
      await access(claudeHome);
    } catch {
      return { ...emptySnapshot(now, config, `Claude 데이터 폴더를 읽을 수 없습니다: ${claudeHome}`), ...this.versionField() };
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
    const sessions = (this.prevSessions = await guard("sessions", () => readSessions(claudeHome, now, this.opts.isAlive ?? pidAlive, this.opts.matchProcStart ?? defaultProcStartMatcher), this.prevSessions));
    // 조상 캐시는 지금 살아 있는 pid만 남긴다(끝난 pid가 다른 프로세스에 다시 쓰일 수 있다)
    const livePids = new Set(sessions.filter((x) => x.alive).map((x) => x.pid));
    for (const pid of this.ancestorCache.keys()) if (!livePids.has(pid)) this.ancestorCache.delete(pid);
    this.aliases = new Map(sessions.flatMap((s) => (s.convId ? [[s.convId, s.sessionId] as [string, string]] : [])));
    const teams = (this.prevTeams = await guard("teams", () => readTeams(claudeHome), this.prevTeams));
    // readLimits에 now를 넘겨, 스냅샷이 판단하는 "현재 시각"과 rate limit 창의 만료 판정 기준을 맞춘다
    // (Task 7 fix round 1에서 readLimits가 now를 받아 이미 지난 창을 걸러내도록 바뀌었다).
    const limits = await readLimits(claudeHome, now).catch((e) => (warnCaught("snapshot", "limits collect failed", e), null));
    this.opts.events?.prune(now);
    this.opts.subagents?.prune(now);

    // 층 관리(Phase 4a): 끝난 세션을 정리하고, 숨긴 세션을 뺀 나머지로 층 번호·현재 세션을 매긴다(스펙 6, B118)
    const floors = this.opts.floors;
    floors?.sweep(sessions);
    this.opts.channels?.sweep(new Set(sessions.filter((x) => x.alive).map((x) => x.sessionId)));
    const shown = floors ? sessions.filter((s) => !floors.isHidden(s.sessionId)) : sessions;
    const byStart = [...shown].sort((a, b) => a.startedAt - b.startedAt || a.sessionId.localeCompare(b.sessionId));
    const floorOf = new Map(byStart.map((s, i) => [s.sessionId, i + 1]));
    const ordered = [...shown].sort((a, b) => Number(b.alive) - Number(a.alive) || b.updatedAt - a.updatedAt);
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
    // 결정은 hook의 session_id(대화 키)로 쌓인다 — 화면·보고서가 층을 찾게 층 id로 바꿔 싣는다(B192)
    const decisions = this.opts.decisions?.list().map((d) => (this.aliases.has(d.sessionId) ? { ...d, sessionId: this.floorIdOf(d.sessionId) } : d));
    const teamItems: DecisionView[] = [];
    const views = await Promise.all(
      ordered.map(async (s) =>
        this.sessionView(s, await teamFor(s.convId ?? s.sessionId), now, s.sessionId === currentId, stale, floorOf.get(s.sessionId) ?? 0, decisions, teamItems),
      ),
    );
    const budget = this.opts.budget;
    if (budget) {
      // 예산은 hook의 session_id(대화 키)로 판정하므로 그 키로 넣고 읽는다(B192)
      for (const v of views) budget.gate.setUsage(this.convOf(v.id), v.members.reduce((n, m) => n + m.tokens.total, 0));
      budget.store.touch(views.filter((v) => v.alive).map((v) => this.convOf(v.id)), (id) => budget.gate.usage(id));
      for (const v of views) {
        const b = budget.gate.view(this.convOf(v.id));
        if (b) v.budget = b;
      }
    }
    const defaultBudgetTokens = budget?.store.defaultTokens();
    // 팀원 요청(보고서만)도 손을 든 만큼 센다
    const decisionCount = decisions
      ? decisions.filter((d) => d.state === "pending").length + teamItems.length
      : views.reduce((n, v) => n + v.members.filter((m) => m.state === "decision").length, 0);

    const p = this.opts.policy;
    const targets = p?.store.all().targets ?? {};
    const counts = p?.gate.counts() ?? {};
    // 읽지 못한 정책 파일은 대상이 없어도 알린다(Ruling B101). 이름·내용 없이 표시 하나
    const unreadable = p?.store.unreadable() ?? false;
    const policy = Object.keys(targets).length || Object.keys(counts).length || unreadable ? { policy: { targets, counts, ...(unreadable ? { unreadable: true as const } : {}) } } : {};

    return { ...emptySnapshot(now, config), ...this.versionField(), usage: this.usage.summary(now), limits, sessions: views, decisionCount, decisions: [...(decisions ?? []), ...teamItems], ...(defaultBudgetTokens !== undefined ? { defaultBudgetTokens } : {}), ...policy, hiddenFloors: floors?.hiddenCount() ?? 0, ...this.experimentalField() };
  }

  /** 마지막 빌드의 세션 레코드(Phase 4a B114·B117). 종료 API가 pid·procStart를 이것으로 검사한다. 스냅샷에는 싣지 않는다 */
  record(sessionId: string): SessionRecord | undefined {
    return this.prevSessions.find((s) => s.sessionId === sessionId);
  }

  /** hook의 session_id → 층 id(합친 층의 대화 키면 그 층, 아니면 그대로, B192). 일시정지 판정이 쓴다 */
  floorIdOf(id: string): string {
    return this.aliases.get(id) ?? id;
  }

  /** 층 id → 대화 키(합친 층이면 bg 쪽 sessionId, 아니면 그대로). 예산 설정이 쓴다 */
  convOf(floorId: string): string {
    return this.record(floorId)?.convId ?? floorId;
  }

  /** 살아 있고 일시정지면 "paused"(구성원 상태와 무관, 스펙 4.4). 횟수는 일시정지 층에만, 종료 중은 참일 때만 */
  private floorFields(s: SessionRecord, members: Member[]): Pick<SessionView, "floorStatus" | "pausedDenied" | "terminating"> {
    const v = this.opts.floors?.view(s.sessionId);
    const paused = s.alive && !!v?.paused;
    return {
      floorStatus: paused ? "paused" : floorStatusOf(s.alive, members),
      ...(paused ? { pausedDenied: v.pausedDenied } : {}),
      ...(s.alive && v?.terminating ? { terminating: true as const } : {}),
    };
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
    // 대화 기록·hook 상태는 대화 키로(합친 층은 bg 쪽 sessionId, B192). 층 id(s.sessionId)는 신원에만
    const conv = s.convId ?? s.sessionId;
    const leadFile = this.usage.findFile((p) => basename(p) === `${conv}.jsonl`);
    const last = leadFile ? this.usage.lastUsage(leadFile) : undefined;
    const status: MemberState = !s.alive ? "offline" : s.status === "busy" ? "working" : "idle";
    const agents = this.opts.events?.agents(conv);
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
          ...(leadFile ? { byModel: this.usage.fileByModel(leadFile) } : {}),
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
            // 설정의 별칭(띄울 때 준 값)보다 대화 기록이 말하는 실제 응답 모델이 먼저다
            model: (m.transcript ? this.usage.lastUsage(m.transcript)?.model : undefined) ?? m.model,
            color: m.color,
            state: memberState({ sessionAlive: s.alive, unread: m.unread, transcriptMtime: mtime, lastEntry, now }),
            unread: m.unread,
            tokens: m.transcript ? this.usage.fileTotal(m.transcript) : emptySum(),
            ...(m.transcript ? { byModel: this.usage.fileByModel(m.transcript) } : {}),
            lastActivityAt: at,
          },
          derived(m.name),
          s.alive,
          lastSentence(lastEntry),
          at,
        ),
      );
    }

    const p = this.opts.policy;
    if (p) {
      for (let i = 0; i < members.length; i++) members[i] = policyFields(members[i], p, conv, now, i === 0 ? agents : undefined);
    }

    return {
      id: s.sessionId,
      name: s.name,
      cwd: s.cwd,
      alive: s.alive,
      isCurrent,
      status,
      floor,
      ...this.floorFields(s, members),
      ...(s.startedAt ? { startedAt: iso(s.startedAt) } : {}),
      ...(!s.alive && s.updatedAt ? { endedAt: iso(s.updatedAt) } : {}),
      ...(stale ? { stale: true } : {}),
      context: contextInfo(last, this.opts.config.contextWindows),
      members,
      ...(await this.subagentField(s, leadFile, now)),
      ...this.channelField(s),
      ...this.reopenField(s),
    };
  }

  /** 실험 기능 켜짐 + 살아 있는 층만(B203·B205·#468). 라우트의 거부 순서와 같다: 진행 중 → 띄운 층 → 합친 층 → 멈춤 → 조상 */
  private reopenField(s: SessionRecord): { reopen?: NonNullable<SessionView["reopen"]> } {
    const ch = this.opts.channels;
    const ro = this.opts.reopen;
    if (!ch || !ro || !ch.enabled() || !s.alive) return {};
    if (ro.busy?.(s.sessionId)) return { reopen: "busy" };
    if (ch.view(s.sessionId)) return { reopen: "launched" };
    if (s.convId && s.convId !== s.sessionId) return { reopen: "merged" };
    if (this.opts.floors?.view(s.sessionId).paused) return { reopen: "paused" };
    // 조상 여부는 pid의 수명 동안 같다 — 빌드마다 묻지 않는다
    let a = this.ancestorCache.get(s.pid);
    if (!this.ancestorCache.has(s.pid)) this.ancestorCache.set(s.pid, (a = ro.isAncestor(s.pid)));
    return { reopen: a === false ? "ok" : "ancestor" };
  }
  private readonly ancestorCache = new Map<number, boolean | undefined>();

  /** 살아 있는 층만. 수집이 실패해도 층은 그대로 보인다 */
  private async subagentField(s: SessionRecord, leadFile: string | undefined, now: number): Promise<{ subagents?: SubagentDesk[] }> {
    if (!s.alive || !leadFile) return {};
    // 리드 대화 기록과 같은 프로젝트 폴더의 <sessionId>/subagents 하나만(B177 M1)
    const conv = s.convId ?? s.sessionId;
    const list = await readSubagents(join(dirname(leadFile), conv, "subagents"), conv, this.usage, this.opts.subagents, now).catch(
      (e) => (warnCaught("snapshot", "cannot read subagents", e), []),
    );
    return list.length ? { subagents: list } : {};
  }

  private channelField(s: SessionRecord): { channel?: NonNullable<SessionView["channel"]> } {
    const ch = this.opts.channels;
    if (!ch || !s.alive) return {};
    const v = ch.view(s.sessionId);
    return v ? { channel: v } : {};
  }

  private experimentalField(): { experimental?: NonNullable<Snapshot["experimental"]> } {
    const ch = this.opts.channels;
    if (!ch) return {};
    const a = ch.available();
    return { experimental: { channels: ch.enabled(), available: a.ok, ...(a.reason ? { reason: a.reason } : {}) } };
  }
}
