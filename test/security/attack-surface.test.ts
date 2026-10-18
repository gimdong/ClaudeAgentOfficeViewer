// 보안 회귀 테스트(#530). 공격자: (a) 사용자가 연 악성 웹페이지(브라우저 경유), (b) 같은 컴퓨터의 다른 계정.
// 이미 막혀 있는 경로가 앞으로도 막혀 있는지 실제 HTTP로 확인한다. 비밀값은 모두 가짜다
import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import type { AddressInfo, Server } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, isAllowedHost, isSameOrigin } from "../../server/app";
import { ChannelHub } from "../../server/floors/channels";
import { FloorControl } from "../../server/floors/control";
import { defaultProcStartMatcher, type SessionRecord } from "../../server/collectors/sessions";
import { Logger, setLogger } from "../../server/log";
import { makeSnapshot } from "../web/fixtures";

const TOKEN = "f".repeat(64);
const SECRET = "outside-static-dir-fake-secret";

let server: Server;
let port: number;
let host: string;
let tmp: string;
let channels: ChannelHub;
let floorKey: string;

type Res = { status: number; headers: Record<string, string | string[] | undefined>; body: string };
function send(method: string, path: string, headers: Record<string, string> = {}, body?: string, hostHeader?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers: { Host: hostHeader ?? host, ...headers } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (d) => {
        text += d;
        if (String(res.headers["content-type"]).startsWith("text/event-stream")) res.destroy();
      });
      const done = () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text });
      res.on("end", done);
      res.on("close", done);
    });
    r.on("error", reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}
const json = { "Content-Type": "application/json" };
const cookie = { Cookie: `co=${TOKEN}` };
const evil = { Origin: "http://evil.example" };

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "co-sec-"));
  setLogger(new Logger({ dir: join(tmp, "logs") }));
  const staticDir = join(tmp, "web");
  mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>t</title>");
  writeFileSync(join(tmp, "secret.txt"), SECRET); // staticDir 바로 위
  writeFileSync(join(tmp, "claude-office-diag-20261002-000000.json"), SECRET); // diagDir 바로 위
  mkdirSync(join(tmp, "diag"));
  channels = new ChannelHub({ file: join(tmp, "experimental.json"), available: { ok: true } });
  channels.setEnabled(true);
  floorKey = channels.register("s1", "co-test")!;
  const floors = new FloorControl({ signal: () => { throw new Error("테스트는 신호를 보내지 않는다"); }, matchProcStart: async () => true, selfPid: 4242 });
  const record = (id: string): SessionRecord | undefined => (id === "s1" ? ({ sessionId: "s1", pid: 99999, alive: true } as SessionRecord) : undefined);
  const app = createApp(
    { current: () => makeSnapshot(), subscribe: () => () => {} },
    {
      staticDir,
      heartbeatMs: 60_000,
      auth: { token: TOKEN },
      diagnostics: { diagDir: join(tmp, "diag"), summary: async () => { throw new Error("unused"); }, makeBundle: async () => "x" },
      decisions: { hold: (_i, res) => (res.status(200).end(), null), answer: () => ({ ok: false, status: 404 }), onEvent: () => {} },
      floors: { preToolUse: () => null, pause: () => {}, resume: () => {}, isPaused: () => false, terminate: (r, f) => floors.terminate(r, f), hide: () => {}, unhideAll: () => {}, hiddenCount: () => 0, record },
      channels: { hub: channels, launch: async () => ({ ok: false, error: "tmux" }) },
    },
  );
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  port = (server.address() as AddressInfo).port;
  host = `127.0.0.1:${port}`;
});
afterAll(() => {
  server.close();
  setLogger(new Logger({ dir: "" }));
  rmSync(tmp, { recursive: true, force: true });
});

describe("(a) DNS rebinding: 로컬이 아닌 Host는 모든 경로에서 403", () => {
  it("로컬 이름을 앞·뒤에 붙인 Host도 로컬로 보지 않는다", () => {
    for (const h of ["127.0.0.1.evil.example", "localhost.evil.example", "evil.example:127.0.0.1", "localhost.", "0.0.0.0", "127.0.0.2", "[::ffff:127.0.0.1]", "LOCALHOST.evil", " evil.example"]) {
      expect(isAllowedHost(h), h).toBe(false);
    }
  });

  it("hook·channel·/api·화면·토큰 주소 모두 403(쿠키·열쇠가 맞아도)", async () => {
    const h = "rebind.evil.example:" + port;
    for (const [m, p, hd, b] of [
      ["POST", "/hooks/event", json, '{"hook_event_name":"PreToolUse","session_id":"x"}'],
      ["GET", "/channel/stream", { Authorization: `Floor ${floorKey}` }],
      ["GET", "/api/snapshot", cookie],
      ["GET", "/", {}],
      ["GET", `/?k=${TOKEN}`, {}],
    ] as const) {
      const r = await send(m, p, hd, b, h);
      expect(r.status, p).toBe(403);
      expect(r.headers["set-cookie"], p).toBeUndefined();
    }
  });
});

describe("(a) CSRF·CORS: 다른 출처의 페이지는 쓰지도 읽지도 못한다", () => {
  it("같은 출처 판정: null·https·다른 포트·다른 로컬 이름·덧붙인 도메인은 다른 출처", () => {
    const hh = "127.0.0.1:4317";
    for (const o of ["null", "https://127.0.0.1:4317", "http://127.0.0.1:4318", "http://localhost:4317", "http://127.0.0.1:4317.evil.example", "http://evil.example", "file://", ""]) {
      expect(isSameOrigin(o, hh), o).toBe(false);
    }
    expect(isSameOrigin("http://127.0.0.1:4317", hh)).toBe(true);
  });

  it("쿠키가 붙어도 Origin이 다른 출처·null이면 쓰기 403, 같은 출처라도 JSON이 아니면 415", async () => {
    for (const o of ["http://evil.example", "null"]) {
      expect((await send("POST", "/api/floors/s1/terminate", { ...cookie, ...json, Origin: o }, "{}")).status, o).toBe(403);
      expect((await send("POST", "/api/floors/s1/instruct", { ...cookie, ...json, Origin: o }, '{"text":"x"}')).status, o).toBe(403);
    }
    for (const ct of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
      expect((await send("POST", "/api/floors/s1/instruct", { ...cookie, "Content-Type": ct, Origin: `http://${host}` }, '{"text":"x"}')).status, ct).toBe(415);
    }
  });

  it("단순 요청(form·text/plain)으로 hook을 위조하지 못한다: Origin이 있으면 403, JSON이 아니면 415", async () => {
    const b = '{"hook_event_name":"PermissionRequest","session_id":"x"}';
    expect((await send("POST", "/hooks/event", { "Content-Type": "text/plain", ...evil }, b)).status).toBe(403);
    expect((await send("POST", "/hooks/event", { ...json, Origin: "null" }, b)).status).toBe(403);
    expect((await send("POST", "/hooks/event", { "Content-Type": "text/plain" }, b)).status).toBe(415);
    expect((await send("POST", "/hooks/event", { "Content-Type": "application/x-www-form-urlencoded" }, b)).status).toBe(415);
  });

  it("어느 경로도 CORS 허용 헤더를 내지 않는다(사전 확인 OPTIONS 포함)", async () => {
    const pre = { ...evil, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" };
    for (const [m, p, hd] of [
      ["OPTIONS", "/hooks/event", pre],
      ["OPTIONS", "/api/floors/s1/instruct", pre],
      ["GET", "/api/snapshot", { ...cookie, ...evil }],
      ["GET", "/", evil],
    ] as const) {
      const r = await send(m, p, hd);
      expect(r.headers["access-control-allow-origin"], `${m} ${p}`).toBeUndefined();
      expect(r.headers["access-control-allow-credentials"], `${m} ${p}`).toBeUndefined();
    }
  });

  it("Bearer는 Origin이 붙으면 쓰기 403(브라우저가 훔친 Bearer를 쓰는 경우)", async () => {
    expect((await send("POST", "/api/floors/s1/instruct", { Authorization: `Bearer ${TOKEN}`, ...json, ...evil }, '{"text":"x"}')).status).toBe(403);
  });

  it("토큰 비교: 배열·대소문자·앞뒤 공백·접두사는 통과하지 않는다", async () => {
    for (const q of [`k=${TOKEN}&k=${TOKEN}`, `k=${TOKEN.toUpperCase()}`, `k=%20${TOKEN}`, `k=${TOKEN.slice(0, 63)}`]) {
      const r = await send("GET", `/?${q}`);
      expect(r.status, q).toBe(401);
      expect(r.headers["set-cookie"], q).toBeUndefined();
    }
    // k[]는 k가 아니다(Express 5 기본 쿼리 파서) — 화면만 주고 쿠키는 주지 않는다
    expect((await send("GET", `/?k[]=${TOKEN}`)).headers["set-cookie"]).toBeUndefined();
    for (const c of [`co=${TOKEN.toUpperCase()}`, `co= ${TOKEN}x`, `xco=${TOKEN}`]) {
      expect((await send("GET", "/api/snapshot", { Cookie: c })).status, c).toBe(401);
    }
  });
});

describe("경로 순회", () => {
  it("정적 파일 제공은 화면 폴더 밖의 파일을 돌려주지 않는다", async () => {
    for (const p of ["/../secret.txt", "/..%2fsecret.txt", "/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt", "/%2e%2e%5csecret.txt", "/assets/%2e%2e/%2e%2e/secret.txt", "/..%252fsecret.txt"]) {
      const r = await send("GET", p);
      expect(r.body, p).not.toContain(SECRET);
    }
  });

  it("진단 파일 내려받기는 이름 규칙 밖(../ 포함)을 404", async () => {
    for (const n of ["..%2fclaude-office-diag-20261002-000000.json", "%2e%2e%2fclaude-office-diag-20261002-000000.json", "..%5cclaude-office-diag-20261002-000000.json"]) {
      const r = await send("GET", `/api/diagnostics/files/${n}`, cookie);
      expect(r.body, n).not.toContain(SECRET);
      expect([400, 404], n).toContain(r.status);
    }
  });
});

describe("channel 열쇠", () => {
  it("열쇠 형식이 조금이라도 다르면 401, 브라우저(Origin)는 맞는 열쇠라도 403", async () => {
    for (const a of [`Floor ${floorKey.toUpperCase()}`, `Floor  ${floorKey}`, `floor ${floorKey}`, `Floor ${floorKey}0`, `Bearer ${floorKey}`, `Floor ${"0".repeat(64)}`, `Bearer ${TOKEN}`]) {
      expect((await send("GET", "/channel/stream", { Authorization: a })).status, a).toBe(401);
      expect((await send("POST", "/channel/ack", { Authorization: a, ...json }, '{"id":"x"}')).status, a).toBe(401);
    }
    expect((await send("GET", "/channel/stream", { Authorization: `Floor ${floorKey}`, ...evil })).status).toBe(403);
    expect((await send("POST", "/channel/ack", { Authorization: `Floor ${floorKey}`, ...json, ...evil }, '{"id":"x"}')).status).toBe(403);
  });

  it("대시보드 토큰(쿠키)으로는 channel 스트림에 붙지 못한다", async () => {
    expect((await send("GET", "/channel/stream", cookie)).status).toBe(401);
  });
});

describe("pid 검증(직접 띄운 sleep으로만)", () => {
  let child: ChildProcess;
  beforeAll(() => {
    child = spawn("sleep", ["30"], { stdio: "ignore" });
  });
  afterAll(() => {
    child.kill();
  });

  it.skipIf(process.platform === "win32")("시작 시각이 다르면 pid 재사용으로 보고 신호를 보내지 않는다. 맞으면 신호 함수까지 간다", async () => {
    const pid = child.pid!;
    const lstart = await new Promise<string>((r) => {
      const ps = spawn("ps", ["-o", "lstart=", "-p", String(pid)], { env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
      let out = "";
      ps.stdout.on("data", (d) => (out += d));
      ps.on("close", () => r(out.trim()));
    });
    expect(await defaultProcStartMatcher(pid, lstart)).toBe(true);
    expect(await defaultProcStartMatcher(pid, "Mon Jan  1 00:00:00 2001")).toBe(false);
    expect(await defaultProcStartMatcher(pid, "not a date")).toBeUndefined();

    const sent: Array<[number, string]> = [];
    const fc = new FloorControl({ signal: (p, s) => void sent.push([p, s]), matchProcStart: defaultProcStartMatcher, selfPid: process.pid });
    const rec = (procStart?: string, p = pid): SessionRecord => ({ sessionId: "dummy", pid: p, alive: true, ...(procStart ? { procStart } : {}) }) as SessionRecord;
    expect(await fc.terminate(rec("Mon Jan  1 00:00:00 2001"), false)).toEqual({ ok: false, error: "pid-reused" });
    expect(await fc.terminate(rec(), false)).toEqual({ ok: false, error: "unverified" });
    for (const bad of [0, 1, -1, 1.5, process.pid]) expect((await fc.terminate(rec(lstart, bad), true)).ok, String(bad)).toBe(false);
    expect(sent).toEqual([]);
    // 맞는 시각이면 신호 함수가 불린다(가짜 함수라 실제 신호는 없다)
    expect(await fc.terminate(rec(lstart), false)).toEqual({ ok: true, signal: "SIGTERM", sent: true });
    expect(sent).toEqual([[pid, "SIGTERM"]]);
  });

  it("주소·본문의 pid는 받지 않는다: 모르는 층 id는 신호 없이 409, 본문에 pid를 넣으면 400", async () => {
    const h = { Authorization: `Bearer ${TOKEN}`, ...json };
    expect((await send("POST", "/api/floors/nope/terminate", h, "{}")).status).toBe(409);
    expect((await send("POST", "/api/floors/s1/terminate", h, '{"pid":1}')).status).toBe(400);
    expect((await send("POST", "/api/floors/..%2fs1/terminate", h, "{}")).status).toBe(400);
  });
});
