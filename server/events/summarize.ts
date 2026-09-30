/**
 * hook 입력의 tool_input에서 화면에 필요한 필드만 남긴다(스펙 5장). 원문은 메모리에도 남기지 않는다.
 * 문자열은 그래핌(사용자가 보는 글자 하나) 단위로 MAX_FIELD자까지 자른다 — ZWJ로 묶인 이모지가
 * 경계에서 쪼개지지 않게 Intl.Segmenter를 쓰고, 없으면 코드포인트 단위(Array.from)로 대체한다.
 */
export const MAX_FIELD = 200;

export interface ToolSummary {
  command?: string;
  description?: string;
  filePath?: string;
  pattern?: string;
  query?: string;
  domain?: string;
  to?: string;
  /** 문자열: 진행 중 할 일, null: 진행 중 표시를 지움, 없음: 할 일과 무관 */
  activeForm?: string | null;
  question?: string;
}

// 그래핌 단위 분해. Intl.Segmenter가 없는 런타임을 대비해 코드포인트 단위로 대체한다.
const toGraphemes: (s: string) => string[] = (() => {
  try {
    const seg = new Intl.Segmenter("ko", { granularity: "grapheme" });
    return (s: string) => Array.from(seg.segment(s), (x) => x.segment);
  } catch {
    return (s: string) => Array.from(s);
  }
})();

// Ruling P9(team-lead 확장): summarize()가 남기는 모든 문자열 필드는 EventStore → 스냅샷 → SSE → 브라우저로
// 그대로 이어지므로 비밀값으로 보이는 형식을 지운다. 잘린 토큰 조각이 남지 않도록 cut(200자)보다 먼저 적용한다.
// 값은 공백이나 닫는 따옴표·괄호 앞에서 멈춘다 — curl -H "Authorization: Bearer xyz" 같은 형태에서 닫는 "를 삼키지 않기 위해
const VALUE = `[^\\s"')\\]}]+`;
const SECRET_NAME = new RegExp(`\\b(\\w*(?:token|secret|key|password|passwd|pwd)\\w*)(\\s*[:=]\\s*)(${VALUE})`, "gi");
const AUTH_BEARER = new RegExp(`\\b(authorization)(\\s*[:=]\\s*)(bearer)(\\s+)(${VALUE})`, "gi");
const AUTH_BARE = new RegExp(`\\b(authorization)(\\s*[:=]\\s*)(?!bearer\\b)(${VALUE})`, "gi");
const BEARER_BARE = new RegExp(`\\b(bearer)(\\s+)(${VALUE})`, "gi");
const PREFIX_TOKEN = /\b(?:sk|ghp|gho|xox[abp]|AKIA)[-_A-Za-z0-9]{8,}/g;
const URL_CREDS = /\/\/[^/\s:@]+:[^/\s@]+@/g;
// 이름·접두어로 잡히지 않은, 32자 이상 이어진 16진수/base64 형태의 문자열을 통째로 가리는 마지막 안전망
const LONG_RANDOM = /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/=_-]{32,}(?![A-Za-z0-9+/=_-])/g;

export function redact(s: string): string {
  return s
    .replace(SECRET_NAME, (_m, name: string, sep: string) => `${name}${sep}***`)
    .replace(AUTH_BEARER, (_m, kw: string, sep: string, bearer: string, sp: string) => `${kw}${sep}${bearer}${sp}***`)
    .replace(AUTH_BARE, (_m, kw: string, sep: string) => `${kw}${sep}***`)
    .replace(BEARER_BARE, (_m, kw: string, sp: string) => `${kw}${sp}***`)
    .replace(PREFIX_TOKEN, "***")
    .replace(URL_CREDS, "//***@")
    .replace(LONG_RANDOM, "***");
}

const cut = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? toGraphemes(redact(v)).slice(0, MAX_FIELD).join("") : undefined;

function domainOf(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    return cut(new URL(url).hostname);
  } catch {
    return undefined;
  }
}

function activeFormOf(tool: string | undefined, input: Record<string, unknown>): string | null | undefined {
  if (tool === "TodoWrite") {
    const todos = Array.isArray(input.todos) ? input.todos : [];
    const cur = todos.find((t) => (t as { status?: unknown } | null)?.status === "in_progress") as { activeForm?: unknown } | undefined;
    return cut(cur?.activeForm) ?? null;
  }
  if (tool === "TaskUpdate") {
    if (input.status === "in_progress") return cut(input.activeForm);
    if (input.status === "completed" || input.status === "deleted") return null;
  }
  // TaskCreate는 할 일을 대기 상태로 만들 뿐이라 진행 중 표시에 쓰지 않는다(Ruling P2)
  return undefined;
}

export function summarize(toolName: string | undefined, input: unknown): ToolSummary {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const i = input as Record<string, unknown>;
  const firstQuestion = Array.isArray(i.questions) ? (i.questions[0] as { question?: unknown } | undefined)?.question : undefined;
  const out: ToolSummary = {
    command: cut(i.command),
    description: cut(i.description),
    filePath: cut(i.file_path ?? i.notebook_path),
    pattern: cut(i.pattern),
    query: cut(i.query),
    domain: domainOf(i.url),
    to: cut(i.to),
    activeForm: activeFormOf(toolName, i),
    question: cut(firstQuestion),
  };
  for (const k of Object.keys(out) as (keyof ToolSummary)[]) if (out[k] === undefined) delete out[k];
  return out;
}

export interface AgentRef {
  name: string;
  /** 리드에 합친 일반 서브에이전트 */
  sub: boolean;
  /** 합친 서브에이전트의 agent_type */
  subType?: string;
}

/** 일반 서브에이전트의 agent_id는 a + 16진수다. 팀원은 a<이름>-<해시>라 하이픈이 들어간다(Phase 0 T0.1) */
const SUBAGENT_ID = /^a[0-9a-f]{8,}$/;

/** 이벤트를 어느 캐릭터에 붙일지 정한다. null이면 저장하지 않는다(스펙 2장 3번, 5장). */
export function agentOf(input: Record<string, unknown>): AgentRef | null {
  const event = input.hook_event_name;
  if (event === "TeammateIdle") {
    return typeof input.teammate_name === "string" && input.teammate_name ? { name: input.teammate_name, sub: false } : null;
  }
  const id = input.agent_id;
  if (typeof id !== "string" || !id) return { name: "team-lead", sub: false };
  const type = typeof input.agent_type === "string" ? input.agent_type : "";
  // 턴 뒤에 도는 내부 보조 에이전트는 agent_type이 비어 있다. 캐릭터가 없으므로 버린다
  if (!type && (event === "SubagentStart" || event === "SubagentStop")) return null;
  if (SUBAGENT_ID.test(id)) return type ? { name: "team-lead", sub: true, subType: type } : { name: "team-lead", sub: true };
  return type ? { name: type, sub: false } : null;
}
