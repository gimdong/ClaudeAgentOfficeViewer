import { describe, expect, it } from "vitest";
import { addSum, emptySum, usageToSum } from "../../src/shared/tokens";

describe("tokens", () => {
  it("usage 객체를 TokenSum으로 바꾸고 total에서 cacheRead를 뺀다", () => {
    expect(
      usageToSum({ input_tokens: 2, output_tokens: 420, cache_read_input_tokens: 9000, cache_creation_input_tokens: 39359 }),
    ).toEqual({ input: 2, output: 420, cacheRead: 9000, cacheWrite: 39359, total: 39781 });
  });

  it("없거나 잘못된 값은 0으로 본다", () => {
    expect(usageToSum(undefined)).toEqual(emptySum());
    expect(usageToSum({ input_tokens: -5, output_tokens: "7", cache_read_input_tokens: NaN })).toEqual(emptySum());
  });

  it("addSum은 항목별로 더한다", () => {
    const a = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 7 };
    expect(addSum(a, a)).toEqual({ input: 2, output: 4, cacheRead: 6, cacheWrite: 8, total: 14 });
  });
});
