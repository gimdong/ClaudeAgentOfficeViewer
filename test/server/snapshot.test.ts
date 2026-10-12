import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapshotBuilder } from "../../server/snapshot";
import { DecisionQueue, RESOLVED_KEEP_MS, type HeldResponse } from "../../server/decisions/queue";
import { HOLD_MS } from "../../server/decisions/protocol";
import { EventStore } from "../../server/events/store";
import { getLogger } from "../../server/log";
import { PolicyGate } from "../../server/policy/gate";
import { FloorControl } from "../../server/floors/control";
import { BudgetGate } from "../../server/budget/gate";
import { BudgetStore } from "../../server/budget/store";
import { PolicyStore } from "../../server/policy/store";
import { assistant, makeHome, type FakeHome } from "../helpers/fakeHome";

const NOW = Date.now();
let h: FakeHome;
beforeEach(async () => {
  h = await makeHome();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await h.cleanup();
});

const config = { budget: { fiveHour: 1000 }, contextWindows: { "claude-opus-5-5": 1_000_000 } };

async function seed() {
  await h.write("sessions/100.json", { pid: 100, sessionId: "s1", name: "alpha", cwd: "/x", status: "busy", updatedAt: NOW - 1000 });
  await h.write("sessions/200.json", { pid: 200, sessionId: "s2", name: "beta", cwd: "/y", status: "idle", updatedAt: NOW - 2 * 3_600_000 });
  await h.append("projects/-p/s1.jsonl", [assistant({ requestId: "r1", ts: NOW - 5000, input: 1000, cacheRead: 9000, output: 50 })]);
  await h.write("teams/t/config.json", {
    name: "t",
    leadSessionId: "s1",
    members: [{ name: "team-lead", agentType: "team-lead" }, { name: "developer", agentType: "general-purpose", model: "sonnet" }, { name: "reviewer", agentType: "general-purpose" }],
  });
  const sub = "projects/-p/s1/subagents";
  await h.write(`${sub}/agent-adev.meta.json`, { name: "developer" });
  await h.append(`${sub}/agent-adev.jsonl`, [
    assistant({ requestId: "d1", ts: NOW - 60_000, output: 7, content: [{ type: "tool_use", name: "Bash" }] }),
  ]);
  const old = new Date(NOW - 60_000);
  await utimes(h.path(`${sub}/agent-adev.jsonl`), old, old);
}

describe("SnapshotBuilder", () => {
  it("세션·팀·토큰·컨텍스트를 합쳐 스냅샷을 만든다", async () => {
    await seed();
    const snap = await new SnapshotBuilder({ claudeHome: h.home, config, isAlive: (pid) => pid === 100 }).build(NOW);

    expect(snap.error).toBeUndefined();
    expect(snap.budget).toEqual({ fiveHour: 1000 });
    expect(snap.limits).toBeNull();
    expect(snap.usage.last5h.total).toBe(1057);
    expect(snap.sessions.map((s) => s.id)).toEqual(["s1", "s2"]);

    const [s1, s2] = snap.sessions;
    expect(s1).toMatchObject({ name: "alpha", alive: true, isCurrent: true, status: "working" });
    expect(s1.stale).toBeUndefined();
    expect(s1.context).toEqual({ used: 10000, window: 1_000_000, pct: 1, estimated: false });
    expect(s1.members.map((m) => [m.name, m.state])).toEqual([["team-lead", "working"], ["developer", "working"], ["reviewer", "idle"]]);
    expect(s1.members[0]).toMatchObject({ role: "lead", model: "claude-opus-5-5", tokens: { total: 1050 } });
    // 팀원 모델은 설정 별칭("sonnet")보다 대화 기록의 마지막 답변 모델이 먼저다. 모델별 합계도 싣는다
    expect(s1.members[0].byModel).toEqual([{ model: "claude-opus-5-5", total: 1050 }]);
    expect(s1.members[1]).toMatchObject({ model: "claude-opus-5-5", tokens: { total: 7 }, byModel: [{ model: "claude-opus-5-5", total: 7 }] });
    expect(s1.members[2].byModel).toBeUndefined(); // 대화 기록이 없으면 싣지 않는다
    expect(s1.members[1].lastActivityAt).toBeDefined();

    expect(s2).toMatchObject({ alive: false, isCurrent: false, status: "offline", context: null });
    expect(s2.members).toHaveLength(1);
    expect(s2.members[0].state).toBe("offline");
  });

  it("빈 claude home이면 오류 없이 빈 대시보드", async () => {
    const snap = await new SnapshotBuilder({ claudeHome: h.home, config: { budget: {}, contextWindows: {} } }).build(NOW);
    expect(snap.error).toBeUndefined();
    expect(snap.sessions).toEqual([]);
    expect(snap.usage.today.total).toBe(0);
  });

  it("claude home에 접근할 수 없으면 error를 채운다", async () => {
    const missing = join(h.home, "nope");
    const snap = await new SnapshotBuilder({ claudeHome: missing, config: { budget: {}, contextWindows: {} } }).build(NOW);
    expect(snap.error).toContain(missing);
    expect(snap.sessions).toEqual([]);
    expect(snap.usage.hourly).toHaveLength(24);
  });

  it("수집기가 실패하면 직전 결과를 쓰고 stale을 표시한다", async () => {
    // teams 자리에 파일을 두면 readTeams가 ENOTDIR로 실패한다 → 직전 값(처음엔 빈 배열) 사용
    await h.write("sessions/1.json", { pid: 1, sessionId: "z", updatedAt: NOW });
    await h.write("teams", "not a directory");
    const warn = vi.spyOn(getLogger(), "warn");
    const snap = await new SnapshotBuilder({ claudeHome: h.home, config, isAlive: () => true }).build(NOW);
    expect(snap.sessions).toHaveLength(1);
    expect(snap.sessions[0].stale).toBe(true);
    expect(snap.sessions[0].members.map((m) => m.name)).toEqual(["team-lead"]);
    expect(warn).toHaveBeenCalledWith("snapshot", expect.stringContaining("teams"), expect.anything());
  });
});

describe("SnapshotBuilder v2", () => {
  const T = NOW;
  async function seedFloors() {
    await h.write("sessions/1.json", { pid: 1, sessionId: "old", name: "old", cwd: "/o", status: "idle", startedAt: T - 3_000_000, updatedAt: T - 1000 });
    await h.write("sessions/2.json", { pid: 2, sessionId: "mid", name: "mid", cwd: "/m", status: "busy", startedAt: T - 2_000_000, updatedAt: T - 1000 });
    await h.write("sessions/3.json", { pid: 3, sessionId: "new", name: "new", cwd: "/n", status: "idle", startedAt: T - 1_000_000, updatedAt: T - 2 * 3_600_000 });
  }
  const alive = (pid: number) => pid !== 3;

  it("시작 시각이 가장 오래된 세션이 1F, floorStatus와 endedAt", async () => {
    await seedFloors();
    const snap = await new SnapshotBuilder({ claudeHome: h.home, config, isAlive: alive }).build(T);
    const by = Object.fromEntries(snap.sessions.map((s) => [s.id, s]));
    expect([by.old.floor, by.mid.floor, by.new.floor]).toEqual([1, 2, 3]);
    expect([by.old.floorStatus, by.mid.floorStatus, by.new.floorStatus]).toEqual(["idle", "working", "ended"]);
    expect(by.new.endedAt).toBe(new Date(T - 2 * 3_600_000).toISOString());
    expect(by.old.endedAt).toBeUndefined();
    expect(by.old.startedAt).toBe(new Date(T - 3_000_000).toISOString());
    expect(snap.decisionCount).toBe(0);
  });

  it("이벤트의 진행 중 도구가 파일 판정보다 우선하고, 결정은 decision 상태와 decisionCount로 나온다", async () => {
    await seed();
    const events = new EventStore();
    events.add({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Read", tool_input: { file_path: "/x/a.md" } }, T - 500);
    events.add({ hook_event_name: "PermissionRequest", session_id: "s1", agent_id: "areviewer-1", agent_type: "reviewer", tool_name: "Bash", tool_input: { command: "rm -rf /tmp/fake" } }, T - 400);
    const snap = await new SnapshotBuilder({ claudeHome: h.home, config, isAlive: () => true, events }).build(T);
    const s1 = snap.sessions.find((s) => s.id === "s1")!;
    const lead = s1.members.find((m) => m.name === "team-lead")!;
    const reviewer = s1.members.find((m) => m.name === "reviewer")!;
    expect(lead.state).toBe("working");
    expect(lead.activity).toEqual({ kind: "tool", tool: "Read", target: "/x/a.md", startedAt: new Date(T - 500).toISOString() });
    expect(reviewer.state).toBe("decision");
    expect(reviewer.decision).toEqual({ kind: "permission", since: new Date(T - 400).toISOString(), summary: "rm -rf /tmp/fake" });
    expect(snap.decisionCount).toBe(1);
    expect(s1.floorStatus).toBe("working");
  });

  it("세션이 죽었으면 이벤트가 있어도 offline이고 결정을 세지 않는다", async () => {
    await seed();
    const events = new EventStore();
    events.add({ hook_event_name: "PermissionRequest", session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } }, T - 100);
    const snap = await new SnapshotBuilder({ claudeHome: h.home, config, isAlive: () => false, events }).build(T);
    const lead = snap.sessions.find((s) => s.id === "s1")!.members[0];
    expect(lead.state).toBe("offline");
    expect(lead.decision).toBeUndefined();
    expect(snap.decisionCount).toBe(0);
  });

  it("세션 파일이 없는 이벤트는 층을 만들지 않는다", async () => {
    await seed();
    const events = new EventStore();
    events.add({ hook_event_name: "PreToolUse", session_id: "ghost", tool_name: "Bash", tool_input: { command: "ls" } }, T);
    const snap = await new SnapshotBuilder({ claudeHome: h.home, config, isAlive: () => true, events }).build(T);
    expect(snap.sessions.map((s) => s.id).sort()).toEqual(["s1", "s2"]);
  });

  it("이벤트가 없으면 리드의 마지막 문장을 said 활동으로 쓴다", async () => {
    await seed();
    await h.append("projects/-p/s1.jsonl", [assistant({ requestId: "r9", ts: NOW - 100, content: [{ type: "text", text: "빌드를 확인했습니다. 다음은 리뷰입니다." }] })]);
    const snap = await new SnapshotBuilder({ claudeHome: h.home, config, isAlive: () => true }).build(T);
    const lead = snap.sessions.find((s) => s.id === "s1")!.members[0];
    expect(lead.activity).toMatchObject({ kind: "said", target: "다음은 리뷰입니다." });
  });

  it("team config의 leadSessionId가 세션 id와 달라도 팀원 meta의 teamName으로 팀을 찾아 팀원 책상을 그린다(Ruling P19)", async () => {
    await h.write("sessions/1.json", { pid: 1, sessionId: "sess-fake-A", name: "alpha", cwd: "/x", status: "idle", updatedAt: T - 1000 });
    await h.write("teams/team-fake/config.json", {
      name: "team-fake",
      leadSessionId: "lead-fake-B", // 실제 세션 id와 다름(Phase 0 관찰)
      members: [{ name: "team-lead", agentType: "team-lead" }, { name: "quill", agentType: "general-purpose" }],
    });
    await h.write("projects/-p/sess-fake-A/subagents/agent-aquill-1.meta.json", { name: "quill", teamName: "team-fake" });
    await h.append("projects/-p/sess-fake-A/subagents/agent-aquill-1.jsonl", [assistant({ requestId: "q1", ts: T - 500 })]);

    const events = new EventStore();
    events.add({ hook_event_name: "PreToolUse", session_id: "sess-fake-A", agent_id: "aquill-1", agent_type: "quill", tool_name: "Bash", tool_input: { command: "echo hi" } }, T - 400);

    const snap = await new SnapshotBuilder({ claudeHome: h.home, config, isAlive: () => true, events }).build(T);
    const s = snap.sessions.find((x) => x.id === "sess-fake-A")!;
    const quill = s.members.find((m) => m.name === "quill");
    expect(quill).toBeDefined();
    expect(quill!.activity).toEqual({ kind: "tool", tool: "Bash", target: "echo hi", startedAt: new Date(T - 400).toISOString() });
  });
});

/** 큐가 쓰는 응답 부분만 흉내 낸다 */
function heldRes(): HeldResponse & { close(): void } {
  const fns: Array<() => void> = [];
  const r = {
    writableEnded: false,
    on: (_e: "close", fn: () => void) => void fns.push(fn),
    status: () => ({ json: () => void (r.writableEnded = true), end: () => void (r.writableEnded = true) }),
    close: () => fns.forEach((f) => f()),
  };
  return r;
}

describe("SnapshotBuilder + 결정 큐(Phase 2, Ruling B28·B40)", () => {
  const T = NOW;
  let clock = T;
  let q: DecisionQueue;
  beforeEach(() => {
    clock = T - 1000;
    q = new DecisionQueue({ now: () => clock });
  });
  afterEach(() => q.stop());
  const hold = (o: Record<string, unknown>) => q.hold({ hook_event_name: "PermissionRequest", session_id: "s1", tool_name: "Bash", tool_input: { command: "rm -rf /tmp/fake" }, ...o }, heldRes())!;
  const build = (events?: EventStore) => new SnapshotBuilder({ claudeHome: h.home, config, isAlive: () => true, decisions: q, ...(events ? { events } : {}) }).build(T);

  it("큐에 pending이 있으면 그 구성원이 decision 상태이고 id·deadline이 붙는다", async () => {
    await seed();
    const v = hold({ agent_id: "areviewer-1", agent_type: "reviewer" });
    const snap = await build();
    const s1 = snap.sessions.find((s) => s.id === "s1")!;
    const reviewer = s1.members.find((m) => m.name === "reviewer")!;
    expect(reviewer.state).toBe("decision");
    expect(reviewer.decision).toEqual({ kind: "permission", since: v.createdAt, summary: "rm -rf /tmp/fake", id: v.id, deadline: v.deadline });
    expect(s1.members.find((m) => m.name === "team-lead")!.decision).toBeUndefined();
    expect(snap.decisions.map((d) => d.id)).toEqual([v.id]);
    expect(snap.decisionCount).toBe(1);
  });

  it("같은 구성원에 결정이 여럿이면 가장 오래된 pending을 쓴다", async () => {
    await seed();
    const first = hold({ tool_input: { command: "first" } });
    clock += 1000;
    hold({ tool_input: { command: "second" } });
    const lead = (await build()).sessions.find((s) => s.id === "s1")!.members[0];
    expect(lead.decision).toMatchObject({ id: first.id, summary: "first" });
  });

  it("큐가 연결되면 derive의 permission 결정은 쓰지 않는다", async () => {
    await seed();
    const events = new EventStore();
    events.add({ hook_event_name: "PermissionRequest", session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } }, T - 100);
    events.add({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "Q?" }] } }, T - 50);
    const snap = await build(events);
    const lead = snap.sessions.find((s) => s.id === "s1")!.members[0];
    expect(lead.decision).toBeUndefined();
    expect(lead.state).not.toBe("decision");
    expect(snap.decisionCount).toBe(0);
  });

  it("ExitPlanMode 결정은 answerable:false로 나오고 그 구성원이 손을 든다", async () => {
    await seed();
    const v = hold({ tool_name: "ExitPlanMode", tool_input: { plan: "1. 파일 만들기" } });
    const snap = await build();
    const lead = snap.sessions.find((s) => s.id === "s1")!.members[0];
    expect(lead.state).toBe("decision");
    expect(lead.decision).toMatchObject({ kind: "plan", id: v.id, summary: "ExitPlanMode" });
    expect(snap.decisions[0]).toMatchObject({ kind: "plan", answerable: false, plan: "1. 파일 만들기" });
    expect(snap.decisionCount).toBe(1);
  });

  it("질문 결정의 요약은 첫 질문(가린 값)이다", async () => {
    await seed();
    hold({ tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "어느 쪽 token=FAKE123 으로?", multiSelect: false, options: [{ label: "a" }] }] } });
    const lead = (await build()).sessions.find((s) => s.id === "s1")!.members[0];
    expect(lead.decision).toMatchObject({ kind: "question", summary: "어느 쪽 token=*** 으로?" });
  });

  it("decisionCount는 pending 수이고, 끝난 결정은 세지 않는다", async () => {
    await seed();
    const a = hold({});
    hold({ tool_input: { command: "b" } });
    q.answer(a.id, { action: "allow" });
    const snap = await build();
    expect(snap.decisionCount).toBe(1);
    expect(snap.decisions.map((d) => d.state)).toEqual(["pending", "answered-dashboard"]);
    expect(snap.sessions.find((s) => s.id === "s1")!.members[0].decision?.summary).toBe("b");
  });

  it("빌드마다 queue.list()를 불러 30초 지난 끝난 결정이 정리된다(Task 3 리뷰 M4)", async () => {
    await seed();
    const a = hold({});
    q.answer(a.id, { action: "allow" });
    let calls = 0;
    const builder = new SnapshotBuilder({ claudeHome: h.home, config, isAlive: () => true, decisions: { list: () => (calls++, q.list()) } });
    expect((await builder.build(T)).decisions).toHaveLength(1);
    clock += RESOLVED_KEEP_MS + 1;
    expect((await builder.build(T)).decisions).toEqual([]);
    expect(calls).toBe(2);
  });

  it("끝난(expired·closed-terminal) 결정은 손을 내린다", async () => {
    await seed();
    const r = heldRes();
    q.hold({ hook_event_name: "PermissionRequest", session_id: "s1", tool_name: "Bash", tool_input: { command: "x" } }, r);
    r.close();
    const lead = (await build()).sessions.find((s) => s.id === "s1")!.members[0];
    expect(lead.decision).toBeUndefined();
    expect(HOLD_MS).toBe(590_000);
  });

  /** 리드 대화 기록에 팀원 메시지(가짜 값, 실제와 같은 태그 모양)를 더한다 */
  const teamMsg = (from: string, summary: string, msAgo: number) =>
    h.append("projects/-p/s1.jsonl", [
      { type: "user", timestamp: new Date(T - msAgo).toISOString(), message: { role: "user", content: `<teammate-message teammate_id="${from}" color="blue" summary="${summary}">\n본문\n</teammate-message>` } },
    ]);

  it("팀원 요청이 있으면 그 책상이 decision(team)이고 decisions에 answerable:false로 나온다", async () => {
    await seed();
    await teamMsg("developer", "[결정 필요] 포트를 무엇으로 할까요 token=FAKE12345", 60_000);
    const snap = await build();
    const dev = snap.sessions.find((s) => s.id === "s1")!.members.find((m) => m.name === "developer")!;
    const at = T - 60_000;
    expect(dev.state).toBe("decision");
    expect(dev.decision).toEqual({
      kind: "team",
      since: new Date(at).toISOString(),
      summary: "[결정 필요] 포트를 무엇으로 할까요 token=***",
      id: `team:s1:developer:${at}`,
      deadline: new Date(at + 30 * 60_000).toISOString(),
    });
    const item = snap.decisions.find((d) => d.kind === "team")!;
    expect(item).toMatchObject({ id: `team:s1:developer:${at}`, sessionId: "s1", agent: "developer", state: "pending", answerable: false, detail: { description: "[결정 필요] 포트를 무엇으로 할까요 token=***" } });
    expect(snap.decisionCount).toBe(1);
    expect(JSON.stringify(snap)).not.toContain("FAKE12345");
  });

  it("대기 중인 큐 결정이 있으면 큐가 먼저다", async () => {
    await seed();
    await teamMsg("developer", "[결정 필요] 질문", 60_000);
    const v = hold({ agent_id: "adeveloper-1", agent_type: "developer" });
    const snap = await build();
    const dev = snap.sessions.find((s) => s.id === "s1")!.members.find((m) => m.name === "developer")!;
    expect(dev.decision).toMatchObject({ kind: "permission", id: v.id });
    expect(snap.decisions.filter((d) => d.kind === "team")).toEqual([]);
    expect(snap.decisionCount).toBe(1);
  });

  it("결정 API로 team 항목에 답하면 404", async () => {
    await seed();
    await teamMsg("developer", "[결정 필요] 질문", 60_000);
    const item = (await build()).decisions.find((d) => d.kind === "team")!;
    expect(q.answer(item.id, { action: "allow" })).toEqual({ ok: false, status: 404 });
  });

  it("스냅샷 JSON에 원래 입력이 없다", async () => {
    await seed();
    hold({ tool_name: "Write", tool_input: { file_path: "/tmp/a.txt", content: `RAW-SECRET-LIKE-${"x".repeat(200_000)}` } });
    const text = JSON.stringify(await build());
    expect(text).not.toContain("RAW-SECRET-LIKE");
    expect(text.length).toBeLessThan(50_000);
  });
});

describe("SnapshotBuilder + 권한 정책(Phase 3 스펙 7.4)", () => {
  const T = NOW;
  let dir: string;
  let store: PolicyStore;
  let gate: PolicyGate;
  let clock: number;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "co-snap-policy-"));
    store = new PolicyStore(join(dir, "policy.json"));
    store.load();
    clock = T;
    gate = new PolicyGate(store, { now: () => clock });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const build = (events?: EventStore) =>
    new SnapshotBuilder({ claudeHome: h.home, config, isAlive: () => true, ...(events ? { events } : {}), policy: { store, gate } }).build(T);
  const pre = (o: Record<string, unknown>) => ({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Bash", tool_input: { command: "FAKE-CMD-123" }, ...o });
  const member = (snap: Awaited<ReturnType<typeof build>>, name: string) => snap.sessions.find((s) => s.id === "s1")!.members.find((m) => m.name === name)!;

  it("(a) lead에 규칙이 있으면 리드 member에 policy", async () => {
    await seed();
    store.set("lead", { bash: "ask" });
    gate.preToolUse(pre({}))?.respond();
    const snap = await build();
    expect(member(snap, "team-lead").policy).toEqual({ source: "own", rules: { bash: "ask" }, denied: 0, asked: 1 });
  });

  it("(b) others만 있으면 팀원은 source: others, 리드에는 policy가 없다", async () => {
    await seed();
    store.set("others", { web: "deny" });
    const snap = await build();
    expect(member(snap, "developer").policy).toEqual({ source: "others", rules: { web: "deny" }, denied: 0, asked: 0 });
    expect("policy" in member(snap, "team-lead")).toBe(false);
  });

  it("(c) 규칙이 없으면 policy 키 자체가 없다", async () => {
    await seed();
    store.set("agent:reviewer", { bash: "deny" });
    const snap = await build();
    expect("policy" in member(snap, "developer")).toBe(false);
    expect("policyDenied" in member(snap, "developer")).toBe(false);
    expect(member(snap, "reviewer").policy?.source).toBe("own");
  });

  it("(d) 30초 안의 deny는 policyDenied, 서브에이전트면 리드에 subType과 함께", async () => {
    await seed();
    store.set("agent:reviewer", { bash: "deny" });
    store.set("sub:Explore", { edit: "deny" });
    gate.preToolUse(pre({ agent_id: "areviewer-1", agent_type: "reviewer" }))?.respond();
    gate.preToolUse(pre({ agent_id: "a1b2c3d4e5f6a7b8", agent_type: "Explore", tool_name: "Edit" }))?.respond();
    let snap = await build();
    expect(member(snap, "reviewer").policyDenied).toEqual({ group: "bash", at: new Date(T).toISOString() });
    expect(member(snap, "reviewer").policy?.denied).toBe(1);
    expect(member(snap, "team-lead").policyDenied).toEqual({ group: "edit", at: new Date(T).toISOString(), subType: "Explore" });
    clock = T + 31_000;
    snap = await build();
    expect("policyDenied" in member(snap, "reviewer")).toBe(false);
  });

  it("(d2) 이름이 101자인 팀원이 others의 규칙으로 막히면 그 member의 policy.denied가 1이다", async () => {
    const long = "가".repeat(101);
    await seed();
    await h.write("teams/t/config.json", { name: "t", leadSessionId: "s1", members: [{ name: "team-lead", agentType: "team-lead" }, { name: long, agentType: "general-purpose" }] });
    store.set("others", { bash: "deny" });
    gate.preToolUse(pre({ agent_id: "along-1", agent_type: long }))?.respond();
    const snap = await build();
    expect(member(snap, long).policy).toEqual({ source: "others", rules: { bash: "deny" }, denied: 1, asked: 0 });
  });

  it("(e) 리드의 subTypes는 이벤트에 보인 종류를 중복 없이 정렬해 싣고, 없으면 키가 없다", async () => {
    await seed();
    let snap = await build(new EventStore());
    expect("subTypes" in member(snap, "team-lead")).toBe(false);
    const events = new EventStore();
    for (const t of ["Plan", "Explore", "Plan"]) events.add(pre({ agent_id: "a1b2c3d4e5f6a7b8", agent_type: t, tool_name: "Read", tool_input: {} }), T - 100);
    snap = await build(events);
    expect(member(snap, "team-lead").subTypes).toEqual(["Explore", "Plan"]);
    expect("subTypes" in member(snap, "developer")).toBe(false);
  });

  it("(f) snapshot.policy는 { targets, counts }이고 대상도 횟수도 없으면 키가 없다", async () => {
    await seed();
    expect("policy" in (await build())).toBe(false);
    store.set("lead", { bash: "deny" });
    gate.preToolUse(pre({}))?.respond();
    const snap = await build();
    expect(snap.policy).toEqual({ targets: { lead: { bash: "deny" } }, counts: { lead: { denied: 1, asked: 0 } } });
  });

  it("(h) unreadable이면 대상이 없어도 policy: { targets: {}, counts: {}, unreadable: true }, 아니면 unreadable 키가 없다(B101)", async () => {
    await seed();
    await writeFile(join(dir, "policy.json"), "{oops");
    store = new PolicyStore(join(dir, "policy.json"));
    store.load();
    gate = new PolicyGate(store, { now: () => clock });
    expect((await build()).policy).toEqual({ targets: {}, counts: {}, unreadable: true });
    store.set("lead", { bash: "deny" });
    const snap = await build();
    expect(snap.policy).toEqual({ targets: { lead: { bash: "deny" } }, counts: {} });
    expect("unreadable" in snap.policy!).toBe(false);
  });

  it("(g) 스냅샷 JSON에 가짜 명령 원문이 없다", async () => {
    await seed();
    store.set("lead", { all: "deny" });
    gate.preToolUse(pre({}))?.respond();
    const text = JSON.stringify(await build());
    expect(text.includes("FAKE-CMD-123")).toBe(false);
  });
});

describe("SnapshotBuilder + 층 관리(Phase 4a 스펙 4.4·5.2·6)", () => {
  const T = NOW;
  const PS = "Mon Oct 11 10:00:00 2026";
  async function seedFloors() {
    await h.write("sessions/1.json", { pid: 101, sessionId: "A", name: "a", cwd: "/a", status: "busy", startedAt: T - 3_000_000, updatedAt: T - 1000 });
    await h.write("sessions/2.json", { pid: 102, sessionId: "B", name: "b", cwd: "/b", status: "idle", startedAt: T - 2_000_000, updatedAt: T - 1000 });
    await h.write("sessions/3.json", { pid: 103, sessionId: "C", name: "c", cwd: "/c", status: "idle", startedAt: T - 1_000_000, updatedAt: T - 500 });
  }
  let alive: (pid: number) => boolean;
  let floors: FloorControl;
  beforeEach(() => {
    alive = () => true;
    floors = new FloorControl({ signal: () => {}, matchProcStart: async () => true, selfPid: 999_999 });
  });
  // 실제 ps를 부르지 않게 matcher도 주입한다(B128). 가짜는 언제나 일치
  const matchProcStart = vi.fn(async () => true as boolean | undefined);
  const builder = () => new SnapshotBuilder({ claudeHome: h.home, config, isAlive: (pid) => alive(pid), matchProcStart, floors });
  const by = (snap: Awaited<ReturnType<SnapshotBuilder["build"]>>) => Object.fromEntries(snap.sessions.map((s) => [s.id, s]));

  it("record(id)는 마지막 빌드의 레코드를 주고 procStart를 담는다, 없는 id는 undefined", async () => {
    await seedFloors();
    await h.write("sessions/4.json", { pid: 104, sessionId: "D", name: "d", cwd: "/d", status: "idle", startedAt: T - 500_000, updatedAt: T - 100, procStart: PS });
    const b = builder();
    expect(b.record("A")).toBeUndefined();
    await b.build(T);
    expect(b.record("A")).toMatchObject({ sessionId: "A", pid: 101, alive: true });
    expect(b.record("D")).toMatchObject({ procStart: PS, alive: true });
    expect(matchProcStart).toHaveBeenCalledWith(104, PS); // 주입한 matcher를 쓴다(실제 ps 없음)
    expect(b.record("nope")).toBeUndefined();
  });

  it("일시정지 층은 구성원이 작업 중이어도 paused이고 pausedDenied를 싣는다, 재개하면 기존 규칙, 끝난 세션은 ended", async () => {
    await seedFloors();
    const b = builder();
    floors.pause("A");
    floors.preToolUse({ hook_event_name: "PreToolUse", session_id: "A", tool_name: "Bash" });
    let s = by(await b.build(T));
    expect([s.A.floorStatus, s.A.pausedDenied]).toEqual(["paused", 1]);
    expect("pausedDenied" in s.B).toBe(false);
    floors.resume("A");
    s = by(await b.build(T));
    expect(s.A.floorStatus).toBe("working");
    expect("pausedDenied" in s.A).toBe(false);
    floors.pause("C");
    alive = (pid) => pid !== 103;
    s = by(await b.build(T));
    expect(s.C.floorStatus).toBe("ended");
    expect(floors.isPaused("C")).toBe(false); // 빌드의 sweep이 지웠다
  });

  it("terminating이면 terminating: true가 실리고 floorStatus는 그대로", async () => {
    await seedFloors();
    const b = builder();
    await b.build(T);
    expect(await floors.terminate({ ...b.record("A")!, procStart: PS }, false)).toMatchObject({ ok: true, sent: true }); // 가짜 matcher·signal
    const s = by(await b.build(T));
    expect([s.A.terminating, s.A.floorStatus]).toEqual([true, "working"]);
    expect("terminating" in s.B).toBe(false);
  });

  it("숨긴 세션은 sessions에서 빠지고 층 번호가 다시 매겨지며 hiddenFloors가 그 수다", async () => {
    await seedFloors();
    alive = (pid) => pid !== 102;
    const b = builder();
    await b.build(T);
    floors.hide("B");
    const snap = await b.build(T);
    expect(snap.sessions.map((s) => [s.id, s.floor])).toEqual([["C", 2], ["A", 1]]);
    expect(snap.hiddenFloors).toBe(1);
    expect(snap.sessions.find((s) => s.isCurrent)?.id).toBe("C");
  });

  it("숨긴 세션이 다시 살아나면 숨김이 풀리고 보인다(Review Focus 3)", async () => {
    await seedFloors();
    alive = (pid) => pid !== 102;
    const b = builder();
    await b.build(T);
    floors.hide("B");
    expect((await b.build(T)).hiddenFloors).toBe(1);
    alive = () => true;
    const snap = await b.build(T);
    expect(snap.hiddenFloors).toBe(0);
    expect(snap.sessions.map((s) => s.id).sort()).toEqual(["A", "B", "C"]);
  });

  it("숨겨도 예산·정책 상태는 그대로다(Review Focus 3)", async () => {
    await seedFloors();
    alive = (pid) => pid !== 102;
    const dir = await mkdtemp(join(tmpdir(), "co-snap-floors-"));
    try {
      const store = new BudgetStore(join(dir, "state.json"));
      store.load();
      store.setBudget("B", 5000, 0);
      const gate = new BudgetGate(store);
      const pstore = new PolicyStore(join(dir, "policy.json"));
      pstore.load();
      pstore.set("lead", { bash: "deny" });
      const pgate = new PolicyGate(pstore);
      pgate.preToolUse({ hook_event_name: "PreToolUse", session_id: "B", tool_name: "Bash" })?.respond();
      const b = new SnapshotBuilder({ claudeHome: h.home, config, isAlive: (pid) => alive(pid), floors, budget: { gate, store }, policy: { store: pstore, gate: pgate } });
      await b.build(T);
      floors.hide("B");
      await b.build(T);
      expect(store.get("B")).toEqual({ budgetTokens: 5000, nextGateAt: 5000 });
      expect(pgate.countsOf("lead")).toEqual({ denied: 1, asked: 0 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("빌드마다 sweep이 불리고, 스냅샷 JSON에 pid·procStart가 없다", async () => {
    await seedFloors();
    const sweep = vi.spyOn(floors, "sweep");
    const b = builder();
    await b.build(T);
    const snap = await b.build(T);
    expect(sweep).toHaveBeenCalledTimes(2);
    const text = JSON.stringify(snap);
    expect([text.includes('"pid"'), text.includes("procStart"), text.includes(PS)]).toEqual([false, false, false]);
  });
});
