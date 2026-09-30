import { describe, expect, it } from "vitest";
import { EventStore, PER_AGENT } from "../../server/events/store";

const T0 = 1_790_000_000_000;
const DAY = 86_400_000;
const pre = (over: Record<string, unknown> = {}) => ({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Bash", tool_input: { command: "echo fake" }, ...over });

describe("EventStore", () => {
  it("에이전트마다 따로 저장하고 오래된 것이 앞에 온다", () => {
    const st = new EventStore();
    expect(st.add(pre({ tool_use_id: "t1" }), T0)).toBe(true);
    expect(st.add(pre({ agent_id: "aquill-1", agent_type: "quill" }), T0 + 1)).toBe(true);
    expect(st.add({ hook_event_name: "PostToolUse", session_id: "s1", tool_name: "Bash", tool_use_id: "t1" }, T0 + 2)).toBe(true);
    const agents = st.agents("s1");
    expect([...agents.keys()].sort()).toEqual(["quill", "team-lead"]);
    expect(agents.get("team-lead")!.map((e) => e.event)).toEqual(["PreToolUse", "PostToolUse"]);
    expect(agents.get("team-lead")![0]).toEqual({ at: T0, event: "PreToolUse", sub: false, tool: "Bash", toolUseId: "t1", summary: { command: "echo fake" } });
  });

  it("원형 버퍼: 에이전트마다 최근 20개만 남긴다", () => {
    const st = new EventStore();
    for (let i = 0; i < 25; i++) st.add(pre({ tool_input: { command: `cmd-${i}` } }), T0 + i);
    const list = st.agents("s1").get("team-lead")!;
    expect(list).toHaveLength(PER_AGENT);
    expect(list[0].summary.command).toBe("cmd-5");
    expect(list.at(-1)!.summary.command).toBe("cmd-24");
  });

  it("큰 Write 입력도 요약만 남는다", () => {
    const st = new EventStore();
    const content = "x".repeat(900_000);
    st.add(pre({ tool_name: "Write", tool_input: { file_path: "/tmp/fake/big.txt", content } }), T0);
    const e = st.agents("s1").get("team-lead")![0];
    expect(e.summary).toEqual({ filePath: "/tmp/fake/big.txt" });
    expect(JSON.stringify(e).length).toBeLessThan(500);
  });

  it("서브에이전트 이벤트는 리드에 sub로 붙는다", () => {
    const st = new EventStore();
    st.add(pre({ agent_id: "a4916735360554fcf", agent_type: "general-purpose" }), T0);
    expect(st.agents("s1").get("team-lead")![0]).toMatchObject({ sub: true, subType: "general-purpose" });
  });

  it("agent_type이 빈 SubagentStop과 필수 필드가 없는 입력은 저장하지 않는다", () => {
    const st = new EventStore();
    expect(st.add({ hook_event_name: "SubagentStop", session_id: "s1", agent_id: "a0123456789abcdef", agent_type: "" }, T0)).toBe(false);
    expect(st.add({ hook_event_name: "PreToolUse" }, T0)).toBe(false);
    expect(st.sessionCount()).toBe(0);
  });

  it("세션이 끝나고 24시간이 지나면 버린다", () => {
    const st = new EventStore();
    st.add(pre(), T0);
    st.add({ hook_event_name: "SessionEnd", session_id: "s1" }, T0 + 1000);
    st.prune(T0 + 1000 + DAY);
    expect(st.sessionCount()).toBe(1);
    st.prune(T0 + 1001 + DAY);
    expect(st.sessionCount()).toBe(0);
  });

  it("SessionEnd가 없어도 마지막 이벤트 뒤 24시간이 지나면 버리고, 최근 세션은 남긴다", () => {
    const st = new EventStore();
    st.add(pre({ session_id: "old" }), T0);
    st.add(pre({ session_id: "new" }), T0 + DAY);
    st.prune(T0 + DAY + 1);
    expect(st.agents("old").size).toBe(0);
    expect(st.agents("new").size).toBe(1);
  });
});
