import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../../server/app";
import { HookStats } from "../../server/events/stats";
import type { Snapshot } from "../../src/shared/types";
import { emptySum } from "../../src/shared/tokens";

const base = {
  generatedAt: "t0",
  usage: { today: emptySum(), last5h: emptySum(), last7d: emptySum(), byModel: [], hourly: [] },
  budget: {},
  limits: null,
  sessions: [],
} as unknown as Snapshot;
const hub = { current: () => base, subscribe: () => () => {} };

let server: Server;
let port: number;
let received: Array<Record<string, unknown>>;
let onHookEvent: (input: Record<string, unknown>) => void;
let stats: HookStats;

beforeEach(async () => {
  received = [];
  onHookEvent = (input) => received.push(input);
  stats = new HookStats();
  server = createApp(hub, { onHookEvent: (i) => onHookEvent(i), stats }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  vi.restoreAllMocks();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

function post(body: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: "/hooks/event", method: "POST", headers: { Host: `127.0.0.1:${port}`, "Content-Type": "application/json", ...headers } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const ok = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s-fake", tool_name: "Bash", tool_input: { command: "echo fake" } });

describe("POST /hooks/event", () => {
  it("수신 통계: 성공은 이벤트별로, 거부는 이유별로 센다", async () => {
    await post(ok);
    await post(ok, { Origin: "https://evil.example" });
    await post(ok, { Host: "evil.example" });
    await post(ok, { "Content-Type": "text/plain" });
    await post(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", tool_input: { content: "x".repeat(2_000_000) } }));
    await post("{broken");
    await post(JSON.stringify({ hook_event_name: "PreToolUse" }));
    expect(stats.view()).toMatchObject({
      total: 1,
      byEvent: { PreToolUse: 1 },
      rejected: { "403": 2, "415": 1, "413": 1, "400": 2 },
    });
  });

  it("수신 통계: 옛 입구의 Notification은 이벤트 수에만 들고 종류 수(byNotification)에는 들지 않는다(Ruling D-3)", async () => {
    await post(JSON.stringify({ hook_event_name: "Notification", session_id: "s-fake", notification_type: "worker_permission_prompt", message: "fake secret body" }));
    expect(stats.view().byEvent).toEqual({ Notification: 1 });
    expect(stats.view().byNotification).toEqual({});
    expect(JSON.stringify(stats.view())).not.toContain("fake secret body");
  });

  it("정상 요청은 200과 빈 본문, 입력을 넘긴다", async () => {
    const r = await post(ok);
    expect(r).toEqual({ status: 200, body: "" });
    expect(received).toEqual([JSON.parse(ok)]);
  });

  it("JSON이 아니면 415", async () => {
    expect((await post(ok, { "Content-Type": "text/plain" })).status).toBe(415);
    expect(received).toEqual([]);
  });

  it("Origin 헤더가 있으면 403", async () => {
    expect((await post(ok, { Origin: "https://evil.example" })).status).toBe(403);
    expect(received).toEqual([]);
  });

  it("Host가 로컬이 아니면 403", async () => {
    expect((await post(ok, { Host: "evil.example" })).status).toBe(403);
  });

  it("본문이 1MB를 넘으면 413", async () => {
    const big = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", tool_input: { content: "x".repeat(1_100_000) } });
    expect((await post(big)).status).toBe(413);
  });

  it("필수 필드가 문자열이 아니거나 JSON이 깨졌으면 400", async () => {
    expect((await post(JSON.stringify({ hook_event_name: "PreToolUse" }))).status).toBe(400);
    expect((await post(JSON.stringify({ hook_event_name: 1, session_id: "s" }))).status).toBe(400);
    expect((await post("[]")).status).toBe(400);
    expect((await post("{not json")).status).toBe(400);
    expect(received).toEqual([]);
  });

  it("처리 중 예외가 나도 200", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    onHookEvent = () => {
      throw new Error("boom");
    };
    expect(await post(ok)).toEqual({ status: 200, body: "" });
  });

  it("GET 등 다른 메서드는 이 경로를 쓰지 않는다", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/hooks/event`);
    expect(res.status).toBe(404);
  });

  it("decisions 없이 만든 앱은 PermissionRequest도 즉시 빈 200(Phase 1 동작)", async () => {
    const r = await post(JSON.stringify({ hook_event_name: "PermissionRequest", session_id: "s-fake", tool_name: "Bash", tool_input: { command: "echo fake" } }));
    expect(r).toEqual({ status: 200, body: "" });
    expect(received).toHaveLength(1);
  });
});
