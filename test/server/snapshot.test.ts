import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { utimes } from "node:fs/promises";
import { join } from "node:path";
import { SnapshotBuilder } from "../../server/snapshot";
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
