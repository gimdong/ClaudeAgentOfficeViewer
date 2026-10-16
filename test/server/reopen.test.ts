import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../server/app";
import type { SessionRecord } from "../../server/collectors/sessions";
import { ChannelHub } from "../../server/floors/channels";
import { FloorControl, type TerminateResult } from "../../server/floors/control";
import { launchArgs } from "../../server/floors/launch";
import { REOPEN_POLL_MS, REOPEN_WAIT_MS, Reopener, type ReopenLaunch } from "../../server/floors/reopen";
import { Logger, setLogger } from "../../server/log";
import { makeSession, makeSnapshot } from "../web/fixtures";

// 어떤 테스트도 실제 프로세스에 신호를 보내지 않는다: terminate·signal·alive는 가짜다
const rec = (p: Partial<SessionRecord> = {}): SessionRecord => ({ pid: 2001, sessionId: "s1", name: "alpha", cwd: "/x", status: "busy", startedAt: 1, updatedAt: 2, alive: true, procStart: "x", ...p });

describe("launchArgs — 옮겨 열기(--resume)", () => {
  it("--session-id 대신 --resume <대화 id>, 첫 지시 없음, channel 옵션 앞", () => {
    const a = launchArgs({ tmuxName: "co-1", claude: "/c/claude", channelSpec: "plugin:claude-office@claude-office", sessionId: "s1", key: "k", port: 4317, cwd: "/w", name: "alpha", resume: "conv-1" });
    expect(a.slice(a.indexOf("--"))).toEqual(["--", "/c/claude", "--resume", "conv-1", "--name", "alpha", "--dangerously-load-development-channels", "plugin:claude-office@claude-office"]);
    expect(a.includes("--session-id")).toBe(false);
  });
});

describe("Reopener(B201 — 끝날 때까지 기다림, SIGKILL 없음)", () => {
  let clock: number;
  let alive: (pid: number) => boolean;
  let terminate: ReturnType<typeof vi.fn<(r: SessionRecord) => Promise<TerminateResult>>>;
  let launch: ReturnType<typeof vi.fn<ReopenLaunch>>;
  let r: Reopener;
  beforeEach(() => {
    clock = 1_000_000;
    alive = () => false;
    terminate = vi.fn(async () => ({ ok: true as const, signal: "SIGTERM" as const, sent: true }));
    launch = vi.fn<ReopenLaunch>(async () => ({ ok: true as const, tmux: "co-new" }));
    r = new Reopener({ terminate: (x) => terminate(x), alive: (pid) => alive(pid), launch: (x, m) => launch(x, m), now: () => clock, sleep: async (ms) => void (clock += ms) });
  });

  it("SIGTERM 뒤 pid가 끝날 때까지 250ms 간격으로 보고, 끝나면 같은 기록으로 다시 연다", async () => {
    let checks = 0;
    alive = (pid) => (expect(pid).toBe(2001), ++checks < 4); // 세 번은 살아 있음
    const start = clock;
    expect(await r.reopen(rec(), "team")).toEqual({ ok: true, tmux: "co-new" });
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith(rec(), "team");
    expect(clock - start).toBe(3 * REOPEN_POLL_MS);
    expect(r.isBusy("s1")).toBe(false);
  });

  it("15초가 지나도 살아 있으면 still-running, 다시 열지 않고 더 센 신호도 보내지 않는다", async () => {
    alive = () => true;
    const start = clock;
    expect(await r.reopen(rec(), undefined)).toEqual({ ok: false, error: "still-running" });
    expect(clock - start).toBeGreaterThanOrEqual(REOPEN_WAIT_MS);
    expect(clock - start).toBeLessThan(REOPEN_WAIT_MS + REOPEN_POLL_MS * 2);
    expect(launch).not.toHaveBeenCalled();
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it.each(["ended", "self", "pid-reused", "unverified"] as const)("종료 검사가 %s면 그대로 돌려주고 기다리지도 열지도 않는다", async (error) => {
    terminate.mockResolvedValueOnce({ ok: false, error });
    expect(await r.reopen(rec(), undefined)).toEqual({ ok: false, error });
    expect(launch).not.toHaveBeenCalled();
  });

  it("같은 층에 진행 중이면 두 번째 요청은 busy(신호는 한 번)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    r = new Reopener({ terminate: (x) => terminate(x), alive: () => false, launch: async (x, m) => (await gate, launch(x, m)), now: () => clock, sleep: async (ms) => void (clock += ms) });
    const first = r.reopen(rec(), undefined);
    await Promise.resolve();
    expect(r.isBusy("s1")).toBe(true);
    expect(await r.reopen(rec(), undefined)).toEqual({ ok: false, error: "busy" });
    release();
    expect(await first).toEqual({ ok: true, tmux: "co-new" });
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it("다시 열기가 실패하면 launch 오류 그대로", async () => {
    launch.mockResolvedValueOnce({ ok: false, error: "tmux" });
    expect(await r.reopen(rec(), undefined)).toEqual({ ok: false, error: "tmux" });
  });
});

describe("POST /api/floors/:id/reopen(B202·B203)", () => {
  const TOKEN = "c".repeat(64);
  let server: Server;
  let port: number;
  let tmp: string;
  let hub: ChannelHub;
  let floors: FloorControl;
  let records: Map<string, SessionRecord>;
  let calls: Array<[SessionRecord, string | undefined]>;
  let reply: Awaited<ReturnType<Reopener["reopen"]>>;
  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "co-reopen-"));
    setLogger(new Logger({ dir: "" }));
    hub = new ChannelHub({ file: join(tmp, "experimental.json"), available: { ok: true } });
    hub.setEnabled(true);
    floors = new FloorControl({ signal: () => {}, matchProcStart: async () => true, selfPid: 4242 });
    records = new Map([["s1", rec()], ["dead", rec({ sessionId: "dead", alive: false })]]);
    calls = [];
    reply = { ok: true, tmux: "co-new" };
    const snap = makeSnapshot({ sessions: [makeSession({ id: "s1" })] });
    server = createApp(
      { current: () => snap, subscribe: () => () => {}, poke: () => {} },
      {
        auth: { token: TOKEN },
        floors: {
          preToolUse: (i) => floors.preToolUse(i), pause: (id) => floors.pause(id), resume: (id) => floors.resume(id), isPaused: (id) => floors.isPaused(id),
          terminate: (r, f) => floors.terminate(r, f), hide: (id) => floors.hide(id), unhideAll: () => floors.unhideAll(), hiddenCount: () => floors.hiddenCount(), record: (id) => records.get(id),
        },
        channels: { hub, launch: async () => ({ ok: false, error: "tmux" }), reopen: async (r, m) => (calls.push([r, m]), reply) },
      },
    ).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    rmSync(tmp, { recursive: true, force: true });
  });
  const post = (path: string, body: unknown, headers: Record<string, string> = { Cookie: `co=${TOKEN}`, Origin: `http://127.0.0.1:${port}` }) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const s = JSON.stringify(body);
      const req = request({ host: "127.0.0.1", port, path, method: "POST", headers: { Host: `127.0.0.1:${port}`, "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(s)), ...headers } }, (res) => {
        let t = "";
        res.on("data", (d) => (t += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: t }));
      });
      req.on("error", reject);
      req.end(s);
    });
  const res = async (path: string, body: unknown = {}) => {
    const r = await post(path, body);
    return [r.status, r.body ? JSON.parse(r.body) : null];
  };

  it("살아 있고 대시보드가 띄우지 않은 층: 200 { tmux }, 일하는 방식을 넘긴다", async () => {
    expect(await res("/api/floors/s1/reopen", { mode: "team" })).toEqual([200, { tmux: "co-new" }]);
    expect(calls).toEqual([[rec(), "team"]]);
    expect(await res("/api/floors/s1/reopen", {})).toEqual([200, { tmux: "co-new" }]);
    expect(calls[1][1]).toBeUndefined();
  });

  it("거부: 실험 기능 꺼짐 403, 토큰 없음 401, 이상한 mode 400, 끝난 층 409 ended, 없는 층 404", async () => {
    expect((await post("/api/floors/s1/reopen", {}, { Origin: `http://127.0.0.1:${port}` })).status).toBe(401);
    expect((await res("/api/floors/s1/reopen", { mode: "x" }))[0]).toBe(400);
    expect(await res("/api/floors/dead/reopen")).toEqual([409, { error: "ended" }]);
    expect((await res("/api/floors/nope/reopen"))[0]).toBe(404);
    hub.setEnabled(false);
    expect((await res("/api/floors/s1/reopen"))[0]).toBe(403);
    expect(calls).toEqual([]);
  });

  it("대시보드가 띄운 층은 409 launched(B203), 멈춘 층은 409 paused(B202)", async () => {
    hub.register("s1", "co-old");
    expect(await res("/api/floors/s1/reopen")).toEqual([409, { error: "launched" }]);
    hub.unregister("s1");
    floors.pause("s1");
    expect(await res("/api/floors/s1/reopen")).toEqual([409, { error: "paused" }]);
    expect(calls).toEqual([]);
  });

  it.each([
    ["busy", 409],
    ["still-running", 409],
    ["unverified", 409],
    ["pid-reused", 409],
    ["limit", 429],
    ["tmux", 502],
  ] as const)("reopen 결과 %s → %i", async (error, status) => {
    reply = { ok: false, error } as never;
    expect(await res("/api/floors/s1/reopen")).toEqual([status, { error }]);
  });
});
