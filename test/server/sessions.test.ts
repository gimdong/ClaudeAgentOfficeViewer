import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { parseCTime, pidAlive, readSessions } from "../../server/collectors/sessions";
import { makeHome, type FakeHome } from "../helpers/fakeHome";

const NOW = Date.now();
let h: FakeHome;
beforeEach(async () => {
  h = await makeHome();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await h.cleanup();
});

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
    expect(console.warn).toHaveBeenCalledTimes(2);
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
