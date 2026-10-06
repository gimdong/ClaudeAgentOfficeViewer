import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_TARGETS, PolicyStore, isTargetKey, kindOf, parseRules } from "../../server/policy/store";
import { Logger, setLogger } from "../../server/log";

// 저장(임시 파일 → rename) 경로를 보려고 renameSync를 감싼다(budget-store.test.ts와 같은 방식)
const renames: Array<[string, string]> = vi.hoisted(() => []);
vi.mock("node:fs", async (orig) => {
  const m = await orig<typeof import("node:fs")>();
  return { ...m, renameSync: (a: string, b: string) => (renames.push([String(a), String(b)]), m.renameSync(a, b)) };
});

let dir: string;
let logDir: string;
const fileOf = () => join(dir, "policy.json");
const store = (file = fileOf()) => {
  const s = new PolicyStore(file);
  s.load();
  return s;
};
const read = (file = fileOf()) => JSON.parse(readFileSync(file, "utf8")) as unknown;
const logLines = () =>
  existsSync(logDir)
    ? readdirSync(logDir).flatMap((f) => readFileSync(join(logDir, f), "utf8").trim().split("\n")).filter(Boolean)
    : [];
const policyWarns = () => logLines().filter((l) => {
  const j = JSON.parse(l) as { level: string; src: string };
  return j.level === "warn" && j.src === "policy";
});
const proto = (o: object | undefined) => (o ? Object.getPrototypeOf(o) : undefined);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "co-policy-"));
  logDir = join(dir, "logs");
  setLogger(new Logger({ dir: logDir }));
  renames.length = 0;
});
afterEach(() => {
  setLogger(new Logger({ dir: "" }));
  if (existsSync(dir)) chmodSync(dir, 0o755);
  rmSync(dir, { recursive: true, force: true });
});

describe("PolicyStore", () => {
  it("파일 형식", () => {
    const s = store();
    expect(s.set("agent:reviewer", { bash: "deny", edit: "deny" })).toEqual({ ok: true, saved: true });
    expect(read()).toEqual({ version: 1, targets: { "agent:reviewer": { bash: "deny", edit: "deny" } } });
  });

  it("저장은 임시 파일에 쓴 뒤 rename하고 0600이다", () => {
    const s = store();
    s.set("lead", { bash: "ask" });
    expect(renames).toHaveLength(1);
    expect(renames[0][0].startsWith(`${fileOf()}.tmp-`)).toBe(true);
    expect(renames[0][1]).toBe(fileOf());
    if (process.platform !== "win32") expect(statSync(fileOf()).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("파일이 없으면 조용히 빈 정책, 폴더가 없으면 저장할 때 만든다", () => {
    const file = join(dir, "sub", "deeper", "policy.json");
    const s = store(file);
    expect(s.all()).toEqual({ version: 1, targets: {} });
    expect(policyWarns()).toEqual([]);
    expect(s.set("lead", { bash: "ask" })).toEqual({ ok: true, saved: true });
    expect(read(file)).toEqual({ version: 1, targets: { lead: { bash: "ask" } } });
  });

  it("allow가 파일에 있으면 그 규칙만 무시하고 warn을 남긴다(개수만)", () => {
    writeFileSync(fileOf(), JSON.stringify({ version: 1, targets: { lead: { bash: "allow", edit: "deny" } } }));
    const s = store();
    expect({ ...s.rulesOf("lead") }).toEqual({ edit: "deny" });
    const warns = policyWarns();
    expect(warns).toHaveLength(1);
    expect(JSON.parse(warns[0]).data).toEqual({ ignored: 1 });
    expect(warns[0].includes("allow")).toBe(false);
    expect(warns[0].includes("lead")).toBe(false);
  });

  it('걸러 내고 규칙이 하나도 안 남은 대상은 "규칙 없는 대상"이다', () => {
    writeFileSync(fileOf(), JSON.stringify({ version: 1, targets: { "agent:rev": { bash: "allow" }, others: { bash: "deny" } } }));
    const s = store();
    expect(s.rulesOf("agent:rev")).toBeUndefined();
    const r = s.resolve("agent:rev");
    expect(r?.source).toBe("others");
    expect({ ...r?.rules }).toEqual({ bash: "deny" });
    expect(Object.keys(s.all().targets)).toEqual(["others"]);
    expect(s.summary().targets).toBe(1);
  });

  it("깨진 파일은 빈 정책으로 시작하고, 다음 저장 전에 policy.json.broken으로 옮긴다", () => {
    writeFileSync(fileOf(), "{oops");
    const s = store();
    expect(s.all().targets).toEqual({});
    expect(policyWarns()).toHaveLength(1);
    expect(existsSync(`${fileOf()}.broken`)).toBe(false);
    s.set("lead", { bash: "ask" });
    expect(readFileSync(`${fileOf()}.broken`, "utf8")).toBe("{oops");
    expect(read()).toEqual({ version: 1, targets: { lead: { bash: "ask" } } });
    s.set("lead", { bash: "deny" });
    expect(readFileSync(`${fileOf()}.broken`, "utf8")).toBe("{oops");
  });

  it.each([
    ["targets가 배열", '{"version":1,"targets":[]}'],
    ["targets가 null", '{"version":1,"targets":null}'],
    ["targets가 문자열", '{"version":1,"targets":"x"}'],
    ["version이 2", '{"version":2,"targets":{"lead":{"bash":"deny"}}}'],
    ["최상위가 배열", "[]"],
  ])("손으로 고친 파일의 이상한 모양들 — %s는 깨진 파일", (_l, text) => {
    writeFileSync(fileOf(), text);
    const s = store();
    expect(s.all().targets).toEqual({});
    s.set("others", { web: "ask" });
    expect(readFileSync(`${fileOf()}.broken`, "utf8")).toBe(text);
  });

  it("손으로 고친 파일의 이상한 모양들 — 앞에 BOM이 붙은 올바른 파일은 그대로 읽는다", () => {
    writeFileSync(fileOf(), '﻿{"version":1,"targets":{"lead":{"bash":"deny"}}}');
    const s = store();
    expect({ ...s.rulesOf("lead") }).toEqual({ bash: "deny" });
    expect(policyWarns()).toEqual([]);
  });

  it.each([
    ["값 Deny", { lead: { bash: "Deny", edit: "deny" } }],
    ["값 1", { lead: { bash: 1, edit: "deny" } }],
    ["값 null", { lead: { bash: null, edit: "deny" } }],
    ["묶음 키 shell", { lead: { shell: "deny", edit: "deny" } }],
  ])("손으로 고친 파일의 이상한 모양들 — %s는 그 규칙만 무시", (_l, targets) => {
    writeFileSync(fileOf(), JSON.stringify({ version: 1, targets }));
    const s = store();
    expect({ ...s.rulesOf("lead") }).toEqual({ edit: "deny" });
    expect(JSON.parse(policyWarns()[0]).data).toEqual({ ignored: 1 });
  });

  it.each(["Agent:reviewer", "agent:", "__proto__"])("손으로 고친 파일의 이상한 모양들 — 대상 키 %s는 그 대상만 무시", (key) => {
    // "__proto__"는 JSON.parse로 만들어야 own 키가 된다
    writeFileSync(fileOf(), `{"version":1,"targets":{${JSON.stringify(key)}:{"bash":"deny"},"lead":{"edit":"deny"}}}`);
    const s = store();
    expect(Object.keys(s.all().targets)).toEqual(["lead"]);
    expect(policyWarns()).toHaveLength(1);
  });

  it("규칙 객체가 배열이나 문자열인 대상도 그 대상만 무시하고 load는 던지지 않는다", () => {
    writeFileSync(fileOf(), '{"version":1,"targets":{"agent:a":[],"agent:b":"deny","agent:c":null,"lead":{"edit":"deny"}}}');
    expect(() => store()).not.toThrow();
    expect(Object.keys(store().all().targets)).toEqual(["lead"]);
  });

  it("저장에 실패해도(읽기 전용 폴더) 던지지 않고 메모리의 정책은 바뀌며 saved: false", () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const ro = join(dir, "ro");
    mkdirSync(ro);
    chmodSync(ro, 0o555);
    try {
      const s = store(join(ro, "policy.json"));
      expect(s.set("lead", { bash: "deny" })).toEqual({ ok: true, saved: false });
      expect({ ...s.rulesOf("lead") }).toEqual({ bash: "deny" });
      expect(policyWarns().length).toBeGreaterThanOrEqual(1);
      expect(s.remove("lead")).toEqual({ ok: true, saved: false });
      expect(s.rulesOf("lead")).toBeUndefined();
    } finally {
      chmodSync(ro, 0o755);
    }
  });

  it("상한 200: 201번째 새 대상은 limit, 이미 있는 대상 고치기와 지우기는 된다", () => {
    const s = store();
    for (let i = 0; i < MAX_TARGETS; i++) expect(s.set(`agent:a${i}`, { bash: "deny" }).ok).toBe(true);
    expect(s.set("agent:new", { bash: "deny" })).toEqual({ ok: false, reason: "limit" });
    expect(s.rulesOf("agent:new")).toBeUndefined();
    expect(s.set("agent:a0", { edit: "ask" })).toEqual({ ok: true, saved: true });
    expect(s.remove("agent:a1")).toEqual({ ok: true, saved: true });
    expect(s.set("agent:new", { bash: "deny" }).ok).toBe(true);
  });

  it("파일에 대상이 200개를 넘으면 앞에서부터 200개만 담고 나머지를 센다", () => {
    const targets: Record<string, object> = {};
    for (let i = 0; i < MAX_TARGETS + 3; i++) targets[`agent:a${i}`] = { bash: "deny" };
    writeFileSync(fileOf(), JSON.stringify({ version: 1, targets }));
    const s = store();
    expect(s.summary().targets).toBe(MAX_TARGETS);
    expect(s.rulesOf("agent:a199")).toBeDefined();
    expect(s.rulesOf("agent:a200")).toBeUndefined();
    expect(JSON.parse(policyWarns()[0]).data).toEqual({ ignored: 3 });
  });

  it("빈 rules로 set하면 그 대상을 지운다, remove는 없는 대상에도 ok", () => {
    const s = store();
    s.set("agent:x", { bash: "deny" });
    expect(s.set("agent:x", {})).toEqual({ ok: true, saved: true });
    expect(s.rulesOf("agent:x")).toBeUndefined();
    expect(read()).toEqual({ version: 1, targets: {} });
    expect(s.remove("agent:nobody").ok).toBe(true);
  });

  it("set은 받은 규칙을 복사해 담는다(null-prototype)", () => {
    const s = store();
    const rules = { bash: "deny" as const };
    s.set("lead", rules);
    (rules as Record<string, string>).bash = "ask";
    expect(s.rulesOf("lead")?.bash).toBe("deny");
    expect(proto(s.rulesOf("lead"))).toBeNull();
  });

  it("resolve(스펙 4.2)", () => {
    const s = store();
    s.set("agent:reviewer", { bash: "deny" });
    s.set("others", { web: "ask" });
    const own = s.resolve("agent:reviewer");
    expect(own?.source).toBe("own");
    expect({ ...own?.rules }).toEqual({ bash: "deny" });
    const qa = s.resolve("agent:qa");
    expect(qa?.source).toBe("others");
    expect({ ...qa?.rules }).toEqual({ web: "ask" });
    expect(s.resolve("lead")).toBeUndefined();
    expect(s.resolve("others")?.source).toBe("own");
    expect(s.resolve("sub:Explore")?.source).toBe("others");
  });

  it("all()은 복사본이다", () => {
    const s = store();
    s.set("lead", { bash: "deny" });
    const a = s.all();
    (a.targets.lead as Record<string, string>).bash = "ask";
    a.targets["agent:x"] = { bash: "deny" };
    expect(s.rulesOf("lead")?.bash).toBe("deny");
    expect(s.rulesOf("agent:x")).toBeUndefined();
  });

  it("summary는 대상 수와 종류별 규칙 수를 센다", () => {
    const s = store();
    s.set("lead", { bash: "ask" });
    s.set("agent:a", { bash: "deny", edit: "deny" });
    s.set("others", { web: "ask" });
    expect(s.summary()).toEqual({ targets: 3, rulesByKind: { lead: 1, agent: 2, sub: 0, others: 1 } });
  });
});

describe("isTargetKey", () => {
  const name100 = "가".repeat(99) + "👩‍👩‍👧";
  it.each(["lead", "others", "agent:reviewer", "sub:Explore", "agent:a:b", "agent:한글 이름", `agent:${name100}`])("참: %s", (k) => {
    expect(isTargetKey(k)).toBe(true);
  });
  it.each([
    "agent:", "sub:", "agent: x", "agent:x ", `agent:${name100}x`, "agent:a\u0000b", "agent:a\nb",
    "agent:__proto__", "sub:constructor", "agent:prototype", "__proto__", "Lead", "team:x", "", "lead:x",
  ])("거짓: %j", (k) => {
    expect(isTargetKey(k)).toBe(false);
  });
  it("문자열이 아니면 거짓", () => {
    for (const v of [42, undefined, null, {}, ["lead"]]) expect(isTargetKey(v)).toBe(false);
  });
});

describe("parseRules", () => {
  it("올바른 규칙과 빈 객체는 통과하고 결과는 null-prototype", () => {
    const r = parseRules({ bash: "deny", all: "ask" });
    expect({ ...r }).toEqual({ bash: "deny", all: "ask" });
    expect(proto(r ?? undefined)).toBeNull();
    expect({ ...parseRules({}) }).toEqual({});
  });
  it("모르는 묶음·값이 하나라도 있으면 null", () => {
    for (const v of [{ bash: "allow" }, { shell: "deny" }, JSON.parse('{"__proto__":"deny"}'), { bash: "deny", edit: "Deny" }, [], null, "x", 1]) {
      expect(parseRules(v)).toBeNull();
    }
  });
});

describe("kindOf", () => {
  it("대상 키의 종류", () => {
    expect([kindOf("lead"), kindOf("others"), kindOf("agent:x"), kindOf("sub:Explore")]).toEqual(["lead", "others", "agent", "sub"]);
  });
});
