import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp, isAllowedHost } from "../../server/app";
import type { Snapshot } from "../../src/shared/types";
import { emptySum } from "../../src/shared/tokens";
import { makeHome, type FakeHome } from "../helpers/fakeHome";

const base: Snapshot = {
  generatedAt: "t0",
  usage: { today: emptySum(), last5h: emptySum(), last7d: emptySum(), byModel: [], hourly: [] },
  budget: {},
  limits: null,
  sessions: [],
  decisionCount: 0,
  decisions: [],
  hiddenFloors: 0,
};

let current = base;
const listeners = new Set<(s: Snapshot) => void>();
const hub = {
  current: () => current,
  subscribe: (fn: (s: Snapshot) => void) => {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  },
};

let server: Server;
let url: string;
let h: FakeHome;

beforeEach(async () => {
  h = await makeHome();
  await h.write("web/index.html", "<!doctype html><title>office</title>");
  current = base;
  listeners.clear();
  server = createApp(hub, { staticDir: h.path("web"), heartbeatMs: 50 }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await h.cleanup();
});

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string): Promise<string> {
  const dec = new TextDecoder();
  let acc = "";
  while (!acc.includes(needle)) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`stream ended before "${needle}"`);
    acc += dec.decode(value);
  }
  return acc;
}

// fetch는 Host 헤더를 사용자 코드가 덮어쓰지 못하게 막는다(Fetch 표준의 forbidden header).
// 실제로 다른 Host를 보내 검사하려면 저수준 http.request를 써야 한다.
function requestWithHost(path: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port: (server.address() as AddressInfo).port, path, headers: { Host: host } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("createApp", () => {
  it("GET /api/snapshot은 현재 스냅샷을 준다", async () => {
    const res = await fetch(`${url}/api/snapshot`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(base);
  });

  it("SSE: 연결 즉시 스냅샷, 변경 시 추가 이벤트, heartbeat", async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${url}/api/stream`, { signal: ctrl.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    expect(await readUntil(reader, '"t0"')).toContain("event: snapshot");
    current = { ...base, generatedAt: "t1" };
    for (const l of listeners) l(current);
    expect(await readUntil(reader, '"t1"')).toContain("data: ");
    expect(await readUntil(reader, ": ping")).toContain(": ping");
    ctrl.abort();
  });

  it("클라이언트가 끊으면 구독이 해제된다", async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${url}/api/stream`, { signal: ctrl.signal });
    await readUntil(res.body!.getReader(), "event: snapshot");
    expect(listeners.size).toBe(1);
    ctrl.abort();
    const deadline = Date.now() + 2000;
    while (listeners.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(listeners.size).toBe(0);
  });

  it("정적 파일과 SPA fallback, 없는 API는 404", async () => {
    expect(await (await fetch(`${url}/`)).text()).toContain("office");
    expect(await (await fetch(`${url}/some/route`)).text()).toContain("office");
    expect((await fetch(`${url}/api/nope`)).status).toBe(404);
  });
});

describe("Host 헤더 검사 (DNS rebinding 방지)", () => {
  it("허용되지 않은 Host면 403", async () => {
    const r = await requestWithHost("/api/snapshot", "evil.example:4317");
    expect(r.status).toBe(403);
  });

  it("localhost:5173(Vite dev 프록시가 넘기는 원래 브라우저 Host)은 허용한다", async () => {
    const r = await requestWithHost("/api/snapshot", "localhost:5173");
    expect(r.status).toBe(200);
  });

  it("127.0.0.1:4317은 허용한다(포트는 검사하지 않는다)", async () => {
    const r = await requestWithHost("/api/snapshot", "127.0.0.1:4317");
    expect(r.status).toBe(200);
  });

  it("대소문자를 구분하지 않는다", async () => {
    const r = await requestWithHost("/api/snapshot", "LOCALHOST:5173");
    expect(r.status).toBe(200);
  });

  it("[::1]도 허용한다", async () => {
    const r = await requestWithHost("/api/snapshot", "[::1]:4317");
    expect(r.status).toBe(200);
  });
});

describe("isAllowedHost", () => {
  // Node의 HTTP 서버는 HTTP/1.1에서 Host 헤더가 없는 요청 자체를 우리 코드에 도달하기 전에
  // 400으로 거부한다(직접 확인함) — 그래서 "Host 없음" 분기는 실제 소켓 요청으로 재현할 수 없고,
  // 순수 함수를 직접 호출해 검증한다.
  it("Host가 없으면 false", () => {
    expect(isAllowedHost(undefined)).toBe(false);
    expect(isAllowedHost("")).toBe(false);
  });

  it("로컬 호스트명만 true", () => {
    expect(isAllowedHost("127.0.0.1")).toBe(true);
    expect(isAllowedHost("127.0.0.1:4317")).toBe(true);
    expect(isAllowedHost("localhost:5173")).toBe(true);
    expect(isAllowedHost("[::1]:4317")).toBe(true);
    expect(isAllowedHost("evil.example:4317")).toBe(false);
    expect(isAllowedHost("127.0.0.1.evil.example")).toBe(false);
  });
});
