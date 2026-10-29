import { chmodSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownFile, parseCTime, pidAlive, readSessions } from "../../server/collectors/sessions";
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

  it("빠른 시작용 예비 프로세스(spare: true) 기록은 층이 아니다(버그 2)", async () => {
    await h.write("sessions/11.json", { pid: 11, sessionId: "real", name: "real", cwd: "/r", status: "idle", kind: "interactive", updatedAt: NOW - 1000 });
    await h.write("sessions/12.json", { pid: 12, sessionId: "spare-1", cwd: "/r", status: "idle", kind: "bg", agent: "claude", spare: true, updatedAt: NOW - 1000 });
    await h.write("sessions/13.json", { pid: 13, sessionId: "not-spare", cwd: "/r", status: "idle", spare: "true", updatedAt: NOW - 1000 }); // 불리언 true만
    const list = await readSessions(h.home, NOW, () => true);
    expect(list.map((s) => s.sessionId).sort()).toEqual(["not-spare", "real"]);
  });

  describe("대시보드로 띄운 층의 두 기록 합치기(버그 3, B192 — parkedJobId·jobId는 문서에 없는 관찰 필드)", () => {
    const INTER = "6b626eda-0000-4000-8000-000000000001";
    const BG = "80673844-48d8-4000-8000-000000000002";
    const seed = async (o: { interAlive?: boolean; bgKind?: string } = {}) => {
      await h.write("sessions/21.json", { pid: 21, sessionId: INTER, name: "launched", cwd: "/w", status: "idle", kind: "interactive", tmux: "co-1", parkedJobId: "80673844", startedAt: NOW - 60_000, updatedAt: NOW - 50_000 });
      await h.write("sessions/22.json", { pid: 22, sessionId: BG, name: "launched", cwd: "/w", status: "busy", kind: o.bgKind ?? "bg", jobId: "80673844", startedAt: NOW - 55_000, updatedAt: NOW - 1_000 });
      return readSessions(h.home, NOW, (pid) => (pid === 21 ? o.interAlive ?? true : true));
    };

    it("살아 있는 interactive의 parkedJobId = bg의 jobId면 층 하나: 신원은 interactive, 대화(convId·상태·갱신 시각)는 bg", async () => {
      const list = await seed();
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ pid: 21, sessionId: INTER, convId: BG, status: "busy", updatedAt: NOW - 1_000, alive: true });
    });

    it("bg 프로세스가 죽었으면 상태는 interactive 쪽 값(B194 M1)", async () => {
      await h.write("sessions/21.json", { pid: 21, sessionId: INTER, name: "launched", cwd: "/w", status: "idle", kind: "interactive", parkedJobId: "80673844", updatedAt: NOW - 50_000 });
      await h.write("sessions/22.json", { pid: 22, sessionId: BG, name: "launched", cwd: "/w", status: "busy", kind: "bg", jobId: "80673844", updatedAt: NOW - 1_000 });
      const list = await readSessions(h.home, NOW, (pid) => pid === 21);
      expect(list).toEqual([expect.objectContaining({ sessionId: INTER, convId: BG, status: "idle" })]);
    });

    it("같은 jobId를 가리키는 살아 있는 기록이 둘이면 첫 짝만 합친다(B194 M2)", async () => {
      await seed();
      await h.write("sessions/20.json", { pid: 20, sessionId: "dup", name: "dup", cwd: "/w", status: "idle", kind: "interactive", parkedJobId: "80673844", updatedAt: NOW - 1_000 });
      const list = await readSessions(h.home, NOW, () => true);
      expect(list.filter((s) => s.convId === BG)).toHaveLength(1);
      expect(list.map((s) => s.sessionId).sort()).toEqual(["dup", INTER].sort());
    });

    it("interactive가 죽으면 짝을 풀어 bg가 혼자 층으로 남는다", async () => {
      const list = await seed({ interAlive: false });
      expect(list.map((s) => [s.sessionId, s.convId]).sort()).toEqual([[BG, undefined], [INTER, undefined]].sort());
    });

    it("대안 A(beta.23 설계 7.5): 합친 층은 bg 쪽 pid·이름·폴더·시작 시각과, 짝이 하나인지·두 기록 파일을 믿을 수 있는지를 남긴다", async () => {
      const [r] = await seed();
      expect(r.bg).toEqual({ pid: 22, alive: true, name: "launched", cwd: "/w", startedAt: NOW - 55_000, trusted: true });
    });

    it("L1: 같은 parkedJobId의 앞면이 둘이거나 같은 jobId의 bg가 둘이면 ambiguous(버튼을 끈다)", async () => {
      await h.write("sessions/20.json", { pid: 20, sessionId: "dup", name: "dup", cwd: "/w", status: "idle", kind: "interactive", parkedJobId: "80673844", updatedAt: NOW - 1_000 });
      let list = await seed();
      expect(list.find((x) => x.convId)?.bg?.ambiguous).toBe(true);
      await h.cleanup();
      h = await makeHome();
      await h.write("sessions/23.json", { pid: 23, sessionId: "bg-dup", name: "x", cwd: "/w", status: "idle", kind: "bg", jobId: "80673844", updatedAt: NOW - 1_000 });
      list = await seed();
      expect(list.find((x) => x.convId)?.bg?.ambiguous).toBe(true);
      // 죽은 bg 기록은 세지 않는다(리뷰 #3-10)
      list = await readSessions(h.home, NOW, (pid) => pid !== 23);
      expect(list.find((x) => x.convId)?.bg?.ambiguous).toBeUndefined();
    });

    it.skipIf(process.platform === "win32")("남이 쓸 수 있는 기록 파일이면 trusted가 아니다(S2 — 버튼 판단에 쓰는 기록)", async () => {
      await seed();
      chmodSync(h.path("sessions/22.json"), 0o666);
      const [r] = await readSessions(h.home, NOW, () => true);
      expect(r.bg?.trusted).toBe(false);
    });

    it.skipIf(process.platform === "win32")("beta.24(security #4 d, 리뷰 #4-1·4): 그룹 쓰기는 Linux에서 파일 그룹이 내 주 그룹일 때만 — macOS(staff 공유)·다른 그룹·남 쓰기는 거절", () => {
      const st = (mode: number, gid = process.getgid!(), uid = process.getuid!()) => ({ isFile: () => true, uid, gid, mode });
      expect(ownFile(st(0o600))).toBe(true);
      expect(ownFile(st(0o664), "linux")).toBe(true);
      expect(ownFile(st(0o664, process.getgid!() + 1), "linux")).toBe(false);
      expect(ownFile(st(0o664), "darwin")).toBe(false);
      expect(ownFile(st(0o646), "linux")).toBe(false);
      expect(ownFile(st(0o644, process.getgid!(), process.getuid!() + 1))).toBe(false);
    });

    it("kind가 bg가 아니면 짝짓지 않는다. 짝 없는 bg(평범한 --bg 세션)는 그대로 보인다", async () => {
      expect((await seed({ bgKind: "interactive" })).map((s) => s.sessionId).sort()).toEqual([BG, INTER].sort());
      await h.write("sessions/23.json", { pid: 23, sessionId: "plain-bg", cwd: "/p", status: "idle", kind: "bg", jobId: "deadbeef", updatedAt: NOW - 1000 });
      expect((await readSessions(h.home, NOW, () => true)).some((s) => s.sessionId === "plain-bg" && s.convId === undefined)).toBe(true);
    });
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
