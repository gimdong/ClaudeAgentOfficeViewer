import { readFile } from "node:fs/promises";

export interface OfficeConfig {
  budget: { fiveHour?: number; weekly?: number };
  contextWindows: Record<string, number>;
}

export const DEFAULT_CONTEXT_WINDOW = 200_000;

const pos = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);

export async function loadConfig(path: string): Promise<OfficeConfig> {
  let raw: { budget?: Record<string, unknown>; contextWindows?: Record<string, unknown> };
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[config] ${path}을 읽지 못해 기본값을 씁니다: ${(e as Error).message}`);
    }
    return { budget: {}, contextWindows: {} };
  }
  const contextWindows: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw?.contextWindows ?? {})) {
    const p = pos(v);
    if (p) contextWindows[k] = p;
  }
  return { budget: { fiveHour: pos(raw?.budget?.fiveHour), weekly: pos(raw?.budget?.weekly) }, contextWindows };
}
