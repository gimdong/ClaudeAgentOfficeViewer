import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookStats } from "../../server/events/stats";
import { Logger, setLogger } from "../../server/log";

const T0 = Date.UTC(2026, 9, 1, 3);
const MIN = 60_000;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-stats-"));
});
afterEach(() => {
  setLogger(new Logger({ dir: "" }));
  rmSync(dir, { recursive: true, force: true });
});

describe("HookStats", () => {
  it("이벤트별 수, 마지막 시각, 거부 수", () => {
    const s = new HookStats(() => T0);
    s.accept("PreToolUse");
    s.accept("PreToolUse");
    s.accept("Stop");
    s.reject("403");
    s.reject("413");
    expect(s.view()).toEqual({
      total: 3,
      byEvent: { PreToolUse: 2, Stop: 1 },
      lastAt: "2026-10-01T03:00:00.000Z",
      rejected: { "403": 1, "415": 0, "413": 1, "400": 0 },
      last10min: 3,
    });
  });

  it("아무것도 받지 않았으면 lastAt은 null", () => {
    expect(new HookStats(() => T0).view()).toMatchObject({ total: 0, lastAt: null, last10min: 0 });
  });

  it("last10min은 10분 안의 수신만", () => {
    let now = T0;
    const s = new HookStats(() => now);
    s.accept("A");
    now = T0 + 5 * MIN;
    s.accept("A");
    now = T0 + 11 * MIN;
    expect(s.view()).toMatchObject({ total: 2, last10min: 1 });
    now = T0 + 16 * MIN;
    expect(s.view()).toMatchObject({ total: 2, last10min: 0 });
  });

  it("summarize는 바뀌었을 때만 로그", () => {
    setLogger(new Logger({ dir, now: () => T0 }));
    const s = new HookStats(() => T0);
    s.summarize();
    s.summarize();
    s.accept("Stop");
    s.summarize();
    const lines = readFileSync(join(dir, readdirSync(dir)[0]), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.src === "hooks" && l.msg === "summary")).toBe(true);
    expect(lines[1].data).toMatchObject({ total: 1, byEvent: { Stop: 1 } });
  });
});
