import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUDGET_STOP, DENY_DEFAULT, HOLD_MS, permissionResponse } from "../../server/decisions/protocol";
import { DecisionQueue, MAX_PENDING, RESOLVED_KEEP_MS } from "../../server/decisions/queue";
import { Logger, setLogger } from "../../server/log";
import type { DecisionAnswer } from "../../src/shared/types";

/** express Response 중 큐가 쓰는 부분만 흉내 낸다. close()는 연결이 끊긴 것처럼 close 콜백을 부른다 */
function fakeRes() {
  const fns: Array<() => void> = [];
  const r = {
    writableEnded: false,
    calls: [] as Array<{ code: number; body?: unknown }>,
    on(_e: "close", fn: () => void) {
      fns.push(fn);
    },
    status(code: number) {
      return {
        json(body: unknown) {
          r.calls.push({ code, body });
          r.writableEnded = true;
        },
        end() {
          r.calls.push({ code });
          r.writableEnded = true;
        },
      };
    },
    close() {
      for (const f of fns) f();
    },
  };
  return r;
}

const req = (tool: string, toolInput: Record<string, unknown>, session = "s1", extra: Record<string, unknown> = {}) => ({
  hook_event_name: "PermissionRequest",
  session_id: session,
  tool_name: tool,
  tool_input: toolInput,
  ...extra,
});
const questionInput = () => ({
  questions: [
    { question: "과일은?", header: "과일", multiSelect: false, options: [{ label: "사과" }, { label: "배" }] },
    { question: "토핑은?", header: "토핑", multiSelect: true, options: [{ label: "버섯" }, { label: "치즈" }, { label: "올리브" }] },
  ],
  metadata: { source: "FAKE-EXTRA" },
});

let q: DecisionQueue;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-02T00:00:00Z"));
});
afterEach(() => {
  q?.stop();
  vi.useRealTimers();
  setLogger(new Logger({ dir: "" }));
});

describe("DecisionQueue", () => {
  it("대시보드 답이 정확한 JSON으로 돌아간다", () => {
    q = new DecisionQueue();
    const res = fakeRes();
    const v = q.hold(req("Bash", { command: "ls" }), res)!;
    expect(v).toMatchObject({ kind: "permission", toolName: "Bash", state: "pending", agent: "team-lead", answerable: true, sessionId: "s1" });
    expect(v.deadline).toBe(new Date(Date.parse(v.createdAt) + HOLD_MS).toISOString());
    expect(q.answer(v.id, { action: "allow" })).toEqual({ ok: true, state: "answered-dashboard" });
    expect(res.calls).toEqual([{ code: 200, body: permissionResponse("allow") }]);
    expect(q.list()[0]).toMatchObject({ state: "answered-dashboard", outcome: "allow" });
    expect(q.list()[0].resolvedAt).toBeDefined();
  });

  it("거부 이유가 없으면 기본 문구, 있으면 그 문구", () => {
    q = new DecisionQueue();
    const a = fakeRes();
    const b = fakeRes();
    const c = fakeRes();
    const va = q.hold(req("Bash", { command: "a" }), a)!;
    const vb = q.hold(req("Bash", { command: "b" }), b)!;
    const vc = q.hold(req("Bash", { command: "c" }), c)!;
    q.answer(va.id, { action: "deny" });
    q.answer(vb.id, { action: "deny", reason: "테스트 폴더만 써 주세요" });
    expect(a.calls[0].body).toEqual(permissionResponse("deny", { message: DENY_DEFAULT }));
    expect(b.calls[0].body).toEqual(permissionResponse("deny", { message: "테스트 폴더만 써 주세요" }));
    expect(q.answer(vc.id, { action: "deny", reason: "가".repeat(201) })).toEqual({ ok: false, status: 400 });
    expect(c.calls).toEqual([]);
    expect(q.answer(vc.id, { action: "deny", reason: "가".repeat(200) })).toEqual({ ok: true, state: "answered-dashboard" });
  });

  it("연결이 끊기면 closed-terminal", () => {
    const onChange = vi.fn();
    q = new DecisionQueue({ onChange });
    const res = fakeRes();
    const v = q.hold(req("Bash", { command: "ls" }), res)!;
    onChange.mockClear();
    res.close();
    expect(q.list()[0].state).toBe("closed-terminal");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("연결이 끊긴 뒤의 답은 409이고 응답에 쓰지 않는다", () => {
    q = new DecisionQueue();
    const res = fakeRes();
    const v = q.hold(req("Bash", { command: "ls" }), res)!;
    res.close();
    expect(q.answer(v.id, { action: "allow" })).toEqual({ ok: false, status: 409, state: "closed-terminal" });
    expect(res.calls).toEqual([]);
  });

  it("590초가 지나면 expired이고 빈 200", () => {
    q = new DecisionQueue();
    const res = fakeRes();
    const v = q.hold(req("Bash", { command: "ls" }), res)!;
    vi.advanceTimersByTime(HOLD_MS - 1);
    expect(res.calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(res.calls).toEqual([{ code: 200 }]);
    res.close();
    expect(q.list()[0].state).toBe("expired");
    expect(q.answer(v.id, { action: "allow" })).toEqual({ ok: false, status: 409, state: "expired" });
  });

  it("같은 답을 두 번 보내면 두 번째는 409", () => {
    q = new DecisionQueue();
    const res = fakeRes();
    const v = q.hold(req("Bash", { command: "ls" }), res)!;
    expect(q.answer(v.id, { action: "allow" })).toEqual({ ok: true, state: "answered-dashboard" });
    expect(q.answer(v.id, { action: "allow" })).toEqual({ ok: false, status: 409, state: "answered-dashboard" });
    expect(res.calls).toHaveLength(1);
  });

  it("없는 id는 404, 종류에 안 맞는 action은 400", () => {
    q = new DecisionQueue();
    expect(q.answer("nope", { action: "allow" })).toEqual({ ok: false, status: 404 });
    const p = q.hold(req("Bash", { command: "ls" }), fakeRes())!;
    const qs = q.hold(req("AskUserQuestion", questionInput()), fakeRes())!;
    const b = q.hold(req("Bash", { command: "x" }), fakeRes(), { kind: "budget", budget: { budgetTokens: 10, usedTokens: 11 } })!;
    expect(q.answer(p.id, { action: "continue" })).toEqual({ ok: false, status: 400 });
    expect(q.answer(p.id, { action: "answer", answers: [] })).toEqual({ ok: false, status: 400 });
    expect(q.answer(qs.id, { action: "allow" })).toEqual({ ok: false, status: 400 });
    expect(q.answer(qs.id, { action: "answer", answers: [{ labels: [9] }, { labels: [0] }] })).toEqual({ ok: false, status: 400 });
    expect(q.answer(b.id, { action: "allow" })).toEqual({ ok: false, status: 400 });
    expect(q.answer(b.id, { action: "nonsense" } as never)).toEqual({ ok: false, status: 400 });
    expect(q.answer(p.id, null as never)).toEqual({ ok: false, status: 400 });
    expect(q.answer(p.id, { action: "deny", reason: 5 } as never)).toEqual({ ok: false, status: 400 });
    expect(q.list().every((v) => v.state === "pending")).toBe(true);
  });

  it("질문의 updatedInput은 원래 입력 전체와 answers", () => {
    q = new DecisionQueue();
    const res = fakeRes();
    const input = questionInput();
    const v = q.hold(req("AskUserQuestion", input), res)!;
    expect(v.kind).toBe("question");
    expect(v.questions).toEqual([
      { question: "과일은?", header: "과일", multiSelect: false, options: [{ label: "사과" }, { label: "배" }] },
      { question: "토핑은?", header: "토핑", multiSelect: true, options: [{ label: "버섯" }, { label: "치즈" }, { label: "올리브" }] },
    ]);
    expect(q.answer(v.id, { action: "answer", answers: [{ labels: [1] }, { labels: [0, 2] }] })).toEqual({ ok: true, state: "answered-dashboard" });
    expect(res.calls[0].body).toEqual(permissionResponse("allow", { updatedInput: { ...input, answers: { "과일은?": "배", "토핑은?": "버섯, 올리브" } } }));
    expect(q.list()[0].outcome).toBe("answer");
  });

  it("질문 화면 문자열은 가리고 200자로 자르지만 answers 키는 원문이다", () => {
    q = new DecisionQueue();
    const res = fakeRes();
    const raw = `token=FAKE12345 ${"꼬".repeat(300)}`;
    const v = q.hold(req("AskUserQuestion", { questions: [{ question: raw, multiSelect: false, options: [{ label: "예 password=FAKEPW1" }] }] }), res)!;
    expect(JSON.stringify(v)).not.toContain("FAKE12345");
    expect(JSON.stringify(v)).not.toContain("FAKEPW1");
    expect([...v.questions![0].question].length).toBeLessThanOrEqual(200);
    q.answer(v.id, { action: "answer", answers: [{ labels: [0] }] });
    const body = res.calls[0].body as { hookSpecificOutput: { decision: { updatedInput: { answers: Record<string, string> } } } };
    expect(body.hookSpecificOutput.decision.updatedInput.answers).toEqual({ [raw]: "예 password=FAKEPW1" });
  });

  it("계획은 보고서만(Ruling B40): answerable false, 어떤 action으로 답해도 400이고 응답에 쓰지 않는다, 연결이 끊기면 closed-terminal, 590초 뒤 빈 200", () => {
    q = new DecisionQueue();
    const a = fakeRes();
    const v = q.hold(req("ExitPlanMode", { plan: "1. 파일 만들기", planFilePath: "/x/p.md" }), a)!;
    expect(v).toMatchObject({ kind: "plan", answerable: false, plan: "1. 파일 만들기" });
    expect(v.planTruncated).toBeUndefined();
    for (const action of [{ action: "allow" }, { action: "deny" }, { action: "continue" }, { action: "stop" }, { action: "answer", answers: [] }] as DecisionAnswer[]) {
      expect(q.answer(v.id, action)).toEqual({ ok: false, status: 400 });
    }
    expect(a.calls).toEqual([]);
    a.close();
    expect(q.list()[0].state).toBe("closed-terminal");

    const b = fakeRes();
    q.hold(req("ExitPlanMode", { plan: "p" }), b);
    vi.advanceTimersByTime(HOLD_MS);
    expect(b.calls).toEqual([{ code: 200 }]);
  });

  it("plan은 가린 뒤 4000자까지", () => {
    q = new DecisionQueue();
    const long = q.hold(req("ExitPlanMode", { plan: `키 sk-FAKEabcdefgh12345 끝 ${"가".repeat(5000)}` }), fakeRes())!;
    expect(long.plan).not.toContain("sk-FAKE");
    expect([...long.plan!].length).toBe(4000);
    expect(long.planTruncated).toBe(true);
    const short = q.hold(req("ExitPlanMode", { plan: "가".repeat(100) }), fakeRes())!;
    expect(short.plan).toBe("가".repeat(100));
    expect("planTruncated" in short).toBe(false);
  });

  it("예산: continue는 allow, stop은 deny와 BUDGET_STOP", () => {
    const onResolve = vi.fn();
    q = new DecisionQueue({ onResolve });
    const a = fakeRes();
    const b = fakeRes();
    const budget = { budgetTokens: 500_000, usedTokens: 512_000 };
    const va = q.hold(req("Bash", { command: "a" }), a, { kind: "budget", budget })!;
    const vb = q.hold(req("Bash", { command: "b" }), b, { kind: "budget", budget })!;
    expect(va).toMatchObject({ kind: "budget", answerable: true, budget });
    q.answer(va.id, { action: "continue" });
    q.answer(vb.id, { action: "stop" });
    expect(a.calls[0].body).toEqual(permissionResponse("allow"));
    expect(b.calls[0].body).toEqual(permissionResponse("deny", { message: BUDGET_STOP }));
    expect(onResolve).toHaveBeenCalledWith(expect.objectContaining({ id: va.id, kind: "budget", outcome: "continue", state: "answered-dashboard" }));
    expect(onResolve).toHaveBeenCalledWith(expect.objectContaining({ id: vb.id, kind: "budget", outcome: "stop" }));
  });

  it("demoteBudget은 같은 세션의 pending budget만 permission으로 바꾼다", () => {
    q = new DecisionQueue();
    const budget = { budgetTokens: 1, usedTokens: 2 };
    const s1 = q.hold(req("Bash", { command: "a" }), fakeRes(), { kind: "budget", budget })!;
    const s1done = q.hold(req("Bash", { command: "b" }), fakeRes(), { kind: "budget", budget })!;
    const s2 = q.hold(req("Bash", { command: "c" }, "s2"), fakeRes(), { kind: "budget", budget })!;
    q.answer(s1done.id, { action: "continue" });
    q.demoteBudget("s1");
    const byId = new Map(q.list().map((v) => [v.id, v]));
    expect(byId.get(s1.id)!.kind).toBe("permission");
    expect(byId.get(s1.id)!.budget).toBeUndefined();
    expect(byId.get(s1done.id)!.kind).toBe("budget");
    expect(byId.get(s2.id)!.kind).toBe("budget");
    expect(q.answer(s1.id, { action: "continue" })).toEqual({ ok: false, status: 400 });
    expect(q.answer(s1.id, { action: "allow" })).toEqual({ ok: true, state: "answered-dashboard" });
  });

  it("화면에 원래 입력이 없다", () => {
    q = new DecisionQueue();
    const content = `RAW-SECRET-LIKE-${"x".repeat(900_000)}`;
    q.hold(req("Write", { file_path: "/tmp/a.txt", content }), fakeRes());
    q.hold(req("Bash", { command: "curl -u user:FAKEPASS https://x", description: "d".repeat(500) }), fakeRes());
    const text = JSON.stringify(q.list());
    expect(text).not.toContain("RAW-SECRET-LIKE");
    expect(text).not.toContain("FAKEPASS");
    for (const v of q.list()) for (const s of Object.values(v.detail)) expect([...(s as string)].length).toBeLessThanOrEqual(200);
    expect(q.list()[0].detail.filePath).toBe("/tmp/a.txt");
  });

  it("로그에 kind·state·ms·세션 순번만 남긴다", () => {
    const dir = mkdtempSync(join(tmpdir(), "co-queue-log-"));
    try {
      setLogger(new Logger({ dir }));
      q = new DecisionQueue();
      const sid = "SESSION-FAKE-ID-1234";
      const a = q.hold(req("Bash", { command: "COMMAND-FAKE run" }, sid), fakeRes())!;
      const b = q.hold(req("AskUserQuestion", { questions: [{ question: "QUESTION-FAKE?", multiSelect: false, options: [{ label: "x" }] }] }, sid), fakeRes())!;
      vi.advanceTimersByTime(1234);
      q.answer(a.id, { action: "deny", reason: "REASON-FAKE" });
      q.answer(b.id, { action: "answer", answers: [{ other: "ANSWER-FAKE" }] });
      const text = readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("");
      for (const s of ["REASON-FAKE", "ANSWER-FAKE", sid, "COMMAND-FAKE", "QUESTION-FAKE"]) expect(text).not.toContain(s);
      const lines = text.trim().split("\n").map((l) => JSON.parse(l) as { src: string; msg: string; data: Record<string, unknown> });
      expect(lines).toHaveLength(2);
      for (const l of lines) {
        expect(l.src).toBe("decisions");
        expect(Object.keys(l.data).sort()).toEqual(["kind", "ms", "session", "state"]);
      }
      expect(lines[0].data).toEqual({ kind: "permission", state: "answered-dashboard", ms: 1234, session: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pending이 50건이면 새 요청은 붙잡지 않고 빈 200", () => {
    q = new DecisionQueue();
    for (let i = 0; i < MAX_PENDING; i++) expect(q.hold(req("Bash", { command: `c${i}` }), fakeRes())).not.toBeNull();
    const res = fakeRes();
    expect(q.hold(req("Bash", { command: "over" }), res)).toBeNull();
    expect(res.calls).toEqual([{ code: 200 }]);
    expect(q.list()).toHaveLength(MAX_PENDING);
  });

  it("list는 오래된 pending이 먼저, 끝난 것은 30초 뒤 사라진다", () => {
    q = new DecisionQueue();
    const a = q.hold(req("Bash", { command: "a" }), fakeRes())!;
    vi.advanceTimersByTime(1000);
    const b = q.hold(req("Bash", { command: "b" }), fakeRes())!;
    vi.advanceTimersByTime(1000);
    const c = q.hold(req("Bash", { command: "c" }), fakeRes())!;
    expect(q.list().map((v) => v.id)).toEqual([a.id, b.id, c.id]);
    q.answer(a.id, { action: "allow" });
    expect(q.list().map((v) => v.id)).toEqual([b.id, c.id, a.id]);
    vi.advanceTimersByTime(RESOLVED_KEEP_MS);
    expect(q.list().map((v) => v.id)).toEqual([b.id, c.id, a.id]);
    vi.advanceTimersByTime(1);
    expect(q.list().map((v) => v.id)).toEqual([b.id, c.id]);
  });

  it("같은 세션에 결정이 여럿 있어도 각각 답할 수 있다", () => {
    q = new DecisionQueue();
    const ra = fakeRes();
    const rb = fakeRes();
    const a = q.hold(req("Bash", { command: "a" }), ra)!;
    const b = q.hold(req("Bash", { command: "b" }, "s1", { agent_id: "aworker-1", agent_type: "worker" }), rb)!;
    expect(b.agent).toBe("worker");
    q.answer(b.id, { action: "deny" });
    q.answer(a.id, { action: "allow" });
    expect(ra.calls[0].body).toEqual(permissionResponse("allow"));
    expect(rb.calls[0].body).toEqual(permissionResponse("deny", { message: DENY_DEFAULT }));
  });

  it("끝난 결정의 원래 입력은 버린다", () => {
    q = new DecisionQueue();
    const a = q.hold(req("Bash", { command: "a" }), fakeRes())!;
    const b = q.hold(req("Bash", { command: "b" }), fakeRes(), { kind: "budget", budget: { budgetTokens: 1, usedTokens: 1 } })!;
    const c = fakeRes();
    q.hold(req("Bash", { command: "c" }), c);
    q.hold(req("Bash", { command: "d" }), fakeRes());
    expect(q.rawCount()).toBe(4);
    q.answer(a.id, { action: "allow" });
    q.answer(b.id, { action: "stop" });
    c.close();
    vi.advanceTimersByTime(HOLD_MS);
    expect(q.rawCount()).toBe(0);
    q.demoteBudget("s1");
    q.answer(a.id, { action: "allow" });
    expect(q.rawCount()).toBe(0);
  });

  it("stats는 종류별·결과별 건수를 센다", () => {
    q = new DecisionQueue();
    const a = q.hold(req("Bash", { command: "a" }), fakeRes())!;
    const r = fakeRes();
    q.hold(req("ExitPlanMode", { plan: "p" }), r);
    q.hold(req("Bash", { command: "c" }), fakeRes());
    q.answer(a.id, { action: "allow" });
    r.close();
    expect(q.stats()).toEqual({
      byKind: { permission: 2, plan: 1 },
      byState: { pending: 1, "answered-dashboard": 1, "closed-terminal": 1, expired: 0 },
    });
  });

  it("onChange가 던져도 hold는 항목을 돌려주고 상태가 유지된다", () => {
    q = new DecisionQueue({ onChange: () => { throw new Error("boom"); } });
    const res = fakeRes();
    const v = q.hold(req("Bash", { command: "a" }), res);
    expect(v).not.toBeNull();
    expect(q.list()).toHaveLength(1);
    expect(q.answer(v!.id, { action: "allow" })).toEqual({ ok: true, state: "answered-dashboard" });
    expect(res.calls).toEqual([{ code: 200, body: permissionResponse("allow") }]);
  });

  it("onResolve가 던져도 응답은 나간다", () => {
    q = new DecisionQueue({ onResolve: () => { throw new Error("boom"); } });
    const res = fakeRes();
    const v = q.hold(req("Bash", { command: "a" }), res, { kind: "budget", budget: { budgetTokens: 1, usedTokens: 1 } })!;
    expect(q.answer(v.id, { action: "continue" })).toEqual({ ok: true, state: "answered-dashboard" });
    expect(res.calls).toEqual([{ code: 200, body: permissionResponse("allow") }]);
    const r2 = fakeRes();
    q.hold(req("Bash", { command: "b" }), r2);
    vi.advanceTimersByTime(HOLD_MS);
    expect(r2.calls).toEqual([{ code: 200 }]);
  });

  it("stop은 타이머를 모두 지운다", () => {
    q = new DecisionQueue();
    q.hold(req("Bash", { command: "a" }), fakeRes());
    q.hold(req("Bash", { command: "b" }), fakeRes());
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    q.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ───────── Ruling B70: 터미널에서 허용하면 hook 연결이 닫히지 않는다(Task 14 항목 3) → hook 이벤트로 closed-terminal ─────────
describe("DecisionQueue.onEvent(B70)", () => {
  const ev = (event: string, o: Record<string, unknown> = {}) => ({ hook_event_name: event, session_id: "s1", ...o });
  const stateOf = (id: string) => q.list().find((v) => v.id === id)!.state;

  it("같은 세션·에이전트·도구·입력 해시의 PostToolUse가 오면 closed-terminal로 닫고 hook에는 빈 200을 한 번 쓴다", () => {
    q = new DecisionQueue();
    const res = fakeRes();
    const v = q.hold(req("Bash", { command: "echo a", description: "d" }), res)!;
    // 키 순서가 달라도 같은 입력(정규 직렬화 해시)
    q.onEvent(ev("PostToolUse", { tool_name: "Bash", tool_input: { description: "d", command: "echo a" }, tool_use_id: "tu" }));
    expect(stateOf(v.id)).toBe("closed-terminal");
    expect(res.calls).toEqual([{ code: 200 }]);
    expect(q.answer(v.id, { action: "allow" })).toEqual({ ok: false, status: 409, state: "closed-terminal" });
    res.close();
    expect(res.calls).toHaveLength(1);
    expect(q.rawCount()).toBe(0);
  });

  it.each(["PostToolUseFailure", "PermissionDenied"])("%s도 같은 규칙으로 닫는다", (event) => {
    q = new DecisionQueue();
    const v = q.hold(req("Bash", { command: "x" }), fakeRes())!;
    q.onEvent(ev(event, { tool_name: "Bash", tool_input: { command: "x" } }));
    expect(stateOf(v.id)).toBe("closed-terminal");
  });

  it("같은 도구의 다른 입력은 닫지 않는다(pending이 둘 이상이고 해시가 안 맞으면 그대로)", () => {
    q = new DecisionQueue();
    const a = q.hold(req("Bash", { command: "a" }), fakeRes())!;
    const b = q.hold(req("Bash", { command: "b" }), fakeRes())!;
    q.onEvent(ev("PostToolUse", { tool_name: "Bash", tool_input: { command: "c" } }));
    expect([stateOf(a.id), stateOf(b.id)]).toEqual(["pending", "pending"]);
    q.onEvent(ev("PostToolUse", { tool_name: "Bash", tool_input: { command: "b" } }));
    expect([stateOf(a.id), stateOf(b.id)]).toEqual(["pending", "closed-terminal"]);
  });

  it("해시가 달라도 그 세션·에이전트·도구의 pending이 하나뿐이면 닫는다(AskUserQuestion처럼 Post 입력이 달라지는 경우)", () => {
    q = new DecisionQueue();
    const v = q.hold(req("AskUserQuestion", { questions: [{ question: "Q?", multiSelect: false, options: [{ label: "a" }] }] }), fakeRes())!;
    q.onEvent(ev("PostToolUse", { tool_name: "AskUserQuestion", tool_input: { questions: [], answers: { "Q?": "a" } } }));
    expect(stateOf(v.id)).toBe("closed-terminal");
  });

  it("다른 세션·다른 에이전트·다른 도구는 그대로", () => {
    q = new DecisionQueue();
    const lead = q.hold(req("Bash", { command: "x" }), fakeRes())!;
    const mate = q.hold(req("Bash", { command: "x" }, "s1", { agent_id: "aworker-1", agent_type: "worker" }), fakeRes())!;
    const other = q.hold(req("Bash", { command: "x" }, "s2"), fakeRes())!;
    q.onEvent(ev("PostToolUse", { tool_name: "Bash", tool_input: { command: "x" }, agent_id: "aworker-1", agent_type: "worker" }));
    expect([stateOf(lead.id), stateOf(mate.id), stateOf(other.id)]).toEqual(["pending", "closed-terminal", "pending"]);
    q.onEvent(ev("PostToolUse", { tool_name: "Write", tool_input: { command: "x" } }));
    expect(stateOf(lead.id)).toBe("pending");
  });

  it("Stop은 그 에이전트 것만, 합친 서브에이전트의 SubagentStop은 그 서브에이전트 것만 닫는다", () => {
    q = new DecisionQueue();
    const lead = q.hold(req("Bash", { command: "l" }), fakeRes())!;
    const sub = q.hold(req("Bash", { command: "s" }, "s1", { agent_id: "a0123456789abcdef", agent_type: "Explore" }), fakeRes())!;
    const mate = q.hold(req("Bash", { command: "m" }, "s1", { agent_id: "aworker-1", agent_type: "worker" }), fakeRes())!;
    q.onEvent(ev("SubagentStop", { agent_id: "a0123456789abcdef", agent_type: "Explore" }));
    expect([stateOf(lead.id), stateOf(sub.id), stateOf(mate.id)]).toEqual(["pending", "closed-terminal", "pending"]);
    q.onEvent(ev("TeammateIdle", { teammate_name: "worker" }));
    expect(stateOf(mate.id)).toBe("closed-terminal");
    q.onEvent(ev("Stop"));
    expect(stateOf(lead.id)).toBe("closed-terminal");
  });

  it("SessionEnd와 리드의 UserPromptSubmit은 그 세션 전체를 닫는다", () => {
    q = new DecisionQueue();
    const a = q.hold(req("Bash", { command: "a" }), fakeRes())!;
    const b = q.hold(req("Bash", { command: "b" }, "s1", { agent_id: "aworker-1", agent_type: "worker" }), fakeRes())!;
    const c = q.hold(req("Bash", { command: "c" }, "s2"), fakeRes())!;
    q.onEvent(ev("UserPromptSubmit", { prompt: "next" }));
    expect([stateOf(a.id), stateOf(b.id), stateOf(c.id)]).toEqual(["closed-terminal", "closed-terminal", "pending"]);
    q.onEvent({ hook_event_name: "SessionEnd", session_id: "s2" });
    expect(stateOf(c.id)).toBe("closed-terminal");
  });

  it("계획(answerable:false)과 예산 결정도 같은 규칙으로 닫히고, 590초 타이머가 정리된다", () => {
    q = new DecisionQueue();
    const r1 = fakeRes();
    const plan = q.hold(req("ExitPlanMode", { plan: "p" }), r1)!;
    const budget = q.hold(req("Bash", { command: "x" }), fakeRes(), { kind: "budget", budget: { budgetTokens: 1, usedTokens: 1 } })!;
    q.onEvent(ev("PostToolUse", { tool_name: "ExitPlanMode", tool_input: { plan: "p", planFilePath: "/x" } }));
    q.onEvent(ev("PostToolUse", { tool_name: "Bash", tool_input: { command: "x" } }));
    expect([stateOf(plan.id), stateOf(budget.id)]).toEqual(["closed-terminal", "closed-terminal"]);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(HOLD_MS);
    expect(r1.calls).toEqual([{ code: 200 }]); // 닫을 때 한 번만
  });

  it("끝난 결정과 붙잡지 않은 이벤트에는 아무것도 하지 않고, 이상한 입력에도 던지지 않는다", () => {
    q = new DecisionQueue();
    const res = fakeRes();
    const v = q.hold(req("Bash", { command: "x" }), res)!;
    q.answer(v.id, { action: "allow" });
    q.onEvent(ev("PostToolUse", { tool_name: "Bash", tool_input: { command: "x" } }));
    expect(stateOf(v.id)).toBe("answered-dashboard");
    expect(res.calls).toHaveLength(1);
    for (const bad of [{}, { hook_event_name: "Stop" }, { hook_event_name: "PostToolUse", session_id: 5 }, ev("PostToolUse", { tool_input: { a: 10n } })] as Array<Record<string, unknown>>) {
      expect(() => q.onEvent(bad)).not.toThrow();
    }
  });

  it("로그는 기존 형식(kind·state·ms·session)이고 원문이 없다", () => {
    const dir = mkdtempSync(join(tmpdir(), "co-queue-b70-"));
    try {
      setLogger(new Logger({ dir }));
      q = new DecisionQueue();
      q.hold(req("Bash", { command: "COMMAND-FAKE-B70" }), fakeRes());
      q.onEvent(ev("PostToolUse", { tool_name: "Bash", tool_input: { command: "COMMAND-FAKE-B70" } }));
      const text = readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("");
      expect(text).not.toContain("COMMAND-FAKE-B70");
      const line = JSON.parse(text.trim().split("\n").at(-1)!) as { data: Record<string, unknown> };
      expect(Object.keys(line.data).sort()).toEqual(["kind", "ms", "session", "state"]);
      expect(line.data.state).toBe("closed-terminal");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
