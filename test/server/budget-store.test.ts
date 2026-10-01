import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BudgetStore, KEEP_MS } from "../../server/budget/store";
import { Logger, setLogger } from "../../server/log";

// 저장(임시 파일 → rename) 횟수와 경로를 보려고 renameSync를 감싼다(vi.mock은 import보다 먼저 실행된다)
const renames: Array<[string, string]> = vi.hoisted(() => []);
vi.mock("node:fs", async (orig) => {
  const m = await orig<typeof import("node:fs")>();
  return { ...m, renameSync: (a: string, b: string) => (renames.push([String(a), String(b)]), m.renameSync(a, b)) };
});

let dir: string;
let logDir: string;
let clock: number;
const T0 = Date.UTC(2026, 9, 2);
const store = (file = join(dir, "state.json")) => new BudgetStore(file, () => clock);
const read = (file = join(dir, "state.json")) => JSON.parse(readFileSync(file, "utf8")) as unknown;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "co-budget-"));
  logDir = join(dir, "logs");
  setLogger(new Logger({ dir: logDir, now: () => clock }));
  clock = T0;
  renames.length = 0;
});
afterEach(() => {
  setLogger(new Logger({ dir: "" }));
  if (existsSync(dir)) chmodSync(dir, 0o755);
  rmSync(dir, { recursive: true, force: true });
});

describe("BudgetStore", () => {
  it("저장은 임시 파일에 쓴 뒤 rename한다", () => {
    const s = store();
    s.load();
    s.setBudget("s1", 500_000, 0);
    const file = join(dir, "state.json");
    expect(renames).toHaveLength(1);
    expect(renames[0][0].startsWith(`${file}.tmp-`)).toBe(true);
    expect(renames[0][1]).toBe(file);
    expect(readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("손상된 state.json이면 빈 상태로 시작하고 warn", () => {
    const file = join(dir, "state.json");
    writeFileSync(file, "{not json");
    const s = store();
    expect(() => s.load()).not.toThrow();
    expect(s.get("s1")).toBeUndefined();
    const lines = readdirSync(logDir).flatMap((f) => readFileSync(join(logDir, f), "utf8").trim().split("\n")).map((l) => JSON.parse(l) as { level: string; src: string; msg: string });
    expect(lines).toEqual([expect.objectContaining({ level: "warn", src: "budget", msg: "state unreadable, starting empty" })]);
    s.setBudget("s1", 1000, 0);
    expect(read()).toMatchObject({ sessions: { s1: { budgetTokens: 1000 } } }); // 다음 저장 때 덮어쓴다
  });

  it("모양이 틀린 값은 버린다", () => {
    writeFileSync(join(dir, "state.json"), JSON.stringify({ defaultBudgetTokens: "x", sessions: { a: { budgetTokens: -1, nextGateAt: 5, seenAt: T0 }, b: "x", c: { budgetTokens: 2000, nextGateAt: 4000, seenAt: T0 } } }));
    const s = store();
    s.load();
    expect(s.defaultTokens()).toBeUndefined();
    expect(s.get("a")).toBeUndefined();
    expect(s.get("b")).toBeUndefined();
    expect(s.get("c")).toEqual({ budgetTokens: 2000, nextGateAt: 4000 });
  });

  it("파일이 없으면 조용히 빈 상태, 폴더가 없으면 만든다", () => {
    const file = join(dir, "a", "b", "state.json");
    const s = store(file);
    s.load();
    expect(existsSync(logDir)).toBe(false); // warn 없음
    s.setDefault(2000);
    expect(read(file)).toEqual({ defaultBudgetTokens: 2000, sessions: {} });
  });

  it("저장에 실패해도(읽기 전용 폴더) 던지지 않고 메모리 값은 유지한다", () => {
    if (process.platform === "win32") return;
    const ro = join(dir, "ro");
    mkdirSync(ro);
    chmodSync(ro, 0o555);
    try {
      const s = store(join(ro, "state.json"));
      s.load();
      expect(() => s.setBudget("s1", 1000, 0)).not.toThrow();
      expect(s.get("s1")).toEqual({ budgetTokens: 1000, nextGateAt: 1000 });
    } finally {
      chmodSync(ro, 0o755);
    }
  });

  it("setBudget: 처음 값은 budgetTokens, 사용량이 이미 넘었으면 사용량을 넘는 첫 배수(B34)", () => {
    const s = store();
    s.setBudget("a", 500_000, 0);
    s.setBudget("b", 100_000, 250_000);
    s.setBudget("c", 100_000, 100_000);
    expect(s.get("a")).toEqual({ budgetTokens: 500_000, nextGateAt: 500_000 });
    expect(s.get("b")).toEqual({ budgetTokens: 100_000, nextGateAt: 300_000 });
    expect(s.get("c")).toEqual({ budgetTokens: 100_000, nextGateAt: 200_000 });
  });

  it("raise: nextGateAt += budgetTokens(스펙 식), 크게 넘었으면 사용량을 넘을 때까지", () => {
    const s = store();
    s.setBudget("a", 500_000, 0);
    s.raise("a", 520_000);
    expect(s.get("a")!.nextGateAt).toBe(1_000_000);
    s.setBudget("b", 100_000, 0);
    s.raise("b", 350_000);
    expect(s.get("b")!.nextGateAt).toBe(400_000);
    s.raise("none", 1); // 예산 없는 세션은 무시
    expect(s.get("none")).toBeUndefined();
  });

  it("setBudget(null)은 예산을 없앤다", () => {
    const s = store();
    s.setBudget("a", 1000, 0);
    s.setBudget("a", null, 0);
    expect(s.get("a")).toBeUndefined();
    expect(read()).toEqual({ sessions: { a: { seenAt: T0 } } });
  });

  it("setDefault는 처음 보는 세션에만 적용된다", () => {
    const s = store();
    s.touch(["old"]);
    s.setDefault(5000);
    s.touch(["old", "new"], (id) => (id === "new" ? 12_000 : 0));
    expect(s.get("old")).toBeUndefined();
    expect(s.get("new")).toEqual({ budgetTokens: 5000, nextGateAt: 15_000 }); // 이미 쓴 양을 넘는 첫 배수(B34)
    expect(s.defaultTokens()).toBe(5000);
    s.setDefault(null);
    expect(s.defaultTokens()).toBeUndefined();
  });

  it("30일 넘게 보이지 않은 세션 항목은 지운다", () => {
    const s = store();
    s.setBudget("gone", 1000, 0);
    s.touch(["stay"]);
    clock += KEEP_MS - 1;
    s.touch(["stay"]);
    expect(s.get("gone")).toBeDefined();
    clock += 2;
    s.touch(["stay"]);
    expect(s.get("gone")).toBeUndefined();
    expect(Object.keys((read() as { sessions: object }).sessions)).toEqual(["stay"]);
  });

  it("seenAt만 바뀌면 1시간에 한 번만 저장한다", () => {
    const s = store();
    s.touch(["a"]); // 새 항목: 저장 1
    renames.length = 0;
    for (let i = 0; i < 100; i++) {
      clock += 3000;
      s.touch(["a"]);
    }
    expect(renames).toHaveLength(0);
    clock += 3_600_000;
    s.touch(["a"]);
    expect(renames).toHaveLength(1);
    expect(read()).toEqual({ sessions: { a: { seenAt: clock } } });
  });

  it("파일 형식", () => {
    const s = store();
    s.setDefault(9000);
    s.setBudget("s1", 1000, 0);
    s.touch(["s2"]);
    expect(read()).toEqual({
      defaultBudgetTokens: 9000,
      sessions: { s1: { budgetTokens: 1000, nextGateAt: 1000, seenAt: T0 }, s2: { budgetTokens: 9000, nextGateAt: 9000, seenAt: T0 } },
    });
    const again = store();
    again.load();
    expect(again.get("s1")).toEqual({ budgetTokens: 1000, nextGateAt: 1000 });
    expect(again.defaultTokens()).toBe(9000);
  });
});
