import type { Member, PolicyGroup, PolicyRules } from "../../src/shared/types";
import { graphemes } from "../report/text";

/** 묶음 순서와 화면 이름(스펙 5.2). 서버 server/policy/tools.ts의 GROUP_KEYS·GROUPS와 테스트로 맞춘다 */
export const GROUP_ORDER: PolicyGroup[] = ["bash", "edit", "web", "agent", "mcp", "other", "all"];
export const GROUP_LABEL: Record<PolicyGroup, string> = {
  bash: "명령 실행",
  edit: "파일 고치기",
  web: "웹 접근",
  agent: "팀원·서브에이전트 만들기",
  mcp: "외부 도구(MCP)",
  other: "그 밖의 도구",
  all: "모든 도구",
};
export const VALUE_LABEL = { default: "기본", ask: "항상 질문", deny: "금지" } as const;

/** 바로 쓰는 묶음(스펙 5.3). 누르면 표 전체가 이 조합이 된다(Ruling B80). 화면에만 있다 */
export const TEMPLATES: Array<{ id: "readonly" | "askBash" | "none"; label: string; rules: PolicyRules }> = [
  { id: "readonly", label: "읽기 전용", rules: { bash: "deny", edit: "deny" } },
  { id: "askBash", label: "명령은 물어보고", rules: { bash: "ask" } },
  { id: "none", label: "제한 없음", rules: {} },
];

/** 디자인 phase3 §8 문구표(qa 검토를 마친 판) */
export const TEXT = {
  scopeNamed: "이 이름의 정책은 다른 세션의 같은 이름에도 적용됩니다",
  scopeLead: "리드의 정책은 모든 세션의 리드에 적용됩니다",
  scopeOthers: "따로 정하지 않은 모든 팀원·서브에이전트에 적용됩니다. 리드에는 적용되지 않습니다",
  notOnScreen: "지금 화면에 이 이름이 없습니다. 정해 두면 이 이름이 나타날 때부터 적용됩니다.",
  countsZero: "켠 뒤로 막거나 물은 적 없음",
  countsNote: "대시보드를 다시 켜면 0부터 셉니다",
  followsOthers: '정한 것이 없어 "그 밖의 모든"을 따릅니다',
  othersLink: '"그 밖의 모든" 정책 보기',
  othersWarn: '여기서 하나라도 정해 저장하면 이 이름은 "그 밖의 모든"을 따르지 않습니다. 기본으로 둔 도구는 원래 규칙대로 합니다.',
  secTemplates: "바로 쓰는 묶음",
  secRules: "도구별 권한",
  secSubs: "서브에이전트",
  templateHelp: "누르면 아래 칸이 모두 그 조합으로 바뀝니다. [저장]을 눌러야 적용됩니다.",
  allHelp: '"모든 도구"는 위에서 기본으로 둔 도구에 적용됩니다.',
  exemptHelp: "사용자에게 묻기(질문·계획 승인), 팀원끼리 연락하기(메시지·할 일 목록), 서브에이전트가 결과 돌려주기는 어떤 정책으로도 막지 않습니다.",
  subsHelp: "리드가 띄운 서브에이전트는 리드 책상에 함께 보입니다. 종류마다 따로 정할 수 있습니다.",
  subsNone: "지금 보이는 서브에이전트가 없습니다. 정책 목록의 [대상 추가]로 미리 정할 수 있습니다.",
  save: "저장",
  saving: "저장하는 중…",
  unsaved: "저장하지 않은 변경이 있습니다",
  saved: "저장했습니다",
  deleted: "정책을 지웠습니다",
  invalid: "값이 올바르지 않아 저장하지 못했습니다. 화면을 새로 고친 뒤 다시 해 주세요.",
  failed: "저장하지 못했습니다. 서버 연결을 확인하고 다시 시도해 주세요.",
  limit: "대상은 200개까지 만들 수 있습니다. 쓰지 않는 대상을 지운 뒤 추가해 주세요.",
  notPersisted: "지금은 적용됐지만 파일에 저장하지 못했습니다. 대시보드를 다시 켜면 이 변경은 사라집니다. 다시 저장해 보고, 계속되면 진단 파일을 만들어 담당자에게 보내 주세요.",
  discarded: "저장하지 않은 변경을 버렸습니다",
  noRules: "정한 것 없음",
} as const;

const RESERVED = new Set(["__proto__", "constructor", "prototype"]);
const MAX_NAME = 100;

/** 서버 isTargetKey의 이름 규칙과 같다: 비지 않음, 앞뒤 공백 없음, 100자(그래핌) 이하, 제어 문자·예약어 없음 */
export function isValidTargetName(name: string): boolean {
  return name !== "" && name === name.trim() && !/\p{Cc}/u.test(name) && !RESERVED.has(name) && graphemes(name).length <= MAX_NAME;
}

/** 화면 구성원의 대상 키. 서버 memberKeyOf와 같은 규칙(B95) */
export function targetKeyOf(m: Pick<Member, "name" | "role">): string {
  if (m.role === "lead") return "lead";
  return isValidTargetName(m.name) ? `agent:${m.name}` : "others";
}

/** 대상 화면 이름(B76, 디자인 §8.1) */
export function targetLabel(key: string): string {
  if (key === "lead") return "리드";
  if (key === "others") return "그 밖의 모든 팀원·서브에이전트";
  if (key.startsWith("sub:")) return `서브에이전트(${key.slice(4)})`;
  return key.startsWith("agent:") ? key.slice(6) : key;
}

export function kindLabel(key: string): string {
  if (key === "lead") return "리드";
  if (key === "others") return "그 밖의 모든";
  return key.startsWith("sub:") ? "서브에이전트" : "팀원";
}

/** "명령 실행 금지 · 파일 고치기 금지". 규칙 하나는 서버 ruleLabel과 같은 글자다(B92) */
export function summaryOf(rules: PolicyRules): string {
  const parts = GROUP_ORDER.flatMap((g) => (rules[g] ? [`${GROUP_LABEL[g]} ${VALUE_LABEL[rules[g]]}`] : []));
  return parts.length ? parts.join(" · ") : TEXT.noRules;
}

export const countsLine = (denied: number, asked: number): string =>
  `켠 뒤로 금지 ${denied.toLocaleString("en-US")}번 · 질문 ${asked.toLocaleString("en-US")}번`;
