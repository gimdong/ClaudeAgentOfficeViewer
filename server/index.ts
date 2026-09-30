import { existsSync } from "node:fs";
import { arch, homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { EventStore } from "./events/store";
import { SnapshotHub } from "./hub";
import { Logger, setLogger } from "./log";
import { resolvePaths } from "./paths";
import { SnapshotBuilder } from "./snapshot";
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

async function main(): Promise<void> {
  let opts: CliOptions;
  try {
    opts = parseCliArgs(process.argv.slice(2));
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
    version: (pkg as { version?: string }).version ?? "dev", // version은 T6에서 package.json에 들어온다
    os: platform(),
    arch: arch(),
    node: process.version,
    port: opts.port,
    mode: paths.mode,
    claudeHomeExists: existsSync(opts.claudeHome),
    webExists: existsSync(join(staticDir, "index.html")),
  });
  process.on("exit", (code) => log.info("server", "exit", { code }));
  process.on("SIGINT", () => process.exit(130));
  process.on("SIGTERM", () => process.exit(143));

  const config = await loadConfig(opts.configPath);
  const events = new EventStore();
  const hub = new SnapshotHub(new SnapshotBuilder({ claudeHome: opts.claudeHome, config, events }), { watchDir: opts.claudeHome });
  await hub.start();

  const onHookEvent = (input: Record<string, unknown>) => {
    if (events.add(input, Date.now())) hub.poke();
  };
  const server = createApp(hub, { staticDir, onHookEvent }).listen(opts.port, "127.0.0.1", () => {
    console.log(`Claude Agent Office: http://127.0.0.1:${opts.port}  (data: ${opts.claudeHome})`);
  });
  server.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") {
      console.error(`포트 ${opts.port}가 이미 사용 중입니다. --port 로 다른 포트를 지정하세요.`);
      log.error("server", "port in use", { port: opts.port });
    } else {
      console.error(e);
      log.error("server", "listen failed", { code: e.code, error: e.message });
    }
    hub.stop();
    process.exit(1);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
