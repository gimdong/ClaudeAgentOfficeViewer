import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { utimes } from "node:fs/promises";
import { ACTIVE_WINDOW_MS, countUnread, memberState, readTeams } from "../../server/collectors/teams";
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
      { name: "developer", agentType: "general-purpose", model: "sonnet", color: "green" },
      { name: "reviewer", agentType: "general-purpose", color: "blue" },
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
        { name: "developer", agentType: "general-purpose", model: "sonnet", color: "green", transcript: h.path(`${SUB}/agent-adev-new.jsonl`), unread: 2 },
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
