import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DoctorItem } from "../../src/shared/types";

/**
 * 에이전트 기록 점검(beta.22). 회사 PC(Claude Code 2.1.305)에서 리드가 Agent를 불렀는데 대시보드가 읽는 자리
 * (`projects/<p>/<대화>/subagents/*.meta.json`, 팀 설정 `teams/<t>/config.json`)에 아무것도 없어 책상이 생기지 않았다.
 * 이 자리는 문서에 없는 관찰이라 버전마다 바뀔 수 있다 — 그때 진단 파일 하나로 알아보게 층마다 개수만 남긴다(id·이름 없음)
 */
export interface AgentCheck {
  /** 살아 있는 층의 순번(1부터) */
  floor: number;
  /** 대화가 bg job으로 옮겨 간 층(B192) */
  bg: boolean;
  /** 대시보드가 그린 책상(리드 포함)·서브에이전트 책상 수 */
  members: number;
  subagents: number;
  /** 리드 대화 기록 끝부분의 Agent·Task 도구 호출 수 */
  agentCalls: number;
  /** `<대화>/` 폴더가 있는가 */
  folder: boolean;
  /** subagents meta 수, 그중 이름(name)이 있는 것 */
  metas: number;
  named: number;
  /** 이 대화를 리드로 둔 팀 설정이 있는가 */
  team: boolean;
  /** Agent를 불렀는데 대시보드가 읽는 자리에 기록이 하나도 없다 */
  missing: boolean;
}

/** 대화 기록은 클 수 있어 끝부분만 본다 */
const TAIL = 4 * 1024 * 1024;
const AGENT_CALL = /"type":"tool_use"[^{}]*?"name":"(?:Agent|Task)"/g;

const ls = (d: string) => readdir(d).catch(() => [] as string[]);

async function tail(file: string): Promise<string> {
  const f = await open(file, "r");
  try {
    const { size } = await f.stat();
    const len = Math.min(size, TAIL);
    const buf = Buffer.alloc(len);
    await f.read(buf, 0, len, size - len);
    return buf.toString("utf8");
  } finally {
    await f.close();
  }
}

export async function checkAgents(claudeHome: string, floors: ReadonlyArray<{ conv: string; bg: boolean; members: number; subagents: number }>): Promise<AgentCheck[]> {
  const projects = join(claudeHome, "projects");
  const dirs = await ls(projects);
  const leads = new Set<string>();
  for (const t of await ls(join(claudeHome, "teams"))) {
    try {
      const id = JSON.parse(await readFile(join(claudeHome, "teams", t, "config.json"), "utf8"))?.leadSessionId;
      if (typeof id === "string") leads.add(id);
    } catch {
      /* 깨진 팀 설정은 건너뛴다 */
    }
  }
  const out: AgentCheck[] = [];
  for (const [i, f] of floors.entries()) {
    let agentCalls = 0;
    let folder = false;
    let metas = 0;
    let named = 0;
    for (const p of dirs) {
      agentCalls += await tail(join(projects, p, `${f.conv}.jsonl`)).then((t) => t.match(AGENT_CALL)?.length ?? 0, () => 0);
      if (!(await stat(join(projects, p, f.conv)).then((s) => s.isDirectory(), () => false))) continue;
      folder = true;
      const sub = join(projects, p, f.conv, "subagents");
      for (const n of await ls(sub)) {
        if (!n.endsWith(".meta.json")) continue;
        metas++;
        if (await readFile(join(sub, n), "utf8").then((t) => !!JSON.parse(t)?.name, () => false)) named++;
      }
    }
    const team = leads.has(f.conv);
    out.push({ floor: i + 1, bg: f.bg, members: f.members, subagents: f.subagents, agentCalls, folder, metas, named, team, missing: agentCalls > 0 && metas === 0 && !team });
  }
  return out;
}

/** 진단 탭·진단 파일의 점검 항목 하나 */
export function agentsItem(checks: readonly AgentCheck[]): DoctorItem {
  const n = checks.filter((c) => c.missing).length;
  return n
    ? {
        id: "agents",
        status: "warn",
        title: "에이전트 기록",
        detail: `에이전트를 불렀는데 대시보드가 읽는 자리에 기록이 없는 층이 ${n}개 있습니다. 이 층의 팀원·서브에이전트는 책상에 보이지 않을 수 있습니다(Claude Code 버전에 따라 기록 위치가 다를 수 있음).`,
        fix: "진단 파일을 만들어 보내 주세요(층마다 개수만 담깁니다).",
      }
    : { id: "agents", status: "ok", title: "에이전트 기록", detail: "살아 있는 층의 에이전트 기록을 찾았습니다(또는 부른 에이전트가 없음).", fix: "" };
}
