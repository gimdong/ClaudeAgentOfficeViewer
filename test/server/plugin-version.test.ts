import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../server/app";
import { Logger, setLogger } from "../../server/log";
import { SnapshotBuilder } from "../../server/snapshot";
import { makeHome, type FakeHome } from "../helpers/fakeHome";
import { makeSnapshot } from "../web/fixtures";

// Phase 5 §3: hook이 보내는 플러그인 버전 헤더를 서버가 기억하고, 스냅샷이 서버 버전과 비교한다
describe("/hooks/event의 X-Claude-Office-Plugin", () => {
  let server: Server;
  let port: number;
  let seen: string[];
  beforeEach(async () => {
    setLogger(new Logger({ dir: "" }));
    seen = [];
    const snap = makeSnapshot({});
    server = createApp({ current: () => snap, subscribe: () => () => {}, poke: () => {} }, { onPluginVersion: (v) => void seen.push(v) }).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const hook = (body: unknown, headers: Record<string, string> = {}) =>
    new Promise<number>((resolve, reject) => {
      const s = JSON.stringify(body);
      const req = request({ host: "127.0.0.1", port, path: "/hooks/event", method: "POST", headers: { Host: `127.0.0.1:${port}`, "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(s)), ...headers } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      req.on("error", reject);
      req.end(s);
    });
  const ok = { hook_event_name: "Stop", session_id: "s1" };

  it("헤더 값을 넘기고, 없으면 unknown. 잘못된 hook(400)은 넘기지 않는다", async () => {
    expect(await hook(ok, { "X-Claude-Office-Plugin": "2.0.0-beta.12" })).toBe(200);
    expect(await hook(ok)).toBe(200);
    expect(await hook({ nope: 1 }, { "X-Claude-Office-Plugin": "9.9.9" })).toBe(400);
    expect(seen).toEqual(["2.0.0-beta.12", "unknown"]);
  });
});

describe("Snapshot.plugin", () => {
  let h: FakeHome;
  beforeEach(async () => {
    h = await makeHome();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await h.cleanup();
  });
  const build = (plugin: string | null) => new SnapshotBuilder({ claudeHome: h.home, config: { budget: {}, contextWindows: {} }, version: "2.0.0-beta.12", plugin: () => plugin }).build();

  it("hook을 한 번도 받지 않았으면 없음, 같으면 match:true, 다르면·unknown이면 match:false", async () => {
    expect((await build(null)).plugin).toBeUndefined();
    expect((await build("2.0.0-beta.12")).plugin).toEqual({ version: "2.0.0-beta.12", match: true });
    expect((await build("2.0.0-beta.11")).plugin).toEqual({ version: "2.0.0-beta.11", match: false });
    expect((await build("unknown")).plugin).toEqual({ version: "unknown", match: false });
  });

  it("옛 http 입구로 온 세션이 있으면 legacy:true(Phase 6a §4)", async () => {
    const b = (legacy: boolean) => new SnapshotBuilder({ claudeHome: h.home, config: { budget: {}, contextWindows: {} }, version: "2.0.0-beta.12", plugin: () => "2.0.0-beta.12", pluginLegacy: () => legacy }).build();
    expect((await b(true)).plugin).toEqual({ version: "2.0.0-beta.12", match: true, legacy: true });
    expect((await b(false)).plugin).toEqual({ version: "2.0.0-beta.12", match: true });
  });
});
