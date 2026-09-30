import { describe, expect, it } from "vitest";
import { DECISION_TTL, deriveAgent, lastSentence, targetOf, TOOL_TTL } from "../../server/events/derive";
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

describe("deriveAgent: 결정을 특정 Pre에 묶기 (Ruling P12)", () => {
  it("재현(1): 무관한 도구(Read)의 Post로 결정이 내려가지 않는다", () => {
    const events = [
      ev("PreToolUse", T0, { tool: "Bash", toolUseId: "a", summary: { command: "rm -rf /tmp/fake" } }),
      ev("PreToolUse", T0 + 1, { tool: "Read", toolUseId: "b", summary: { filePath: "/x/r.md" } }),
      ev("PermissionRequest", T0 + 2, { tool: "Bash", summary: { command: "rm -rf /tmp/fake" } }),
      ev("PostToolUse", T0 + 3, { tool: "Read", toolUseId: "b" }),
    ];
    expect(deriveAgent(events, T0 + 4).decision).toEqual({ kind: "permission", since: iso(T0 + 2), summary: "rm -rf /tmp/fake" });
  });

  it("재현(2): 리드의 결정이 백그라운드 서브에이전트 도구 호출로 내려가지 않는다", () => {
    const events = [
      ev("PreToolUse", T0, { tool: "Bash", toolUseId: "pub", summary: { command: "npm publish" } }),
      ev("PermissionRequest", T0 + 1, { tool: "Bash", summary: { command: "npm publish" } }),
      ev("PreToolUse", T0 + 2, { tool: "Grep", toolUseId: "g", sub: true, summary: { pattern: "TODO" } }),
      ev("PostToolUse", T0 + 3, { tool: "Grep", toolUseId: "g", sub: true }),
    ];
    expect(deriveAgent(events, T0 + 4).decision?.kind).toBe("permission");
  });

  it("재현(3): 질문 결정이 뒤이은 다른 도구의 Pre/Post로 내려가지 않는다", () => {
    const events = [
      ev("PreToolUse", T0, { tool: "AskUserQuestion", summary: { question: "어느 쪽?" } }),
      ev("PreToolUse", T0 + 1, { tool: "Read", toolUseId: "r", summary: { filePath: "/x/r.md" } }),
      ev("PostToolUse", T0 + 2, { tool: "Read", toolUseId: "r" }),
    ];
    expect(deriveAgent(events, T0 + 3).decision).toEqual({ kind: "question", since: iso(T0), summary: "어느 쪽?" });
  });

  it("묶인 Pre의 Post(같은 tool_use_id)가 오면 내린다", () => {
    const events = [
      ev("PreToolUse", T0, { tool: "Bash", toolUseId: "a", summary: { command: "npm test" } }),
      ev("PermissionRequest", T0 + 1, { tool: "Bash", summary: { command: "npm test" } }),
      ev("PostToolUse", T0 + 2, { tool: "Bash", toolUseId: "a" }),
    ];
    expect(deriveAgent(events, T0 + 3).decision).toBeUndefined();
  });

  it("묶인 Pre가 닫힌 뒤 새 Pre가 오면 내린다(이미 닫혀서)", () => {
    const events = [
      ev("PreToolUse", T0, { tool: "Bash", toolUseId: "a", summary: { command: "npm test" } }),
      ev("PermissionRequest", T0 + 1, { tool: "Bash", summary: { command: "npm test" } }),
      ev("PostToolUse", T0 + 2, { tool: "Bash", toolUseId: "a" }),
      ev("PreToolUse", T0 + 3, { tool: "Bash", toolUseId: "c", summary: { command: "ls" } }),
    ];
    expect(deriveAgent(events, T0 + 4).decision).toBeUndefined();
  });

  it("병렬 Bash 두 개 중 명령이 일치하는 쪽에 묶이고, 다른 쪽의 Post로는 안 내려간다", () => {
    const events = [
      ev("PreToolUse", T0, { tool: "Bash", toolUseId: "a", summary: { command: "cmd1" } }),
      ev("PreToolUse", T0 + 1, { tool: "Bash", toolUseId: "b", summary: { command: "cmd2" } }),
      ev("PermissionRequest", T0 + 2, { tool: "Bash", summary: { command: "cmd2" } }),
      ev("PostToolUse", T0 + 3, { tool: "Bash", toolUseId: "a" }), // 관련 없는 첫 번째 Bash가 먼저 끝남
    ];
    expect(deriveAgent(events, T0 + 4).decision).toEqual({ kind: "permission", since: iso(T0 + 2), summary: "cmd2" });
  });
});

describe("deriveAgent: UserPromptSubmit과 재요청 (Ruling P13)", () => {
  it("UserPromptSubmit은 이전 결정과 진행 중 도구를 지운다", () => {
    const events = [
      bash(T0, { toolUseId: "a" }),
      ev("PermissionRequest", T0 + 1, { tool: "Bash", summary: { command: "npm test" } }),
      ev("UserPromptSubmit", T0 + 2),
    ];
    const d = deriveAgent(events, T0 + 3);
    expect(d.decision).toBeUndefined();
    expect(d.toolRunning).toBe(false);
  });

  it("서브에이전트의 UserPromptSubmit은 무시한다(턴 시작이 아니다)", () => {
    const events = [
      bash(T0, { toolUseId: "a" }),
      ev("PermissionRequest", T0 + 1, { tool: "Bash", summary: { command: "npm test" } }),
      ev("UserPromptSubmit", T0 + 2, { sub: true }),
    ];
    const d = deriveAgent(events, T0 + 3);
    expect(d.toolRunning).toBe(true);
    expect(d.decision?.kind).toBe("permission");
  });

  it("같은 도구의 두 번째 권한 요청은 새 호출에 묶이고 그 Post로 내려간다", () => {
    const events = [
      ev("PreToolUse", T0, { tool: "Write", toolUseId: "a", summary: { filePath: "/x/a.md" } }),
      ev("PermissionRequest", T0 + 1, { tool: "Write", summary: { filePath: "/x/a.md" } }),
      ev("PreToolUse", T0 + 2, { tool: "Write", toolUseId: "b", summary: { filePath: "/x/b.md" } }),
      ev("PermissionRequest", T0 + 3, { tool: "Write", summary: { filePath: "/x/b.md" } }),
      ev("PostToolUse", T0 + 4, { tool: "Write", toolUseId: "b" }),
    ];
    expect(deriveAgent(events, T0 + 5).decision).toBeUndefined();
  });

  it("허용 흐름(Pre→PermissionRequest→Notification→Post)에서 Post 직후 내려간다", () => {
    const events = [
      ev("PreToolUse", T0, { tool: "Write", toolUseId: "toolu_ok", summary: { filePath: "/x/ok.md" } }),
      ev("PermissionRequest", T0 + 1, { tool: "Write", summary: { filePath: "/x/ok.md" } }),
      ev("Notification", T0 + 2),
      ev("PostToolUse", T0 + 3, { tool: "Write", toolUseId: "toolu_ok" }),
    ];
    expect(deriveAgent(events, T0 + 4).decision).toBeUndefined();
  });

  it("실측 순서 회귀: 거부(아무 이벤트 없음) 뒤 UserPromptSubmit으로 리셋되고, 재시도가 새로 묶인다", () => {
    const events = [
      ev("PreToolUse", T0, { tool: "Write", toolUseId: "toolu_FAKE1", summary: { filePath: "/x/fake.md" } }),
      ev("PermissionRequest", T0 + 1, { tool: "Write", summary: { filePath: "/x/fake.md" } }),
      // 거부: 아무 이벤트도 오지 않는다(reviewer 실측)
      ev("UserPromptSubmit", T0 + 2),
      ev("PreToolUse", T0 + 3, { tool: "Write", toolUseId: "toolu_FAKE2", summary: { filePath: "/x/fake.md" } }),
      ev("PermissionRequest", T0 + 4, { tool: "Write", summary: { filePath: "/x/fake.md" } }),
      ev("Notification", T0 + 5),
      ev("PostToolUse", T0 + 6, { tool: "Write", toolUseId: "toolu_FAKE2" }),
      ev("Stop", T0 + 7),
    ];
    const kinds = events.map((_, i) => deriveAgent(events.slice(0, i + 1), T0 + 8).decision?.kind);
    expect(kinds).toEqual([
      undefined, // Pre(FAKE1)
      "permission", // PermissionRequest(FAKE1)
      undefined, // UserPromptSubmit
      undefined, // Pre(FAKE2)
      "permission", // PermissionRequest(FAKE2) — FAKE2에 새로 묶임
      "permission", // Notification
      undefined, // PostToolUse(FAKE2)
      undefined, // Stop
    ]);
  });
});

describe("lastSentence", () => {
  const a = (text: string) => ({ type: "assistant", message: { content: [{ type: "tool_use" }, { type: "text", text }] } });
  it("assistant 텍스트의 마지막 문장", () => {
    expect(lastSentence(a("첫 문장입니다. 둘째 문장입니다."))).toBe("둘째 문장입니다.");
    expect(lastSentence(a("줄 하나\n\n줄 둘"))).toBe("줄 둘");
  });
  it("assistant가 아니거나 텍스트가 없으면 undefined, 200자로 자른다", () => {
    expect(lastSentence({ type: "user", message: { content: [{ type: "text", text: "x" }] } })).toBeUndefined();
    expect(lastSentence({ type: "assistant", message: { content: [{ type: "tool_use" }] } })).toBeUndefined();
    expect(lastSentence(undefined)).toBeUndefined();
    expect(Array.from(lastSentence(a("가".repeat(300)))!)).toHaveLength(200);
  });

  it("마지막 문장의 흔한 토큰 형식은 가린다(Ruling P14)", () => {
    expect(lastSentence(a("토큰은 ghp_FAKEFAKEFAKE1234567890 입니다."))).toBe("토큰은 *** 입니다.");
    expect(lastSentence(a("export GITHUB_TOKEN=FAKE_TOKEN_123 로 설정하세요"))).toBe("export GITHUB_TOKEN=*** 로 설정하세요");
  });

  it("가림이 200자 자르기보다 먼저 적용된다(긴 문장 끝의 토큰)", () => {
    const filler = "lorem ".repeat(30); // 180자, 공백으로 끊겨 32자 연속 규칙에 안 걸림
    const secret = "ghp_" + "F".repeat(36);
    const text = `${filler}GITHUB_TOKEN=${secret}`;
    expect(text.length).toBeGreaterThan(200);
    expect(lastSentence(a(text))).toBe(`${filler}GITHUB_TOKEN=***`);
  });

  it("코드 블록으로 끝나면 그 앞 문장을 고른다(Ruling P15)", () => {
    expect(lastSentence(a("다음 코드입니다:\n```ts\nconst x = 1;\n```"))).toBe("다음 코드입니다:");
  });

  it("표로 끝나면 그 앞 문장을 고른다(Ruling P15)", () => {
    expect(lastSentence(a("결과는 다음과 같습니다.\n| A | B |\n| 1 | 2 |"))).toBe("결과는 다음과 같습니다.");
  });

  it("코드만 있으면 undefined", () => {
    expect(lastSentence(a("```ts\nconst x = 1;\n```"))).toBeUndefined();
  });
});
