import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLimits } from "../../server/collectors/limits";
import { makeHome, type FakeHome } from "../helpers/fakeHome";

let h: FakeHome;
beforeEach(async () => { h = await makeHome(); });
afterEach(() => h.cleanup());
const P = "claude-office/limits.json";

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
    expect(await readLimits(h.home)).toEqual({ fiveHourPct: 42.5, weeklyPct: 100, resetsAt: "2026-09-28T18:00:00.000Z", source: "statusline" });
  });

  it("camelCase와 epoch 초 단위 resets_at도 받아들인다", async () => {
    await h.write(P, { rateLimits: { fiveHour: { usedPercentage: 10, resetsAt: 1790600000 } } });
    expect(await readLimits(h.home)).toEqual({ fiveHourPct: 10, weeklyPct: undefined, resetsAt: new Date(1790600000 * 1000).toISOString(), source: "statusline" });
  });
});
