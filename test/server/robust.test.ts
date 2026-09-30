import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../server/app";
import { loadConfig, type OfficeConfig } from "../../server/config";
import { readTeams } from "../../server/collectors/teams";
import { SnapshotHub } from "../../server/hub";
import { checkNode } from "../../server/index";
import { Logger, setLogger, type LogLine } from "../../server/log";
import { emptySnapshot } from "../../server/snapshot";
import { makeHome, type FakeHome } from "../helpers/fakeHome";

let logDir: string;
let server: Server | undefined;
let hub: SnapshotHub | undefined;
beforeEach(() => {
  logDir = mkdtempSync(join(tmpdir(), "office-robust-"));
  setLogger(new Logger({ dir: logDir }));
});
afterEach(async () => {
  hub?.stop();
  hub = undefined;
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server!.close(r));
    server = undefined;
  }
  setLogger(new Logger({ dir: "" }));
  vi.restoreAllMocks();
  rmSync(logDir, { recursive: true, force: true });
});

const logLines = (): LogLine[] =>
  readdirSync(logDir).flatMap((f) => readFileSync(join(logDir, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)));

async function listen(app: ReturnType<typeof createApp>): Promise<string> {
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server!.once("listening", r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

const config = { budget: {}, contextWindows: {} } as OfficeConfig;

describe("checkNode", () => {
  it("24 미만이면 안내 문구, 이상이면 null", () => {
    expect(checkNode("v22.1.0")).toContain("Node.js 24");
    expect(checkNode("v22.1.0")).toContain("v22.1.0");
    expect(checkNode("v24.0.0")).toBeNull();
    expect(checkNode("v26.1.0")).toBeNull();
  });
});

describe("빌드 파일이 없을 때", () => {
  it("안내 HTML과 error 로그, /api/snapshot은 그대로 JSON", async () => {
    const empty = mkdtempSync(join(tmpdir(), "office-noweb-"));
    const snap = emptySnapshot(0, config);
    const base = await listen(createApp({ current: () => snap, subscribe: () => () => {} }, { staticDir: empty }));
    const r = await fetch(`${base}/`);
    expect(r.status).toBe(503);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(await r.text()).toContain("화면 파일이 없습니다 — 다시 설치해 주세요");
    const api = await fetch(`${base}/api/snapshot`);
    expect(api.status).toBe(200);
    expect(await api.json()).toMatchObject({ sessions: [] });
    const errs = logLines().filter((l) => l.level === "error" && l.msg === "static files missing");
    expect(errs).toHaveLength(1);
    expect(JSON.stringify(errs[0])).not.toContain(empty);
    rmSync(empty, { recursive: true, force: true });
  });
});

describe("첫 빌드 실패", () => {
  it("fallback 스냅샷으로 /api/snapshot이 200과 error를 돌려준다", async () => {
    hub = new SnapshotHub(
      { build: () => Promise.reject(new Error("boom")) },
      { fallback: () => emptySnapshot(Date.now(), config, "데이터를 읽지 못했습니다"), intervalMs: 60_000 },
    );
    await hub.start();
    expect(() => hub!.current()).not.toThrow();
    expect(hub.current().error).toBe("데이터를 읽지 못했습니다");
    const base = await listen(createApp(hub));
    const r = await fetch(`${base}/api/snapshot`);
    expect(r.status).toBe(200);
    expect((await r.json()).error).toBe("데이터를 읽지 못했습니다");
    expect(logLines().some((l) => l.src === "hub" && l.level === "error")).toBe(true);
  });

  it("다음 빌드가 성공하면 fallback을 대체한다", async () => {
    let fail = true;
    const good = emptySnapshot(0, config);
    hub = new SnapshotHub(
      { build: () => (fail ? Promise.reject(new Error("boom")) : Promise.resolve(good)) },
      { fallback: () => emptySnapshot(0, config, "x"), intervalMs: 60_000 },
    );
    await hub.start();
    fail = false;
    await hub.refresh();
    expect(hub.current().error).toBeUndefined();
  });
});

describe("빈 catch 대신 warn 로그", () => {
  let h: FakeHome;
  beforeEach(async () => {
    h = await makeHome();
  });
  afterEach(() => h.cleanup());

  it("readTeams: 깨진 config.json은 건너뛰고 teams warn 한 줄(내용·폴더 이름 없음)", async () => {
    await h.write("teams/secret-team/config.json", "{not json SECRETCONTENT");
    expect(await readTeams(h.home)).toEqual([]);
    const w = logLines().filter((l) => l.src === "teams" && l.level === "warn");
    expect(w).toHaveLength(1);
    expect(w[0].data).toMatchObject({ file: "config.json", error: "SyntaxError" });
    const text = JSON.stringify(w);
    expect(text).not.toContain("secret-team");
    expect(text).not.toContain("SECRETCONTENT");
  });

  it("팀원 이름이 든 파일 이름은 warn에 남지 않는다", async () => {
    await h.write("teams/t/config.json", { leadSessionId: "s1", members: [{ name: "fakemate", agentType: "general-purpose" }] });
    await h.write("teams/t/inboxes/fakemate.json", "{broken");
    await h.write("projects/-p/s1/subagents/agent-afakemate-1.meta.json", "{broken");
    // 기록 파일 자리에 폴더를 두면 읽기가 EISDIR로 실패한다(usage·snapshot 경로)
    await mkdir(h.path("projects/-p/s1/subagents/agent-afakemate-2.jsonl"), { recursive: true });
    await h.write("projects/-p/s1/subagents/agent-afakemate-2.meta.json", { name: "fakemate" });
    const { UsageCollector } = await import("../../server/collectors/usage");
    await readTeams(h.home);
    await new UsageCollector(h.path("projects")).refresh();
    const text = readdirSync(logDir).map((f) => readFileSync(join(logDir, f), "utf8")).join("");
    expect(text).toContain('"src":"teams"');
    expect(text).toContain('"src":"usage"');
    expect(text).not.toContain("fakemate");
  });

  it("readTeams: 받은편지함이 없는(ENOENT) 것은 조용히 넘긴다", async () => {
    await h.write("teams/t/config.json", { leadSessionId: "s1", members: [{ name: "dev", agentType: "general-purpose" }] });
    const teams = await readTeams(h.home);
    expect(teams[0].members[0].unread).toBe(0);
    expect(logLines()).toEqual([]);
  });

  it("loadConfig: 깨진 JSON은 기본값 + config warn", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = join(logDir, "..", `office-cfg-${process.pid}.json`);
    writeFileSync(p, "{broken");
    try {
      expect(await loadConfig(p)).toEqual({ budget: {}, contextWindows: {} });
    } finally {
      rmSync(p, { force: true });
    }
    const w = logLines().filter((l) => l.src === "config" && l.level === "warn");
    expect(w).toHaveLength(1);
    expect(w[0].data).toMatchObject({ error: "SyntaxError" });
  });
});
