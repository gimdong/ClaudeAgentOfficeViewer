import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { SubagentDesk } from "../../src/shared/types";
import { agentOf } from "../events/summarize";
import { warnCaught } from "../log";
import type { UsageCollector } from "./usage";

/** 끝난 뒤(또는 대화 기록이 마지막으로 바뀐 뒤) 임시 책상을 남겨 두는 시간, working 판정 창(Ruling B171) */
export const SUBAGENT_LINGER_MS = 30_000;
/** Stop을 못 받아도 대화 기록이 이만큼 그대로면 끝난 것으로 본다(B177 I1 a) */
export const SUBAGENT_STALE_MS = 10 * 60_000;
/** Stop 없는 기록을 지우는 시간, 기록 총수 상한(B177 I1 b — /hooks/event는 인증하지 않아 가짜 Start로 커질 수 있다) */
const RUN_MAX_AGE_MS = 3_600_000;
export const SUBAGENT_MAX_RUNS = 1000;

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
    if (this.size() > SUBAGENT_MAX_RUNS) this.dropOldest();
  }

  // ponytail: 넘칠 때마다 전체를 훑는다(최대 1000개). 더 커지면 시작 순 큐로
  private dropOldest(): void {
    let oldest: { session: string; id: string; at: number } | undefined;
    for (const [session, m] of this.runs) for (const [id, r] of m) if (!oldest || r.startedAt < oldest.at) oldest = { session, id, at: r.startedAt };
    if (!oldest) return;
    const m = this.runs.get(oldest.session)!;
    m.delete(oldest.id);
    if (m.size === 0) this.runs.delete(oldest.session);
  }

  get(sessionId: string, agentId: string): Run | undefined {
    return this.runs.get(sessionId)?.get(agentId);
  }

  size(): number {
    let n = 0;
    for (const m of this.runs.values()) n += m.size;
    return n;
  }

  /** 끝난 지 창 두 배가 지난 기록, Stop 없이 시작 뒤 1시간이 지난 기록을 지운다 */
  prune(now = Date.now()): void {
    for (const [session, m] of this.runs) {
      for (const [id, r] of m) if (r.stoppedAt !== undefined ? now - r.stoppedAt > 2 * SUBAGENT_LINGER_MS : now - r.startedAt > RUN_MAX_AGE_MS) m.delete(id);
      if (m.size === 0) this.runs.delete(session);
    }
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * 살아 있는 리드 세션의 `<리드 대화 기록 폴더>/<sessionId>/subagents/` 하나에서(B177 M1 — projects 전체를 훑지 않는다) 이름(name)이 없는 meta만(이름 있는 것은 팀원 — teams.ts).
 * 맡긴 일(description)은 사용자 글이라 스냅샷에만 싣고 로그에는 넣지 않는다(B172) — 경고에는 파일 종류만 남긴다
 */
export async function readSubagents(
  dir: string,
  sessionId: string,
  usage: Pick<UsageCollector, "fileTotal" | "lastUsage" | "mtime">,
  tracker: SubagentTracker | undefined,
  now: number,
): Promise<SubagentDesk[]> {
  const out: Array<{ desk: SubagentDesk; start: number }> = [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return []; // 서브에이전트를 쓰지 않은 세션은 폴더가 없다
  }
  for (const n of names) {
    if (!n.startsWith("agent-") || !n.endsWith(".meta.json")) continue;
    const id = basename(n, ".meta.json").slice("agent-".length);
    const file = join(dir, `agent-${id}.jsonl`);
    const mtime = usage.mtime(file);
    const run = tracker?.get(sessionId, id);
    // 기록도 없고 대화 기록도 창 밖이면 보일 수 없다 — meta를 읽지 않는다(B177 M1)
    if (!run && (mtime === undefined || now - mtime >= SUBAGENT_LINGER_MS)) continue;
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(await readFile(join(dir, n), "utf8")) ?? {};
    } catch (e) {
      warnCaught("subagents", "cannot read subagent meta", e, "meta.json");
      continue;
    }
    if (str(meta.name)) continue; // 팀원
    // 기록이 있으면 기록이 우선(Stop 직후에도 mtime은 새것이라 "끝남"이 안 보이게 된다, B175). 기록이 없을 때(서버 재시작)만 mtime 30초.
    // Stop을 못 받았어도 대화 기록이 10분 넘게 그대로면 끝난 것으로 보고, 끝 시각은 그 mtime이다(B177 I1 a)
    const stale = !!run && run.stoppedAt === undefined && mtime !== undefined && now - mtime > SUBAGENT_STALE_MS;
    const working = run ? run.stoppedAt === undefined && !stale : mtime !== undefined && now - mtime <= SUBAGENT_LINGER_MS;
    const end = stale ? mtime! : Math.max(run?.stoppedAt ?? 0, mtime ?? 0);
    if (!working && !(end && now - end < SUBAGENT_LINGER_MS)) continue;
    const model = usage.lastUsage(file)?.model;
    const desk: SubagentDesk = { id, type: str(meta.agentType), description: str(meta.description), ...(model ? { model } : {}), tokens: usage.fileTotal(file).total, working };
    out.push({ desk, start: run?.startedAt ?? mtime ?? 0 });
  }
  // 일하는 중 먼저, 그 안에서 먼저 시작한 것부터(기록이 없으면 mtime). 스냅샷마다 순서가 흔들리지 않게 id로 끝을 맺는다(명세 §7, B175)
  out.sort((a, b) => Number(b.desk.working) - Number(a.desk.working) || a.start - b.start || a.desk.id.localeCompare(b.desk.id));
  return out.map((x) => x.desk);
}
