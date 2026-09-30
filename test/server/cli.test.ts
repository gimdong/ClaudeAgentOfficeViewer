import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseCliArgs } from "../../server/index";

describe("parseCliArgs", () => {
  it("옵션 > 환경변수 > 기본값 순서", () => {
    expect(parseCliArgs(["--port", "5000", "--claude-home", "/tmp/x"], {})).toEqual({ port: 5000, claudeHome: "/tmp/x", configPath: resolve("claude-office.config.json") });
    expect(parseCliArgs([], { CLAUDE_HOME: "/env/home" })).toMatchObject({ port: 4317, claudeHome: "/env/home" });
    expect(parseCliArgs([], {})).toMatchObject({ claudeHome: join(homedir(), ".claude") });
  });

  it("잘못된 포트는 오류", () => {
    expect(() => parseCliArgs(["--port", "abc"], {})).toThrow("잘못된 포트");
    expect(() => parseCliArgs(["--port", "70000"], {})).toThrow("잘못된 포트");
  });

  // final review I-1(Ruling 17): --claude-home > CLAUDE_HOME > CLAUDE_CONFIG_DIR > 기본값.
  it("CLAUDE_CONFIG_DIR만 설정돼 있으면 그것을 쓴다", () => {
    expect(parseCliArgs([], { CLAUDE_CONFIG_DIR: "/cfg/dir" })).toMatchObject({ claudeHome: "/cfg/dir" });
  });

  it("CLAUDE_HOME이 CLAUDE_CONFIG_DIR보다 우선한다", () => {
    expect(parseCliArgs([], { CLAUDE_HOME: "/env/home", CLAUDE_CONFIG_DIR: "/cfg/dir" })).toMatchObject({ claudeHome: "/env/home" });
  });

  it("CLAUDE_HOME이 빈 문자열이면 건너뛰고 CLAUDE_CONFIG_DIR을 쓴다", () => {
    expect(parseCliArgs([], { CLAUDE_HOME: "", CLAUDE_CONFIG_DIR: "/cfg/dir" })).toMatchObject({ claudeHome: "/cfg/dir" });
  });

  it("선행 ~/는 homedir()로 확장된다", () => {
    expect(parseCliArgs(["--claude-home", "~/mydir"], {})).toMatchObject({ claudeHome: join(homedir(), "mydir") });
  });

  it("단독 ~도 homedir()로 확장된다", () => {
    expect(parseCliArgs(["--claude-home", "~"], {})).toMatchObject({ claudeHome: homedir() });
  });

  it("--log-dir는 홈을 전개해 logDir로 들어오고, 없으면 undefined", () => {
    expect(parseCliArgs(["--log-dir", "~/x"], {})).toMatchObject({ logDir: join(homedir(), "x") });
    expect(parseCliArgs([], {}).logDir).toBeUndefined();
  });
});

describe("CLI", () => {
  it("doctor --json은 서버를 켜지 않고 10개 항목을 JSON으로 내고, fail이 있으면 종료 코드 1", async () => {
    const home = mkdtempSync(join(tmpdir(), "office-doctor-home-"));
    const logDir = mkdtempSync(join(tmpdir(), "office-doctor-log-"));
    const child = spawn(join("node_modules", ".bin", "tsx"), ["server/index.ts", "doctor", "--json", "--claude-home", home, "--port", "4399", "--log-dir", logDir], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    const code = await new Promise<number | null>((r) => child.on("exit", r));
    const items = JSON.parse(stdout) as Array<{ id: string; status: string }>;
    const logFiles = readdirSync(logDir);
    rmSync(home, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
    expect(items.map((i) => i.id)).toEqual(["node", "app", "port", "claude_home", "claude_cli", "plugin", "managed", "proxy", "hooks", "statusline"]);
    expect(items.find((i) => i.id === "port")!.status).toBe("warn"); // 4399에는 아무것도 없다
    expect(code).toBe(items.some((i) => i.status === "fail") ? 1 : 0);
    expect(logFiles).toEqual([]); // doctor는 서버 로그를 쓰지 않는다
  }, 20_000);

  it("포트가 이미 사용 중이면 안내 후 종료 코드 1", async () => {
    const blocker = createServer().listen(0, "127.0.0.1");
    await new Promise((r) => blocker.once("listening", r));
    const port = (blocker.address() as { port: number }).port;
    // 저장소 .logs/에 시험 산출물을 남기지 않도록 임시 로그 폴더를 준다
    const logDir = mkdtempSync(join(tmpdir(), "office-cli-log-"));
    const child = spawn(join("node_modules", ".bin", "tsx"), ["server/index.ts", "--port", String(port), "--claude-home", tmpdir(), "--log-dir", logDir], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const code = await new Promise<number | null>((r) => child.on("exit", r));
    blocker.close();
    expect(code).toBe(1);
    expect(stderr).toContain("이미 사용 중");
    const log = readFileSync(join(logDir, readdirSync(logDir)[0]), "utf8");
    rmSync(logDir, { recursive: true, force: true });
    expect(log).toContain('"msg":"port in use"');
    expect(log).toContain('"msg":"exit"');
  });
});
