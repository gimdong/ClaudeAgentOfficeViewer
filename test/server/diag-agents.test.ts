import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assistant, makeHome, type FakeHome } from "../helpers/fakeHome";
import { agentsItem, checkAgents } from "../../server/diag/agents";

let h: FakeHome;
beforeEach(async () => (h = await makeHome()));
afterEach(async () => h.cleanup());

const agentCall = (ts: number) => assistant({ requestId: `r${ts}`, ts, output: 1, content: [{ type: "tool_use", name: "Agent" }] });

describe("진단: 에이전트 기록 점검(beta.22, 회사 PC 2.1.305 사례)", () => {
  it("층마다 Agent 호출 수·대화 폴더·subagents meta(이름 있는 것)·팀 설정을 센다. id·이름은 싣지 않는다", async () => {
    await h.append("projects/-p/c1.jsonl", [agentCall(1), agentCall(2)]);
    await h.write("projects/-p/c1/subagents/agent-a1.meta.json", { name: "dev", teamName: "t" });
    await h.write("projects/-p/c1/subagents/agent-a2.meta.json", { agentType: "Explore" });
    await h.write("teams/t/config.json", { name: "t", leadSessionId: "c1", members: [] });
    await h.append("projects/-p/c2.jsonl", [agentCall(3)]);
    const r = await checkAgents(h.home, [
      { conv: "c1", bg: true, members: 2, subagents: 0 },
      { conv: "c2", bg: false, members: 1, subagents: 0 },
      { conv: "c3", bg: false, members: 1, subagents: 0 },
    ]);
    expect(r).toEqual([
      { floor: 1, bg: true, members: 2, subagents: 0, agentCalls: 2, folder: true, metas: 2, named: 1, team: true, missing: false },
      { floor: 2, bg: false, members: 1, subagents: 0, agentCalls: 1, folder: false, metas: 0, named: 0, team: false, missing: true },
      { floor: 3, bg: false, members: 1, subagents: 0, agentCalls: 0, folder: false, metas: 0, named: 0, team: false, missing: false },
    ]);
    expect(JSON.stringify(r)).not.toMatch(/c1|c2|dev|"t"/);
  });

  it("못 찾은 층이 있으면 진단 항목은 warn, 없으면 ok", () => {
    const base = { bg: false, members: 1, subagents: 0, agentCalls: 1, folder: false, metas: 0, named: 0, team: false };
    expect(agentsItem([{ ...base, floor: 1, missing: true }])).toMatchObject({ id: "agents", status: "warn" });
    expect(agentsItem([{ ...base, floor: 1, missing: false }])).toMatchObject({ id: "agents", status: "ok" });
  });
});
