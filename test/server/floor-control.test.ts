import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "../../server/collectors/sessions";
import { PAUSED_REASON, preToolDeny } from "../../server/decisions/protocol";
import { FloorControl } from "../../server/floors/control";
import { Logger, setLogger } from "../../server/log";
import { EXEMPT_TOOLS } from "../../server/policy/tools";

// 어떤 테스트도 실제 프로세스에 신호를 보내지 않는다: signal은 호출을 모으기만 하는 가짜다
type Sig = "SIGTERM" | "SIGKILL";
let calls: Array<[number, Sig]>;
let match: () => Promise<boolean | undefined>;
let dir: string;
let changes: number;
const SELF = 4242;
const fc = () =>
  new FloorControl({
    signal: (pid, sig) => void calls.push([pid, sig]),
    matchProcStart: () => match(),
    selfPid: SELF,
    onChange: () => void changes++,
  });
const rec = (p: Partial<SessionRecord> = {}): SessionRecord => ({
  pid: 1001, sessionId: "s1", name: "alpha", cwd: "/x/FAKE-CWD", status: "busy", startedAt: 1, updatedAt: 2, alive: true, procStart: "Mon Oct 11 10:00:00 2026", ...p,
});
const pre = (o: Record<string, unknown> = {}) => ({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Bash", tool_input: { command: "FAKE-CMD-123" }, cwd: "/x/FAKE-CWD", ...o });
const logText = () => (existsSync(join(dir, "logs")) ? readdirSync(join(dir, "logs")).map((f) => readFileSync(join(dir, "logs", f), "utf8")).join("") : "");
const floorLines = () =>
  logText()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { src: string; msg: string; data?: Record<string, unknown> })
    .filter((l) => l.src === "floors");

beforeEach(() => {
  calls = [];
  match = async () => true;
  changes = 0;
  dir = mkdtempSync(join(tmpdir(), "co-floors-"));
  setLogger(new Logger({ dir: join(dir, "logs") }));
});
afterEach(() => {
  setLogger(new Logger({ dir: "" }));
  rmSync(dir, { recursive: true, force: true });
});

describe("일시정지 판정(스펙 4.2)", () => {
  it("일시정지한 세션의 PreToolUse는 deny이고 이유는 PAUSED_REASON 글자 그대로", () => {
    const f = fc();
    f.pause("s1");
    expect(f.preToolUse(pre())).toEqual(preToolDeny(PAUSED_REASON));
  });

  it.each([...EXEMPT_TOOLS])("예외 도구 아홉 개는 일시정지 중에도 통과: %s", (tool) => {
    const f = fc();
    f.pause("s1");
    expect(f.preToolUse(pre({ tool_name: tool }))).toBeNull();
    expect(f.view("s1").pausedDenied).toBe(0);
  });

  it("예외 도구는 아홉 개다", () => {
    expect(EXEMPT_TOOLS.size).toBe(9);
  });

  it("일시정지하지 않은 세션·PreToolUse가 아닌 이벤트·tool_name이 없는 입력은 null", () => {
    const f = fc();
    f.pause("s1");
    expect(f.preToolUse(pre({ session_id: "other" }))).toBeNull();
    expect(f.preToolUse(pre({ hook_event_name: "PostToolUse" }))).toBeNull();
    expect(f.preToolUse(pre({ hook_event_name: "Stop" }))).toBeNull();
    for (const tool_name of [undefined, "", 42]) expect(f.preToolUse(pre({ tool_name }))).toBeNull();
    expect(f.preToolUse(pre({ session_id: 7 }))).toBeNull();
    // Review Focus 5: 모르는 id로 쏟아져도 세지 않는다
    for (let i = 0; i < 10_000; i++) f.preToolUse(pre({ session_id: `x${i}` }));
    expect(f.view("x0").pausedDenied).toBe(0);
    expect(f.view("s1").pausedDenied).toBe(0);
    expect(f.stats()).toEqual({ paused: 1, hidden: 0, terminating: 0 });
  });

  it("막을 때마다 pausedDenied가 1씩 오르고, resume하면 횟수는 유지하되 막지 않는다", () => {
    const f = fc();
    f.pause("s1");
    f.preToolUse(pre());
    f.preToolUse(pre({ tool_name: "Write" }));
    expect(f.view("s1")).toEqual({ paused: true, pausedDenied: 2, terminating: false });
    f.resume("s1");
    expect(f.preToolUse(pre())).toBeNull();
    expect(f.view("s1")).toEqual({ paused: false, pausedDenied: 2, terminating: false });
  });

  it("판정은 tool_input을 읽지 않는다", () => {
    const f = fc();
    f.pause("s1");
    const getter = vi.fn(() => {
      throw new Error("read");
    });
    const tool_input = Object.defineProperty({}, "command", { get: getter, enumerable: true });
    expect(f.preToolUse(pre({ tool_input }))).toEqual(preToolDeny(PAUSED_REASON));
    expect(getter).not.toHaveBeenCalled();
  });

  it("pause·resume은 멱등이고 로그·onChange는 상태가 바뀔 때만", () => {
    const f = fc();
    f.pause("s1");
    f.pause("s1");
    expect(f.isPaused("s1")).toBe(true);
    f.resume("s1");
    f.resume("s1");
    expect(f.isPaused("s1")).toBe(false);
    expect(floorLines().map((l) => l.msg)).toEqual(["pause", "resume"]);
    expect(changes).toBe(2);
  });
});

describe("종료 검사(스펙 5.1)", () => {
  it.each<[string, () => SessionRecord | undefined, () => Promise<boolean | undefined>, string]>([
    ["레코드 없음", () => undefined, async () => true, "ended"],
    ["alive: false", () => rec({ alive: false }), async () => true, "ended"],
    ["pid === selfPid", () => rec({ pid: SELF }), async () => true, "self"],
    ["matcher false", () => rec(), async () => false, "pid-reused"],
    ["matcher undefined", () => rec(), async () => undefined, "unverified"],
    ["matcher가 던짐", () => rec(), async () => {
      throw new Error("ps");
    }, "unverified"],
  ])("%s이면 거부하고 신호를 보내지 않는다", async (_l, r, m, error) => {
    match = m;
    expect(await fc().terminate(r(), false)).toEqual({ ok: false, error });
    expect(calls).toEqual([]);
  });

  it("procStart가 없으면 matcher를 부르지 않고 unverified(Review Focus 4)", async () => {
    const m = vi.fn(async () => true);
    match = m;
    const { procStart: _p, ...noStart } = rec();
    expect(await fc().terminate(noStart, false)).toEqual({ ok: false, error: "unverified" });
    expect(m).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("모두 통과하면 SIGTERM, 다시 보내면 멱등, force면 SIGKILL — 신호 목록이 정확히 같다", async () => {
    const f = fc();
    expect(await f.terminate(rec(), false)).toEqual({ ok: true, signal: "SIGTERM", sent: true });
    expect(f.view("s1").terminating).toBe(true);
    expect(await f.terminate(rec(), false)).toEqual({ ok: true, signal: "SIGTERM", sent: false });
    expect(await f.terminate(rec(), true)).toEqual({ ok: true, signal: "SIGKILL", sent: true });
    expect(calls).toEqual([
      [1001, "SIGTERM"],
      [1001, "SIGKILL"],
    ]);
    expect(floorLines().filter((l) => l.msg === "terminate").map((l) => l.data)).toEqual([
      { session: 1, signal: "SIGTERM" },
      { session: 1, signal: "SIGKILL" },
    ]);
  });

  it.each([0, 1, -1, 1.5])("pid %s는 unverified이고 matcher·signal을 부르지 않는다(B123)", async (pid) => {
    const m = vi.fn(async () => true);
    match = m;
    expect(await fc().terminate(rec({ pid }), false)).toEqual({ ok: false, error: "unverified" });
    expect(m).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("terminate는 레코드의 pid로만 신호를 보낸다", async () => {
    await fc().terminate(rec({ pid: 31337, sessionId: "s9" }), false);
    expect(calls).toEqual([[31337, "SIGTERM"]]);
  });

  it("신호 함수가 ESRCH로 던지면(이미 끝남) terminating에 남기지 않고 ended", async () => {
    const f = new FloorControl({
      signal: () => {
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      },
      matchProcStart: async () => true,
      selfPid: SELF,
    });
    expect(await f.terminate(rec(), false)).toEqual({ ok: false, error: "ended" });
    expect(f.view("s1").terminating).toBe(false);
  });
});

describe("숨김과 정리", () => {
  it("hide·unhideAll·isHidden·hiddenCount", () => {
    const f = fc();
    f.hide("a");
    f.hide("b");
    f.hide("b");
    expect([f.isHidden("a"), f.isHidden("c"), f.hiddenCount()]).toEqual([true, false, 2]);
    f.unhideAll();
    expect(f.hiddenCount()).toBe(0);
    expect(floorLines().map((l) => l.msg)).toEqual(["hide", "hide", "unhide"]);
  });

  it("sweep: 끝난 세션은 paused·pausedDenied·terminating에서, 목록에 없는 세션은 hidden에서, 살아 있는 세션은 hidden에서 빠진다(B118)", async () => {
    const f = fc();
    f.pause("dead");
    f.preToolUse(pre({ session_id: "dead" }));
    await f.terminate(rec({ sessionId: "dead" }), false);
    f.pause("live");
    f.hide("gone");
    f.hide("ended");
    f.hide("revived");
    f.sweep([rec({ sessionId: "dead", alive: false }), rec({ sessionId: "live" }), rec({ sessionId: "ended", alive: false }), rec({ sessionId: "revived" })]);
    expect(f.view("dead")).toEqual({ paused: false, pausedDenied: 0, terminating: false });
    expect(f.view("live").paused).toBe(true);
    expect([f.isHidden("gone"), f.isHidden("ended"), f.isHidden("revived")]).toEqual([false, true, false]);
    expect(f.stats()).toEqual({ paused: 1, hidden: 1, terminating: 0 });
  });

  it("stats는 세 집합의 수만", async () => {
    const f = fc();
    f.pause("a");
    f.hide("b");
    await f.terminate(rec({ sessionId: "c" }), false);
    expect(f.stats()).toEqual({ paused: 1, hidden: 1, terminating: 1 });
  });
});

describe("로그와 onChange", () => {
  it("로그에는 세션 id·도구 이름·신호 이름만(tool_input·cwd 없음)", async () => {
    const f = fc();
    f.pause("s1");
    f.preToolUse(pre());
    await f.terminate(rec(), false);
    f.hide("s2");
    f.unhideAll();
    f.resume("s1");
    const text = logText();
    expect([text.includes("FAKE-CMD-123"), text.includes("FAKE-CWD")]).toEqual([false, false]);
    expect(floorLines().map((l) => l.msg)).toEqual(["pause", "paused-deny", "terminate", "hide", "unhide", "resume"]);
    expect(floorLines().find((l) => l.msg === "paused-deny")?.data).toEqual({ session: 1, tool: "Bash" });
    // 세션 표시는 처음 본 순서의 순번(B123): s1=1, s2=2. 세션 id 문자열은 로그에 없다
    expect(floorLines().find((l) => l.msg === "hide")?.data).toEqual({ session: 2 });
    expect([text.includes("s1"), text.includes("s2")]).toEqual([false, false]);
  });

  it("같은 도구를 5번 막으면 로그는 한 줄(로거의 10분 묶음, B125), 횟수는 5", () => {
    const f = fc();
    f.pause("s1");
    for (let i = 0; i < 5; i++) f.preToolUse(pre());
    expect(floorLines().filter((l) => l.msg.startsWith("paused-deny"))).toHaveLength(1);
    expect(f.view("s1").pausedDenied).toBe(5);
  });

  it("같은 세션을 다른 도구 이름 100개로 막아도 로그는 한 줄(msg 고정, B128)", () => {
    const f = fc();
    f.pause("s1");
    for (let i = 0; i < 100; i++) f.preToolUse(pre({ tool_name: `mcp__fake__t${i}` }));
    expect(floorLines().filter((l) => l.msg.startsWith("paused-deny"))).toHaveLength(1);
    expect(f.view("s1").pausedDenied).toBe(100);
  });

  it("세션 id가 길고 고유해도 로그 폴더 전체에 그 문자열이 없다(B123)", async () => {
    const id = "sess-6f1d2c3b-UNIQUE-ID-XYZ";
    const f = fc();
    f.pause(id);
    f.preToolUse(pre({ session_id: id }));
    await f.terminate(rec({ sessionId: id }), false);
    f.resume(id);
    f.hide(id);
    expect(logText().includes("UNIQUE-ID")).toBe(false);
  });

  it("onChange는 상태가 바뀔 때만(deny 횟수 포함)", async () => {
    const f = fc();
    f.preToolUse(pre());
    expect(changes).toBe(0);
    f.pause("s1");
    f.preToolUse(pre());
    await f.terminate(rec(), false);
    await f.terminate(rec(), false); // 멱등: 바뀌지 않음
    f.hide("x");
    f.hide("x");
    f.unhideAll();
    f.unhideAll();
    expect(changes).toBe(5);
  });

  it("preToolUse는 던지지 않는다(B116)", () => {
    const f = fc();
    f.pause("s1");
    const bad = new Proxy({}, { get: () => { throw new Error("x"); } }) as Record<string, unknown>;
    expect(f.preToolUse(bad)).toBeNull();
  });
});
