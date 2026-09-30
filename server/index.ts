import { existsSync, realpathSync } from "node:fs";
import { arch, homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { buildBundle, readClaudeVersion, writeBundle } from "./diag/bundle";
import { defaultProbePort, defaultWhich, formatDoctor, runDoctor, type DoctorItem } from "./diag/doctor";
import { HookStats, type HookStatsView } from "./events/stats";
import { EventStore } from "./events/store";
import { SnapshotHub } from "./hub";
import { Logger, errInfo, scrub, setLogger } from "./log";
import { resolvePaths, type OfficePaths } from "./paths";
import { SnapshotBuilder, emptySnapshot } from "./snapshot";
import type { Snapshot } from "../src/shared/types";
import pkg from "../package.json" with { type: "json" };

export interface CliOptions {
  port: number;
  claudeHome: string;
  configPath: string;
  logDir?: string;
}

/** 선행 "~/"나 단독 "~"를 homedir()로 치환한다(그 외 경로는 그대로 둔다). */
function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: { port: { type: "string" }, "claude-home": { type: "string" }, config: { type: "string" }, "log-dir": { type: "string" } },
  });
  const port = values.port === undefined ? 4317 : Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`잘못된 포트: ${values.port}`);
  // --claude-home > CLAUDE_HOME > CLAUDE_CONFIG_DIR > 기본값(~/.claude). Claude Code 자신은
  // CLAUDE_CONFIG_DIR로 설정 폴더 전체(sessions/projects/teams)를 옮기므로, 이 변수만 설정한
  // 사용자도 서버가 올바른 폴더를 읽어야 한다. ??가 아니라 ||를 써서 빈 문자열도 건너뛴다.
  const claudeHomeRaw = values["claude-home"] || env.CLAUDE_HOME || env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return {
    port,
    claudeHome: resolve(expandHome(claudeHomeRaw)),
    configPath: resolve(values.config ?? "claude-office.config.json"),
    logDir: values["log-dir"] ? resolve(expandHome(values["log-dir"])) : undefined,
  };
}

/** 플러그인 hooks.json의 주소에 고정된 포트 */
const HOOK_PORT = 4317;

/** Node가 24 미만이면 쉬운 말 안내를, 아니면 null을 돌려준다(스펙 5장 1번) */
export function checkNode(version: string): string | null {
  const major = Number(/^v(\d+)/.exec(version)?.[1] ?? 0);
  return major >= 24 ? null : `Claude Agent Office는 Node.js 24 이상이 필요합니다(지금 ${version}). https://nodejs.org 에서 LTS를 설치한 뒤 다시 실행해 주세요.`;
}

/** `doctor [--json]`: 서버를 켜지 않고 환경을 점검한다. 켜져 있는 서버의 hook 통계는 /api/diagnostics에서 읽는다 */
async function doctorCli(argv: string[]): Promise<void> {
  const json = argv.includes("--json");
  const opts = parseCliArgs(argv.filter((a) => a !== "--json"));
  const items = await runDoctor({
    claudeHome: opts.claudeHome,
    paths: resolvePaths({ moduleUrl: import.meta.url, env: process.env, logDir: opts.logDir }),
    port: opts.port,
    hooks: () =>
      fetch(`http://127.0.0.1:${opts.port}/api/diagnostics`, { signal: AbortSignal.timeout(1500) })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => (j as { hooks?: HookStatsView } | null)?.hooks ?? null)
        .catch(() => null),
  });
  console.log(json ? JSON.stringify(items, null, 2) : formatDoctor(items));
  process.exitCode = items.some((i) => i.status === "fail") ? 1 : 0;
}

/** 진단 파일을 만들어 paths.diagDir에 쓰고 파일 이름을 돌려준다(서버 버튼과 CLI가 같이 쓴다) */
async function makeBundleFile(paths: OfficePaths, snapshot: Snapshot, hooks: HookStatsView, doctor: () => Promise<DoctorItem[]>): Promise<string> {
  const claudeVersion = await readClaudeVersion(defaultWhich(process.env, process.platform)("claude"));
  return writeBundle(paths.diagDir, await buildBundle({ doctor, hooks, snapshot, logDir: paths.logDir, appVersion: pkg.version, claudeVersion }));
}

/**
 * `diag`: 진단 파일을 만들고 전체 경로를 출력한다(고객 자신의 화면이라 경로를 보여 준다. 파일 안에는 없다).
 * 이 포트의 서버가 우리 서버면 서버에게 만들게 하고(hook 통계 포함), 아니면 직접 만든다.
 */
async function diagCli(argv: string[]): Promise<void> {
  const opts = parseCliArgs(argv);
  const paths = resolvePaths({ moduleUrl: import.meta.url, env: process.env, logDir: opts.logDir });
  let file: string | null = null;
  if ((await defaultProbePort(opts.port)) === "ours") {
    try {
      const r = await fetch(`http://127.0.0.1:${opts.port}/api/diagnostics/bundle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(30_000),
      });
      if (r.status === 201) file = ((await r.json()) as { file: string }).file;
    } catch {
      /* 아래에서 직접 만든다 */
    }
  }
  if (!file) {
    const config = await loadConfig(opts.configPath);
    const snapshot = await new SnapshotBuilder({ claudeHome: opts.claudeHome, config }).build();
    file = await makeBundleFile(paths, snapshot, new HookStats().view(), () => runDoctor({ claudeHome: opts.claudeHome, paths, port: opts.port }));
  }
  console.log(`진단 파일을 만들었습니다: ${join(paths.diagDir, file)}`);
  console.log("이 파일을 담당자에게 보내 주세요. 대화 내용, 이름, 비밀값은 들어 있지 않습니다.");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "diag") {
    try {
      await diagCli(argv.slice(1));
    } catch (e) {
      console.error(`진단 파일을 만들지 못했습니다(${errInfo(e)}).`);
      process.exitCode = 1;
    }
    return;
  }
  if (argv[0] === "doctor") {
    try {
      await doctorCli(argv.slice(1));
    } catch (e) {
      console.error((e as Error).message);
      process.exitCode = 1;
    }
    return;
  }
  let opts: CliOptions;
  try {
    opts = parseCliArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  // index.ts(묶음에서는 server.mjs)의 URL을 넘긴다 — paths.ts의 URL이면 묶음 여부를 알 수 없다
  const paths = resolvePaths({ moduleUrl: import.meta.url, env: process.env, logDir: opts.logDir });
  const log = new Logger({ dir: paths.logDir });
  setLogger(log);
  log.cleanup();
  const staticDir = paths.staticDir;
  log.info("server", "start", {
    version: pkg.version,
    os: platform(),
    arch: arch(),
    node: process.version,
    port: opts.port,
    mode: paths.mode,
    claudeHomeExists: existsSync(opts.claudeHome),
    webExists: existsSync(join(staticDir, "index.html")),
  });
  process.on("exit", (code) => log.info("server", "exit", { code }));
  // 옛 Node에서 번들을 아예 못 읽는 경우는 런처(T7)가 먼저 막는다. 여기는 읽을 수는 있는 옛 Node용
  const nodeProblem = checkNode(process.version);
  if (nodeProblem) {
    console.error(nodeProblem);
    log.error("server", "node too old", { node: process.version });
    process.exit(1);
  }
  process.on("SIGINT", () => process.exit(130));
  process.on("SIGTERM", () => process.exit(143));
  if (opts.port !== HOOK_PORT) {
    console.warn(`참고: 플러그인은 ${HOOK_PORT} 포트로 이벤트를 보냅니다. ${opts.port} 포트에서는 말풍선·손들기가 보이지 않습니다.`);
    log.warn("server", "port is not 4317; plugin hooks go to 4317", { port: opts.port });
  }

  const config = await loadConfig(opts.configPath);
  const events = new EventStore();
  const hub = new SnapshotHub(new SnapshotBuilder({ claudeHome: opts.claudeHome, config, events }), {
    watchDir: opts.claudeHome,
    fallback: () => emptySnapshot(Date.now(), config, "데이터를 읽지 못했습니다 — 진단 패널을 확인해 주세요"),
  });
  await hub.start();

  const stats = new HookStats();
  setInterval(() => stats.summarize(), 60_000).unref();
  const onHookEvent = (input: Record<string, unknown>) => {
    if (events.add(input, Date.now())) hub.poke();
  };
  const home = homedir();
  const doctor = () => runDoctor({ claudeHome: opts.claudeHome, paths, port: opts.port, hooks: async () => stats.view() });
  const diagnostics = {
    diagDir: paths.diagDir,
    summary: async () => ({
      doctor: await doctor(),
      hooks: stats.view(),
      errorsLastHour: log.errorsSince(Date.now() - 3_600_000),
      logDir: scrub(paths.logDir, home) as string,
      diagDir: scrub(paths.diagDir, home) as string,
    }),
    makeBundle: () => makeBundleFile(paths, hub.current(), stats.view(), doctor),
  };
  const server = createApp(hub, { staticDir, onHookEvent, stats, diagnostics }).listen(opts.port, "127.0.0.1", () => {
    console.log(`Claude Agent Office: http://127.0.0.1:${opts.port}  (data: ${opts.claudeHome})`);
  });
  server.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") {
      console.error(`포트 ${opts.port}가 이미 사용 중입니다. --port 로 다른 포트를 지정하세요.`);
      log.error("server", "port in use", { port: opts.port });
    } else {
      console.error(e);
      log.error("server", "listen failed", { error: errInfo(e) });
    }
    hub.stop();
    process.exit(1);
  });
}

// 번들(server.mjs)을 심볼릭 링크가 낀 경로(예: macOS os.tmpdir()의 /var/folders/... → /private/var/folders/...)
// 에서 node로 직접 실행하면 import.meta.url은 실제 경로로, process.argv[1]은 호출한 그대로(링크 경로)라
// 문자열 비교가 어긋나 main()이 전혀 안 불린다(Task 6 패키지 실행 테스트에서 발견). 양쪽 다
// realpath로 풀어서 비교한다.
function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}
if (isMainModule()) void main();
