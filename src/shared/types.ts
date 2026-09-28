export type MemberState = "working" | "idle" | "mail" | "offline";

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
}

export interface ContextInfo {
  used: number;
  window: number;
  pct: number;
  estimated: boolean;
}

export interface SessionView {
  id: string;
  name: string;
  cwd: string;
  alive: boolean;
  isCurrent: boolean;
  status: MemberState;
  stale?: boolean;
  context: ContextInfo | null;
  members: Member[];
}

export interface Limits {
  fiveHourPct?: number;
  weeklyPct?: number;
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
}
