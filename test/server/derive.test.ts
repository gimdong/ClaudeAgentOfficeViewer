import { describe, expect, it } from "vitest";
import { DECISION_TTL, deriveAgent, targetOf, TOOL_TTL } from "../../server/events/derive";
import type { StoredEvent } from "../../server/events/store";

const T0 = 1_790_000_000_000;
const iso = (ms: number) => new Date(ms).toISOString();
const ev = (event: string, at: number, over: Partial<StoredEvent> = {}): StoredEvent => ({ at, event, sub: false, summary: {}, ...over });
const bash = (at: number, over: Partial<StoredEvent> = {}) => ev("PreToolUse", at, { tool: "Bash", summary: { command: "npm test", description: "테스트 실행" }, ...over });

describe("targetOf", () => {
  it.each([
    ["Bash", { command: "ls", description: "목록" }, "목록"],
    ["Bash", { command: "ls" }, "ls"],
    ["Edit", { filePath: "/x/a.ts" }, "/x/a.ts"],
    ["MultiEdit", { filePath: "/x/b.ts" }, "/x/b.ts"],
    ["NotebookEdit", { filePath: "/x/c.ipynb" }, "/x/c.ipynb"],
    ["Write", { filePath: "/x/d.md" }, "/x/d.md"],
    ["Read", { filePath: "/x/e.md" }, "/x/e.md"],
    ["Grep", { pattern: "TODO" }, "TODO"],
    ["Glob", { pattern: "**/*.ts" }, "**/*.ts"],
    ["WebSearch", { query: "q" }, "q"],
    ["WebFetch", { domain: "example.com" }, "example.com"],
    ["SendMessage", { to: "reviewer" }, "reviewer"],
    ["Agent", { description: "조사" }, "조사"],
    ["Task", { description: "조사2" }, "조사2"],
    ["mcp__x__y", { command: "ignored" }, undefined],
  ] as const)("%s → %s", (tool, s, want) => {
    expect(targetOf(tool, s)).toBe(want);
  });
});

describe("deriveAgent: 진행 중인 도구", () => {
  it("짝 없는 Pre는 진행 중이다", () => {
    const d = deriveAgent([bash(T0, { toolUseId: "t1" })], T0 + 1000);
    expect(d.toolRunning).toBe(true);
    expect(d.activity).toEqual({ kind: "tool", tool: "Bash", target: "테스트 실행", startedAt: iso(T0) });
  });

  it("tool_use_id로 짝을 맞춘다(병렬 도구)", () => {
    const d = deriveAgent(
      [bash(T0, { toolUseId: "a" }), ev("PreToolUse", T0 + 1, { tool: "Read", toolUseId: "b", summary: { filePath: "/x/r.md" } }), ev("PostToolUse", T0 + 2, { tool: "Read", toolUseId: "b" })],
      T0 + 3,
    );
    expect(d.activity).toMatchObject({ tool: "Bash" });
  });

  it("tool_use_id가 없으면 다음 Post가 가장 오래된 Pre를 닫는다", () => {
    const d = deriveAgent([bash(T0), ev("PostToolUse", T0 + 1)], T0 + 2);
    expect(d.toolRunning).toBe(false);
    expect(d.activity).toBeUndefined();
  });

  it("짝 없는 Post는 무시한다", () => {
    const d = deriveAgent([ev("PostToolUse", T0, { toolUseId: "zzz" }), bash(T0 + 1, { toolUseId: "t1" })], T0 + 2);
    expect(d.toolRunning).toBe(true);
  });

  it("PostToolUseFailure와 PermissionDenied도 짝을 닫는다", () => {
    expect(deriveAgent([bash(T0, { toolUseId: "a" }), ev("PostToolUseFailure", T0 + 1, { toolUseId: "a" })], T0 + 2).toolRunning).toBe(false);
    expect(deriveAgent([bash(T0, { toolUseId: "a" }), ev("PermissionDenied", T0 + 1, { toolUseId: "a" })], T0 + 2).toolRunning).toBe(false);
  });

  it("10분이 지난 도구는 뺀다", () => {
    expect(deriveAgent([bash(T0)], T0 + TOOL_TTL).toolRunning).toBe(true);
    const d = deriveAgent([bash(T0)], T0 + TOOL_TTL + 1);
    expect(d.toolRunning).toBe(false);
    expect(d.activity).toBeUndefined();
  });

  it("Stop은 모두 닫고, 서브에이전트의 SubagentStop은 서브에이전트가 연 것만 닫는다", () => {
    expect(deriveAgent([bash(T0), ev("Stop", T0 + 1)], T0 + 2).toolRunning).toBe(false);
    const d = deriveAgent(
      [ev("PreToolUse", T0, { tool: "Agent", summary: { description: "조사" } }), bash(T0 + 1, { sub: true }), ev("SubagentStop", T0 + 2, { sub: true })],
      T0 + 3,
    );
    expect(d.activity).toMatchObject({ tool: "Agent", target: "조사" });
    expect(d.activity?.sub).toBeUndefined();
  });

  it("서브에이전트가 연 도구는 활동에 sub와 서브에이전트 타입 표시", () => {
    expect(deriveAgent([bash(T0, { sub: true, subType: "Explore" })], T0 + 1).activity).toMatchObject({ tool: "Bash", sub: true, subType: "Explore" });
    expect(deriveAgent([bash(T0, { sub: true })], T0 + 1).activity?.subType).toBeUndefined();
  });

  it("팀원의 SubagentStop·TeammateIdle은 턴 끝으로 본다", () => {
    expect(deriveAgent([bash(T0), ev("SubagentStop", T0 + 1)], T0 + 2).toolRunning).toBe(false);
    expect(deriveAgent([bash(T0), ev("TeammateIdle", T0 + 1)], T0 + 2).toolRunning).toBe(false);
  });
});

describe("deriveAgent: 할 일 activeForm", () => {
  const todo = (at: number, activeForm: string | null) => ev("PreToolUse", at, { tool: "TodoWrite", summary: { activeForm } });

  it("진행 중 도구가 없으면 activeForm을 활동으로 쓴다", () => {
    const d = deriveAgent([todo(T0, "테스트 고치는 중"), ev("PostToolUse", T0 + 1)], T0 + 2);
    expect(d.activity).toEqual({ kind: "todo", target: "테스트 고치는 중", startedAt: iso(T0) });
  });

  it("null이 오면 지운다", () => {
    const d = deriveAgent([todo(T0, "A"), ev("PostToolUse", T0 + 1), todo(T0 + 2, null), ev("PostToolUse", T0 + 3)], T0 + 4);
    expect(d.activity).toBeUndefined();
  });

  it("진행 중 도구가 있으면 도구가 먼저다", () => {
    const d = deriveAgent([todo(T0, "A"), ev("PostToolUse", T0 + 1), bash(T0 + 2)], T0 + 3);
    expect(d.activity?.kind).toBe("tool");
  });
});

describe("deriveAgent: 결정", () => {
  it("PermissionRequest → permission, summary는 명령", () => {
    const d = deriveAgent([bash(T0, { toolUseId: "a" }), ev("PermissionRequest", T0 + 1, { tool: "Bash", summary: { command: "rm -rf /tmp/fake" } })], T0 + 2);
    expect(d.decision).toEqual({ kind: "permission", since: iso(T0 + 1), summary: "rm -rf /tmp/fake" });
  });

  it("파일 도구의 권한 요청 summary는 파일 경로, 둘 다 없으면 도구 이름", () => {
    expect(deriveAgent([ev("PermissionRequest", T0, { tool: "Write", summary: { filePath: "/x/a.md" } })], T0).decision?.summary).toBe("/x/a.md");
    expect(deriveAgent([ev("PermissionRequest", T0, { tool: "mcp__x" })], T0).decision?.summary).toBe("mcp__x");
  });

  it("AskUserQuestion의 PreToolUse → question, 이어지는 같은 도구의 PermissionRequest가 종류를 바꾸지 않는다", () => {
    const d = deriveAgent(
      [ev("PreToolUse", T0, { tool: "AskUserQuestion", summary: { question: "어느 쪽?" } }), ev("PermissionRequest", T0 + 1, { tool: "AskUserQuestion", summary: { question: "어느 쪽?" } })],
      T0 + 2,
    );
    expect(d.decision).toEqual({ kind: "question", since: iso(T0), summary: "어느 쪽?" });
  });

  it("PermissionRequest만 온 AskUserQuestion도 question이다", () => {
    expect(deriveAgent([ev("PermissionRequest", T0, { tool: "AskUserQuestion", summary: { question: "Q" } })], T0).decision?.kind).toBe("question");
  });

  it("ExitPlanMode → plan", () => {
    expect(deriveAgent([ev("PreToolUse", T0, { tool: "ExitPlanMode" })], T0).decision).toEqual({ kind: "plan", since: iso(T0) });
  });

  it.each(["PostToolUse", "PostToolUseFailure", "PermissionDenied", "Stop"])("%s가 오면 내린다", (name) => {
    expect(deriveAgent([ev("PermissionRequest", T0, { tool: "Bash" }), ev(name, T0 + 1)], T0 + 2).decision).toBeUndefined();
  });

  it("이후의 새 PreToolUse가 오면 내린다", () => {
    expect(deriveAgent([ev("PermissionRequest", T0, { tool: "Bash" }), bash(T0 + 1)], T0 + 2).decision).toBeUndefined();
  });

  it("30분이 지나면 내린다", () => {
    const events = [ev("PermissionRequest", T0, { tool: "Bash" })];
    expect(deriveAgent(events, T0 + DECISION_TTL).decision).toBeDefined();
    expect(deriveAgent(events, T0 + DECISION_TTL + 1).decision).toBeUndefined();
  });

  it("서브에이전트의 SubagentStop은 리드 자신의 결정을 내리지 않는다", () => {
    expect(deriveAgent([ev("PermissionRequest", T0, { tool: "Bash" }), ev("SubagentStop", T0 + 1, { sub: true })], T0 + 2).decision?.kind).toBe("permission");
  });

  it("알 수 없는 이벤트는 무시한다", () => {
    expect(deriveAgent([ev("Whatever", T0), ev("Notification", T0 + 1)], T0 + 2)).toEqual({ toolRunning: false });
  });
});
