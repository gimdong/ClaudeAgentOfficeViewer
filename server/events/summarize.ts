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
// lastSentence(derive.ts)도 같은 함수로 잘라야 ZWJ 이모지가 안 쪼개진다(Ruling P14).
export const toGraphemes: (s: string) => string[] = (() => {
  try {
    const seg = new Intl.Segmenter("ko", { granularity: "grapheme" });
    return (s: string) => Array.from(seg.segment(s), (x) => x.segment);
  } catch {
    return (s: string) => Array.from(s);
  }
})();

// Ruling P9/P10(team-lead 확장): summarize()가 남기는 모든 문자열 필드는 EventStore → 스냅샷 → SSE → 브라우저로
// 그대로 이어지므로 비밀값으로 보이는 형식을 지운다. 잘린 토큰 조각이 남지 않도록 cut(200자)보다 먼저 적용한다.
// 이름(NAME)은 token/secret/password/passwd/pwd를 포함하거나, key로 끝나되 앞에 _·-·api·access·private가
// 붙은 경우만 잡는다 — monkey/keyboard/sort --key=2 같은 단어 중간 "key"는 걸리지 않게(reviewer Minor).
const NAME = `(?:\\w*(?:token|secret|password|passwd|pwd)\\w*|\\w+[-_]key|(?:api|access|private)key)`;
// 이름 뒤 구분자는 JSON처럼 이름에 닫는 따옴표가 붙는 경우까지 허용한다: "token":
const SEP = `["']?\\s*[:=]\\s*`;
// AUTH 계열 값은 JWT처럼 점(.)이 들어갈 수 있어 점을 막지 않는다. 공백이나 닫는 따옴표·괄호 앞에서 멈춘다.
const VALUE = `[^\\s"')\\]}]+`;
// NAME=값 계열 값은 점을 막아 token-notes.md, api_key_rotation.md 같은 파일명의 확장자를 삼키지 않는다.
const BARE_VALUE_NO_DOT = `[^\\s"')\\]}.]+`;
// 따옴표로 감싼 값은 같은 따옴표가 다시 나올 때까지 전부(공백 포함) 값으로 본다. 따옴표 자체는 남긴다.
const QUOTED_VALUE = `(?<q>["'])(?:(?!\\k<q>).)*\\k<q>`;

const SECRET_NAME = new RegExp(`\\b(${NAME})\\b(${SEP})(${QUOTED_VALUE}|${BARE_VALUE_NO_DOT})`, "gi");
// mysql --password FAKEPASS123처럼 공백으로만 구분된 값은, 흔한 문장과 안 겹치도록 --옵션 형태에만 적용한다
const CLI_FLAG_VALUE = new RegExp(`(--(?:password|token|api-key|secret))(\\s+)(${QUOTED_VALUE}|${VALUE})`, "gi");
const AUTH_BEARER = new RegExp(`\\b(authorization)(\\s*[:=]\\s*)(bearer)(\\s+)(${VALUE})`, "gi");
const AUTH_BARE = new RegExp(`\\b(authorization)(\\s*[:=]\\s*)(?!bearer\\b)(${VALUE})`, "gi");
const BEARER_BARE = new RegExp(`\\b(bearer)(\\s+)(${VALUE})`, "gi");
// curl -u user:pass — 사용자 이름은 남기고 비밀번호만 가린다
const CURL_U = /(-u\s+[^\s:]+:)(\S+)/g;
// npm config의 //registry…/:_authToken 형태(Ruling P11) — 일반 공백 구분(CLI_FLAG_VALUE)은 오탐 위험이 있어
// 넓히지 않고, _authToken 앞에 선택적 콜론이 붙는 이 구체적인 이름만 좁게 잡는다
const AUTH_TOKEN_FIELD = new RegExp(`(:?_authToken)(=|\\s+)(${QUOTED_VALUE}|${VALUE})`, "gi");
const PREFIX_TOKEN = /\b(?:sk|ghp|gho|xox[abp]|AKIA)[-_A-Za-z0-9]{8,}/g;
const URL_CREDS = /\/\/[^/\s:@]+:[^/\s@]+@/g;
// 이름·접두어로 잡히지 않은, 32자 이상 이어진 16진수/base64 형태의 문자열을 통째로 가리는 마지막 안전망.
// Fix round 2에서 "숫자+영문 혼합"만으로는 SOME_REALLY_LONG_..._HERE=1처럼 이름 전체가 여전히 걸려서(reviewer 재확인),
// round 2 보강(Ruling P10 추가분)에서 두 규칙으로 좁힌다.
// (a) 16진수(git sha, 해시)만: 0-9와 a-f만으로 32자 이상 이어진 경우
const HEX_RUN = /\b[0-9a-f]{32,}\b/gi;
// (b) base64형: /를 빼고, 대문자·소문자·숫자가 모두 있어야 한다 — 이름만(대문자만/소문자만)인 식별자나
// 절대경로는 대개 세 종류가 다 섞이지 않으므로 자연히 빠진다.
const BASE64_RUN =
  /(?<![A-Za-z0-9+=_-])(?=[A-Za-z0-9+=_-]*[A-Z])(?=[A-Za-z0-9+=_-]*[a-z])(?=[A-Za-z0-9+=_-]*\d)[A-Za-z0-9+=_-]{32,}(?![A-Za-z0-9+=_-])/g;

const maskValue = (value: string): string => {
  const q = value[0];
  return q === '"' || q === "'" ? `${q}***${q}` : "***";
};

export function redact(s: string): string {
  return s
    .replace(SECRET_NAME, (_m, name: string, sep: string, value: string) => `${name}${sep}${maskValue(value)}`)
    .replace(CLI_FLAG_VALUE, (_m, flag: string, sp: string, value: string) => `${flag}${sp}${maskValue(value)}`)
    .replace(AUTH_BEARER, (_m, kw: string, sep: string, bearer: string, sp: string) => `${kw}${sep}${bearer}${sp}***`)
    .replace(AUTH_BARE, (_m, kw: string, sep: string) => `${kw}${sep}***`)
    .replace(BEARER_BARE, (_m, kw: string, sp: string) => `${kw}${sp}***`)
    .replace(CURL_U, (_m, prefix: string) => `${prefix}***`)
    .replace(AUTH_TOKEN_FIELD, (_m, name: string, sep: string, value: string) => `${name}${sep}${maskValue(value)}`)
    .replace(PREFIX_TOKEN, "***")
    .replace(URL_CREDS, "//***@")
    .replace(HEX_RUN, "***")
    .replace(BASE64_RUN, "***");
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
