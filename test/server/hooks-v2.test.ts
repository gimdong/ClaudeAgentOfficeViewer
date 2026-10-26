import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../server/app";
import { HookStats } from "../../server/events/stats";
import { HOOK_V2, LegacySessions, ReplayWindow, deriveKeys, loadOrCreateHookKey } from "../../server/hooks/v2";
import { Logger, setLogger } from "../../server/log";
import { makeSnapshot } from "../web/fixtures";

// Phase 6a §4: 암호화 command relay의 입구. 테스트는 서버 모듈의 deriveKeys를 쓰지 않고 고정 글자(B292)로 키를 직접 만든다 —
// 서버가 키 방향이나 info를 바꾸면 여기서 깨진다
const KEY = Buffer.from("ab".repeat(32), "hex"); // 가짜 열쇠
const hk = (info: string) => Buffer.from(hkdfSync("sha256", KEY, Buffer.alloc(0), info, 32));
const REQ = hk("claude-office hook req v1");
const RES = hk("claude-office hook res v1");
const KID = createHash("sha256").update(KEY).digest("hex").slice(0, 16);
const pre = { session_id: "s1", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } };

function seal(plain: object, o: { kid?: string; iv?: Buffer; key?: Buffer; flip?: boolean; tagLen?: number } = {}) {
  const iv = o.iv ?? randomBytes(12);
  const kid = o.kid ?? KID;
  const c = createCipheriv("aes-256-gcm", o.key ?? REQ, iv);
  c.setAAD(Buffer.from(kid));
  const ct = Buffer.concat([c.update(JSON.stringify(plain)), c.final()]);
  if (o.flip) ct[0] ^= 1;
  return { kid, iv: iv.toString("hex"), ct: ct.toString("base64"), tag: c.getAuthTag().subarray(0, o.tagLen ?? 16).toString("hex") };
}
const plain = (event: object, o: Partial<{ v: number; id: string; ts: number; plugin: string }> = {}) => ({ v: 1, id: randomBytes(16).toString("hex"), ts: Date.now(), plugin: "2.0.0-beta.14", event, ...o });
function open(body: string) {
  const { iv, ct, tag } = JSON.parse(body);
  const d = createDecipheriv("aes-256-gcm", RES, Buffer.from(iv, "hex"));
  d.setAuthTag(Buffer.from(tag, "hex"));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString());
}

let server: Server;
let port: number;
let stats: HookStats;
let versions: Array<[string, boolean, string]>;
let froms: Array<{ v2: boolean }>;
let pauseAnswer: object | null;
let held: { closed?: boolean; answer?: (o: object) => void };
let socketClosed: Array<() => void>;
beforeEach(async () => {
  setLogger(new Logger({ dir: "" }));
  stats = new HookStats();
  versions = [];
  froms = [];
  pauseAnswer = null;
  held = {};
  socketClosed = [];
  const snap = makeSnapshot({});
  server = createApp(
    { current: () => snap, subscribe: () => () => {}, poke: () => {} },
    {
      stats,
      onPluginVersion: (v, legacy, sid) => void versions.push([v, legacy, sid]),
      onHookEvent: (_i, from) => void froms.push(from),
      hookV2: { keys: () => deriveKeys(KEY), seen: new ReplayWindow() },
      floors: { preToolUse: () => pauseAnswer, pause() {}, resume() {}, isPaused: () => false, terminate: async () => ({ ok: true }) as never, hide() {}, unhideAll() {}, hiddenCount: () => 0, record: () => undefined },
      decisions: {
        onEvent() {},
        hold(_i: unknown, res: { writableEnded: boolean; on(e: "close", f: () => void): unknown; status(c: number): { json(b: unknown): unknown } }) {
          res.on("close", () => (held.closed = !res.writableEnded));
          held.answer = (o) => res.status(200).json(o);
          return null;
        },
      } as never,
    },
  ).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

type Res = { status: number; body: string };
function post(body: string, headers: Record<string, string> = {}, path = "/hooks/v2"): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "POST", headers: { Host: `127.0.0.1:${port}`, "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)), ...headers } }, (res) => {
      let t = "";
      res.on("data", (d) => (t += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: t }));
    });
    req.on("error", reject);
    socketClosed.push(() => req.destroy());
    req.end(body);
  });
}
const send = (p: object, o?: Parameters<typeof seal>[1]) => post(JSON.stringify(seal(p, o)));

describe("/hooks/v2 (Phase 6a §4)", () => {
  it("정상 왕복: 풀어서 기존 처리기로 넘기고, 응답 키로 {id, out}을 암호화해 200", async () => {
    const p = plain(pre);
    const r = await send(p);
    expect(r.status).toBe(200);
    expect(open(r.body)).toEqual({ id: p.id, out: null });
    pauseAnswer = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "휴업" } };
    const q = plain(pre);
    expect(open((await send(q)).body)).toEqual({ id: q.id, out: pauseAnswer });
    expect(stats.view().v2).toBe(2);
    expect(stats.view().byEvent.PreToolUse).toBe(2);
    expect(versions).toEqual([["2.0.0-beta.14", false, "s1"], ["2.0.0-beta.14", false, "s1"]]);
  });

  it("B344: 저장소로 넘기는 이벤트에 입구를 싣는다 — /hooks/v2는 v2 true, 옛 /hooks/event는 false(지시 수신 판정은 v2만)", async () => {
    await send(plain(pre));
    expect((await post(JSON.stringify(pre), {}, "/hooks/event")).status).toBe(200);
    expect(froms).toEqual([{ v2: true }, { v2: false }]);
  });

  it("응답은 요청 키로는 풀리지 않는다(키 방향 분리), 평문 표지가 응답 본문에 없다", async () => {
    const p = plain(pre);
    const r = await send(p);
    expect(r.body).not.toContain(p.id);
    const { iv, ct, tag } = JSON.parse(r.body);
    const d = createDecipheriv("aes-256-gcm", REQ, Buffer.from(iv, "hex"));
    d.setAuthTag(Buffer.from(tag, "hex"));
    expect(() => Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()])).toThrow();
  });

  it("kid 틀림·1비트 변조·요청 키가 아닌 키·ts 범위 밖(-31초·+3초)·v≠1·id 형식·이벤트 형식은 모두 401 빈 본문", async () => {
    const cases: Array<[string, Promise<Res>]> = [
      ["kid", send(plain(pre), { kid: "0".repeat(16) })],
      ["flip", send(plain(pre), { flip: true })],
      ["res key", send(plain(pre), { key: RES })],
      ["ts+3", send(plain(pre, { ts: Date.now() + 3_000 }))],
      ["ts-31", send(plain(pre, { ts: Date.now() - 31_000 }))],
      ["v2", send(plain(pre, { v: 2 }))],
      ["id", send(plain(pre, { id: "x" }))],
      ["event", send(plain({ hook_event_name: "PreToolUse" }))],
    ];
    for (const [n, p] of cases) expect(await p, n).toEqual({ status: 401, body: "" });
    expect(stats.view().rejected["401-v2"]).toBe(cases.length);
    expect(stats.view().v2).toBe(0);
  });

  it("ts는 30초 전부터 2초 뒤까지 받고, 1.4MB 본문도 받는다(relay stdin 1MB의 base64)", async () => {
    expect((await send(plain(pre, { ts: Date.now() + 1_500 }))).status).toBe(200);
    expect((await send(plain({ ...pre, tool_input: { command: "x".repeat(1024 * 1024) } }))).status).toBe(200);
    expect((await send(plain(pre, { ts: Date.now() - 29_000 }))).status).toBe(200);
  });

  it("같은 요청을 다시 보내면(같은 id) 두 번째는 401", async () => {
    const body = JSON.stringify(seal(plain(pre)));
    expect((await post(body)).status).toBe(200);
    expect(await post(body)).toEqual({ status: 401, body: "" });
  });

  it("iv 11바이트·tag 15바이트·필드 빠짐·깨진 JSON·1.5MB 초과·Origin은 401 빈 본문", async () => {
    const ok = seal(plain(pre));
    for (const [n, b] of [
      ["iv", JSON.stringify(seal(plain(pre), { iv: randomBytes(11) }))],
      ["tag", JSON.stringify(seal(plain(pre), { tagLen: 15 }))],
      ["no ct", JSON.stringify({ ...ok, ct: undefined })],
      ["array", "[]"],
      ["broken", "{broken"],
      ["big", JSON.stringify({ ...ok, pad: "x".repeat(1.5 * 1024 * 1024 + 10) })],
    ] as const) expect(await post(b), n).toEqual({ status: 401, body: "" });
    expect(await post(JSON.stringify(seal(plain(pre))), { Origin: `http://127.0.0.1:${port}` })).toEqual({ status: 401, body: "" });
  });

  it("PermissionRequest: 대시보드 답은 암호화되어 가고, 기다리는 중 relay가 끊으면 결정이 닫힌다", async () => {
    const pr = { ...pre, hook_event_name: "PermissionRequest" };
    const a = plain(pr);
    const pa = send(a);
    await until(() => !!held.answer);
    held.answer!({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
    expect(open((await pa).body)).toEqual({ id: a.id, out: { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } } });
    expect(held.closed).toBe(false);
    held = {};
    const pb = send(plain(pr)).catch(() => undefined);
    await until(() => !!held.answer);
    socketClosed.at(-1)!();
    await pb;
    await until(() => held.closed === true);
  });

  it("열쇠가 없거나 잘못되면(keys()가 null) 입구를 닫는다 — 401", async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    server = createApp({ current: () => makeSnapshot({}), subscribe: () => () => {}, poke: () => {} }, { stats, hookV2: { keys: () => null, seen: new ReplayWindow() } }).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    port = (server.address() as AddressInfo).port;
    expect(await send(plain(pre))).toEqual({ status: 401, body: "" });
  });

  it("옛 /hooks/event로 받으면 legacy로 알린다", async () => {
    expect((await post(JSON.stringify(pre), { "X-Claude-Office-Plugin": "2.0.0-beta.13" }, "/hooks/event")).status).toBe(200);
    expect(versions).toEqual([["2.0.0-beta.13", true, "s1"]]);
  });
});

describe("재전송 창·키(B292 상수)", () => {
  it("HKDF info·필드 이름·크기는 한 곳의 상수", () => {
    expect(HOOK_V2).toMatchObject({
      infoReq: "claude-office hook req v1", infoRes: "claude-office hook res v1",
      body: ["kid", "iv", "ct", "tag"], plain: ["v", "id", "ts", "plugin", "event"], reply: ["id", "out"],
      ivBytes: 12, tagBytes: 16, idBytes: 16, windowMs: 30_000, futureMs: 2_000, maxSeen: 10_000, maxBody: "1.5mb",
    });
    const k = deriveKeys(KEY);
    expect([k.req.equals(REQ), k.res.equals(RES), k.kid]).toEqual([true, true, KID]);
  });

  it("본 id는 max(ts, 받은 시각)+30초까지 기억한다 — 미래 ts로 창을 비껴가지 못한다", () => {
    const w = new ReplayWindow();
    expect(w.add("a", 1000, 0)).toBe(true);
    expect(w.add("a", 1000, 30_999)).toBe(false); // ts+30초 안
    expect(w.add("a", 1000, 31_001)).toBe(true); // 창이 지났다
    const f = new ReplayWindow();
    expect(f.add("b", 5_000, 0)).toBe(true); // ts가 5초 미래
    expect(f.add("b", 5_000, 34_000)).toBe(false); // 받은 시각+30초는 지났지만 ts+30초 안
  });

  it(`${HOOK_V2.maxSeen}개가 창 안 id로 가득 차면 새 요청을 거절하고(창 안 id를 버리지 않는다), 창이 지난 것은 지운다`, () => {
    const w = new ReplayWindow();
    for (let i = 0; i < HOOK_V2.maxSeen; i++) expect(w.add(`id${i}`, 0, 0)).toBe(true);
    expect(w.add("new", 0, 1)).toBe(false);
    expect(w.add("id0", 0, 1)).toBe(false); // 재전송은 여전히 막힌다
    expect(w.size()).toBe(HOOK_V2.maxSeen);
    expect(w.add("new", 0, HOOK_V2.windowMs + 1)).toBe(true); // 창이 지난 것을 지우고 받는다
    expect(w.size()).toBe(1);
  });
});

describe("legacy 세션(스펙 4장)", () => {
  it("옛 입구로 온 세션을 기억하고, 그 세션이 끝나거나 10분 동안 옛 입구 이벤트가 없으면 잊는다", () => {
    const l = new LegacySessions();
    expect(l.active(0)).toBe(false);
    l.seen("s1", 0);
    l.seen("s2", 0);
    expect(l.active(1)).toBe(true);
    l.end("s1");
    expect(l.active(1)).toBe(true);
    l.seen("s2", 5 * 60_000);
    expect(l.active(14 * 60_000)).toBe(true);
    expect(l.active(15 * 60_000 + 1)).toBe(false);
  });
});

describe("hook 열쇠 파일(스펙 4장)", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "co-hk-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("없으면 32바이트 hex를 0600으로(폴더 0700) 만들고, 다시 부르면 같은 열쇠", () => {
    const f = join(dir, "sub", "hook.key");
    const a = loadOrCreateHookKey(f);
    expect(a.ok && a.key.length).toBe(32);
    expect(readFileSync(f, "utf8")).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "sub")).mode & 0o777).toBe(0o700);
    const b = loadOrCreateHookKey(f);
    expect(b.ok && a.ok && b.key.equals(a.key)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("자기 소유 0400 열쇠는 그대로 두고(chmod 안 함) 그 열쇠로 /hooks/v2가 열린다(B293, review M3)", async () => {
    const f = join(dir, "ro.key");
    writeFileSync(f, KEY.toString("hex"));
    chmodSync(f, 0o400);
    const k = loadOrCreateHookKey(f);
    expect(k.ok).toBe(true);
    expect(statSync(f).mode & 0o777).toBe(0o400);
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    server = createApp({ current: () => makeSnapshot({}), subscribe: () => () => {}, poke: () => {} }, { stats, hookV2: { keys: () => (k.ok ? deriveKeys(k.key) : null), seen: new ReplayWindow() } }).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    port = (server.address() as AddressInfo).port;
    const p = plain(pre);
    const r = await send(p);
    expect(r.status).toBe(200);
    expect(open(r.body)).toEqual({ id: p.id, out: null });
  });

  it.skipIf(process.platform === "win32")("자기 파일이 넓은 권한이면 0600으로 좁혀 쓰고, 내용이 64자 hex가 아니거나 소유자가 다르면 거부", () => {
    const f = join(dir, "hook.key");
    writeFileSync(f, "cd".repeat(32));
    chmodSync(f, 0o644);
    const a = loadOrCreateHookKey(f);
    expect(a.ok && a.key.toString("hex")).toBe("cd".repeat(32));
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(loadOrCreateHookKey(f, (process.getuid?.() ?? 0) + 1)).toEqual({ ok: false, reason: "owner" });
    writeFileSync(f, "short");
    expect(loadOrCreateHookKey(f)).toEqual({ ok: false, reason: "format" });
  });
});

async function until(f: () => boolean, ms = 3000) {
  const t = Date.now();
  while (!f()) {
    if (Date.now() - t > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}
