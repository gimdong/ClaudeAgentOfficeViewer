import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../server/app";
import { BudgetGate } from "../../server/budget/gate";
import { BudgetStore } from "../../server/budget/store";
import type { SessionRecord } from "../../server/collectors/sessions";
import { PAUSED_REASON, preToolDeny } from "../../server/decisions/protocol";
import { DecisionQueue } from "../../server/decisions/queue";
import { FloorControl } from "../../server/floors/control";
import { Logger, setLogger } from "../../server/log";
import { PolicyGate } from "../../server/policy/gate";
import { PolicyStore } from "../../server/policy/store";
import { makeSession, makeSnapshot } from "../web/fixtures";

// 어떤 테스트도 실제 프로세스에 신호를 보내지 않는다: signal은 호출을 모으기만 하는 가짜다
const TOKEN = "c".repeat(64);
let server: Server;
let port: number;
let tmp: string;
let queue: DecisionQueue;
let budgetStore: BudgetStore;
let budgetGate: BudgetGate;
let policyStore: PolicyStore;
let policyGate: PolicyGate;
let floors: FloorControl;
let floorsApi: NonNullable<NonNullable<Parameters<typeof createApp>[1]>["floors"]>;
let signals: Array<[number, string]>;
let match: () => Promise<boolean | undefined>;
let records: Map<string, SessionRecord>;
let onHookEvent: ReturnType<typeof vi.fn<(input: Record<string, unknown>) => void>>;
let pokes: number;
let accepted: string[];

const rec = (p: Partial<SessionRecord> = {}): SessionRecord => ({
  pid: 2001, sessionId: "s1", name: "alpha", cwd: "/x", status: "busy", startedAt: 1, updatedAt: 2, alive: true, procStart: "Mon Oct 11 10:00:00 2026", ...p,
});

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "co-floors-api-"));
  setLogger(new Logger({ dir: "" }));
  budgetStore = new BudgetStore(join(tmp, "state.json"));
  budgetStore.load();
  budgetGate = new BudgetGate(budgetStore, { demote: (id) => queue.demoteBudget(id) });
  queue = new DecisionQueue({ onResolve: (v) => budgetGate.resolved(v) });
  policyStore = new PolicyStore(join(tmp, "policy.json"));
  policyStore.load();
  policyGate = new PolicyGate(policyStore);
  signals = [];
  match = async () => true;
  floors = new FloorControl({ signal: (pid, sig) => void signals.push([pid, sig]), matchProcStart: () => match(), selfPid: 4242 });
  records = new Map([["s1", rec()], ["dead", rec({ sessionId: "dead", alive: false })]]);
  floorsApi = {
    preToolUse: (i) => floors.preToolUse(i),
    pause: (id) => floors.pause(id),
    resume: (id) => floors.resume(id),
    isPaused: (id) => floors.isPaused(id),
    terminate: (r, f) => floors.terminate(r, f),
    hide: (id) => floors.hide(id),
    unhideAll: () => floors.unhideAll(),
    hiddenCount: () => floors.hiddenCount(),
    record: (id) => records.get(id),
  };
  onHookEvent = vi.fn<(input: Record<string, unknown>) => void>();
  pokes = 0;
  accepted = [];
  const snap = makeSnapshot({ sessions: [makeSession({ id: "s1" })] });
  server = createApp(
    { current: () => snap, subscribe: () => () => {}, poke: () => void pokes++ },
    {
      auth: { token: TOKEN },
      onHookEvent: (i) => onHookEvent(i),
      stats: { accept: (e: string) => void accepted.push(e), reject: () => {} } as never,
      decisions: queue,
      gate: budgetGate,
      policy: policyGate,
      policyApi: policyStore,
      // 테스트마다 바꿀 수 있게 위임한다
      floors: {
        preToolUse: (i) => floorsApi.preToolUse(i),
        pause: (id) => floorsApi.pause(id),
        resume: (id) => floorsApi.resume(id),
        isPaused: (id) => floorsApi.isPaused(id),
        terminate: (r, f) => floorsApi.terminate(r, f),
        hide: (id) => floorsApi.hide(id),
        unhideAll: () => floorsApi.unhideAll(),
        hiddenCount: () => floorsApi.hiddenCount(),
        record: (id) => floorsApi.record(id),
      },
    },
  ).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  queue.stop();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(tmp, { recursive: true, force: true });
});

type Res = { status: number; body: string; ms: number };
function send(path: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  const t0 = performance.now();
  return new Promise<Res>((resolve, reject) => {
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
const api = (path: string, body: unknown = {}, method = "POST", headers: Record<string, string> = {}) =>
  send(path, { method, headers: { ...PAGE(), ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const json = (r: Res) => JSON.parse(r.body) as Record<string, unknown>;
const INPUT = { session_id: "s1", tool_name: "Bash", tool_input: { command: "FAKE-CMD" }, prompt_id: "p1" };
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

describe("관문 순서(스펙 4.2)", () => {
  it("일시정지 deny가 정책 deny보다 먼저다", async () => {
    floors.pause("s1");
    policyStore.set("lead", { bash: "deny" });
    expect(JSON.parse((await hook(pre())).body)).toEqual(preToolDeny(PAUSED_REASON));
    expect(policyGate.countsOf("lead")).toEqual({ denied: 0, asked: 0 });
  });

  it("일시정지 deny가 예산 관문보다 먼저다(관문 기록이 남지 않는다)", async () => {
    budgetStore.setBudget("s1", 1000, 0);
    budgetGate.setUsage("s1", 1200);
    floors.pause("s1");
    expect(JSON.parse((await hook(pre())).body)).toEqual(preToolDeny(PAUSED_REASON));
    floors.resume("s1");
    hook(permReq()).catch(() => {}); // 붙잡힌 채 끝난다(afterEach가 연결을 끊는다)
    const v = await until(() => queue.list().find((d) => d.state === "pending"));
    expect(v.kind).toBe("permission"); // 예산으로 짝지어지지 않았다
  });

  it("일시정지 deny는 이벤트 저장소·큐 onEvent를 거치지 않는다(수신 통계에는 센다, B123)", async () => {
    const onEvent = vi.spyOn(queue, "onEvent");
    floors.pause("s1");
    await hook(pre());
    expect(accepted).toEqual(["PreToolUse"]);
    expect(onHookEvent).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("예외 도구는 일시정지 중에도 뒤 관문으로 넘어간다", async () => {
    floors.pause("s1");
    const r = await hook(pre({ tool_name: "AskUserQuestion", tool_input: { questions: [] } }));
    expect([r.status, r.body]).toEqual([200, ""]);
    expect(onHookEvent).toHaveBeenCalledTimes(1);
    hook(permReq({ tool_name: "AskUserQuestion", tool_input: { questions: [] } })).catch(() => {});
    expect((await until(() => queue.list().find((d) => d.state === "pending"))).kind).toBe("question");
  });

  it("PreToolUse가 아닌 이벤트는 일시정지와 무관하게 그대로 처리된다", async () => {
    floors.pause("s1");
    await hook({ hook_event_name: "PostToolUse", ...INPUT, tool_use_id: "tu-1" });
    expect(onHookEvent).toHaveBeenCalledTimes(1);
  });

  it("일시정지 전의 결정은 그대로이고 답할 수 있다(Review Focus 2)", async () => {
    hook(permReq()).catch(() => {});
    const v = await until(() => queue.list().find((d) => d.state === "pending"));
    expect((await api("/api/floors/s1/pause")).status).toBe(200);
    expect(queue.list().find((d) => d.id === v.id)?.state).toBe("pending");
    const a = await send(`/api/decisions/${v.id}`, { headers: PAGE(), body: JSON.stringify({ action: "allow" }) });
    expect([a.status, json(a)]).toEqual([200, { state: "answered-dashboard" }]);
  });

  it("floors.preToolUse가 던져도 뒤 관문과 큐는 동작한다", async () => {
    floorsApi = { ...floorsApi, preToolUse: () => { throw new TypeError("x"); } };
    policyStore.set("lead", { bash: "deny" });
    expect(JSON.parse((await hook(pre())).body).hookSpecificOutput.permissionDecision).toBe("deny");
    policyStore.remove("lead");
    expect(await hook(pre())).toMatchObject({ status: 200, body: "" });
  });

  it("응답 시간 1초 안(일시정지 50번)", async () => {
    floors.pause("s1");
    let slowest = 0;
    for (let i = 0; i < 50; i++) slowest = Math.max(slowest, (await hook(pre({ tool_input: { command: `c${i}` } }))).ms);
    expect(slowest).toBeLessThan(1000);
    expect(floors.view("s1").pausedDenied).toBe(50);
  });
});

describe("층 API(스펙 4.1·5.1·6)", () => {
  it("인증 없음 401, 다른 출처 403, JSON 아님 415, id 모양 틀림 400", async () => {
    expect((await api("/api/floors/s1/pause", {}, "POST", { Cookie: "" })).status).toBe(401);
    expect((await api("/api/floors/s1/pause", {}, "POST", { Origin: "http://evil.example" })).status).toBe(403);
    expect((await api("/api/floors/s1/pause", "x", "POST", { "Content-Type": "text/plain" })).status).toBe(415);
    for (const id of ["a%2Fb", "a b".replace(" ", "%20"), "x".repeat(129), "%E0%A4%A"]) expect((await api(`/api/floors/${id}/pause`)).status, id).toBe(400);
  });

  it("pause·resume은 200이고 멱등, 바뀌면 hub.poke", async () => {
    expect([(await api("/api/floors/s1/pause")).status, floors.isPaused("s1")]).toEqual([200, true]);
    expect(json(await api("/api/floors/s1/pause"))).toEqual({ paused: true });
    expect(json(await api("/api/floors/s1/resume"))).toEqual({ paused: false });
    expect(json(await api("/api/floors/s1/resume"))).toEqual({ paused: false });
    expect(pokes).toBe(2); // 바뀐 때만
  });

  it("끝난 세션·없는 세션은 409 ended", async () => {
    for (const id of ["dead", "nope"]) for (const act of ["pause", "resume", "terminate"]) {
      const r = await api(`/api/floors/${id}/${act}`);
      expect([r.status, json(r)], `${id} ${act}`).toEqual([409, { error: "ended" }]);
    }
    expect(signals).toEqual([]);
  });

  it("terminate의 결과와 신호 목록", async () => {
    expect([(await api("/api/floors/s1/terminate")).status, json(await api("/api/floors/s1/terminate", { force: true }))]).toEqual([200, { signal: "SIGKILL" }]);
    records.set("me", rec({ sessionId: "me", pid: 4242 }));
    const self = await api("/api/floors/me/terminate");
    expect([self.status, json(self)]).toEqual([400, { error: "self" }]);
    records.set("s2", rec({ sessionId: "s2", pid: 2002 }));
    match = async () => false;
    expect([(await api("/api/floors/s2/terminate")).status, json(await api("/api/floors/s2/terminate"))]).toEqual([409, { error: "pid-reused" }]);
    match = async () => undefined;
    expect(json(await api("/api/floors/s2/terminate"))).toEqual({ error: "unverified" });
    expect(signals).toEqual([
      [2001, "SIGTERM"],
      [2001, "SIGKILL"],
    ]);
  });

  it("terminate 응답은 첫 SIGTERM이 200 { signal }, 다시 눌러도 200이고 신호는 한 번", async () => {
    const a = await api("/api/floors/s1/terminate");
    const b = await api("/api/floors/s1/terminate");
    expect([a.status, json(a), b.status, json(b)]).toEqual([200, { signal: "SIGTERM" }, 200, { signal: "SIGTERM" }]);
    expect(signals).toEqual([[2001, "SIGTERM"]]);
  });

  it("terminate는 레코드의 pid로만 보낸다(본문·주소의 pid는 무시)", async () => {
    expect((await api("/api/floors/s1/terminate", { pid: 1 })).status).toBe(400);
    await api("/api/floors/s1/terminate?pid=1");
    expect(signals).toEqual([[2001, "SIGTERM"]]);
  });

  it("terminate 본문: 모르는 키·틀린 타입 400, 1kb 초과 413", async () => {
    expect((await api("/api/floors/s1/terminate", { force: "yes" })).status).toBe(400);
    expect((await api("/api/floors/s1/terminate", [])).status).toBe(400);
    expect((await api("/api/floors/s1/terminate", { force: true, pad: "x".repeat(2000) })).status).toBe(413);
    expect(signals).toEqual([]);
  });

  it("hide: 살아 있으면 409 alive, 없으면 404, 끝났으면 200 { hidden: n }. DELETE /api/floors/hidden은 200 { hidden: 0 }", async () => {
    expect([(await api("/api/floors/s1/hide")).status, json(await api("/api/floors/s1/hide"))]).toEqual([409, { error: "alive" }]);
    expect((await api("/api/floors/nope/hide")).status).toBe(404);
    records.set("dead2", rec({ sessionId: "dead2", alive: false }));
    expect(json(await api("/api/floors/dead/hide"))).toEqual({ hidden: 1 });
    expect(json(await api("/api/floors/dead2/hide"))).toEqual({ hidden: 2 });
    const d = await api("/api/floors/hidden", {}, "DELETE");
    expect([d.status, json(d), floors.hiddenCount()]).toEqual([200, { hidden: 0 }, 0]);
    expect(pokes).toBe(3);
  });
});
