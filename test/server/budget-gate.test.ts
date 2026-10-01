import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BudgetGate } from "../../server/budget/gate";
import { BudgetStore } from "../../server/budget/store";
import { budgetReason, preToolAsk } from "../../server/decisions/protocol";
import { Logger, setLogger } from "../../server/log";
import { SnapshotBuilder } from "../../server/snapshot";
import type { DecisionView } from "../../src/shared/types";
import { assistant, makeHome } from "../helpers/fakeHome";

// preToolUse가 파일을 읽지 않는지 보려고 읽기 함수를 감싼다
const reads = vi.hoisted(() => ({ n: 0 }));
vi.mock("node:fs", async (orig) => {
  const m = await orig<typeof import("node:fs")>();
  return { ...m, readFileSync: (...a: unknown[]) => (reads.n++, (m.readFileSync as (...x: unknown[]) => unknown)(...a)) };
});
vi.mock("node:fs/promises", async (orig) => {
  const m = await orig<typeof import("node:fs/promises")>();
  return { ...m, readFile: (...a: unknown[]) => (reads.n++, (m.readFile as (...x: unknown[]) => unknown)(...a)) };
});

let dir: string;
let clock: number;
let store: BudgetStore;
let gate: BudgetGate;
let demoted: string[];
const T0 = Date.UTC(2026, 9, 2);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "co-gate-"));
  setLogger(new Logger({ dir: "" }));
  clock = T0;
  demoted = [];
  store = new BudgetStore(join(dir, "state.json"), () => clock);
  store.load();
  gate = new BudgetGate(store, { now: () => clock, demote: (id) => demoted.push(id) });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const pre = (o: Record<string, unknown> = {}) => ({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Bash", tool_input: { command: "echo fake", description: "d" }, tool_use_id: "tu-1", prompt_id: "p1", ...o });
const perm = (o: Record<string, unknown> = {}) => ({ hook_event_name: "PermissionRequest", session_id: "s1", tool_name: "Bash", tool_input: { description: "d", command: "echo fake" }, prompt_id: "p1", ...o });
const ASK = preToolAsk(budgetReason(1000));
function reach() {
  store.setBudget("s1", 1000, 0);
  gate.setUsage("s1", 1000);
}
const view = (o: Partial<DecisionView>): DecisionView =>
  ({ id: "d", sessionId: "s1", agent: "team-lead", kind: "budget", toolName: "Bash", state: "answered-dashboard", createdAt: "", deadline: "", detail: {}, answerable: true, ...o }) as DecisionView;

describe("BudgetGate.preToolUse", () => {
  it("예산이 없으면 null", () => {
    gate.setUsage("s1", 10 ** 9);
    expect(gate.preToolUse(pre())).toBeNull();
  });

  it("사용량이 nextGateAt 미만이면 null", () => {
    store.setBudget("s1", 1000, 0);
    gate.setUsage("s1", 999);
    expect(gate.preToolUse(pre())).toBeNull();
  });

  it("닿으면 ask JSON(스펙 문구)", () => {
    reach();
    expect(gate.preToolUse(pre())).toEqual(ASK);
    expect(JSON.stringify(ASK)).toContain("예산(1,000토큰)에 도달했습니다. 대시보드나 이 창에서 계속할지 정해 주세요");
  });

  it("AskUserQuestion·ExitPlanMode에는 걸지 않는다", () => {
    reach();
    expect(gate.preToolUse(pre({ tool_name: "AskUserQuestion" }))).toBeNull();
    expect(gate.preToolUse(pre({ tool_name: "ExitPlanMode" }))).toBeNull();
  });

  it("이상한 입력에도 던지지 않는다", () => {
    reach();
    for (const bad of [{}, { session_id: 5 }, { session_id: "s1", tool_input: { a: 10n } }] as Array<Record<string, unknown>>) {
      expect(() => gate.preToolUse(bad)).not.toThrow();
      expect(() => gate.claim(bad)).not.toThrow();
      expect(() => gate.onEvent(bad)).not.toThrow();
    }
  });

  it("저장에 실패해도 preToolUse는 던지지 않는다", () => {
    const broken = new BudgetStore(join(dir, "nope", "\u0000bad", "state.json"), () => clock);
    broken.setBudget("s1", 1000, 0); // 저장 실패(경로 오류) — 메모리 값은 남는다
    const g = new BudgetGate(broken, { now: () => clock });
    g.setUsage("s1", 5000);
    expect(g.preToolUse(pre())).toEqual(ASK);
    expect(() => g.resolved(view({ outcome: "continue" }))).not.toThrow();
  });

  it("preToolUse는 파일을 읽지 않는다", () => {
    reach();
    reads.n = 0;
    for (let i = 0; i < 10; i++) gate.preToolUse(pre({ tool_use_id: `tu-${i}` }));
    gate.claim(perm());
    expect(reads.n).toBe(0);
  });
});

describe("BudgetGate.claim (Ruling B48)", () => {
  it("claim은 같은 세션·도구·입력 해시의 관문 호출에 한 번만 값을 준다", () => {
    reach();
    gate.preToolUse(pre());
    // 키 순서가 달라도 같은 입력(정규 직렬화)
    expect(gate.claim(perm())).toEqual({ budgetTokens: 1000, usedTokens: 1000 });
    expect(gate.claim(perm())).toBeNull();
  });

  it("입력이 다르면 null", () => {
    reach();
    gate.preToolUse(pre());
    expect(gate.claim(perm({ tool_input: { command: "echo other" } }))).toBeNull();
    expect(gate.claim(perm({ tool_name: "Write" }))).toBeNull();
    expect(gate.claim(perm({ prompt_id: "p2" }))).toBeNull(); // 양쪽에 있으면 같아야 한다
  });

  it("관문 호출 기록에 tool_input 원문이 없다", () => {
    reach();
    gate.preToolUse(pre({ tool_input: { command: "RAW-FAKE-COMMAND" } }));
    expect(JSON.stringify(gate)).not.toContain("RAW-FAKE-COMMAND");
    expect(JSON.stringify([...Object.values(gate as unknown as Record<string, unknown>)].map((v) => (v instanceof Map ? [...v.entries()] : v)))).not.toContain("RAW-FAKE-COMMAND");
  });

  it("10초가 지나면 null", () => {
    reach();
    gate.preToolUse(pre());
    clock += 10_001;
    expect(gate.claim(perm())).toBeNull();
  });

  it("다른 세션이면 null", () => {
    reach();
    gate.preToolUse(pre());
    expect(gate.claim(perm({ session_id: "s2" }))).toBeNull();
  });
});

describe("계속·중단·터미널 허용", () => {
  it("계속을 고르면 nextGateAt이 오르고 다음 preToolUse는 null", () => {
    reach();
    gate.preToolUse(pre());
    gate.resolved(view({ outcome: "continue" }));
    expect(store.get("s1")!.nextGateAt).toBe(2000);
    expect(demoted).toEqual(["s1"]);
    expect(gate.preToolUse(pre({ tool_use_id: "tu-2" }))).toBeNull();
    // 이미 계속으로 처리한 관문 호출의 PostToolUse가 와도 다시 올리지 않는다
    gate.onEvent({ hook_event_name: "PostToolUse", session_id: "s1", tool_use_id: "tu-1" });
    expect(store.get("s1")!.nextGateAt).toBe(2000);
  });

  it("중단을 고르면 nextGateAt은 그대로이고 다음 preToolUse도 ask", () => {
    reach();
    gate.preToolUse(pre());
    gate.resolved(view({ outcome: "stop" }));
    gate.resolved(view({ kind: "permission", outcome: "allow" }));
    expect(store.get("s1")!.nextGateAt).toBe(1000);
    expect(demoted).toEqual([]);
    expect(gate.preToolUse(pre({ tool_use_id: "tu-2" }))).toEqual(ASK);
  });

  it("터미널에서 허용하면(PostToolUse가 관문 호출의 tool_use_id로 옴) 계속으로 본다", () => {
    reach();
    gate.preToolUse(pre());
    gate.onEvent({ hook_event_name: "PostToolUse", session_id: "s1", tool_use_id: "other" });
    expect(store.get("s1")!.nextGateAt).toBe(1000);
    gate.onEvent({ hook_event_name: "PostToolUse", session_id: "s1", tool_use_id: "tu-1" });
    expect(store.get("s1")!.nextGateAt).toBe(2000);
    expect(demoted).toEqual(["s1"]);
  });

  it("PermissionDenied면 그대로", () => {
    reach();
    gate.preToolUse(pre());
    gate.onEvent({ hook_event_name: "PermissionDenied", session_id: "s1", tool_use_id: "tu-1" });
    gate.onEvent({ hook_event_name: "PostToolUseFailure", session_id: "s1", tool_use_id: "tu-1" });
    expect(store.get("s1")!.nextGateAt).toBe(1000);
  });

  it("view: reached는 used >= nextGateAt", () => {
    expect(gate.view("s1")).toBeUndefined();
    store.setBudget("s1", 1000, 0);
    gate.setUsage("s1", 999);
    expect(gate.view("s1")).toEqual({ budgetTokens: 1000, usedTokens: 999, nextGateAt: 1000, reached: false });
    gate.setUsage("s1", 1000);
    expect(gate.view("s1")!.reached).toBe(true);
    expect(gate.usage("s1")).toBe(1000);
  });
});

describe("스냅샷의 층 예산", () => {
  it("스냅샷의 층에 budget {budgetTokens, usedTokens, nextGateAt, reached}가 나온다", async () => {
    const h = await makeHome();
    try {
      const NOW = Date.now();
      await h.write("sessions/1.json", { pid: 1, sessionId: "s1", name: "a", cwd: "/x", status: "busy", updatedAt: NOW - 1000 });
      await h.write("sessions/2.json", { pid: 2, sessionId: "s2", name: "b", cwd: "/y", status: "idle", updatedAt: NOW - 1000 });
      await h.append("projects/-p/s1.jsonl", [assistant({ requestId: "r1", ts: NOW - 5000, input: 1000, cacheRead: 9000, output: 500 })]);
      store.setDefault(700);
      store.setBudget("s1", 1000, 0);
      const snap = await new SnapshotBuilder({ claudeHome: h.home, config: { budget: {}, contextWindows: {} }, isAlive: () => true, budget: { gate, store } }).build(NOW);
      const s1 = snap.sessions.find((s) => s.id === "s1")!;
      const s2 = snap.sessions.find((s) => s.id === "s2")!;
      expect(s1.budget).toEqual({ budgetTokens: 1000, usedTokens: 1500, nextGateAt: 1000, reached: true });
      expect(s2.budget).toEqual({ budgetTokens: 700, usedTokens: 0, nextGateAt: 700, reached: false }); // 처음 본 세션: 기본값
      expect(snap.defaultBudgetTokens).toBe(700);
      expect(gate.preToolUse(pre())).toEqual(ASK);
    } finally {
      await h.cleanup();
    }
  });
});
