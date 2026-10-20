import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HOOK_V2, ReplayWindow, deriveKeys, openRequest, sealResponse } from "../../server/hooks/v2";

// Phase 6a §3: relay를 자식 프로세스로 띄우고, 테스트가 띄운 가짜 대시보드와 주고받는다
const ROOT = join(__dirname, "../..");
const RELAY = join(ROOT, "plugins/claude-office/hooks/relay.cjs");
const KEY = "cd".repeat(32); // 가짜 열쇠
const MARK = "PLAINTEXT_MARK_7f3a"; // 평문 표지: 가짜 서버가 받은 바이트에 나오면 안 된다
const keys = deriveKeys(Buffer.from(KEY, "hex"));

let dir: string;
let keyFile: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "co-relay-"));
  keyFile = join(dir, "hook.key");
  writeFileSync(keyFile, KEY, { mode: 0o600 });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Mode = (o: { id: string; event: Record<string, unknown> }) => { status?: number; body?: string; out?: unknown; id?: string; flip?: boolean; hold?: boolean };
let server: Server | undefined;
let got: { bytes: string; opened?: ReturnType<typeof openRequest>; halfClosedBeforeReply: boolean }[] = [];
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
  got = [];
});

/** 가짜 대시보드. 실제 서버 모듈로 풀고(계약 대조), mode가 답을 정한다. impostor면 풀지 않고 받은 바이트만 적는다 */
async function dashboard(mode: Mode, o: { impostor?: string; holdMs?: number } = {}) {
  const seen = new ReplayWindow();
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    let ended = false;
    req.socket.on("end", () => (ended = true));
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const rec: (typeof got)[number] = { bytes: `${req.method} ${req.url}\n${JSON.stringify(req.headers)}\n${raw}`, halfClosedBeforeReply: false };
      got.push(rec);
      if (o.impostor !== undefined) return void res.end(o.impostor);
      const opened = openRequest(JSON.parse(raw), keys, Date.now(), seen);
      rec.opened = opened;
      if (!opened.ok) return void res.writeHead(401).end();
      const m = mode({ id: opened.id, event: opened.event });
      const reply = () => {
        rec.halfClosedBeforeReply = ended;
        if (m.status && m.status !== 200) return void res.writeHead(m.status).end();
        if (m.body !== undefined) return void res.end(m.body);
        const sealed = sealResponse(m.id ?? opened.id, m.out ?? null, keys);
        if (m.flip) sealed.ct = Buffer.from(Buffer.from(sealed.ct, "base64").map((b, i) => (i === 0 ? b ^ 1 : b))).toString("base64");
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(sealed));
      };
      if (m.hold) return; // 답하지 않는다
      if (o.holdMs) setTimeout(reply, o.holdMs);
      else reply();
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return (server.address() as AddressInfo).port;
}

const ev = (name: string, extra: object = {}) => ({ session_id: "s1", hook_event_name: name, tool_name: "Bash", tool_input: { command: `echo ${MARK}` }, ...extra });
/** relay를 띄우고 끝날 때까지 기다린다(같은 프로세스의 가짜 대시보드가 답할 수 있게 spawnSync는 쓰지 않는다) */
function run(port: number | string, event: unknown, o: { key?: string; env?: Record<string, string>; raw?: string } = {}) {
  const c = spawn(process.execPath, [RELAY, o.key ?? keyFile, String(port)], { env: { PATH: process.env.PATH ?? "", ...o.env }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  c.stdout.on("data", (d) => (stdout += d));
  c.stderr.on("data", (d) => (stderr += d));
  c.stdin.on("error", () => {}); // 상한을 넘긴 입력을 relay가 다 읽지 않고 끝내면 EPIPE
  c.stdin.end(o.raw ?? JSON.stringify(event));
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((r) => c.on("exit", (code, signal) => r({ code, signal, stdout, stderr })));
}
function runAsync(port: number, event: unknown, env: Record<string, string> = {}) {
  const c = spawn(process.execPath, [RELAY, keyFile, String(port)], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  c.stdout.on("data", (d) => (stdout += d));
  c.stdin.end(JSON.stringify(event));
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string }>((r) => c.on("exit", (code, signal) => r({ code, signal, stdout })));
  return { child: c, done };
}
const silent = (r: { code: number | null; stdout: string }) => expect({ code: r.code, stdout: r.stdout }).toEqual({ code: 0, stdout: "" });
const relayLog = () => (existsSync(join(dir, "logs/relay.log")) ? readFileSync(join(dir, "logs/relay.log"), "utf8") : "");
const until = async (f: () => boolean, ms = 5000) => {
  const t = Date.now();
  while (!f()) {
    if (Date.now() - t > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("relay 계약(B292)", () => {
  it("HKDF info·필드 이름이 서버 HOOK_V2와 같고, PLUGIN_VERSION은 package.json 버전", () => {
    const relay = createRequire(import.meta.url)(RELAY) as { C: Record<string, unknown>; PLUGIN_VERSION: string };
    expect(relay.C).toEqual({ infoReq: HOOK_V2.infoReq, infoRes: HOOK_V2.infoRes, body: [...HOOK_V2.body], plain: [...HOOK_V2.plain], reply: [...HOOK_V2.reply] });
    expect(relay.PLUGIN_VERSION).toBe(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version);
  });
});

describe("relay 정상 경로", () => {
  it("서버 답을 그대로 stdout에, exit 0. 서버는 평문의 plugin을 받는다", async () => {
    const out = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "휴업" } };
    const port = await dashboard(() => ({ out }));
    const r = await run(port, ev("PreToolUse"));
    expect({ code: r.code, stdout: JSON.parse(r.stdout) }).toEqual({ code: 0, stdout: out });
    expect(r.stderr).toBe("");
    expect(got[0].opened).toMatchObject({ ok: true, plugin: expect.stringMatching(/^2\.0\.0/), event: { tool_input: { command: `echo ${MARK}` } } });
  });

  it("out이 null이면 무출력", async () => {
    const port = await dashboard(() => ({ out: null }));
    silent(await run(port, ev("PostToolUse")));
  });

  it("응답을 다 받을 때까지 쓰기 쪽을 닫지 않는다(half-close 금지)", async () => {
    const port = await dashboard(() => ({ out: null }), { holdMs: 150 });
    silent(await run(port, ev("PermissionRequest")));
    expect(got[0].halfClosedBeforeReply).toBe(false);
  });
});

describe("relay 실패는 모두 무출력 exit 0", () => {
  it("대시보드 꺼짐: 곧바로 끝나고 relay.log도 남기지 않는다", async () => {
    const port = await dashboard(() => ({}));
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    const before = relayLog();
    const t = Date.now();
    silent(await run(port, ev("PreToolUse")));
    expect(Date.now() - t).toBeLessThan(3000);
    expect(relayLog()).toBe(before);
  });

  it("가짜 서버(열쇠 모름): 무출력, 받은 바이트에 평문 표지·세션 id·열쇠가 없다", async () => {
    const port = await dashboard(() => ({}), { impostor: JSON.stringify({ iv: "0".repeat(24), ct: "AAAA", tag: "0".repeat(32) }) });
    silent(await run(port, ev("PreToolUse", { session_id: "SESSION_MARK_1" })));
    expect(got).toHaveLength(1);
    for (const s of [MARK, "SESSION_MARK_1", KEY, "PreToolUse"]) expect(got[0].bytes).not.toContain(s);
  });

  it("응답 1비트 변조·id 불일치·200이 아닌 상태·JSON 아닌 본문 → 무출력(relay.log에 한 단어)", async () => {
    const out = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
    for (const m of [() => ({ out, flip: true }), () => ({ out, id: "0".repeat(32) }), () => ({ status: 401 }), () => ({ body: "not json" })] as Mode[]) {
      const port = await dashboard(m);
      silent(await run(port, ev("PreToolUse")));
      await new Promise<void>((r) => server!.close(() => r()));
      server = undefined;
    }
    const log = relayLog();
    expect(log).toMatch(/decrypt/);
    expect(log).not.toContain(MARK);
    expect(log).not.toContain(KEY);
  });

  it("hookEventName이 받은 이벤트와 다르거나, hookSpecificOutput 밖의 최상위 키가 있으면 무출력", async () => {
    let out: unknown = { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } };
    const port = await dashboard(() => ({ out }));
    silent(await run(port, ev("PreToolUse")));
    // 최상위 키는 hookSpecificOutput 하나만(서버가 만드는 것 — 옛 decision 형식·문맥 전달 키를 닫는다)
    for (const o of [{ continue: false, stopReason: "x" }, { decision: "approve" }, { decision: "block", reason: "INJECT" }, { systemMessage: "x" }, { suppressOutput: true }, { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" }, reason: "x" }]) {
      out = o;
      silent(await run(port, ev("PreToolUse")));
    }
  });

  it("문맥 주입·멈춤 이벤트 5종은 out이 와도 쓰지 않는다", async () => {
    const port = await dashboard(({ event }) => ({ out: { hookSpecificOutput: { hookEventName: event.hook_event_name, additionalContext: "INJECT" }, decision: "block", reason: "x" } }));
    for (const n of ["UserPromptSubmit", "SessionStart", "Stop", "SubagentStop", "TeammateIdle"]) silent(await run(port, ev(n)));
    expect(got).toHaveLength(5); // 보내기는 한다(대시보드 표시)
  });

  it.skipIf(process.platform === "win32")("열쇠 파일이 0644·없음·형식 틀림이면 보내지도 않는다", async () => {
    const port = await dashboard(() => ({ out: null }));
    const wide = join(dir, "wide.key");
    writeFileSync(wide, KEY);
    chmodSync(wide, 0o644);
    const bad = join(dir, "bad.key");
    writeFileSync(bad, "short", { mode: 0o600 });
    for (const k of [wide, join(dir, "none.key"), bad]) silent(await run(port, ev("PreToolUse"), { key: k }));
    expect(got).toHaveLength(0);
  });

  it("stdin이 1MB(바이트)를 넘거나 JSON이 아니면 보내지도 않는다. 1MB 안이면 보낸다", async () => {
    const port = await dashboard(() => ({ out: null }));
    silent(await run(port, null, { raw: JSON.stringify(ev("PreToolUse", { pad: "가".repeat(350 * 1024) })) })); // 글자 35만 개 = 1MB 넘는 바이트
    silent(await run(port, null, { raw: "{broken" }));
    silent(await run(port, null, { raw: JSON.stringify({ no: "name" }) }));
    expect(got).toHaveLength(0);
    silent(await run(port, ev("PreToolUse", { pad: "x".repeat(1000 * 1024) })));
    expect(got).toHaveLength(1);
    expect(got[0].opened?.ok).toBe(true); // 서버 상한(1.5MB) 안
  });

  it("대기 한도를 넘으면 무출력으로 끝난다", async () => {
    const port = await dashboard(() => ({ hold: true }));
    const t = Date.now();
    silent(await run(port, ev("PermissionRequest"), { env: { CLAUDE_OFFICE_RELAY_WAIT_MS: "300" } }));
    expect(Date.now() - t).toBeLessThan(3000);
  });

  it("기다리는 중 SIGTERM·SIGINT·SIGHUP을 받으면 exit 0, 무출력", async () => {
    const port = await dashboard(() => ({ hold: true }));
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
      const n = got.length;
      const { child, done } = runAsync(port, ev("PermissionRequest"));
      await until(() => got.length > n);
      child.kill(sig);
      expect(await done, sig).toEqual({ code: 0, signal: null, stdout: "" });
    }
  });
});

describe("relay 지연 회귀", () => {
  it("웜 10회 중앙값이 200ms 미만(로컬 기대 약 33ms/회)", async () => {
    const port = await dashboard(() => ({ out: null }));
    await run(port, ev("PreToolUse"));
    const ts: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t = performance.now();
      await run(port, ev("PreToolUse"));
      ts.push(performance.now() - t);
    }
    ts.sort((a, b) => a - b);
    expect(ts[5]).toBeLessThan(200);
  });
});
