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

export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: { port: { type: "string" }, "claude-home": { type: "string" }, config: { type: "string" } },
  });
  const port = values.port === undefined ? 4317 : Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`잘못된 포트: ${values.port}`);
  return {
    port,
    claudeHome: resolve(values["claude-home"] ?? env.CLAUDE_HOME ?? join(homedir(), ".claude")),
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
