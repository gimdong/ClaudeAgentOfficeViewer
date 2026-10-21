import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
