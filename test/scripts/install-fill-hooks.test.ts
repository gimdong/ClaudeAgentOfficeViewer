import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Phase 6a §2: 설치 스크립트가 플러그인 등록 전에 부르는 자리 표시자 바꾸기. 실패는 exit 1(설치를 멈춘다), 파일은 그대로
const FILL = join(__dirname, "../../packaging/fill-hooks.cjs");
const ORIGINAL = readFileSync(join(__dirname, "../../plugins/claude-office/hooks/hooks.json"), "utf8");
let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "co-fill-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const run = (...args: string[]) => spawnSync(process.execPath, [FILL, ...args], { encoding: "utf8" });

describe("fill-hooks.cjs", () => {
  it("원본 hooks.json의 13개 command·args 자리를 이 node와 열쇠 경로로(따옴표·역슬래시·공백이 있는 경로도 JSON 값으로)", () => {
    const f = join(dir, "hooks.json");
    writeFileSync(f, ORIGINAL);
    const key = 'C:\\Users\\a "b"\\hook.key';
    expect(run(f, key).status).toBe(0);
    const text = readFileSync(f, "utf8");
    expect(text).not.toMatch(/__NODE__|__KEYFILE__/);
    const hooks = Object.values(JSON.parse(text).hooks as Record<string, Array<{ hooks: Array<{ command: string; args: string[] }> }>>).flatMap((g) => g.flatMap((x) => x.hooks));
    expect(hooks).toHaveLength(13);
    for (const h of hooks) expect([h.command, h.args]).toEqual([process.execPath, ["${CLAUDE_PLUGIN_ROOT}/hooks/relay.cjs", key]]);
  });

  // review M2(B304·B305): process.execPath는 링크를 푼 실제 경로(예: Homebrew Cellar 버전 폴더)라 업그레이드 뒤 사라진다 —
  // 설치 스크립트가 넘긴 PATH 위의 node 경로(링크 그대로)를 쓰되, 절대 경로이고 realpath가 지금 node와 같을 때만.
  // volta·asdf·mise·nodenv의 shim은 cwd 설정으로 바이너리를 고르므로(스펙 13번 위반) execPath로 간다
  const commandsOf = (f: string) => [...new Set(Object.values(JSON.parse(readFileSync(f, "utf8")).hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>).flatMap((g) => g.flatMap((x) => x.hooks.map((h) => h.command))))];
  it.skipIf(process.platform === "win32")("셋째 인자(설치 스크립트가 찾은 node)가 링크면 링크 경로 그대로 적는다(realpath로 풀지 않음)", () => {
    const f = join(dir, "hooks.json");
    writeFileSync(f, ORIGINAL);
    const link = join(dir, "bin-node");
    symlinkSync(process.execPath, link);
    expect(run(f, "/k", link).status).toBe(0);
    expect(commandsOf(f)).toEqual([link]);
  });

  it("셋째 인자가 다른 실행 파일(가짜 shim)·상대 경로·없는 파일·실행 불가·폴더이거나 없으면 process.execPath", () => {
    const plain = join(dir, "plain");
    writeFileSync(plain, "x");
    chmodSync(plain, 0o644);
    const shim = join(dir, "shim-node");
    writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 }); // 실행되고 같은 node를 부르지만 다른 파일
    for (const arg of [shim, "node", "./node", join(dir, "gone"), ...(process.platform === "win32" ? [] : [plain]), dir, undefined]) {
      const f = join(dir, "hooks.json");
      writeFileSync(f, ORIGINAL);
      expect(run(...[f, "/k", ...(arg === undefined ? [] : [arg])]).status, String(arg)).toBe(0);
      expect(commandsOf(f), String(arg)).toEqual([process.execPath]);
    }
  });

  it("자리 표시자가 남거나(다른 자리), 깨진 JSON이거나, 인자가 없으면 exit 1이고 파일을 바꾸지 않는다", () => {
    const f = join(dir, "hooks.json");
    const left = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "__NODE__", args: ["x", "__KEYFILE__"], note: "__NODE__" }] }] } });
    for (const body of [left, "{ broken"]) {
      writeFileSync(f, body);
      expect(run(f, "/k").status).toBe(1);
      expect(readFileSync(f, "utf8")).toBe(body);
    }
    expect(run().status).toBe(1);
    expect(run(f).status).toBe(1);
  });
});
