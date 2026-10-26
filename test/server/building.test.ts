import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../server/app";
import { BuildingStore, DEFAULT_USER_NAME, MAX_USER_NAME } from "../../server/building";
import { Logger, setLogger } from "../../server/log";
import { makeSnapshot } from "../web/fixtures";

// Phase 6b Task 10(스펙 12장 f): 지붕 간판의 사용자 이름. <PREFIX>/building.json(0600, 원자 쓰기)
let dir: string;
let file: string;
beforeEach(() => {
  setLogger(new Logger({ dir: "" }));
  dir = mkdtempSync(join(tmpdir(), "co-bld-"));
  file = join(dir, "building.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("BuildingStore", () => {
  it(`처음은 "${DEFAULT_USER_NAME}", 저장하면 0600 파일(임시 파일 남지 않음)이고 다시 켜도 남는다`, () => {
    const s = new BuildingStore({ file });
    expect(s.userName()).toBe(DEFAULT_USER_NAME);
    expect(s.set({ userName: "  김 팀장  " })).toEqual({ ok: true, userName: "김 팀장", variant: "system", saved: true });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["building.json"]);
    expect(new BuildingStore({ file }).userName()).toBe("김 팀장");
  });

  it(`1~${MAX_USER_NAME}자(낱자 기준 — 이모지·결합 문자 하나는 한 자), 빈 값·제어 문자(Cc·bidi 같은 Cf, 이모지 ZWJ는 허용)·글자가 아닌 값은 거절`, () => {
    const s = new BuildingStore({ file });
    expect(s.set({ userName: "가".repeat(MAX_USER_NAME) }).ok).toBe(true);
    expect(s.set({ userName: "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F} 팀" }).ok).toBe(true); // 태그 문자(Cf) 깃발
    expect(s.set({ userName: "👩‍💻".repeat(MAX_USER_NAME) }).ok).toBe(true);
    for (const v of ["", "   ", "가".repeat(MAX_USER_NAME + 1), "a\nb", "a\u0000b", "a\tb", "a\u202Eb", "\u200Fx", "a\u2066b", 3, null]) expect(s.set({ userName: v }), JSON.stringify(v)).toEqual({ ok: false, error: "name" });
    expect(s.userName()).toBe("👩‍💻".repeat(MAX_USER_NAME));
  });

  it("깨진 파일·형식이 틀린 이름은 기본값으로 읽고, 읽을 때 넓은 권한은 0600으로 좁힌다", () => {
    writeFileSync(file, "{oops");
    chmodSync(file, 0o644);
    expect(new BuildingStore({ file }).userName()).toBe(DEFAULT_USER_NAME);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    writeFileSync(file, JSON.stringify({ userName: "a\nb" }));
    expect(new BuildingStore({ file }).userName()).toBe(DEFAULT_USER_NAME);
  });
});

describe("낮·밤 변형(Phase 7 Task 3)", () => {
  it("기본은 system, night를 저장하면 다시 켜도 남고 0600. 이름·변형을 따로 보내도 다른 값을 잃지 않는다", () => {
    const s = new BuildingStore({ file });
    expect(s.variant()).toBe("system");
    expect(s.set({ variant: "night" })).toEqual({ ok: true, userName: DEFAULT_USER_NAME, variant: "night", saved: true });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(new BuildingStore({ file }).variant()).toBe("night");
    s.set({ userName: "빌딩주" });
    expect([new BuildingStore({ file }).userName(), new BuildingStore({ file }).variant()]).toEqual(["빌딩주", "night"]);
    s.set({ variant: "day" });
    expect([new BuildingStore({ file }).userName(), new BuildingStore({ file }).variant()]).toEqual(["빌딩주", "day"]);
  });

  it("dusk·남는 키·빈 본문은 거절하고 파일을 바꾸지 않는다. 파일의 틀린 변형은 system으로 읽는다", () => {
    const s = new BuildingStore({ file });
    s.set({ userName: "A", variant: "night" });
    const before = readFileSync(file, "utf8");
    for (const p of [{ variant: "dusk" }, { variant: "night", extra: 1 }, {}, [], null, { userName: "B", variant: "dusk" }]) expect(s.set(p).ok, JSON.stringify(p)).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect([s.userName(), s.variant()]).toEqual(["A", "night"]);
    writeFileSync(file, JSON.stringify({ userName: "A", variant: "dusk" }));
    expect(new BuildingStore({ file }).variant()).toBe("system");
  });
});

describe("스냅샷의 building", () => {
  it("빌더에 넘기면 snapshot.building.userName으로 낸다(간판이 바로 바뀜)", async () => {
    const { SnapshotBuilder } = await import("../../server/snapshot");
    const store = new BuildingStore({ file });
    store.set({ userName: "빌딩주", variant: "night" });
    const snap = await new SnapshotBuilder({ claudeHome: join(dir, "none"), config: { budget: {}, contextWindows: {} }, building: store }).build();
    expect(snap.building).toEqual({ userName: "빌딩주", variant: "night" });
  });
});

describe("GET·PUT /api/building", () => {
  const TOKEN = "d".repeat(64);
  let server: Server;
  let port: number;
  let store: BuildingStore;
  beforeEach(async () => {
    store = new BuildingStore({ file });
    server = createApp({ current: () => makeSnapshot({}), subscribe: () => () => {}, poke: () => {} }, { auth: { token: TOKEN }, building: store }).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const send = (method: string, body?: object, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const text = body === undefined ? undefined : JSON.stringify(body);
      const req = request({ host: "127.0.0.1", port, path: "/api/building", method, headers: { Host: `127.0.0.1:${port}`, Cookie: `co_${port}=${TOKEN}`, Origin: `http://127.0.0.1:${port}`, ...(text ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(text)) } : {}), ...headers } }, (res) => {
        let t = "";
        res.on("data", (d) => (t += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: t }));
      });
      req.on("error", reject);
      req.end(text);
    });

  it("GET은 지금 이름, PUT은 저장하고 이름을 돌려준다. 틀린 이름은 400 name, 다른 출처는 403, 열쇠 없으면 401", async () => {
    expect(JSON.parse((await send("GET")).body)).toEqual({ userName: DEFAULT_USER_NAME, variant: "system" });
    expect(JSON.parse((await send("PUT", { userName: " 빌딩주 " })).body)).toEqual({ userName: "빌딩주", variant: "system", saved: true });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ userName: "빌딩주", variant: "system" });
    // 변형(Phase 7 Task 3): 따로 저장, 틀린 값은 400 variant
    expect(JSON.parse((await send("PUT", { variant: "night" })).body)).toEqual({ userName: "빌딩주", variant: "night", saved: true });
    expect(await send("PUT", { variant: "dusk" })).toEqual({ status: 400, body: JSON.stringify({ error: "variant" }) });
    expect(await send("PUT", { userName: "" })).toEqual({ status: 400, body: JSON.stringify({ error: "name" }) });
    expect((await send("PUT", { userName: "x", extra: 1 })).status).toBe(400);
    expect((await send("PUT", { userName: "x" }, { Origin: "http://evil.example" })).status).toBe(403);
    expect((await send("GET", undefined, { Cookie: "" })).status).toBe(401);
    expect(store.userName()).toBe("빌딩주");
  });
});
