import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PairingBook } from "../../server/floors/pairing";
import { MAX_FLOOR_FILE, MAX_FLOOR_REPORTS, ReportStore, SEEN_SAVE_MS, STALE_FLOOR_MS } from "../../server/floors/reports";
import { Logger, setLogger } from "../../server/log";

// Phase 6b Task 2: 보고서 저장소(스펙 5장·11장 g)와 PreToolUse·제출 짝짓기(B311)
let dir: string;
let file: string;
let clock: number;
beforeEach(() => {
  setLogger(new Logger({ dir: "" }));
  dir = mkdtempSync(join(tmpdir(), "co-reports-"));
  file = join(dir, "reports.json");
  clock = 1_000_000;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const store = () => new ReportStore({ file, now: () => clock });
const rid = (n: number) => `r-${n.toString(16).padStart(8, "0")}`;

describe("ReportStore — 요청 id는 한 번만, 그 층·그 종류만", () => {
  it("expect한 요청 id만 받고, 다른 층·다른 종류·두 번째·모르는 id는 null", () => {
    const s = store();
    s.expect(rid(1), "s1", "report");
    s.expect(rid(2), "s1", "handover", "builder");
    expect(s.take(rid(1), "s2", "report")).toBeNull();
    expect(s.take(rid(1), "s1", "handover")).toBeNull();
    expect(s.take(rid(1), "s1", "report")).toMatchObject({ floor: "s1", kind: "report" });
    expect(s.take(rid(1), "s1", "report")).toBeNull();
    expect(s.take(rid(9), "s1", "report")).toBeNull();
    expect(s.take(rid(2), "s1", "handover")).toMatchObject({ member: "builder" });
  });
});

describe("ReportStore — 파일(0600·원자 쓰기)·다시 켜도 남음", () => {
  it("보고서를 더하면 0600 파일에 원자적으로 쓰고(임시 파일 남지 않음), 새 저장소가 다시 읽는다", () => {
    const s = store();
    s.add("s1", { id: rid(1), kind: "report", title: "주간", body: "본문" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["reports.json"]);
    expect(store().list("s1")).toMatchObject([{ id: rid(1), kind: "report", title: "주간", body: "본문", state: "pending" }]);
  });

  it("깨진 파일은 빈 것으로 시작하고 덮어쓰기 전에 .broken으로 남긴다", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, "{oops", { mode: 0o600 });
    const s = store();
    expect(s.list("s1")).toEqual([]);
    s.add("s1", { id: rid(1), kind: "report", title: "t", body: "b" });
    expect(existsSync(`${file}.broken`)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).floors.s1.reports).toHaveLength(1);
  });

  it("최신 먼저로 돌려주고, 상태를 바꿀 수 있다(대기·승인됨·수정 요청)", () => {
    const s = store();
    s.add("s1", { id: rid(1), kind: "report", title: "a", body: "a" });
    clock += 1;
    s.add("s1", { id: rid(2), kind: "report", title: "b", body: "b" });
    expect(s.list("s1").map((r) => r.id)).toEqual([rid(2), rid(1)]);
    expect(s.setState("s1", rid(1), "approved")).toBe(true);
    expect(s.setState("s1", rid(9), "approved")).toBe(false);
    expect(s.list("s1").find((r) => r.id === rid(1))!.state).toBe("approved");
  });
});

describe(`ReportStore — 상한(층마다 ${MAX_FLOOR_REPORTS}개, 파일 ${MAX_FLOOR_FILE}개)·보관함·오래된 층 정리`, () => {
  it(`${MAX_FLOOR_REPORTS}개를 넘으면 가장 오래된 승인된 것부터 지운다`, () => {
    const s = store();
    for (let i = 0; i < MAX_FLOOR_REPORTS; i++) {
      s.add("s1", { id: rid(i), kind: "report", title: "t", body: "b" });
      if (i < 3) s.setState("s1", rid(i), "approved");
      clock += 1;
    }
    s.add("s1", { id: rid(1000), kind: "report", title: "t", body: "b" });
    const ids = s.list("s1").map((r) => r.id);
    expect(ids).toHaveLength(MAX_FLOOR_REPORTS);
    expect(ids).not.toContain(rid(0));
    expect(ids).toContain(rid(1));
  });

  it("대기 중인 것만으로 차면 새 보고서를 받고 가장 오래된 대기 보고서를 보관함으로 옮긴다(파일은 층마다 100개까지)", () => {
    const s = store();
    for (let i = 0; i < MAX_FLOOR_FILE + 5; i++) {
      s.add("s1", { id: rid(i), kind: "report", title: "t", body: "b" });
      clock += 1;
    }
    expect(s.list("s1")).toHaveLength(MAX_FLOOR_REPORTS);
    expect(s.list("s1")[0].id).toBe(rid(MAX_FLOOR_FILE + 4));
    const archived = s.archived("s1");
    expect(archived.length).toBe(MAX_FLOOR_FILE - MAX_FLOOR_REPORTS);
    expect(archived.map((r) => r.id)).not.toContain(rid(0)); // 파일 상한을 넘은 가장 오래된 것은 지운다
  });

  it("층마다 lastSeenAt을 남기고, 7일 넘게 보이지 않은 층은 정리한다 — 서버 시작 직후 첫 sweep 전에는 정리하지 않는다", () => {
    const s = store();
    s.add("old", { id: rid(1), kind: "report", title: "t", body: "b" });
    s.add("live", { id: rid(2), kind: "report", title: "t", body: "b" });
    clock += STALE_FLOOR_MS + 1;
    const fresh = store(); // 다시 켬
    expect(fresh.list("old")).toHaveLength(1); // 첫 스냅샷(sweep) 전이라 정리하지 않는다
    fresh.sweep(new Set(["live"]));
    expect(fresh.list("old")).toEqual([]);
    expect(fresh.list("live")).toHaveLength(1);
    expect(JSON.parse(readFileSync(file, "utf8")).floors.live.lastSeenAt).toBe(clock);
  });
});

describe("ReportStore — sweep은 스냅샷마다 파일을 쓰지 않는다(B321 I1)", () => {
  it("lastSeenAt은 메모리에서 고치고, 저장한 값보다 1시간 넘게 지났을 때만 쓴다", () => {
    const s = store();
    s.add("live", { id: rid(1), kind: "report", title: "t", body: "b" });
    const saved = () => JSON.parse(readFileSync(file, "utf8")).floors.live.lastSeenAt as number;
    const first = saved();
    clock += 60_000;
    s.sweep(new Set(["live"]));
    clock += 60_000;
    s.sweep(new Set(["live"]));
    expect(saved()).toBe(first); // 2분 동안 두 번 빌드해도 그대로
    clock += SEEN_SAVE_MS;
    s.sweep(new Set(["live"]));
    expect(saved()).toBe(clock);
  });
});

describe("PairingBook — PreToolUse와 제출 짝짓기(B311)", () => {
  const pre = (agent: object, input: object) => ({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "mcp__plugin_claude-office_office-channel__ask_user", tool_input: input, ...agent });
  it("같은 입력의 PreToolUse를 찾아 그 주인을 돌려주고, 한 번만 쓴다. 키 순서는 상관없다", () => {
    const b = new PairingBook({ now: () => clock });
    b.onPreToolUse(pre({ agent_id: "atester-1a2b", agent_type: "tester" }, { question: "q", options: ["a"] }));
    expect(b.ownerOf("s1", "ask_user", { options: ["a"], question: "q" })).toEqual({ name: "tester", sub: false });
    expect(b.ownerOf("s1", "ask_user", { options: ["a"], question: "q" })).toEqual({ name: "team-lead", sub: false });
  });

  it("짝이 없거나, 창(10초)이 지났거나, 같은 입력이 다른 주인으로 둘 이상이면(모호) 팀리더", () => {
    const b = new PairingBook({ now: () => clock });
    expect(b.ownerOf("s1", "ask_user", { question: "x" })).toEqual({ name: "team-lead", sub: false });
    b.onPreToolUse(pre({ agent_id: "atester-1a2b", agent_type: "tester" }, { question: "late" }));
    clock += 10_001;
    expect(b.ownerOf("s1", "ask_user", { question: "late" })).toEqual({ name: "team-lead", sub: false });
    b.onPreToolUse(pre({ agent_id: "atester-1a2b", agent_type: "tester" }, { question: "same" }));
    b.onPreToolUse(pre({ agent_id: "areviewer-9f9f", agent_type: "reviewer" }, { question: "same" }));
    expect(b.ownerOf("s1", "ask_user", { question: "same" })).toEqual({ name: "team-lead", sub: false });
  });

  it("다른 층(대화 키)의 PreToolUse와는 짝이 맞지 않는다(B321 M2)", () => {
    const b = new PairingBook({ now: () => clock });
    b.onPreToolUse(pre({ agent_id: "atester-1a2b", agent_type: "tester" }, { question: "q" }));
    expect(b.ownerOf("s2", "ask_user", { question: "q" })).toEqual({ name: "team-lead", sub: false });
    expect(b.ownerOf("s1", "ask_user", { question: "q" })).toEqual({ name: "tester", sub: false });
  });

  it("이 플러그인의 세 도구가 아닌 PreToolUse는 적지 않는다", () => {
    const b = new PairingBook({ now: () => clock });
    b.onPreToolUse({ ...pre({ agent_id: "atester-1a2b", agent_type: "tester" }, { question: "q" }), tool_name: "mcp__other__ask_user" });
    expect(b.ownerOf("s1", "ask_user", { question: "q" })).toEqual({ name: "team-lead", sub: false });
  });
});
