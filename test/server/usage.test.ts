import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rm, writeFile } from "node:fs/promises";
import { UsageCollector } from "../../server/collectors/usage";
import { assistant, makeHome, type FakeHome } from "../helpers/fakeHome";

const HOUR = 3_600_000;
const NOW = new Date(2026, 8, 28, 15, 0, 0).getTime(); // 로컬 시간 15:00
const F = "projects/-p/s1.jsonl";

let h: FakeHome;
let c: UsageCollector;
beforeEach(async () => {
  h = await makeHome();
  c = new UsageCollector(h.path("projects"));
});
afterEach(() => h.cleanup());

// assistant() 헬퍼는 requestId만 지정할 수 있다. 중복 제거 키의 fallback 단계
// (requestId → message.id → file:uuid)를 개별적으로 검증하려면 그 아래 단계들을 직접 만들어야
// 한다(Ruling 18 — 코드는 이미 이렇게 fallback하므로 테스트만 추가한다).
function assistantWithId(o: { messageId?: string; uuid?: string; ts: number; output?: number }) {
  return {
    type: "assistant",
    uuid: o.uuid,
    timestamp: new Date(o.ts).toISOString(),
    message: {
      role: "assistant",
      id: o.messageId,
      model: "claude-opus-5-5",
      content: [{ type: "text", text: "hi" }],
      usage: { input_tokens: 0, output_tokens: o.output ?? 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  };
}

describe("UsageCollector", () => {
  it("같은 requestId는 한 번만 세고 total이 더 큰 줄을 남긴다", async () => {
    await h.append(F, [
      assistant({ requestId: "r1", ts: NOW - HOUR, input: 10, output: 5 }),
      assistant({ requestId: "r1", ts: NOW - HOUR, input: 10, output: 50 }),
      assistant({ requestId: "r2", ts: NOW - HOUR, input: 1, output: 1, cacheWrite: 3, cacheRead: 100 }),
    ]);
    await c.refresh();
    expect(c.summary(NOW).last5h).toEqual({ input: 11, output: 51, cacheRead: 100, cacheWrite: 3, total: 65 });
  });

  it("requestId가 없고 message.id가 같으면 하나로 세되, total이 더 큰 줄을 남긴다(fallback 1단계)", async () => {
    await h.append(F, [
      assistantWithId({ messageId: "m1", ts: NOW - 2000, output: 1 }),
      assistantWithId({ messageId: "m1", ts: NOW - 1000, output: 5 }), // 같은 message.id, total이 더 큼
    ]);
    await c.refresh();
    expect(c.summary(NOW).today.total).toBe(5); // 1+5(=6)가 아니라 더 큰 쪽 5만 남는다
  });

  it("requestId와 message.id가 둘 다 없으면 파일 경로:uuid로 구분해 각각 센다(fallback 2단계)", async () => {
    await h.append(F, [
      assistantWithId({ uuid: "u1", ts: NOW - 2000, output: 1 }),
      assistantWithId({ uuid: "u2", ts: NOW - 1000, output: 2 }),
    ]);
    await c.refresh();
    expect(c.summary(NOW).today.total).toBe(3); // 서로 다른 키로 취급되어 둘 다 더해진다(1+2)
  });

  it("5시간·7일 경계를 지킨다", async () => {
    await h.append(F, [
      assistant({ requestId: "in5h", ts: NOW - 5 * HOUR + 60_000, output: 1 }),
      assistant({ requestId: "out5h", ts: NOW - 5 * HOUR - 60_000, output: 10 }),
      assistant({ requestId: "out7d", ts: NOW - 168 * HOUR - 60_000, output: 100 }),
    ]);
    await c.refresh();
    const s = c.summary(NOW);
    expect(s.last5h.total).toBe(1);
    expect(s.last7d.total).toBe(11);
  });

  it("today는 로컬 자정부터 센다", async () => {
    const midnight = new Date(2026, 8, 28, 0, 0, 0).getTime();
    await h.append(F, [
      assistant({ requestId: "before", ts: midnight - 60_000, output: 7 }),
      assistant({ requestId: "after", ts: midnight + 60_000, output: 3 }),
    ]);
    await c.refresh();
    expect(c.summary(NOW).today.total).toBe(3);
  });

  it("깨진 줄, 잘못된 timestamp, <synthetic> 모델, assistant가 아닌 줄은 건너뛴다", async () => {
    await h.append(F, [
      "{not json",
      { ...assistant({ requestId: "bad-ts", ts: NOW, output: 9 }), timestamp: "nope" },
      assistant({ requestId: "syn", ts: NOW - 1000, model: "<synthetic>", output: 9 }),
      { type: "user", message: { usage: { output_tokens: 9 } }, timestamp: new Date(NOW).toISOString() },
      assistant({ requestId: "ok", ts: NOW - 1000, output: 2 }),
    ]);
    await c.refresh();
    expect(c.summary(NOW).today.total).toBe(2);
  });

  it("추가된 줄만 읽어 중복으로 세지 않는다", async () => {
    await h.append(F, [assistant({ requestId: "a", ts: NOW - 1000, output: 1 })]);
    await c.refresh();
    await h.append(F, [assistant({ requestId: "b", ts: NOW - 500, output: 2 })]);
    await c.refresh();
    expect(c.summary(NOW).today.total).toBe(3);
  });

  it("파일이 삭제되면 합계에서 빠진다", async () => {
    await h.append(F, [assistant({ requestId: "a", ts: NOW - 1000, output: 5 })]);
    await c.refresh();
    await rm(h.path(F));
    await c.refresh();
    expect(c.summary(NOW).today.total).toBe(0);
    expect(c.findFile(() => true)).toBeUndefined();
  });

  it("파일이 교체(크기 감소)되면 처음부터 다시 읽는다", async () => {
    await h.append(F, [
      assistant({ requestId: "old1", ts: NOW - 1000, output: 50 }),
      assistant({ requestId: "old2", ts: NOW - 1000, output: 50 }),
    ]);
    await c.refresh();
    await writeFile(h.path(F), JSON.stringify(assistant({ requestId: "new", ts: NOW - 1000, output: 4 })) + "\n");
    await c.refresh();
    expect(c.summary(NOW).today.total).toBe(4);
  });

  it("hourly는 마지막 칸이 현재 시간대다", async () => {
    await h.append(F, [
      assistant({ requestId: "a", ts: NOW - 10 * 60_000, output: 1 }),
      assistant({ requestId: "b", ts: NOW - 2.5 * HOUR, output: 2 }),
    ]);
    await c.refresh();
    const { hourly } = c.summary(NOW);
    expect(hourly).toHaveLength(24);
    expect(hourly[23]).toBe(1);
    expect(hourly[21]).toBe(2);
  });

  it("byModel, fileTotal, lastUsage, mtime, findFile", async () => {
    await h.append(F, [
      assistant({ requestId: "a", ts: NOW - 2000, model: "claude-opus-5-5", input: 5, output: 1 }),
      assistant({ requestId: "b", ts: NOW - 1000, model: "claude-sonnet-5", input: 7, cacheRead: 3, output: 2 }),
    ]);
    await h.append("projects/-p/s1/subagents/agent-x.jsonl", [assistant({ requestId: "c", ts: NOW - 500, output: 4 })]);
    await c.refresh();
    const file = c.findFile((p) => p.endsWith("/s1.jsonl"))!;
    expect(file).toBe(h.path(F));
    expect(c.fileTotal(file).total).toBe(15);
    expect(c.lastUsage(file)).toMatchObject({ model: "claude-sonnet-5", sum: { input: 7, cacheRead: 3 } });
    expect(c.mtime(file)).toBeGreaterThan(0);
    const models = Object.fromEntries(c.summary(NOW).byModel.map((m) => [m.model, m.total]));
    expect(models).toEqual({ "claude-opus-5-5": 10, "claude-sonnet-5": 9 });
  });

  it("projects 폴더가 없으면 빈 결과", async () => {
    await c.refresh();
    expect(c.summary(NOW).last7d.total).toBe(0);
  });

  it("`.jsonl` 이름의 디렉터리가 있어도 다른 파일은 수집한다", async () => {
    await h.write("projects/weird.jsonl/placeholder.txt", "x");
    await h.append("projects/z/ok.jsonl", [assistant({ requestId: "a", ts: NOW - 1000, output: 5 })]);
    await c.refresh();
    expect(c.summary(NOW).today.total).toBe(5);
  });

  it("같은 requestId가 두 파일에 있을 때 한 파일을 지워도 남은 파일의 토큰은 유지된다", async () => {
    const dup = assistant({ requestId: "dup", ts: NOW - 1000, output: 10 });
    await h.append(F, [dup]);
    await h.append("projects/-p/s1/subagents/agent-x.jsonl", [dup]);
    await c.refresh();
    expect(c.summary(NOW).today.total).toBe(10);

    await rm(h.path(F));
    await c.refresh();
    expect(c.summary(NOW).today.total).toBe(10);
  });
});
