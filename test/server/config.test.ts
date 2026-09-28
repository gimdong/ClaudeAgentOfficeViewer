import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONTEXT_WINDOW, loadConfig } from "../../server/config";
import { contextInfo } from "../../server/collectors/context";
import { makeHome, type FakeHome } from "../helpers/fakeHome";

let h: FakeHome;
beforeEach(async () => {
  h = await makeHome();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await h.cleanup();
});

describe("loadConfig", () => {
  it("파일이 없으면 기본값", async () => {
    expect(await loadConfig(h.path("none.json"))).toEqual({ budget: {}, contextWindows: {} });
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("양수만 받아들인다", async () => {
    await h.write("c.json", { budget: { fiveHour: 500000, weekly: -1 }, contextWindows: { "claude-opus": 1000000, bad: "x" } });
    expect(await loadConfig(h.path("c.json"))).toEqual({ budget: { fiveHour: 500000, weekly: undefined }, contextWindows: { "claude-opus": 1000000 } });
  });

  it("깨진 JSON이면 경고 후 기본값", async () => {
    await h.write("c.json", "{oops");
    expect(await loadConfig(h.path("c.json"))).toEqual({ budget: {}, contextWindows: {} });
    expect(console.warn).toHaveBeenCalledOnce();
  });
});

describe("contextInfo", () => {
  const sum = { input: 1000, output: 500, cacheRead: 40000, cacheWrite: 9000, total: 10500 };

  it("used = input + cacheRead + cacheWrite, 가장 긴 접두어가 맞는 창 크기를 쓴다", () => {
    const info = contextInfo({ ts: 0, model: "claude-opus-5-5", sum }, { claude: 100000, "claude-opus": 1000000 });
    expect(info).toEqual({ used: 50000, window: 1000000, pct: 5, estimated: false });
  });

  it("모르는 모델은 기본 창으로 추정한다", () => {
    const info = contextInfo({ ts: 0, model: "mystery", sum }, {});
    expect(info).toEqual({ used: 50000, window: DEFAULT_CONTEXT_WINDOW, pct: 25, estimated: true });
  });

  it("사용률은 100을 넘지 않고, 기록이 없으면 null", () => {
    const big = { ...sum, cacheRead: 999999 };
    expect(contextInfo({ ts: 0, model: "x", sum: big }, {})!.pct).toBe(100);
    expect(contextInfo(undefined, {})).toBeNull();
  });
});
