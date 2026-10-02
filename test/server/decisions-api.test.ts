import { request, type ClientRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../server/app";
import { BudgetGate } from "../../server/budget/gate";
import { BudgetStore } from "../../server/budget/store";
import { BUDGET_STOP, budgetReason, permissionResponse, preToolAsk } from "../../server/decisions/protocol";
import { DecisionQueue } from "../../server/decisions/queue";
import { Logger, setLogger } from "../../server/log";
import { makeSession, makeSnapshot } from "../web/fixtures";

const TOKEN = "a".repeat(64);
type Gate = { preToolUse(input: Record<string, unknown>): object | null; claim(input: Record<string, unknown>): { budgetTokens: number; usedTokens: number } | null };

let server: Server;
let port: number;
let queue: DecisionQueue;
let gate: Gate;
let decisions: Pick<DecisionQueue, "hold" | "answer" | "onEvent">;
let tmp: string;
let store: BudgetStore;
let realGate: BudgetGate;
let budgetSets: Array<[string | undefined, number | null]>;

beforeEach(async () => {
  setLogger(new Logger({ dir: "" }));
  tmp = mkdtempSync(join(tmpdir(), "co-dapi-"));
  store = new BudgetStore(join(tmp, "state.json"));
  store.load();
  // 실제 배선과 같다: 큐의 onResolve → gate.resolved, gate의 demote → 큐
  realGate = new BudgetGate(store, { demote: (id) => queue.demoteBudget(id) });
  queue = new DecisionQueue({ onResolve: (v) => realGate.resolved(v) });
  gate = { preToolUse: () => null, claim: () => null };
  decisions = queue;
  budgetSets = [];
  const snap = makeSnapshot({ sessions: [makeSession({ id: "s1" })] });
  server = createApp(
    { current: () => snap, subscribe: () => () => {} },
    {
      auth: { token: TOKEN },
      // 테스트마다 바꿀 수 있게 위임한다
      decisions: { hold: (...a) => decisions.hold(...a), answer: (...a) => decisions.answer(...a), onEvent: (i) => decisions.onEvent(i) },
      gate: { preToolUse: (i) => gate.preToolUse(i), claim: (i) => gate.claim(i) },
      budget: {
        set: (id, tokens) => {
          budgetSets.push([id, tokens]);
          if (id) store.setBudget(id, tokens, realGate.usage(id));
          else store.setDefault(tokens);
        },
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

type Res = { status: number; body: string };
function send(path: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}): { req: ClientRequest; done: Promise<Res> } {
  let req!: ClientRequest;
  const done = new Promise<Res>((resolve, reject) => {
    req = request({ host: "127.0.0.1", port, path, method: o.method ?? "POST", headers: { Host: `127.0.0.1:${port}`, ...o.headers } }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on("error", reject);
    req.end(o.body);
  });
  return { req, done };
}
const hook = (body: Record<string, unknown>) => send("/hooks/event", { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const answer = (id: string, body: unknown, headers: Record<string, string> = {}) =>
  send(`/api/decisions/${id}`, {
    headers: { Cookie: `co=${TOKEN}`, Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }).done;
const perm = (o: Record<string, unknown> = {}) => ({ hook_event_name: "PermissionRequest", session_id: "s1", tool_name: "Bash", tool_input: { command: "echo fake" }, ...o });

async function until<T>(fn: () => T | undefined, ms = 2000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("시간 초과");
    await new Promise((r) => setTimeout(r, 5));
  }
}
const pendingId = () => until(() => queue.list().find((v) => v.state === "pending")?.id);

describe("hook 응답 분기", () => {
  it("PermissionRequest는 붙잡히고, 대시보드가 허용하면 hook이 allow JSON을 받는다", async () => {
    const h = hook(perm());
    const id = await pendingId();
    let settled = false;
    void h.done.then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false); // 큐가 답하기 전에는 응답하지 않는다
    const a = await answer(id, { action: "allow" });
    expect(a).toEqual({ status: 200, body: JSON.stringify({ state: "answered-dashboard" }) });
    const r = await h.done;
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual(permissionResponse("allow"));
  });

  it("hook 요청을 끊으면(req.destroy) 결정이 closed-terminal이 되고, 그 뒤 답은 409", async () => {
    const h = hook(perm());
    h.done.catch(() => {});
    const id = await pendingId();
    h.req.destroy();
    await until(() => (queue.list()[0].state === "closed-terminal" ? true : undefined));
    const a = await answer(id, { action: "allow" });
    expect(a.status).toBe(409);
    expect(JSON.parse(a.body)).toEqual({ state: "closed-terminal" });
  });

  it("터미널에서 허용해 같은 입력의 PostToolUse가 오면 붙잡은 hook이 빈 200으로 끝나고 결정이 closed-terminal(B70)", async () => {
    const h = hook(perm({ tool_input: { command: "echo fake", description: "d" } }));
    const id = await pendingId();
    const post = await hook({ hook_event_name: "PostToolUse", session_id: "s1", tool_name: "Bash", tool_input: { description: "d", command: "echo fake" }, tool_use_id: "tu" }).done;
    expect(post).toEqual({ status: 200, body: "" });
    expect(await h.done).toEqual({ status: 200, body: "" }); // 결정 없이 놓아줌 — 터미널이 이미 결정했다
    expect(queue.list().find((v) => v.id === id)!.state).toBe("closed-terminal");
    const a = await answer(id, { action: "allow" });
    expect(a.status).toBe(409);
    expect(JSON.parse(a.body)).toEqual({ state: "closed-terminal" });
  });

  it("onEvent가 던져도 hook은 빈 200", async () => {
    decisions = { hold: (...a) => queue.hold(...a), answer: (...a) => queue.answer(...a), onEvent: () => { throw new Error("boom"); } };
    expect(await hook({ hook_event_name: "Stop", session_id: "s1" }).done).toEqual({ status: 200, body: "" });
  });

  it("PreToolUse·PostToolUse 등은 여전히 즉시 빈 200", async () => {
    for (const ev of ["PreToolUse", "PostToolUse", "Stop", "Notification"]) {
      const r = await hook({ hook_event_name: ev, session_id: "s1", tool_name: "Bash", tool_input: { command: "x" } }).done;
      expect(r, ev).toEqual({ status: 200, body: "" });
    }
  });

  it("gate.preToolUse가 객체를 주면 그 JSON이 PreToolUse 응답이다", async () => {
    gate.preToolUse = () => preToolAsk("예산");
    const r = await hook({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Bash", tool_input: {} }).done;
    expect(JSON.parse(r.body)).toEqual(preToolAsk("예산"));
  });

  it("gate.claim이 값을 주면 kind가 budget", async () => {
    gate.claim = () => ({ budgetTokens: 100, usedTokens: 120 });
    hook(perm()).done.catch(() => {});
    await pendingId();
    expect(queue.list()[0]).toMatchObject({ kind: "budget", budget: { budgetTokens: 100, usedTokens: 120 } });
  });

  it("hold가 던져도 hook은 빈 200을 받는다", async () => {
    decisions = { hold: () => { throw new Error("boom"); }, answer: () => ({ ok: false, status: 404 }), onEvent: () => { throw new Error("boom"); } };
    expect(await hook(perm()).done).toEqual({ status: 200, body: "" });
    gate.preToolUse = () => { throw new Error("boom"); };
    expect(await hook({ hook_event_name: "PreToolUse", session_id: "s1" }).done).toEqual({ status: 200, body: "" });
    decisions = queue;
    gate = { preToolUse: () => null, claim: () => { throw new Error("boom"); } };
    expect(await hook(perm()).done).toEqual({ status: 200, body: "" });
  });

  it("PreToolUse 응답이 1초 안에 온다(측정)", async () => {
    gate.preToolUse = () => preToolAsk("예산");
    let max = 0;
    for (let i = 0; i < 20; i++) {
      const t = performance.now();
      const r = await hook({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Bash", tool_input: { command: `c${i}` } }).done;
      max = Math.max(max, performance.now() - t);
      expect(r.status).toBe(200);
    }
    expect(max).toBeLessThan(1000);
  });
});

describe("POST /api/decisions/:id", () => {
  it("쿠키 없음 401, Origin 없음 403, text/plain 415, 모양이 틀리면 400, 없는 id 404", async () => {
    hook(perm()).done.catch(() => {});
    const id = await pendingId();
    expect((await answer(id, { action: "allow" }, { Cookie: "" })).status).toBe(401);
    const noOrigin = await send(`/api/decisions/${id}`, { headers: { Cookie: `co=${TOKEN}`, "Content-Type": "application/json" }, body: '{"action":"allow"}' }).done;
    expect(noOrigin.status).toBe(403);
    expect((await answer(id, { action: "allow" }, { "Content-Type": "text/plain" })).status).toBe(415);
    for (const bad of [[], "x", { action: 1 }, null, { nope: true }]) expect((await answer(id, bad)).status, JSON.stringify(bad)).toBe(400);
    expect((await answer(id, "{not json")).status).toBe(400);
    expect((await answer(id, { action: "deny", reason: "x".repeat(17_000) })).status).toBe(413);
    expect((await answer(id, { action: "continue" })).status).toBe(400); // 종류에 안 맞는 action(큐 판단)
    const missing = await answer("no-such-id", { action: "allow" });
    expect(missing.status).toBe(404);
    expect(queue.list()[0].state).toBe("pending"); // 위 시도들은 아무것도 바꾸지 않았다
  });

  it("임의 키·3000개 배열·__proto__ 본문은 400", async () => {
    hook(perm()).done.catch(() => {});
    const id = await pendingId();
    for (const bad of [
      '{"action":"allow","extra":1}',
      // 16KB 안에 들어가는 3000개 배열(넘으면 413은 아래 다른 테스트)
      JSON.stringify({ action: "answer", answers: Array(3000).fill(0) }),
      JSON.stringify({ action: "answer", answers: [{ labels: Array(3000).fill(0) }] }),
      '{"__proto__":{"polluted":true},"action":"allow"}',
    ]) expect((await answer(id, bad)).status, bad.slice(0, 40)).toBe(400);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(queue.list()[0].state).toBe("pending");
  });
});

describe("예산(Task 6)", () => {
  const put = (body: unknown, headers: Record<string, string> = {}) =>
    send("/api/budget", {
      method: "PUT",
      headers: { Cookie: `co=${TOKEN}`, Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }).done;

  it("PUT /api/budget — 세션 예산과 기본값, 범위 밖 400, 모르는 세션 404, 쿠키 없음 401", async () => {
    expect((await put({ sessionId: "s1", budgetTokens: 500_000 })).status).toBe(204);
    expect((await put({ budgetTokens: 200_000 })).status).toBe(204);
    expect((await put({ sessionId: "s1", budgetTokens: null })).status).toBe(204);
    expect(budgetSets).toEqual([["s1", 500_000], [undefined, 200_000], ["s1", null]]);
    for (const bad of [{ sessionId: "s1", budgetTokens: 999 }, { budgetTokens: 1_000_000_001 }, { budgetTokens: 1.5 }, { budgetTokens: "1000" }, {}, { sessionId: 5, budgetTokens: 1000 }, { budgetTokens: 1000, extra: 1 }]) {
      expect((await put(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await put({ sessionId: "nope", budgetTokens: 1000 })).status).toBe(404);
    expect((await put({ budgetTokens: 1000 }, { Cookie: "" })).status).toBe(401);
    expect((await put({ budgetTokens: 1000 }, { Origin: "http://evil.example" })).status).toBe(403);
    expect(budgetSets).toHaveLength(3);
  });

  it("예산에 닿은 세션의 PreToolUse는 ask, 이어 온 PermissionRequest는 budget 결정, 계속을 누르면 allow JSON과 nextGateAt 증가, 중단을 누르면 deny와 BUDGET_STOP", async () => {
    gate = realGate;
    store.setBudget("s1", 1000, 0);
    realGate.setUsage("s1", 1200);
    const input = { session_id: "s1", tool_name: "Bash", tool_input: { command: "echo fake" }, prompt_id: "p1" };

    const pre1 = await hook({ hook_event_name: "PreToolUse", tool_use_id: "tu-1", ...input }).done;
    expect(JSON.parse(pre1.body)).toEqual(preToolAsk(budgetReason(1000)));
    const h1 = hook({ hook_event_name: "PermissionRequest", ...input });
    const id1 = await pendingId();
    expect(queue.list()[0]).toMatchObject({ kind: "budget", budget: { budgetTokens: 1000, usedTokens: 1200 } });
    expect((await answer(id1, { action: "continue" })).status).toBe(200);
    expect(JSON.parse((await h1.done).body)).toEqual(permissionResponse("allow"));
    expect(store.get("s1")!.nextGateAt).toBe(2000);

    realGate.setUsage("s1", 2500);
    const input2 = { ...input, tool_input: { command: "echo two" } };
    expect(JSON.parse((await hook({ hook_event_name: "PreToolUse", tool_use_id: "tu-2", ...input2 }).done).body)).toEqual(preToolAsk(budgetReason(1000)));
    const h2 = hook({ hook_event_name: "PermissionRequest", ...input2 });
    const id2 = await until(() => queue.list().find((v) => v.state === "pending" && v.id !== id1)?.id);
    expect((await answer(id2, { action: "stop" })).status).toBe(200);
    expect(JSON.parse((await h2.done).body)).toEqual(permissionResponse("deny", { message: BUDGET_STOP }));
    expect(store.get("s1")!.nextGateAt).toBe(2000);
  });

  it("실제 BudgetGate + BudgetStore로 PreToolUse 응답이 1초 안에 온다(측정)", async () => {
    gate = realGate;
    store.setBudget("s1", 1000, 0);
    realGate.setUsage("s1", 5000);
    let max = 0;
    for (let i = 0; i < 20; i++) {
      const t = performance.now();
      const r = await hook({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Bash", tool_use_id: `tu-${i}`, tool_input: { command: `c${i}` } }).done;
      max = Math.max(max, performance.now() - t);
      expect(JSON.parse(r.body)).toEqual(preToolAsk(budgetReason(1000)));
    }
    expect(max).toBeLessThan(1000);
  });
});
