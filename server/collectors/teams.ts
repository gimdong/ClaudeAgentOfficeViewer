import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { MemberState } from "../../src/shared/types";

export interface TeamMemberRecord {
  name: string;
  agentType: string;
  model?: string;
  color?: string;
  transcript?: string;
  unread: number;
}

export interface TeamRecord {
  name: string;
  leadSessionId: string;
  members: TeamMemberRecord[];
}

export const ACTIVE_WINDOW_MS = 10_000;

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

async function readdirOrEmpty(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw e;
  }
}

export async function countUnread(inboxPath: string): Promise<number> {
  try {
    const v: unknown = JSON.parse(await readFile(inboxPath, "utf8"));
    if (!Array.isArray(v)) return 0;
    return v.filter((m) => !(m && typeof m === "object" && (m as { read?: unknown }).read === true)).length;
  } catch {
    return 0;
  }
}

async function findTranscripts(projectsDir: string, sessionId: string): Promise<Map<string, string>> {
  const best = new Map<string, { path: string; mtime: number }>();
  for (const project of await readdirOrEmpty(projectsDir)) {
    const dir = join(projectsDir, project, sessionId, "subagents");
    for (const n of await readdirOrEmpty(dir)) {
      if (!n.endsWith(".meta.json")) continue;
      let name: string | undefined;
      try {
        name = str(JSON.parse(await readFile(join(dir, n), "utf8"))?.name);
      } catch {
        continue;
      }
      if (!name) continue;
      const path = join(dir, n.replace(/\.meta\.json$/, ".jsonl"));
      try {
        const { mtimeMs } = await stat(path);
        const cur = best.get(name);
        if (!cur || mtimeMs > cur.mtime) best.set(name, { path, mtime: mtimeMs });
      } catch {
        // meta만 있고 기록 파일이 없는 경우
      }
    }
  }
  return new Map([...best].map(([k, v]) => [k, v.path]));
}

export async function readTeams(claudeHome: string): Promise<TeamRecord[]> {
  const teamsDir = join(claudeHome, "teams");
  let names: string[];
  try {
    names = await readdir(teamsDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }

  const out: TeamRecord[] = [];
  for (const dirName of names) {
    const teamDir = join(teamsDir, dirName);
    let config: { name?: unknown; leadSessionId?: unknown; members?: unknown };
    try {
      config = JSON.parse(await readFile(join(teamDir, "config.json"), "utf8"));
    } catch {
      continue; // config가 없으면 이 세션은 리드만 있는 1인 사무실이 된다
    }
    const leadSessionId = str(config.leadSessionId);
    if (!leadSessionId) continue;
    const transcripts = await findTranscripts(join(claudeHome, "projects"), leadSessionId);
    const members: TeamMemberRecord[] = [];
    for (const m of Array.isArray(config.members) ? config.members : []) {
      const name = str(m?.name);
      if (!name || name === "team-lead" || m?.agentType === "team-lead") continue;
      members.push({
        name,
        agentType: str(m.agentType) ?? "unknown",
        model: str(m.model),
        color: str(m.color),
        transcript: transcripts.get(name),
        unread: await countUnread(join(teamDir, "inboxes", `${name}.json`)),
      });
    }
    out.push({ name: str(config.name) ?? dirName, leadSessionId, members });
  }
  return out;
}

function hasPendingToolUse(entry: unknown): boolean {
  const e = entry as { type?: string; message?: { content?: unknown } } | undefined;
  const content = e?.type === "assistant" ? e.message?.content : undefined;
  return Array.isArray(content) && content.some((c) => (c as { type?: string } | null)?.type === "tool_use");
}

export function memberState(i: {
  sessionAlive: boolean;
  unread: number;
  transcriptMtime?: number;
  lastEntry?: unknown;
  now: number;
}): MemberState {
  if (!i.sessionAlive) return "offline";
  if (i.unread > 0) return "mail";
  if (i.transcriptMtime !== undefined && i.now - i.transcriptMtime <= ACTIVE_WINDOW_MS) return "working";
  if (hasPendingToolUse(i.lastEntry)) return "working";
  return "idle";
}
