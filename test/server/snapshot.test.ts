import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { utimes } from "node:fs/promises";
import { join } from "node:path";
import { SnapshotBuilder } from "../../server/snapshot";
import { EventStore } from "../../server/events/store";
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
    expect(s1.members[1]).toMatchObject({ model: "sonnet", tokens: { total: 7 } });
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
    const snap = await new SnapshotBuilder({ claudeHome: h.home, config, isAlive: () => true }).build(NOW);
    expect(snap.sessions).toHaveLength(1);
    expect(snap.sessions[0].stale).toBe(true);
    expect(snap.sessions[0].members.map((m) => m.name)).toEqual(["team-lead"]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("teams"));
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
