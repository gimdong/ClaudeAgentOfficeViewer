// #647·스펙 12장 (n) — 구현 전 실패 테스트(B306 방식). 층 등록을 열쇠 폴더의 registry.json에 남겨, 대시보드를 다시 켜도
// channel이 새 핸드셰이크로 다시 붙는다. 인터페이스: new ChannelHub({file, available, keyDir}) → load()가 keyDir/registry.json을 읽는다.
// 열쇠는 key 파일(floorKeyFile)에만. 가짜 값만, 포트는 임의
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../server/app";
import { ChannelHub, MAX_LAUNCHED, UNSEEN_MS, floorKeyFile } from "../../server/floors/channels";
import { ReportStore } from "../../server/floors/reports";
import { makeSnapshot } from "../web/fixtures";

const SCRIPT = join(__dirname, "../../plugins/claude-office/channel/server.mjs");
const posix = process.platform !== "win32";

let base: string;
let keyDir: string;
let expFile: string;
const servers: Server[] = [];
const children: ChildProcess[] = [];
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "co-sec-reg-"));
  keyDir = join(base, "floors");
  expFile = join(base, "experimental.json");
});
afterEach(async () => {
  for (const c of children.splice(0)) c.kill();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => (s.closeAllConnections(), s.close(() => r())))));
  rmSync(base, { recursive: true, force: true });
});

const hubAt = (now?: () => number) => {
  const h = new ChannelHub({ file: expFile, available: { ok: true }, keyDir, ...(now ? { now } : {}) });
  h.load();
  h.setEnabled(true);
  return h;
};
const registry = () => join(keyDir, "registry.json");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms: number) {
  const t = Date.now();
  while (!f() && Date.now() - t < ms) await wait(50);
}
async function dashboard(hub: ChannelHub, port = 0) {
  const s = createApp({ current: () => makeSnapshot(), subscribe: () => () => {} }, { channels: { hub, launch: async () => ({ ok: false, error: "tmux" }) } }).listen(port, "127.0.0.1");
  servers.push(s);
  await new Promise((r) => s.once("listening", r));
  return { server: s, port: (s.address() as AddressInfo).port };
}
async function stop(s: Server) {
  servers.splice(servers.indexOf(s), 1);
  s.closeAllConnections();
  await new Promise<void>((r) => s.close(() => r()));
}
function channel(port: number, keyFile: string) {
  const c = spawn(process.execPath, [SCRIPT], { env: { PATH: process.env.PATH ?? "", CLAUDE_OFFICE_PORT: String(port), CLAUDE_OFFICE_FLOOR_KEY_FILE: keyFile }, stdio: ["pipe", "pipe", "ignore"] });
  children.push(c);
  const got: string[] = [];
  let buf = "";
  c.stdout!.on("data", (d) => {
    buf += String(d);
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      try {
        const m = JSON.parse(buf.slice(0, i));
        if (m.method === "notifications/claude/channel") got.push(String(m.params?.content));
      } catch {}
      buf = buf.slice(i + 1);
    }
  });
  c.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } } }) + "\n");
  c.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return { child: c, got };
}

describe.skipIf(!posix)("(a)(h) 재시작 뒤 다시 붙기", () => {
  it("대시보드를 껐다 켜도(같은 열쇠 폴더) 같은 열쇠의 channel이 새 핸드셰이크로 다시 붙고, 같은 층 둘이면 한쪽에만 지시가 간다", async () => {
    const h1 = hubAt();
    h1.register("s1", "co-0a1b2c3d");
    const d1 = await dashboard(h1);
    const kf = floorKeyFile(keyDir, "co-0a1b2c3d");
    const a = channel(d1.port, kf);
    const b = channel(d1.port, kf); // 같은 열쇠(리드 둘이 동시에 다시 붙는 경우)
    await until(() => h1.connected("s1"), 5000);
    expect(h1.connected("s1")).toBe(true);
    await stop(d1.server);
    const h2 = hubAt(); // 재시작
    expect(h2.has("s1")).toBe(true);
    await dashboard(h2, d1.port);
    await until(() => h2.connected("s1"), 40_000);
    expect(h2.connected("s1")).toBe(true);
    for (let i = 0; i < 6; i++) {
      h2.instruct("s1", `AFTER_RESTART ${i}`, false);
      await wait(300);
    }
    await wait(300);
    const na = a.got.filter((x) => x.startsWith("AFTER_RESTART")).length;
    const nb = b.got.filter((x) => x.startsWith("AFTER_RESTART")).length;
    expect(na + nb).toBe(6);
    expect(Math.min(na, nb)).toBe(0);
  }, 60_000);
});

describe.skipIf(!posix)("(b)(c)(d) 등록 파일", () => {
  it("(b) registry.json에는 열쇠·kid가 없고 파일 0600·폴더 0700", () => {
    const h = hubAt();
    const key = h.register("s1", "co-0a1b2c3d")!;
    const text = readFileSync(registry(), "utf8");
    expect(text).not.toContain(key);
    expect(text).toContain("s1");
    expect(text).not.toMatch(/[0-9a-f]{64}/);
    expect(statSync(registry()).mode & 0o777).toBe(0o600);
    expect(statSync(keyDir).mode & 0o777).toBe(0o700);
  });

  it("(c) 그룹·다른 사용자 쓰기 권한의 registry, 0644 열쇠 파일, 64자 hex가 아닌 열쇠는 등록하지 않고 파일을 지우지도 않는다", () => {
    const h = hubAt();
    h.register("s1", "co-0a1b2c3d");
    h.register("s2", "co-11112222");
    h.register("s3", "co-33334444");
    chmodSync(floorKeyFile(keyDir, "co-11112222"), 0o644);
    writeFileSync(floorKeyFile(keyDir, "co-33334444"), "not-hex", { mode: 0o600 });
    const h2 = hubAt();
    expect([h2.has("s1"), h2.has("s2"), h2.has("s3")]).toEqual([true, false, false]);
    chmodSync(registry(), 0o666);
    const h3 = hubAt();
    expect(h3.has("s1")).toBe(false);
    for (const t of ["co-0a1b2c3d", "co-11112222", "co-33334444"]) expect(existsSync(floorKeyFile(keyDir, t)), t).toBe(true);
    expect(existsSync(registry())).toBe(true);
  });

  it("(d) 이상한 sessionId·tmux 항목과 상한을 넘는 항목은 버린다", () => {
    mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    chmodSync(keyDir, 0o700);
    const key = "ab".repeat(32);
    const entries: { sessionId: string; tmux: string; at: number }[] = [
      { sessionId: "bad/../x", tmux: "co-0a1b2c3d", at: 1 },
      { sessionId: "ok-1", tmux: "co-xx; rm -rf ~", at: 1 },
      { sessionId: "ok-2", tmux: "../x", at: 1 },
      { sessionId: "ok-3", tmux: "co-ZZZZZZZZ", at: 1 },
    ];
    for (let i = 0; i < MAX_LAUNCHED + 2; i++) entries.push({ sessionId: `good-${i}`, tmux: `co-${i.toString(16).padStart(8, "0")}`, at: 1 });
    for (const e of entries) if (/^co-[0-9a-f]{8}$/.test(e.tmux)) writeFileSync(floorKeyFile(keyDir, e.tmux), key, { mode: 0o600 });
    writeFileSync(registry(), JSON.stringify({ floors: entries }), { mode: 0o600 });
    const h = hubAt();
    for (const id of ["bad/../x", "ok-1", "ok-2", "ok-3"]) expect(h.has(id), id).toBe(false);
    expect(h.launchedCount()).toBeLessThanOrEqual(MAX_LAUNCHED);
  });
});

describe("(e) 핸드셰이크 상태는 재시작을 넘지 않는다", () => {
  it.skipIf(!posix)("지난 실행의 snonce로 attach, 지난 ack 토큰으로 submit하면 거절", async () => {
    const { createHmac, randomBytes } = await import("node:crypto");
    const mac = (k: string, m: string) => createHmac("sha256", k).update(m).digest("hex");
    const h1 = hubAt();
    const key = h1.register("s1", "co-0a1b2c3d")!;
    const kid = mac(key, "kid");
    const nonce = randomBytes(32).toString("hex");
    const hello = h1.hello(kid, nonce)!;
    const h2 = hubAt();
    expect(h2.has("s1")).toBe(true);
    const res = { on: () => {}, end: () => {}, destroyed: false, writableEnded: false } as never;
    expect(h2.attach({ kid, snonce: hello.snonce, proof: mac(key, `client|${nonce}|${hello.snonce}`) }, res)).toBeNull();
    expect(h2.verifySubmit("a".repeat(64), "x", "m", "0".repeat(32))).toBeNull();
  });
});

describe.skipIf(!posix)("(f) channel 서버의 401 처리", () => {
  async function always401() {
    let hellos = 0;
    const s = createServer((req, res) => {
      if (req.url === "/channel/hello") hellos++;
      req.resume();
      req.on("end", () => res.writeHead(401).end());
    }).listen(0, "127.0.0.1");
    servers.push(s);
    await new Promise((r) => s.once("listening", r));
    return { port: (s.address() as AddressInfo).port, count: () => hellos };
  }
  it("열쇠 파일이 있는데 401이면 멈추지 않고 다시 시도한다(재시작 직후의 등록 누락에서도 살아남게)", async () => {
    const f = await always401();
    const kf = join(base, "k.key");
    writeFileSync(kf, "cd".repeat(32), { mode: 0o600 });
    channel(f.port, kf);
    await until(() => f.count() >= 2, 40_000);
    expect(f.count()).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it("열쇠 파일이 사라지면(층 정리) 401 뒤에 멈춘다", async () => {
    const f = await always401();
    const kf = join(base, "k2.key");
    writeFileSync(kf, "cd".repeat(32), { mode: 0o600 });
    channel(f.port, kf);
    await until(() => f.count() >= 1, 5000);
    rmSync(kf);
    const n = f.count();
    await wait(4000);
    expect(f.count()).toBeLessThanOrEqual(n + 1);
  }, 30_000);
});

describe.skipIf(!posix)("(g) 옛 층 정리", () => {
  it("10분 넘게 전에 띄운 층도 재시작 직후 정리되지 않고, 그 뒤 10분 동안 붙지 않거나 세션 목록에 없으면 등록과 열쇠 파일이 함께 지워진다", () => {
    let t = 1_800_000_000_000;
    const h1 = hubAt(() => t);
    h1.register("s1", "co-0a1b2c3d");
    t += 3 * UNSEEN_MS; // 30분 뒤 재시작
    const h2 = hubAt(() => t);
    h2.sweep(new Set());
    expect(h2.has("s1")).toBe(true);
    t += UNSEEN_MS + 1000;
    h2.sweep(new Set());
    expect(h2.has("s1")).toBe(false);
    expect(existsSync(floorKeyFile(keyDir, "co-0a1b2c3d"))).toBe(false);
    expect(readFileSync(registry(), "utf8")).not.toContain("s1");
  });
});

describe("보고 요청 대기 id(12장 n)", () => {
  it("재시작 뒤에도 남아 같은 request_id를 한 번은 받고 두 번째는 거절한다(ask_user 질문은 QuestionBoard 메모리라 여기 없음)", () => {
    const file = join(base, "reports.json");
    const r1 = new ReportStore({ file });
    r1.expect("r-0a1b2c3d", "s1", "report");
    r1.add("s1", { id: "r-dummy000", kind: "report", title: "t", body: "b" }); // 저장을 한 번 일으킨다
    const r2 = new ReportStore({ file });
    expect(r2.take("r-0a1b2c3d", "s1", "report")).not.toBeNull();
    expect(r2.take("r-0a1b2c3d", "s1", "report")).toBeNull();
    if (posix) expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
