import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapshotBuilder } from "../../server/snapshot";
import { SubagentTracker, SUBAGENT_LINGER_MS } from "../../server/collectors/subagents";
import { buildBundle } from "../../server/diag/bundle";
import { HookStats } from "../../server/events/stats";
import { Logger, setLogger } from "../../server/log";
import { assistant, makeHome, type FakeHome } from "../helpers/fakeHome";

const NOW = Date.now();
const config = { budget: {}, contextWindows: {} };
const SUB = "projects/-p/s1/subagents";
const DESC = "결제 모듈의 환불 경로를 조사";
let h: FakeHome;
beforeEach(async () => {
  h = await makeHome();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await h.write("sessions/100.json", { pid: 100, sessionId: "s1", name: "alpha", cwd: "/x", status: "busy", updatedAt: NOW - 1000 });
  await h.append("projects/-p/s1.jsonl", [assistant({ requestId: "r0", ts: NOW - 5000, output: 1 })]);
});
afterEach(async () => {
  vi.restoreAllMocks();
  setLogger(new Logger({ dir: "" }));
  await h.cleanup();
});

const ID = "a0123456789abcdef";
/** 이름 없는 meta(서브에이전트) + 같은 이름의 대화 기록. ageMs = 대화 기록 mtime이 now보다 얼마나 앞인지 */
async function subagent(id: string, o: { type?: string; description?: string; name?: string; ageMs?: number } = {}) {
  await h.write(`${SUB}/agent-${id}.meta.json`, { agentType: o.type ?? "Explore", ...(o.description !== undefined ? { description: o.description } : { description: DESC }), ...(o.name ? { name: o.name } : {}) });
  await h.append(`${SUB}/agent-${id}.jsonl`, [assistant({ requestId: `q-${id}`, ts: NOW - 2000, model: "claude-haiku-4-5", input: 100, output: 20 })]);
  const t = new Date(NOW - (o.ageMs ?? 0));
  await utimes(h.path(`${SUB}/agent-${id}.jsonl`), t, t);
}
const build = (tracker?: SubagentTracker, now = NOW, alive = true) =>
  new SnapshotBuilder({ claudeHome: h.home, config, isAlive: () => alive, subagents: tracker }).build(now);
const ev = (event: "SubagentStart" | "SubagentStop", id = ID, type = "Explore", session = "s1") => ({ hook_event_name: event, session_id: session, agent_id: id, agent_type: type });

describe("SubagentTracker (B171 — 메모리만)", () => {
  it("Start 뒤 Stop 전이면 돌고 있고, Stop 뒤에는 끝난 시각을 준다. 팀원·내부 보조 에이전트는 세지 않는다", () => {
    const t = new SubagentTracker();
    t.onEvent(ev("SubagentStart"), NOW - 5000);
    expect(t.get("s1", ID)).toEqual({ startedAt: NOW - 5000 });
    t.onEvent(ev("SubagentStop"), NOW - 1000);
    expect(t.get("s1", ID)).toEqual({ startedAt: NOW - 5000, stoppedAt: NOW - 1000 });
    t.onEvent(ev("SubagentStart", "aworker-1a2b", "worker"), NOW); // 팀원(하이픈)
    t.onEvent(ev("SubagentStart", "a1111111111111111", ""), NOW); // 턴 뒤 내부 보조(agent_type 빈 값)
    t.onEvent({ hook_event_name: "PreToolUse", session_id: "s1", agent_id: "a2222222222222222", agent_type: "Explore" }, NOW);
    expect(t.size()).toBe(1);
  });

  it("끝난 지 오래된 기록은 prune이 지운다", () => {
    const t = new SubagentTracker();
    t.onEvent(ev("SubagentStart"), NOW - 120_000);
    t.onEvent(ev("SubagentStop"), NOW - 100_000);
    t.prune(NOW);
    expect(t.get("s1", ID)).toBeUndefined();
  });
});

describe("SessionView.subagents", () => {
  it("이름 없는 meta만, 종류·맡긴 일·모델·토큰과 Start만 있으면 working", async () => {
    await subagent(ID, { ageMs: 120_000 }); // 대화 기록은 오래됐지만 Stop 전
    await subagent("aquill-1", { name: "quill", type: "general-purpose" }); // 팀원 meta는 넣지 않는다
    const t = new SubagentTracker();
    t.onEvent(ev("SubagentStart"), NOW - 130_000);
    const [s1] = (await build(t)).sessions;
    expect(s1.subagents).toEqual([{ id: ID, type: "Explore", description: DESC, model: "claude-haiku-4-5", tokens: 120, working: true }]);
    expect(s1.members.map((m) => m.name)).toEqual(["team-lead"]);
  });

  it("Stop 뒤에는 working:false로 30초 보이고, 그 뒤 사라진다(끝 = Stop과 마지막 mtime 중 늦은 것)", async () => {
    await subagent(ID, { ageMs: 10_000 });
    const t = new SubagentTracker();
    t.onEvent(ev("SubagentStart"), NOW - 60_000);
    t.onEvent(ev("SubagentStop"), NOW - 40_000);
    // 기록이 있으면 기록이 우선: Stop 뒤면 mtime이 새것이어도 working:false(B175), 끝(mtime)에서 30초 안이라 보인다
    expect((await build(t)).sessions[0].subagents?.map((x) => x.working)).toEqual([false]);
    // mtime 31초 전, Stop 40초 전 → working 아님, 끝(늦은 쪽 = mtime)에서 30초 지남 → 없음
    await utimes(h.path(`${SUB}/agent-${ID}.jsonl`), new Date(NOW - 31_000), new Date(NOW - 31_000));
    expect((await build(t)).sessions[0].subagents).toBeUndefined();
    // mtime 35초 전, Stop 5초 전 → 끝(Stop)에서 30초 안 → working:false로 보임
    await utimes(h.path(`${SUB}/agent-${ID}.jsonl`), new Date(NOW - 35_000), new Date(NOW - 35_000));
    const t2 = new SubagentTracker();
    t2.onEvent(ev("SubagentStart"), NOW - 60_000);
    t2.onEvent(ev("SubagentStop"), NOW - 5_000);
    expect((await build(t2)).sessions[0].subagents?.map((x) => x.working)).toEqual([false]);
    expect((await build(t2, NOW + SUBAGENT_LINGER_MS)).sessions[0].subagents).toBeUndefined();
  });

  it("Stop 직후(대화 기록 mtime이 새것)에도 기록이 있으면 기록이 우선이라 working:false로 보인다(B175)", async () => {
    await subagent(ID, { ageMs: 500 });
    const t = new SubagentTracker();
    t.onEvent(ev("SubagentStart"), NOW - 10_000);
    t.onEvent(ev("SubagentStop"), NOW - 400);
    expect((await build(t)).sessions[0].subagents).toEqual([expect.objectContaining({ id: ID, working: false })]);
  });

  it("정렬: 일하는 중 먼저, 그 안에서 먼저 시작한 것부터(기록이 없으면 mtime)(B175, 명세 §7)", async () => {
    const [A, B, C, D] = ["af000000000000001", "ae000000000000002", "ad000000000000003", "ac000000000000004"];
    for (const id of [A, B, C]) await subagent(id, { ageMs: 1_000 });
    await subagent(D, { ageMs: 20_000 }); // 기록 없음 → mtime 20초 전 = 시작으로 봄, working
    const t = new SubagentTracker();
    t.onEvent(ev("SubagentStart", A), NOW - 50_000);
    t.onEvent(ev("SubagentStart", B), NOW - 10_000);
    t.onEvent(ev("SubagentStart", C), NOW - 90_000);
    t.onEvent(ev("SubagentStop", C), NOW - 5_000); // 끝남은 뒤로
    expect((await build(t)).sessions[0].subagents?.map((x) => [x.id, x.working])).toEqual([[A, true], [D, true], [B, true], [C, false]]);
  });

  it("기록이 없으면(서버를 다시 켬) mtime만으로: 30초 안에 바뀐 것만 working으로 보인다", async () => {
    await subagent(ID, { ageMs: 5_000 });
    await subagent("a9999999999999999", { ageMs: 45_000 });
    expect((await build(new SubagentTracker())).sessions[0].subagents?.map((x) => [x.id, x.working])).toEqual([[ID, true]]);
    expect((await build(undefined)).sessions[0].subagents?.map((x) => x.id)).toEqual([ID]);
  });

  it("끝난 층에는 싣지 않는다. 서브에이전트가 없으면 필드가 없다", async () => {
    await subagent(ID, { ageMs: 1_000 });
    expect((await build(new SubagentTracker(), NOW, false)).sessions[0].subagents).toBeUndefined();
    await rmAll();
    expect((await build(new SubagentTracker())).sessions[0].subagents).toBeUndefined();
  });

  it("description이 없거나 종류가 없어도 깨지지 않는다(빈 문자열·unknown)", async () => {
    await h.write(`${SUB}/agent-${ID}.meta.json`, {});
    await h.append(`${SUB}/agent-${ID}.jsonl`, [assistant({ requestId: "z", ts: NOW - 1000, output: 1 })]);
    const t = new SubagentTracker();
    t.onEvent(ev("SubagentStart"), NOW - 2000);
    expect((await build(t)).sessions[0].subagents).toEqual([expect.objectContaining({ id: ID, type: "", description: "", working: true })]);
  });
});

describe("description은 화면에만(B172)", () => {
  it("실제 수집기·로거: 로그 파일과 진단 묶음에 description 문자열이 없다", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "subagents-log-"));
    try {
      setLogger(new Logger({ dir: logDir }));
      await subagent(ID);
      await h.write(`${SUB}/agent-abad0000000000000.meta.json`, "{broken"); // 경고 경로도 지나게
      const t = new SubagentTracker();
      t.onEvent(ev("SubagentStart"), NOW - 1000);
      const snap = await build(t);
      expect(snap.sessions[0].subagents?.[0].description).toBe(DESC); // 스냅샷에는 있다
      const bundle = await buildBundle({ doctor: async () => [], hooks: new HookStats(() => NOW).view(), snapshot: snap, logDir, now: () => NOW, appVersion: "t" });
      const logs = readdirSync(logDir).map((f) => readFileSync(join(logDir, f), "utf8")).join("\n");
      expect(logs).not.toContain(DESC);
      expect(JSON.stringify(bundle)).not.toContain(DESC);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});

async function rmAll() {
  rmSync(h.path(SUB), { recursive: true, force: true });
}
