import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../../server/app";
import type { Snapshot } from "../../src/shared/types";
import { emptySum } from "../../src/shared/tokens";
import { makeHome, type FakeHome } from "../helpers/fakeHome";

const base: Snapshot = {
  generatedAt: "t0",
  usage: { today: emptySum(), last5h: emptySum(), last7d: emptySum(), byModel: [], hourly: [] },
  budget: {},
  limits: null,
  sessions: [],
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
