import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCTime, pidAlive, readSessions } from "../../server/collectors/sessions";
import { Logger, setLogger, type LogLine } from "../../server/log";
import { makeHome, type FakeHome } from "../helpers/fakeHome";

// spawnSync(pidAlive 테스트가 진짜 프로세스로 씀)는 실제로 두고 execFile만 감시용으로 바꾼다(Task 3).
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn() };
});

const NOW = Date.now();
let h: FakeHome;
let logDir: string;
beforeEach(async () => {
  h = await makeHome();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  logDir = mkdtempSync(join(tmpdir(), "office-sessions-log-"));
  setLogger(new Logger({ dir: logDir }));
  vi.mocked(execFile).mockClear();
});
afterEach(async () => {
  vi.restoreAllMocks();
  setLogger(new Logger({ dir: "" }));
  rmSync(logDir, { recursive: true, force: true });
  await h.cleanup();
});

const logLines = (): LogLine[] =>
  readdirSync(logDir).flatMap((f) => readFileSync(join(logDir, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)));

describe("readSessions", () => {
  it("살아 있는 세션과 24시간 안에 끝난 세션만 반환하고, 잘못된 파일은 건너뛴다", async () => {
    await h.write("sessions/1.json", { pid: 1, sessionId: "alive", name: "alpha", cwd: "/a", status: "busy", startedAt: NOW - 5000, updatedAt: NOW - 1000 });
    await h.write("sessions/2.json", { pid: 2, sessionId: "recent", cwd: "/b", status: "idle", updatedAt: NOW - 3_600_000 });
    await h.write("sessions/3.json", { pid: 3, sessionId: "old", status: "idle", updatedAt: NOW - 25 * 3_600_000 });
    await h.write("sessions/4.abc.key", { peerToken: "x" });
    await h.write("sessions/5.json", "{broken");
    await h.write("sessions/6.json", { pid: 6 });

    const list = await readSessions(h.home, NOW, (pid) => pid === 1);
    const byId = Object.fromEntries(list.map((s) => [s.sessionId, s]));
    expect(Object.keys(byId).sort()).toEqual(["alive", "recent"]);
    expect(byId.alive).toMatchObject({ pid: 1, name: "alpha", cwd: "/a", status: "busy", alive: true, updatedAt: NOW - 1000 });
    expect(byId.recent).toMatchObject({ name: "recent", alive: false, status: "idle" });
    // console.warn 대신 파일 로거로 남긴다(Task 3) — 깨진 5.json, sessionId 없는 6.json 두 건.
    expect(logLines().filter((l) => l.src === "sessions")).toHaveLength(2);
  });

  it("sessions 폴더가 없으면 빈 배열", async () => {
    expect(await readSessions(h.home, NOW, () => true)).toEqual([]);
  });
});

describe("pidAlive", () => {
  it("현재 프로세스는 살아 있고, 끝난 프로세스는 죽었다", () => {
    expect(pidAlive(process.pid)).toBe(true);
    const done = spawnSync("true");
    expect(pidAlive(done.pid!)).toBe(false);
  });
});

describe("readSessions - procStart로 pid 재사용을 감지한다", () => {
  const file = { name: "x", cwd: "/x", status: "busy", startedAt: NOW - 5000 };
  const PROC_START = "Mon Sep 28 12:59:39 2026";

  it("procStart 불일치이면 alive=false로 덮어쓴다", async () => {
    await h.write("sessions/1.json", { ...file, pid: 1, sessionId: "s1", updatedAt: NOW - 1000, procStart: PROC_START });
    const matchProcStart = vi.fn().mockResolvedValue(false);
    const list = await readSessions(h.home, NOW, () => true, matchProcStart);
    expect(list).toMatchObject([{ sessionId: "s1", alive: false }]);
    expect(matchProcStart).toHaveBeenCalledWith(1, PROC_START);
  });

  it("procStart가 레코드에 남는다, 없으면 키가 없다(Phase 4a B114)", async () => {
    await h.write("sessions/1.json", { ...file, pid: 1, sessionId: "s1", updatedAt: NOW - 1000, procStart: PROC_START });
    await h.write("sessions/2.json", { ...file, pid: 2, sessionId: "s2", updatedAt: NOW - 1000 });
    const list = await readSessions(h.home, NOW, () => true, vi.fn().mockResolvedValue(true));
    const by = Object.fromEntries(list.map((r) => [r.sessionId, r]));
    expect(by.s1.procStart).toBe(PROC_START);
    expect("procStart" in by.s2).toBe(false);
  });

  it("procStart가 일치하면 alive=true를 유지한다", async () => {
    await h.write("sessions/1.json", { ...file, pid: 1, sessionId: "s1", updatedAt: NOW - 1000, procStart: PROC_START });
    const matchProcStart = vi.fn().mockResolvedValue(true);
    const list = await readSessions(h.home, NOW, () => true, matchProcStart);
    expect(list).toMatchObject([{ sessionId: "s1", alive: true }]);
  });

  it("procStart가 없으면 matcher를 부르지 않고 기존 판정을 그대로 쓴다", async () => {
    await h.write("sessions/1.json", { ...file, pid: 1, sessionId: "s1", updatedAt: NOW - 1000 });
    const matchProcStart = vi.fn().mockResolvedValue(false);
    const list = await readSessions(h.home, NOW, () => true, matchProcStart);
    expect(list).toMatchObject([{ sessionId: "s1", alive: true }]);
    expect(matchProcStart).not.toHaveBeenCalled();
  });

  it("matcher가 판단 불가(undefined)를 반환하면 기존 판정을 그대로 쓴다", async () => {
    await h.write("sessions/1.json", { ...file, pid: 1, sessionId: "s1", updatedAt: NOW - 1000, procStart: PROC_START });
    const matchProcStart = vi.fn().mockResolvedValue(undefined);
    const list = await readSessions(h.home, NOW, () => true, matchProcStart);
    expect(list).toMatchObject([{ sessionId: "s1", alive: true }]);
  });

  it("kill(pid,0)이 이미 죽었다고 판정하면 matcher를 부르지 않는다", async () => {
    await h.write("sessions/1.json", { ...file, pid: 1, sessionId: "s1", updatedAt: NOW - 1000, procStart: PROC_START });
    const matchProcStart = vi.fn().mockResolvedValue(true);
    const list = await readSessions(h.home, NOW, () => false, matchProcStart);
    expect(list).toMatchObject([{ sessionId: "s1", alive: false }]);
    expect(matchProcStart).not.toHaveBeenCalled();
  });
});

describe("readSessions - Windows 호환(Task 3)", () => {
  const file = { name: "x", cwd: "/x", status: "busy", startedAt: NOW - 5000 };
  const PROC_START = "Mon Sep 28 12:59:39 2026";

  it("platform이 win32이면 ps를 부르지 않고 pid 생존만으로 판정한다", async () => {
    await h.write("sessions/1.json", { ...file, pid: 1, sessionId: "s1", updatedAt: NOW - 1000, procStart: PROC_START });
    const list = await readSessions(h.home, NOW, () => true, undefined, "win32");
    expect(list).toMatchObject([{ sessionId: "s1", alive: true }]);
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe("readSessions - 읽을 수 없는 세션 파일(Task 3)", () => {
  it("읽을 수 없는 세션 파일은 건너뛰고 warn 한 줄, 로그엔 폴더 경로가 없다", async () => {
    await h.write("sessions/1.json", "{broken");
    const list = await readSessions(h.home, NOW, () => true);
    expect(list).toEqual([]);
    const lines = logLines().filter((l) => l.src === "sessions");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "warn" });
    expect(JSON.stringify(lines[0])).not.toContain(h.home); // 폴더 경로 없음, 파일 이름만
  });
});

describe("parseCTime", () => {
  it("두 자리 날짜를 UTC epoch ms로 변환한다", () => {
    expect(parseCTime("Mon Sep 28 12:59:39 2026")).toBe(Date.UTC(2026, 8, 28, 12, 59, 39));
  });

  it("한 자리 날짜의 공백 패딩('Sep  8' 같은 이중 공백)을 허용한다", () => {
    expect(parseCTime("Tue Sep  8 09:05:00 2026")).toBe(Date.UTC(2026, 8, 8, 9, 5, 0));
  });

  it("형식이 다르면 undefined를 반환한다", () => {
    expect(parseCTime("2026-09-28T12:59:39Z")).toBeUndefined();
    expect(parseCTime("not a date")).toBeUndefined();
    expect(parseCTime("")).toBeUndefined();
  });
});
