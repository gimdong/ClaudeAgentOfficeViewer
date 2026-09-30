import { describe, expect, it } from "vitest";
import { agentOf, MAX_FIELD, summarize } from "../../server/events/summarize";

describe("summarize", () => {
  it("필요한 필드만 남기고 나머지는 버린다", () => {
    const s = summarize("Write", { file_path: "/tmp/fake/a.ts", content: "SECRET-LIKE-CONTENT", extra: 1 });
    expect(s).toEqual({ filePath: "/tmp/fake/a.ts" });
    expect(JSON.stringify(s)).not.toContain("SECRET-LIKE-CONTENT");
  });

  it("Bash의 command·description, 검색·웹·메시지 필드", () => {
    expect(summarize("Bash", { command: "npm test", description: "Run tests" })).toEqual({ command: "npm test", description: "Run tests" });
    expect(summarize("Grep", { pattern: "TODO", path: "/x" })).toEqual({ pattern: "TODO" });
    expect(summarize("WebSearch", { query: "vitest fake timers" })).toEqual({ query: "vitest fake timers" });
    expect(summarize("WebFetch", { url: "https://code.claude.com/docs/en/hooks?x=1", prompt: "p" })).toEqual({ domain: "code.claude.com" });
    expect(summarize("SendMessage", { to: "reviewer", message: "hello" })).toEqual({ to: "reviewer" });
    expect(summarize("NotebookEdit", { notebook_path: "/tmp/fake/n.ipynb" })).toEqual({ filePath: "/tmp/fake/n.ipynb" });
  });

  it("질문 도구는 첫 질문 텍스트만 남긴다", () => {
    const s = summarize("AskUserQuestion", { questions: [{ question: "어느 쪽?", options: [{ label: "A" }] }, { question: "둘째" }] });
    expect(s).toEqual({ question: "어느 쪽?" });
  });

  it("문자열은 200자에서 자르고, 잘린 곳에서 글자를 깨뜨리지 않는다", () => {
    const long = "가".repeat(150) + "😀".repeat(100);
    const s = summarize("Bash", { command: long });
    expect(Array.from(s.command!)).toHaveLength(MAX_FIELD);
    expect(s.command!.endsWith("😀")).toBe(true);
  });

  it("URL이 잘못되었거나 입력이 객체가 아니면 해당 필드를 비운다", () => {
    expect(summarize("WebFetch", { url: "not a url" })).toEqual({});
    expect(summarize("Bash", null)).toEqual({});
    expect(summarize("Bash", "string")).toEqual({});
    expect(summarize("Bash", [1, 2])).toEqual({});
    expect(summarize("Bash", { command: 42, description: "  " })).toEqual({});
  });

  it("TodoWrite: 진행 중 항목의 activeForm, 없으면 null(지움)", () => {
    expect(summarize("TodoWrite", { todos: [{ status: "completed", activeForm: "A" }, { status: "in_progress", activeForm: "테스트 고치는 중" }] })).toEqual({ activeForm: "테스트 고치는 중" });
    expect(summarize("TodoWrite", { todos: [{ status: "pending", activeForm: "B" }] })).toEqual({ activeForm: null });
  });

  it("TaskUpdate: in_progress면 activeForm, completed/deleted면 null, 그 밖은 없음. TaskCreate는 쓰지 않는다", () => {
    expect(summarize("TaskUpdate", { status: "in_progress", activeForm: "빌드 확인 중" })).toEqual({ activeForm: "빌드 확인 중" });
    expect(summarize("TaskUpdate", { status: "completed" })).toEqual({ activeForm: null });
    expect(summarize("TaskUpdate", { status: "deleted" })).toEqual({ activeForm: null });
    expect(summarize("TaskUpdate", { status: "pending", activeForm: "X" })).toEqual({});
    expect(summarize("TaskCreate", { subject: "s", activeForm: "만드는 중" })).toEqual({});
  });
});

describe("redact (Ruling P9)", () => {
  it("Authorization/Bearer: 키워드는 남기고 값만 가린다", () => {
    const s = summarize("Bash", { command: 'curl -H "Authorization: Bearer FAKE_TOKEN_123"' });
    expect(s.command).toBe('curl -H "Authorization: Bearer ***"');
  });

  it("NAME=값 형태의 비밀값은 이름은 남기고 값만 가린다", () => {
    const s = summarize("Bash", { command: "export GITHUB_TOKEN=ghp_FAKEFAKEFAKE1234" });
    expect(s.command).toBe("export GITHUB_TOKEN=***");
  });

  it("접두어 형식 토큰은 단독으로 나와도 통째로 가린다", () => {
    expect(summarize("Bash", { command: "aws configure set aws_access_key_id AKIAFAKEFAKE1234" }).command).toBe(
      "aws configure set aws_access_key_id ***",
    );
    expect(summarize("Bash", { command: "echo sk-FAKE12345678" }).command).toBe("echo ***");
  });

  it("URL의 사용자:비밀번호는 가린다", () => {
    const s = summarize("Bash", { command: "psql postgres://u:FAKEPASS@h/db" });
    expect(s.command).toBe("psql postgres://***@h/db");
  });

  it("흔한 비밀 형식이 없는 명령은 그대로 둔다", () => {
    expect(summarize("Bash", { command: "npm test" }).command).toBe("npm test");
    expect(summarize("Bash", { command: "ls -la" }).command).toBe("ls -la");
  });

  it("200자로 자르기 전에 가려서 잘린 자리에 원문 조각이 남지 않는다", () => {
    const filler = "x".repeat(150);
    const secret = "ghp_" + "F".repeat(36); // 접두어 + 36자, 이 예시에선 이름이 없어 접두어 규칙으로 가려진다
    const raw = `${filler} GITHUB_TOKEN=${secret}`;
    expect(raw.length).toBeGreaterThan(MAX_FIELD);
    const s = summarize("Bash", { command: raw });
    expect(s.command).toBe(`${filler} GITHUB_TOKEN=***`);
    expect(s.command).not.toContain("FFFFFF");
  });
});

describe("agentOf", () => {
  it("agent_id가 없으면 리드", () => {
    expect(agentOf({ hook_event_name: "PreToolUse" })).toEqual({ name: "team-lead", sub: false });
  });

  it("팀원은 agent_type이 이름이다", () => {
    expect(agentOf({ hook_event_name: "PreToolUse", agent_id: "aquill-4794329a4ffe20f7", agent_type: "quill" })).toEqual({ name: "quill", sub: false });
  });

  it("TeammateIdle은 teammate_name", () => {
    expect(agentOf({ hook_event_name: "TeammateIdle", teammate_name: "ember", team_name: "t" })).toEqual({ name: "ember", sub: false });
    expect(agentOf({ hook_event_name: "TeammateIdle" })).toBeNull();
  });

  it("일반 서브에이전트(a<16진수>)는 리드에 합치고 타입을 남긴다", () => {
    expect(agentOf({ hook_event_name: "PreToolUse", agent_id: "a4916735360554fcf", agent_type: "general-purpose" })).toEqual({ name: "team-lead", sub: true, subType: "general-purpose" });
    expect(agentOf({ hook_event_name: "PreToolUse", agent_id: "a4916735360554fcf" })).toEqual({ name: "team-lead", sub: true });
  });

  it("agent_type이 빈 SubagentStart/SubagentStop은 무시한다", () => {
    expect(agentOf({ hook_event_name: "SubagentStop", agent_id: "a0123456789abcdef", agent_type: "" })).toBeNull();
    expect(agentOf({ hook_event_name: "SubagentStart", agent_id: "aabcdef0123456789", agent_type: "" })).toBeNull();
  });

  it("agent_id가 서브에이전트 모양이 아닌데 agent_type이 비면 무시한다", () => {
    expect(agentOf({ hook_event_name: "PreToolUse", agent_id: "ax-1", agent_type: "" })).toBeNull();
  });
});
