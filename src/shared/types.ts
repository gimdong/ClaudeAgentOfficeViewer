export type MemberState = "decision" | "working" | "idle" | "mail" | "offline";

/** tool: 진행 중인 도구, todo: 할 일 목록의 진행 중 항목, said: 대화 기록의 마지막 문장 */
export type ActivityKind = "tool" | "todo" | "said";

export interface Activity {
  kind: ActivityKind;
  tool?: string;
  /** 말풍선의 「」 안에 들어갈 원문(최대 200자). 자르기는 UI가 한다 */
  target?: string;
  startedAt: string;
  /** 리드에 합쳐진 일반 서브에이전트가 한 일 */
  sub?: boolean;
  /** 그 서브에이전트의 agent_type(예: "Explore"). 말풍선 보조 줄 "서브에이전트(Explore) · …"에 쓴다 */
  subType?: string;
}

/** budget, team은 Phase 2에서 서버가 보낸다(Ruling P4). Phase 1 서버는 앞의 세 가지만 보낸다 */
export type DecisionKind = "permission" | "question" | "plan" | "budget" | "team";

export interface Decision {
  kind: DecisionKind;
  since: string;
  summary?: string;
  /** 큐의 결정 id(Phase 2). 보고서를 열 때 쓴다 */
  id?: string;
  /** 서버가 놓아주는 시각(createdAt + 590초, Ruling B29) */
  deadline?: string;
}

// ───────── 결정 큐(Phase 2): 서버와 화면이 같이 쓴다 ─────────
export type DecisionState = "pending" | "answered-dashboard" | "closed-terminal" | "expired";
/** 화면에 보내는 도구 입력 요약. 모두 가림(redact)과 200자 자르기를 거친 값이다 */
export interface DecisionDetail { command?: string; description?: string; filePath?: string; pattern?: string; query?: string; domain?: string; to?: string }
export interface QuestionView { question: string; header?: string; multiSelect: boolean; options: Array<{ label: string; description?: string }> }
export interface DecisionView {
  id: string;
  sessionId: string;
  agent: string;
  kind: DecisionKind;
  toolName: string;
  state: DecisionState;
  createdAt: string;
  /** createdAt + 590초 (Ruling B29) */
  deadline: string;
  resolvedAt?: string;
  /** 대시보드에서 답했을 때의 결과: allow | deny | answer | continue | stop */
  outcome?: string;
  detail: DecisionDetail;
  questions?: QuestionView[];
  plan?: string;
  /** plan이 4000자에서 잘렸다(Ruling B47) */
  planTruncated?: boolean;
  budget?: { budgetTokens: number; usedTokens: number };
  /** 정책 ask로 뜬 권한 요청(Phase 3 Ruling B84). 종류는 permission 그대로 */
  byPolicy?: true;
  /** false면 보고서만(팀원 요청, 보고서만으로 판정된 계획) */
  answerable: boolean;
}
export type DecisionAnswer =
  | { action: "allow" }
  | { action: "deny"; reason?: string }
  | { action: "answer"; answers: Array<{ labels: number[] } | { other: string }> }
  | { action: "continue" }
  | { action: "stop" };

export interface TokenSum {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number; // input + output + cacheWrite (cacheRead 제외)
}

export interface Member {
  name: string;
  role: string;
  model?: string;
  color?: string;
  state: MemberState;
  unread: number;
  tokens: TokenSum;
  lastActivityAt?: string;
  activity?: Activity;
  decision?: Decision;
  /** 이 구성원에게 걸린 권한 정책(Phase 3 스펙 7.4). 규칙이 없으면 싣지 않는다 */
  policy?: MemberPolicy;
  /** 30초 안의 마지막 정책 deny(Ruling B85) */
  policyDenied?: PolicyDenied;
  /** 리드만: 최근 이벤트에 보인 서브에이전트 종류(정렬, 중복 없음) */
  subTypes?: string[];
}

export interface ContextInfo {
  used: number;
  window: number;
  pct: number;
  estimated: boolean;
}

/** "paused"는 Phase 4에서 추가한다 */
export type FloorStatus = "working" | "idle" | "ended";

export interface SessionView {
  id: string;
  name: string;
  cwd: string;
  alive: boolean;
  isCurrent: boolean;
  status: MemberState;
  stale?: boolean;
  /** 1F = 시작 시각이 가장 오래된 세션(디자인 A1, 사용자 확정) */
  floor: number;
  floorStatus: FloorStatus;
  startedAt?: string;
  /** 종료된 층의 "종료됨 HH:MM"에 쓴다 */
  endedAt?: string;
  context: ContextInfo | null;
  members: Member[];
  /** 이 층의 토큰 예산(Phase 2 스펙 5장). 없으면 "예산 없음" */
  budget?: BudgetView;
}

/** 층 예산. usedTokens는 세션 구성원 tokens.total의 합(cacheRead 제외) */
export interface BudgetView {
  budgetTokens: number;
  usedTokens: number;
  nextGateAt: number;
  /** usedTokens >= nextGateAt */
  reached: boolean;
}

export interface Limits {
  fiveHourPct?: number;
  weeklyPct?: number;
  /** gateway 지출 한도 사용률(0~100으로 자른 값) */
  spendPct?: number;
  /** 자르기 전 원래 값. 100을 넘을 수 있다 */
  spendRawPct?: number;
  resetsAt?: string;
  source: string;
}

export interface UsageSummary {
  today: TokenSum;
  last5h: TokenSum;
  last7d: TokenSum;
  byModel: Array<{ model: string } & TokenSum>;
  hourly: number[]; // 길이 24, 마지막 칸이 현재 시간대
}

export interface Snapshot {
  generatedAt: string;
  /** 이 스냅샷을 만든 서버의 버전(FB-7). beta.4 이전 서버는 싣지 않으므로 화면은 "없음"도 불일치로 본다 */
  serverVersion?: string;
  error?: string;
  usage: UsageSummary;
  budget: { fiveHour?: number; weekly?: number };
  limits: Limits | null;
  sessions: SessionView[];
  /** HUD "결정 대기 N" 칩 */
  decisionCount: number;
  /** 결정 큐: pending(오래된 것부터) + 최근 30초 안에 끝난 것 */
  decisions: DecisionView[];
  /** 새 층에 줄 예산 기본값. 없으면 기본값 없음 */
  defaultBudgetTokens?: number;
  /** 권한 정책 전체와 켠 뒤로의 횟수(Ruling B77). 대상도 횟수도 없으면 싣지 않는다 */
  policy?: PolicySnapshot;
}

// ───────── 진단(베타): 서버와 화면이 같이 쓴다 ─────────
export type DoctorStatus = "ok" | "warn" | "fail";
/** doctor 항목. detail에는 값이 아니라 있음/없음과 숫자만 넣는다 */
export interface DoctorItem { id: string; status: DoctorStatus; title: string; detail: string; fix: string }
export interface HookStatsView { total: number; byEvent: Record<string, number>; lastAt: string | null; rejected: Record<"403" | "415" | "413" | "400", number>; last10min: number }
/** GET /api/diagnostics. 경로는 "~"로 치환되어 온다 */
export interface DiagnosticsSummary { doctor: DoctorItem[]; hooks: HookStatsView; errorsLastHour: number; logDir: string; diagDir: string }

// ───────── 권한 정책(Phase 3): 서버와 화면이 같이 쓴다 ─────────
/** 조이기만 한다(스펙 D1). "allow"는 어떤 경로로도 받지 않는다 */
export type PolicyValue = "ask" | "deny";
export type PolicyGroup = "bash" | "edit" | "web" | "agent" | "mcp" | "other" | "all";
export type PolicyRules = Partial<Record<PolicyGroup, PolicyValue>>;
export interface MemberPolicy { source: "own" | "others"; rules: PolicyRules; denied: number; asked: number }
export interface PolicyDenied { group: PolicyGroup; at: string; subType?: string }
/** unreadable: 저장해 둔 정책 파일을 읽지 못했다(Ruling B101). 이때는 대상·횟수가 없어도 싣는다 */
export interface PolicySnapshot { targets: Record<string, PolicyRules>; counts: Record<string, { denied: number; asked: number }>; unreadable?: true }
