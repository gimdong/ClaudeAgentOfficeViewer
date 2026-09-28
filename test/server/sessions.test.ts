import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { pidAlive, readSessions } from "../../server/collectors/sessions";
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
