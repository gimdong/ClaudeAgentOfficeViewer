import { describe, expect, it } from "vitest";
import { EXEMPT_TOOLS, GROUP_KEYS, GROUPS, VALUE_LABELS, groupOf, isGroup, isValue, ruleLabel } from "../../server/policy/tools";

describe("policy tools", () => {
  it.each([
    ["Bash", "bash"],
    ["Edit", "edit"],
    ["Write", "edit"],
    ["NotebookEdit", "edit"],
    ["MultiEdit", "edit"],
    ["WebFetch", "web"],
    ["WebSearch", "web"],
    ["Agent", "agent"],
    ["Task", "agent"],
    ["mcp__srv__tool", "mcp"],
    ["mcp__", "mcp"],
    ["Read", "other"],
    ["Grep", "other"],
    ["Glob", "other"],
    ["TodoWrite", "other"],
    ["ToolSearch", "other"],
    ["모르는이름", "other"],
  ])("묶음 표(스펙 5.2): %s → %s", (tool, group) => {
    expect(groupOf(tool)).toBe(group);
  });

  it("빼는 도구 아홉 개는 null(B94, TaskStop은 사용자 결정 2026-10-11)", () => {
    const exempt = ["AskUserQuestion", "ExitPlanMode", "SendMessage", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "SubagentHandback", "TaskStop"];
    for (const t of exempt) expect(groupOf(t)).toBeNull();
    expect(EXEMPT_TOOLS.size).toBe(9);
    expect(EXEMPT_TOOLS.has("ToolSearch")).toBe(false);
  });

  it("이름은 대소문자를 가린다", () => {
    expect(groupOf("bash")).toBe("other");
    expect(groupOf("MCP__x")).toBe("other");
  });

  it("groupOf는 all을 돌려주지 않는다, GROUP_KEYS는 일곱 개이고 all이 마지막", () => {
    for (const t of ["Bash", "x", "mcp__a", "all", "All"]) expect(groupOf(t)).not.toBe("all");
    expect(GROUP_KEYS).toEqual(["bash", "edit", "web", "agent", "mcp", "other", "all"]);
  });

  it("화면 이름과 규칙 이름(B92)", () => {
    expect(GROUP_KEYS.map((g) => GROUPS[g].label)).toEqual(["명령 실행", "파일 고치기", "웹 접근", "팀원·서브에이전트 만들기", "외부 도구(MCP)", "그 밖의 도구", "모든 도구"]);
    expect(VALUE_LABELS).toEqual({ ask: "항상 질문", deny: "금지" });
    expect(ruleLabel("bash", "deny")).toBe("명령 실행 금지");
    expect(ruleLabel("all", "ask")).toBe("모든 도구 항상 질문");
  });

  it("isGroup·isValue", () => {
    expect(isValue("ask")).toBe(true);
    expect(isValue("deny")).toBe(true);
    expect(isValue("allow")).toBe(false);
    expect(isValue("Deny")).toBe(false);
    expect(isGroup("bash")).toBe(true);
    expect(isGroup("all")).toBe(true);
    expect(isGroup("__proto__")).toBe(false);
    expect(isGroup("constructor")).toBe(false);
    expect(isGroup("toString")).toBe(false);
  });
});
