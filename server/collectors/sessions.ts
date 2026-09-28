import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface SessionRecord {
  pid: number;
  sessionId: string;
  name: string;
  cwd: string;
  status: string;
  startedAt: number;
  updatedAt: number;
  alive: boolean;
}

const DAY = 86_400_000;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function readSessions(claudeHome: string, now = Date.now(), isAlive = pidAlive): Promise<SessionRecord[]> {
  const dir = join(claudeHome, "sessions");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }

  const out: SessionRecord[] = [];
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(await readFile(join(dir, n), "utf8"));
    } catch {
      console.warn(`[sessions] ${n}: JSON을 읽을 수 없어 건너뜁니다`);
      continue;
    }
    const pid = num(raw?.pid);
    const sessionId = str(raw?.sessionId);
    if (pid === undefined || !sessionId) {
      console.warn(`[sessions] ${n}: pid 또는 sessionId가 없어 건너뜁니다`);
      continue;
    }
    const alive = isAlive(pid);
    const updatedAt = num(raw.updatedAt) ?? num(raw.startedAt) ?? 0;
    if (!alive && now - updatedAt > DAY) continue;
    out.push({
      pid,
      sessionId,
      name: str(raw.name) ?? sessionId.slice(0, 8),
      cwd: str(raw.cwd) ?? "",
      status: str(raw.status) ?? "idle",
      startedAt: num(raw.startedAt) ?? 0,
      updatedAt,
      alive,
    });
  }
  return out;
}
