import { request, type ClientRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../server/app";
import { permissionResponse, preToolAsk } from "../../server/decisions/protocol";
import { DecisionQueue } from "../../server/decisions/queue";
import { Logger, setLogger } from "../../server/log";
import { makeSnapshot } from "../web/fixtures";

const TOKEN = "a".repeat(64);
type Gate = { preToolUse(input: Record<string, unknown>): object | null; claim(input: Record<string, unknown>): { budgetTokens: number; usedTokens: number } | null };

let server: Server;
let port: number;
let queue: DecisionQueue;
let gate: Gate;
let decisions: Pick<DecisionQueue, "hold" | "answer">;

beforeEach(async () => {
  setLogger(new Logger({ dir: "" }));
  queue = new DecisionQueue();
  gate = { preToolUse: () => null, claim: () => null };
  decisions = queue;
  const snap = makeSnapshot();
  server = createApp(
    { current: () => snap, subscribe: () => () => {} },
    {
      auth: { token: TOKEN },
      // 테스트마다 바꿀 수 있게 위임한다
      decisions: { hold: (...a) => decisions.hold(...a), answer: (...a) => decisions.answer(...a) },
      gate: { preToolUse: (i) => gate.preToolUse(i), claim: (i) => gate.claim(i) },
    },
  ).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  queue.stop();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
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
    decisions = { hold: () => { throw new Error("boom"); }, answer: () => ({ ok: false, status: 404 }) };
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
});
