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
}

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
  error?: string;
  usage: UsageSummary;
  budget: { fiveHour?: number; weekly?: number };
  limits: Limits | null;
  sessions: SessionView[];
  /** HUD "결정 대기 N" 칩 */
  decisionCount: number;
}

// ───────── 진단(베타): 서버와 화면이 같이 쓴다 ─────────
export type DoctorStatus = "ok" | "warn" | "fail";
/** doctor 항목. detail에는 값이 아니라 있음/없음과 숫자만 넣는다 */
export interface DoctorItem { id: string; status: DoctorStatus; title: string; detail: string; fix: string }
export interface HookStatsView { total: number; byEvent: Record<string, number>; lastAt: string | null; rejected: Record<"403" | "415" | "413" | "400", number>; last10min: number }
/** GET /api/diagnostics. 경로는 "~"로 치환되어 온다 */
export interface DiagnosticsSummary { doctor: DoctorItem[]; hooks: HookStatsView; errorsLastHour: number; logDir: string; diagDir: string }
