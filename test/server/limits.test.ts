import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLimits } from "../../server/collectors/limits";
import { makeHome, type FakeHome } from "../helpers/fakeHome";

let h: FakeHome;
beforeEach(async () => { h = await makeHome(); });
afterEach(() => h.cleanup());
const P = "claude-office/limits.json";
// 브리핑의 원래 테스트 3·4는 resets_at으로 고정된 시각을 쓴다. Fix round 1에서 readLimits가
// "이미 지난 창"의 pct를 지우도록 바뀌면서, 실제 벽시계 Date.now()를 그대로 쓰면 그 고정
// 시각을 이미 지났는지 여부가 테스트를 실행하는 시점에 따라 달라져 깨질 수 있다(실제로 이
// 세션에서 테스트 4의 resets_at은 이미 지난 시각이 되어 있었다). 두 테스트 모두 명시적인
// now를 넘겨 시계에 의존하지 않게 한다 — director가 허용한 최소 수정.
const FIXED_NOW = Date.parse("2026-09-28T00:00:00Z");

describe("readLimits", () => {
  it("파일이 없거나 깨졌으면 null", async () => {
    expect(await readLimits(h.home)).toBeNull();
    await h.write(P, "{");
    expect(await readLimits(h.home)).toBeNull();
  });

  it("rate_limits 필드가 없으면 null", async () => {
    await h.write(P, { model: { display_name: "Opus" } });
    expect(await readLimits(h.home)).toBeNull();
  });

  it("snake_case 필드를 읽고 0~100으로 자른다", async () => {
    await h.write(P, { rate_limits: { five_hour: { used_percentage: 42.5, resets_at: "2026-09-28T18:00:00Z" }, seven_day: { used_percentage: 130 } } });
    expect(await readLimits(h.home, FIXED_NOW)).toEqual({ fiveHourPct: 42.5, weeklyPct: 100, resetsAt: "2026-09-28T18:00:00.000Z", source: "statusline" });
  });

  it("camelCase와 epoch 초 단위 resets_at도 받아들인다", async () => {
    await h.write(P, { rateLimits: { fiveHour: { usedPercentage: 10, resetsAt: 1790600000 } } });
    expect(await readLimits(h.home, FIXED_NOW)).toEqual({ fiveHourPct: 10, weeklyPct: undefined, resetsAt: new Date(1790600000 * 1000).toISOString(), source: "statusline" });
  });

  it("resets_at이 지난 창은 무시한다", async () => {
    await h.write(P, {
      rate_limits: {
        five_hour: { used_percentage: 90, resets_at: "2026-01-01T00:00:00Z" }, // 이미 지남
        seven_day: { used_percentage: 50, resets_at: "2026-06-01T00:00:00Z" }, // 아직 안 지남
      },
    });
    const now = Date.parse("2026-03-01T00:00:00Z"); // five_hour보다 뒤, seven_day보다 앞
    expect(await readLimits(h.home, now)).toEqual({
      fiveHourPct: undefined,
      weeklyPct: 50,
      resetsAt: "2026-06-01T00:00:00.000Z",
      source: "statusline",
    });
  });

  it("resets_at이 없는 창은 만료 검사 없이 pct를 그대로 쓴다", async () => {
    await h.write(P, { rate_limits: { five_hour: { used_percentage: 77 } } });
    expect(await readLimits(h.home, FIXED_NOW)).toEqual({ fiveHourPct: 77, weeklyPct: undefined, resetsAt: undefined, source: "statusline" });
  });

  it("두 창 모두 지났으면 null", async () => {
    await h.write(P, {
      rate_limits: {
        five_hour: { used_percentage: 90, resets_at: "2026-01-01T00:00:00Z" },
        seven_day: { used_percentage: 95, resets_at: "2026-01-02T00:00:00Z" },
      },
    });
    expect(await readLimits(h.home, FIXED_NOW)).toBeNull();
  });

  it("범위를 벗어난 resets_at은 무시하고(예외 없이) pct는 유지한다", async () => {
    await h.write(P, { rate_limits: { five_hour: { used_percentage: 5, resets_at: 1e20 }, seven_day: { used_percentage: 6, resets_at: -1e300 } } });
    expect(await readLimits(h.home)).toEqual({ fiveHourPct: 5, weeklyPct: 6, resetsAt: undefined, source: "statusline" });
  });

  it("spend_limit을 읽고, 100을 넘는 원래 값을 따로 보존한다", async () => {
    await h.write("claude-office/limits.json", { rate_limits: { spend_limit: { used_percentage: 130, resets_at: "2026-10-31T00:00:00Z" } } });
    expect(await readLimits(h.home, FIXED_NOW)).toMatchObject({ spendPct: 100, spendRawPct: 130, source: "statusline" });
  });

  it("초기화 시각이 지난 spend 창은 버린다", async () => {
    await h.write("claude-office/limits.json", { rate_limits: { spend_limit: { used_percentage: 50, resets_at: "2020-01-01T00:00:00Z" } } });
    expect(await readLimits(h.home, FIXED_NOW)).toBeNull();
  });
});
