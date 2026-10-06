import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLAIM_MS } from "../../server/budget/gate";
import { policyAskReason, policyDenyReason, preToolAsk, preToolDeny } from "../../server/decisions/protocol";
import { Logger, setLogger } from "../../server/log";
import { MAX_COUNT_KEYS, POLICY_DENIED_SHOW_MS, PolicyGate, agentKeyOf, memberKeyOf } from "../../server/policy/gate";
import { PolicyStore } from "../../server/policy/store";
import type { PolicyRules } from "../../src/shared/types";

const SUB_ID = "a1b2c3d4e5f6a7b8";
let dir: string;
let logDir: string;
let clock: number;
let store: PolicyStore;

type PreOpts = { tool?: unknown; agentId?: string; agentType?: string; session?: string; input?: unknown; promptId?: string; event?: string };
const pre = (o: PreOpts = {}): Record<string, unknown> => ({
  hook_event_name: o.event ?? "PreToolUse",
  session_id: o.session ?? "s1",
  tool_name: "tool" in o ? o.tool : "Bash",
  tool_input: "input" in o ? o.input : { command: "FAKE-CMD-123" },
  ...(o.agentId ? { agent_id: o.agentId } : {}),
  ...(o.agentType ? { agent_type: o.agentType } : {}),
  ...(o.promptId ? { prompt_id: o.promptId } : {}),
});
const perm = (o: PreOpts = {}) => pre({ ...o, event: "PermissionRequest" });
const teammate = (name: string, o: PreOpts = {}) => pre({ agentId: `a${name}-12ab`, agentType: name, ...o });
const sub = (type: string | undefined, o: PreOpts = {}) => pre({ agentId: SUB_ID, ...(type ? { agentType: type } : {}), ...o });

const policy = (targets: Record<string, PolicyRules>) => {
  for (const [k, r] of Object.entries(targets)) store.set(k, r);
};
const gate = (o: { onChange?: () => void } = {}) => new PolicyGate(store, { now: () => clock, ...o });
const logText = () => (existsSync(logDir) ? readdirSync(logDir).map((f) => readFileSync(join(logDir, f), "utf8")).join("") : "");
const policyLines = () =>
  logText()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { level: string; src: string; msg: string; data?: Record<string, unknown> })
    .filter((l) => l.src === "policy");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "co-pgate-"));
  logDir = join(dir, "logs");
  clock = Date.UTC(2026, 9, 7);
  setLogger(new Logger({ dir: logDir, now: () => clock }));
  store = new PolicyStore(join(dir, "policy.json"));
  store.load();
});
afterEach(() => {
  setLogger(new Logger({ dir: "" }));
  rmSync(dir, { recursive: true, force: true });
});

describe("agentKeyOf(B75)", () => {
  it("리드, 팀원, 서브에이전트", () => {
    expect(agentKeyOf(pre())).toEqual({ key: "lead", kind: "lead", who: "리드", name: "team-lead" });
    expect(agentKeyOf(teammate("rev"))).toEqual({ key: "agent:rev", kind: "agent", who: "rev", name: "rev" });
    expect(agentKeyOf(sub("Explore"))).toEqual({ key: "sub:Explore", kind: "sub", who: "서브에이전트(Explore)", name: "team-lead", subType: "Explore" });
    expect(agentKeyOf(sub(undefined))).toEqual({ key: "others", kind: "others", who: "서브에이전트", name: "team-lead" });
  });

  it("대상 이름 규칙에 안 맞는 팀원은 others", () => {
    const long = "가".repeat(101);
    expect(agentKeyOf(teammate(long))?.key).toBe("others");
    expect(agentKeyOf(teammate(long))?.kind).toBe("others");
    expect(agentKeyOf(teammate("__proto__"))?.key).toBe("others");
  });

  it("agentOf가 null이면 null", () => {
    expect(agentKeyOf(pre({ agentId: "arev-12ab" }))).toBeNull();
  });

  it("who는 100자(그래핌)로 잘린다", () => {
    expect(agentKeyOf(teammate("가".repeat(150)))?.who).toBe("가".repeat(100));
    expect(agentKeyOf(sub("나".repeat(150)))?.who).toBe(`서브에이전트(${"나".repeat(100)})`);
  });

  it("team-lead라는 이름의 팀원은 agent:team-lead다(agent_id 유무로 가른다)", () => {
    expect(agentKeyOf(teammate("team-lead"))?.key).toBe("agent:team-lead");
  });
});

describe("memberKeyOf", () => {
  it("agentKeyOf와 같은 키를 준다", () => {
    expect(memberKeyOf("x", true)).toBe("lead");
    expect(memberKeyOf("team-lead", true)).toBe("lead");
    expect(memberKeyOf("rev", false)).toBe("agent:rev");
    expect(memberKeyOf("가".repeat(101), false)).toBe("others");
    expect(memberKeyOf("__proto__", false)).toBe("others");
    for (const name of ["rev", "team-lead", "가".repeat(100), "가".repeat(101), "__proto__", "a b", " a", "a:b", "한글 이름"]) {
      expect(memberKeyOf(name, false)).toBe(agentKeyOf(teammate(name))?.key);
    }
  });
});

describe("PolicyGate.preToolUse", () => {
  it("규칙이 없으면 null", () => {
    expect(gate().preToolUse(pre())).toBeNull();
  });

  it("규칙이 있으면 묶음 규칙 → all 순서로 본다", () => {
    policy({ lead: { bash: "ask", all: "deny" } });
    const g = gate();
    expect(g.preToolUse(pre())?.decision).toBe("ask");
    expect(g.preToolUse(pre({ tool: "Read" }))?.decision).toBe("deny");
  });

  it("이유 문구는 걸린 규칙의 묶음을 말한다(B90)", () => {
    policy({ "agent:rev": { all: "deny" }, lead: { bash: "ask", all: "deny" } });
    const g = gate();
    expect(g.preToolUse(teammate("rev"))?.respond()).toEqual(preToolDeny(policyDenyReason("rev", "모든 도구 금지")));
    expect(policyLines().at(-1)?.msg).toBe("deny bash agent");
    expect(g.lastDenied("s1", "rev")?.group).toBe("bash");
    expect(g.preToolUse(pre())?.respond()).toEqual(preToolAsk(policyAskReason("리드", "명령 실행 항상 질문")));
    expect(g.preToolUse(pre({ tool: "Read" }))?.respond()).toEqual(preToolDeny(policyDenyReason("리드", "모든 도구 금지")));
  });

  it("이름에 규칙이 있으면 others를 보지 않는다(스펙 4.2)", () => {
    policy({ "agent:rev": { bash: "deny" }, others: { web: "ask" } });
    const g = gate();
    expect(g.preToolUse(teammate("rev", { tool: "WebFetch" }))).toBeNull();
    expect(g.preToolUse(teammate("qa", { tool: "WebFetch" }))?.decision).toBe("ask");
  });

  it("리드는 others를 따르지 않는다", () => {
    policy({ others: { all: "deny" } });
    expect(gate().preToolUse(pre())).toBeNull();
  });

  it.each(["AskUserQuestion", "ExitPlanMode", "SendMessage", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "SubagentHandback"])(
    "답하기·팀 통신 도구는 all: deny에서도 통과: %s",
    (tool) => {
      policy({ lead: { all: "deny" }, others: { all: "deny" }, "sub:Explore": { all: "deny" }, "agent:rev": { all: "deny" } });
      const g = gate();
      expect(g.preToolUse(pre({ tool }))).toBeNull();
      expect(g.preToolUse(teammate("rev", { tool }))).toBeNull();
      expect(g.preToolUse(sub("Explore", { tool }))).toBeNull();
    },
  );

  it("tool_name이 없거나 문자열이 아니거나 빈 문자열이면 판정하지 않는다", () => {
    policy({ lead: { all: "deny" } });
    const g = gate();
    for (const tool of [undefined, 42, "", null]) expect(g.preToolUse(pre({ tool }))).toBeNull();
    const { tool_name: _t, ...noTool } = pre();
    expect(g.preToolUse(noTool)).toBeNull();
  });

  it("판정은 tool_input을 읽지 않는다(D3)", () => {
    policy({ lead: { bash: "deny" } });
    const getter = vi.fn(() => {
      throw new Error("read");
    });
    const input = Object.defineProperty({}, "command", { get: getter, enumerable: true });
    const v = gate().preToolUse(pre({ input }));
    expect(v?.decision).toBe("deny");
    v?.respond();
    expect(getter).not.toHaveBeenCalled();
  });

  it("preToolUse는 부작용이 없다(B78)", () => {
    policy({ lead: { bash: "ask" }, "agent:rev": { bash: "deny" } });
    const onChange = vi.fn();
    const g = gate({ onChange });
    expect(g.preToolUse(pre())?.decision).toBe("ask");
    expect(g.preToolUse(teammate("rev"))?.decision).toBe("deny");
    expect(g.counts()).toEqual({});
    expect(g.claim(perm())).toBe(false);
    expect(g.lastDenied("s1", "rev")).toBeUndefined();
    expect(g.totals()).toEqual({ deny: 0, ask: 0 });
    expect(onChange).not.toHaveBeenCalled();
    expect(policyLines()).toEqual([]);
  });

  it("respond(): deny", () => {
    policy({ "agent:rev": { bash: "deny" } });
    const onChange = vi.fn();
    const g = gate({ onChange });
    const out = g.preToolUse(teammate("rev"))?.respond();
    expect(out).toEqual(preToolDeny(policyDenyReason("rev", "명령 실행 금지")));
    expect(JSON.stringify(out).includes("FAKE-CMD-123")).toBe(false);
    expect(g.countsOf("agent:rev")).toEqual({ denied: 1, asked: 0 });
    expect(g.lastDenied("s1", "rev")).toEqual({ group: "bash", at: clock });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("respond(): ask와 PermissionRequest 짝 찾기", () => {
    policy({ lead: { bash: "ask" }, "agent:rev": { edit: "ask" }, "sub:Explore": { other: "ask" } });
    const g = gate();
    expect(g.preToolUse(pre({ promptId: "p1" }))?.respond()).toEqual(preToolAsk(policyAskReason("리드", "명령 실행 항상 질문")));
    expect(g.countsOf("lead")).toEqual({ denied: 0, asked: 1 });
    expect(g.claim(perm({ input: { command: "other" } }))).toBe(false); // 다른 입력
    expect(g.claim(perm({ promptId: "p2" }))).toBe(false); // prompt_id가 다름
    expect(g.claim(teammate("doc", { event: "PermissionRequest" }))).toBe(false); // 다른 에이전트(B94)
    expect(g.claim(perm({ promptId: "p1" }))).toBe(true);
    expect(g.claim(perm({ promptId: "p1" }))).toBe(false); // 한 번만

    // 팀원의 기록은 리드·다른 팀원이 가져가지 않고, 자기 PermissionRequest와 짝이 된다
    g.preToolUse(teammate("rev", { tool: "Write" }))?.respond();
    expect(g.claim(perm({ tool: "Write" }))).toBe(false);
    expect(g.claim(teammate("doc", { tool: "Write", event: "PermissionRequest" }))).toBe(false);
    expect(g.claim(teammate("rev", { tool: "Write", event: "PermissionRequest" }))).toBe(true);

    g.preToolUse(sub("Explore", { tool: "Read" }))?.respond();
    expect(g.claim(sub("Explore", { tool: "Read", event: "PermissionRequest" }))).toBe(true);

    g.preToolUse(pre())?.respond();
    clock += CLAIM_MS + 1_000;
    expect(g.claim(perm())).toBe(false); // 11초 뒤
  });

  it("others에서 온 규칙의 이유에도 그 에이전트 이름을 쓴다(B76)", () => {
    policy({ others: { bash: "deny" } });
    const g = gate();
    const out = g.preToolUse(teammate("qa"))?.respond();
    expect(out).toEqual(preToolDeny(policyDenyReason("qa", "명령 실행 금지")));
    expect(g.countsOf("agent:qa")).toEqual({ denied: 1, asked: 0 });
    expect(g.countsOf("others")).toEqual({ denied: 0, asked: 0 });
  });

  it("서브에이전트의 막힘은 리드 캐릭터에 붙는다", () => {
    policy({ "sub:Explore": { edit: "deny" } });
    const g = gate();
    g.preToolUse(sub("Explore", { tool: "Edit" }))?.respond();
    expect(g.lastDenied("s1", "team-lead")).toEqual({ group: "edit", at: clock, subType: "Explore" });
    expect(g.lastDenied("s2", "team-lead")).toBeUndefined();
  });

  it("lastDenied는 30초 뒤 사라진다", () => {
    policy({ lead: { bash: "deny" } });
    const g = gate();
    g.preToolUse(pre())?.respond();
    clock += POLICY_DENIED_SHOW_MS - 1;
    expect(g.lastDenied("s1", "team-lead")).toBeDefined();
    clock += 2;
    expect(g.lastDenied("s1", "team-lead")).toBeUndefined();
  });

  it("로그(B81)에는 결과·묶음·대상 종류만 있다", () => {
    policy({ "agent:rev": { bash: "deny" }, lead: { bash: "ask" }, others: { web: "deny" }, "sub:Explore": { bash: "deny" } });
    const g = gate();
    g.preToolUse(teammate("rev"))?.respond();
    g.preToolUse(pre())?.respond();
    g.preToolUse(teammate("qa", { tool: "WebFetch" }))?.respond();
    g.preToolUse(sub("Explore"))?.respond();
    const lines = policyLines();
    expect(lines.map((l) => [l.level, l.msg, l.data])).toEqual([
      ["warn", "deny bash agent", { outcome: "deny", group: "bash", target: "agent" }],
      ["info", "ask bash lead", { outcome: "ask", group: "bash", target: "lead" }],
      ["warn", "deny web others", { outcome: "deny", group: "web", target: "others" }],
      ["warn", "deny bash sub", { outcome: "deny", group: "bash", target: "sub" }],
    ]);
    const text = logText();
    expect([text.includes("rev"), text.includes("Explore"), text.includes("qa"), text.includes("FAKE-CMD")]).toEqual([false, false, false, false]);
  });

  it("같은 deny가 연달아 나오면 로그는 한 줄이다", () => {
    policy({ "agent:rev": { bash: "deny" } });
    const g = gate();
    for (let i = 0; i < 5; i++) g.preToolUse(teammate("rev"))?.respond();
    expect(policyLines()).toHaveLength(1);
    expect(g.countsOf("agent:rev").denied).toBe(5);
  });

  it("이름을 바꿔 가며 10,000번 막혀도 횟수 표는 500개를 넘지 않는다", () => {
    setLogger(new Logger({ dir: "" }));
    policy({ others: { all: "deny" } });
    const g = gate();
    for (let i = 0; i < 10_000; i++) g.preToolUse(teammate(`t${i}`))?.respond();
    expect(Object.keys(g.counts()).length).toBeLessThanOrEqual(MAX_COUNT_KEYS);
    expect(g.countsOf("agent:t9999").denied).toBe(1);
    expect(g.totals().deny).toBe(10_000);
    // 방금 막힘 표도 500개 상한(30초 안이라 시간 정리가 아니라 상한으로만 지워진다, B97)
    expect(g.lastDenied("s1", "t0")).toBeUndefined();
    expect(g.lastDenied("s1", "t9999")).toBeDefined();
  });

  it("ask 짝 찾기 기록도 상한이 있다(세션당 20건, 10초 지나면 지움, 세션 500개)", () => {
    setLogger(new Logger({ dir: "" }));
    policy({ others: { all: "ask" }, lead: { all: "ask" } });
    const g = gate();
    // 한 세션에 30건: 앞의 10건은 버려져 짝이 안 된다
    for (let i = 0; i < 30; i++) g.preToolUse(pre({ input: { n: i } }))?.respond();
    expect(g.claim(perm({ input: { n: 0 } }))).toBe(false);
    expect(g.claim(perm({ input: { n: 29 } }))).toBe(true);
    // 세션 id 10,000개(10초 안): 가장 오래된 세션부터 버린다
    for (let i = 0; i < 10_000; i++) g.preToolUse(pre({ session: `x${i}` }))?.respond();
    expect(g.pendingSessions()).toBeLessThanOrEqual(500);
    expect(g.claim(perm({ session: "x0" }))).toBe(false);
    expect(g.claim(perm({ session: "x9999" }))).toBe(true);
    // 10초가 지나면 기록이 지워진다
    clock += CLAIM_MS + 1;
    g.preToolUse(pre({ session: "y" }))?.respond();
    expect(g.pendingSessions()).toBe(1);
  });

  it("폭주 중에도 자주 쓰이는 대상의 횟수는 남는다", () => {
    setLogger(new Logger({ dir: "" }));
    policy({ others: { all: "deny" }, lead: { all: "deny" } });
    const g = gate();
    // 계획의 600·400은 첫 600번 사이에 lead가 가장 오래 안 쓰인 키가 되어 지워진다(LRU 500). 400·400이면
    // LRU는 lead를 지키고, 올릴 때 맨 뒤로 옮기지 않는 FIFO는 두 번째 400번 중에 lead를 지운다
    g.preToolUse(pre())?.respond();
    for (let i = 0; i < 400; i++) g.preToolUse(teammate(`t${i}`))?.respond();
    g.preToolUse(pre())?.respond();
    for (let i = 400; i < 800; i++) g.preToolUse(teammate(`t${i}`))?.respond();
    expect(g.countsOf("lead").denied).toBe(2);
    expect(Object.keys(g.counts()).length).toBe(MAX_COUNT_KEYS);
  });

  it("정책 오류가 판정을 던지게 하지 않는다", () => {
    const g = new PolicyGate({
      resolve: () => {
        throw new TypeError("SECRET-MESSAGE");
      },
    });
    expect(g.preToolUse(pre())).toBeNull();
    const lines = policyLines();
    expect(lines.map((l) => [l.level, l.data])).toEqual([["error", { error: "TypeError" }]]);
    expect(logText().includes("SECRET-MESSAGE")).toBe(false);
  });

  it("totals", () => {
    policy({ lead: { bash: "deny", edit: "ask" } });
    const g = gate();
    g.preToolUse(pre())?.respond();
    g.preToolUse(pre())?.respond();
    g.preToolUse(pre({ tool: "Edit" }))?.respond();
    expect(g.totals()).toEqual({ deny: 2, ask: 1 });
  });

  it("판정은 1ms 수준(실제 객체로 측정)", () => {
    for (let i = 0; i < 199; i++) store.set(`agent:a${i}`, { bash: "deny", edit: "ask" });
    store.set("others", { web: "ask" });
    const g = gate();
    const inputs = Array.from({ length: 2_000 }, (_, i) => teammate(`a${i % 199}`, { tool: i % 2 ? "Bash" : "Edit", input: { command: `c${i}` } }));
    const t0 = performance.now();
    for (const input of inputs) g.preToolUse(input)?.respond();
    const avg = (performance.now() - t0) / inputs.length;
    expect(avg).toBeLessThan(1);
  });
});
