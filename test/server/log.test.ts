import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger, getLogger, scrub, type LogLine } from "../../server/log";

const T0 = Date.UTC(2026, 9, 1, 3);
const MIN = 60_000;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-log-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const lines = (day = "2026-10-01"): LogLine[] =>
  readFileSync(join(dir, `office-${day}.log`), "utf8").trim().split("\n").map((l) => JSON.parse(l));

describe("Logger", () => {
  it("한 줄에 JSON 하나, t·level·src·msg·data 필드", () => {
    new Logger({ dir, now: () => T0 }).info("server", "start", { port: 4318 });
    expect(lines()).toEqual([{ t: "2026-10-01T03:00:00.000Z", level: "info", src: "server", msg: "start", data: { port: 4318 } }]);
  });

  it("msg와 data의 가짜 비밀값과 홈 경로를 가린다", () => {
    new Logger({ dir, now: () => T0, home: "/Users/fakeuser" }).error("collect", "read /Users/fakeuser/.claude/x failed", {
      cmd: "curl -H 'Authorization: Bearer FAKE-TOKEN-abc123'",
      nested: ["api_key=FAKEKEY123"],
    });
    const text = readFileSync(join(dir, "office-2026-10-01.log"), "utf8");
    expect(text).not.toContain("fakeuser");
    expect(text).not.toContain("FAKE-TOKEN-abc123");
    expect(text).not.toContain("FAKEKEY123");
    expect(text).toContain("~/.claude/x");
  });

  it("같은 warn은 10분에 한 번, 억제 건수를 붙인다", () => {
    let now = T0;
    const log = new Logger({ dir, now: () => now });
    for (let i = 0; i < 5; i++) {
      now = T0 + i * 2 * MIN; // 0, 2, 4, 6, 8분
      log.warn("hub", "watch failed");
    }
    now = T0 + 10 * MIN + 1000;
    log.warn("hub", "watch failed");
    log.warn("hub", "other msg");
    log.error("hub", "boom");
    log.error("hub", "boom");
    const got = lines();
    expect(got.map((l) => l.msg)).toEqual(["watch failed", "watch failed", "other msg", "boom", "boom"]);
    expect(got[0].data).toBeUndefined();
    expect(got[1].data).toEqual({ suppressed: 4 });
  });

  it("5MB에 닿으면 그날은 더 쓰지 않는다", () => {
    let now = T0;
    const log = new Logger({ dir, now: () => now, maxBytes: 300 });
    for (let i = 0; i < 20; i++) log.info("server", "x".repeat(40));
    const file = join(dir, "office-2026-10-01.log");
    const got = lines();
    const last = got.at(-1)!;
    expect(last.msg).toBe("log cap reached");
    expect(got.filter((l) => l.msg === "log cap reached")).toHaveLength(1);
    expect(statSync(file).size).toBeLessThanOrEqual(300 + JSON.stringify(last).length + 1);
    now = T0 + 86_400_000;
    log.info("server", "next day");
    expect(lines("2026-10-02").map((l) => l.msg)).toEqual(["next day"]);
  });

  it("7일 지난 로그를 지운다", () => {
    for (const f of ["office-2026-09-23.log", "office-2026-09-25.log", "other.txt"]) writeFileSync(join(dir, f), "");
    new Logger({ dir, now: () => T0 }).cleanup();
    expect(readdirSync(dir).sort()).toEqual(["office-2026-09-25.log", "other.txt"]);
  });

  it("폴더가 없으면 만든다, 쓰기 실패는 던지지 않는다", () => {
    const sub = join(dir, "a", "b");
    new Logger({ dir: sub, now: () => T0 }).info("server", "start");
    expect(readdirSync(sub)).toEqual(["office-2026-10-01.log"]);
    const file = join(dir, "plain");
    writeFileSync(file, "");
    expect(() => new Logger({ dir: file }).info("server", "start")).not.toThrow();
  });

  it("errorsSince는 이 프로세스의 error 수를 센다", () => {
    let now = T0;
    const log = new Logger({ dir, now: () => now });
    log.error("a", "1");
    now = T0 + MIN;
    log.error("a", "2");
    log.warn("a", "w");
    expect(log.errorsSince(T0)).toBe(2);
    expect(log.errorsSince(T0 + 1)).toBe(1);
  });

  it("순환 객체와 BigInt가 있어도 던지지 않는다", () => {
    const log = new Logger({ dir, now: () => T0 });
    const c: Record<string, unknown> = {};
    c.self = c;
    expect(() => log.info("t", "x", { c })).not.toThrow();
    expect(() => log.info("t", "x", { n: 1n })).not.toThrow();
  });

  it("errors 기록은 24시간보다 오래된 것을 버린다", () => {
    let now = T0;
    const log = new Logger({ dir, now: () => now });
    log.error("a", "old");
    now = T0 + 86_400_000 + 1;
    log.error("a", "new");
    expect(log.errorsSince(0)).toBe(1);
  });

  it("getLogger 기본값은 아무 것도 쓰지 않는다", () => {
    const log = getLogger();
    expect(log.dir).toBe("");
    expect(() => log.error("x", "y")).not.toThrow();
  });
});

describe("scrub", () => {
  it("인코딩된 홈 경로(-Users-name-…)도 가린다", () => {
    const out = scrub("open '/Users/fakeuser/.claude/projects/-Users-fakeuser-Code-secret/a.jsonl'", "/Users/fakeuser") as string;
    expect(out).not.toContain("fakeuser");
    expect(out).toBe("open '~/.claude/projects/~-Code-secret/a.jsonl'");
  });

  it("객체 키도 가린다", () => {
    const out = JSON.stringify(scrub({ "/Users/fakeuser/x": { "api_key=FAKEKEY123": 1 } }, "/Users/fakeuser"));
    expect(out).not.toContain("fakeuser");
    expect(out).not.toContain("FAKEKEY123");
  });
});
