import { describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseCliArgs, portInUseOutcome, tokenUrlLine } from "../../server/index";

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

  it("포트가 이미 쓰일 때의 안내와 종료 코드(Ruling B42·B64)", () => {
    expect(portInUseOutcome("phase2", "installed", 4317)).toEqual({ code: 0, out: "이미 켜져 있습니다. 브라우저에서 대시보드를 다시 열었습니다. 이 창은 닫아도 대시보드가 꺼지지 않습니다." });
    expect(portInUseOutcome("phase2", "dev", 4319)).toEqual({ code: 0, out: "이미 켜져 있습니다." });
    const beta = portInUseOutcome("beta", "installed", 4317) as { code: 1; err: string };
    expect(beta.code).toBe(1);
    expect(beta.err.startsWith("이전 버전 대시보드가 켜져 있습니다. 그 대시보드를 켠 터미널 창에서 Ctrl+C를 누르거나 그 창을 닫은 뒤, claude-office를 다시 실행해 주세요.")).toBe(true);
    expect(portInUseOutcome("other", "dev", 4319)).toEqual({ code: 1, err: "포트 4319번이 이미 사용 중입니다. --port 로 다른 포트를 지정하세요." });
  });

  it("FB-8: 버전이 다른 Phase 2 계열 서버는 \"이전 버전\" 안내(버전 표시)와 창이 없을 때의 안내, 종료 코드 1", () => {
    const o = portInUseOutcome("phase2-old", "installed", 4317, "2.0.0-beta.4");
    expect(o.code).toBe(1);
    const err = (o as { err: string }).err;
    expect(err.startsWith("이전 버전 대시보드(2.0.0-beta.4)가 켜져 있습니다. 그 대시보드를 켠 터미널 창에서 Ctrl+C를 누르거나 그 창을 닫은 뒤, claude-office를 다시 실행해 주세요.")).toBe(true);
    expect(err).toContain("창이 보이지 않으면");
    // 버전을 모르면(beta.4 이전 Phase 2 서버의 401에는 버전이 없음) 괄호 없이
    expect((portInUseOutcome("phase2-old", "installed", 4317) as { err: string }).err.startsWith("이전 버전 대시보드가 켜져 있습니다.")).toBe(true);
    // 옛 베타(인증 없음) 문구에도 같은 "창이 없을 때" 안내가 붙는다
    expect((portInUseOutcome("beta", "installed", 4317) as { err: string }).err).toContain("창이 보이지 않으면");
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
      expect(await r.json()).toEqual({ error: "unauthorized", app: "claude-office", version: expect.stringMatching(/^\d+\.\d+\.\d+/) }); // FB-8: 실제 서버는 자기 버전을 싣는다
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

  it("진단 배선: 서버가 만든 진단 파일의 policy는 저장한 대상 수와 켠 뒤로의 판정 수다", async () => {
    const s = await startServer();
    try {
      const token = readFileSync(join(s.prefix, "token"), "utf8").trim();
      for (const [target, rules] of [["lead", { bash: "deny" }], [encodeURIComponent("agent:rev"), { edit: "ask" }]] as const) {
        const r = await fetch(`http://127.0.0.1:${s.port}/api/policy/targets/${target}`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ rules }),
        });
        expect(r.status).toBe(200);
      }
      const pre = await fetch(`http://127.0.0.1:${s.port}/hooks/event`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s-fake", tool_name: "Bash", tool_input: { command: "echo fake" } }),
      });
      expect(JSON.stringify(await pre.json())).toContain('"permissionDecision":"deny"');
      const g = await run(["diag", "--claude-home", s.home, "--port", String(s.port)], s.env);
      expect(g.code).toBe(0);
      const [file] = readdirSync(join(s.prefix, "diagnostics"));
      const bundle = JSON.parse(readFileSync(join(s.prefix, "diagnostics", file), "utf8")) as { policy: unknown };
      expect(bundle.policy).toEqual({ targets: 2, rulesByKind: { lead: 1, agent: 1, sub: 0, others: 0 }, decisions: { deny: 1, ask: 0 } });
    } finally {
      await s.stop();
    }
  }, 40_000);

  it("진단 배선: 서버가 만든 진단 파일의 floors는 층 관리 상태의 수다(Phase 4a)", async () => {
    const s = await startServer();
    try {
      // 살아 있는 가짜 세션(이 테스트 프로세스의 pid, procStart 없음 — 신호는 보내지 않는다)
      mkdirSync(join(s.home, "sessions"), { recursive: true });
      writeFileSync(join(s.home, "sessions", "1.json"), JSON.stringify({ pid: process.pid, sessionId: "fake-floor", name: "f", cwd: "/x", status: "idle", startedAt: Date.now() - 1000, updatedAt: Date.now() }));
      const token = readFileSync(join(s.prefix, "token"), "utf8").trim();
      const pause = async () => (await fetch(`http://127.0.0.1:${s.port}/api/floors/fake-floor/pause`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" })).status;
      const end = Date.now() + 10_000;
      let st = await pause();
      while (st !== 200 && Date.now() < end) {
        await new Promise((r) => setTimeout(r, 300)); // 스냅샷이 세션 레코드를 읽을 때까지
        st = await pause();
      }
      expect(st).toBe(200);
      const g = await run(["diag", "--claude-home", s.home, "--port", String(s.port)], s.env);
      expect(g.code).toBe(0);
      const [file] = readdirSync(join(s.prefix, "diagnostics"));
      const bundle = JSON.parse(readFileSync(join(s.prefix, "diagnostics", file), "utf8")) as { floors: unknown };
      expect(bundle.floors).toEqual({ paused: 1, hidden: 0, terminating: 0 });
    } finally {
      await s.stop();
    }
  }, 40_000);

  it("진단 배선: 서버 없이 만들면 policy는 파일에서 읽은 대상 수이고 판정 수는 0이다", async () => {
    const prefix = mkdtempSync(join(tmpdir(), "office-diag-prefix-"));
    const home = mkdtempSync(join(tmpdir(), "office-diag-home-"));
    writeFileSync(join(prefix, "policy.json"), JSON.stringify({ version: 1, targets: { others: { all: "deny" }, "sub:Explore": { edit: "deny", bash: "deny" } } }));
    const r = await run(["diag", "--claude-home", home, "--port", String(await freePort())], { ...process.env, CLAUDE_OFFICE_PREFIX: prefix });
    const [file] = readdirSync(join(prefix, "diagnostics"));
    const body = JSON.parse(readFileSync(join(prefix, "diagnostics", file), "utf8")) as { policy: unknown };
    const policyText = readFileSync(join(prefix, "policy.json"), "utf8");
    rmSync(prefix, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    expect(r.code).toBe(0);
    expect(body.policy).toEqual({ targets: 2, rulesByKind: { lead: 0, agent: 0, sub: 2, others: 1 }, decisions: { deny: 0, ask: 0 } });
    expect(policyText.includes("Explore")).toBe(true); // 읽기만 했다(파일 그대로)
  }, 30_000);

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
      // 설치본(임시 PREFIX) 문구(Ruling B64): 런처의 "이 창을 닫으면 대시보드가 꺼집니다."를 바로잡는다
      expect(r.stdout.trim().split("\n").at(-1)).toBe("이미 켜져 있습니다. 브라우저에서 대시보드를 다시 열었습니다. 이 창은 닫아도 대시보드가 꺼지지 않습니다.");
      expect(r.stderr).not.toContain("이미 사용 중입니다");
    } finally {
      await s.stop();
    }
  }, 40_000);

  it("인증 없는 옛 베타 서버가 포트를 쓰면 \"이전 버전\" 안내와 종료 코드 1(Ruling B64)", async () => {
    const { createServer: createHttp } = await import("node:http");
    // 베타(beta.1·2) 서버 흉내: 토큰 없이도 /api/snapshot 200, 진단 API 있음
    const beta = createHttp((req, res) => {
      const body = req.url === "/api/snapshot" ? { generatedAt: "2026-10-02T00:00:00.000Z", sessions: [] } : req.url === "/api/diagnostics" ? { doctor: [] } : null;
      if (!body) return void res.writeHead(404).end();
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    }).listen(0, "127.0.0.1");
    await new Promise((r) => beta.once("listening", r));
    const port = (beta.address() as { port: number }).port;
    const prefix = mkdtempSync(join(tmpdir(), "office-b64-prefix-"));
    const home = mkdtempSync(join(tmpdir(), "office-b64-home-"));
    const logDir = mkdtempSync(join(tmpdir(), "office-b64-log-"));
    try {
      const r = await run(["--port", String(port), "--claude-home", home, "--log-dir", logDir], { ...process.env, CLAUDE_OFFICE_PREFIX: prefix });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("이전 버전 대시보드가 켜져 있습니다. 그 대시보드를 켠 터미널 창에서 Ctrl+C를 누르거나 그 창을 닫은 뒤, claude-office를 다시 실행해 주세요.");
      expect(r.stdout).not.toContain("이미 켜져 있습니다");
    } finally {
      beta.close();
      for (const d of [prefix, home, logDir]) rmSync(d, { recursive: true, force: true });
    }
  }, 30_000);

  it("FB-8: 버전이 다른 Phase 2 계열 서버(401 + app, 다른 version)가 포트를 쓰면 \"이전 버전\" 안내와 종료 코드 1", async () => {
    const { createServer: createHttp } = await import("node:http");
    const old = createHttp((_req, res) => void res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "unauthorized", app: "claude-office", version: "0.0.1-old" }))).listen(0, "127.0.0.1");
    await new Promise((r) => old.once("listening", r));
    const port = (old.address() as { port: number }).port;
    const prefix = mkdtempSync(join(tmpdir(), "office-fb8-prefix-"));
    const home = mkdtempSync(join(tmpdir(), "office-fb8-home-"));
    const logDir = mkdtempSync(join(tmpdir(), "office-fb8-log-"));
    try {
      const r = await run(["--port", String(port), "--claude-home", home, "--log-dir", logDir], { ...process.env, CLAUDE_OFFICE_PREFIX: prefix });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("이전 버전 대시보드(0.0.1-old)가 켜져 있습니다.");
      expect(r.stdout).not.toContain("이미 켜져 있습니다");
    } finally {
      old.close();
      for (const d of [prefix, home, logDir]) rmSync(d, { recursive: true, force: true });
    }
  }, 30_000);

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
