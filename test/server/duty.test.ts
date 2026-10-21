import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DutyBoard, LONG_IDLE_MS, OFF_IDLE_MS, RETIRE_NUDGE_MS } from "../../server/floors/duty";
import { leadInstruct } from "../../server/floors/lead";
import { ReportStore } from "../../server/floors/reports";
import { Logger, setLogger } from "../../server/log";

// Phase 6b 스펙 6장·7장·11장 a d e f
let dir: string;
let clock: number;
let reports: ReportStore;
let duty: DutyBoard;
beforeEach(() => {
  setLogger(new Logger({ dir: "" }));
  dir = mkdtempSync(join(tmpdir(), "co-duty-"));
  clock = Date.parse("2026-10-21T10:00:00Z");
  reports = new ReportStore({ file: join(dir, "reports.json"), now: () => clock });
  duty = new DutyBoard({ reports, now: () => clock });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const at = (ms: number) => new Date(ms).toISOString();
const ctx = (o: Partial<{ paused: boolean; decision: boolean; active: boolean; lastActivityAt: string }> = {}) => ({ paused: false, decision: false, ...o });
const sent = (kind: "offduty" | "onduty" | "retire" | "rehire", member = "tester", extra: object = {}) => duty.onSent({ floor: "s1", kind, member, requestId: "r-11111111", ...extra });

describe("퇴근·출근(스펙 6장)", () => {
  it("퇴근 요청을 보내면 requested, 10분 동안 활동이 없으면 off, 팀원 프로세스가 끝나면(isActive false) 곧바로 off", () => {
    expect(duty.view("s1", "tester", ctx({ lastActivityAt: at(clock) }))).toEqual({});
    sent("offduty");
    expect(duty.view("s1", "tester", ctx({ lastActivityAt: at(clock) })).duty).toBe("requested");
    expect(duty.view("s1", "tester", ctx({ lastActivityAt: at(clock), active: false })).duty).toBe("off");
    clock += OFF_IDLE_MS - 1;
    expect(duty.view("s1", "tester", ctx({ lastActivityAt: at(clock - OFF_IDLE_MS + 1) })).duty).toBe("requested");
    clock += 2;
    expect(duty.view("s1", "tester", ctx({ lastActivityAt: at(clock - OFF_IDLE_MS - 1) })).duty).toBe("off");
  });

  it("요청 뒤에 활동이 있으면 그때부터 다시 잰다", () => {
    sent("offduty");
    clock += OFF_IDLE_MS + 1;
    expect(duty.view("s1", "tester", ctx({ lastActivityAt: at(clock - 1000) })).duty).toBe("requested");
  });

  it("휴업 중인 층·손든(결정 대기) 팀원은 off로 넘어가지 않는다(11장 d)", () => {
    sent("offduty");
    clock += OFF_IDLE_MS + 1;
    for (const c of [ctx({ paused: true, active: false }), ctx({ decision: true, active: false })]) expect(duty.view("s1", "tester", c).duty).toBe("requested");
  });

  it("출근(onduty)을 보내면 퇴근 표시를 지우고, 층이 보이지 않으면(끝남·숨김) 기억을 지운다", () => {
    sent("offduty");
    sent("onduty");
    expect(duty.view("s1", "tester", ctx())).toEqual({});
    sent("offduty");
    duty.sweep(new Set(["other"]));
    expect(duty.view("s1", "tester", ctx())).toEqual({});
  });
});

describe(`오래 쉼(${LONG_IDLE_MS / 3_600_000}시간)`, () => {
  it("마지막 활동이 1시간 넘으면 longIdle, 휴업 층·손든 팀원·활동 기록 없음은 아님", () => {
    expect(duty.view("s1", "tester", ctx({ lastActivityAt: at(clock - LONG_IDLE_MS + 1) }))).toEqual({});
    expect(duty.view("s1", "tester", ctx({ lastActivityAt: at(clock - LONG_IDLE_MS - 1) }))).toEqual({ longIdle: true });
    for (const c of [ctx({ paused: true, lastActivityAt: at(0) }), ctx({ decision: true, lastActivityAt: at(0) }), ctx()]) expect(duty.view("s1", "tester", c)).toEqual({});
  });
});

describe("퇴사(스펙 7장·11장 e f)", () => {
  const hub = (connected = true) => {
    const sentTexts: string[] = [];
    return { sentTexts, h: { connected: () => connected, instruct: (_id: string, text: string) => (sentTexts.push(text), { ok: true as const, id: "i", state: "sent" as const }) } };
  };

  it("retire를 보내면 시작 시각을 reports.json에 남기고(다시 켜도 이어 감) 화면에 retiring", () => {
    sent("retire");
    expect(duty.view("s1", "tester", ctx())).toEqual({ retiring: { since: at(clock) } });
    const again = new DutyBoard({ reports: new ReportStore({ file: join(dir, "reports.json"), now: () => clock }), now: () => clock });
    expect(again.view("s1", "tester", ctx()).retiring).toEqual({ since: at(clock) });
  });

  it(`${RETIRE_NUDGE_MS / 60_000}분 동안 인수인계가 없으면 channel이 연결돼 있을 때만 팀리더에게 "대신 써 달라"를 한 번`, () => {
    sent("retire");
    const { h, sentTexts } = hub();
    clock += RETIRE_NUDGE_MS - 1;
    duty.sweep(new Set(["s1"]), h);
    expect(sentTexts).toEqual([]);
    clock += 2;
    const off = hub(false);
    duty.sweep(new Set(["s1"]), off.h);
    expect(off.sentTexts).toEqual([]); // 연결이 없으면 보내지 않는다(다시 켠 뒤 channel 없음 포함)
    duty.sweep(new Set(["s1"]), h);
    duty.sweep(new Set(["s1"]), h);
    expect(sentTexts).toHaveLength(1);
    expect(sentTexts[0]).toContain('submit_handover 도구(request_id: "r-11111111", member: "tester")');
    expect(sentTexts[0]).toMatch(/^\[대시보드 지시 r-[0-9a-f]{8}\] /);
  });

  it("인수인계가 이미 왔으면 재촉하지 않는다", () => {
    sent("retire");
    reports.add("s1", { id: "r-11111111", kind: "handover", member: "tester", body: "메모" });
    const { h, sentTexts } = hub();
    clock += RETIRE_NUDGE_MS + 1;
    duty.sweep(new Set(["s1"]), h);
    expect(sentTexts).toEqual([]);
  });

  it("rehire는 그 팀원의 인수인계 메모가 있어야 하고(없으면 409), 틀은 ①종료 ②종료 확인 ③같은 이름 순서 + 메모 칸", () => {
    const fake = { instruct: () => ({ ok: true as const, id: "i", state: "sent" as const }) };
    const team = ["tester", "builder"];
    expect(leadInstruct(fake, "s1", false, { kind: "rehire", member: "tester", handoverId: "r-22222222" }, team, reports).status).toBe(409);
    reports.add("s1", { id: "r-22222222", kind: "handover", member: "builder", body: "남의 메모" });
    expect(leadInstruct(fake, "s1", false, { kind: "rehire", member: "tester", handoverId: "r-22222222" }, team, reports)).toEqual({ status: 409, body: { error: "handover" } });
    reports.add("s1", { id: "r-33333333", kind: "handover", member: "tester", body: "할 일: <a> 고치기\n주의" });
    let text = "";
    const ok = leadInstruct({ instruct: (_i: string, t: string) => ((text = t), { ok: true as const, id: "i", state: "sent" as const }) }, "s1", false, { kind: "rehire", member: "tester", handoverId: "r-33333333" }, team, reports, (s) => duty.onSent(s));
    expect(ok.status).toBe(200);
    const [i1, i2, i3] = ["①", "②", "③"].map((c) => text.indexOf(c));
    expect(i1).toBeGreaterThan(0);
    expect(i2).toBeGreaterThan(i1);
    expect(i3).toBeGreaterThan(i2);
    expect(text).toContain("shutdown_request");
    expect(text).toContain('같은 이름 "tester"');
    expect(text).toContain("> 할 일: ＜a＞ 고치기");
    // 보냄 → 인수인계 보고서는 started, 퇴사는 끝나고 전임자(이름·시각만)
    expect(reports.find("s1", "r-33333333")!.state).toBe("started");
    expect(duty.predecessors("s1")).toEqual([{ name: "tester", retiredAt: clock }]);
    expect(duty.view("s1", "tester", ctx())).toEqual({});
  });
});

describe("전임자 일한 기간(B323)", () => {
  it("퇴사 중 view가 받은 팀 설정 joinedAt을 남기고 rehire 뒤 전임자 startedAt으로. 퇴사 시작 뒤에 합류한 값(새 팀원)·없는 값은 쓰지 않는다", () => {
    const joined = clock - 3_600_000;
    sent("retire");
    duty.view("s1", "tester", { ...ctx(), joinedAt: clock + 1 });
    duty.view("s1", "tester", { ...ctx(), joinedAt: joined });
    duty.view("s1", "tester", { ...ctx(), joinedAt: clock + 1 });
    clock += 60_000;
    sent("rehire");
    sent("retire", "builder");
    sent("rehire", "builder");
    expect(duty.predecessors("s1")).toEqual([
      { name: "tester", retiredAt: clock, startedAt: joined },
      { name: "builder", retiredAt: clock },
    ]);
    // 다시 켜도(reports.json) 남는다
    expect(new DutyBoard({ reports: new ReportStore({ file: join(dir, "reports.json"), now: () => clock }) }).predecessors("s1")[0].startedAt).toBe(joined);
  });
});

describe("지시가 실제로 나갔을 때만 기록(11장 a)", () => {
  it("휴업 중 보관(held)이면 onSent를 부르지 않고 보관 지시의 meta로 넘긴다", () => {
    const calls: unknown[] = [];
    const metas: unknown[] = [];
    const hub = { instruct: (_i: string, _t: string, paused: boolean, _k?: string, meta?: unknown) => (metas.push(meta), paused ? { ok: true as const, id: "h", state: "held" as const } : { ok: true as const, id: "i", state: "sent" as const }) };
    leadInstruct(hub, "s1", true, { kind: "offduty", member: "tester" }, ["tester"], reports, (s) => calls.push(s));
    expect(calls).toEqual([]);
    expect(metas[0]).toMatchObject({ floor: "s1", kind: "offduty", member: "tester" });
    leadInstruct(hub, "s1", false, { kind: "offduty", member: "tester" }, ["tester"], reports, (s) => calls.push(s));
    expect(calls).toHaveLength(1);
  });
});
