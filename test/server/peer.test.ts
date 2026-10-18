import { request, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../server/app";
import { HookStats } from "../../server/events/stats";
import { Logger, setLogger } from "../../server/log";
import { peerUidFromProc, sameUserGuard, UID_REJECT_BODY } from "../../server/peer";
import { makeSnapshot } from "../web/fixtures";

// Phase 5 §2 같은 계정만 받기. /proc 내용은 모두 가짜 문자열(주입) — 실제 /proc·이름·경로를 쓰지 않는다(B242)
const HEAD = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
const hex = (p: number) => p.toString(16).toUpperCase().padStart(4, "0");
const LO4 = "0100007F"; // 127.0.0.1(4바이트 리틀엔디언)
const LO6 = "00000000000000000000000001000000"; // ::1(32비트 단어별 리틀엔디언)
const MAP6 = "0000000000000000FFFF00000100007F"; // ::ffff:127.0.0.1
const row = (lp: number, rp: number, uid: number | string, la = LO4, ra = LO4) => `   0: ${la}:${hex(lp)} ${ra}:${hex(rp)} 01 00000000:00000000 00:00000000 00000000  ${uid}        0 1\n`;
const row6 = (lp: number, rp: number, uid: number, la = LO6, ra = LO6) => row(lp, rp, uid, la, ra);
const L = "127.0.0.1";

describe("peerUidFromProc(순수 함수)", () => {
  it("클라이언트 쪽 줄(local = 클라이언트 포트, rem = 서버 포트)의 uid. 서버 쪽 줄은 보지 않는다", () => {
    expect(peerUidFromProc(HEAD + row(4317, 50000, 0) + row(50000, 4317, 1000), "", L, 50000, L, 4317)).toBe(1000);
  });
  it("줄이 없으면 null", () => expect(peerUidFromProc(HEAD + row(4317, 50000, 0), "", L, 50000, L, 4317)).toBeNull());
  it("tcp6([::1] 접속)도 찾는다", () => expect(peerUidFromProc(HEAD, HEAD + row6(50000, 4317, 1001), "::1", 50000, "::1", 4317)).toBe(1001));
  it("uid가 숫자가 아니면 null(B241 ②)", () => expect(peerUidFromProc(HEAD + row(50000, 4317, "x1"), "", L, 50000, L, 4317)).toBeNull());
  it("머리글·빈 줄·깨진 줄은 건너뛴다", () => expect(peerUidFromProc(`${HEAD}\ngarbage\n   1: zz\n${row(50000, 4317, 7)}`, "", L, 50000, L, 4317)).toBe(7));
  it("주소까지 맞춘다: 다른 로컬 주소의 같은 포트 줄이 앞에 있어도 그 uid로 판정하지 않는다(B244 a)", () => {
    const other = row(50000, 4317, 1000, "0200007F", LO4); // 127.0.0.2 쪽의 같은 포트
    expect(peerUidFromProc(HEAD + other + row(50000, 4317, 1001), "", L, 50000, L, 4317)).toBe(1001);
    expect(peerUidFromProc(HEAD + other, "", L, 50000, L, 4317)).toBeNull();
    // 서버 쪽(rem) 주소가 다른 줄도 아니다
    expect(peerUidFromProc(HEAD + row(50000, 4317, 1000, LO4, "0200007F"), "", L, 50000, L, 4317)).toBeNull();
  });
  it("IPv4 매핑 주소(::ffff:127.0.0.1)는 tcp6의 매핑 형태로 찾는다(B244 a)", () => {
    expect(peerUidFromProc(HEAD, HEAD + row6(50000, 4317, 1002, MAP6, MAP6), "::ffff:127.0.0.1", 50000, "::ffff:127.0.0.1", 4317)).toBe(1002);
  });
  it("주소·포트가 맞는 줄이 둘 이상이고 uid가 다르면 null(거절, B244 b). 같으면 그 uid", () => {
    expect(peerUidFromProc(HEAD + row(50000, 4317, 1000) + row(50000, 4317, 1001), "", L, 50000, L, 4317)).toBeNull();
    expect(peerUidFromProc(HEAD + row(50000, 4317, 1000) + row(50000, 4317, 1000), "", L, 50000, L, 4317)).toBe(1000);
  });
});

describe("sameUserGuard(미들웨어, B241)", () => {
  let server: Server;
  let port: number;
  let lastClientPort = -1;
  let reads: string[];
  let read: (p: string) => string;
  let rejects: number;
  let logDir: string;
  const start = async (o: Parameters<typeof sameUserGuard>[0]) => {
    const app = express();
    app.use(sameUserGuard({ ...o, read: (p) => (reads.push(p), read(p)), onReject: () => void rejects++ }));
    app.get("/x", (_req, res) => void res.send("ok"));
    server = app.listen(0, "127.0.0.1");
    server.on("connection", (s: Socket) => (lastClientPort = s.remotePort ?? -1));
    await new Promise((r) => server.once("listening", r));
    port = (server.address() as AddressInfo).port;
  };
  const get = (agent?: import("node:http").Agent) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      // 기본은 새 소켓(전역 에이전트의 keep-alive가 소켓 캐시를 섞지 않게)
      const req = request({ host: "127.0.0.1", port, path: "/x", agent: agent ?? false }, (res) => {
        let t = "";
        res.on("data", (d) => (t += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: t }));
      });
      req.on("error", reject);
      req.end();
    });
  beforeEach(() => {
    reads = [];
    rejects = 0;
    logDir = mkdtempSync(join(tmpdir(), "co-peer-log-"));
    setLogger(new Logger({ dir: logDir }));
  });
  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise((r) => server.close(r));
    setLogger(new Logger({ dir: "" }));
    rmSync(logDir, { recursive: true, force: true });
  });
  // 서버 포트는 고정 4317이 아니라 그 소켓의 localPort다(B241 ③)
  const myRow = (uid: number | string, rp = port) => HEAD + row(lastClientPort, rp, uid);

  it("같은 uid는 통과, 다른 uid는 403 + 본문, onReject 한 번", async () => {
    await start({ platform: "linux", uid: 1000 });
    read = (p) => (p.endsWith("tcp") ? myRow(1000) : HEAD);
    expect(await get()).toEqual({ status: 200, body: "ok" });
    read = (p) => (p.endsWith("tcp") ? myRow(1001) : HEAD);
    expect(await get()).toEqual({ status: 403, body: UID_REJECT_BODY });
    expect(rejects).toBe(1);
  });

  it("/proc/net/tcp 읽기 실패는 거절, tcp6 읽기 실패(IPv6 꺼진 커널)만 빈 것으로 보고 tcp 줄로 통과(B241 ①)", async () => {
    await start({ platform: "linux", uid: 1000 });
    read = (p) => {
      if (p.endsWith("tcp")) throw new Error("EACCES");
      return HEAD + row6(lastClientPort, port, 1000);
    };
    expect((await get()).status).toBe(403);
    read = (p) => {
      if (p.endsWith("tcp6")) throw new Error("ENOENT");
      return myRow(1000);
    };
    expect((await get()).status).toBe(200);
  });

  it("줄 없음·uid가 숫자 아님·서버 포트가 4317로 고정이라 가정한 줄·다른 주소의 같은 포트 줄은 거절(B241 ②③, B244)", async () => {
    await start({ platform: "linux", uid: 1000 });
    for (const t of [HEAD, myRow("abc"), HEAD + row(lastClientPort, 4317, 1000), HEAD + row(lastClientPort, port, 1000, "0200007F", LO4)]) {
      read = (p) => (p.endsWith("tcp") ? t : HEAD);
      expect((await get()).status).toBe(403);
    }
  });

  it("tcp6 줄로도 통과([::1] 접속, B241 ④)", async () => {
    await start({ platform: "linux", uid: 1000 });
    // 이 서버는 127.0.0.1에 떠 있으므로 tcp6 쪽에는 IPv4 매핑 표기로 나타난다
    read = (p) => (p.endsWith("tcp6") ? HEAD + row6(lastClientPort, port, 1000, MAP6, MAP6) : HEAD);
    expect((await get()).status).toBe(200);
  });

  it("Linux가 아니거나 getuid가 없으면 /proc을 읽지 않고 통과", async () => {
    await start({ platform: "darwin", uid: 1000 });
    read = () => {
      throw new Error("must not read");
    };
    expect((await get()).status).toBe(200);
    expect(reads).toEqual([]);
  });

  it("판정은 소켓마다 한 번(keep-alive 연결에서 다시 읽지 않는다, B241 ⑤)", async () => {
    await start({ platform: "linux", uid: 1000 });
    read = (p) => (p.endsWith("tcp") ? myRow(1000) : HEAD);
    const { Agent } = await import("node:http");
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    expect((await get(agent)).status).toBe(200);
    const n = reads.length;
    expect((await get(agent)).status).toBe(200);
    expect(reads.length).toBe(n);
    agent.destroy();
  });

  it("로그에는 거절 사실·경로 종류만, uid·포트 값은 없다(B241 ⑥)", async () => {
    await start({ platform: "linux", uid: 4242 });
    read = (p) => (p.endsWith("tcp") ? myRow(5151) : HEAD);
    await get();
    const logs = readdirSync(logDir).map((f) => readFileSync(join(logDir, f), "utf8")).join("\n");
    expect(logs).toContain("other user");
    for (const v of ["4242", "5151", String(port), String(lastClientPort)]) expect(logs).not.toContain(v);
  });
});

describe("createApp 연결(Review Focus 2)", () => {
  let server: Server;
  let port: number;
  let stats: HookStats;
  beforeEach(async () => {
    setLogger(new Logger({ dir: "" }));
    stats = new HookStats();
    const snap = makeSnapshot({});
    // 언제나 다른 uid로 보이게 — /hooks/event·/api·화면 모두 같은 미들웨어에 걸리는지
    server = createApp({ current: () => snap, subscribe: () => () => {}, poke: () => {} }, { stats, sameUser: { platform: "linux", uid: 1000, read: () => HEAD } }).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const send = (path: string, method: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const body = method === "POST" ? "{}" : undefined;
      const req = request({ host: "127.0.0.1", port, path, method, headers: { Host: `127.0.0.1:${port}`, ...(body ? { "Content-Type": "application/json", "Content-Length": "2" } : {}), ...headers } }, (res) => {
        let t = "";
        res.on("data", (d) => (t += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: t }));
      });
      req.on("error", reject);
      req.end(body);
    });

  it("hook·/api·화면 모두 403 + 본문, 403-uid만 세고 기존 403·415와 두 번 세지 않는다. Host 검사가 먼저다", async () => {
    for (const [p, m] of [["/hooks/event", "POST"], ["/api/snapshot", "GET"], ["/", "GET"]] as const) expect(await send(p, m)).toEqual({ status: 403, body: UID_REJECT_BODY });
    expect(stats.view().rejected).toEqual({ "403": 0, "415": 0, "413": 0, "400": 0, "403-uid": 3 });
    // Host가 틀리면 Host 검사가 먼저 답한다(403, uid 검사·셈 없음)
    expect((await send("/hooks/event", "POST", { Host: "evil.example" })).status).toBe(403);
    expect(stats.view().rejected).toEqual({ "403": 1, "415": 0, "413": 0, "400": 0, "403-uid": 3 });
  });
});
