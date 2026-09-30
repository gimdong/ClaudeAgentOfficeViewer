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

// findTranscripts 안에서만 쓴다. projects/ 아래 프로젝트 폴더 하나가 EACCES 등으로 못 읽어도
// 그 폴더만 건너뛰고 다른 프로젝트에서 팀원 전사록을 계속 찾는다 — 그 오류를 findTranscripts
// 밖으로 새어나가게 하면 readTeams 전체가 죽어 모든 세션의 팀원이 한꺼번에 사라진다(readTeams
// 최상위 teams/ 디렉터리 읽기는 이 함수를 쓰지 않고 여전히 ENOENT 외 오류를 그대로 던진다).
async function readdirOrEmpty(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
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

/**
 * team config의 leadSessionId가 실제로 그 팀을 쓰는 세션과 다를 수 있다(Ruling P19 — Phase 0 T0.1/T0.1-review
 * 관찰: in-process 팀원의 세션 id가 나중에 leadSessionId와 어긋남). leadSessionId로 못 찾으면 이 세션
 * 자신의 subagents meta에 적힌 teamName으로 팀을 역으로 찾는다. meta 파일 하나가 깨져도 그 파일만 건너뛴다.
 */
export async function findTeamNameForSession(projectsDir: string, sessionId: string): Promise<string | undefined> {
  for (const project of await readdirOrEmpty(projectsDir)) {
    const dir = join(projectsDir, project, sessionId, "subagents");
    for (const n of await readdirOrEmpty(dir)) {
      if (!n.endsWith(".meta.json")) continue;
      try {
        const teamName = str(JSON.parse(await readFile(join(dir, n), "utf8"))?.teamName);
        if (teamName) return teamName;
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

/** team을 leadSessionId가 아닌 다른 세션에 붙일 때, 팀원 transcript를 그 세션 폴더 기준으로 다시 찾는다(Ruling P19) */
export async function withTranscriptsFor(team: TeamRecord, projectsDir: string, sessionId: string): Promise<TeamRecord> {
  const transcripts = await findTranscripts(projectsDir, sessionId);
  return { ...team, members: team.members.map((m) => ({ ...m, transcript: transcripts.get(m.name) })) };
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
    // JSON.parse는 "null"/숫자/문자열도 성공적으로 파싱하므로(예: config.json 내용이 "null"),
    // 객체가 아니면 이 팀만 건너뛴다 — 한 팀의 손상된 config가 나머지 팀 수집을 막지 않게 한다.
    if (!config || typeof config !== "object") continue;
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
