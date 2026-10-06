import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../server/app";
import { BudgetGate } from "../../server/budget/gate";
import { BudgetStore } from "../../server/budget/store";
import { budgetReason, policyAskReason, policyDenyReason, preToolAsk, preToolDeny } from "../../server/decisions/protocol";
import { DecisionQueue } from "../../server/decisions/queue";
import { Logger, setLogger } from "../../server/log";
import { PolicyGate, type PolicyVerdict } from "../../server/policy/gate";
import { MAX_TARGETS, PolicyStore } from "../../server/policy/store";
import { makeSession, makeSnapshot } from "../web/fixtures";

const TOKEN = "b".repeat(64);
type Policy = { preToolUse(input: Record<string, unknown>): PolicyVerdict | null; claim(input: Record<string, unknown>): boolean };

let server: Server;
let port: number;
let tmp: string;
let logDir: string;
let policyDir: string;
let queue: DecisionQueue;
let budgetStore: BudgetStore;
let budgetGate: BudgetGate;
let policyStore: PolicyStore;
let policyGate: PolicyGate;
let policy: Policy;
let onHookEvent: ReturnType<typeof vi.fn<(input: Record<string, unknown>) => void>>;
let accepted: string[];
let pokes: number;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "co-papi-"));
  logDir = join(tmp, "logs");
  policyDir = join(tmp, "policy");
  mkdirSync(policyDir);
  setLogger(new Logger({ dir: logDir }));
  budgetStore = new BudgetStore(join(tmp, "state.json"));
  budgetStore.load();
  budgetGate = new BudgetGate(budgetStore, { demote: (id) => queue.demoteBudget(id) });
  queue = new DecisionQueue({ onResolve: (v) => budgetGate.resolved(v) });
  policyStore = new PolicyStore(join(policyDir, "policy.json"));
  policyStore.load();
  policyGate = new PolicyGate(policyStore);
  policy = policyGate;
  onHookEvent = vi.fn<(input: Record<string, unknown>) => void>();
  accepted = [];
  pokes = 0;
  const snap = makeSnapshot({ sessions: [makeSession({ id: "s1" })] });
  server = createApp(
    { current: () => snap, subscribe: () => () => {}, poke: () => void pokes++ },
    {
      auth: { token: TOKEN },
      onHookEvent: (i) => onHookEvent(i),
      stats: { accept: (e: string) => void accepted.push(e), reject: () => {} } as never,
      decisions: queue,
      gate: budgetGate,
      // 테스트마다 바꿀 수 있게 위임한다
      policy: { preToolUse: (i) => policy.preToolUse(i), claim: (i) => policy.claim(i) },
      policyApi: policyStore,
    },
  ).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  queue.stop();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  setLogger(new Logger({ dir: "" }));
  if (existsSync(policyDir)) chmodSync(policyDir, 0o755);
  rmSync(tmp, { recursive: true, force: true });
});

type Res = { status: number; body: string; ms: number };
function send(path: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  const t0 = performance.now();
  return new Promise<Res>((resolve, reject) => {
    // Node는 DELETE 본문에 chunked를 쓰지 않으므로 길이를 적는다(브라우저 fetch도 Content-Length를 보낸다)
    const length = o.body === undefined ? {} : { "Content-Length": String(Buffer.byteLength(o.body)) };
    const req = request({ host: "127.0.0.1", port, path, method: o.method ?? "POST", headers: { Host: `127.0.0.1:${port}`, ...length, ...o.headers } }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text, ms: performance.now() - t0 }));
    });
    req.on("error", reject);
    req.end(o.body);
  });
}
const hook = (body: Record<string, unknown>) => send("/hooks/event", { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const PAGE = () => ({ Cookie: `co=${TOKEN}`, Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" });
const put = (target: string, body: unknown, headers: Record<string, string> = {}) =>
  send(`/api/policy/targets/${target}`, { method: "PUT", headers: { ...PAGE(), ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const del = (target: string, headers: Record<string, string> = {}) => send(`/api/policy/targets/${target}`, { method: "DELETE", headers: { ...PAGE(), ...headers }, body: "{}" });
const getPolicy = async () => JSON.parse((await send("/api/policy", { method: "GET", headers: { Cookie: `co=${TOKEN}` } })).body) as { version: number; targets: Record<string, Record<string, string>> };
const enc = encodeURIComponent;

const INPUT = { session_id: "s1", tool_name: "Bash", tool_input: { command: "FAKE-CMD-123" }, prompt_id: "p1" };
const pre = (o: Record<string, unknown> = {}) => ({ hook_event_name: "PreToolUse", tool_use_id: "tu-1", ...INPUT, ...o });
const permReq = (o: Record<string, unknown> = {}) => ({ hook_event_name: "PermissionRequest", ...INPUT, ...o });
async function until<T>(fn: () => T | undefined, ms = 2000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("시간 초과");
    await new Promise((r) => setTimeout(r, 5));
  }
}
const pending = () => until(() => queue.list().find((v) => v.state === "pending"));
const reachBudget = () => {
  budgetStore.setBudget("s1", 1000, 0);
  budgetGate.setUsage("s1", 1200);
};
const logText = () => (existsSync(logDir) ? readdirSync(logDir).map((f) => readFileSync(join(logDir, f), "utf8")).join("") : "");

describe("판정 순서(스펙 6.2)", () => {
  it("정책 deny면 즉시 deny이고 예산 관문 기록을 만들지 않는다", async () => {
    reachBudget();
    policyStore.set("lead", { bash: "deny" });
    const r = await hook(pre());
    expect(JSON.parse(r.body)).toEqual(preToolDeny(policyDenyReason("리드", "명령 실행 금지")));
    expect(queue.list()).toEqual([]);
    hook(permReq()).catch(() => {}); // 붙잡힌 채 끝난다(afterEach가 연결을 끊는다)
    const v = await pending();
    expect(v.kind).toBe("permission");
    expect("byPolicy" in v).toBe(false);
  });

  it("예산 관문이 정책 ask보다 먼저다", async () => {
    reachBudget();
    policyStore.set("lead", { bash: "ask" });
    const r = await hook(pre());
    expect(JSON.parse(r.body)).toEqual(preToolAsk(budgetReason(1000)));
    hook(permReq()).catch(() => {}); // 붙잡힌 채 끝난다(afterEach가 연결을 끊는다)
    const v = await pending();
    expect(v.kind).toBe("budget");
    expect("byPolicy" in v).toBe(false);
    expect(policyGate.countsOf("lead").asked).toBe(0);
  });

  it("예산에 안 닿았으면 정책 ask, 뒤따르는 PermissionRequest는 byPolicy", async () => {
    policyStore.set("lead", { bash: "ask" });
    const r = await hook(pre());
    expect(JSON.parse(r.body)).toEqual(preToolAsk(policyAskReason("리드", "명령 실행 항상 질문")));
    hook(permReq()).catch(() => {}); // 붙잡힌 채 끝난다(afterEach가 연결을 끊는다)
    const v = await pending();
    expect(v).toMatchObject({ kind: "permission", byPolicy: true });
    hook(permReq({ tool_input: { command: "other" } })).catch(() => {}); // 붙잡힌 채 끝난다(afterEach가 연결을 끊는다)
    const v2 = await until(() => queue.list().find((d) => d.id !== v.id));
    expect("byPolicy" in v2).toBe(false);
  });

  it("아무것도 아니면 빈 200", async () => {
    const r = await hook(pre());
    expect([r.status, r.body]).toEqual([200, ""]);
  });

  it.each<[string, Policy]>([
    ["preToolUse가 던짐", { preToolUse: () => { throw new TypeError("x"); }, claim: () => false }],
    ["respond가 던짐", { preToolUse: () => ({ decision: "deny" as const, respond: () => { throw new RangeError("x"); } }), claim: () => false }],
    ["ask의 respond가 던짐", { preToolUse: () => ({ decision: "ask" as const, respond: () => { throw new RangeError("x"); } }), claim: () => false }],
  ])("정책 판정이 던져도 예산 관문과 큐는 동작한다(스펙 6.4) — %s", async (_l, fake) => {
    policy = fake;
    expect(await hook(pre())).toMatchObject({ status: 200, body: "" });
    reachBudget();
    expect(JSON.parse((await hook(pre())).body)).toEqual(preToolAsk(budgetReason(1000)));
    const lines = logText().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { level: string; src: string; data?: { error?: string } });
    const errs = lines.filter((l) => l.level === "error" && l.src === "policy");
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.every((l) => l.data?.error === "TypeError" || l.data?.error === "RangeError")).toBe(true);
  });

  it("정책 claim이 던져도 PermissionRequest는 붙잡힌다", async () => {
    policy = { preToolUse: () => null, claim: () => { throw new Error("x"); } };
    hook(permReq()).catch(() => {}); // 붙잡힌 채 끝난다(afterEach가 연결을 끊는다)
    expect((await pending()).kind).toBe("permission");
  });

  it("deny된 PreToolUse는 이벤트 저장소에 들어가지 않는다(B79)", async () => {
    policyStore.set("lead", { bash: "deny", edit: "ask" });
    await hook(pre());
    expect(onHookEvent).not.toHaveBeenCalled();
    expect(accepted).toEqual(["PreToolUse"]);
    await hook(pre({ tool_name: "Edit" }));
    await hook(pre({ tool_name: "Read" }));
    expect(onHookEvent.mock.calls.map((c) => (c[0] as { tool_name: string }).tool_name)).toEqual(["Edit", "Read"]);
  });

  it("hook 응답은 1초 안이다(실측)", async () => {
    for (let i = 0; i < MAX_TARGETS - 1; i++) policyStore.set(`agent:a${i}`, { bash: "deny" });
    policyStore.set("lead", { bash: "deny" });
    let slowest = 0;
    for (let i = 0; i < 50; i++) slowest = Math.max(slowest, (await hook(pre({ tool_input: { command: `c${i}` } }))).ms);
    expect(slowest).toBeLessThan(1000);
  });

  it("응답 본문과 로그에 tool_input 원문이 없다", async () => {
    policyStore.set("lead", { bash: "deny", edit: "ask" });
    const a = await hook(pre());
    const b = await hook(pre({ tool_name: "Edit" }));
    expect([a.body.includes("FAKE-CMD-123"), b.body.includes("FAKE-CMD-123"), logText().includes("FAKE-CMD-123")]).toEqual([false, false, false]);
  });
});

describe("정책 API(스펙 7.4)", () => {
  it("GET /api/policy는 전체 정책을 준다, 쿠키도 Bearer도 없으면 401", async () => {
    policyStore.set("lead", { bash: "ask" });
    expect(await getPolicy()).toEqual({ version: 1, targets: { lead: { bash: "ask" } } });
    const r = await send("/api/policy", { method: "GET" });
    expect(r.status).toBe(401);
    expect(JSON.parse(r.body)).toMatchObject({ app: "claude-office" });
  });

  it("PUT으로 한 대상을 통째로 바꾼다", async () => {
    const a = await put(enc("agent:reviewer"), { rules: { bash: "deny" } });
    expect([a.status, JSON.parse(a.body)]).toEqual([200, { saved: true }]);
    await put(enc("agent:reviewer"), { rules: { web: "ask" } });
    expect((await getPolicy()).targets).toEqual({ "agent:reviewer": { web: "ask" } });
  });

  it("빈 rules는 그 대상을 지운다, DELETE는 지우고 없는 대상에도 200", async () => {
    await put("lead", { rules: { bash: "deny" } });
    expect((await put("lead", { rules: {} })).status).toBe(200);
    expect((await getPolicy()).targets).toEqual({});
    await put("others", { rules: { bash: "deny" } });
    const d = await del("others");
    expect([d.status, JSON.parse(d.body)]).toEqual([200, { saved: true }]);
    expect((await getPolicy()).targets).toEqual({});
    expect((await del(enc("agent:nobody"))).status).toBe(200);
  });

  it.each([
    ["대상 team:x", enc("team:x"), { rules: { bash: "deny" } }],
    ["대상 agent:", enc("agent:"), { rules: { bash: "deny" } }],
    ["대상 agent:__proto__", enc("agent:__proto__"), { rules: { bash: "deny" } }],
    ["대상 101자", enc(`agent:${"가".repeat(101)}`), { rules: { bash: "deny" } }],
    ["값 allow", "lead", { rules: { bash: "allow" } }],
    ["묶음 shell", "lead", { rules: { shell: "deny" } }],
    ["다른 키", "lead", { rules: { bash: "deny" }, extra: 1 }],
    ["rules 배열", "lead", { rules: [] }],
    ["빈 본문 객체", "lead", {}],
    ["본문 배열", "lead", []],
    ["JSON 아님", "lead", "{nope"],
    ["rules에 __proto__", "lead", '{"rules":{"__proto__":"deny"}}'],
  ])("400인 경우 — %s", async (_l, target, body) => {
    const r = await put(target, body);
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body)).toEqual({});
  });

  it("4kb 초과는 413", async () => {
    expect((await put("lead", { rules: { bash: "deny" }, pad: "x".repeat(5000) })).status).toBe(413);
  });

  it("allow는 어떤 경로로도 저장되지 않는다", async () => {
    await put("lead", { rules: { bash: "allow" } });
    await put("lead", { rules: { bash: "deny", edit: "allow" } });
    await put("lead", '{"rules":{"bash":"allow"}}');
    const file = join(policyDir, "policy.json");
    expect(JSON.stringify(await getPolicy()).includes("allow")).toBe(false);
    expect(existsSync(file) && readFileSync(file, "utf8").includes("allow")).toBe(false);
  });

  it("상한 200을 넘는 새 대상은 400 { reason: limit }이고 기존 대상은 고칠 수 있다", async () => {
    for (let i = 0; i < MAX_TARGETS; i++) policyStore.set(`agent:a${i}`, { bash: "deny" });
    const r = await put(enc("agent:new"), { rules: { bash: "deny" } });
    expect([r.status, JSON.parse(r.body)]).toEqual([400, { reason: "limit" }]);
    expect((await put(enc("agent:a0"), { rules: { edit: "ask" } })).status).toBe(200);
    expect(JSON.parse((await put(enc("agent:new"), { rules: { bash: "allow" } })).body)).toEqual({});
  });

  it("쓰기 인증은 예산 API와 같다", async () => {
    expect((await put("lead", { rules: { bash: "deny" } }, { Origin: "http://evil.example" })).status).toBe(403);
    expect((await put("lead", { rules: { bash: "deny" } }, { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await put("lead", { rules: { bash: "deny" } }, { Cookie: "" })).status).toBe(401);
    expect((await del("lead", { Origin: "http://evil.example" })).status).toBe(403);
    const cli = await send("/api/policy/targets/lead", { method: "PUT", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ rules: { bash: "deny" } }) });
    expect(cli.status).toBe(200);
    expect((await getPolicy()).targets).toEqual({ lead: { bash: "deny" } });
  });

  it("이름에 슬래시·한글·콜론·퍼센트가 있어도 PUT·GET·DELETE가 같은 대상을 가리킨다", async () => {
    for (const key of ["agent:a/b", "agent:검토 담당", "agent:a:b", "agent:100%"]) {
      expect((await put(enc(key), { rules: { bash: "deny" } })).status).toBe(200);
      expect(Object.keys((await getPolicy()).targets)).toEqual([key]);
      expect((await del(enc(key))).status).toBe(200);
      expect((await getPolicy()).targets).toEqual({});
    }
  });

  it("퍼센트 인코딩이 깨진 주소는 400", async () => {
    const r = await put("agent%3A%E0%A4%A", { rules: { bash: "deny" } });
    expect(r.status).toBe(400);
    expect([r.body.includes("at "), r.body.includes("/"), r.body.includes("URIError")]).toEqual([false, false, false]);
    expect((await del("agent%3A%E0%A4%A")).status).toBe(400);
  });

  it("저장에 실패하면 200 { saved: false }이고 정책은 적용된다(B87)", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    chmodSync(policyDir, 0o555);
    const r = await put("lead", { rules: { bash: "deny" } });
    expect([r.status, JSON.parse(r.body)]).toEqual([200, { saved: false }]);
    expect(JSON.parse((await hook(pre())).body)).toEqual(preToolDeny(policyDenyReason("리드", "명령 실행 금지")));
  });

  it("정책이 바뀌면 hub.poke가 불린다", async () => {
    await put("lead", { rules: { bash: "deny" } });
    expect(pokes).toBe(1);
    await del("lead");
    expect(pokes).toBe(2);
    await put("lead", { rules: { bash: "allow" } });
    expect(pokes).toBe(2);
  });
});
