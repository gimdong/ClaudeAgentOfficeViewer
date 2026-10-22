import { createHmac, randomBytes } from "node:crypto";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../server/app";
import type { SessionRecord } from "../../server/collectors/sessions";
import { ChannelHub, floorKeyFile, MAX_HELD, MAX_LAUNCHED, MAX_PENDING, PENDING_MS } from "../../server/floors/channels";
import { FloorControl } from "../../server/floors/control";
import { launchArgs, tmuxVersionOk, validateLaunch, type LaunchInput } from "../../server/floors/launch";
import { Logger, setLogger } from "../../server/log";
import { makeSession, makeSnapshot } from "../web/fixtures";

const TOKEN = "c".repeat(64);
let server: Server;
let port: number;
let tmp: string;
let hub: ChannelHub;
let floors: FloorControl;
let launched: LaunchInput[];
let launchReply: { ok: true; sessionId: string; tmux: string } | { ok: false; error: "limit" | "tmux" };
let available: { ok: boolean; reason?: string };
let skew: number;
const rec = (p: Partial<SessionRecord> = {}): SessionRecord => ({ pid: 2001, sessionId: "s1", name: "alpha", cwd: "/x", status: "busy", startedAt: 1, updatedAt: 2, alive: true, procStart: "x", ...p });

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "co-ch-"));
  setLogger(new Logger({ dir: "" }));
  available = { ok: true };
  skew = 0;
  hub = new ChannelHub({ file: join(tmp, "experimental.json"), available: { get ok() { return available.ok; } }, now: () => Date.now() + skew });
  floors = new FloorControl({ signal: () => {}, matchProcStart: async () => true, selfPid: 4242 });
  launched = [];
  launchReply = { ok: true, sessionId: "new-1", tmux: "co-abcd1234" };
  const records = new Map([["s1", rec()]]);
  const snap = makeSnapshot({ sessions: [makeSession({ id: "s1" })] });
  server = createApp(
    { current: () => snap, subscribe: () => () => {}, poke: () => {} },
    {
      auth: { token: TOKEN },
      floors: {
        preToolUse: (i) => floors.preToolUse(i), pause: (id) => floors.pause(id), resume: (id) => floors.resume(id), isPaused: (id) => floors.isPaused(id),
        terminate: (r, f) => floors.terminate(r, f), hide: (id) => floors.hide(id), unhideAll: () => floors.unhideAll(), hiddenCount: () => floors.hiddenCount(), record: (id) => records.get(id),
      },
      channels: { hub, launch: async (i) => (launched.push(i), launchReply) },
    },
  ).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(tmp, { recursive: true, force: true });
});

type Res = { status: number; body: string };
function send(path: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  return new Promise<Res>((resolve, reject) => {
    const length = o.body === undefined ? {} : { "Content-Length": String(Buffer.byteLength(o.body)) };
    const req = request({ host: "127.0.0.1", port, path, method: o.method ?? "POST", headers: { Host: `127.0.0.1:${port}`, ...length, ...o.headers } }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on("error", reject);
    req.end(o.body);
  });
}
const PAGE = () => ({ Cookie: `co=${TOKEN}`, Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" });
const post = (path: string, body: unknown, method = "POST") => send(path, { method, headers: PAGE(), body: JSON.stringify(body) });
const mac = (k: string, m: string) => createHmac("sha256", k).update(m).digest("hex");
const hello = (body: unknown, headers: Record<string, string> = {}) =>
  send("/channel/hello", { headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
/** channel 서버처럼 핸드셰이크(B257: hello → 서버 proof 확인 → 클라이언트 proof)로 스트림을 열고 받은 글을 모은다 */
function openStream(key: string, headers: Record<string, string> = {}) {
  const got: string[] = [];
  let status = 0;
  let ack = "";
  let sk = "";
  let close = () => {};
  const ready = (async () => {
    const nonce = randomBytes(32).toString("hex");
    const h = await hello({ kid: mac(key, "kid"), nonce }, headers);
    if (h.status !== 200) return void (status = h.status);
    const { snonce, proof } = JSON.parse(h.body);
    expect(proof).toBe(mac(key, `server|${nonce}|${snonce}`));
    sk = mac(key, `session|${nonce}|${snonce}`);
    await new Promise<void>((resolve) => {
      const req = request({ host: "127.0.0.1", port, path: "/channel/stream", method: "GET", headers: { Host: `127.0.0.1:${port}`, Authorization: `Proof ${mac(key, "kid")} ${snonce} ${mac(key, `client|${nonce}|${snonce}`)}`, ...headers } }, (res) => {
        status = res.statusCode ?? 0;
        ack = String(res.headers["x-office-ack"] ?? "");
        res.on("data", (d) => got.push(String(d)));
        res.on("end", () => resolve());
        if (status === 200) setTimeout(resolve, 30);
      });
      req.end();
      close = () => req.destroy();
    });
  })();
  return { got, ready, status: () => status, ack: () => ack, sk: () => sk, close: () => close() };
}
/** SSE 글에서 instruction data를 꺼낸다 */
const instructions = (got: string[]) => [...got.join("").matchAll(/event: instruction\ndata: (.+)\n/g)].map((m) => JSON.parse(m[1]) as { id: string; text: string; mac: string });
const until = async (f: () => boolean) => {
  const t = Date.now();
  while (!f()) {
    if (Date.now() - t > 2000) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("launchArgs·validateLaunch(스펙 4.2)", () => {
  it("셸 없이 인자 배열, 첫 지시는 channel 옵션 앞(따옴표·$()·줄바꿈도 한 인자)", () => {
    const prompt = 'do "x" $(rm -rf ~)\nnext';
    const a = launchArgs({ tmuxName: "co-1", claude: "/c/claude", channelSpec: "plugin:claude-office@claude-office", sessionId: "u1", keyFile: "/k/co-1.key", port: 4317, cwd: "/w", name: "alpha", model: "sonnet", prompt });
    expect(a).toEqual(["new-session", "-d", "-s", "co-1", "-c", "/w", "-e", "CLAUDE_OFFICE_FLOOR_KEY_FILE=/k/co-1.key", "-e", "CLAUDE_OFFICE_PORT=4317", "--", "/c/claude", "--session-id", "u1", "--name", "alpha", "--model", "sonnet", prompt, "--dangerously-load-development-channels", "plugin:claude-office@claude-office"]);
    expect(a.indexOf(prompt)).toBeLessThan(a.indexOf("--dangerously-load-development-channels"));
    const b = launchArgs({ tmuxName: "co-1", claude: "/c/claude", channelSpec: "s", sessionId: "u1", keyFile: "/k", port: 1, cwd: "/w", name: "n", socket: "p4bt" });
    expect(b.slice(0, 2)).toEqual(["-L", "p4bt"]);
    expect(b.includes("--model")).toBe(false);
  });

  it("검사: 없는 폴더·상대 경로·파일·NUL·이름·모델·긴 지시·모르는 키는 거부, ~는 홈으로, 이름 기본은 폴더 이름", () => {
    const dir = join(tmp, "my proj");
    mkdirSync(dir);
    expect(validateLaunch({ cwd: dir })).toMatchObject({ ok: true, value: { name: "my proj" } });
    expect(validateLaunch({ cwd: "~/my proj" }, tmp)).toMatchObject({ ok: true });
    for (const [b, e] of [
      [{ cwd: join(tmp, "nope") }, "cwd"], [{ cwd: "rel" }, "cwd"], [{ cwd: join(tmp, "experimental.json") }, "cwd"], [{ cwd: `${dir}\0` }, "cwd"],
      [{ cwd: dir, name: "a;b" }, "name"], [{ cwd: dir, model: "gpt" }, "model"], [{ cwd: dir, prompt: "x".repeat(8001) }, "prompt"], [{ cwd: dir, extra: 1 }, "body"],
    ] as const) expect(validateLaunch(b)).toEqual({ ok: false, error: e });
  });
});

describe("실험 기능 스위치(스펙 3장)", () => {
  it("꺼져 있으면 launch·instruct는 403, 켜면 파일에 저장, 쓸 수 없는 환경이면 켤 수 없다", async () => {
    expect((await post("/api/floors/launch", { cwd: tmp })).status).toBe(403);
    expect((await post("/api/experimental", { channels: true }, "PUT")).status).toBe(200);
    expect(JSON.parse(readFileSync(join(tmp, "experimental.json"), "utf8"))).toEqual({ channels: true });
    expect(hub.enabled()).toBe(true);
    available = { ok: false, reason: "tmux" };
    expect(hub.enabled()).toBe(false);
    expect((await post("/api/experimental", { channels: true }, "PUT")).status).toBe(409);
  });
});

describe("새 층·지시·보관(스펙 4·6·7장)", () => {
  beforeEach(() => hub.setEnabled(true));

  it("launch는 검사한 값을 넘기고 세션 id와 tmux 이름을 돌려준다. 상한은 429", async () => {
    const r = await post("/api/floors/launch", { cwd: tmp, prompt: "hi" });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ sessionId: "new-1", tmux: "co-abcd1234" });
    expect(launched[0]).toMatchObject({ prompt: "hi" });
    launchReply = { ok: false, error: "limit" };
    expect((await post("/api/floors/launch", { cwd: tmp })).status).toBe(429);
  });

  it("스트림은 층 열쇠의 증명으로만, 브라우저(Origin)는 hello부터 403, 틀린 열쇠 401", async () => {
    const key = hub.register("s1", "co-1")!;
    const bad = openStream("0".repeat(64));
    await bad.ready;
    expect(bad.status()).toBe(401);
    const web = openStream(key, { Origin: `http://127.0.0.1:${port}` });
    await web.ready;
    expect(web.status()).toBe(403);
  });

  it("연결된 층에 보내면 SSE로 가고 ack로 delivered, 연결 없으면 409 not-connected, 띄우지 않은 층은 404", async () => {
    expect((await post("/api/floors/s1/instruct", { text: "x" })).status).toBe(404);
    const key = hub.register("s1", "co-1")!;
    expect(JSON.parse((await post("/api/floors/s1/instruct", { text: "x" })).body)).toEqual({ error: "not-connected" });
    const s = openStream(key);
    await s.ready;
    await until(() => hub.view("s1")?.connected === true);
    const r = JSON.parse((await post("/api/floors/s1/instruct", { text: "고쳐 줘 \"a\"" })).body);
    expect(r.state).toBe("sent");
    await until(() => s.got.join("").includes("event: instruction"));
    expect(instructions(s.got)).toEqual([{ id: r.id, text: "고쳐 줘 \"a\"", mac: mac(s.sk(), JSON.stringify([r.id, '고쳐 줘 "a"'])) }]);
    expect(hub.view("s1")?.last).toBe("sent");
    expect((await send("/channel/ack", { headers: { Authorization: `Ack ${s.ack()}`, "Content-Type": "application/json" }, body: JSON.stringify({ id: r.id }) })).status).toBe(200);
    expect(hub.view("s1")?.last).toBe("delivered");
  });

  it("휴업 중이면 보관(held), 고치기·지우기, 상한, [보내고 재개]가 순서대로 보낸다. 그냥 재개는 보내지 않는다", async () => {
    const key = hub.register("s1", "co-1")!;
    const s = openStream(key);
    await s.ready;
    floors.pause("s1");
    const a = JSON.parse((await post("/api/floors/s1/instruct", { text: "첫째" })).body);
    const b = JSON.parse((await post("/api/floors/s1/instruct", { text: "둘째" })).body);
    expect([a.state, b.state]).toEqual(["held", "held"]);
    expect(s.got.join("")).not.toContain("instruction");
    expect((await post(`/api/floors/s1/held/${a.id}`, { text: "첫째(고침)" }, "PUT")).status).toBe(200);
    const list = JSON.parse((await send("/api/floors/s1/held", { method: "GET", headers: { Cookie: `co=${TOKEN}` } })).body).held;
    expect(list.map((h: { text: string }) => h.text)).toEqual(["첫째(고침)", "둘째"]);
    expect((await post(`/api/floors/s1/held/${b.id}`, {}, "DELETE")).status).toBe(200);
    for (let i = 0; i < MAX_HELD - 1; i++) hub.instruct("s1", `f${i}`, true);
    expect(JSON.parse((await post("/api/floors/s1/instruct", { text: "넘침" })).body)).toEqual({ error: "held-full" });
    const r = JSON.parse((await post("/api/floors/s1/resume", { sendHeld: true })).body);
    expect(r).toEqual({ paused: false, sent: MAX_HELD });
    await until(() => s.got.join("").includes("첫째(고침)"));
    const all = s.got.join("");
    expect(all.indexOf('"text":"첫째(고침)"')).toBeLessThan(all.indexOf('"text":"f0"'));
    expect(hub.view("s1")?.held).toBe(0);
    floors.pause("s1");
    hub.instruct("s1", "남김", true);
    expect(JSON.parse((await post("/api/floors/s1/resume", {})).body)).toEqual({ paused: false });
    expect(hub.view("s1")?.held).toBe(1);
  });

  it("빈 지시·너무 긴 지시는 400", async () => {
    hub.register("s1", "co-1");
    expect((await post("/api/floors/s1/instruct", { text: "  " })).status).toBe(400);
    expect((await post("/api/floors/s1/instruct", { text: "x".repeat(8001) })).status).toBe(400);
  });
});

describe("리뷰 #410 수정", () => {
  it("I1: 첫 지시·이름이 -로 시작하면 claude 옵션으로 읽히므로 거부(앞 공백도)", () => {
    const dir = join(tmp, "w");
    mkdirSync(dir);
    for (const prompt of ["--dangerously-skip-permissions", "-p x", "  --mcp-config=/x.json"]) expect(validateLaunch({ cwd: dir, prompt })).toEqual({ ok: false, error: "prompt-dash" });
    expect(validateLaunch({ cwd: dir, name: "--settings=x" })).toEqual({ ok: false, error: "name" });
    const dash = join(tmp, "-rf");
    mkdirSync(dash);
    expect(validateLaunch({ cwd: dash })).toMatchObject({ ok: true, value: { name: "rf" } });
    expect(validateLaunch({ cwd: dir, prompt: "x -p y" })).toMatchObject({ ok: true });
  });

  it("I2: tmux 3.0 미만은 쓸 수 없다(명령이 셸로 실행됨)", () => {
    expect(["tmux 3.5a", "tmux 3.0", "tmux next-3.4", "tmux 10.1"].map(tmuxVersionOk)).toEqual([true, true, true, true]);
    expect(["tmux 2.9a", "tmux 1.8", "", "garbage"].map(tmuxVersionOk)).toEqual([false, false, false, false]);
  });

  it("I3: 세션 목록에서 사라진 층(정상 종료)과 10분 넘게 안 나타난 층은 정리되어 다시 띄울 수 있다", () => {
    let now = 0;
    const h = new ChannelHub({ file: join(tmp, "e.json"), available: { ok: true }, now: () => now });
    const ids = Array.from({ length: MAX_LAUNCHED }, (_, i) => `f${i}`);
    for (const id of ids) expect(h.register(id, "co")).not.toBeNull();
    expect(h.register("over", "co")).toBeNull();
    h.sweep(new Set(["f0", "f1"])); // f0·f1은 나타났다
    now = 5 * 60_000;
    h.sweep(new Set(["f1"])); // f0은 나타났다가 사라짐(정상 종료) → 바로 정리
    expect(h.view("f0")).toBeUndefined();
    expect(h.view("f2")).toBeDefined(); // 아직 10분 안
    now = 11 * 60_000;
    h.sweep(new Set(["f1"]));
    expect(h.launchedCount()).toBe(1);
    expect(h.register("next", "co")).not.toBeNull();
  });

  it("M2: 연결 전인 층을 [보내고 재개]하면 재개하지 않고 409 not-connected(보관 지시는 남는다)", async () => {
    hub.setEnabled(true);
    hub.register("s1", "co-1");
    floors.pause("s1");
    hub.instruct("s1", "남김", true);
    const r = await post("/api/floors/s1/resume", { sendHeld: true });
    expect([r.status, JSON.parse(r.body)]).toEqual([409, { error: "not-connected" }]);
    expect(floors.isPaused("s1")).toBe(true);
    expect(hub.view("s1")?.held).toBe(1);
  });
});

describe("일하는 방식(서브에이전트/agent team)", () => {
  it("team이면 tmux -e로 agent team 환경변수를 넘기고, 기본(서브에이전트)은 넘기지 않는다. 모르는 값은 400", () => {
    const base = { tmuxName: "co-1", claude: "/c", channelSpec: "s", sessionId: "u", keyFile: "/k", port: 1, cwd: "/w", name: "n" };
    expect(launchArgs({ ...base, mode: "team" })).toContain("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1");
    expect(launchArgs(base).some((a) => a.includes("AGENT_TEAMS"))).toBe(false);
    const a = launchArgs({ ...base, mode: "team" });
    expect(a.indexOf("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1")).toBeLessThan(a.indexOf("--"));
    expect(validateLaunch({ cwd: tmp, mode: "team" })).toMatchObject({ ok: true, value: { mode: "team" } });
    expect(validateLaunch({ cwd: tmp, mode: "subagents" })).toMatchObject({ ok: true });
    expect(validateLaunch({ cwd: tmp, mode: "swarm" })).toEqual({ ok: false, error: "mode" });
  });
});

describe("channel 핸드셰이크(B257) — 열쇠 원문은 오가지 않는다", () => {
  const hex = () => randomBytes(32).toString("hex");
  const stream = (authorization: string) => send("/channel/stream", { method: "GET", headers: { Authorization: authorization } });
  const proofAuth = (key: string, nonce: string, snonce: string, p = mac(key, `client|${nonce}|${snonce}`)) => `Proof ${mac(key, "kid")} ${snonce} ${p}`;
  async function helloOk(key: string) {
    const nonce = hex();
    const r = await hello({ kid: mac(key, "kid"), nonce });
    expect(r.status).toBe(200);
    return { nonce, snonce: JSON.parse(r.body).snonce as string };
  }

  it("옛 Floor <열쇠> 인증은 stream·ack 모두 401", async () => {
    const key = hub.register("s1", "co-1")!;
    expect((await stream(`Floor ${key}`)).status).toBe(401);
    expect((await send("/channel/ack", { headers: { Authorization: `Floor ${key}`, "Content-Type": "application/json" }, body: '{"id":"x"}' })).status).toBe(401);
    expect(hub.view("s1")?.connected).toBe(false);
  });

  it("모르는 kid는 401, nonce·kid가 64자 hex가 아니거나 본문이 1kb를 넘으면 400", async () => {
    hub.register("s1", "co-1");
    expect((await hello({ kid: hex(), nonce: hex() })).status).toBe(401);
    for (const b of [{ kid: hex(), nonce: "x" }, { kid: hex().toUpperCase(), nonce: hex() }, { kid: hex() }, [], "s"]) expect((await hello(b)).status, JSON.stringify(b)).toBe(400);
    expect((await hello({ kid: hex(), nonce: hex(), pad: "x".repeat(1100) })).status).toBe(413);
  });

  it("클라이언트 proof가 틀리면 401이고 그 snonce는 지워진다(맞는 proof로 다시 써도 401)", async () => {
    const key = hub.register("s1", "co-1")!;
    const { nonce, snonce } = await helloOk(key);
    expect((await stream(proofAuth(key, nonce, snonce, hex()))).status).toBe(401);
    expect((await stream(proofAuth(key, nonce, snonce))).status).toBe(401);
    expect(hub.view("s1")?.connected).toBe(false);
  });

  it("다른 층 열쇠·서버 proof를 그대로 돌려준 값·nonce를 바꾼 proof는 401", async () => {
    const key = hub.register("s1", "co-1")!;
    const other = hub.register("s2", "co-2")!;
    const a = await helloOk(key);
    expect((await stream(proofAuth(key, a.nonce, a.snonce, mac(other, `client|${a.nonce}|${a.snonce}`)))).status).toBe(401);
    const b = await helloOk(key);
    expect((await stream(proofAuth(key, b.nonce, b.snonce, mac(key, `server|${b.nonce}|${b.snonce}`)))).status).toBe(401);
    const c = await helloOk(key);
    expect((await stream(proofAuth(key, hex(), c.snonce))).status).toBe(401);
  });

  it(`미결 snonce는 층마다 ${MAX_PENDING}개(오래된 것부터 버림), ${PENDING_MS / 1000}초가 지나면 무효`, async () => {
    const key = hub.register("s1", "co-1")!;
    const all = [];
    for (let i = 0; i <= MAX_PENDING; i++) all.push(await helloOk(key));
    expect((await stream(proofAuth(key, all[0].nonce, all[0].snonce))).status).toBe(401);
    const old = all[1];
    skew = PENDING_MS + 1;
    expect((await stream(proofAuth(key, old.nonce, old.snonce))).status).toBe(401);
    const fresh = await helloOk(key);
    const s = openStream(key);
    await s.ready;
    expect(s.status()).toBe(200);
    expect(fresh.snonce).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ack 토큰은 연결마다 새로 나오고, 연결이 끊기면 무효", async () => {
    const key = hub.register("s1", "co-1")!;
    const a = openStream(key);
    await a.ready;
    const first = a.ack();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    const ack = (t: string) => send("/channel/ack", { headers: { Authorization: `Ack ${t}`, "Content-Type": "application/json" }, body: '{"id":"x"}' });
    expect((await ack(first)).status).toBe(200);
    // 첫 연결이 살아 있는 동안 새 연결은 409(Phase 6b 스펙 12장 g ② — 빼앗지 않는다), 토큰도 없다
    const busy = openStream(key);
    await busy.ready;
    expect([busy.status(), busy.ack()]).toEqual([409, ""]);
    expect((await ack(first)).status).toBe(200);
    a.close();
    await until(() => hub.view("s1")?.connected === false);
    expect((await ack(first)).status).toBe(401); // 끊긴 연결의 토큰은 무효
    const b = openStream(key); // 끊긴 뒤의 다시 연결은 받는다
    await b.ready;
    expect(b.status()).toBe(200);
    expect(b.ack()).not.toBe(first);
    expect((await ack(b.ack())).status).toBe(200);
    expect((await ack(key)).status).toBe(401);
    b.close();
    await until(() => hub.view("s1")?.connected === false);
    expect((await ack(b.ack())).status).toBe(401);
  });

  it("verifySubmit(Phase 6b): 살아 있는 연결의 ack 토큰 + 그 연결 키 MAC만, nonce는 한 번만, 끊긴 연결은 거절", async () => {
    const key = hub.register("s1", "co-1")!;
    const s = openStream(key);
    await s.ready;
    const input = JSON.stringify(["submit", "ask_user", "n1", { question: "q" }]);
    expect(hub.verifySubmit(s.ack(), input, mac(s.sk(), input) .replace(/^./, (c) => (c === "0" ? "1" : "0")), "n1")).toBeNull(); // MAC 틀림
    expect(hub.verifySubmit("b".repeat(64), input, mac(s.sk(), input), "n1")).toBeNull(); // 모르는 토큰
    expect(hub.verifySubmit(s.ack(), input, mac(key, input), "n1")).toBeNull(); // 층 열쇠로 만든 MAC(연결 키가 아님)
    expect(hub.verifySubmit(s.ack(), input, mac(s.sk(), input), "n1")).toBe("s1");
    expect(hub.verifySubmit(s.ack(), input, mac(s.sk(), input), "n1")).toBeNull(); // 같은 nonce 두 번째
    s.close();
    await until(() => hub.view("s1")?.connected === false);
    expect(hub.verifySubmit(s.ack(), input, mac(s.sk(), input), "n2")).toBeNull();
  });

  it("B333 I-1: 층을 정리(unregister)하면 남은 보관 지시마다 '보내지 않고 사라짐'을 알린다(결재 도장이 보관됨에 남지 않게)", () => {
    hub.register("s1", "co-1");
    const gone: Array<[string, boolean, unknown]> = [];
    hub.onHeldGone((k, sent, meta) => void gone.push([k, sent, meta]));
    const meta = { floor: "s1", kind: "approve", requestId: "r-99999999", reportId: "r-11111111" };
    hub.instruct("s1", "승인", true, "lead:verdict:r-11111111", meta);
    hub.unregister("s1");
    expect(gone).toEqual([["lead:verdict:r-11111111", false, meta]]);
  });

  it("보관한 팀리더 지시는 실제로 나갈 때 meta와 함께 알린다(Phase 6b 11장 a) — 화면용 held 목록에는 meta가 없다", async () => {
    const key = hub.register("s1", "co-1")!;
    const gone: Array<[string, boolean, unknown]> = [];
    hub.onHeldGone((k, sent, meta) => void gone.push([k, sent, meta]));
    hub.instruct("s1", "퇴근 지시", true, "lead:duty:tester", { floor: "s1", kind: "offduty", member: "tester" });
    hub.instruct("s1", "보통 지시", true);
    expect(hub.held("s1").map((h) => Object.keys(h).sort())).toEqual([["at", "id", "key", "text"], ["at", "id", "text"]]);
    const s = openStream(key);
    await s.ready;
    expect(hub.flushHeld("s1")).toBe(2);
    expect(gone).toEqual([["lead:duty:tester", true, { floor: "s1", kind: "offduty", member: "tester" }]]);
  });

  it("busy 로그는 리드 연결이 붙어 있는 동안 처음 한 번만(B321 M4)", async () => {
    const logs = join(tmp, "busylogs");
    setLogger(new Logger({ dir: logs }));
    const key = hub.register("s1", "co-1")!;
    const a = openStream(key);
    await a.ready;
    for (let i = 0; i < 3; i++) {
      const b = openStream(key);
      await b.ready;
      expect(b.status()).toBe(409);
    }
    const text = readdirSync(logs).map((f) => readFileSync(join(logs, f), "utf8")).join("");
    expect(text.split("channel-busy").length - 1).toBe(1);
  });

  it("hello·stream·ack의 응답과 로그에 열쇠·proof 값이 나오지 않는다", async () => {
    const logs = join(tmp, "logs");
    setLogger(new Logger({ dir: logs }));
    const key = hub.register("s1", "co-1")!;
    const { nonce, snonce } = await helloOk(key);
    await stream(proofAuth(key, nonce, snonce, hex()));
    const s = openStream(key);
    await s.ready;
    const text = readdirSync(logs).map((f) => readFileSync(join(logs, f), "utf8")).join("");
    expect(text).toContain("channel-connect");
    for (const v of [key, snonce, mac(key, "kid"), s.ack()]) expect(text).not.toContain(v);
  });
});

describe("층 열쇠 파일(B265 — 열쇠 원문은 tmux 인자에 싣지 않는다)", () => {
  it("keyDir이 있으면 등록할 때 0700 폴더에 0600 파일로 쓰고, 해제하면 지운다. load는 지난 실행의 열쇠 파일을 지운다", () => {
    const keyDir = join(tmp, "floors");
    mkdirSync(keyDir, { mode: 0o755 });
    writeFileSync(join(keyDir, "co-old.key"), "stale");
    const h = new ChannelHub({ file: join(tmp, "experimental.json"), available: { ok: true }, keyDir });
    h.load();
    expect(existsSync(join(keyDir, "co-old.key"))).toBe(false);
    const key = h.register("s1", "co-1")!;
    const f = floorKeyFile(keyDir, "co-1");
    expect(readFileSync(f, "utf8")).toBe(key);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(statSync(keyDir).mode & 0o777).toBe(0o700);
    h.unregister("s1");
    expect(existsSync(f)).toBe(false);
  });

  it("열쇠 파일을 쓰지 못하면 등록하지 않고 던진다(층 수에 남지 않는다)", () => {
    const blocker = join(tmp, "not-a-dir");
    writeFileSync(blocker, "");
    const h = new ChannelHub({ file: join(tmp, "experimental.json"), available: { ok: true }, keyDir: blocker });
    expect(() => h.register("s1", "co-1")).toThrow();
    expect(h.launchedCount()).toBe(0);
  });
});
