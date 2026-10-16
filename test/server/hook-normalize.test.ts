import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../server/app";
import { BudgetGate } from "../../server/budget/gate";
import { BudgetStore } from "../../server/budget/store";
import { SubagentTracker } from "../../server/collectors/subagents";
import { PAUSED_REASON, preToolDeny } from "../../server/decisions/protocol";
import { DecisionQueue } from "../../server/decisions/queue";
import { EventStore } from "../../server/events/store";
import { FloorControl } from "../../server/floors/control";
import { Logger, setLogger } from "../../server/log";
import { PolicyGate } from "../../server/policy/gate";
import { PolicyStore } from "../../server/policy/store";
import { SnapshotBuilder } from "../../server/snapshot";
import { assistant, makeHome, type FakeHome } from "../helpers/fakeHome";
import { makeSnapshot } from "../web/fixtures";

// B194: 합친 층(B192)의 hook이 층 id(interactive)로 와도 대화 키(bg)로 한 번 바꿔 모든 관문에 넘긴다
const NOW = Date.now();
const INTER = "6b626eda-0000-4000-8000-000000000001";
const BG = "80673844-48d8-4000-8000-000000000002";
let h: FakeHome;
let tmp: string;
let server: Server;
let port: number;
let builder: SnapshotBuilder;
let events: EventStore;
let budgetStore: BudgetStore;
let budgetGate: BudgetGate;
let policyStore: PolicyStore;
let floors: FloorControl;
let queue: DecisionQueue;
let seen: Array<Record<string, unknown>>;

beforeEach(async () => {
  h = await makeHome();
  tmp = mkdtempSync(join(tmpdir(), "co-hook-norm-"));
  setLogger(new Logger({ dir: "" }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await h.write("sessions/21.json", { pid: 21, sessionId: INTER, name: "launched", cwd: "/w", status: "busy", kind: "interactive", tmux: "co-1", parkedJobId: "80673844", startedAt: NOW - 60_000, updatedAt: NOW - 50_000 });
  await h.write("sessions/22.json", { pid: 22, sessionId: BG, name: "launched", cwd: "/w", status: "busy", kind: "bg", jobId: "80673844", startedAt: NOW - 55_000, updatedAt: NOW - 1_000 });
  await h.write("sessions/23.json", { pid: 23, sessionId: "solo", name: "solo", cwd: "/s", status: "busy", updatedAt: NOW - 1_000 });
  await h.append(`projects/-w/${BG}.jsonl`, [assistant({ requestId: "r1", ts: NOW - 2000, output: 40 })]);
  events = new EventStore();
  budgetStore = new BudgetStore(join(tmp, "state.json"));
  budgetStore.load();
  budgetGate = new BudgetGate(budgetStore);
  policyStore = new PolicyStore(join(tmp, "policy.json"));
  policyStore.load();
  const policyGate = new PolicyGate(policyStore);
  queue = new DecisionQueue({});
  builder = new SnapshotBuilder({ claudeHome: h.home, config: { budget: {}, contextWindows: {} }, isAlive: () => true, events, subagents: new SubagentTracker(), policy: { store: policyStore, gate: policyGate } });
  floors = new FloorControl({ signal: () => {}, matchProcStart: async () => true, aliasOf: (id) => builder.floorIdOf(id) });
  await builder.build(NOW);
  seen = [];
  const snap = makeSnapshot({});
  server = createApp(
    { current: () => snap, subscribe: () => () => {}, poke: () => {} },
    {
      normalizeSession: (id) => builder.convOf(id),
      onHookEvent: (i) => {
        seen.push(i);
        events.add(i, Date.now());
        budgetGate.onEvent(i);
      },
      decisions: queue,
      gate: budgetGate,
      policy: policyGate,
      floors: { preToolUse: (i) => floors.preToolUse(i), pause: () => {}, resume: () => {}, isPaused: () => false, terminate: async () => ({ ok: false, error: "ended" }), hide: () => {}, unhideAll: () => {}, hiddenCount: () => 0, record: () => undefined },
    },
  ).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  vi.restoreAllMocks();
  queue.stop();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(tmp, { recursive: true, force: true });
  await h.cleanup();
});

const hook = (body: Record<string, unknown>) =>
  new Promise<string>((resolve, reject) => {
    const s = JSON.stringify(body);
    const req = request({ host: "127.0.0.1", port, path: "/hooks/event", method: "POST", headers: { Host: `127.0.0.1:${port}`, "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(s)) } }, (res) => {
      let t = "";
      res.on("data", (d) => (t += d));
      res.on("end", () => resolve(t));
    });
    req.on("error", reject);
    req.end(s);
  });
const pre = (session_id: string, command = "ls") => ({ hook_event_name: "PreToolUse", session_id, tool_name: "Bash", tool_input: { command }, tool_use_id: `tu-${command}`, prompt_id: "p1" });
const lead = async () => (await builder.build(Date.now())).sessions.find((s) => s.id === INTER)!.members[0];

describe("hook 입구의 session_id 정규화(B194)", () => {
  it("층 id로 온 hook도 대화 키로 바뀌어 저장된다 → 말풍선 활동이 보인다. 짝 없는 층의 hook은 그대로", async () => {
    await hook(pre(INTER));
    expect(seen.map((i) => i.session_id)).toEqual([BG]);
    expect((await lead()).activity).toMatchObject({ kind: "tool", tool: "Bash" });
    await hook(pre("solo"));
    expect(seen.at(-1)!.session_id).toBe("solo");
  });

  it("예산 관문: 화면이 건 예산(대화 키로 저장)이 층 id로 온 hook에도 걸린다", async () => {
    budgetStore.setBudget(builder.convOf(INTER), 1000, 0);
    budgetGate.setUsage(BG, 1200);
    const out = await hook(pre(INTER));
    expect(out).toContain('"permissionDecision":"ask"');
  });

  it("정책 deny의 '방금 막힘'이 층 id로 온 hook에도 그 층에 붙는다", async () => {
    policyStore.set("lead", { bash: "deny" });
    const out = await hook(pre(INTER));
    expect(out).toContain('"permissionDecision":"deny"');
    expect((await lead()).policyDenied).toBeDefined();
  });

  it("일시정지는 어느 id로 와도 그 층에 걸린다", async () => {
    floors.pause(INTER);
    for (const id of [INTER, BG]) expect(JSON.parse(await hook(pre(id, `c-${id}`)))).toEqual(preToolDeny(PAUSED_REASON));
    expect(floors.view(INTER).pausedDenied).toBe(2);
  });
});
