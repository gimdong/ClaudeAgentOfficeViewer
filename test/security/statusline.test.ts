// Phase 6b Task 11(스펙 12장 j, B325) 보안 회귀 — 구현 전 실패 테스트. 사용자 설정(~/.claude/settings.json)을 바꾸는 일이라
// 임시 HOME·임시 CLAUDE_CONFIG_DIR에서만 한다. 비밀값은 가짜
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../..");
const FAKE_SECRET = "sk-fake-0000-should-stay-private";
const ORIG = { type: "command", command: "echo ORIG_STATUS", padding: 2 };
const SETTINGS = { model: "sonnet", env: { FAKE_API_KEY: FAKE_SECRET }, statusLine: ORIG };
const sha1 = (f: string) => createHash("sha1").update(readFileSync(f)).digest("hex");
const mode = (f: string) => statSync(f).mode & 0o777;

let base: string;
let cc: string; // 임시 CLAUDE_CONFIG_DIR
let scripts: string; // 따옴표·공백이 든 설치 경로 아래의 scripts 복사본
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "co-sec-sl-"));
  cc = join(base, "cc");
  mkdirSync(cc, { recursive: true });
  writeFileSync(join(cc, "settings.json"), JSON.stringify(SETTINGS, null, 2) + "\n", { mode: 0o600 });
  chmodSync(join(cc, "settings.json"), 0o600);
  scripts = join(base, "o'brien dir", "scripts");
  mkdirSync(scripts, { recursive: true });
  for (const f of ["statusline-setup.mjs", "statusline-tap.sh"]) copyFileSync(join(ROOT, "scripts", f), join(scripts, f));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const env = () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(base, "home"), CLAUDE_CONFIG_DIR: cc });
const setup = (cmd: "install" | "remove") => spawnSync(process.execPath, [join(scripts, "statusline-setup.mjs"), cmd], { env: env(), encoding: "utf8" });
const settings = () => JSON.parse(readFileSync(join(cc, "settings.json"), "utf8"));

describe.skipIf(process.platform === "win32")("statusline-setup install·remove(스펙 12장 j)", () => {
  it("설정 파일 권한을 넓히지 않는다: settings.json은 원래 0600 그대로, 백업·limits.json·임시 파일도 0600(설정에 비밀값이 있을 수 있음)", () => {
    expect(setup("install").status).toBe(0);
    expect(mode(join(cc, "settings.json"))).toBe(0o600);
    const office = join(cc, "claude-office");
    for (const f of readdirSync(office)) if (f.endsWith(".json")) expect(mode(join(office, f)), f).toBe(0o600);
    // tap을 한 번 돌려 limits.json을 만든다
    const r = spawnSync("sh", ["-c", settings().statusLine.command], { input: JSON.stringify({ session_id: "s", rate_limits: { five_hour: { used_percentage: 10 } } }), env: env(), encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(mode(join(office, "limits.json"))).toBe(0o600);
  });

  it("설치 경로에 따옴표·공백이 있어도 statusLine 명령이 깨지거나 다른 명령이 되지 않는다: tap이 돌고 원래 명령도 이어 돈다", () => {
    expect(setup("install").status).toBe(0);
    const r = spawnSync("sh", ["-c", settings().statusLine.command], { input: '{"session_id":"s"}', env: env(), encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("ORIG_STATUS");
    expect(existsSync(join(cc, "claude-office", "limits.json"))).toBe(true);
  });

  it("remove는 statusLine을 원래 값과 똑같이 되돌리고 다른 키는 건드리지 않는다. 권한도 그대로", () => {
    expect(setup("install").status).toBe(0);
    expect(setup("remove").status).toBe(0);
    expect(settings()).toEqual(SETTINGS);
    expect(mode(join(cc, "settings.json"))).toBe(0o600);
  });

  it("설치 뒤 사용자가 statusLine을 바꿨으면 remove가 옛 백업으로 덮어쓰지 않는다", () => {
    expect(setup("install").status).toBe(0);
    const s = settings();
    s.statusLine = { type: "command", command: "echo USER_NEWER" };
    writeFileSync(join(cc, "settings.json"), JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
    setup("remove");
    expect(settings().statusLine).toEqual({ type: "command", command: "echo USER_NEWER" });
  });

  it("settings.json이 심볼릭 링크(dotfiles 관리)면 링크를 일반 파일로 바꾸지 않는다", () => {
    const real = join(base, "dotfiles-settings.json");
    copyFileSync(join(cc, "settings.json"), real);
    chmodSync(real, 0o600);
    rmSync(join(cc, "settings.json"));
    symlinkSync(real, join(cc, "settings.json"));
    expect(setup("install").status).toBe(0);
    expect(lstatSync(join(cc, "settings.json")).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, "utf8")).statusLine.command).toContain("statusline-tap.sh");
  });
});

describe.skipIf(process.platform === "win32")("install.sh의 statusline 질문(B325)", () => {
  /** 최소 압축본: install.sh·도우미·플러그인 hooks.json·가짜 서버(doctor는 그냥 0). statusline 파일은 app/과 scripts/ 양쪽에 둔다 */
  function pkg() {
    const p = join(base, "pkg");
    for (const d of ["app", "scripts", "plugin/plugins/claude-office/hooks"]) mkdirSync(join(p, d), { recursive: true });
    for (const [s, d] of [["packaging/install.sh", "install.sh"], ["packaging/fill-hooks.cjs", "fill-hooks.cjs"], ["packaging/claude-office.sh", "claude-office.sh"], ["plugins/claude-office/hooks/hooks.json", "plugin/plugins/claude-office/hooks/hooks.json"]]) copyFileSync(join(ROOT, s), join(p, d));
    for (const f of ["statusline-setup.mjs", "statusline-tap.sh"]) for (const d of ["app", "scripts"]) copyFileSync(join(ROOT, "scripts", f), join(p, d, f));
    writeFileSync(join(p, "app/server.mjs"), "process.exit(0)\n");
    writeFileSync(join(p, "VERSION"), "0.0.0-test\n");
    chmodSync(join(p, "install.sh"), 0o755);
    chmodSync(join(p, "claude-office.sh"), 0o755);
    return p;
  }
  const install = (args: string[], input = "") =>
    spawnSync("sh", [join(pkg(), "install.sh"), "--prefix", join(base, "prefix"), "--no-path", "--no-open", "--port", "4391", ...args], { input, env: { ...env(), SHELL: "/bin/sh" }, encoding: "utf8" });

  it("--yes만으로는 켜지 않고, 비대화형(파이프로 y)도 켜지 않는다: settings.json 바이트 그대로, claude-office 폴더도 만들지 않음", () => {
    const before = sha1(join(cc, "settings.json"));
    for (const [args, input] of [[["--yes"], ""], [[], "y\ny\ny\n"], [["--yes"], "y\n"]] as const) {
      install([...args], input);
      expect(sha1(join(cc, "settings.json")), args.join(" ") + JSON.stringify(input)).toBe(before);
      expect(existsSync(join(cc, "claude-office")), args.join(" ")).toBe(false);
    }
  });

  it("--statusline이면 묻지 않고 켠다(설치본 경로의 tap), 다른 키와 권한은 그대로", () => {
    const r = install(["--yes", "--statusline"]);
    expect(r.status, r.stderr).toBe(0);
    const s = settings();
    expect(s.statusLine.command).toContain("statusline-tap.sh");
    expect(s.statusLine.command).toContain(join(base, "prefix"));
    expect(s.env).toEqual(SETTINGS.env);
    expect(mode(join(cc, "settings.json"))).toBe(0o600);
    // 설치 로그·출력에 설정 내용(비밀값·원래 명령)이 나오지 않는다
    expect(r.stdout + r.stderr).not.toContain(FAKE_SECRET);
    const logs = join(base, "prefix", "logs");
    for (const f of existsSync(logs) ? readdirSync(logs) : []) expect(readFileSync(join(logs, f), "utf8")).not.toContain(FAKE_SECRET);
  });
});
