import { describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseCliArgs, tokenUrlLine } from "../../server/index";

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

  it("토큰 주소 줄은 개발 모드에서만 만든다(Ruling B33)", () => {
    const t = "a".repeat(64);
    expect(tokenUrlLine("dev", 4319, t)).toContain(`http://127.0.0.1:4319/?k=${t}`);
    expect(tokenUrlLine("installed", 4317, t)).toBeNull();
  });

  it("--log-dir는 홈을 전개해 logDir로 들어오고, 없으면 undefined", () => {
    expect(parseCliArgs(["--log-dir", "~/x"], {})).toMatchObject({ logDir: join(homedir(), "x") });
    expect(parseCliArgs([], {}).logDir).toBeUndefined();
  });
});

/** 비어 있는 포트 번호(잠깐 열었다 닫는다) */
async function freePort(): Promise<number> {
  const s = createServer().listen(0, "127.0.0.1");
  await new Promise((r) => s.once("listening", r));
  const port = (s.address() as { port: number }).port;
  await new Promise((r) => s.close(r));
  return port;
}

function run(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(join("node_modules", ".bin", "tsx"), ["server/index.ts", ...args], { stdio: ["ignore", "pipe", "pipe"], env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  // "exit"은 자식이 끝난 순간이고 파이프에 남은 출력은 그 뒤에 올 수 있다. 출력을 다 읽은 뒤인 "close"를 기다린다
  return new Promise((r) => child.on("close", (code) => r({ code, stdout, stderr })));
}

describe("CLI", () => {
  it("doctor: 데이터 폴더가 없으면 fail이고 종료 코드 1", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "office-doctor-log-"));
    const r = await run(["doctor", "--json", "--claude-home", join(logDir, "no-such-home"), "--port", String(await freePort()), "--log-dir", logDir]);
    rmSync(logDir, { recursive: true, force: true });
    const items = JSON.parse(r.stdout) as Array<{ id: string; status: string }>;
    expect(items.find((i) => i.id === "claude_home")!.status).toBe("fail");
    expect(r.code).toBe(1);
  }, 20_000);

  it("diag: 서버가 꺼져 있으면 직접 만들어 prefix/diagnostics에 쓰고 전체 경로를 출력한다", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "office-diag-prefix-"));
    const home = mkdtempSync(join(tmpdir(), "office-diag-home-"));
    const r = await run(["diag", "--claude-home", home, "--port", String(await freePort())], { ...process.env, CLAUDE_OFFICE_PREFIX: prefix });
    const files = readdirSync(join(prefix, "diagnostics"));
    const body = JSON.parse(readFileSync(join(prefix, "diagnostics", files[0]), "utf8"));
    rmSync(prefix, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    expect(r.code).toBe(0);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^claude-office-diag-\d{8}-\d{6}\.json$/);
    expect(r.stdout).toContain(files[0]);
    expect(body).toMatchObject({ kind: "claude-office-diag", snapshot: { sessions: 0 } });
    expect(body.doctor).toHaveLength(12);
  }, 30_000);

  it("doctor --json은 서버를 켜지 않고 12개 항목을 JSON으로 내고, fail이 있으면 종료 코드 1", async () => {
    const home = mkdtempSync(join(tmpdir(), "office-doctor-home-"));
    const logDir = mkdtempSync(join(tmpdir(), "office-doctor-log-"));
    const child = spawn(join("node_modules", ".bin", "tsx"), ["server/index.ts", "doctor", "--json", "--claude-home", home, "--port", String(await freePort()), "--log-dir", logDir], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    const code = await new Promise<number | null>((r) => child.on("close", r)); // 출력을 다 읽은 뒤("exit"은 더 이를 수 있다)
    const items = JSON.parse(stdout) as Array<{ id: string; status: string }>;
    const logFiles = readdirSync(logDir);
    rmSync(home, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
    expect(items.map((i) => i.id)).toEqual(["node", "app", "port", "claude_home", "claude_cli", "plugin", "token", "hook_timeout", "managed", "proxy", "hooks", "statusline"]);
    expect(items.find((i) => i.id === "port")!.status).toBe("warn"); // 빈 포트라 서버가 꺼져 있다
    expect(code).toBe(items.some((i) => i.status === "fail") ? 1 : 0);
    expect(logFiles).toEqual([]); // doctor는 서버 로그를 쓰지 않는다
  }, 20_000);

  it("포트가 이미 사용 중이면 안내 후 종료 코드 1", async () => {
    const blocker = createServer().listen(0, "127.0.0.1");
    await new Promise((r) => blocker.once("listening", r));
    const port = (blocker.address() as { port: number }).port;
    // 저장소 .logs/에 시험 산출물을 남기지 않도록 임시 로그 폴더를 준다
    const logDir = mkdtempSync(join(tmpdir(), "office-cli-log-"));
    // OS 임시 폴더 전체를 데이터 폴더로 주면 서버가 켜지기 전에 그 전체를 감시·수집해 부하 때 느려진다. 빈 폴더를 준다
    const home = mkdtempSync(join(tmpdir(), "office-cli-home-"));
    // 개발 모드로 켜면 서버가 저장소 .logs/token을 만든다(Task 4). 임시 prefix로 설치본 모드로 켠다
    const prefix = mkdtempSync(join(tmpdir(), "office-cli-prefix-"));
    const child = spawn(join("node_modules", ".bin", "tsx"), ["server/index.ts", "--port", String(port), "--claude-home", home, "--log-dir", logDir], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CLAUDE_OFFICE_PREFIX: prefix } });
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.stdout.on("data", (d) => (stdout += d));
    const code = await new Promise<number | null>((r) => child.on("close", r)); // 출력을 다 읽은 뒤("exit"은 더 이를 수 있다)
    blocker.close();
    expect(code).toBe(1);
    expect(stderr).toContain(`포트 ${port}번이 이미 사용 중입니다. --port 로 다른 포트를 지정하세요.`);
    // 실패했는데 "켜졌다" 줄이 먼저 찍히면 고객이 성공으로 오해한다(Express 5는 listen 실패에도 콜백을 부른다)
    expect(stdout).not.toContain("Claude Agent Office: http");
    const log = readFileSync(join(logDir, readdirSync(logDir)[0]), "utf8");
    rmSync(logDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(prefix, { recursive: true, force: true });
    expect(log).toContain('"msg":"port in use"');
    expect(log).toContain('"msg":"exit"');
  }, 20_000); // 다른 CLI 테스트와 같게. 전체 테스트 부하에서는 tsx 시작만 몇 초 걸릴 수 있다

  it("서버를 켜면 토큰 파일이 생기고, 쿠키 없는 /api/snapshot은 401, doctor는 포트를 \"이 프로그램\"으로 본다", async () => {
    const s = await startServer();
    try {
      const token = readFileSync(join(s.prefix, "token"), "utf8").trim();
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      if (process.platform !== "win32") expect(statSync(join(s.prefix, "token")).mode & 0o777).toBe(0o600);
      const r = await fetch(`http://127.0.0.1:${s.port}/api/snapshot`);
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: "unauthorized", app: "claude-office" });
      expect((await fetch(`http://127.0.0.1:${s.port}/api/snapshot`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
      // doctor는 토큰 파일을 읽어 Bearer로 묻는다. 4317이 아니므로 "켜져 있지만 플러그인은 4317로" 안내 = 이 프로그램으로 인식
      const d = await run(["doctor", "--json", "--claude-home", s.home, "--port", String(s.port)], s.env);
      const port = (JSON.parse(d.stdout) as Array<{ id: string; detail: string }>).find((i) => i.id === "port")!;
      expect(port.detail).toBe(`서버가 ${s.port}에서 켜져 있지만 플러그인은 4317로 보냅니다`);
      // diag는 켜진 서버에게 만들게 한다(Bearer + Origin 없음, Ruling B32)
      const g = await run(["diag", "--claude-home", s.home, "--port", String(s.port)], s.env);
      expect(g.code).toBe(0);
      expect(readdirSync(join(s.prefix, "diagnostics"))).toHaveLength(1);
      for (const out of [d.stdout, d.stderr, g.stdout, g.stderr]) expect(out).not.toContain(token);
    } finally {
      await s.stop();
    }
  }, 40_000);

  it("포트에 다른 프로그램(가짜 http 서버)이 있으면 doctor·diag가 Authorization을 보내지 않는다(Ruling B52)", async () => {
    const { createServer: createHttp } = await import("node:http");
    const seen: Array<string | undefined> = [];
    const fake = createHttp((req, res) => {
      seen.push(req.headers.authorization);
      res.writeHead(200, { "Content-Type": "text/html" }).end("<!doctype html>");
    }).listen(0, "127.0.0.1");
    await new Promise((r) => fake.once("listening", r));
    const port = (fake.address() as { port: number }).port;
    const prefix = mkdtempSync(join(tmpdir(), "office-b52-prefix-"));
    const home = mkdtempSync(join(tmpdir(), "office-b52-home-"));
    writeFileSync(join(prefix, "token"), "c".repeat(64), { mode: 0o600 });
    const env = { ...process.env, CLAUDE_OFFICE_PREFIX: prefix };
    try {
      await run(["doctor", "--json", "--claude-home", home, "--port", String(port)], env);
      const g = await run(["diag", "--claude-home", home, "--port", String(port)], env);
      expect(g.code).toBe(0); // 서버가 우리 것이 아니므로 직접 만든다
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((a) => a === undefined)).toBe(true);
    } finally {
      fake.close();
      rmSync(prefix, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }, 40_000);

  it("서버가 켜져 있으면 doctor·diag가 Bearer로 서버 통계를 읽는다(긍정 경로, Ruling B52)", async () => {
    const s = await startServer();
    try {
      const { request } = await import("node:http");
      const hookPost = (body: object) =>
        new Promise<void>((resolve) => {
          const r = request({ host: "127.0.0.1", port: s.port, path: "/hooks/event", method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
            res.resume();
            res.on("end", resolve);
          });
          r.on("error", () => resolve());
          r.end(JSON.stringify(body));
          // PermissionRequest는 서버가 붙잡는다 — 잠시 뒤 끊어 closed-terminal로 만든다
          if ((body as { hook_event_name: string }).hook_event_name === "PermissionRequest") setTimeout(() => (r.destroy(), resolve()), 300);
        });
      await hookPost({ hook_event_name: "Stop", session_id: "s-fake" });
      await hookPost({ hook_event_name: "PermissionRequest", session_id: "s-fake", tool_name: "Bash", tool_input: { command: "echo fake" } });
      await new Promise((r) => setTimeout(r, 200));

      const d = await run(["doctor", "--json", "--claude-home", s.home, "--port", String(s.port)], s.env);
      const hooks = (JSON.parse(d.stdout) as Array<{ id: string; status: string; detail: string }>).find((i) => i.id === "hooks")!;
      expect(hooks.detail).not.toContain("확인하지 못했습니다"); // 401이면 서버 통계를 못 읽어 이 문구가 된다
      expect(hooks.detail).toMatch(/^최근 10분 \d+건$/);

      const g = await run(["diag", "--claude-home", s.home, "--port", String(s.port)], s.env);
      expect(g.code).toBe(0);
      const [file] = readdirSync(join(s.prefix, "diagnostics"));
      const bundle = JSON.parse(readFileSync(join(s.prefix, "diagnostics", file), "utf8")) as { hooks: { total: number }; decisions: { byKind: Record<string, number>; byState: Record<string, number> } };
      expect(bundle.hooks.total).toBeGreaterThanOrEqual(2); // CLI가 직접 만들면 0이다
      expect(bundle.decisions.byKind.permission).toBe(1);
      expect(bundle.decisions.byState["closed-terminal"]).toBe(1);
    } finally {
      await s.stop();
    }
  }, 40_000);

  it("예산 배선: Bearer로 PUT /api/budget(기본값)이면 204이고 prefix의 state.json에 저장된다", async () => {
    const s = await startServer();
    try {
      const token = readFileSync(join(s.prefix, "token"), "utf8").trim();
      const r = await fetch(`http://127.0.0.1:${s.port}/api/budget`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ budgetTokens: 5000 }),
      });
      expect(r.status).toBe(204);
      const state = JSON.parse(readFileSync(join(s.prefix, "state.json"), "utf8")) as { defaultBudgetTokens?: number };
      expect(state.defaultBudgetTokens).toBe(5000);
      if (process.platform !== "win32") expect(statSync(join(s.prefix, "state.json")).mode & 0o777).toBe(0o600);
    } finally {
      await s.stop();
    }
  }, 30_000);

  it("같은 포트에 우리 서버가 있으면 안내 뒤 종료 코드 0(Ruling B42)", async () => {
    const s = await startServer();
    try {
      const logDir = mkdtempSync(join(tmpdir(), "office-b42-log-"));
      const r = await run(["--port", String(s.port), "--claude-home", s.home, "--log-dir", logDir], s.env);
      rmSync(logDir, { recursive: true, force: true });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("이미 켜져 있습니다. 브라우저에서 대시보드를 다시 열었습니다.");
      expect(r.stderr).not.toContain("이미 사용 중입니다");
    } finally {
      await s.stop();
    }
  }, 40_000);

  it("다른 프로그램(http)이 포트를 쓰면 기존 안내와 종료 코드 1", async () => {
    const { createServer: createHttp } = await import("node:http");
    const other = createHttp((_req, res) => void res.writeHead(200, { "Content-Type": "text/html" }).end("<!doctype html>")).listen(0, "127.0.0.1");
    await new Promise((r) => other.once("listening", r));
    const port = (other.address() as { port: number }).port;
    const prefix = mkdtempSync(join(tmpdir(), "office-b42-prefix-"));
    const home = mkdtempSync(join(tmpdir(), "office-b42-home-"));
    const logDir = mkdtempSync(join(tmpdir(), "office-b42-log-"));
    try {
      const r = await run(["--port", String(port), "--claude-home", home, "--log-dir", logDir], { ...process.env, CLAUDE_OFFICE_PREFIX: prefix });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`포트 ${port}번이 이미 사용 중입니다. --port 로 다른 포트를 지정하세요.`);
      expect(r.stdout).not.toContain("이미 켜져 있습니다");
    } finally {
      other.close();
      for (const d of [prefix, home, logDir]) rmSync(d, { recursive: true, force: true });
    }
  }, 30_000);

  it("설치본 모드에서는 콘솔에 토큰이 나오지 않는다", async () => {
    const s = await startServer();
    try {
      const token = readFileSync(join(s.prefix, "token"), "utf8").trim();
      expect(s.stdout()).toContain(`http://127.0.0.1:${s.port}`);
      expect(s.stdout()).not.toContain(token);
      expect(s.stdout()).not.toContain("?k=");
      const logs = readdirSync(s.logDir).map((f) => readFileSync(join(s.logDir, f), "utf8")).join("");
      expect(logs).not.toContain(token);
    } finally {
      await s.stop();
    }
  }, 30_000);
});

/** 임시 prefix(설치본 모드)·로그·데이터 폴더로 빈 포트에 서버를 켜고 "켜졌다" 줄까지 기다린다 */
async function startServer() {
  const prefix = mkdtempSync(join(tmpdir(), "office-auth-prefix-"));
  const home = mkdtempSync(join(tmpdir(), "office-auth-home-"));
  const logDir = mkdtempSync(join(tmpdir(), "office-auth-log-"));
  const port = await freePort();
  const env = { ...process.env, CLAUDE_OFFICE_PREFIX: prefix };
  const child: ChildProcess = spawn(join("node_modules", ".bin", "tsx"), ["server/index.ts", "--port", String(port), "--claude-home", home, "--log-dir", logDir], { stdio: ["ignore", "pipe", "pipe"], env });
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`서버가 켜지지 않았습니다: ${out}`)), 20_000);
    child.stdout!.on("data", () => out.includes("Claude Agent Office: http") && (clearTimeout(t), resolve()));
    child.on("close", () => (clearTimeout(t), reject(new Error("서버가 끝났습니다"))));
  });
  return {
    prefix, home, logDir, port, env,
    stdout: () => out,
    stop: async () => {
      const closed = new Promise((r) => child.once("close", r));
      child.kill("SIGTERM");
      await closed;
      for (const d of [prefix, home, logDir]) rmSync(d, { recursive: true, force: true });
    },
  };
}
