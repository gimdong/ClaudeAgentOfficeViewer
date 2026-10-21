// Phase 6a 보안 회귀(Task 5): 암호화 command relay(plugins/claude-office/hooks/relay.cjs)와 진짜 서버(createApp + /hooks/v2)를 실제로 잇고,
// 그 사이에 가짜 서버·중계자를 끼운다. spike 시험 후보 12 + 13번, B294(재전송 창 기준 시각·창 안 id 가득 참·half-close).
// 열쇠·평문은 모두 가짜. 포트는 0(임의)
import { spawn, spawnSync } from "node:child_process";
import { createCipheriv, randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../server/app";
import { HOOK_V2, ReplayWindow, deriveKeys, openRequest, sealResponse, type HookKeys } from "../../server/hooks/v2";
import { makeSnapshot } from "../web/fixtures";

const ROOT = join(__dirname, "../..");
const RELAY = join(ROOT, "plugins/claude-office/hooks/relay.cjs");
const KEY = "a7".repeat(32);
const OTHER_KEY = "3c".repeat(32);
const MARK = "SEC_PLAINTEXT_MARK_51c2";
const keys = deriveKeys(Buffer.from(KEY, "hex"));

let dir: string;
let keyFile: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "co-sec-relay-"));
  keyFile = join(dir, "hook.key");
  writeFileSync(keyFile, KEY, { mode: 0o600 });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => (s.closeAllConnections(), s.close(() => r())))));
});
const listen = async (s: Server) => {
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return (s.address() as AddressInfo).port;
};
const readBody = (req: IncomingMessage) => new Promise<string>((r) => {
  let b = "";
  req.on("data", (d) => (b += d));
  req.on("end", () => r(b));
});
const send = (res: ServerResponse, status: number, body: string) => res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }).end(body);

/** 진짜 서버: PermissionRequest는 결정 큐 대신 held에 붙잡거나(answer 없음) answer로 바로 답한다 */
async function dashboard(o: { answer?: object; keys?: HookKeys | null } = {}) {
  const held: { res: { writableEnded: boolean }; closed: boolean }[] = [];
  const events: Record<string, unknown>[] = [];
  const app = createApp({ current: () => makeSnapshot(), subscribe: () => () => {} }, {
    hookV2: { keys: () => (o.keys === undefined ? keys : o.keys), seen: new ReplayWindow() },
    onHookEvent: (i) => void events.push(i),
    decisions: {
      hold: (_i, res) => {
        const h = { res, closed: false };
        held.push(h);
        res.on("close", () => (h.closed = !res.writableEnded));
        if (o.answer) res.status(200).json(o.answer);
        return null;
      },
      answer: () => ({ ok: false, status: 404 }),
      onEvent: () => {},
    },
  });
  const port = await listen(app.listen(0, "127.0.0.1"));
  return { port, held, events };
}

type Tap = (path: string, body: string) => string;
/** 중계자: 모든 요청을 target으로 넘기며 기록한다. req는 요청 본문을, res는 응답 본문을 바꿀 수 있다 */
async function relayProxy(target: number, o: { req?: Tap; res?: Tap; replace?: () => string | undefined } = {}) {
  const seen: string[] = [];
  const responses: string[] = [];
  const port = await listen(createServer(async (req, res) => {
    let body = await readBody(req);
    seen.push(`${req.method} ${req.url}\n${JSON.stringify(req.headers)}\n${body}`);
    const fixed = o.replace?.();
    if (fixed !== undefined) return void send(res, 200, fixed);
    if (o.req) body = o.req(req.url ?? "", body);
    const up = await new Promise<{ status: number; body: string }>((r, j) => {
      const x = request({ host: "127.0.0.1", port: target, path: req.url, method: "POST", agent: false, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (u) => {
        let t = "";
        u.on("data", (d) => (t += d));
        u.on("end", () => r({ status: u.statusCode ?? 0, body: t }));
      });
      x.on("error", j);
      x.end(body);
    }).catch(() => ({ status: 502, body: "" }));
    responses.push(up.body);
    send(res, up.status, o.res ? o.res(req.url ?? "", up.body) : up.body);
  }));
  return { port, seen, responses };
}

/** 열쇠를 모르는 가짜 서버 */
async function impostor(reply: (res: ServerResponse) => void) {
  const seen: string[] = [];
  const port = await listen(createServer(async (req, res) => {
    seen.push(`${req.method} ${req.url}\n${JSON.stringify(req.headers)}\n${await readBody(req)}`);
    reply(res);
  }));
  return { port, seen };
}

const ev = (name: string, extra: object = {}) => ({ session_id: "sec-s1", hook_event_name: name, tool_name: "Bash", tool_input: { command: `echo ${MARK}` }, ...extra });
function relay(port: number, event: unknown, o: { key?: string; raw?: string; env?: Record<string, string> } = {}) {
  const c = spawn(process.execPath, [RELAY, o.key ?? keyFile, String(port)], { env: { PATH: process.env.PATH ?? "", ...o.env }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  c.stdout.on("data", (d) => (stdout += d));
  c.stderr.on("data", (d) => (stderr += d));
  c.stdin.on("error", () => {});
  c.stdin.end(o.raw ?? JSON.stringify(event));
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((r) => c.on("exit", (code) => r({ code, stdout, stderr })));
  return { child: c, done };
}
const run = (port: number, event: unknown, o?: Parameters<typeof relay>[2]) => relay(port, event, o).done;
/** 안전한 실패: exit 0, stdout 0바이트, stderr 0바이트(경로·스택 없음) */
const expectSilent = (r: { code: number | null; stdout: string; stderr: string }) => expect(r).toEqual({ code: 0, stdout: "", stderr: "" });
const expectNoSecret = (seen: string[]) => {
  for (const s of seen) for (const bad of [MARK, "sec-s1", KEY]) expect(s).not.toContain(bad);
};
const relayLog = () => (existsSync(join(dir, "logs/relay.log")) ? readFileSync(join(dir, "logs/relay.log"), "utf8") : "");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 4000) => {
  const t = Date.now();
  while (!f() && Date.now() - t < ms) await wait(10);
};
const ALLOW = { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } };

/** 서버 입장의 요청 하나를 직접 만든다(재전송 창 시험용) */
function sealRequest(k: HookKeys, plain: object) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k.req, iv);
  c.setAAD(Buffer.from(k.kid));
  const ct = Buffer.concat([c.update(JSON.stringify(plain)), c.final()]);
  return { kid: k.kid, iv: iv.toString("hex"), ct: ct.toString("base64"), tag: c.getAuthTag().toString("hex") };
}

describe("대조군: 진짜 서버와 직접", () => {
  it("PermissionRequest 허용이 그대로 stdout에, 서버는 평문 이벤트를 받는다", async () => {
    const d = await dashboard({ answer: ALLOW });
    const r = await run(d.port, ev("PermissionRequest"));
    expect(r).toEqual({ code: 0, stdout: JSON.stringify(ALLOW), stderr: "" });
    expect(d.events.some((e) => JSON.stringify(e).includes(MARK))).toBe(true);
  });
});

describe("1. 가짜 서버(열쇠 모름)", () => {
  const cases: [string, (res: ServerResponse) => void][] = [
    ["401", (res) => res.writeHead(401).end()],
    ["404", (res) => res.writeHead(404).end()],
    ["200 쓰레기 JSON", (res) => send(res, 200, '{"iv":"x","ct":"y","tag":"z"}')],
    ["200 형식은 맞는 가짜 암호문", (res) => send(res, 200, JSON.stringify({ iv: "0".repeat(24), ct: Buffer.from("allow").toString("base64"), tag: "0".repeat(32) }))],
    ["200 평문 allow", (res) => send(res, 200, JSON.stringify(ALLOW))],
    ["연결 중 끊김", (res) => res.destroy()],
  ];
  for (const [name, reply] of cases) {
    it(`${name}: 무출력, 받은 바이트에 평문 표지·세션 id·열쇠 없음`, async () => {
      const f = await impostor(reply);
      expectSilent(await run(f.port, ev("PermissionRequest")));
      expect(f.seen).toHaveLength(1);
      expectNoSecret(f.seen);
    });
  }
});

describe("2·3. 중계자 변조", () => {
  const flip = (field: "ct" | "tag", at = 0) => (_p: string, b: string) => {
    const o = JSON.parse(b);
    const buf = field === "ct" ? Buffer.from(o.ct, "base64") : Buffer.from(o.tag, "hex");
    buf[at] ^= 1;
    o[field] = field === "ct" ? buf.toString("base64") : buf.toString("hex");
    return JSON.stringify(o);
  };

  it("중계자는 평문을 볼 수 없다(요청·응답 어디에도 표지·세션 id 없음)", async () => {
    const d = await dashboard({ answer: ALLOW });
    const m = await relayProxy(d.port);
    expect((await run(m.port, ev("PermissionRequest"))).stdout).toBe(JSON.stringify(ALLOW));
    expectNoSecret([...m.seen, ...m.responses]);
  });

  for (const [name, tap] of [["요청 암호문 1비트", flip("ct")], ["요청 태그 1비트", flip("tag")], ["요청 kid 바꿈", (_p: string, b: string) => JSON.stringify({ ...JSON.parse(b), kid: "0".repeat(16) })]] as const) {
    it(`${name}: 서버 401, 이벤트 처리 0건, relay 무출력`, async () => {
      const d = await dashboard({ answer: ALLOW });
      const m = await relayProxy(d.port, { req: tap });
      expectSilent(await run(m.port, ev("PermissionRequest")));
      expect(d.events).toEqual([]);
      expect(d.held).toEqual([]);
    });
  }

  for (const [name, tap] of [["응답 암호문 1비트", flip("ct")], ["응답 태그 1비트", flip("tag", 15)]] as const) {
    it(`${name}: relay 무출력`, async () => {
      const d = await dashboard({ answer: ALLOW });
      const m = await relayProxy(d.port, { res: tap });
      expectSilent(await run(m.port, ev("PermissionRequest")));
    });
  }
});

describe("4. 재전송", () => {
  it("지난 호출의 응답을 새 호출에 돌려주면 무출력(응답이 요청 id에 묶임)", async () => {
    const d = await dashboard({ answer: ALLOW });
    let saved: string | undefined;
    let replay = false;
    const m = await relayProxy(d.port, { res: (_p, b) => (saved ??= b), replace: () => (replay ? saved : undefined) });
    expect((await run(m.port, ev("PermissionRequest"))).stdout).toBe(JSON.stringify(ALLOW));
    replay = true;
    expectSilent(await run(m.port, ev("PermissionRequest")));
  });

  it("같은 요청을 서버에 다시 보내면 401, 처리는 한 번", async () => {
    const d = await dashboard({ answer: ALLOW });
    const m = await relayProxy(d.port);
    await run(m.port, ev("PermissionRequest"));
    const body = m.seen[0].split("\n").slice(2).join("\n");
    const again = await fetch(`http://127.0.0.1:${d.port}/hooks/v2`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    expect(again.status).toBe(401);
    expect(await again.text()).toBe("");
    expect(d.held).toHaveLength(1);
  });

  it("B294: ts가 미래 +2초면 받고 +3초면 401. +2초로 받은 id는 31초 뒤 재전송해도 401(기준 = max(ts, 받은 시각))", () => {
    const t0 = 1_800_000_000_000;
    const seen = new ReplayWindow();
    const req = (id: string, ts: number) => sealRequest(keys, { v: 1, id, ts, plugin: "t", event: ev("PreToolUse") });
    const idA = "a".repeat(32);
    const a = req(idA, t0 + 2_000);
    expect(openRequest(a, keys, t0, seen).ok).toBe(true);
    expect(openRequest(req("b".repeat(32), t0 + 3_000), keys, t0, seen)).toEqual({ ok: false, reason: "ts" });
    // t0+31초: |now - ts| = 29초라 ts 검사는 통과한다. id 기억(ts+30초 = t0+32초)이 막아야 한다
    expect(openRequest(a, keys, t0 + 31_000, seen)).toEqual({ ok: false, reason: "replay" });
    // 창 밖(ts보다 30초 넘게 지남)은 ts 검사가 막는다
    expect(openRequest(a, keys, t0 + 32_500, seen)).toEqual({ ok: false, reason: "ts" });
  });

  it("B294: 창 안의 id로 가득 차면 새 요청은 401이고, 기억한 id를 버리지 않는다. 창이 지나면 다시 받는다", () => {
    const t0 = 1_800_000_000_000;
    const seen = new ReplayWindow();
    const first = "f".repeat(32);
    expect(seen.add(first, t0, t0)).toBe(true);
    for (let i = 1; i < HOOK_V2.maxSeen; i++) seen.add(i.toString(16).padStart(32, "0"), t0, t0);
    expect(seen.size()).toBe(HOOK_V2.maxSeen);
    expect(openRequest(sealRequest(keys, { v: 1, id: "e".repeat(32), ts: t0 + 1000, plugin: "t", event: ev("PreToolUse") }), keys, t0 + 1000, seen)).toEqual({ ok: false, reason: "replay" });
    expect(seen.add(first, t0, t0 + 1000)).toBe(false); // 가장 오래된 것도 그대로 기억
    expect(seen.add("e".repeat(32), t0 + 31_000, t0 + 31_000)).toBe(true); // 창이 지나면 자리가 난다
  });
});

describe("5. 응답 이벤트 검사·문맥 주입 이벤트", () => {
  it("hookEventName이 다르거나 hookSpecificOutput 밖의 최상위 키가 있으면 무출력", async () => {
    for (const answer of [
      { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } },
      { ...ALLOW, decision: "approve" },
      { decision: "approve" },
      { continue: false, stopReason: "x" },
    ]) {
      const d = await dashboard({ answer });
      expectSilent(await run(d.port, ev("PermissionRequest")));
    }
  });

  it("UserPromptSubmit·SessionStart·Stop·SubagentStop·TeammateIdle은 열쇠를 아는 서버가 답을 보내도 무출력", async () => {
    // 진짜 처리기는 이 이벤트들에 답을 만들지 않으므로, 같은 열쇠로 답을 만드는 서버(서버 버그·변경 대비)를 쓴다
    for (const name of ["UserPromptSubmit", "SessionStart", "Stop", "SubagentStop", "TeammateIdle"]) {
      const out = { hookSpecificOutput: { hookEventName: name, additionalContext: MARK } };
      const seen = new ReplayWindow();
      const port = await listen(createServer(async (req, res) => {
        const o = openRequest(JSON.parse(await readBody(req)), keys, Date.now(), seen);
        if (!o.ok) return void res.writeHead(401).end();
        send(res, 200, JSON.stringify(sealResponse(o.id, out, keys)));
      }));
      expectSilent(await run(port, ev(name, { prompt: "p" })));
    }
  });
});

describe("6. 오류 경로: 모두 exit 0, stdout·stderr 0바이트", () => {
  it("열쇠 파일 없음·0644·잘린 열쇠·hex 아님·폴더", async () => {
    const d = await dashboard({ answer: ALLOW });
    const bad = (name: string, content: string | null, mode = 0o600) => {
      const f = join(dir, name);
      if (content !== null) {
        writeFileSync(f, content, { mode });
        chmodSync(f, mode);
      }
      return f;
    };
    for (const key of [bad("none.key", null), bad("wide.key", KEY, 0o644), bad("group.key", KEY, 0o640), bad("short.key", KEY.slice(0, 63)), bad("nothex.key", "z".repeat(64)), dir]) {
      expectSilent(await run(d.port, ev("PermissionRequest"), { key }));
    }
    expect(d.held).toEqual([]);
  });

  it("잘못된 stdin(JSON 아님·배열·이벤트 이름 없음·빈 입력)", async () => {
    const d = await dashboard({ answer: ALLOW });
    for (const raw of ["{not json", "[]", '{"session_id":"x"}', "", "null"]) expectSilent(await run(d.port, null, { raw }));
    expect(d.events).toEqual([]);
  });

  it("크기는 바이트로 센다: 한글 1MB 초과는 보내지도 않고, 1MB 바로 안은 서버(1.5MB)가 받는다", async () => {
    const d = await dashboard({ answer: ALLOW });
    const m = await relayProxy(d.port);
    const big = (bytes: number) => JSON.stringify(ev("PermissionRequest", { tool_input: { command: "가".repeat(Math.floor(bytes / 3)) } }));
    const over = big(1024 * 1024 + 300); // 글자 수는 약 35만(1MB 아래)이지만 바이트는 1MB 초과
    expect(over.length).toBeLessThan(1024 * 1024);
    expect(Buffer.byteLength(over)).toBeGreaterThan(1024 * 1024);
    expectSilent(await run(m.port, null, { raw: over }));
    expect(m.seen).toEqual([]);
    const under = big(1024 * 1024 - 2000);
    expect(Buffer.byteLength(under)).toBeLessThanOrEqual(1024 * 1024);
    expect((await run(m.port, null, { raw: under })).stdout).toBe(JSON.stringify(ALLOW));
    expect(d.held).toHaveLength(1);
  });

  it("대시보드 꺼짐(연결 거부)은 relay.log를 남기지 않고, 가짜 서버(복호화 실패)는 한 단어만 남긴다(0600, 비밀 없음)", async () => {
    rmSync(join(dir, "logs"), { recursive: true, force: true });
    const closed = await listen(createServer());
    servers.pop()!.close();
    await wait(50);
    expectSilent(await run(closed, ev("PermissionRequest")));
    expect(relayLog()).toBe("");
    const f = await impostor((res) => send(res, 200, JSON.stringify({ iv: "0".repeat(24), ct: "", tag: "0".repeat(32) })));
    expectSilent(await run(f.port, ev("PermissionRequest")));
    const log = relayLog();
    expect(log.trim().split("\n")).toHaveLength(1);
    expect(log).toMatch(/^\S+ decrypt\n$/);
    for (const bad of [MARK, "sec-s1", KEY, keys.kid]) expect(log).not.toContain(bad);
    if (process.platform !== "win32") expect(statSync(join(dir, "logs/relay.log")).mode & 0o777).toBe(0o600);
  });
});

describe("7. half-close·신호(B294)", () => {
  it("PermissionRequest를 기다리는 동안 relay가 살아 있으면 서버 결정은 닫히지 않고, SIGTERM으로 끝나면 닫힌다(exit 0·무출력)", async () => {
    const d = await dashboard();
    const r = relay(d.port, ev("PermissionRequest"));
    await until(() => d.held.length === 1);
    expect(d.held).toHaveLength(1);
    await wait(500);
    expect(d.held[0].closed).toBe(false);
    r.child.kill("SIGTERM");
    expectSilent(await r.done);
    await until(() => d.held[0].closed);
    expect(d.held[0].closed).toBe(true);
  });
});

describe("8. exit 1·2를 쓰지 않는다", () => {
  it("relay 소스에 exit(1)·exit(2)·exitCode 대입·stderr 쓰기가 없다", () => {
    const src = readFileSync(RELAY, "utf8");
    expect(src).not.toMatch(/process\.exit\(\s*[12]\s*\)/);
    expect(src).not.toMatch(/exitCode\s*=/);
    expect(src).not.toMatch(/process\.stderr|console\./);
  });
});

describe("10. 열쇠 파일이 rename으로 바뀌는 중에도", () => {
  it("relay는 맞는 답이거나 무출력이고, 반쯤 읽은 열쇠로 쓰지 않는다", async () => {
    const d = await dashboard({ answer: ALLOW });
    const rot = join(dir, "rot.key");
    writeFileSync(rot, KEY, { mode: 0o600 });
    let stop = false;
    const swap = (async () => {
      let i = 0;
      while (!stop) {
        const tmp = join(dir, `rot.tmp${i}`);
        writeFileSync(tmp, i++ % 2 ? KEY : OTHER_KEY, { mode: 0o600, flag: "wx" });
        renameSync(tmp, rot);
        await wait(1);
      }
    })();
    const results = await Promise.all(Array.from({ length: 30 }, () => run(d.port, ev("PermissionRequest"), { key: rot })));
    stop = true;
    await swap;
    for (const r of results) {
      expect(r.code).toBe(0);
      expect(r.stderr).toBe("");
      expect(["", JSON.stringify(ALLOW)]).toContain(r.stdout);
    }
  });
});

describe("13. hooks.json(저장소 원본)", () => {
  it("13개 이벤트 모두 command·exec form(args), command는 자리 표시자(맨 node 아님), onFailure 없음", () => {
    const h = JSON.parse(readFileSync(join(ROOT, "plugins/claude-office/hooks/hooks.json"), "utf8")).hooks as Record<string, { hooks: Record<string, unknown>[] }[]>;
    const names = ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "PermissionDenied", "Notification", "SubagentStart", "SubagentStop", "TeammateIdle", "Stop"];
    expect(Object.keys(h).sort()).toEqual([...names].sort());
    for (const n of names) {
      for (const g of h[n]) {
        for (const x of g.hooks) {
          expect(x.type, n).toBe("command");
          expect(x.command, n).toBe("__NODE__");
          expect(x.args, n).toEqual(["${CLAUDE_PLUGIN_ROOT}/hooks/relay.cjs", "__KEYFILE__"]);
          expect(x, n).not.toHaveProperty("onFailure");
          expect(x, n).not.toHaveProperty("url");
          expect(x.timeout, n).toBe(n === "PermissionRequest" ? 600 : 10);
        }
      }
    }
  });
});

describe("11. 설치본 hooks.json의 node 절대 경로(packaging/fill-hooks.cjs)", () => {
  const FILL = join(ROOT, "packaging/fill-hooks.cjs");
  /** 저장소 원본을 임시 플러그인 폴더로 복사하고 설치 스크립트처럼 채운다 */
  function filled(keyPath: string) {
    const plug = mkdtempSync(join(tmpdir(), "co-sec-plug-"));
    mkdirSync(join(plug, "hooks"), { recursive: true });
    copyFileSync(RELAY, join(plug, "hooks/relay.cjs"));
    const hooks = join(plug, "hooks/hooks.json");
    copyFileSync(join(ROOT, "plugins/claude-office/hooks/hooks.json"), hooks);
    const r = spawnSync(process.execPath, [FILL, hooks, keyPath], { encoding: "utf8" });
    return { plug, hooks, r };
  }
  /** Claude Code의 exec form처럼: 셸 없이 command를 args로, cwd는 프로젝트 폴더. ${CLAUDE_PLUGIN_ROOT}는 플러그인 폴더 */
  function execForm(h: { command: string; args: string[] }, plug: string, cwd: string, path: string, input: string) {
    return spawnSync(h.command, h.args.map((a) => a.replace("${CLAUDE_PLUGIN_ROOT}", plug)), { cwd, input, encoding: "utf8", env: { PATH: path, CLAUDE_PLUGIN_ROOT: plug } });
  }
  const firstHook = (file: string) => (Object.values(JSON.parse(readFileSync(file, "utf8")).hooks) as { hooks: { command: string; args: string[] }[] }[][])[0][0].hooks[0];

  it("13개 모두 command = 설치한 node의 절대 경로(실행 가능), args = [relay, 열쇠 경로 그대로], 자리 표시자 0", () => {
    const keyPath = join(dir, "sp ace 'q\" key", "hook.key"); // 공백·따옴표가 있어도 JSON 값으로 들어간다
    const { plug, hooks, r } = filled(keyPath);
    try {
      expect(r.status).toBe(0);
      const text = readFileSync(hooks, "utf8");
      expect(text).not.toMatch(/__NODE__|__KEYFILE__/);
      const all = Object.values(JSON.parse(text).hooks as Record<string, { hooks: { command: string; args: string[] }[] }[]>).flatMap((gs) => gs.flatMap((g) => g.hooks));
      expect(all).toHaveLength(13);
      for (const h of all) {
        expect(isAbsolute(h.command)).toBe(true);
        expect(h.command).toBe(process.execPath);
        expect(statSync(h.command).mode & 0o111).not.toBe(0);
        expect(h.args).toEqual(["${CLAUDE_PLUGIN_ROOT}/hooks/relay.cjs", keyPath]);
      }
    } finally {
      rmSync(plug, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("PATH 앞에 .이 있고 cwd(프로젝트)에 가짜 node가 있어도 설치본 명령은 가짜를 실행하지 않는다. 맨 node였다면 실행됐다(대조군)", () => {
    const { plug, hooks, r } = filled(keyFile);
    const proj = mkdtempSync(join(tmpdir(), "co-sec-proj-"));
    const marker = join(proj, "PWNED");
    try {
      expect(r.status).toBe(0);
      writeFileSync(join(proj, "node"), `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
      const path = `.:${process.env.PATH ?? "/usr/bin:/bin"}`;
      const input = JSON.stringify(ev("PreToolUse"));
      const h = firstHook(hooks);
      const out = execForm(h, plug, proj, path, input);
      expect({ status: out.status, stdout: out.stdout }).toEqual({ status: 0, stdout: "" }); // 진짜 relay: 대시보드 없음 → 무출력
      expect(existsSync(marker)).toBe(false);
      // 대조군: 같은 조건에서 command가 맨 "node"면 cwd의 가짜가 실행된다 — 위 검사가 헛돌지 않음을 보인다
      execForm({ ...h, command: "node" }, plug, proj, path, input);
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(plug, { recursive: true, force: true });
      rmSync(proj, { recursive: true, force: true });
    }
  });

  it("채우지 못하면 exit 1: 인자 없음·JSON 아님·hooks 없음. 설치 스크립트는 그 실패에서 멈춘다(마켓플레이스 등록보다 앞)", () => {
    const t = mkdtempSync(join(tmpdir(), "co-sec-fill-"));
    try {
      writeFileSync(join(t, "bad.json"), "{not json");
      writeFileSync(join(t, "nohooks.json"), "{}");
      for (const args of [[], [join(t, "bad.json"), keyFile], [join(t, "nohooks.json"), keyFile], [join(t, "missing.json"), keyFile]]) {
        expect(spawnSync(process.execPath, [FILL, ...args]).status, args.join(" ")).toBe(1);
      }
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
    for (const [f, fail] of [["packaging/install.sh", /fill-hooks\.cjs"[^\n]*\\\n\s*\|\| fail hooks/], ["packaging/install.ps1", /fill-hooks\.cjs[\s\S]{0,200}\$LASTEXITCODE -ne 0\)\s*\{\s*\n\s*Fail-Install "hooks"/]] as const) {
      const s = readFileSync(join(ROOT, f), "utf8");
      expect(s, f).toMatch(fail);
      expect(s.indexOf("fill-hooks.cjs"), f).toBeLessThan(s.indexOf("plugin marketplace add"));
    }
  });
});
