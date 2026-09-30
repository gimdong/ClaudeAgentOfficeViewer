import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
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
});

describe("CLI", () => {
  it("포트가 이미 사용 중이면 안내 후 종료 코드 1", async () => {
    const blocker = createServer().listen(0, "127.0.0.1");
    await new Promise((r) => blocker.once("listening", r));
    const port = (blocker.address() as { port: number }).port;
    const child = spawn(join("node_modules", ".bin", "tsx"), ["server/index.ts", "--port", String(port), "--claude-home", tmpdir()], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const code = await new Promise<number | null>((r) => child.on("exit", r));
    blocker.close();
    expect(code).toBe(1);
    expect(stderr).toContain("이미 사용 중");
  });
});
