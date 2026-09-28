import type { ContextInfo } from "../../src/shared/types";
import { DEFAULT_CONTEXT_WINDOW } from "../config";
import type { LastUsage } from "./usage";

export function contextInfo(last: LastUsage | undefined, windows: Record<string, number>): ContextInfo | null {
  if (!last) return null;
  const used = last.sum.input + last.sum.cacheRead + last.sum.cacheWrite;
  const key = Object.keys(windows)
    .filter((k) => last.model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  const window = key ? windows[key] : DEFAULT_CONTEXT_WINDOW;
  return { used, window, pct: Math.min(100, Math.round((used / window) * 1000) / 10), estimated: !key };
}
