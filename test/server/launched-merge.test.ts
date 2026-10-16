import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SnapshotBuilder } from "../../server/snapshot";
import { FloorControl } from "../../server/floors/control";
import { SubagentTracker } from "../../server/collectors/subagents";
import type { DecisionView } from "../../src/shared/types";
import { assistant, makeHome, type FakeHome } from "../helpers/fakeHome";

// 버그 3(B192): 대시보드로 띄운 층 = interactive 기록(신원) + bg 기록(대화). team-lead가 준 필드 모양 그대로의 가짜 기록
const NOW = Date.now();
const INTER = "6b626eda-0000-4000-8000-000000000001";
const BG = "80673844-48d8-4000-8000-000000000002";
const config = { budget: {}, contextWindows: {} };
let h: FakeHome;
beforeEach(async () => {
  h = await makeHome();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await h.write("sessions/21.json", { pid: 21, sessionId: INTER, name: "launched", cwd: "/w", status: "idle", kind: "interactive", tmux: "co-1", parkedJobId: "80673844", startedAt: NOW - 60_000, updatedAt: NOW - 50_000 });
  await h.write("sessions/22.json", { pid: 22, sessionId: BG, name: "launched", cwd: "/w", status: "busy", kind: "bg", jobId: "80673844", startedAt: NOW - 55_000, updatedAt: NOW - 1_000 });
  // 대화 기록은 bg 쪽 sessionId에만 있다(interactive 기록은 띄운 직후에 멈춤)
  await h.append(`projects/-w/${BG}.jsonl`, [assistant({ requestId: "r1", ts: NOW - 2000, model: "claude-haiku-4-5", input: 300, output: 40 })]);
  await h.write(`projects/-w/${BG}/subagents/agent-a0123456789abcdef.meta.json`, { agentType: "Explore", description: "조사" });
  await h.append(`projects/-w/${BG}/subagents/agent-a0123456789abcdef.jsonl`, [assistant({ requestId: "s1", ts: NOW - 1000, output: 5 })]);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await h.cleanup();
});

const pending = (sessionId: string): DecisionView =>
  ({ id: "d1", sessionId, agent: "team-lead", kind: "permission", toolName: "Bash", state: "pending", createdAt: new Date(NOW - 1000).toISOString(), deadline: new Date(NOW + 500_000).toISOString(), detail: {} }) as DecisionView;

describe("합친 층의 신원·대화 키(B192)", () => {
  it("층 하나, id는 interactive, 구성원·토큰·모델·서브에이전트는 bg 대화 기록에서", async () => {
    const tracker = new SubagentTracker();
    tracker.onEvent({ hook_event_name: "SubagentStart", session_id: BG, agent_id: "a0123456789abcdef", agent_type: "Explore" }, NOW - 1500);
    const b = new SnapshotBuilder({ claudeHome: h.home, config, isAlive: () => true, subagents: tracker });
    const snap = await b.build(NOW);
    expect(snap.sessions.map((s) => s.id)).toEqual([INTER]);
    const [s] = snap.sessions;
    expect(s).toMatchObject({ status: "working", floor: 1 });
    expect(s.members[0]).toMatchObject({ name: "team-lead", model: "claude-haiku-4-5" });
    expect(s.members[0].tokens.total).toBe(340);
    expect(s.subagents?.map((x) => [x.id, x.working])).toEqual([["a0123456789abcdef", true]]);
    expect([b.convOf(INTER), b.floorIdOf(BG), b.floorIdOf(INTER), b.floorIdOf("other")]).toEqual([BG, INTER, INTER, "other"]);
  });

  it("hook 상태(결정 큐)는 대화 키로 찾고, 스냅샷의 결정은 층 id로 보인다(보고서가 층을 찾게)", async () => {
    const snap = await new SnapshotBuilder({ claudeHome: h.home, config, isAlive: () => true, decisions: { list: () => [pending(BG)] } }).build(NOW);
    expect(snap.sessions[0].members[0].state).toBe("decision");
    expect(snap.decisions.map((d) => d.sessionId)).toEqual([INTER]);
  });

  it("예산 사용량은 대화 키로 관문에 넣고 그 키로 읽는다", async () => {
    const setUsage = vi.fn();
    const view = vi.fn(() => undefined);
    const touch = vi.fn();
    await new SnapshotBuilder({ claudeHome: h.home, config, isAlive: () => true, budget: { gate: { setUsage, usage: () => 0, view }, store: { touch, defaultTokens: () => undefined } } }).build(NOW);
    expect(setUsage).toHaveBeenCalledWith(BG, 340);
    expect(view).toHaveBeenCalledWith(BG);
    expect(touch.mock.calls[0][0]).toEqual([BG]);
  });

  it("일시정지는 층 id로 걸고, hook이 어느 id로 와도(interactive·bg) 그 층의 멈춤에 걸린다", async () => {
    const b = new SnapshotBuilder({ claudeHome: h.home, config, isAlive: () => true });
    const floors = new FloorControl({ signal: () => {}, matchProcStart: async () => true, aliasOf: (id) => b.floorIdOf(id) });
    await b.build(NOW);
    floors.pause(INTER);
    const pre = (session_id: string) => floors.preToolUse({ hook_event_name: "PreToolUse", session_id, tool_name: "Bash" });
    expect(pre(BG)).not.toBeNull();
    expect(pre(INTER)).not.toBeNull();
    expect(pre("someone-else")).toBeNull();
    expect(floors.view(INTER).pausedDenied).toBe(2);
  });

  it("종료 대상은 interactive 기록(pid 21)이다", async () => {
    const b = new SnapshotBuilder({ claudeHome: h.home, config, isAlive: () => true });
    await b.build(NOW);
    expect(b.record(INTER)?.pid).toBe(21);
    expect(b.record(BG)).toBeUndefined();
  });
});
