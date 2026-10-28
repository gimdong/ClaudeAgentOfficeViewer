import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(__dirname, "../../plugins/claude-office/channel/server.mjs");
const KEY = "ab".repeat(32);
const FAKE_MSG_TOKEN = "fake-messaging-token-should-never-leave";

let child: ChildProcess | undefined;
let server: Server | undefined;
let keyDir: string | undefined;
/** 대시보드처럼 열쇠를 0600 파일에 두고 그 경로만 넘긴다(B265) */
function keyFile() {
  keyDir = mkdtempSync(join(tmpdir(), "co-chkey-"));
  const f = join(keyDir, "co-1.key");
  writeFileSync(f, KEY, { mode: 0o600 });
  return f;
}
afterEach(async () => {
  if (keyDir) rmSync(keyDir, { recursive: true, force: true });
  keyDir = undefined;
  child?.kill();
  child = undefined;
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

const mac = (k: string, m: string) => createHmac("sha256", k).update(m).digest("hex");
const TEXT = 'say "hi" $(rm -rf /)\nline2';
type Mode = "good" | "no-proof" | "bad-proof" | "tamper" | "refuse";
/**
 * 가짜 대시보드(B257 핸드셰이크): good은 열쇠를 아는 진짜처럼 증명하고 MAC을 붙인다. no-proof·bad-proof는 열쇠를 모르는 가짜 서버,
 * tamper는 핸드셰이크는 그대로 중계하지만 지시 글을 바꾸는 중계자. 받은 요청은 모두 기록한다
 */
/** 이 channel 서버를 띄운 대화(가짜 값, CLAUDE_CODE_SESSION_ID) */
const CONV = "c0ffee00-0000-4000-8000-000000000001";
async function fakeDashboard(o: { mode?: Mode; onStream?: (res: ServerResponse, sk: string) => void } = {}) {
  const mode = o.mode ?? "good";
  const seen: Array<{ url: string; auth?: string; body: string; headers: IncomingMessage["headers"] }> = [];
  const nonces = new Map<string, string>();
  let streams = 0;
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", auth: req.headers.authorization, body, headers: req.headers });
      if (req.url === "/channel/hello") {
        const { nonce, conv } = JSON.parse(body);
        if (mode === "refuse") return void res.writeHead(403, { "Content-Type": "application/json" }).end(JSON.stringify({ reason: "conv-mismatch" }));
        const snonce = randomBytes(32).toString("hex");
        nonces.set(snonce, `${nonce}|${snonce}|${conv}`);
        const proof = mode === "no-proof" ? undefined : mode === "bad-proof" ? randomBytes(32).toString("hex") : mac(KEY, `server|${nonce}|${snonce}|${conv}`);
        res.end(JSON.stringify({ snonce, proof }));
      } else if (req.url === "/channel/stream") {
        streams++;
        const [, , snonce] = (req.headers.authorization ?? "").split(" ");
        const sk = mac(KEY, `session|${nonces.get(snonce)}`);
        res.writeHead(200, { "Content-Type": "text/event-stream", "X-Office-Ack": "f".repeat(64) });
        const text = mode === "tamper" ? "rm -rf ~" : TEXT;
        (o.onStream ?? ((r) => r.write(`event: instruction\ndata: ${JSON.stringify({ id: "i1", text, mac: mac(sk, JSON.stringify(["i1", TEXT])) })}\n\n`)))(res, sk);
      } else res.end("{}");
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return { port: (server.address() as AddressInfo).port, seen, streams: () => streams };
}

function start(env: Record<string, string>) {
  const out: string[] = [];
  child = spawn(process.execPath, [SCRIPT], { env: { PATH: process.env.PATH ?? "", CLAUDE_CODE_MESSAGING_TOKEN: FAKE_MSG_TOKEN, CLAUDE_CODE_SESSION_ID: CONV, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  child.stdout!.on("data", (d) => {
    buf += String(d);
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      out.push(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  const write = (m: object) => child!.stdin!.write(JSON.stringify(m) + "\n");
  write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  write({ jsonrpc: "2.0", method: "notifications/initialized" });
  return out;
}
const until = async (f: () => boolean, ms = 4000) => {
  const t = Date.now();
  while (!f()) {
    if (Date.now() - t > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("channel 서버(Phase 4b 스펙 5장)", () => {
  it("열쇠가 없으면 대시보드에 연결하지 않고, channel 능력·안내 문구도 내지 않는다", async () => {
    const d = await fakeDashboard();
    const out = start({ CLAUDE_OFFICE_PORT: String(d.port) });
    await until(() => out.length >= 1);
    await new Promise((r) => setTimeout(r, 400));
    expect(d.seen).toEqual([]);
    const init = JSON.parse(out[0]).result;
    expect(init.protocolVersion).toBe("2025-11-25");
    expect(init.capabilities.experimental).toBeUndefined();
    expect(init.instructions).toBeUndefined();
    expect(out).toHaveLength(1);
  });

  it("beta.23 설계 7.2: hello가 403(이 열쇠는 이 대화의 것이 아님)이면 다시 시도하지 않는다. hello에 자기 대화 id를 밝힌다", async () => {
    const d = await fakeDashboard({ mode: "refuse" });
    start({ CLAUDE_OFFICE_PORT: String(d.port), CLAUDE_OFFICE_FLOOR_KEY_FILE: keyFile() });
    await until(() => d.seen.length >= 1);
    await new Promise((r) => setTimeout(r, 2_500));
    expect(d.seen.map((s) => s.url)).toEqual(["/channel/hello"]);
    expect(JSON.parse(d.seen[0].body).conv).toBe(CONV);
  });

  it("security 6: 열쇠 파일 없이 환경(옛 이름)에만 열쇠가 있으면 연결하지 않는다 — 데몬이 물려준 원문으로 붙지 않게", async () => {
    const d = await fakeDashboard();
    start({ CLAUDE_OFFICE_PORT: String(d.port), CLAUDE_OFFICE_FLOOR_KEY: KEY });
    await new Promise((r) => setTimeout(r, 800));
    expect(d.seen).toEqual([]);
  });

  it("열쇠가 있으면 SSE로 받은 지시를 그대로 channel 알림으로 넣고 ack를 보낸다. 메시징 토큰은 어디에도 보내지 않는다", async () => {
    const d = await fakeDashboard();
    const out = start({ CLAUDE_OFFICE_PORT: String(d.port), CLAUDE_OFFICE_FLOOR_KEY_FILE: keyFile() });
    await until(() => d.seen.some((s) => s.url === "/channel/ack"));
    const init = JSON.parse(out[0]).result;
    expect(init.capabilities.experimental).toEqual({ "claude/channel": {} });
    const note = out.map((l) => JSON.parse(l)).find((m) => m.method === "notifications/claude/channel");
    expect(note.params.content).toBe(TEXT);
    expect(d.seen.map((s) => s.url).slice(0, 3)).toEqual(["/channel/hello", "/channel/stream", "/channel/ack"]);
    const ack = d.seen.find((s) => s.url === "/channel/ack")!;
    expect(ack.auth).toBe(`Ack ${"f".repeat(64)}`);
    expect(JSON.parse(ack.body)).toEqual({ id: "i1" });
    expect(JSON.stringify(d.seen)).not.toContain(KEY);
    const leaked = d.seen.some((s) => JSON.stringify(s).includes(FAKE_MSG_TOKEN)) || out.some((l) => l.includes(FAKE_MSG_TOKEN));
    expect(leaked).toBe(false);
  });

  it("스트림이 끊기면 다시 잇는다", async () => {
    let n = 0;
    const d = await fakeDashboard({
      onStream: (res) => {
        n++;
        res.end();
      },
    });
    start({ CLAUDE_OFFICE_PORT: String(d.port), CLAUDE_OFFICE_FLOOR_KEY_FILE: keyFile() });
    await until(() => n >= 2, 5000);
  });

  for (const mode of ["no-proof", "bad-proof"] as const) {
    it(`가짜 서버(${mode})면 스트림을 열지 않고 지시 0, 열쇠 원문은 어떤 요청에도 없고, 새 nonce로 다시 시도한다`, async () => {
      const d = await fakeDashboard({ mode });
      const out = start({ CLAUDE_OFFICE_PORT: String(d.port), CLAUDE_OFFICE_FLOOR_KEY_FILE: keyFile() });
      await until(() => d.seen.filter((s) => s.url === "/channel/hello").length >= 2, 5000);
      expect(d.streams()).toBe(0);
      expect(out.some((l) => l.includes("notifications/claude/channel"))).toBe(false);
      expect(JSON.stringify(d.seen)).not.toContain(KEY);
      const [a, b] = d.seen.filter((s) => s.url === "/channel/hello").map((s) => JSON.parse(s.body));
      expect(a.kid).toBe(b.kid);
      expect(a.nonce).not.toBe(b.nonce);
      expect(a.nonce).toMatch(/^[0-9a-f]{64}$/);
    });
  }

  it("중계자가 지시 글을 바꾸면(MAC 불일치) 넣지 않고 ack도 없이 연결을 끊고 다시 잇는다", async () => {
    const d = await fakeDashboard({ mode: "tamper" });
    const out = start({ CLAUDE_OFFICE_PORT: String(d.port), CLAUDE_OFFICE_FLOOR_KEY_FILE: keyFile() });
    await until(() => d.streams() >= 2, 5000);
    expect(out.some((l) => l.includes("notifications/claude/channel"))).toBe(false);
    expect(d.seen.some((s) => s.url === "/channel/ack")).toBe(false);
  });

  it("연결마다 본 id는 1000개까지만 기억한다(오래된 것부터 잊는다, B268 상한)", async () => {
    const ev = (sk: string, id: string) => `event: instruction\ndata: ${JSON.stringify({ id, text: id, mac: mac(sk, JSON.stringify([id, id])) })}\n\n`;
    const d = await fakeDashboard({
      onStream: (res, sk) => {
        const ids = Array.from({ length: 1001 }, (_, i) => `i${i}`);
        res.write(ids.map((id) => ev(sk, id)).join("") + ev(sk, "i1000") + ev(sk, "i0"));
      },
    });
    const out = start({ CLAUDE_OFFICE_PORT: String(d.port), CLAUDE_OFFICE_FLOOR_KEY_FILE: keyFile() });
    const notes = () => out.filter((l) => l.includes("notifications/claude/channel")).map((l) => JSON.parse(l).params.content as string);
    await until(() => notes().length >= 1002, 8000);
    await new Promise((r) => setTimeout(r, 200));
    expect(notes().filter((t) => t === "i1000")).toHaveLength(1); // 최근 것은 다시 넣지 않는다
    expect(notes().filter((t) => t === "i0")).toHaveLength(2); // 가장 오래된 것은 잊었다
  }, 15_000);

  it("agent team 팀원 프로세스(부모 명령줄에 --agent-id)면 연결하지 않고 도구도 내지 않는다(Phase 6b 스펙 12장 g ①). 부모가 셸이면 그 위를 본다", async () => {
    const d = await fakeDashboard();
    const wrapper = join(keyDir ?? tmpdir(), "fake-claude.cjs");
    writeFileSync(wrapper, `require("child_process").spawn(process.execPath, [${JSON.stringify(SCRIPT)}], { stdio: "inherit" }).on("exit", (c) => process.exit(c ?? 0));`);
    const env = { PATH: process.env.PATH ?? "", CLAUDE_OFFICE_PORT: String(d.port), CLAUDE_OFFICE_FLOOR_KEY_FILE: keyFile() };
    for (const argv of [[wrapper, "--agent-id", "tester@team", "--agent-name", "tester", "--team-name", "team"], ["-e", `require("child_process").spawn("sh", ["-c", ${JSON.stringify(`exec "${process.execPath}" "${SCRIPT}"`)}], { stdio: "inherit" }).on("exit", (c) => process.exit(c ?? 0))`, "--", "--agent-id=tester@team", "--agent-name=tester", "--team-name=team"]]) {
      const c = spawn(process.execPath, argv, { env, stdio: ["pipe", "pipe", "pipe"] });
      const lines: string[] = [];
      c.stdout.on("data", (b) => lines.push(...String(b).split("\n").filter(Boolean)));
      c.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } } }) + "\n");
      c.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      c.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
      await until(() => lines.length >= 2);
      await new Promise((r) => setTimeout(r, 600));
      const msgs = lines.map((l) => JSON.parse(l));
      expect(msgs.find((m) => m.id === 1).result.capabilities.experimental, argv[0]).toBeUndefined();
      expect(msgs.find((m) => m.id === 2).result.tools).toEqual([]);
      c.kill();
    }
    expect(d.seen).toEqual([]);
    // 대조군: 세 인자가 다 있지 않으면(리드) 연결하고 도구 셋을 낸다 — 첫 지시·이름 글자에 "--agent-id"가 들어 있어도(security Minor-8)
    const lead = spawn(process.execPath, [wrapper, "--session-id", "s", "--name", "x --agent-id", "첫 지시 --agent-id y 를 보세요"], { env, stdio: ["pipe", "pipe", "pipe"] });
    const out: string[] = [];
    lead.stdout.on("data", (b) => out.push(...String(b).split("\n").filter(Boolean)));
    lead.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    lead.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    lead.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    await until(() => d.seen.length > 0);
    expect(out.map((l) => JSON.parse(l)).find((m) => m.id === 2).result.tools.map((t: { name: string }) => t.name).sort()).toEqual(["ask_user", "submit_handover", "submit_report"]);
    lead.kill();
  });

  it("stream이 409(같은 층에 리드 연결)면 멈추지 않고 2초에서 두 배씩 늘려 다시 시도한다(B321 M4)", async () => {
    const times: number[] = [];
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        if (req.url === "/channel/hello") {
          const { nonce, conv } = JSON.parse(body);
          const snonce = randomBytes(32).toString("hex");
          return void res.end(JSON.stringify({ snonce, proof: mac(KEY, `server|${nonce}|${snonce}|${conv}`) }));
        }
        if (req.url === "/channel/stream") times.push(Date.now());
        res.writeHead(409).end();
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    start({ CLAUDE_OFFICE_PORT: String((server.address() as AddressInfo).port), CLAUDE_OFFICE_FLOOR_KEY_FILE: keyFile() });
    await new Promise((r) => setTimeout(r, 7_500));
    // 고정 2초면 0·2·4·6초에 4번, 두 배씩이면 0·2·6초에 3번
    expect(times.length).toBe(3);
    expect(times[2] - times[1]).toBeGreaterThan(3_500);
  }, 15_000);

  it("process.env에서는 세 이름만 읽는다(코드 검사) — 옛 이름 CLAUDE_OFFICE_FLOOR_KEY(열쇠 원문)는 읽지 않는다", () => {
    const src = readFileSync(SCRIPT, "utf8");
    const names = [...src.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]);
    expect([...new Set(names)].sort()).toEqual(["CLAUDE_CODE_SESSION_ID", "CLAUDE_OFFICE_FLOOR_KEY_FILE", "CLAUDE_OFFICE_PORT"]);
    expect(/process\.env\[/.test(src) || /Object\.(keys|entries)\(process\.env\)/.test(src)).toBe(false);
  });

  it("플러그인 .mcp.json이 이 스크립트를 node로 띄운다", () => {
    const cfg = JSON.parse(readFileSync(join(__dirname, "../../plugins/claude-office/.mcp.json"), "utf8"));
    expect(cfg.mcpServers["office-channel"]).toEqual({ command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/channel/server.mjs"] });
  });
});
