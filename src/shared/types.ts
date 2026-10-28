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
/** chat: 팀리더·팀원이 ask_user로 물은 질문(Phase 6b 스펙 4장) — 답은 Member.awaitingReply로 */
export type DecisionKind = "permission" | "question" | "plan" | "budget" | "team" | "chat";

/**
 * 대화 질문(Phase 6b 스펙 4장·11장). source: ask_user 도구 / Stop 대체 경로. owner는 책상 주인 이름.
 * state: 서버는 open·held(휴업 중 보낸 답이 보관됨)만 낸다. answered-terminal·superseded는 화면이 열어 둔 창에서만 쓴다
 */
export interface ChatQuestionView {
  id: string;
  source: "ask" | "await";
  owner: string;
  ownerIsLead: boolean;
  text: string;
  options: string[];
  state: "open" | "held" | "answered-terminal" | "superseded";
  /** 질문이 온 시각(ISO) */
  since?: string;
}

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
  /** 팀원 권한 질문 알림(안 A) — 리드 터미널 대화상자에서만 답할 수 있다 */
  viaLead?: true;
}
export type DecisionAnswer =
  | { action: "allow" }
  | { action: "deny"; reason?: string }
  | { action: "answer"; answers: Array<{ labels: number[] } | { other: string }> }
  | { action: "continue" }
  | { action: "stop" };

/** 임시 책상 하나(서브에이전트 임시 책상 B). description은 사용자가 맡긴 일이라 화면에만 쓴다(로그·진단 금지, B172) */
export interface SubagentDesk {
  /** agent_id(= subagents/agent-<id>.jsonl의 id) */
  id: string;
  /** agentType(예: Explore). meta에 없으면 "" */
  type: string;
  description: string;
  model?: string;
  /** 그 대화 기록의 토큰 합(cacheRead 제외) */
  tokens: number;
  /** 시작했고 아직 끝나지 않았거나, 대화 기록이 30초 안에 바뀜(B171). false면 끝난 뒤 30초 동안만 보인다 */
  working: boolean;
}

/** 대시보드가 띄운 층의 상한(Phase 4b 스펙 4장). 서버(channels.ts)와 화면 문구가 같은 값을 쓴다 */
export const MAX_LAUNCHED = 8;

export interface TokenSum {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number; // input + output + cacheWrite (cacheRead 제외)
}

/** Claude Code가 hook 입력 effort.level로 싣는 노력 정도(Phase 7 Task 4, #646) */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface Member {
  name: string;
  role: string;
  model?: string;
  color?: string;
  state: MemberState;
  unread: number;
  tokens: TokenSum;
  /** 대화 기록의 모델별 합계(큰 순). 기록이 없으면 싣지 않는다 */
  byModel?: Array<{ model: string; total: number }>;
  lastActivityAt?: string;
  activity?: Activity;
  decision?: Decision;
  /** 이 책상의 대화 질문(Phase 6b) — 답을 기다립니다 / ask_user */
  awaitingReply?: ChatQuestionView;
  /** 퇴근(Phase 6b 스펙 6장): requested = 퇴근 요청을 보냄, off = 퇴근함(빈 의자 + 팻말). 팀원만 */
  duty?: "requested" | "off";
  /** 마지막 활동이 1시간 넘음(표시만, 휴업 층·손든 팀원 제외) */
  longIdle?: true;
  /** 퇴사 진행 중(스펙 7장) — 인수인계를 기다림 */
  retiring?: { since: string };
  /** 이 구성원에게 걸린 권한 정책(Phase 3 스펙 7.4). 규칙이 없으면 싣지 않는다 */
  policy?: MemberPolicy;
  /** 30초 안의 마지막 정책 deny(Ruling B85) */
  policyDenied?: PolicyDenied;
  /** 리드만: 최근 이벤트에 보인 서브에이전트 종류(정렬, 중복 없음) */
  subTypes?: string[];
  /** 노력 정도: 그 멤버의 마지막 /hooks/v2 이벤트 중 effort.level이 있는 것(Phase 7 Task 4). 화면은 오라 단계로 쓴다 */
  effort?: EffortLevel;
}

export interface ContextInfo {
  used: number;
  window: number;
  pct: number;
  estimated: boolean;
}

/** "paused": 대시보드에서 일시정지한 살아 있는 층(Phase 4a 스펙 4.4) */
export type FloorStatus = "working" | "idle" | "paused" | "ended";

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
  /** 퇴사한 팀원(스펙 7장 4번) — 이름·퇴사 시각만 */
  predecessors?: Array<{ name: string; retiredAt: string; startedAt?: string }>;
  /** 서류철(Phase 6b 스펙 5장): 대기 수(보관함 포함)·모두. 본문은 GET /api/floors/:id/reports. overdue: 보고 요청 뒤 10분 넘게 보고서가 없음 */
  folder?: { pending: number; total: number; overdue?: true };
  /** 이 층의 토큰 예산(Phase 2 스펙 5장). 없으면 "예산 없음" */
  budget?: BudgetView;
  /** 일하는 동안의 일반 서브에이전트(임시 책상). 살아 있는 층에서 하나 이상일 때만 */
  subagents?: SubagentDesk[];
  /**
   * 작업 지시 켜기(옮겨 열기) 버튼 상태(B205 ④, #468). 실험 기능이 켜져 있고 살아 있는 층에만.
   * ok = 누를 수 있음, busy = 옮겨 여는 중, launched = 대시보드가 띄운 층(이미 지시 가능), merged = 합친 층(bg job이 같은 대화를 씀),
   * paused = 멈춘 층(B202), ancestor = 대시보드 서버의 조상(끄면 서버도 끝남·확인 불가 포함)
   */
  reopen?: "ok" | "busy" | "launched" | "merged" | "paused" | "ancestor";
  /** 대시보드가 channel을 붙여 띄운 층만(Phase 4b) */
  /** reconnecting: 대시보드를 다시 켠 뒤 복원한 층이 아직 다시 붙지 않음(2분 안, #658) */
  /** unreceived: 보낸 지시를 세션이 받은 흔적(리드 hook)이 없음(B343, 확실하지 않음) */
  /** parked: 대화가 bg job으로 옮겨 가 이 층의 channel로는 지시가 닿지 않음(서버가 보내지 않는다) */
  /** refused: 연결 전, 이 층 열쇠로 온 연결을 거절한 이유(beta.23) — 옛 channel 서버(no-conv)·다른 대화(conv-mismatch) */
  channel?: { connected: boolean; tmux: string; held: number; last?: "sent" | "delivered"; reconnecting?: boolean; unreceived?: boolean; parked?: boolean; refused?: "no-conv" | "conv-mismatch" };
  /** 켠 뒤로 일시정지가 막은 호출 수(Phase 4a 스펙 4.4). 일시정지 층에만 */
  pausedDenied?: number;
  /** 종료 신호를 보냈고 아직 살아 있다(스펙 5.2) */
  terminating?: true;
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
  /** 빌딩 설정(Phase 6b 스펙 12장 f) — 지붕 간판 `{userName}의 회사` */
  /** variant: 낮·밤 설정(Phase 7 Task 3) — system이면 화면이 prefers-color-scheme을 따른다 */
  building?: { userName: string; variant: "day" | "night" | "system" };
  /** statusline 연결(스펙 12장 j): PLAN 바가 빈 이유를 고른다. on이면 "요금제가 알려 주지 않음", off면 "연결이 꺼져 있음"(다른 statusline이 덮은 것 포함) */
  statusline?: "on" | "off" | "unsupported";
  generatedAt: string;
  /** 이 스냅샷을 만든 서버의 버전(FB-7). beta.4 이전 서버는 싣지 않으므로 화면은 "없음"도 불일치로 본다 */
  serverVersion?: string;
  /** 마지막 hook이 보낸 플러그인 버전과 서버 버전이 같은지(Phase 5 §3). hook을 한 번도 받지 않았으면 없음 */
  /** legacy: 옛 http 입구(/hooks/event)로 온 세션이 남아 있다(Phase 6a §4, beta.14 동안만) */
  plugin?: { version: string; match: boolean; legacy?: true };
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
  /** 대시보드에서 숨긴 끝난 층의 수(Phase 4a 스펙 6) */
  hiddenFloors: number;
  /** 실험 기능(Phase 4b 3장). available=false면 켤 수 없다(reason: "tmux"|"claude"|"windows") */
  experimental?: { channels: boolean; available: boolean; reason?: string };
}

// ───────── 진단(베타): 서버와 화면이 같이 쓴다 ─────────
export type DoctorStatus = "ok" | "warn" | "fail";
/** doctor 항목. detail에는 값이 아니라 있음/없음과 숫자만 넣는다 */
export interface DoctorItem { id: string; status: DoctorStatus; title: string; detail: string; fix: string }
export interface HookStatsView { total: number; byEvent: Record<string, number>; /** Notification의 notification_type별 수(beta.20). 옛 서버는 없다 */ byNotification?: Record<string, number>; lastAt: string | null; rejected: Record<"403" | "415" | "413" | "400" | "403-uid" | "401-v2", number>; /** /hooks/v2로 받은 수(Phase 6a) */ v2: number; last10min: number }
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

/** 팀리더 지시 통로 상태(Phase 6b 화면, designer SPEC §1.2) */
export type LeadChannel = "ok" | "not-launched" | "not-connected" | "reconnecting" | "parked";
/** 보고서 도장(started: 인수인계로 새 팀원을 시작함) */
/** held: 휴업 중 보관한 결재(실제로 나가면 approved·revise, 보관함에서 지우면 pending — 스펙 12장 l) */
export type ReportState = "pending" | "held" | "approved" | "revise" | "started";
/** 서류철 한 장(GET /api/floors/:id/reports). 시각은 ISO */
export interface ReportView {
  id: string;
  kind: "report" | "handover";
  title?: string;
  /** 인수인계 대상 팀원 */
  member?: string;
  /** 제출한 에이전트 이름 */
  from: string;
  body: string;
  at: string;
  state: ReportState;
  /** 승인·수정 요청·새 팀원 시작 시각 */
  decidedAt?: string;
  /** state "held"일 때 무엇을 보관했는지(스펙 12장 l) */
  held?: "approve" | "revise";
}
/** 최신 먼저. archived는 넘쳐서 보관함으로 옮긴 대기 보고서(스펙 11장 g) */
export interface FolderView {
  reports: ReportView[];
  archived: ReportView[];
}
