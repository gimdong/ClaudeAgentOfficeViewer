import type { TokenSum } from "./types";

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

export function emptySum(): TokenSum {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

export function usageToSum(u: unknown): TokenSum {
  const o = (u ?? {}) as Record<string, unknown>;
  const input = n(o.input_tokens);
  const output = n(o.output_tokens);
  const cacheRead = n(o.cache_read_input_tokens);
  const cacheWrite = n(o.cache_creation_input_tokens);
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheWrite };
}

export function addSum(a: TokenSum, b: TokenSum): TokenSum {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    total: a.total + b.total,
  };
}
