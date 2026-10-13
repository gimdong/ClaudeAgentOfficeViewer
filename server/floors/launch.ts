import { statSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { MAX_TEXT } from "./channels";

export const MODELS = ["opus", "sonnet", "haiku"] as const;
export type LaunchModel = (typeof MODELS)[number];
export interface LaunchInput { cwd: string; name: string; model?: LaunchModel; prompt?: string }
const NAME = /^[\p{L}\p{N} ._-]{1,40}$/u;

/** 본문 검사(스펙 4.2). 폴더는 realpath 뒤 실제 디렉터리여야 한다 */
export function validateLaunch(b: unknown, home = homedir()): { ok: true; value: LaunchInput } | { ok: false; error: string } {
  if (!b || typeof b !== "object" || Array.isArray(b)) return { ok: false, error: "body" };
  const { cwd, name, model, prompt, ...rest } = b as Record<string, unknown>;
  if (Object.keys(rest).length) return { ok: false, error: "body" };
  if (typeof cwd !== "string" || !cwd || cwd.length > 1024 || cwd.includes("\0")) return { ok: false, error: "cwd" };
  const expanded = cwd === "~" ? home : cwd.startsWith("~/") ? join(home, cwd.slice(2)) : cwd;
  if (!isAbsolute(expanded)) return { ok: false, error: "cwd" };
  let real: string;
  try {
    real = realpathSync(expanded);
    if (!statSync(real).isDirectory()) return { ok: false, error: "cwd" };
  } catch {
    return { ok: false, error: "cwd" };
  }
  let nm: string;
  if (name === undefined || name === "") {
    nm = [...basename(real)].filter((c) => NAME.test(c)).join("").slice(0, 40) || "floor";
  } else if (typeof name === "string" && NAME.test(name)) nm = name;
  else return { ok: false, error: "name" };
  if (model !== undefined && !MODELS.includes(model as LaunchModel)) return { ok: false, error: "model" };
  if (prompt !== undefined && (typeof prompt !== "string" || prompt.length > MAX_TEXT || prompt.includes("\0"))) return { ok: false, error: "prompt" };
  return { ok: true, value: { cwd: real, name: nm, ...(model ? { model: model as LaunchModel } : {}), ...(prompt ? { prompt } : {}) } };
}

/**
 * tmux 인자(스펙 4.2). 셸을 거치지 않는다. 첫 지시는 channel 옵션 **앞**에 둔다 —
 * 그 옵션은 값을 여러 개 받아 뒤의 프롬프트를 삼킨다(스파이크 Q4 함정)
 */
export function launchArgs(o: { tmuxName: string; claude: string; channelSpec: string; sessionId: string; key: string; port: number; socket?: string } & LaunchInput): string[] {
  return [
    ...(o.socket ? ["-L", o.socket] : []),
    "new-session", "-d", "-s", o.tmuxName, "-c", o.cwd,
    "-e", `CLAUDE_OFFICE_FLOOR_KEY=${o.key}`, "-e", `CLAUDE_OFFICE_PORT=${o.port}`,
    "--",
    o.claude, "--session-id", o.sessionId, "--name", o.name,
    ...(o.model ? ["--model", o.model] : []),
    ...(o.prompt ? [o.prompt] : []),
    "--dangerously-load-development-channels", o.channelSpec,
  ];
}

/**
 * 실행 파일을 찾아 실제 경로로(심볼릭 링크 풀기). 없으면 undefined. first를 먼저 본다 —
 * claude는 ~/.local/bin/claude를 먼저: PATH 앞쪽의 터미널 shim(cmux 등)은 자기 --session-id를 끼워 넣는다
 */
export function findExecutable(name: string, path = process.env.PATH ?? "", first: string[] = []): string | undefined {
  for (const dir of [...first, ...path.split(":")]) {
    if (!dir) continue;
    try {
      const p = realpathSync(join(dir, name));
      if (statSync(p).isFile()) return p;
    } catch {
      // 다음 폴더
    }
  }
  return undefined;
}
