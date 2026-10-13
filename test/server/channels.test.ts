import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../server/app";
import type { SessionRecord } from "../../server/collectors/sessions";
import { ChannelHub, MAX_HELD, MAX_LAUNCHED } from "../../server/floors/channels";
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
const rec = (p: Partial<SessionRecord> = {}): SessionRecord => ({ pid: 2001, sessionId: "s1", name: "alpha", cwd: "/x", status: "busy", startedAt: 1, updatedAt: 2, alive: true, procStart: "x", ...p });

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "co-ch-"));
  setLogger(new Logger({ dir: "" }));
  available = { ok: true };
  hub = new ChannelHub({ file: join(tmp, "experimental.json"), available: { get ok() { return available.ok; } } });
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
/** channel 서버처럼 스트림을 열고 받은 글을 모은다 */
function openStream(key: string, headers: Record<string, string> = {}) {
  const got: string[] = [];
  let status = 0;
  const ready = new Promise<void>((resolve) => {
    const req = request({ host: "127.0.0.1", port, path: "/channel/stream", method: "GET", headers: { Host: `127.0.0.1:${port}`, Authorization: `Floor ${key}`, ...headers } }, (res) => {
      status = res.statusCode ?? 0;
      res.on("data", (d) => got.push(String(d)));
      res.on("end", () => resolve());
      if (status === 200) setTimeout(resolve, 30);
    });
    req.end();
  });
  return { got, ready, status: () => status };
}
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
    const a = launchArgs({ tmuxName: "co-1", claude: "/c/claude", channelSpec: "plugin:claude-office@claude-office", sessionId: "u1", key: "k".repeat(64), port: 4317, cwd: "/w", name: "alpha", model: "sonnet", prompt });
    expect(a).toEqual(["new-session", "-d", "-s", "co-1", "-c", "/w", "-e", `CLAUDE_OFFICE_FLOOR_KEY=${"k".repeat(64)}`, "-e", "CLAUDE_OFFICE_PORT=4317", "--", "/c/claude", "--session-id", "u1", "--name", "alpha", "--model", "sonnet", prompt, "--dangerously-load-development-channels", "plugin:claude-office@claude-office"]);
    expect(a.indexOf(prompt)).toBeLessThan(a.indexOf("--dangerously-load-development-channels"));
    const b = launchArgs({ tmuxName: "co-1", claude: "/c/claude", channelSpec: "s", sessionId: "u1", key: "k", port: 1, cwd: "/w", name: "n", socket: "p4bt" });
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

  it("스트림은 층 열쇠로만, 브라우저(Origin)는 403, 틀린 열쇠 401", async () => {
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
    expect(s.got.join("")).toContain(JSON.stringify({ id: r.id, text: "고쳐 줘 \"a\"" }));
    expect(hub.view("s1")?.last).toBe("sent");
    expect((await send("/channel/ack", { headers: { Authorization: `Floor ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ id: r.id }) })).status).toBe(200);
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
