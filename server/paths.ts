import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface OfficePaths { mode: "installed" | "dev"; prefix: string | null; logDir: string; diagDir: string; staticDir: string }

/**
 * moduleUrl은 index.ts(묶음에서는 server.mjs)의 import.meta.url이다.
 * 설치본은 CLAUDE_OFFICE_PREFIX(설치 스크립트가 넣는다) 아래 logs/·diagnostics/, 저장소에서는 .logs/를 쓴다.
 */
export function resolvePaths(o: { moduleUrl: string; env: NodeJS.ProcessEnv; logDir?: string }): OfficePaths {
  const file = fileURLToPath(o.moduleUrl);
  const here = dirname(file);
  // 묶음(server.mjs) 옆에는 web/, 저장소에서는 server/../dist/web
  const staticDir = basename(file) === "server.mjs" ? join(here, "web") : resolve(here, "../dist/web");
  const prefix = o.env.CLAUDE_OFFICE_PREFIX ? resolve(o.env.CLAUDE_OFFICE_PREFIX) : null;
  const base = prefix
    ? { logDir: join(prefix, "logs"), diagDir: join(prefix, "diagnostics") }
    : { logDir: resolve(here, "../.logs"), diagDir: resolve(here, "../.logs/diagnostics") };
  return { mode: prefix ? "installed" : "dev", prefix, staticDir, ...base, ...(o.logDir ? { logDir: resolve(o.logDir) } : {}) };
}
