import { request } from "node:http";
import type { AddressInfo, Server } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../server/app";
import { bearerOf, cookieName, cookieOf, loadOrCreateToken, readToken, tokenMatches } from "../../server/auth";
import { Logger, setLogger } from "../../server/log";
import type { Snapshot } from "../../src/shared/types";
import { makeSnapshot } from "../web/fixtures";

const TOKEN = "a".repeat(64);
// 쿠키 이름은 브라우저가 본 포트(Host 헤더)로 나눈다(B297). 옛 이름 co는 지운다
const cookieLine = (p: number | string) => `co_${p}=${TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`;
const CLEAR_OLD = "co=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0";

let server: Server;
let port: number;
let host: string;
let tmp: string;
let logDir: string;

type Res = { status: number; headers: Record<string, string | string[] | undefined>; body: string };
function send(method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers: { Host: host, ...headers } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      // SSE(/api/stream)는 끝나지 않으므로 첫 조각에서 끊는다
      res.on("data", (d) => {
        text += d;
        if (path === "/api/stream") res.destroy();
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
const cookie = { Cookie: `other=1; co=${TOKEN}` };
const bearer = { Authorization: `Bearer ${TOKEN}` };
const origin = () => ({ Origin: `http://${host}` });

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "co-auth-"));
  logDir = join(tmp, "logs");
  setLogger(new Logger({ dir: logDir }));
  const staticDir = join(tmp, "web");
  mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>t</title>");
  writeFileSync(join(staticDir, "assets/x.js"), "console.log(1)");
  const snap: Snapshot = makeSnapshot();
  const app = createApp(
    { current: () => snap, subscribe: () => () => {} },
    {
      staticDir,
      heartbeatMs: 60_000,
      auth: { token: TOKEN, version: "9.9.9-test" },
      diagnostics: {
        diagDir: tmp,
        summary: async () => ({ doctor: [], hooks: { total: 0, byEvent: {}, lastAt: null, rejected: { "403": 0, "415": 0, "413": 0, "400": 0, "403-uid": 0, "401-v2": 0 }, v2: 0, last10min: 0 }, errorsLastHour: 0, logDir: "l", diagDir: "d" }),
        makeBundle: async () => "claude-office-diag-20261002-000000.json",
      },
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

describe("토큰 주소와 쿠키(스펙 7.1)", () => {
  it("토큰 주소로 접속하면 쿠키가 생기고 /로 리다이렉트된다", async () => {
    const r = await send("GET", `/?k=${TOKEN}`);
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe("/");
    expect(r.headers["set-cookie"]).toEqual([cookieLine(port)]);
  });

  it("옛 co는 값이 이 열쇠와 같을 때만 지운다(같은 브라우저의 다른 포트 beta.13 설치본 쿠키는 남긴다, B300)", async () => {
    expect((await send("GET", `/?k=${TOKEN}`, { Cookie: `co=${TOKEN}` })).headers["set-cookie"]).toEqual([cookieLine(port), CLEAR_OLD]);
    expect((await send("GET", `/?k=${TOKEN}`, { Cookie: `co=${"b".repeat(64)}` })).headers["set-cookie"]).toEqual([cookieLine(port)]);
  });

  it("틀린 k는 401이고 쿠키를 주지 않는다", async () => {
    for (const k of ["b".repeat(64), "short", ""]) {
      const r = await send("GET", `/?k=${k}`);
      expect(r.status).toBe(401);
      expect(r.headers["set-cookie"]).toBeUndefined();
      expect(r.body).toBe("주소가 올바르지 않습니다. 터미널에서 claude-office로 다시 열어 주세요");
    }
  });
});

describe("쿠키 이름에 브라우저가 본 포트(B297·B298)", () => {
  it("포트가 다른 Host(로컬 4317·터널 14317)는 서로 다른 이름 — 서로 덮어쓰지 않는다", async () => {
    const a = await send("GET", `/?k=${TOKEN}`, { Host: "127.0.0.1:4317" });
    const b = await send("GET", `/?k=${TOKEN}`, { Host: "127.0.0.1:14317" });
    expect((a.headers["set-cookie"] as string[])[0]).toBe(cookieLine(4317));
    expect((b.headers["set-cookie"] as string[])[0]).toBe(cookieLine(14317));
    expect((await send("GET", "/api/snapshot", { Host: "127.0.0.1:14317", Cookie: `co_4317=${"b".repeat(64)}; co_14317=${TOKEN}` })).status).toBe(200);
    expect((await send("GET", "/api/snapshot", { Host: "127.0.0.1:4317", Cookie: `co_14317=${TOKEN}` })).status).toBe(401);
  });

  it("이상한 Host 포트는 Set-Cookie에 끼워 넣어지지 않는다(listen 포트 이름으로), 포트가 없으면 80", () => {
    for (const h of ["127.0.0.1:1; Domain=x", "127.0.0.1:0", "127.0.0.1:65536", "127.0.0.1:abc", "127.0.0.1:", "127.0.0.1:123456", "[::1]:x"]) expect(cookieName(h, 4321), h).toBe("co_4321");
    expect(cookieName("127.0.0.1", 4321)).toBe("co_80");
    expect(cookieName("localhost:14317", 4321)).toBe("co_14317");
    expect(cookieName("[::1]:4317", 4321)).toBe("co_4317");
    expect(cookieName(undefined, 4321)).toBe("co_4321");
  });

  it("옛 co는 열쇠가 맞을 때만 새 이름으로 다시 심고 옛 것을 지운다. 틀린 옛 co는 401, 아무것도 심지 않는다", async () => {
    const ok = await send("GET", "/api/snapshot", { Cookie: `co=${TOKEN}` });
    expect(ok.status).toBe(200);
    expect(ok.headers["set-cookie"]).toEqual([cookieLine(port), CLEAR_OLD]);
    const bad = await send("GET", "/api/snapshot", { Cookie: `co=${"b".repeat(64)}` });
    expect(bad.status).toBe(401);
    expect(bad.headers["set-cookie"]).toBeUndefined();
    const now = await send("GET", "/api/snapshot", { Cookie: `co_${port}=${TOKEN}` });
    expect([now.status, now.headers["set-cookie"]]).toEqual([200, undefined]);
  });
});

describe("읽기 API 인증", () => {
  it("쿠키가 없으면 /api/snapshot·/api/stream·/api/diagnostics가 401", async () => {
    for (const p of ["/api/snapshot", "/api/stream", "/api/diagnostics", "/api/diagnostics/files/claude-office-diag-20261002-000000.json", "/api/nope"]) {
      const r = await send("GET", p);
      expect(r.status, p).toBe(401);
      // FB-8: 런처가 떠 있는 서버의 버전을 알 수 있게 401 본문에 버전을 싣는다(이 PC 안에서만 보이는 값)
      expect(JSON.parse(r.body)).toEqual({ error: "unauthorized", app: "claude-office", version: "9.9.9-test" });
    }
  });

  it("쿠키가 맞으면 200", async () => {
    expect((await send("GET", "/api/snapshot", cookie)).status).toBe(200);
    expect((await send("GET", "/api/stream", cookie)).status).toBe(200);
  });

  it("인증된 /api/snapshot 본문과 /api/stream 첫 메시지에 토큰 값이 없다(스펙 10장)", async () => {
    for (const [p, h] of [["/api/snapshot", cookie], ["/api/stream", cookie], ["/api/snapshot", bearer]] as const) {
      const r = await send("GET", p, h);
      expect(r.status, p).toBe(200);
      expect(r.body.includes('"sessions"'), p).toBe(true); // 스냅샷이 실제로 실렸다
      // 값 자체를 단언 메시지에 싣지 않도록 포함 여부만 본다
      const hasToken = r.body.includes(TOKEN);
      expect(hasToken, p).toBe(false);
    }
  });

  it("Bearer가 맞으면 200", async () => {
    expect((await send("GET", "/api/snapshot", bearer)).status).toBe(200);
    expect((await send("GET", "/api/diagnostics", bearer)).status).toBe(200);
  });

  it("틀린 쿠키는 401", async () => {
    expect((await send("GET", "/api/snapshot", { Cookie: `co=${"b".repeat(64)}` })).status).toBe(401);
    expect((await send("GET", "/api/snapshot", { Authorization: `Bearer ${"b".repeat(64)}` })).status).toBe(401);
  });

  it("길이가 다른 토큰도 던지지 않고 401", async () => {
    expect((await send("GET", "/api/snapshot", { Cookie: "co=a" })).status).toBe(401);
    expect((await send("GET", "/api/snapshot", { Cookie: `co=${TOKEN}${TOKEN}` })).status).toBe(401);
    expect((await send("GET", "/api/snapshot", { Authorization: "Bearer x" })).status).toBe(401);
  });

  it("/hooks/event는 쿠키 없이 200", async () => {
    const r = await send("POST", "/hooks/event", json, JSON.stringify({ hook_event_name: "Stop", session_id: "s" }));
    expect(r.status).toBe(200);
  });

  it("정적 파일(/, /assets/x.js)은 쿠키 없이 200", async () => {
    expect((await send("GET", "/")).status).toBe(200);
    expect((await send("GET", "/assets/x.js")).status).toBe(200);
  });
});

describe("쓰기 API 인증(Ruling B32)", () => {
  const bundle = "/api/diagnostics/bundle";
  it("쓰기 API: 쿠키 + 같은 출처 Origin + JSON이면 통과", async () => {
    expect((await send("POST", bundle, { ...cookie, ...origin(), ...json }, "{}")).status).toBe(201);
  });

  it("쓰기 API: 쿠키가 있어도 Origin이 없으면 403, 다른 출처 Origin이면 403, text/plain이면 415, 쿠키가 없으면 401", async () => {
    expect((await send("POST", bundle, { ...cookie, ...json }, "{}")).status).toBe(403);
    expect((await send("POST", bundle, { ...cookie, Origin: "http://evil.example", ...json }, "{}")).status).toBe(403);
    expect((await send("POST", bundle, { ...cookie, Origin: `http://localhost:${port + 1}`, ...json }, "{}")).status).toBe(403);
    expect((await send("POST", bundle, { ...cookie, ...origin(), "Content-Type": "text/plain" }, "{}")).status).toBe(415);
    const r = await send("POST", bundle, { ...origin(), ...json }, "{}");
    expect(r.status).toBe(401);
    expect(JSON.parse(r.body)).toEqual({ error: "unauthorized", app: "claude-office", version: "9.9.9-test" });
  });

  it("쓰기 API: Bearer + Origin 없음이면 통과, Bearer + 다른 출처 Origin이면 403", async () => {
    expect((await send("POST", bundle, { ...bearer, ...json }, "{}")).status).toBe(201);
    expect((await send("POST", bundle, { ...bearer, Origin: "http://evil.example", ...json }, "{}")).status).toBe(403);
    expect((await send("POST", bundle, { ...bearer, ...origin(), ...json }, "{}")).status).toBe(403);
  });

  it("토큰 값이 로그에 없다", () => {
    const text = readdirSync(logDir).map((f) => readFileSync(join(logDir, f), "utf8")).join("");
    expect(text.length).toBeGreaterThan(0); // 위 요청들이 로그를 남겼다(bundle created)
    expect(text).not.toContain(TOKEN);
  });
});

describe("토큰 파일과 헤더 해석", () => {
  it("loadOrCreateToken: 없으면 64자 hex를 0600으로 만들고, 있으면 그대로 둔다", () => {
    const dir = mkdtempSync(join(tmpdir(), "co-token-"));
    try {
      const file = join(dir, "nested", "token");
      expect(readToken(file)).toBeNull();
      const t = loadOrCreateToken(file);
      expect(t).toMatch(/^[0-9a-f]{64}$/);
      if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
      const mtime = statSync(file).mtimeMs;
      expect(loadOrCreateToken(file)).toBe(t);
      expect(statSync(file).mtimeMs).toBe(mtime);
      expect(readToken(file)).toBe(t);
      expect(loadOrCreateToken(join(dir, "other"))).not.toBe(t);
      // 빈 파일은 없는 것과 같다: 새로 만들고 0600으로 맞춘다
      const empty = join(dir, "empty");
      writeFileSync(empty, "", { mode: 0o644 });
      expect(readToken(empty)).toBeNull();
      expect(loadOrCreateToken(empty)).toMatch(/^[0-9a-f]{64}$/);
      if (process.platform !== "win32") expect(statSync(empty).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("0644로 있던 토큰 파일은 내용 그대로 0600이 된다", () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "co-token-"));
    try {
      const file = join(dir, "token");
      writeFileSync(file, "b".repeat(64), { mode: 0o644 });
      chmodSync(file, 0o644); // umask와 무관하게
      expect(loadOrCreateToken(file)).toBe("b".repeat(64));
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(readFileSync(file, "utf8")).toBe("b".repeat(64));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tokenMatches·cookieOf·bearerOf", () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches(undefined, TOKEN)).toBe(false);
    expect(tokenMatches("", TOKEN)).toBe(false);
    expect(tokenMatches("a", TOKEN)).toBe(false);
    expect(cookieOf(undefined)).toBeUndefined();
    expect(cookieOf("x=1; co=abc; y=2")).toBe("abc");
    expect(cookieOf("xco=abc")).toBeUndefined();
    expect(bearerOf("Bearer abc")).toBe("abc");
    expect(bearerOf("bearer  abc")).toBe("abc");
    expect(bearerOf("Basic abc")).toBeUndefined();
    expect(bearerOf(undefined)).toBeUndefined();
  });
});
