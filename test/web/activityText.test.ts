import { describe, expect, it } from "vitest";
import type { Activity, Member } from "../../src/shared/types";
import { emptySum } from "../../src/shared/tokens";
import { activityLine, chars, clipEnd, clipMiddle, fileName, metaLine, squash } from "../../web/office/activityText";

const T = Date.parse("2026-10-01T05:00:00Z");
const member = (p: Partial<Member> = {}): Member => ({ name: "developer", role: "developer", state: "working", unread: 0, tokens: emptySum(), ...p });
const tool = (tool: string, target?: string, over: Partial<Activity> = {}): Member =>
  member({ activity: { kind: "tool", tool, ...(target === undefined ? {} : { target }), startedAt: new Date(T - 12_000).toISOString(), ...over } });

describe("자르기 (디자인 7.3)", () => {
  it("28자를 넘으면 끝을 줄인다", () => {
    expect(clipEnd("Run the full vitest suite with coverage")).toBe("Run the full vitest suite w…");
    expect(chars(clipEnd("Run the full vitest suite with coverage"))).toHaveLength(28);
    expect(clipEnd("짧은 문장")).toBe("짧은 문장");
  });

  it("파일 이름은 가운데를 줄여 확장자를 살린다", () => {
    expect(clipMiddle("2026-09-28-claude-office-design.md")).toBe("2026-09-28-cla…ice-design.md");
    expect(fileName("/Users/x/docs/2026-09-28-claude-office-design.md")).toBe("2026-09-28-claude-office-design.md");
    expect(fileName("C:\\x\\a.ts")).toBe("a.ts");
  });

  it("줄바꿈과 연속 공백은 공백 하나로", () => {
    expect(squash("  npm   run\n\ttest  ")).toBe("npm run test");
    expect(clipEnd("a\n\nb")).toBe("a b");
  });

  it("이모지와 결합 문자를 한 글자로 센다", () => {
    expect(chars("👩‍💻가é")).toHaveLength(3);
    const s = "👍🏽".repeat(40);
    const clipped = clipEnd(s);
    expect(chars(clipped)).toHaveLength(28);
    expect(clipped.endsWith("👍🏽…")).toBe(true);
  });

  it("Segmenter가 없으면 코드포인트 단위로 센다", () => {
    expect(chars("가👍🏽", undefined)).toHaveLength(3);
  });
});

describe("activityLine (디자인 7.2 표)", () => {
  it.each([
    [{ kind: "permission" }, "저는 지금 명령 실행 허락을 기다리고 있습니다"],
    [{ kind: "question" }, "저는 지금 질문에 대한 답을 기다리고 있습니다"],
    [{ kind: "plan" }, "저는 지금 계획 승인을 기다리고 있습니다"],
    [{ kind: "budget" }, "저는 지금 예산 추가 여부를 기다리고 있습니다"],
    [{ kind: "team" }, "저는 지금 팀 리드의 결정을 기다리고 있습니다"],
  ] as const)("결정 대기 %o", (decision, text) => {
    const l = activityLine(member({ state: "decision", decision: { ...decision, since: new Date(T).toISOString() } }));
    expect(l).toEqual({ icon: "ask", text, decision: true });
  });

  it("휴업", () => {
    expect(activityLine(member(), { paused: true })).toEqual({ icon: "pause", text: "저는 지금 휴업 중이라 쉬고 있습니다", decision: false });
  });

  it.each([
    ["Bash", "테스트 실행", "bash", "저는 지금 「테스트 실행」 명령을 실행하고 있습니다"],
    ["Edit", "/x/web/office/Desk.tsx", "edit", "저는 지금 「Desk.tsx」 파일을 고치고 있습니다"],
    ["MultiEdit", "/x/a.ts", "edit", "저는 지금 「a.ts」 파일을 고치고 있습니다"],
    ["NotebookEdit", "/x/n.ipynb", "edit", "저는 지금 「n.ipynb」 파일을 고치고 있습니다"],
    ["Write", "/x/README.md", "edit", "저는 지금 「README.md」 파일을 만들고 있습니다"],
    ["Read", "/x/SPEC.md", "read", "저는 지금 「SPEC.md」 파일을 읽고 있습니다"],
    ["Grep", "TODO", "search", "저는 지금 「TODO」 패턴을 찾고 있습니다"],
    ["Glob", "**/*.ts", "search", "저는 지금 「**/*.ts」 패턴을 찾고 있습니다"],
    ["WebSearch", "vitest timers", "web", "저는 지금 「vitest timers」 자료를 찾아보고 있습니다"],
    ["WebFetch", "code.claude.com", "web", "저는 지금 「code.claude.com」 페이지를 읽고 있습니다"],
    ["SendMessage", "reviewer", "team", "저는 지금 reviewer에게 메시지를 보내고 있습니다"],
    ["Agent", "코드 조사", "team", "저는 지금 「코드 조사」 일을 맡기고 있습니다"],
    ["Task", "코드 조사", "team", "저는 지금 「코드 조사」 일을 맡기고 있습니다"],
    ["mcp__github__create_issue", undefined, "bash", "저는 지금 「mcp__github__create_issue」 도구를 쓰고 있습니다"],
  ] as const)("%s", (name, target, icon, text) => {
    expect(activityLine(tool(name, target))).toEqual({ icon, text, decision: false });
  });

  it("대상이 필요한 도구인데 대상이 없으면 '그 밖의 도구' 틀을 쓴다", () => {
    expect(activityLine(tool("Bash")).text).toBe("저는 지금 「Bash」 도구를 쓰고 있습니다");
  });

  it("할 일 activeForm", () => {
    const m = member({ activity: { kind: "todo", target: "테스트 고치는 중", startedAt: new Date(T).toISOString() } });
    expect(activityLine(m)).toEqual({ icon: "read", text: "저는 지금 할 일 목록의 「테스트 고치는 중」 항목을 진행하고 있습니다", decision: false });
  });

  it("마지막 문장만 있음", () => {
    const m = member({ state: "idle", activity: { kind: "said", target: "다음은 리뷰입니다.", startedAt: new Date(T).toISOString() } });
    expect(activityLine(m)).toEqual({ icon: "team", text: "저는 방금 「다음은 리뷰입니다.」라고 말했습니다", decision: false });
  });

  it("읽지 않은 메시지는 마지막 문장보다 먼저다", () => {
    const m = member({ state: "mail", unread: 3, activity: { kind: "said", target: "x", startedAt: new Date(T).toISOString() } });
    expect(activityLine(m)).toEqual({ icon: "team", text: "저는 지금 읽지 않은 메시지가 3통 있습니다", decision: false });
  });

  it("대기와 퇴근", () => {
    expect(activityLine(member({ state: "idle" }))).toEqual({ icon: "wait", text: "저는 지금 다음 지시를 기다리고 있습니다", decision: false });
    const off = member({ state: "offline", activity: { kind: "tool", tool: "Bash", target: "x", startedAt: "t" } });
    expect(activityLine(off)).toEqual({ icon: "wait", text: "저는 퇴근했습니다", decision: false });
  });

  it("결정 대기가 휴업보다, 휴업이 도구보다 먼저다", () => {
    const d = member({ state: "decision", decision: { kind: "plan", since: "t" }, activity: { kind: "tool", tool: "Bash", target: "x", startedAt: "t" } });
    expect(activityLine(d, { paused: true }).icon).toBe("ask");
    expect(activityLine(tool("Bash", "x"), { paused: true }).icon).toBe("pause");
  });

  it("값이 길면 「」 안만 28자로 자른다", () => {
    const l = activityLine(tool("Bash", "Run the full vitest suite with coverage and retry"));
    expect(l.text).toBe("저는 지금 「Run the full vitest suite w…」 명령을 실행하고 있습니다");
  });
});

describe("metaLine (디자인 7.1)", () => {
  it("{모델} · 토큰 {n} · {경과}초째", () => {
    const m = { ...tool("Bash", "x"), model: "claude-opus-5-5", tokens: { ...emptySum(), total: 48_200 } };
    expect(metaLine(m, T)).toBe("claude-opus-5-5 · 토큰 48.2k · 12초째");
  });

  it("서브에이전트가 한 일이면 앞에 '서브에이전트' 또는 '서브에이전트({agent_type})' (디자인 7.1)", () => {
    expect(metaLine({ ...tool("Bash", "x", { sub: true }), model: "m" }, T)).toBe("서브에이전트 · m · 토큰 0 · 12초째");
    expect(metaLine({ ...tool("Bash", "x", { sub: true, subType: "Explore" }), model: "sonnet" }, T)).toBe("서브에이전트(Explore) · sonnet · 토큰 0 · 12초째");
  });

  it("모델이 없거나 활동이 없으면 그 부분을 뺀다. said는 경과를 쓰지 않는다", () => {
    expect(metaLine(member({ state: "idle" }), T)).toBe("토큰 0");
    expect(metaLine(member({ state: "idle", activity: { kind: "said", target: "x", startedAt: new Date(T - 5000).toISOString() } }), T)).toBe("토큰 0");
  });

  it("결정 대기와 퇴근", () => {
    expect(metaLine(member({ state: "decision", decision: { kind: "permission", since: "t" } }), T)).toBe("결정 보고서는 다음 버전에서 열립니다");
    expect(metaLine(member({ state: "offline" }), T)).toBe("");
  });
});
