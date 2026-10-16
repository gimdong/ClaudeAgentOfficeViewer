import { existsSync, realpathSync } from "node:fs";
import { arch, homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createApp } from "./app";
import { loadOrCreateToken, readToken } from "./auth";
import { loadConfig } from "./config";
import { BudgetGate } from "./budget/gate";
import { BudgetStore } from "./budget/store";
import { DecisionQueue, type DecisionStats } from "./decisions/queue";
import { PolicyGate } from "./policy/gate";
import { FloorControl, type FloorStats } from "./floors/control";
import { ChannelHub } from "./floors/channels";
import { findExecutable, launchArgs, tmuxVersionOk, type LaunchInput } from "./floors/launch";
import { execFile, execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { defaultProcStartMatcher } from "./collectors/sessions";
import { PolicyStore } from "./policy/store";
import { buildBundle, readClaudeVersion, writeBundle, type PolicyStats } from "./diag/bundle";
import { defaultProbePort, defaultWhich, formatDoctor, runDoctor, type DoctorItem, type PortState } from "./diag/doctor";
import { HookStats, type HookStatsView } from "./events/stats";
import { EventStore } from "./events/store";
import { SnapshotHub } from "./hub";
import { Logger, errInfo, getLogger, scrub, setLogger, warnCaught } from "./log";
import { resolvePaths, type OfficePaths } from "./paths";
import { SubagentTracker } from "./collectors/subagents";
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

/** 개발 모드에서만 콘솔에 찍는 토큰 주소 줄(Ruling B33). 설치본은 런처가 브라우저를 연다. 로거에는 넣지 않는다 */
export function tokenUrlLine(mode: OfficePaths["mode"], port: number, token: string): string | null {
  return mode === "dev" ? `대시보드 열기(개발): http://127.0.0.1:${port}/?k=${token}` : null;
}

/**
 * 포트에 이미 무엇이 있는가: 같은 버전의 Phase 2 계열 서버(토큰 없이 401 + app 표시 + 같은 version), 버전이 다르거나 버전을
 * 안 싣는 Phase 2 계열 서버(FB-8: 설치 뒤 옛 서버가 떠 있는 경우), 인증 없는 옛 베타 서버, 그 밖
 */
export type RunningKind = "phase2" | "phase2-old" | "beta" | "other";

/** 이전 버전 서버가 떠 있을 때의 문구. 설명서 4장·6장이 글자 그대로 인용한다(manual.test) */
const OLD_RUNNING = "이전 버전 대시보드가 켜져 있습니다. 그 대시보드를 켠 터미널 창에서 Ctrl+C를 누르거나 그 창을 닫은 뒤, claude-office를 다시 실행해 주세요.";
/** FB-8: Claude Code 안에서 `!`로 켠 서버는 끌 창이 없다 */
const NO_WINDOW_HINT = "창이 보이지 않으면(Claude Code 안에서 !로 켠 경우) 사용설명서 6장 \"끌 창이 없어요\"를 보세요.";

/**
 * 포트가 이미 쓰일 때의 안내와 종료 코드(Ruling B42·B64, 문구 B66, FB-8). 런처가 앞에 낸 "이 창을 닫으면…"을 설치본에서는 바로잡는다.
 * 버전이 다른 Phase 2 계열 서버는 0으로 끝내지 않는다 — 옛 서버가 새 화면을 내보내 저장이 실패하고 사용자는 재시작할 길을 모른다(FB-7·8)
 */
export function portInUseOutcome(kind: RunningKind, mode: OfficePaths["mode"], port: number, version?: string): { code: 0; out: string } | { code: 1; err: string } {
  if (kind === "phase2") {
    return { code: 0, out: mode === "installed" ? "이미 켜져 있습니다. 브라우저에서 대시보드를 다시 열었습니다. 이 창은 닫아도 대시보드가 꺼지지 않습니다." : "이미 켜져 있습니다." };
  }
  if (kind === "phase2-old") return { code: 1, err: `${version ? OLD_RUNNING.replace("이전 버전 대시보드가", `이전 버전 대시보드(${version})가`) : OLD_RUNNING} ${NO_WINDOW_HINT}` };
  if (kind === "beta") return { code: 1, err: `${OLD_RUNNING} ${NO_WINDOW_HINT}` };
  return { code: 1, err: `포트 ${port}번이 이미 사용 중입니다. --port 로 다른 포트를 지정하세요.` };
}

/**
 * doctor의 "ours"에는 인증 없는 베타 서버도 들어간다. 토큰 없이 물어 401 + app "claude-office"면 Phase 2 서버다(토큰은 보내지 않는다, B52).
 * 그 밖에 doctor 판정이 ours면 옛 베타 서버
 */
async function probeRunning(port: number): Promise<{ kind: RunningKind; version?: string }> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/snapshot`, { signal: AbortSignal.timeout(1500) });
    const body = (await r.json().catch(() => null)) as { app?: unknown; version?: unknown } | null;
    if (r.status === 401 && body?.app === "claude-office") {
      // FB-8: 401에 version을 싣기 시작한 것은 beta.5부터. 없으면 그보다 옛 Phase 2 계열 서버다
      const v = typeof body.version === "string" ? body.version : undefined;
      return v === pkg.version ? { kind: "phase2", version: v } : { kind: "phase2-old", version: v };
    }
  } catch {
    /* 아래 doctor 판정으로 */
  }
  return { kind: (await defaultProbePort(port)) === "ours" ? "beta" : "other" };
}

/** Node가 24 미만이면 쉬운 말 안내를, 아니면 null을 돌려준다(스펙 5장 1번) */
export function checkNode(version: string): string | null {
  const major = Number(/^v(\d+)/.exec(version)?.[1] ?? 0);
  return major >= 24 ? null : `Claude Agent Office는 Node.js 24 이상이 필요합니다(지금 ${version}). https://nodejs.org 에서 LTS를 설치한 뒤 다시 실행해 주세요.`;
}

/** 토큰 파일이 있으면 Bearer 헤더. "ours"로 판정된 포트에만 쓴다(Ruling B52) */
function bearer(paths: OfficePaths): Record<string, string> {
  const token = readToken(paths.tokenFile);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** `doctor [--json]`: 서버를 켜지 않고 환경을 점검한다. 켜져 있는 서버의 hook 통계는 /api/diagnostics에서 읽는다 */
async function doctorCli(argv: string[]): Promise<void> {
  const json = argv.includes("--json");
  const opts = parseCliArgs(argv.filter((a) => a !== "--json"));
  const paths = resolvePaths({ moduleUrl: import.meta.url, env: process.env, logDir: opts.logDir });
  // 포트 판정은 토큰 없이 한 번만 하고(Ruling B52), 이 프로그램일 때만 토큰을 읽어 hook 통계를 묻는다. 값은 출력하지 않는다
  let probed: Promise<PortState> | undefined;
  const probePort = (port: number) => (probed ??= defaultProbePort(port));
  const items = await runDoctor({
    claudeHome: opts.claudeHome,
    paths,
    port: opts.port,
    probePort,
    hooks: async () => {
      if ((await probePort(opts.port)) !== "ours") return null;
      return fetch(`http://127.0.0.1:${opts.port}/api/diagnostics`, { headers: bearer(paths), signal: AbortSignal.timeout(1500) })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => (j as { hooks?: HookStatsView } | null)?.hooks ?? null)
        .catch(() => null);
    },
  });
  console.log(json ? JSON.stringify(items, null, 2) : formatDoctor(items));
  process.exitCode = items.some((i) => i.status === "fail") ? 1 : 0;
}

/** 진단 파일을 만들어 paths.diagDir에 쓰고 파일 이름을 돌려준다(서버 버튼과 CLI가 같이 쓴다) */
/** decisions는 켜진 서버의 큐 통계. CLI가 직접 만들 때는 없다(진단 파일에는 0으로 들어간다). policy는 정책 통계(대상 이름 없음) */
async function makeBundleFile(paths: OfficePaths, snapshot: Snapshot, hooks: HookStatsView, doctor: () => Promise<DoctorItem[]>, policy: PolicyStats, decisions?: DecisionStats, floors?: FloorStats): Promise<string> {
  const claudeVersion = await readClaudeVersion(defaultWhich(process.env, process.platform)("claude"));
  return writeBundle(paths.diagDir, await buildBundle({ doctor, hooks, snapshot, logDir: paths.logDir, appVersion: pkg.version, claudeVersion, decisions, policy, floors }));
}

/**
 * `diag`: 진단 파일을 만들고 전체 경로를 출력한다(고객 자신의 화면이라 경로를 보여 준다. 파일 안에는 없다).
 * 이 포트의 서버가 우리 서버면 서버에게 만들게 하고(hook 통계 포함), 아니면 직접 만든다.
 */
async function diagCli(argv: string[]): Promise<void> {
  const opts = parseCliArgs(argv);
  const paths = resolvePaths({ moduleUrl: import.meta.url, env: process.env, logDir: opts.logDir });
  let file: string | null = null;
  // 이 프로그램으로 판정된 포트에만 토큰을 보낸다(Ruling B52)
  if ((await defaultProbePort(opts.port)) === "ours") {
    try {
      const r = await fetch(`http://127.0.0.1:${opts.port}/api/diagnostics/bundle`, {
        method: "POST",
        // Bearer + Origin 없음(Ruling B32). 토큰이 없거나 틀리면 401 → 아래에서 직접 만든다
        headers: { "Content-Type": "application/json", ...bearer(paths) },
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
    // 서버가 없으면 정책 파일을 읽기만 한다(판정 수는 서버 메모리 값이라 0)
    const policyStore = new PolicyStore(paths.policyFile);
    policyStore.load();
    const policy = { ...policyStore.summary(), decisions: { deny: 0, ask: 0 } };
    file = await makeBundleFile(paths, snapshot, new HookStats().view(), () => runDoctor({ claudeHome: opts.claudeHome, paths, port: opts.port }), policy);
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
  // 결정이 생기거나 끝나면 화면을 바로 갱신한다. hub는 아래에서 만들고, onChange는 hook이 온 뒤에야 불린다
  // 예산(스펙 5장): 상태 파일은 시작할 때 한 번 읽고, 관문은 메모리 값만 본다
  const budgetStore = new BudgetStore(paths.stateFile);
  budgetStore.load();
  // 큐의 "계속" → 관문이 nextGateAt을 올리고, 관문은 같은 세션의 남은 예산 결정을 permission으로 바꾼다(Ruling B35)
  const gate = new BudgetGate(budgetStore, { demote: (id) => decisions.demoteBudget(id) });
  const policyStore = new PolicyStore(paths.policyFile);
  policyStore.load();
  const policy = new PolicyGate(policyStore, { onChange: () => hub.poke() });
  // 층 관리(Phase 4a). 실제 신호(process.kill)는 이 한 줄에만 묶는다 — 서버·테스트는 주입된 signal만 쓴다(스펙 5.1)
  // aliasOf: 합친 층(B192)의 대화 쪽 session_id로 온 hook도 그 층의 멈춤에 걸리게. builder는 아래에서 만들지만 호출은 서버가 뜬 뒤다
  const floors = new FloorControl({ signal: (pid, sig) => process.kill(pid, sig), matchProcStart: defaultProcStartMatcher, selfPid: process.pid, onChange: () => hub.poke(), aliasOf: (id) => builder.floorIdOf(id) });
  // 작업 지시·새 층(Phase 4b, 실험 기능). tmux와 claude 실제 경로가 있어야 켤 수 있다(Windows 제외)
  const tmuxFound = platform() === "win32" ? undefined : findExecutable("tmux");
  const tmuxBin = tmuxFound && tmuxVersionOk((() => { try { return execFileSync(tmuxFound, ["-V"], { encoding: "utf8", timeout: 3000 }); } catch { return ""; } })()) ? tmuxFound : undefined;
  const claudeBin = platform() === "win32" ? undefined : process.env.CLAUDE_OFFICE_CLAUDE_BIN ?? findExecutable("claude", process.env.PATH, [join(homedir(), ".local/bin")]);
  const channels = new ChannelHub({
    file: join(dirname(paths.stateFile), "experimental.json"),
    available: platform() === "win32" ? { ok: false, reason: "windows" } : !tmuxBin ? { ok: false, reason: "tmux" } : !claudeBin ? { ok: false, reason: "claude" } : { ok: true },
    onChange: () => hub.poke(),
  });
  channels.load();
  const launchFloor = async (input: LaunchInput) => {
    if (!tmuxBin || !claudeBin) return { ok: false as const, error: "tmux" as const };
    const sessionId = randomUUID();
    const tmuxName = `co-${randomBytes(4).toString("hex")}`;
    const key = channels.register(sessionId, tmuxName);
    if (!key) return { ok: false as const, error: "limit" as const };
    const args = launchArgs({ ...input, tmuxName, claude: claudeBin, channelSpec: process.env.CLAUDE_OFFICE_CHANNEL_SPEC ?? "plugin:claude-office@claude-office", sessionId, key, port: opts.port, socket: process.env.CLAUDE_OFFICE_TMUX_SOCKET });
    const ok = await new Promise<boolean>((r) => execFile(tmuxBin, args, { timeout: 10_000 }, (e) => (e && getLogger().warn("floors", "launch failed", { error: errInfo(e) }), r(!e))));
    if (!ok) {
      channels.unregister(sessionId);
      return { ok: false as const, error: "tmux" as const };
    }
    return { ok: true as const, sessionId, tmux: tmuxName };
  };
  const decisions = new DecisionQueue({ onChange: () => hub.poke(), onResolve: (v) => gate.resolved(v) });
  process.on("exit", () => decisions.stop()); // SIGINT·SIGTERM도 process.exit를 거쳐 여기로 온다
  const subagents = new SubagentTracker();
  const builder = new SnapshotBuilder({ claudeHome: opts.claudeHome, config, version: pkg.version, events, subagents, decisions, budget: { gate, store: budgetStore }, policy: { store: policyStore, gate: policy }, floors, channels, matchProcStart: defaultProcStartMatcher });
  const hub = new SnapshotHub(builder, {
    watchDir: opts.claudeHome,
    fallback: () => emptySnapshot(Date.now(), config, "데이터를 읽지 못했습니다 — 진단 패널을 확인해 주세요"),
  });
  await hub.start();

  const stats = new HookStats();
  setInterval(() => stats.summarize(), 60_000).unref();
  const onHookEvent = (input: Record<string, unknown>) => {
    try {
      subagents.onEvent(input);
    } catch (e) {
      warnCaught("subagents", "tracker failed", e); // 기록기가 실패해도 아래 저장·관문은 계속(B177 M2)
    }
    if (events.add(input, Date.now())) hub.poke();
    gate.onEvent(input);
  };
  const budget = {
    set: (sessionId: string | undefined, tokens: number | null) => {
      // 화면은 층 id를 보낸다. 관문은 hook의 session_id(대화 키)로 판정하므로 그 키로 저장한다(B192)
      if (sessionId) budgetStore.setBudget(builder.convOf(sessionId), tokens, gate.usage(builder.convOf(sessionId)));
      else budgetStore.setDefault(tokens);
      hub.poke(); // 막대·관문 판정(view)이 새 값을 곧바로 쓰게 다시 만든다
    },
  };
  const home = homedir();
  // 서버 안의 doctor는 자기 자신이 이 포트를 쓴다. 기본 probe는 /api/diagnostics를 부르는데, 그 API가 다시
  // doctor를 돌리므로 자기 자신을 조회하면 끝없이 되풀이된다(FB-2). 그래서 "ours"로 준다
  const doctor = () => runDoctor({ claudeHome: opts.claudeHome, paths, port: opts.port, hooks: async () => stats.view(), probePort: async () => "ours" });
  const diagnostics = {
    diagDir: paths.diagDir,
    summary: async () => ({
      doctor: await doctor(),
      hooks: stats.view(),
      errorsLastHour: log.errorsSince(Date.now() - 3_600_000),
      logDir: scrub(paths.logDir, home) as string,
      diagDir: scrub(paths.diagDir, home) as string,
    }),
    makeBundle: () => makeBundleFile(paths, hub.current(), stats.view(), doctor, { ...policyStore.summary(), decisions: policy.totals() }, decisions.stats(), floors.stats()),
  };
  // 토큰 파일이 없으면(beta.2에서 올라온 설치본, 개발 첫 실행) 여기서 0600으로 만든다(Ruling B33)
  const token = loadOrCreateToken(paths.tokenFile);
  const floorsApi = {
    preToolUse: (i: Record<string, unknown>) => floors.preToolUse(i),
    pause: (id: string) => floors.pause(id),
    resume: (id: string) => floors.resume(id),
    isPaused: (id: string) => floors.isPaused(id),
    terminate: (r: Parameters<FloorControl["terminate"]>[0], force: boolean) => floors.terminate(r, force),
    hide: (id: string) => floors.hide(id),
    unhideAll: () => floors.unhideAll(),
    hiddenCount: () => floors.hiddenCount(),
    // 마지막 스냅샷 빌드의 세션 레코드(B117) — 종료 검사는 스냅샷이 아니라 이 레코드의 pid·procStart로 한다
    record: (id: string) => builder.record(id),
  };
  const server = createApp(hub, { staticDir, onHookEvent, normalizeSession: (id) => builder.convOf(id), stats, diagnostics, auth: { token, version: pkg.version }, decisions, gate, budget, policy, policyApi: policyStore, floors: floorsApi, channels: { hub: channels, launch: launchFloor } }).listen(opts.port, "127.0.0.1", (err?: Error) => {
    // Express 5는 listen이 실패해도(EADDRINUSE 등) 이 콜백을 오류와 함께 부른다. 실패 안내는 아래 "error" 처리가 한다
    if (err) return;
    console.log(`Claude Agent Office: http://127.0.0.1:${opts.port}  (data: ${opts.claudeHome})`);
    const line = tokenUrlLine(paths.mode, opts.port, token);
    if (line) console.log(line);
  });
  server.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") {
      // 이미 이 프로그램이 켜져 있으면(Ruling B42) 오류가 아니다 — 런처가 토큰 주소로 브라우저를 이미 다시 열었다.
      // 판별은 doctor의 포트 판정을 그대로 쓴다(토큰을 보내지 않는다, B52). v1·다른 프로그램은 기존 안내와 종료 코드 1
      // 인증 없는 옛 베타 서버(B64)는 0으로 끝내지 않는다 — 브라우저에 옛 화면이 뜨고 결정·예산이 조용히 동작하지 않기 때문
      void probeRunning(opts.port).then(({ kind, version }) => {
        hub.stop();
        const o = portInUseOutcome(kind, paths.mode, opts.port, version);
        if (o.code === 0) {
          console.log(o.out);
          log.info("server", "already running", { port: opts.port });
        } else {
          console.error(o.err);
          log.error("server", kind === "beta" || kind === "phase2-old" ? "older version running" : "port in use", { port: opts.port });
        }
        process.exit(o.code);
      });
      return;
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
