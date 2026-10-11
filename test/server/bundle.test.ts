import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBundle, pseudonymize, writeBundle, type DiagBundle } from "../../server/diag/bundle";
import type { DoctorItem } from "../../server/diag/doctor";
import { HookStats } from "../../server/events/stats";
import type { Snapshot } from "../../src/shared/types";
import { emptySnapshot } from "../../server/snapshot";
import { DecisionQueue } from "../../server/decisions/queue";
import { Logger, setLogger } from "../../server/log";
import { PolicyStore } from "../../server/policy/store";
import { PolicyGate } from "../../server/policy/gate";
import { FloorControl } from "../../server/floors/control";

const NOW = Date.UTC(2026, 9, 1, 3);
const HOME = "/Users/fakeuser";
let logDir: string;
let outDir: string;
beforeEach(() => {
  logDir = mkdtempSync(join(tmpdir(), "office-bundle-log-"));
  outDir = mkdtempSync(join(tmpdir(), "office-bundle-out-"));
});
afterEach(() => {
  rmSync(logDir, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
});

const doctor = async (): Promise<DoctorItem[]> => [{ id: "node", status: "ok", title: "Node.js", detail: "버전 24", fix: "" }];
const line = (t: string, msg: string, data?: unknown) => JSON.stringify({ t, level: "warn", src: "test", msg, ...(data ? { data } : {}) });
const writeLog = (day: string, lines: string[]) => writeFileSync(join(logDir, `office-${day}.log`), lines.join("\n") + "\n");

function snapshotWithNames(): Snapshot {
  const s = emptySnapshot(NOW, { budget: {}, contextWindows: {} });
  const member = (name: string) => ({ name, role: name, state: "idle", unread: 0, tokens: s.usage.today }) as unknown as Snapshot["sessions"][number]["members"][number];
  s.sessions = [
    { id: "sess-1", name: "secret-project-x", cwd: `${HOME}/work`, alive: true, isCurrent: true, status: "idle", floor: 1, floorStatus: "idle", context: null, members: [member("team-lead"), member("alice-fake")] },
    { id: "sess-2", name: "other", cwd: `${HOME}/b`, alive: true, isCurrent: false, status: "idle", floor: 2, floorStatus: "idle", context: null, members: [member("team-lead")] },
  ] as Snapshot["sessions"];
  s.decisionCount = 2;
  return s;
}

const base = (o: Partial<Parameters<typeof buildBundle>[0]> = {}) =>
  buildBundle({ doctor, hooks: new HookStats(() => NOW).view(), snapshot: snapshotWithNames(), logDir, home: HOME, now: () => NOW, appVersion: "2.0.0-beta.1", claudeVersion: "9.9.9", ...o });

describe("buildBundle", () => {
  it("진단 파일에 가짜 비밀값·홈 경로·세션·팀원 이름이 없다", async () => {
    writeLog("2026-10-01", [
      line("2026-10-01T01:00:00.000Z", "read /Users/fakeuser/.claude/x failed", { cmd: "curl -H 'Authorization: Bearer FAKE-TOKEN-abc123'" }),
      // 로거를 거치지 않고 직접 쓴 줄
      "raw api_key=FAKEKEY123 at /Users/fakeuser/work",
    ]);
    const b = await base();
    const text = JSON.stringify(b);
    for (const bad of ["FAKE-TOKEN", "FAKEKEY123", "fakeuser", "secret-project-x", "alice-fake", "sess-1"]) expect(text).not.toContain(bad);
    expect(b.snapshot).toEqual({ sessions: 2, members: 3, teams: 1, decisions: 2, error: false });
    expect(b.versions).toMatchObject({ app: "2.0.0-beta.1", claude: "9.9.9" });
    expect(b.kind).toBe("claude-office-diag");
    expect(b.doctor).toHaveLength(1);
  });

  it("프로젝트·팀 폴더 이름은 순번으로 바꾸고, 같은 이름은 같은 번호", async () => {
    writeLog("2026-10-01", [
      line("2026-10-01T01:00:00.000Z", "open /Users/fakeuser/.claude/projects/-Users-fakeuser-Code-fake-proj-alpha/s1.jsonl"),
      line("2026-10-01T01:01:00.000Z", "cwd /Users/fakeuser/Code/fake-proj-alpha/src", { dir: "-Users-fakeuser-Code-fake-proj-alpha" }),
      line("2026-10-01T01:02:00.000Z", "open /Users/fakeuser/.claude/projects/-Users-fakeuser-Code-fake-proj-beta/s2.jsonl"),
      line("2026-10-01T01:03:00.000Z", "scandir /Users/fakeuser/.claude/teams/fake-team-gamma/inboxes"),
      line("2026-10-01T01:04:00.000Z", "again /Users/fakeuser/.claude/teams/fake-team-gamma"),
    ]);
    const b = await base();
    const text = b.logs.flatMap((l) => l.lines).join("\n");
    expect(text).not.toMatch(/fake-proj-alpha|fake-proj-beta|fake-team-gamma|fakeuser/);
    const alpha = [...text.matchAll(/<project-\d+>/g)].map((m) => m[0]);
    // alpha는 1·2번째 줄에 세 번(인코딩 폴더, 경로, data의 인코딩 이름), beta는 3번째 줄에 한 번
    const lines = b.logs[0].lines;
    const nums = (s: string) => [...s.matchAll(/<project-\d+>/g)].map((m) => m[0]);
    const a = [...nums(lines[0]), ...nums(lines[1])];
    expect(new Set(a).size).toBe(1);
    expect(a.length).toBeGreaterThanOrEqual(3);
    expect(nums(lines[2])).toHaveLength(1);
    expect(nums(lines[2])[0]).not.toBe(a[0]);
    expect(alpha.length).toBe(a.length + 1);
    const teams = [...lines[3].matchAll(/<team-\d+>/g), ...lines[4].matchAll(/<team-\d+>/g)].map((m) => m[0]);
    expect(teams).toEqual(["<team-1>", "<team-1>"]);
    expect(lines[0]).toContain("~/.claude/projects/");
  });

  it("5MB를 넘으면 오래된 로그부터 버린다", async () => {
    const pad = "x".repeat(200);
    writeLog("2026-09-29", [line("2026-09-29T01:00:00.000Z", `old ${pad}`), line("2026-09-29T02:00:00.000Z", `old ${pad}`)]);
    writeLog("2026-09-30", [line("2026-09-30T01:00:00.000Z", `mid ${pad}`)]);
    writeLog("2026-10-01", [line("2026-10-01T01:00:00.000Z", `new ${pad}`)]);
    const b = await base({ maxBytes: 2000 });
    expect(b.truncated).toBe(true);
    expect(b.logs.map((l) => l.file)).not.toContain("office-2026-09-29.log");
    expect(b.logs[0].file).toBe("office-2026-10-01.log");
    expect(Buffer.byteLength(JSON.stringify(b, null, 2))).toBeLessThanOrEqual(2000);
  });

  it("파일 하나가 너무 크면 그 파일의 오래된 줄부터 버린다", async () => {
    writeLog("2026-10-01", Array.from({ length: 50 }, (_, i) => line(`2026-10-01T01:${String(i).padStart(2, "0")}:00.000Z`, `n${i} ${"y".repeat(100)}`)));
    const b = await base({ maxBytes: 3000 });
    expect(b.truncated).toBe(true);
    const lines = b.logs[0].lines;
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.at(-1)).toContain("n49");
    expect(Buffer.byteLength(JSON.stringify(b, null, 2))).toBeLessThanOrEqual(3000);
  });

  it("7일 넘은 로그는 넣지 않고, 다른 파일도 넣지 않는다", async () => {
    writeLog("2026-09-23", [line("2026-09-23T01:00:00.000Z", "too old")]);
    writeLog("2026-09-25", [line("2026-09-25T01:00:00.000Z", "ok")]);
    writeFileSync(join(logDir, "install-20261001.log"), "이름 형식이 다른 파일\n");
    writeFileSync(join(logDir, "notes.txt"), "other\n");
    const b = await base();
    expect(b.logs.map((l) => l.file)).toEqual(["office-2026-09-25.log"]);
    expect(b.truncated).toBe(false);
  });

  it("설치 로그(install-YYYYMMDD-HHMMSS.log)도 넣고, 경로·비밀값은 가리며, 8일 전 것은 뺀다", async () => {
    const local = (d: Date) =>
      `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;
    const recent = `install-${local(new Date(NOW - 3_600_000))}.log`;
    const old = `install-${local(new Date(NOW - 8 * 86_400_000))}.log`;
    writeFileSync(
      join(logDir, recent),
      [
        "2026-10-01T02:00:00.000Z node ok v24.1.0",
        "2026-10-01T02:00:01.000Z copy ok /Users/fakeuser/Code/fake-proj-alpha/src",
        "2026-10-01T02:00:02.000Z plugin fail token=FAKE-sk-ant-xxx /Users/fakeuser/Code/My Secret Client/app.ts",
      ].join("\n") + "\n",
    );
    writeFileSync(join(logDir, old), "2026-09-23T02:00:00.000Z node ok v24.1.0\n");
    writeLog("2026-10-01", [line("2026-10-01T01:00:00.000Z", "start")]);
    const b = await base();
    expect(b.logs.map((l) => l.file)).toContain(recent);
    expect(b.logs.map((l) => l.file)).not.toContain(old);
    const text = JSON.stringify(b);
    for (const bad of ["fakeuser", "fake-proj-alpha", "FAKE-sk-ant", "Secret", "Client"]) expect(text).not.toContain(bad);
    const install = b.logs.find((l) => l.file === recent)!.lines;
    expect(install[0]).toBe("2026-10-01T02:00:00.000Z node ok v24.1.0");
    expect(install[1]).toMatch(/^2026-10-01T02:00:01\.000Z copy ok ~\/Code\/<project-\d+>\/<item-\d+>$/);
  });

  it("상한에서는 종류와 관계없이 날짜가 가장 오래된 로그부터 버린다", async () => {
    const pad = "z".repeat(300);
    writeLog("2026-09-29", [line("2026-09-29T01:00:00.000Z", `office-old ${pad}`)]);
    writeFileSync(join(logDir, "install-20260930-120000.log"), `2026-09-30T03:00:00.000Z copy ok ${pad}\n`);
    writeLog("2026-10-01", [line("2026-10-01T01:00:00.000Z", `office-new ${pad}`)]);
    const all = await base();
    expect(all.logs.map((l) => l.file)).toEqual(["office-2026-10-01.log", "install-20260930-120000.log", "office-2026-09-29.log"]);
    const size = Buffer.byteLength(JSON.stringify(all, null, 2));
    const cut = await base({ maxBytes: size - 100 });
    expect(cut.logs.map((l) => l.file)).toEqual(["office-2026-10-01.log", "install-20260930-120000.log"]);
  });

  it("로그 폴더가 없으면 로그 없이 만든다", async () => {
    const b = await base({ logDir: join(logDir, "nope") });
    expect(b.logs).toEqual([]);
  });
});

describe("결정 통계(Phase 2)", () => {
  /** express Response 중 큐가 쓰는 부분만 흉내 낸다(queue.test와 같은 모양) */
  const fakeRes = () => ({ writableEnded: false, on() {}, status: () => ({ json() {}, end() {} }) });
  const req = (tool: string, toolInput: Record<string, unknown>) => ({ hook_event_name: "PermissionRequest", session_id: "s1", tool_name: tool, tool_input: toolInput });

  it("decisions 통계가 들어가고, 토큰 값·거부 이유·답 내용·도구 입력이 없다", async () => {
    const FAKE_TOKEN = "e".repeat(64);
    writeFileSync(join(logDir, "token"), FAKE_TOKEN); // 같은 폴더에 있어도 진단 파일은 읽지 않는다
    setLogger(new Logger({ dir: logDir, now: () => NOW, home: HOME })); // 큐가 남기는 결정 로그도 진단 파일에 들어간다
    const q = new DecisionQueue({ now: () => NOW });
    try {
      const a = q.hold(req("Bash", { command: "echo FAKE-COMMAND-xyz" }), fakeRes())!;
      q.answer(a.id, { action: "deny", reason: "FAKE-REASON-xyz" });
      const b = q.hold(req("AskUserQuestion", { questions: [{ question: "FAKE-QUESTION?", multiSelect: false, options: [{ label: "FAKE-LABEL" }] }] }), fakeRes())!;
      q.answer(b.id, { action: "answer", answers: [{ other: "FAKE-ANSWER-xyz" }] });
      q.hold(req("Write", { file_path: "/tmp/FAKE-PATH" }), fakeRes()); // 아직 대기 중
      const bundle = await base({ decisions: q.stats() });
      expect(bundle.decisions.byKind).toMatchObject({ permission: 2, question: 1 });
      expect(bundle.decisions.byState).toMatchObject({ pending: 1, "answered-dashboard": 2 });
      const text = JSON.stringify(bundle);
      for (const bad of [FAKE_TOKEN, "FAKE-REASON", "FAKE-ANSWER", "FAKE-COMMAND", "FAKE-QUESTION", "FAKE-LABEL", "FAKE-PATH"]) expect(text, bad).not.toContain(bad);
    } finally {
      q.stop();
      setLogger(new Logger({ dir: "" }));
    }
  });

  it("decisions를 주지 않으면 0으로 채운다", async () => {
    const b = await base();
    expect(b.decisions).toEqual({
      byKind: { permission: 0, question: 0, plan: 0, budget: 0, team: 0 },
      byState: { pending: 0, "answered-dashboard": 0, "closed-terminal": 0, expired: 0 },
    });
  });
});

describe("권한 정책 통계(Phase 3)", () => {
  it("policy 통계가 입력 그대로 들어간다", async () => {
    const policy = { targets: 3, rulesByKind: { lead: 1, agent: 2, sub: 0, others: 1 }, decisions: { deny: 4, ask: 2 } };
    expect((await base({ policy })).policy).toEqual(policy);
  });

  it("진단 파일 전체에 대상 이름과 도구 입력이 없다(실제 PolicyStore·PolicyGate·Logger)", async () => {
    const NAME = "FAKE-NAME-rev";
    const TYPE = "FAKE-TYPE-X";
    const CMD = "FAKE-CMD-policy-777";
    setLogger(new Logger({ dir: logDir, now: () => NOW, home: HOME }));
    try {
      const store = new PolicyStore(join(outDir, "policy.json"));
      store.set(`agent:${NAME}`, { bash: "deny", web: "ask" });
      store.set(`sub:${TYPE}`, { edit: "deny" });
      const gate = new PolicyGate(store, { now: () => NOW });
      const pre = (tool: string, who: Record<string, string>) => ({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: tool, tool_input: { command: CMD, file_path: `/tmp/${CMD}` }, ...who });
      const teammate = { agent_id: `a${NAME}-1`, agent_type: NAME };
      const sub = { agent_id: "a1b2c3d4e5f6a7b8", agent_type: TYPE };
      for (const [tool, who, decision] of [["Bash", teammate, "deny"], ["WebFetch", teammate, "ask"], ["Edit", sub, "deny"]] as const) {
        const v = gate.preToolUse(pre(tool, who));
        expect(v?.decision, tool).toBe(decision);
        v!.respond();
      }
      const b = await base({ policy: { ...store.summary(), decisions: gate.totals() } });
      expect(b.policy).toEqual({ targets: 2, rulesByKind: { lead: 0, agent: 2, sub: 1, others: 0 }, decisions: { deny: 2, ask: 1 } });
      const text = JSON.stringify(b);
      expect(text.includes('"src\\":\\"policy\\"')).toBe(true); // 정책 로그 줄이 실제로 들어갔다
      for (const bad of [NAME, TYPE, CMD]) {
        const leaked = text.includes(bad);
        expect(leaked, bad).toBe(false);
      }
    } finally {
      setLogger(new Logger({ dir: "" }));
    }
  });

  it("policy를 주지 않으면 0으로 채운다", async () => {
    expect((await base()).policy).toEqual({ targets: 0, rulesByKind: { lead: 0, agent: 0, sub: 0, others: 0 }, decisions: { deny: 0, ask: 0 } });
  });
});

describe("층 관리 통계(Phase 4a)", () => {
  it("floors 수가 입력 그대로 들어간다", async () => {
    const floors = { paused: 2, hidden: 3, terminating: 1 };
    expect((await base({ floors })).floors).toEqual(floors);
  });

  it("floors를 주지 않으면 0으로 채운다", async () => {
    expect((await base()).floors).toEqual({ paused: 0, hidden: 0, terminating: 0 });
  });

  it("진단 파일 전체에 명령 원문·cwd·홈 경로가 없다(실제 FloorControl·Logger)", async () => {
    const CMD = "FAKE-CMD-123";
    const CWD = `${HOME}/Code/FAKE-CWD-floor`;
    setLogger(new Logger({ dir: logDir, now: () => NOW, home: HOME }));
    try {
      const signals: Array<[number, string]> = [];
      const fc = new FloorControl({ signal: (pid, sig) => void signals.push([pid, sig]), matchProcStart: async () => true, selfPid: 1, now: () => NOW });
      const rec = { pid: 4242, sessionId: "sess-floor-1", name: "FAKE-NAME-floor", cwd: CWD, status: "busy", startedAt: NOW, updatedAt: NOW, alive: true, procStart: "Mon Oct  6 10:00:00 2026" };
      fc.pause(rec.sessionId);
      for (const tool of ["Bash", "Edit"]) expect(fc.preToolUse({ hook_event_name: "PreToolUse", session_id: rec.sessionId, tool_name: tool, tool_input: { command: CMD, file_path: `${CWD}/${CMD}` }, cwd: CWD })).not.toBeNull();
      fc.resume(rec.sessionId);
      expect((await fc.terminate(rec, false)).ok).toBe(true);
      expect(signals).toEqual([[4242, "SIGTERM"]]);
      const b = await base({ floors: fc.stats() });
      expect(b.floors).toEqual({ paused: 0, hidden: 0, terminating: 1 });
      const text = JSON.stringify(b);
      expect(text.includes('"src\\":\\"floors\\"')).toBe(true); // 층 관리 로그 줄이 실제로 들어갔다
      // 로그의 세션 표시는 순번이다(B125·B129): 레코드의 세션 id도 진단 파일에 없어야 한다
      for (const bad of [CMD, "FAKE-CWD-floor", "FAKE-NAME-floor", HOME, rec.sessionId]) {
        const leaked = text.includes(bad);
        expect(leaked, bad).toBe(false);
      }
    } finally {
      setLogger(new Logger({ dir: "" }));
    }
  });
});

describe("pseudonymize", () => {
  it("이 프로그램의 폴더와 로그·진단 파일 이름은 그대로 둔다", () => {
    const map = new Map<string, string>();
    expect(pseudonymize("~/.claude-office/logs/office-2026-10-01.log", map)).toBe("~/.claude-office/logs/office-2026-10-01.log");
    expect(pseudonymize("~/.claude/claude-office/limits.json", map)).toBe("~/.claude/claude-office/limits.json");
    expect(pseudonymize("~/.claude-office/app/fake-secret", map)).toBe("~/.claude-office/app/<item-1>");
  });

  it("경로 조각은 공백을 포함한다(뒤 단어가 남지 않는다)", () => {
    const map = new Map<string, string>();
    expect(pseudonymize("open ~/Code/My Secret Client/app.ts", map)).toBe("open ~/Code/<project-1>/<item-1>");
    expect(pseudonymize('{"msg":"read ~/Documents/AcmeCorp Deal/notes.md","x":1}', map)).toBe('{"msg":"read ~/Documents/<project-2>/<item-2>","x":1}');
    // 같은 폴더를 Claude Code 인코딩으로 본 이름도 같은 번호
    expect(pseudonymize("~-Code-My-Secret-Client", map)).toBe("<project-1>");
  });

  it("이미 바꾼 것은 다시 바꾸지 않는다", () => {
    const map = new Map<string, string>();
    const once = pseudonymize("a ~/.claude/teams/t1 b ~-Code-p1", map);
    expect(pseudonymize(once, map)).toBe(once);
  });
});

describe("writeBundle", () => {
  it("dir 안에만 쓰고 이름만 돌려준다", async () => {
    const b: DiagBundle = await base();
    const name = await writeBundle(join(outDir, "diagnostics"), b);
    expect(name).toMatch(/^claude-office-diag-\d{8}-\d{6}\.json$/);
    expect(name).not.toMatch(/[\/\\]/);
    const file = join(outDir, "diagnostics", name);
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).kind).toBe("claude-office-diag");
  });
});
