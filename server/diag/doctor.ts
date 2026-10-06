import { existsSync, statSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import type { HookStatsView } from "../events/stats";
import type { OfficePaths } from "../paths";
import { PolicyStore } from "../policy/store";
import type { DoctorItem, DoctorStatus } from "../../src/shared/types";

export type Status = DoctorStatus;
export type { DoctorItem }; // 화면과 같이 쓰도록 src/shared/types.ts로 옮겼다
/** timeout: 연결은 됐는데 답이 없다(멈춘 우리 서버일 수도 있어 "다른 프로그램"과 구분한다) */
/** v1: /api/snapshot은 응답하지만 /api/diagnostics가 없는 이전 버전(v1) 뷰어(FB-2) */
export type PortState = "ours" | "v1" | "other" | "free" | "timeout";
export interface DoctorDeps {
  claudeHome: string;
  paths: OfficePaths;
  port: number;
  nodeVersion?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  managedPath?: string; // 기본: 플랫폼별 경로
  which?: (cmd: string) => string | null; // 기본: PATH 탐색
  probePort?: (port: number) => Promise<PortState>; // 기본: GET /api/snapshot, 그다음 /api/diagnostics
  hooks?: () => Promise<HookStatsView | null>; // 서버 안: stats.view(), CLI: /api/diagnostics 조회
  now?: () => number;
}

export const MANAGED_PATHS = {
  darwin: "/Library/Application Support/ClaudeCode/managed-settings.json",
  linux: "/etc/claude-code/managed-settings.json",
  win32: "C:\\Program Files\\ClaudeCode\\managed-settings.json",
};

/** 플러그인 hooks.json에 고정된 주소 */
const HOOK_PORT = 4317;
const HOOK_URL = `http://127.0.0.1:${HOOK_PORT}/hooks/event`;
const PLUGIN_ID = "claude-office@claude-office";
const INSTALL_FIX = "설치 스크립트를 다시 실행해 플러그인 설치에 y로 답하거나, 터미널에서 claude plugin install claude-office@claude-office 를 실행해 주세요.";
// 이미 설치된 플러그인은 install로는 등록이 바뀌지 않는다(FB-4) — update가 등록 버전을 새로 적는다
const UPDATE_FIX = "터미널에서 claude plugin update claude-office@claude-office 를 실행한 뒤 Claude Code를 다시 열어 주세요.";

// 관리자 정책은 파일 말고 다른 방식(MDM 등)으로도 배포될 수 있어, 파일이 없다고 문제 없다고 단정하지 않는다
const MANAGED_MISSING = "파일 없음(회사가 다른 방식으로 정책을 배포했을 수 있음)";
const APPENDIX_A = " 그래도 안 되면 회사 관리자에게 사용설명서 부록 A를 전달해 주세요.";
/** 정책이 있는데 hook이 대시보드에 닿지 않을 때(스펙 9장). 항목을 늘리지 않고 hooks 안내 앞에 둔다(상태 → 할 일, Ruling B98) */
const POLICY_OFF = "권한 정책이 적용되지 않고 있습니다. ";

/** 플러그인 hooks.json의 PermissionRequest timeout(초). 대시보드에서 답할 시간(스펙 3.1) */
const PERMISSION_TIMEOUT_S = 600;

/** 플러그인 파일(비밀 아님)을 JSON으로 읽는다. 읽을 수 없으면 null */
async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

const item = (id: string, status: Status, title: string, detail: string, fix = ""): DoctorItem => ({ id, status, title, detail, fix });

/**
 * JSON 설정 파일에서 필요한 키만 꺼낸다. 없으면 null, 읽을 수 없으면 "unreadable".
 * 다른 키의 값(토큰·환경변수 등)은 이 함수 밖으로 나가지 않는다.
 */
async function pickKeys<K extends string>(path: string, keys: readonly K[]): Promise<Partial<Record<K, unknown>> | null | "unreadable"> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? null : "unreadable";
  }
  if (!parsed || typeof parsed !== "object") return "unreadable";
  const out: Partial<Record<K, unknown>> = {};
  for (const k of keys) out[k] = (parsed as Record<string, unknown>)[k];
  return out;
}

const pluginEnabled = (v: unknown) => !!v && typeof v === "object" && (v as Record<string, unknown>)[PLUGIN_ID] === true;

/** allowedHttpHookUrls 패턴("*" 와일드카드)이 hook 주소를 허용하는지 */
const urlAllowed = (pattern: string) =>
  new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(HOOK_URL);

async function countEntries(dir: string, filter: (name: string) => boolean): Promise<number> {
  try {
    return (await readdir(dir)).filter(filter).length;
  } catch {
    return 0;
  }
}

export function defaultWhich(env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  return (cmd: string): string | null => {
    const names = platform === "win32" ? [`${cmd}.cmd`, `${cmd}.exe`, cmd] : [cmd];
    for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)) {
      for (const n of names) if (existsSync(join(dir, n))) return join(dir, n);
    }
    return null;
  };
}

/** 포트에 무엇이 있는지 모르는 채 토큰을 보내지 않는다 — 헤더 없이 묻는다(Ruling B52) */
export async function defaultProbePort(port: number): Promise<PortState> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/snapshot`, { signal: AbortSignal.timeout(1500) });
    const body = (await r.json().catch(() => null)) as { generatedAt?: unknown; app?: unknown } | null;
    // Phase 2 서버는 토큰 없이 물으면 401과 app 표시를 돌려준다
    if (r.status === 401 && body?.app === "claude-office") return "ours";
    if (!body || typeof body.generatedAt !== "string") return "other";
    // v1도 같은 /api/snapshot을 갖는다. 진단 API가 있어야 이 프로그램(베타 이후)이다.
    // v1은 이 경로에 404나 화면 HTML(SPA)을 돌려준다
    const diag = await fetch(`http://127.0.0.1:${port}/api/diagnostics`, { signal: AbortSignal.timeout(3000) });
    // 5xx는 진단 API가 있는데 내부 오류가 난 것 — 이전 버전이 아니다(hooks 쪽에서 못 읽은 이유가 따로 드러난다)
    if (diag.status >= 500) return "ours";
    const summary = (await diag.json().catch(() => null)) as { doctor?: unknown } | null;
    return diag.ok && summary && Array.isArray(summary.doctor) ? "ours" : "v1";
  } catch (e) {
    if ((e as { name?: string }).name === "TimeoutError") return "timeout";
    return (e as { cause?: { code?: string } }).cause?.code === "ECONNREFUSED" ? "free" : "other";
  }
}

type Check = (d: Required<DoctorDeps>) => Promise<DoctorItem>;

/** 점검이 던질 때 쓸 id·제목(checks와 같은 순서) */
const META: Array<[string, string]> = [
  ["node", "Node.js"], ["app", "프로그램 파일"], ["port", "포트"], ["claude_home", "Claude 데이터 폴더"], ["claude_cli", "Claude Code"],
  ["plugin", "플러그인"], ["token", "대시보드 열쇠"], ["hook_timeout", "결정 대기 시간"], ["managed", "회사 관리자 설정"], ["proxy", "프록시"], ["hooks", "실시간 이벤트"], ["statusline", "요금제 한도(선택)"],
];

const checks: Check[] = [
  async (d) => {
    const major = Number(/^v(\d+)/.exec(d.nodeVersion)?.[1] ?? 0);
    return major >= 24
      ? item("node", "ok", "Node.js", `버전 ${major}`)
      : item("node", "fail", "Node.js", `버전 ${major} (24 이상 필요)`, "https://nodejs.org 에서 LTS(24 이상)를 설치한 뒤 다시 실행해 주세요.");
  },
  async (d) => {
    const web = existsSync(join(d.paths.staticDir, "index.html"));
    // 설치본은 server.mjs 옆에 web/이 있다. 저장소(dev)에서는 server.mjs가 없으므로 보지 않는다
    const server = d.paths.mode !== "installed" || existsSync(join(dirname(d.paths.staticDir), "server.mjs"));
    return web && server
      ? item("app", "ok", "프로그램 파일", "있음")
      : item("app", "fail", "프로그램 파일", `화면 파일 ${web ? "있음" : "없음"}, 서버 파일 ${server ? "있음" : "없음"}`, "설치 스크립트로 다시 설치해 주세요.");
  },
  async (d) => {
    const state = await d.probePort(d.port);
    if (state === "other") return item("port", "fail", "포트", `다른 프로그램이 ${d.port}을 쓰고 있습니다`, `그 프로그램을 끄거나 다른 포트로 켜 주세요. 다른 포트에서는 말풍선·손들기가 보이지 않습니다(플러그인은 ${HOOK_PORT}로 보냄).`);
    if (state === "v1") return item("port", "warn", "포트", `이전 버전(v1) 서버가 ${d.port}을 쓰고 있습니다 — 끄고 다시 실행해 주세요`, "이전 버전 뷰어를 켠 터미널 창에서 Ctrl+C를 누르거나 그 창을 닫은 뒤, claude-office 명령으로 다시 켜 주세요.");
    if (state === "timeout") return item("port", "warn", "포트", `${d.port}에서 응답이 없습니다`, "대시보드 창을 닫고 claude-office 명령으로 다시 켜 주세요. 그래도 같으면 컴퓨터를 다시 시작해 주세요.");
    if (state === "free") return item("port", "warn", "포트", `서버가 꺼져 있습니다(${d.port})`, "claude-office 명령으로 대시보드를 켜 주세요.");
    if (d.port !== HOOK_PORT) return item("port", "warn", "포트", `서버가 ${d.port}에서 켜져 있지만 플러그인은 ${HOOK_PORT}로 보냅니다`, `포트 옵션 없이 켜면 ${HOOK_PORT}을 씁니다.`);
    return item("port", "ok", "포트", `${d.port} 사용 중(이 프로그램)`);
  },
  async (d) => {
    try {
      await readdir(d.claudeHome);
    } catch {
      return item("claude_home", "fail", "Claude 데이터 폴더", "없음 또는 읽을 수 없음", "Claude Code를 한 번 실행한 뒤 다시 확인해 주세요.");
    }
    const sessions = await countEntries(join(d.claudeHome, "sessions"), (n) => n.endsWith(".json"));
    const projects = await countEntries(join(d.claudeHome, "projects"), () => true);
    return item("claude_home", "ok", "Claude 데이터 폴더", `세션 ${sessions}개, 프로젝트 ${projects}개`);
  },
  async (d) =>
    d.which("claude")
      ? item("claude_cli", "ok", "Claude Code", "있음")
      : item("claude_cli", "warn", "Claude Code", "없음", "Claude Code를 설치해 주세요(https://claude.com/claude-code)."),
  async (d) => {
    const s = await pickKeys(join(d.claudeHome, "settings.json"), ["enabledPlugins"] as const);
    if (s === "unreadable") return item("plugin", "warn", "플러그인", "설정 파일을 읽을 수 없음", INSTALL_FIX);
    return pluginEnabled(s?.enabledPlugins)
      ? item("plugin", "ok", "플러그인", "켜져 있음")
      : item("plugin", "warn", "플러그인", "꺼져 있음 또는 설치 안 됨", INSTALL_FIX);
  },
  // 대시보드 열쇠(토큰) 파일: 있는지와 권한만 본다. 내용은 읽지 않는다(값이 결과·진단 파일로 새지 않게)
  async (d) => {
    const title = "대시보드 열쇠";
    let mode: number;
    try {
      mode = statSync(d.paths.tokenFile).mode;
    } catch {
      return item("token", "warn", title, "없음", "claude-office를 다시 켜면 만들어집니다");
    }
    // 다른 사용자가 읽을 수 있으면 경고한다. Windows는 권한 비트가 뜻이 없어 보지 않는다
    if (d.platform !== "win32" && (mode & 0o077) !== 0)
      return item("token", "warn", title, "있음(권한 확인 필요)", "claude-office를 다시 켜면 권한이 바로잡힙니다(본인만 읽을 수 있게).");
    return item("token", "ok", title, "있음");
  },
  // 플러그인의 PermissionRequest hook이 600초 기다리는지. Claude Code가 실제로 쓰는 등록 경로(installed_plugins.json의
  // installPath)를 먼저 보고, 등록이 없을 때만 캐시에서 가장 최근 버전 폴더를 본다(FB-4: 업그레이드 뒤 등록이 옛 버전에 남음)
  async (d) => {
    const title = "결정 대기 시간";
    let hooksDir: string | null = null;
    const reg = (await readJson(join(d.claudeHome, "plugins", "installed_plugins.json"))) as { plugins?: Record<string, Array<{ installPath?: unknown }>> } | null;
    const installPath = reg?.plugins?.[PLUGIN_ID]?.[0]?.installPath;
    if (typeof installPath === "string" && existsSync(join(installPath, "hooks", "hooks.json"))) hooksDir = installPath;
    if (!hooksDir) {
      const root = join(d.claudeHome, "plugins", "cache", "claude-office", "claude-office");
      let newestAt = -Infinity;
      try {
        for (const v of await readdir(root)) {
          const at = (await stat(join(root, v))).mtimeMs;
          if (existsSync(join(root, v, "hooks", "hooks.json")) && at > newestAt) {
            hooksDir = join(root, v);
            newestAt = at;
          }
        }
      } catch {
        /* 캐시 폴더 없음 */
      }
    }
    if (!hooksDir) return item("hook_timeout", "warn", title, "플러그인 캐시 없음", INSTALL_FIX);
    const parsed = (await readJson(join(hooksDir, "hooks", "hooks.json"))) as { hooks?: { PermissionRequest?: Array<{ hooks?: Array<{ timeout?: unknown }> }> } } | null;
    const t = parsed?.hooks?.PermissionRequest?.[0]?.hooks?.[0]?.timeout;
    if (t === PERMISSION_TIMEOUT_S) return item("hook_timeout", "ok", title, `${PERMISSION_TIMEOUT_S}초`);
    // 숫자일 때만 "초"를 붙인다(hooks.json이 깨졌거나 PermissionRequest 항목이 없으면 "알 수 없음")
    return item("hook_timeout", "warn", title, `${typeof t === "number" ? `${t}초` : "알 수 없음"} — 대시보드에서 답하려면 플러그인을 업데이트해 주세요`, UPDATE_FIX);
  },
  async (d) => {
    const m = await pickKeys(d.managedPath, ["allowManagedHooksOnly", "allowedHttpHookUrls", "enabledPlugins"] as const);
    const title = "회사 관리자 설정";
    if (m === null) return item("managed", "ok", title, MANAGED_MISSING);
    if (m === "unreadable") return item("managed", "warn", title, "있음(읽을 수 없음)", "사용설명서 부록 A를 회사 관리자에게 전달해 확인을 부탁해 주세요.");
    const problems: string[] = [];
    if (m.allowManagedHooksOnly === true && !pluginEnabled(m.enabledPlugins)) problems.push("관리자 hook만 허용");
    const urls = m.allowedHttpHookUrls;
    if (Array.isArray(urls) && !urls.some((u) => typeof u === "string" && urlAllowed(u))) problems.push("hook 주소 허용 목록에 없음");
    return problems.length
      ? item("managed", "fail", title, `있음: ${problems.join(", ")}`, "사용설명서 부록 A를 회사 관리자에게 전달해 설정을 부탁해 주세요.")
      : item("managed", "ok", title, "있음(문제 없음)");
  },
  async (d) => {
    const e = d.env;
    const proxy = e.HTTP_PROXY || e.HTTPS_PROXY || e.http_proxy || e.https_proxy;
    if (!proxy) return item("proxy", "ok", "프록시", "없음");
    const noProxy = `${e.NO_PROXY ?? ""},${e.no_proxy ?? ""}`.split(",").map((s) => s.trim());
    return noProxy.some((s) => s === "127.0.0.1" || s === "localhost" || s === "*")
      ? item("proxy", "ok", "프록시", "있음(로컬 주소 예외 있음)")
      : item("proxy", "warn", "프록시", "있음(로컬 주소 예외 없음)", "환경변수 NO_PROXY에 127.0.0.1,localhost 를 넣어 주세요(회사 IT 담당자에게 문의).");
  },
  async (d) => {
    const v = await d.hooks().catch(() => null);
    // 포트에 이전 버전 서버가 있으면 진단 API가 없어 통계를 못 읽는다 — "꺼져 있다"고 하면 port 항목과 모순된다
    if (!v && (await d.probePort(d.port)) === "v1")
      return item("hooks", "warn", "실시간 이벤트", "확인하지 못했습니다(이전 버전 서버)", "이전 버전 서버를 끄고 claude-office로 다시 켠 뒤 확인해 주세요.");
    if (!v) return item("hooks", "warn", "실시간 이벤트", "서버가 꺼져 있어 확인하지 못했습니다", "대시보드를 켠 뒤 다시 확인해 주세요.");
    const rejected = Object.values(v.rejected).reduce((a, b) => a + b, 0);
    if (rejected > 0) return item("hooks", "warn", "실시간 이벤트", `거부된 요청 ${rejected}건`, "진단 파일을 만들어 담당자에게 보내 주세요.");
    if (v.total === 0) return item("hooks", "warn", "실시간 이벤트", "받은 이벤트 0건", "Claude Code 세션에서 아무 작업이나 해 보세요. 그래도 0건이면 플러그인과 회사 관리자 설정 항목을 확인해 주세요.");
    return item("hooks", "ok", "실시간 이벤트", `최근 10분 ${v.last10min}건`);
  },
  async (d) => {
    const title = "요금제 한도(선택)";
    let mtime: number;
    try {
      mtime = (await stat(join(d.claudeHome, "claude-office", "limits.json"))).mtimeMs;
    } catch {
      // Ruling B12: PLAN 바는 베타에서 지원하지 않는다. 없는 것이 보통이라 경고하지 않는다(정보)
      return item("statusline", "ok", title, "없음", "PLAN 바(요금제 한도)는 베타에서 지원하지 않습니다. 회사 좌석에서는 대부분 표시되지 않습니다");
    }
    return d.now() - mtime <= 3_600_000
      ? item("statusline", "ok", title, "최근 1시간 안에 갱신됨")
      : item("statusline", "warn", title, "1시간 넘게 갱신되지 않음", "Claude Code 세션을 열면 다시 갱신됩니다.");
  },
];

export async function runDoctor(deps: DoctorDeps): Promise<DoctorItem[]> {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const d: Required<DoctorDeps> = {
    nodeVersion: process.version,
    managedPath: MANAGED_PATHS[platform as keyof typeof MANAGED_PATHS] ?? MANAGED_PATHS.linux,
    which: defaultWhich(env, platform),
    probePort: defaultProbePort,
    hooks: async () => null,
    now: Date.now,
    ...deps,
    platform,
    env,
  };
  // port와 hooks가 같은 결과를 보도록 포트 조회는 한 번만 한다
  const probe = d.probePort;
  const probed = new Map<number, Promise<PortState>>();
  d.probePort = (port) => {
    if (!probed.has(port)) probed.set(port, probe(port));
    return probed.get(port)!;
  };
  // 한 점검이 던져도 나머지 결과는 낸다
  const items = await Promise.all(
    checks.map((c, i) =>
      c(d).catch(() => item(META[i][0], "warn", META[i][1], "확인 중 오류", "진단 파일을 만들어 담당자에게 보내 주세요.")),
    ),
  );
  // 관리자 설정 파일이 안 보이는데 hook이 0건이면, 파일 밖의 정책이 막고 있을 수 있다
  const managed = items.find((i) => i.id === "managed");
  const hooks = items.find((i) => i.id === "hooks");
  if (managed?.detail === MANAGED_MISSING && hooks && hooks.detail === "받은 이벤트 0건") hooks.fix += APPENDIX_A;
  // 정책 파일은 읽기만 한다(대상 수만 쓰고 이름은 결과에 넣지 않는다). 깨졌으면 load가 빈 정책으로 둔다.
  // plugin 항목은 보지 않는다 — ~/.claude/settings.json만 봐서, 다른 곳에서 켠 플러그인으로 이벤트가 들어와도 warn이다.
  // 정말 꺼졌으면 이벤트가 0건이라 위 조건이 잡는다(Ruling B98)
  const notReaching = hooks?.detail === "받은 이벤트 0건" || hooks?.detail === "서버가 꺼져 있어 확인하지 못했습니다";
  if (hooks && notReaching && policyTargets(d.paths.policyFile) > 0) hooks.fix = POLICY_OFF + hooks.fix;
  return items;
}

function policyTargets(file: string): number {
  try {
    const s = new PolicyStore(file);
    s.load();
    return s.summary().targets;
  } catch {
    return 0;
  }
}

const MARK: Record<Status, string> = { ok: "✅", warn: "⚠️", fail: "❌" };

export function formatDoctor(items: DoctorItem[]): string {
  return items.flatMap((i) => [`${MARK[i.status]} ${i.title}: ${i.detail}`, ...(i.status !== "ok" && i.fix ? [`  → ${i.fix}`] : [])]).join("\n");
}
