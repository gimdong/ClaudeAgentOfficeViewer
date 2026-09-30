import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { SnapshotHub } from "./hub";
import { SnapshotBuilder } from "./snapshot";

export interface CliOptions {
  port: number;
  claudeHome: string;
  configPath: string;
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
    options: { port: { type: "string" }, "claude-home": { type: "string" }, config: { type: "string" } },
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
  const config = await loadConfig(opts.configPath);
  const hub = new SnapshotHub(new SnapshotBuilder({ claudeHome: opts.claudeHome, config }), { watchDir: opts.claudeHome });
  await hub.start();

  const staticDir = fileURLToPath(new URL("../dist/web", import.meta.url));
  const server = createApp(hub, { staticDir }).listen(opts.port, "127.0.0.1", () => {
    console.log(`Claude Agent Office: http://127.0.0.1:${opts.port}  (data: ${opts.claudeHome})`);
  });
  server.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") console.error(`포트 ${opts.port}가 이미 사용 중입니다. --port 로 다른 포트를 지정하세요.`);
    else console.error(e);
    hub.stop();
    process.exit(1);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
