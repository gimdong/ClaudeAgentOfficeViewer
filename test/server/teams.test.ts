import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdir, utimes } from "node:fs/promises";
import { ACTIVE_WINDOW_MS, countUnread, findTeamNameForSession, memberState, readTeams, withTranscriptsFor } from "../../server/collectors/teams";
import { makeHome, type FakeHome } from "../helpers/fakeHome";

let h: FakeHome;
beforeEach(async () => { h = await makeHome(); });
afterEach(() => h.cleanup());

const SUB = "projects/-p/s1/subagents";

async function seedTeam() {
  await h.write("teams/t1/config.json", {
    name: "t1",
    leadSessionId: "s1",
    members: [
      { name: "team-lead", agentType: "team-lead" },
      { name: "developer", agentType: "general-purpose", model: "sonnet", color: "green", joinedAt: 1_700_000_000_000 },
      { name: "reviewer", agentType: "general-purpose", color: "blue", joinedAt: "x" },
    ],
  });
  await h.write("teams/t1/inboxes/developer.json", [{ from: "director", text: "hi", read: false }, { from: "x", read: true }, { from: "y" }]);
  await h.write("teams/t1/inboxes/reviewer.json", "garbage");
  await h.write(`${SUB}/agent-adev-old.meta.json`, { name: "developer" });
  await h.append(`${SUB}/agent-adev-old.jsonl`, [{ n: 1 }]);
  await utimes(h.path(`${SUB}/agent-adev-old.jsonl`), new Date(2020, 0, 1), new Date(2020, 0, 1));
  await h.write(`${SUB}/agent-adev-new.meta.json`, { name: "developer" });
  await h.append(`${SUB}/agent-adev-new.jsonl`, [{ n: 2 }]);
  await h.write(`${SUB}/agent-bad.meta.json`, "{");
  await h.write("teams/t2/inboxes/x.json", []); // config 없는 팀
}

describe("readTeams", () => {
  it("config가 있는 팀만 읽고, 팀원 기록과 안 읽은 메시지를 붙인다", async () => {
    await seedTeam();
    const teams = await readTeams(h.home);
    expect(teams).toHaveLength(1);
    expect(teams[0]).toEqual({
      name: "t1",
      leadSessionId: "s1",
      members: [
        { name: "developer", agentType: "general-purpose", model: "sonnet", color: "green", transcript: h.path(`${SUB}/agent-adev-new.jsonl`), unread: 2, joinedAt: 1_700_000_000_000 },
        { name: "reviewer", agentType: "general-purpose", model: undefined, color: "blue", transcript: undefined, unread: 0 },
      ],
    });
  });

  it("teams 폴더가 없으면 빈 배열", async () => {
    expect(await readTeams(h.home)).toEqual([]);
  });

  it("config가 null인 팀이 있어도 다른 팀은 읽는다", async () => {
    await h.write("teams/broken/config.json", null);
    await h.write("teams/ok/config.json", { name: "ok", leadSessionId: "s2", members: [] });
    const teams = await readTeams(h.home);
    expect(teams).toEqual([{ name: "ok", leadSessionId: "s2", members: [] }]);
  });

  // final review I-2: projects/ 아래 한 프로젝트 폴더를 읽을 수 없어도(EACCES) 팀원 전체가
  // 사라지면 안 된다. root는 chmod 000이 무의미해 재현이 안 되므로 그럴 때만 건너뛴다.
  it("읽을 수 없는 프로젝트 폴더가 있어도 다른 팀원은 표시된다", async () => {
    if (process.getuid?.() === 0) return;
    await seedTeam();
    const blocked = h.path("projects/blocked-proj");
    await mkdir(blocked, { recursive: true });
    await chmod(blocked, 0o000);
    try {
      const teams = await readTeams(h.home);
      expect(teams).toHaveLength(1);
      expect(teams[0].members.map((m) => m.name)).toEqual(["developer", "reviewer"]);
      const dev = teams[0].members.find((m) => m.name === "developer");
      expect(dev?.transcript).toBe(h.path(`${SUB}/agent-adev-new.jsonl`));
    } finally {
      await chmod(blocked, 0o755); // afterEach의 정리(rm -rf)가 지울 수 있게 권한을 복구한다
    }
  });
});

describe("findTeamNameForSession / withTranscriptsFor (Ruling P19)", () => {
  it("leadSessionId와 다른 세션이어도, 그 세션의 subagent meta에 적힌 teamName으로 팀을 찾을 수 있다", async () => {
    await h.write("projects/-p/sess-fake-A/subagents/agent-aquill-1.meta.json", { name: "quill", teamName: "team-fake" });
    expect(await findTeamNameForSession(h.path("projects"), "sess-fake-A", new Set(["team-fake"]))).toBe("team-fake");
    expect(await findTeamNameForSession(h.path("projects"), "no-such-session", new Set(["team-fake"]))).toBeUndefined();
  });

  it("meta 파일이 깨져 있으면 그 파일만 건너뛰고 나머지에서 찾는다", async () => {
    await h.write("projects/-p/s/subagents/agent-bad.meta.json", "{");
    await h.write("projects/-p/s/subagents/agent-aok.meta.json", { name: "ok", teamName: "team-ok" });
    expect(await findTeamNameForSession(h.path("projects"), "s", new Set(["team-ok"]))).toBe("team-ok");
  });

  // 최종 리뷰 Important 3: teams에 실제로 존재하는 이름만 후보로 삼는다 — 파일 이름 순서상 사라진
  // 팀(team-gone)이 먼저 읽혀도 현재 존재하는 팀(team-live)을 돌려줘야 한다.
  it("현재 teams에 없는 teamName은 후보에서 빼고, 있는 이름만 돌려준다", async () => {
    await h.write("projects/-p/sess-mixed/subagents/agent-agone.meta.json", { name: "x", teamName: "team-gone" });
    await h.write("projects/-p/sess-mixed/subagents/agent-blive.meta.json", { name: "y", teamName: "team-live" });
    const found = await findTeamNameForSession(h.path("projects"), "sess-mixed", new Set(["team-live"]));
    expect(found).toBe("team-live");
  });

  it("유효한 후보가 여럿이면 meta 파일 mtime이 가장 최근인 쪽을 쓴다", async () => {
    await h.write("projects/-p/sess-multi/subagents/agent-aold.meta.json", { name: "x", teamName: "team-old" });
    await utimes(h.path("projects/-p/sess-multi/subagents/agent-aold.meta.json"), new Date(2020, 0, 1), new Date(2020, 0, 1));
    await h.write("projects/-p/sess-multi/subagents/agent-bnew.meta.json", { name: "y", teamName: "team-new" });
    const found = await findTeamNameForSession(h.path("projects"), "sess-multi", new Set(["team-old", "team-new"]));
    expect(found).toBe("team-new");
  });

  it("withTranscriptsFor는 원래 팀 정보(이름·unread 등)는 두고 transcript만 새 세션 기준으로 다시 찾는다", async () => {
    await h.write("projects/-p/lead-fake-B/subagents/agent-adev.meta.json", { name: "developer" });
    await h.append("projects/-p/lead-fake-B/subagents/agent-adev.jsonl", [{ n: 1 }]);
    await h.write("projects/-p/sess-fake-A/subagents/agent-adev2.meta.json", { name: "developer" });
    await h.append("projects/-p/sess-fake-A/subagents/agent-adev2.jsonl", [{ n: 2 }]);
    const team = { name: "team-fake", leadSessionId: "lead-fake-B", members: [{ name: "developer", agentType: "general-purpose", unread: 1 }] };
    const moved = await withTranscriptsFor(team, h.path("projects"), "sess-fake-A");
    expect(moved.name).toBe("team-fake");
    expect(moved.members[0]).toMatchObject({ name: "developer", unread: 1, transcript: h.path("projects/-p/sess-fake-A/subagents/agent-adev2.jsonl") });
  });
});

describe("countUnread", () => {
  it("깨진 inbox와 meta는 안 읽은 메시지 0으로 보고 팀원은 유지한다", async () => {
    await h.write("i/a.json", "garbage");
    await h.write("i/b.json", { not: "array" });
    await h.write("i/c.json", [null, 3, { read: true }, { read: false }]);
    expect(await countUnread(h.path("i/a.json"))).toBe(0);
    expect(await countUnread(h.path("i/b.json"))).toBe(0);
    expect(await countUnread(h.path("i/missing.json"))).toBe(0);
    expect(await countUnread(h.path("i/c.json"))).toBe(3);
  });
});

describe("memberState", () => {
  const now = 1_000_000;
  const toolUse = { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } };
  const text = { type: "assistant", message: { content: [{ type: "text", text: "done" }] } };

  it.each([
    [{ sessionAlive: false, unread: 3, transcriptMtime: now, lastEntry: toolUse }, "offline"],
    [{ sessionAlive: true, unread: 1, transcriptMtime: now, lastEntry: toolUse }, "mail"],
    [{ sessionAlive: true, unread: 0, transcriptMtime: now - ACTIVE_WINDOW_MS, lastEntry: text }, "working"],
    [{ sessionAlive: true, unread: 0, transcriptMtime: now - ACTIVE_WINDOW_MS - 1, lastEntry: toolUse }, "working"],
    [{ sessionAlive: true, unread: 0, transcriptMtime: now - 60_000, lastEntry: text }, "idle"],
    [{ sessionAlive: true, unread: 0 }, "idle"],
  ])("%o → %s", (input, expected) => {
    expect(memberState({ ...input, now })).toBe(expected);
  });
});
