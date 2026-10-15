import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { SubagentDesk } from "../../src/shared/types";
import { agentOf } from "../events/summarize";
import { warnCaught } from "../log";
import type { UsageCollector } from "./usage";

/** 끝난 뒤(또는 대화 기록이 마지막으로 바뀐 뒤) 임시 책상을 남겨 두는 시간, working 판정 창(Ruling B171) */
export const SUBAGENT_LINGER_MS = 30_000;

interface Run {
  startedAt: number;
  stoppedAt?: number;
}

/**
 * 서브에이전트의 시작·끝 시각(B171). EventStore는 서브에이전트 이벤트를 리드에 합쳐 저장하므로 agent_id별로 따로 기억한다.
 * 메모리만 쓴다 — 서버를 다시 켜면 비고, 그때는 대화 기록 mtime만으로 판정한다. 팀원·내부 보조 에이전트는 세지 않는다
 */
export class SubagentTracker {
  private runs = new Map<string, Map<string, Run>>();

  onEvent(input: Record<string, unknown>, now = Date.now()): void {
    const event = input.hook_event_name;
    if (event !== "SubagentStart" && event !== "SubagentStop") return;
    const session = input.session_id, id = input.agent_id;
    if (typeof session !== "string" || typeof id !== "string") return;
    const ref = agentOf(input);
    if (!ref?.sub || !ref.subType) return;
    let m = this.runs.get(session);
    if (!m) this.runs.set(session, (m = new Map()));
    if (event === "SubagentStart") m.set(id, { startedAt: now });
    else m.set(id, { startedAt: m.get(id)?.startedAt ?? now, stoppedAt: now });
  }

  get(sessionId: string, agentId: string): Run | undefined {
    return this.runs.get(sessionId)?.get(agentId);
  }

  size(): number {
    let n = 0;
    for (const m of this.runs.values()) n += m.size;
    return n;
  }

  /** 끝난 지 창 두 배가 지난 기록을 지운다(창 안 판정에는 영향 없음) */
  prune(now = Date.now()): void {
    for (const [session, m] of this.runs) {
      for (const [id, r] of m) if (r.stoppedAt !== undefined && now - r.stoppedAt > 2 * SUBAGENT_LINGER_MS) m.delete(id);
      if (m.size === 0) this.runs.delete(session);
    }
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * 살아 있는 리드 세션의 `projects/<p>/<sessionId>/subagents/`에서 이름(name)이 없는 meta만(이름 있는 것은 팀원 — teams.ts).
 * 맡긴 일(description)은 사용자 글이라 스냅샷에만 싣고 로그에는 넣지 않는다(B172) — 경고에는 파일 종류만 남긴다
 */
export async function readSubagents(
  projectsDir: string,
  sessionId: string,
  usage: Pick<UsageCollector, "fileTotal" | "lastUsage" | "mtime">,
  tracker: SubagentTracker | undefined,
  now: number,
): Promise<SubagentDesk[]> {
  const out: SubagentDesk[] = [];
  let projects: string[];
  try {
    projects = await readdir(projectsDir);
  } catch {
    return out;
  }
  for (const project of projects) {
    const dir = join(projectsDir, project, sessionId, "subagents");
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue; // 서브에이전트를 쓰지 않은 세션은 폴더가 없다
    }
    for (const n of names) {
      if (!n.startsWith("agent-") || !n.endsWith(".meta.json")) continue;
      let meta: Record<string, unknown>;
      try {
        meta = JSON.parse(await readFile(join(dir, n), "utf8")) ?? {};
      } catch (e) {
        warnCaught("subagents", "cannot read subagent meta", e, "meta.json");
        continue;
      }
      if (str(meta.name)) continue; // 팀원
      const id = basename(n, ".meta.json").slice("agent-".length);
      const file = join(dir, `agent-${id}.jsonl`);
      const mtime = usage.mtime(file);
      const run = tracker?.get(sessionId, id);
      const running = !!run && run.stoppedAt === undefined;
      const fresh = mtime !== undefined && now - mtime <= SUBAGENT_LINGER_MS;
      const end = Math.max(run?.stoppedAt ?? 0, mtime ?? 0);
      const working = running || fresh;
      if (!working && !(end && now - end < SUBAGENT_LINGER_MS)) continue;
      const model = usage.lastUsage(file)?.model;
      out.push({ id, type: str(meta.agentType), description: str(meta.description), ...(model ? { model } : {}), tokens: usage.fileTotal(file).total, working });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
