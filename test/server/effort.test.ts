import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventStore, lastEffort } from "../../server/events/store";
import { SnapshotBuilder } from "../../server/snapshot";
import { auraRow } from "../../web/themes/aura";
import { assistant, makeHome, type FakeHome } from "../helpers/fakeHome";

// Phase 7 Task 4: 노력 정도(hook 입력 effort.level, #646). 리드·팀원마다 그 멤버의 마지막 v2 이벤트 중 값이 있는 것
const NOW = Date.now();
let h: FakeHome;
beforeEach(async () => {
  h = await makeHome();
});
afterEach(() => h.cleanup());

const ev = (o: object) => ({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Read", ...o });

describe("EventStore·lastEffort", () => {
  it("/hooks/v2 이벤트의 effort.level만 담고, 옛 입구·알 수 없는 값·숫자는 버린다(이전 값 유지)", () => {
    const s = new EventStore();
    s.add(ev({ effort: { level: "high" } }), NOW - 400, true);
    s.add(ev({ effort: { level: "max" } }), NOW - 300); // 옛 /hooks/event
    s.add(ev({ effort: { level: "turbo" } }), NOW - 200, true);
    s.add(ev({ effort: { level: 3 } }), NOW - 100, true);
    s.add(ev({}), NOW - 50, true);
    expect(lastEffort(s.agents("s1").get("team-lead") ?? [])).toBe("high");
    s.add(ev({ effort: { level: "xhigh" } }), NOW, true);
    expect(lastEffort(s.agents("s1").get("team-lead") ?? [])).toBe("xhigh");
  });

  it("서브에이전트 이벤트의 값은 리드 것이 아니다", () => {
    const s = new EventStore();
    s.add(ev({ effort: { level: "low" } }), NOW - 100, true);
    s.add(ev({ effort: { level: "max" }, agent_id: "a0123456789abcdef", agent_type: "Explore" }), NOW, true);
    expect(lastEffort(s.agents("s1").get("team-lead") ?? [])).toBe("low");
  });
});

describe("스냅샷 Member.effort", () => {
  it("리드와 팀원에 각자의 마지막 값을 싣고, 값이 없으면 싣지 않는다", async () => {
    await h.write("sessions/100.json", { pid: 100, sessionId: "s1", name: "alpha", cwd: "/x", status: "busy", updatedAt: NOW - 1000 });
    await h.append("projects/-p/s1.jsonl", [assistant({ requestId: "r1", ts: NOW - 5000, input: 10, output: 5 })]);
    await h.write("teams/t/config.json", { name: "t", leadSessionId: "s1", members: [{ name: "team-lead", agentType: "team-lead" }, { name: "developer", agentType: "general-purpose" }, { name: "reviewer", agentType: "general-purpose" }] });
    const events = new EventStore();
    events.add(ev({ effort: { level: "high" } }), NOW - 500, true);
    events.add(ev({ effort: { level: "low" }, agent_id: "adeveloper-1a2b3c", agent_type: "developer" }), NOW - 400, true);
    const snap = await new SnapshotBuilder({ claudeHome: h.home, config: { budget: {}, contextWindows: {} }, isAlive: () => true, events }).build(NOW);
    const members = snap.sessions.find((s) => s.id === "s1")!.members;
    expect(Object.fromEntries(members.map((m) => [m.name, m.effort]))).toEqual({ "team-lead": "high", developer: "low", reviewer: undefined });
    expect("effort" in members.find((m) => m.name === "reviewer")!).toBe(false);
  });
});

describe("auraRow(오라 단계, #646 판정)", () => {
  it("low 1, medium 2, high 3, xhigh·max 4, 없음 1", () => {
    expect([auraRow("low"), auraRow("medium"), auraRow("high"), auraRow("xhigh"), auraRow("max"), auraRow(undefined)]).toEqual([1, 2, 3, 4, 4, 1]);
  });
});
