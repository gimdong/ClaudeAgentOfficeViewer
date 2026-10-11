import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { arch, homedir, platform } from "node:os";
import { join } from "node:path";
import type { Snapshot } from "../../src/shared/types";
import type { DecisionStats } from "../decisions/queue";
import type { FloorStats } from "../floors/control";
import type { HookStatsView } from "../events/stats";
import { scrub } from "../log";
import type { DoctorItem } from "./doctor";

/** 권한 정책 통계(Phase 3). 대상 이름은 넣지 않는다(스펙 9장) */
export interface PolicyStats { targets: number; rulesByKind: Record<"lead" | "agent" | "sub" | "others", number>; decisions: { deny: number; ask: number } }

export interface DiagBundle {
  kind: "claude-office-diag";
  format: 1;
  createdAt: string;
  versions: { app: string; node: string; platform: string; arch: string; claude: string | null };
  doctor: DoctorItem[];
  hooks: HookStatsView;
  snapshot: { sessions: number; members: number; teams: number; decisions: number; error: boolean };
  /** 결정 종류별·결과별 건수만(Phase 2). 도구 입력·거부 이유·답 내용은 없다 */
  decisions: DecisionStats;
  policy: PolicyStats;
  /** 층 관리(Phase 4a): 지금 일시정지·숨김·종료 중인 층의 수만. 세션 id는 넣지 않는다(스펙 9장) */
  floors: FloorStats;
  logs: Array<{ file: string; lines: string[] }>; // 최근 7일, 새 파일이 앞
  truncated: boolean;
}

export interface BundleInput {
  doctor: () => Promise<DoctorItem[]>;
  hooks: HookStatsView;
  snapshot: Snapshot;
  logDir: string;
  home?: string;
  now?: () => number;
  appVersion: string;
  claudeVersion?: string | null;
  maxBytes?: number;
  /** 서버의 DecisionQueue.stats(). 없으면(CLI가 서버 없이 만들 때 등) 0으로 채운다 */
  decisions?: DecisionStats;
  /** 서버의 정책 저장소 요약 + 판정 수. 없으면 0으로 채운다 */
  policy?: PolicyStats;
  /** 서버의 FloorControl.stats(). 없으면 0으로 채운다 */
  floors?: FloorStats;
}

const EMPTY_DECISIONS = (): DecisionStats => ({
  byKind: { permission: 0, question: 0, plan: 0, budget: 0, team: 0 },
  byState: { pending: 0, "answered-dashboard": 0, "closed-terminal": 0, expired: 0 },
});

const EMPTY_POLICY = (): PolicyStats => ({ targets: 0, rulesByKind: { lead: 0, agent: 0, sub: 0, others: 0 }, decisions: { deny: 0, ask: 0 } });

const DAY = 86_400_000;
const OFFICE_LOG = /^office-(\d{4})-(\d{2})-(\d{2})\.log$/; // 날짜는 UTC(로그 줄의 t와 같다)
const INSTALL_LOG = /^install-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.log$/; // Ruling B10, 로컬 시각

/** 로그 파일 이름에서 [시작 시각, 정렬용 시각]. 실행 로그는 그날 전체를 담으므로 정렬은 그날 끝으로 한다 */
function logTime(name: string): [number, number] | null {
  const o = OFFICE_LOG.exec(name);
  if (o) {
    const start = Date.UTC(+o[1], +o[2] - 1, +o[3]);
    return [start, start + DAY - 1];
  }
  const i = INSTALL_LOG.exec(name);
  if (i) {
    const t = new Date(+i[1], +i[2] - 1, +i[3], +i[4], +i[5], +i[6]).getTime();
    return [t, t];
  }
  return null;
}

/** 경로에서 그대로 둬도 되는 구조 이름. 그 밖의 폴더·파일 이름은 순번으로 바꾼다 */
const KNOWN = new Set([
  ".claude", ".claude-office", "claude-office", "projects", "teams", "sessions", "subagents", "inboxes", "logs", "diagnostics",
  "app", "web", "bin", "plugin", "Code", "Documents", "Desktop", "Downloads",
  "settings.json", "config.json", "limits.json", "managed-settings.json",
]);
/** 이 프로그램이 만드는 파일 이름(날짜만 담는다) */
const OWN_FILE = /^(office-\d{4}-\d{2}-\d{2}\.log|install-[\d-]+\.log|claude-office-diag-\d{8}-\d{6}\.json)$/;
// 조각은 공백을 포함하고 구분자(/ \\)·따옴표·줄바꿈에서 끝난다(폴더 이름에 공백이 있어도 뒤가 남지 않게. 과잉 가림은 허용).
// "<"도 끝으로 본다 — 이미 바꾼 <project-N>을 다시 바꾸지 않게
const PATH = /~((?:[\/\\]+[^"'`<\/\\\r\n]+)+)/g;
const ENCODED = /~-([A-Za-z0-9-]+)/g;
const encode = (s: string) => s.replace(/[^A-Za-z0-9]/g, "-");

/**
 * Ruling B7: 홈 아래 경로의 폴더·파일 이름과 인코딩된 프로젝트 폴더 이름(~-Code-x)을 `<project-N>`·`<team-N>`·`<item-N>`으로 바꾼다.
 * map을 공유하면 같은 이름은 같은 번호다. 프로젝트는 Claude Code의 폴더 인코딩(영숫자 아닌 문자 → "-") 기준으로 묶어서
 * `~/Code/x`와 `~-Code-x`가 같은 번호가 된다. scrub(홈 → "~") 뒤에 부른다.
 */
export function pseudonymize(s: string, map: Map<string, string>): string {
  const label = (kind: string, key: string) => {
    const k = `${kind}\u0000${key}`;
    let v = map.get(k);
    if (!v) {
      v = `<${kind}-${[...map.keys()].filter((x) => x.startsWith(`${kind}\u0000`)).length + 1}>`;
      map.set(k, v);
    }
    return v;
  };
  const project = (seg: string) => label("project", seg.startsWith("~-") ? seg.slice(2) : encode(seg));
  return s
    .replace(PATH, (_m, rest: string) => {
      const parts = rest.split(/([\/\\]+)/); // 구분자를 남겨 원래 모양을 지킨다
      const segs: string[] = [];
      let underClaude = false;
      let next: "project" | "team" | null = null;
      let projectDone = false;
      const out = parts.map((p) => {
        if (!p || /^[\/\\]+$/.test(p)) return p;
        segs.push(p);
        const expect = next;
        next = null;
        if ((KNOWN.has(p) || OWN_FILE.test(p)) && !expect) {
          // ~/.claude·~/.claude-office 아래는 프로젝트 폴더가 아니다
          if (p === ".claude" || p === ".claude-office") underClaude = true;
          if (underClaude && p === "projects") next = "project";
          if (underClaude && p === "teams") next = "team";
          return p;
        }
        if (expect === "project") return (projectDone = true), project(p);
        if (expect === "team") return label("team", p);
        if (!underClaude && !projectDone) return (projectDone = true), label("project", encode(segs.join("-")));
        return label("item", p);
      });
      return `~${out.join("")}`;
    })
    .replace(ENCODED, (_m, key: string) => label("project", key));
}

function mapStrings(v: unknown, f: (s: string) => string): unknown {
  if (typeof v === "string") return f(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, f));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [f(k), mapStrings(x, f)]));
  return v;
}

/** 전체 가림: redact + 홈 → "~" + 순번 치환. 여러 번 해도 결과가 같다 */
function clean<T>(v: T, home: string): T {
  const map = new Map<string, string>();
  return mapStrings(scrub(v, home), (s) => pseudonymize(s, map)) as T;
}

async function readLogs(dir: string, now: number): Promise<DiagBundle["logs"]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const cutoff = now - 7 * DAY;
  // 실행 로그와 설치 로그를 섞어 새것부터. 크기 상한은 끝(가장 오래된 것)부터 버린다
  const recent = names
    .map((n) => [n, logTime(n)] as const)
    .filter((x): x is readonly [string, [number, number]] => !!x[1] && x[1][0] >= cutoff)
    .sort((a, b) => b[1][1] - a[1][1])
    .map(([n]) => n);
  const out: DiagBundle["logs"] = [];
  for (const file of recent) {
    try {
      out.push({ file, lines: (await readFile(join(dir, file), "utf8")).split("\n").filter(Boolean) });
    } catch {
      /* 읽는 사이 지워진 파일은 건너뛴다 */
    }
  }
  return out;
}

const sizeOf = (b: DiagBundle) => Buffer.byteLength(JSON.stringify(b, null, 2));

export async function buildBundle(d: BundleInput): Promise<DiagBundle> {
  const now = (d.now ?? Date.now)();
  const home = d.home ?? homedir();
  const s = d.snapshot;
  const raw: DiagBundle = {
    kind: "claude-office-diag",
    format: 1,
    createdAt: new Date(now).toISOString(),
    versions: { app: d.appVersion, node: process.version, platform: platform(), arch: arch(), claude: d.claudeVersion ?? null },
    doctor: await d.doctor(),
    hooks: d.hooks,
    // 이름·경로는 빼고 개수만
    snapshot: {
      sessions: s.sessions.length,
      members: s.sessions.reduce((n, x) => n + x.members.length, 0),
      teams: s.sessions.filter((x) => x.members.length > 1).length,
      decisions: s.decisionCount ?? 0,
      error: !!s.error,
    },
    decisions: d.decisions ?? EMPTY_DECISIONS(),
    policy: d.policy ?? EMPTY_POLICY(),
    floors: d.floors ?? { paused: 0, hidden: 0, terminating: 0 },
    logs: await readLogs(d.logDir, now),
    truncated: false,
  };
  const b = clean(raw, home);

  // 크기 상한: 오래된 파일부터 통째로, 마지막 한 파일은 오래된 줄부터 버린다
  const max = d.maxBytes ?? 5 * 1024 * 1024;
  let total = sizeOf(b);
  while (total > max && b.logs.length) {
    const last = b.logs[b.logs.length - 1];
    if (b.logs.length > 1 || !last.lines.length) b.logs.pop();
    else {
      let drop = 0;
      for (let freed = 0; drop < last.lines.length && freed < total - max; drop++) freed += Buffer.byteLength(JSON.stringify(last.lines[drop])) + 6;
      last.lines.splice(0, drop);
    }
    b.truncated = true;
    total = sizeOf(b);
  }
  return b;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** dir 안에 새 파일로만 쓴다(같은 이름이 있으면 EEXIST). 쓰기 직전에 한 번 더 가린다. 반환값은 파일 이름뿐이다 */
export async function writeBundle(dir: string, b: DiagBundle, home = homedir()): Promise<string> {
  const t = new Date(b.createdAt);
  const name = `claude-office-diag-${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}.json`;
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), JSON.stringify(clean(b, home), null, 2), { flag: "wx" });
  return name;
}

/** `claude --version`의 버전 숫자. 못 구하면 null */
export function readClaudeVersion(claudePath: string | null): Promise<string | null> {
  if (!claudePath) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(claudePath, ["--version"], { timeout: 5000, shell: process.platform === "win32" }, (err, stdout) => {
      resolve(err ? null : (/\d+\.\d+\.\d+\S*/.exec(String(stdout))?.[0] ?? null));
    });
  });
}
