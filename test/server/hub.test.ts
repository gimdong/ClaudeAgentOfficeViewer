import { afterEach, describe, expect, it } from "vitest";
import { SnapshotHub } from "../../server/hub";
import { SnapshotBuilder } from "../../server/snapshot";
import type { Snapshot } from "../../src/shared/types";
import { emptySum } from "../../src/shared/tokens";
import { makeHome } from "../helpers/fakeHome";

function snap(tag: string, n: number): Snapshot {
  return {
    generatedAt: String(n),
    usage: { today: emptySum(), last5h: emptySum(), last7d: emptySum(), byModel: [], hourly: [] },
    budget: {},
    limits: null,
    sessions: [{ id: tag, name: tag, cwd: "", alive: true, isCurrent: true, status: "idle", floor: 1, floorStatus: "idle", context: null, members: [] }],
    decisionCount: 0,
    decisions: [],
    hiddenFloors: 0,
  };
}

let hub: SnapshotHub | undefined;
afterEach(() => hub?.stop());

describe("SnapshotHub", () => {
  it("start 후 current를 제공하고, 내용이 바뀔 때만 구독자에게 알린다", async () => {
    let tag = "a";
    let n = 0;
    hub = new SnapshotHub({ build: async () => snap(tag, n++) }, { intervalMs: 60_000 });
    await hub.start();
    expect(hub.current().sessions[0].id).toBe("a");

    const got: string[] = [];
    hub.subscribe((s) => got.push(s.sessions[0].id));
    await hub.refresh(); // generatedAt만 바뀜 → 알리지 않음
    tag = "b";
    await hub.refresh();
    expect(got).toEqual(["b"]);
    expect(hub.current().generatedAt).toBe("2");
  });

  it("실행 중에 들어온 refresh는 한 번으로 합친다", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    hub = new SnapshotHub({
      build: async () => {
        calls++;
        if (calls === 1) await gate;
        return snap("x", calls);
      },
    }, { intervalMs: 60_000 });
    const p1 = hub.refresh();
    const p2 = hub.refresh();
    const p3 = hub.refresh();
    release();
    await Promise.all([p1, p2, p3]);
    expect(calls).toBe(2);
  });

  it("unsubscribe 후에는 listenerCount가 줄어든다", async () => {
    hub = new SnapshotHub({ build: async () => snap("a", 0) }, { intervalMs: 60_000 });
    const off = hub.subscribe(() => {});
    expect(hub.listenerCount()).toBe(1);
    off();
    expect(hub.listenerCount()).toBe(0);
  });

  it("claude home 파일이 바뀌면 5초 안에 알린다 (fs.watch + debounce)", async () => {
    const h = await makeHome();
    try {
      await h.write("sessions/1.json", { pid: process.pid, sessionId: "w1", updatedAt: Date.now() });
      hub = new SnapshotHub(new SnapshotBuilder({ claudeHome: h.home, config: { budget: {}, contextWindows: {} } }), {
        intervalMs: 60_000, // 주기 갱신이 아니라 파일 감시로 알림이 오는지 본다
        debounceMs: 100,
        watchDir: h.home,
      });
      await hub.start();
      const seen = new Promise<Snapshot>((r) => hub!.subscribe(r));
      // macOS 재귀 fs.watch(FSEvents)는 감시를 막 시작한 직후의 변경을 부하가 클 때 놓칠 수 있다. 주기 갱신은
      // 꺼 두었으므로(60초) 한 번 놓치면 알림이 영영 오지 않는다. 알림이 올 때까지 500ms마다 내용을 바꿔 다시 쓴다.
      // 첫 쓰기부터 5초 안에 와야 한다는 기준은 그대로다
      const t0 = Date.now();
      let n = 0;
      const write = () => h.write("sessions/2.json", { pid: process.pid, sessionId: "w2", updatedAt: Date.now() + n++ });
      await write();
      // 진행 중인 마지막 쓰기를 기억해 두고, 끝난 뒤에야 임시 폴더를 지운다(겹치면 폴더가 다시 생기거나 처리 안 된 rejection)
      let last: Promise<void> = Promise.resolve();
      const again = setInterval(() => {
        last = write().catch(() => {});
      }, 500);
      let timer: NodeJS.Timeout | undefined;
      const s = await Promise.race([seen, new Promise<null>((r) => (timer = setTimeout(() => r(null), 5000)))]);
      clearInterval(again);
      clearTimeout(timer);
      await last;
      expect(s, "fs.watch 알림이 5초 안에 오지 않았다").not.toBeNull();
      expect(s!.sessions.map((x) => x.id).sort()).toEqual(["w1", "w2"]);
      expect(Date.now() - t0).toBeLessThan(5000);
    } finally {
      hub?.stop();
      await h.cleanup();
    }
  });

  it("poke를 50번 불러도 한 번만 다시 만든다", async () => {
    let builds = 0;
    hub = new SnapshotHub({ build: async () => snap("p", ++builds) }, { pokeMs: 30 });
    for (let i = 0; i < 50; i++) hub.poke();
    await new Promise((r) => setTimeout(r, 80));
    expect(builds).toBe(1);
    hub.poke();
    await new Promise((r) => setTimeout(r, 80));
    expect(builds).toBe(2);
  });
});
