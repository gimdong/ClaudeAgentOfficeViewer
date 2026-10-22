import { beforeAll, describe, expect, inject, it } from "vitest";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 이 파일의 모든 케이스는 HOME=<mkdtemp>, --no-open을 쓴다(팀 규칙 — 이 Mac 사용자의 ~/.zshrc·~/.claude는
// 절대 건드리지 않는다). 가짜 claude는 stub-bin/claude 셸 스크립트로 인자를 STUB_LOG에 기록만 한다.
// 4317·4318은 쓰지 않는다 — 서버를 띄우는 테스트는 항상 빈 포트를 직접 골라 --port로 준다.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const VERSION = pkg.version as string;
// PATH에 node의 실제 bin 폴더 전체를 넣으면, node와 claude가 같은 폴더에 깔린 PC(예: npm -g로
// claude CLI를 설치한 경우)에서는 "claude 없음" 시나리오가 진짜 claude를 찾아 실행해 버릴 수 있다
// (리뷰어 지적 — Minor, 안전). node 심볼릭 링크 하나만 있는 전용 폴더를 만들어 그 폴더만 PATH에
// 넣는다 — 다른 실행 파일이 전혀 없으니 가짜 claude를 뒀을 때만 claude가 "있다".
// Phase 6a 고객 문구(qa 검토 글자)
const HOOKS_FAIL = "플러그인 hook 설정(node·열쇠 경로)을 쓰지 못해 설치를 멈춥니다 — 사용설명서 6장(문제가 생겼을 때)을 봐 주세요.";
const PORT_BAD = "--port에는 1~65535 숫자가 필요합니다. 예: --port 4321";
const URL_NO_TOKEN = "대시보드 열쇠 파일이 없습니다 — claude-office를 한 번 켜면 만들어집니다.";
const NODE_ONLY_DIR = mkdtempSync(join(tmpdir(), "claude-office-installtest-node-only-"));
symlinkSync(process.execPath, join(NODE_ONLY_DIR, "node"));

let buildError: Error | undefined;
let releaseAppDir: string; // .tar.gz를 풀어 만든 실제 배포물 폴더(app/plugin/install.sh/claude-office.sh가 이 안에 있음) — T6 규칙대로 release/app을 직접 쓰지 않는다.

// 빌드(npm run package:beta)는 vitest globalSetup(test/setup/package-once.ts)에서 전체 실행에
// 한 번만 돈다(director #79 — package.test.ts와 여기서 각자 beforeAll에 따로 돌리면 둘이 동시에
// release/ 산출물을 지우고 다시 써서 간헐적으로 깨진다, B14). 여기서는 이미 만들어진 tar.gz를
// 내 전용 임시 폴더에 풀기만 한다.
beforeAll(() => {
  // #87(리뷰어 지적): release/에 tar.gz가 "있기만" 한 걸로는 안 된다 — 파일 경로 없이 -t만으로
  // 걸러서 globalSetup이 빌드를 건너뛴 경우, 예전 버전 결과물로 조용히 통과해 버릴 수 있다.
  // globalSetup이 이번 실행에서 실제로 빌드를 끝냈을 때만 provide한 타임스탬프로 확인한다.
  if (inject("packageBuiltAt") == null) {
    buildError = new Error("이번 실행에서 package:beta가 빌드되지 않았습니다 — CLAUDE_OFFICE_FORCE_PACKAGE_BUILD=1로 다시 실행해 주세요.");
    return;
  }
  try {
    const extracted = mkdtempSync(join(tmpdir(), "claude-office-installtest-pkg-"));
    execFileSync("tar", ["-xzf", join(ROOT, "release", `claude-office-${VERSION}.tar.gz`), "-C", extracted]);
    releaseAppDir = join(extracted, `claude-office-${VERSION}`);
  } catch (e) {
    buildError = e as Error;
  }
}, 120_000);

function requireBuildOk() {
  if (buildError) throw new Error(buildError.message);
}

function getFreePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      srv.close(() => (port ? resolvePromise(port) : reject(new Error("빈 포트를 못 얻음"))));
    });
  });
}

// B14(director #113): child.kill() 직후 바로 rig.cleanup()(rmSync)을 부르면, 서버가 종료 로그를
// 아직 쓰는 중이라(서버는 종료할 때 exit 로그를 쓴다) 그 로그 파일이 들어있는 폴더를 지우다
// ENOTEMPTY로 간헐 실패할 수 있다(package.test.ts에서 리뷰어 실측). kill 신호를 보낸 뒤 "exit"
// 이벤트까지 기다리고 나서 정리한다. 정해진 시간 안에 안 끝나면 SIGKILL로 강제 종료한다.
function killAndWait(child: ChildProcess, timeoutMs = 3000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const t = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("exit", () => {
      clearTimeout(t);
      resolvePromise();
    });
    child.kill();
  });
}

interface Rig {
  home: string;
  stubBin: string;
  stubLog: string;
  /** node 래퍼가 doctor·diag를 돌린 포트(B109) — 4317(사용자 대시보드)이 아닌 빈 포트 */
  doctorPort: number;
  /** node 래퍼가 포트를 붙인 호출의 기록 */
  wrapLog: string;
  cleanup: () => void;
}

/** 지금 빈 포트 하나(동기). makeRig가 동기라 자식 node로 listen(0)을 한 번 한다 */
function freePortSync(): number {
  const r = spawnSync(process.execPath, ["-e", 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})'], { encoding: "utf8" });
  const port = Number(r.stdout);
  if (!Number.isInteger(port) || port <= 0) throw new Error("빈 포트를 못 얻음");
  return port;
}

/** 임시 HOME·stub-bin·STUB_LOG를 만든다. claude가 false면 stub-bin에 claude를 안 둔다("claude 없음" 시나리오). */
function makeRig(opts: { claude?: boolean } = {}): Rig {
  const base = mkdtempSync(join(tmpdir(), "claude-office-installtest-"));
  const home = join(base, "home");
  const stubBin = join(base, "stub-bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(stubBin, { recursive: true });
  if (opts.claude !== false) {
    writeFileSync(join(stubBin, "claude"), '#!/bin/sh\necho "$@" >> "$STUB_LOG"\n');
    chmodSync(join(stubBin, "claude"), 0o755);
  }
  const stubLog = join(base, "stub.log");
  writeFileSync(stubLog, "");
  // B109: 진짜 install.sh·런처는 끝에서 doctor를 기본 포트 4317로 돌린다. 이 Mac 사용자의 대시보드가 켜져 있으면
  // 테스트마다 읽기 요청이 간다. PATH 맨 앞의 node 래퍼가 --port 없는 doctor·diag에 rig의 빈 포트를 붙인다
  // (그 밖의 호출은 진짜 node로 그대로). fakeNode를 쓰는 테스트는 이 래퍼를 덮어쓴다
  const doctorPort = freePortSync();
  const wrapLog = join(base, "node-wrap.log");
  writeFileSync(
    join(stubBin, "node"),
    `#!/bin/sh\ncase " $* " in\n  *" --port "*) ;;\n  *" doctor "*|*" diag "*) echo "port ${doctorPort} $*" >> "${wrapLog}"; exec "${process.execPath}" "$@" --port ${doctorPort} ;;\nesac\nexec "${process.execPath}" "$@"\n`,
  );
  chmodSync(join(stubBin, "node"), 0o755);
  // maxRetries/retryDelay: 서버를 띄웠다 끈 테스트에서 아직 핸들이 덜 풀린 파일이 있어도(killAndWait로
  // "exit" 이벤트까지는 기다리지만, OS가 핸들을 완전히 닫는 데는 한 박자 더 걸릴 수 있다) 몇 번 재시도한다.
  return { home, stubBin, stubLog, doctorPort, wrapLog, cleanup: () => rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) };
}

function env(rig: Rig, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // LANG을 한국어 UTF-8로 고정한다 — 이 앱 사용자 다수가 이 로케일을 쓰고, 옛 bash(macOS 기본 /bin/sh는
  // bash 3.2)가 이 로케일에서 "$VAR가나다" 같은 표현을 변수 이름 경계를 잘못 잡아 파싱하는 문제가
  // 실제로 있었다(install.sh의 "$RC에" → "${RC}에"로 고친 회귀). 이 로케일로 고정해야 그 버그가
  // 재발하면 테스트가 다시 잡아낸다.
  return { HOME: rig.home, PATH: `${rig.stubBin}:${NODE_ONLY_DIR}:/usr/bin:/bin`, STUB_LOG: rig.stubLog, SHELL: "/bin/zsh", LANG: "ko_KR.UTF-8", ...extra };
}

function runInstall(args: string[], e: NodeJS.ProcessEnv) {
  return spawnSync("sh", [join(releaseAppDir, "install.sh"), ...args], { env: e, encoding: "utf8" });
}

function installLogLines(prefix: string): string[] {
  const dir = join(prefix, "logs");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith("install-")) : [];
  return files.flatMap((f) => readFileSync(join(dir, f), "utf8").trim().split("\n").filter(Boolean));
}

/**
 * 설치 로그 한 줄 형식(Ruling B10 보강, #36): "<ISO> <단계> ok|fail|skip( <메시지>)?". 경로("/"
 * 포함)가 있는 줄은 그 경로가 줄 끝 큰따옴표 안에 있어야 한다 — 안 그러면 진단 파일의 경로 가림이
 * 공백을 포함해 다음 "/"·따옴표·줄 끝까지를 통째로 삼켜 경로 뒤 설명까지 함께 가려진다. 따옴표
 * 앞부분(설명)에는 임시 HOME의 mkdtemp 고유 이름이 나오면 안 된다(비밀값·사용자 식별 정보 금지).
 */
function expectValidInstallLog(lines: string[], tempMarker: string) {
  // 시각은 로컬+오프셋(%z, 예: +0900)으로 바뀌어 자릿수가 고정이 아니다(director 지시 #52.h) — \S+로 느슨하게 받는다.
  const re = /^\S+ (node|copy|token|hookkey|hooks|path|plugin|statusline|doctor|done) (ok|fail|skip)( .*)?$/;
  for (const line of lines) {
    expect(line, line).toMatch(re);
    if (!line.includes("/")) continue;
    const m = /"([^"]*)"$/.exec(line);
    expect(m, `경로가 있는 줄은 줄 끝 큰따옴표 안에 있어야 함: ${line}`).toBeTruthy();
    expect(m![1]).toContain("/");
    expect(line.slice(0, line.length - m![0].length)).not.toContain(tempMarker);
  }
}

describe("packaging/install.sh, claude-office.sh", () => {
  it("bash -n과 sh -n 문법 검사 통과", () => {
    for (const bin of ["bash", "sh"]) {
      for (const file of ["packaging/install.sh", "packaging/claude-office.sh"]) {
        const r = spawnSync(bin, ["-n", join(ROOT, file)], { encoding: "utf8" });
        expect(r.status, `${bin} -n ${file}: ${r.stderr}`).toBe(0);
      }
    }
  });

  it("--no-path면 HOME의 셸 설정 파일을 만들지도 고치지도 않는다", () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      writeFileSync(join(rig.home, ".zshrc"), "# mine");
      const prefix = join(rig.home, ".claude-office");
      const r = runInstall(["--prefix", prefix, "--yes", "--no-path", "--no-open"], env(rig));
      expect(r.status, r.stderr).toBe(0);
      expect(readFileSync(join(rig.home, ".zshrc"), "utf8")).toBe("# mine");
      expect(existsSync(join(rig.home, ".bashrc"))).toBe(false);
      expect(existsSync(join(rig.home, ".profile"))).toBe(false);
    } finally {
      rig.cleanup();
    }
  });

  it("설치 결과 구조", () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      const prefix = join(rig.home, ".claude-office");
      const r = runInstall(["--prefix", prefix, "--yes", "--no-path", "--no-open"], env(rig));
      expect(r.status, r.stderr).toBe(0);
      expect(existsSync(join(prefix, "app/server.mjs"))).toBe(true);
      expect(existsSync(join(prefix, "app/app/server.mjs"))).toBe(false);
      expect(existsSync(join(prefix, "bin/claude-office"))).toBe(true);
      expect((statSync(join(prefix, "bin/claude-office")).mode & 0o111) !== 0).toBe(true);
      expect(existsSync(join(prefix, "logs"))).toBe(true);
      expect(existsSync(join(prefix, "diagnostics"))).toBe(true);

      // 설치 로그(SPEC 4장, Ruling B10/#36): <prefix>/logs/install-*.log에 평문 한 줄씩.
      const lines = installLogLines(prefix);
      expect(lines.length).toBeGreaterThan(0);
      expectValidInstallLog(lines, basename(dirname(rig.home)));
      const steps = lines.map((l) => l.split(" ")[1]);
      for (const step of ["node", "copy", "plugin", "done"]) expect(steps, lines.join("\n")).toContain(step);
      // B325: --yes만으로는 statusline을 켜지 않고, 묻지 않고 건너뛴 사실과 켜는 법을 한 줄로 알린다(qa #627 B)
      expect(r.stdout).toContain("statusline 연결은 묻지 않고 건너뛰었습니다. 켜려면 설치 스크립트를 --statusline을 붙여 다시 실행하세요.");
      expect(lines.find((l) => l.split(" ")[1] === "statusline")).toContain(" skip ");
      expect(existsSync(join(rig.home, ".claude", "settings.json"))).toBe(false);
      // 비밀값·환경변수 값은 안 남는다(경로는 됨) — STUB_LOG 값 같은 건 절대 안 보여야 한다.
      for (const line of lines) expect(line).not.toContain(rig.stubLog);
    } finally {
      rig.cleanup();
    }
  });

  it("재설치는 app만 바꾸고 logs·diagnostics는 남긴다", () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      const prefix = join(rig.home, ".claude-office");
      expect(runInstall(["--prefix", prefix, "--yes", "--no-path", "--no-open"], env(rig)).status).toBe(0);
      writeFileSync(join(prefix, "logs/keep-me.txt"), "x");
      writeFileSync(join(prefix, "app/should-vanish.txt"), "x");

      expect(runInstall(["--prefix", prefix, "--yes", "--no-path", "--no-open"], env(rig)).status).toBe(0);
      expect(existsSync(join(prefix, "logs/keep-me.txt"))).toBe(true);
      expect(existsSync(join(prefix, "app/should-vanish.txt"))).toBe(false);
      expect(existsSync(join(prefix, "app/server.mjs"))).toBe(true);
    } finally {
      rig.cleanup();
    }
  });

  it("--yes면 플러그인 설치를 claude CLI로 요청한다", () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      const prefix = join(rig.home, ".claude-office");
      const r = runInstall(["--prefix", prefix, "--yes", "--no-path", "--no-open"], env(rig, { CLAUDE_CONFIG_DIR: join(rig.home, "cc") }));
      expect(r.status, r.stderr).toBe(0);
      const log = readFileSync(rig.stubLog, "utf8").trim().split("\n");
      // install.sh가 이제 pwd -P로 정규화해서(T7 fix round 2) macOS의 /var -> /private/var 같은
      // 심볼릭 링크를 실제 물리 경로로 바꿔 쓴다 — mkdtemp가 돌려준 그대로가 아니라 realpath와 비교한다.
      const realPrefix = realpathSync(prefix);
      expect(log[0]).toBe(`plugin marketplace add ${realPrefix}/plugin`);
      expect(log[1]).toBe("plugin install claude-office@claude-office --scope user");
      // FB-4: 이미 설치된 플러그인은 install만으로는 등록(버전·경로)이 바뀌지 않는다 — update가 새로 적는다
      expect(log[2]).toBe("plugin update claude-office@claude-office --scope user");
    } finally {
      rig.cleanup();
    }
  });

  it("FB-4: plugin update가 실패해도(옛 Claude Code 등) 설치는 끝까지 가고 플러그인 단계는 ok로 남는다", () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      // update만 실패하는 가짜 claude
      writeFileSync(join(rig.stubBin, "claude"), '#!/bin/sh\necho "$@" >> "$STUB_LOG"\n[ "$2" = update ] && exit 1\nexit 0\n');
      chmodSync(join(rig.stubBin, "claude"), 0o755);
      const prefix = join(rig.home, ".claude-office");
      const r = runInstall(["--prefix", prefix, "--yes", "--no-path", "--no-open"], env(rig, { CLAUDE_CONFIG_DIR: join(rig.home, "cc") }));
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout + r.stderr).not.toContain("플러그인 설치 실패");
      expect(installLogLines(prefix).join("\n")).toContain("플러그인 설치 완료");
    } finally {
      rig.cleanup();
    }
  });

  it("claude가 없으면 플러그인 단계를 건너뛰고 안내만", () => {
    requireBuildOk();
    const rig = makeRig({ claude: false });
    try {
      const prefix = join(rig.home, ".claude-office");
      const r = runInstall(["--prefix", prefix, "--yes", "--no-path", "--no-open"], env(rig));
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("나중에");
    } finally {
      rig.cleanup();
    }
  });

  it("Node 24 미만이면 멈춘다", () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      const oldNodeDir = join(dirname(rig.stubBin), "old-node-bin");
      mkdirSync(oldNodeDir, { recursive: true });
      writeFileSync(join(oldNodeDir, "node"), '#!/bin/sh\necho "v22.0.0"\n');
      chmodSync(join(oldNodeDir, "node"), 0o755);
      const prefix = join(rig.home, ".claude-office");
      const r = runInstall(
        ["--prefix", prefix, "--yes", "--no-path", "--no-open"],
        { ...env(rig), PATH: `${oldNodeDir}:/usr/bin:/bin` },
      );
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("Node.js 24");
      expect(r.stderr).toContain("자세한 기록:");
      const lines = installLogLines(prefix);
      expect(lines.some((l) => l.includes(" node fail "))).toBe(true);
    } finally {
      rig.cleanup();
    }
  });

  it("PATH 단계(--no-path 없이, HOME 임시)", () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      const prefix = join(rig.home, ".claude-office");
      expect(runInstall(["--prefix", prefix, "--yes", "--no-open"], env(rig)).status).toBe(0);
      // pwd -P 정규화(T7 fix round 2) 때문에 rc에는 mkdtemp가 돌려준 경로가 아니라 실제 물리
      // 경로(macOS의 /var -> /private/var 등)가 적힌다 — install 뒤(prefix가 실제로 생긴 뒤)
      // realpath로 비교한다.
      const realPrefix = realpathSync(prefix);
      const rc1 = readFileSync(join(rig.home, ".zshrc"), "utf8");
      expect(rc1.split("\n").filter((l) => l === "# claude-office PATH")).toHaveLength(1);
      expect(rc1).toContain(`export PATH="${realPrefix}/bin:$PATH"`);
      expectValidInstallLog(installLogLines(prefix), basename(dirname(rig.home))); // path ok 줄에 실제 경로 포함(#36 형식 확인)

      expect(runInstall(["--prefix", prefix, "--yes", "--no-open"], env(rig)).status).toBe(0);
      const rc2 = readFileSync(join(rig.home, ".zshrc"), "utf8");
      expect(rc2.split("\n").filter((l) => l === "# claude-office PATH")).toHaveLength(1); // 두 번 설치해도 한 번만
    } finally {
      rig.cleanup();
    }
  });

  it("claude-office doctor --json이 JSON 배열", async () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      const prefix = join(rig.home, ".claude-office");
      expect(runInstall(["--prefix", prefix, "--yes", "--no-path", "--no-open"], env(rig)).status).toBe(0);
      const port = await getFreePort();
      const r = spawnSync(join(prefix, "bin/claude-office"), ["doctor", "--json", "--port", String(port)], { env: env(rig), encoding: "utf8" });
      const items = JSON.parse(r.stdout);
      expect(Array.isArray(items)).toBe(true);
      const node = items.find((i: { id: string }) => i.id === "node");
      expect(node.status).toBe("ok");
    } finally {
      rig.cleanup();
    }
  });

  it(
    "claude-office가 서버를 켜고 로그를 prefix/logs에 쓴다",
    async () => {
      requireBuildOk();
      const rig = makeRig();
      try {
        const prefix = join(rig.home, ".claude-office");
        expect(runInstall(["--prefix", prefix, "--yes", "--no-path", "--no-open"], env(rig)).status).toBe(0);
        const port = await getFreePort();
        const fakeClaudeHome = join(rig.home, "fake-claude-home");
        mkdirSync(fakeClaudeHome, { recursive: true });
        const child = spawn(join(prefix, "bin/claude-office"), ["--port", String(port), "--claude-home", fakeClaudeHome], {
          env: env(rig, { CLAUDE_OFFICE_NO_OPEN: "1" }),
        });
        try {
          await new Promise<void>((resolvePromise, reject) => {
            let out = "";
            const onData = (b: Buffer) => {
              out += b.toString();
              if (out.includes(`:${port}`)) resolvePromise();
            };
            child.stdout?.on("data", onData);
            child.stderr?.on("data", onData);
            child.on("exit", (code) => reject(new Error(`서버가 일찍 끝남(code ${code}): ${out}`)));
            setTimeout(() => reject(new Error(`서버 시작 시간초과: ${out}`)), 10_000);
          });
          const r = await fetch(`http://127.0.0.1:${port}/`);
          expect(r.status).toBe(200);
          const logFiles = readdirSync(join(prefix, "logs")).filter((f) => f.startsWith("office-"));
          expect(logFiles.length).toBeGreaterThan(0);
          const logText = readFileSync(join(prefix, "logs", logFiles[0]), "utf8");
          expect(logText).toContain('"msg":"start"');
        } finally {
          await killAndWait(child);
        }
      } finally {
        rig.cleanup();
      }
    },
    20_000,
  );

  it("uninstall --yes는 app·bin·plugin·rc 표지 줄을 지우고 logs·diagnostics도 지운다", () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      const prefix = join(rig.home, ".claude-office");
      expect(runInstall(["--prefix", prefix, "--yes", "--no-open"], env(rig)).status).toBe(0); // PATH 단계 포함(표지 줄 확인용)
      writeFileSync(join(rig.home, ".zshrc"), readFileSync(join(rig.home, ".zshrc"), "utf8") + "# mine\n");
      writeFileSync(rig.stubLog, ""); // install 중 쌓인 로그는 지우고 uninstall 것만 본다

      const r = spawnSync(join(prefix, "bin/claude-office"), ["uninstall", "--yes"], { env: env(rig), encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);

      const log = readFileSync(rig.stubLog, "utf8").trim().split("\n");
      expect(log).toContain("plugin uninstall claude-office@claude-office --scope user");
      expect(log).toContain("plugin marketplace remove claude-office");

      const rc = readFileSync(join(rig.home, ".zshrc"), "utf8");
      expect(rc).not.toContain("# claude-office PATH");
      expect(rc).not.toContain(`${prefix}/bin`);
      expect(rc).toContain("# mine");

      expect(existsSync(prefix)).toBe(false);
    } finally {
      rig.cleanup();
    }
  });

  // T7 fix round 1(배정 #58) — 리뷰어가 job tmp에서 실측 재현한 Critical: 런처가 $0의 심볼릭
  // 링크를 안 풀어 PREFIX가 엉뚱한 곳(예: /usr/local)이 되고, uninstall이 그 엉뚱한 곳을 지웠다.
  it("심볼릭 링크로 실행해도 uninstall이 실제 prefix만 지우고, 링크가 있던 폴더의 다른 파일은 남긴다(Critical)", () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      const prefix = join(rig.home, ".claude-office");
      expect(runInstall(["--prefix", prefix, "--yes", "--no-path", "--no-open"], env(rig)).status).toBe(0);

      const elsewhere = join(dirname(rig.home), "elsewhere");
      mkdirSync(elsewhere, { recursive: true });
      writeFileSync(join(elsewhere, "important.txt"), "DO NOT DELETE ME");
      symlinkSync(join(prefix, "bin/claude-office"), join(elsewhere, "claude-office"));

      const r = spawnSync(join(elsewhere, "claude-office"), ["uninstall", "--yes"], { env: env(rig), encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);

      expect(existsSync(prefix)).toBe(false); // 진짜 설치 폴더는 지워짐
      expect(readFileSync(join(elsewhere, "important.txt"), "utf8")).toBe("DO NOT DELETE ME"); // 링크가 있던 폴더는 안 건드림
    } finally {
      rig.cleanup();
    }
  });

  it("app/server.mjs·VERSION이 없는 폴더에서 uninstall하면 exit 1이고 아무것도 지우지 않는다(Critical)", () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      const bogus = join(rig.home, "bogus-prefix");
      mkdirSync(join(bogus, "bin"), { recursive: true });
      const launcher = join(bogus, "bin/claude-office");
      writeFileSync(launcher, readFileSync(join(releaseAppDir, "claude-office.sh"), "utf8"));
      chmodSync(launcher, 0o755);
      writeFileSync(join(bogus, "marker.txt"), "still here");

      const r = spawnSync(launcher, ["uninstall", "--yes"], { env: env(rig), encoding: "utf8" });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("설치 폴더를 찾지 못했습니다");
      expect(existsSync(join(bogus, "marker.txt"))).toBe(true);
      expect(existsSync(bogus)).toBe(true); // bogus 폴더 자체도 안 지워짐
    } finally {
      rig.cleanup();
    }
  });

  it('--prefix "/"는 거부된다(Critical)', () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      const r = runInstall(["--prefix", "/", "--yes", "--no-open"], env(rig));
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('"/"');
    } finally {
      rig.cleanup();
    }
  });

  it('--prefix ""(빈 값)과 --prefix "$HOME" 자체도 거부된다', () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      expect(runInstall(["--prefix", "", "--yes", "--no-open"], env(rig)).status).not.toBe(0);
      expect(runInstall(["--prefix", rig.home, "--yes", "--no-open"], env(rig)).status).not.toBe(0);
    } finally {
      rig.cleanup();
    }
  });

  it("--prefix에 값을 안 주면 쉬운 안내와 함께 끝난다(Minor 7)", () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      const r = runInstall(["--yes", "--no-open", "--prefix"], env(rig));
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("--prefix");
    } finally {
      rig.cleanup();
    }
  });

  it("uninstall이 rc를 심볼릭 링크·권한(600) 그대로 두고 내용만 고친다(Important)", () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      const realRc = join(dirname(rig.home), "real-zshrc");
      writeFileSync(realRc, "# mine\n");
      chmodSync(realRc, 0o600);
      symlinkSync(realRc, join(rig.home, ".zshrc"));

      const prefix = join(rig.home, ".claude-office");
      expect(runInstall(["--prefix", prefix, "--yes", "--no-open"], env(rig)).status).toBe(0);

      const r = spawnSync(join(prefix, "bin/claude-office"), ["uninstall", "--yes"], { env: env(rig), encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);

      expect(lstatSync(join(rig.home, ".zshrc")).isSymbolicLink()).toBe(true);
      expect(statSync(realRc).mode & 0o777).toBe(0o600);
      expect(readFileSync(realRc, "utf8")).toBe("# mine\n");
    } finally {
      rig.cleanup();
    }
  });

  it("설치·제거를 반복해도 rc에 빈 줄이 쌓이지 않는다(Minor)", () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      const prefix = join(rig.home, ".claude-office");
      for (let i = 0; i < 3; i++) {
        expect(runInstall(["--prefix", prefix, "--yes", "--no-open"], env(rig)).status).toBe(0);
        const r = spawnSync(join(prefix, "bin/claude-office"), ["uninstall", "--yes"], { env: env(rig), encoding: "utf8" });
        expect(r.status, r.stderr).toBe(0);
      }
      expect(readFileSync(join(rig.home, ".zshrc"), "utf8")).toBe("");
    } finally {
      rig.cleanup();
    }
  });

  // macOS에서는 Terminal.app이 로그인 셸을 띄우고, 로그인 bash는 .bashrc가 아니라
  // .bash_profile을 읽는다 — 이 분기는 install.sh의 `uname = Darwin` 검사라 다른 OS에서
  // 돌리면 의미가 없다(#69 보충).
  it.skipIf(process.platform !== "darwin")("macOS에서 로그인 셸이 bash면 .bashrc가 아니라 .bash_profile을 쓴다(Minor)", () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      const prefix = join(rig.home, ".claude-office");
      const r = runInstall(["--prefix", prefix, "--yes", "--no-open"], { ...env(rig), SHELL: "/bin/bash" });
      expect(r.status, r.stderr).toBe(0);
      expect(existsSync(join(rig.home, ".bash_profile"))).toBe(true);
      expect(existsSync(join(rig.home, ".bashrc"))).toBe(false);
    } finally {
      rig.cleanup();
    }
  });

  it(
    "런처가 --port=5000 형식도 알아본다(Minor)",
    async () => {
      requireBuildOk();
      const rig = makeRig();
      try {
        fileOpener(rig);

        const prefix = join(rig.home, ".claude-office");
        expect(runInstall(["--prefix", prefix, "--yes", "--no-path", "--no-open"], env(rig)).status).toBe(0);

        const port = await getFreePort();
        const fakeClaudeHome = join(rig.home, "fake-claude-home");
        mkdirSync(fakeClaudeHome, { recursive: true });
        // CLAUDE_OFFICE_NO_OPEN을 안 줘서(install 테스트들과 달리) open이 실제로 불리게 둔다.
        const child = spawn(join(prefix, "bin/claude-office"), [`--port=${port}`, "--claude-home", fakeClaudeHome], { env: env(rig) });
        try {
          await new Promise<void>((resolvePromise, reject) => {
            let out = "";
            const onData = (b: Buffer) => {
              out += b.toString();
              if (out.includes(`:${port}`)) resolvePromise();
            };
            child.stdout?.on("data", onData);
            child.stderr?.on("data", onData);
            child.on("exit", (code) => reject(new Error(`서버가 일찍 끝남(code ${code}): ${out}`)));
            setTimeout(() => reject(new Error("서버 시작 시간초과")), 10_000);
          });
          // 런처의 "(sleep 1; open ...) &"가 부하 상황에서 1초보다 늦게 끝날 수 있어(리뷰어 실측,
          // B14 — 원인 모르는 간헐 실패 금지) 고정 대기 대신 최대 5초 동안 100ms마다 로그를 본다.
          const deadline = Date.now() + 5000;
          let log = "";
          for (;;) {
            log = opened(rig);
            if (log.includes(`http://127.0.0.1:${port}/`) || Date.now() > deadline) break;
            await new Promise((r) => setTimeout(r, 100));
          }
          expect(log).toContain(`http://127.0.0.1:${port}/`);
        } finally {
          await killAndWait(child);
        }
      } finally {
        rig.cleanup();
      }
    },
    20_000,
  );

  // T7 fix round 2(#69/#73, Ruling B15) — "$PREFIX" = "$HOME"처럼 글자 그대로 비교하면
  // --prefix "$HOME/"나 "//"나 "$HOME/."가 거부를 피해간다(리뷰어 실측). pwd -P 정규화 뒤
  // 비교해야 셋 다 거부된다.
  it('--prefix "$HOME/", "//", "$HOME/."는 모두 거부된다(Important, B15)', () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      expect(runInstall(["--prefix", `${rig.home}/`, "--yes", "--no-open"], env(rig)).status).not.toBe(0);
      expect(runInstall(["--prefix", "//", "--yes", "--no-open"], env(rig)).status).not.toBe(0);
      expect(runInstall(["--prefix", `${rig.home}/.`, "--yes", "--no-open"], env(rig)).status).not.toBe(0);
    } finally {
      rig.cleanup();
    }
  });

  it("이미 다른 파일이 있는 폴더(VERSION 없음)에는 설치를 거부하고 내용을 그대로 둔다(B15)", () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      const foreign = join(dirname(rig.home), "foreign");
      mkdirSync(foreign, { recursive: true });
      writeFileSync(join(foreign, "mydata.txt"), "my precious data");

      const r = runInstall(["--prefix", foreign, "--yes", "--no-open"], env(rig));
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("이미 다른 파일이 있는 폴더입니다. 빈 폴더나 새 폴더 이름을 지정해 주세요.");
      expect(readFileSync(join(foreign, "mydata.txt"), "utf8")).toBe("my precious data");
      expect(existsSync(join(foreign, "app"))).toBe(false); // 설치 흔적이 안 생김
    } finally {
      rig.cleanup();
    }
  });

  it("재설치(VERSION 있음)는 거부되지 않는다(정상 동작 확인, B15)", () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      const prefix = join(rig.home, ".claude-office");
      expect(runInstall(["--prefix", prefix, "--yes", "--no-path", "--no-open"], env(rig)).status).toBe(0);
      // 재설치 — 이미 VERSION이 있으니 "남의 폴더" 거부에 걸리면 안 된다.
      expect(runInstall(["--prefix", prefix, "--yes", "--no-path", "--no-open"], env(rig)).status).toBe(0);
    } finally {
      rig.cleanup();
    }
  });

  it("아직 없는 기본 경로(--prefix 생략, ~/.claude-office)에 첫 설치가 성공한다(정규화가 정상 설치를 안 깨뜨림)", () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      const r = runInstall(["--yes", "--no-path", "--no-open"], env(rig));
      expect(r.status, r.stderr).toBe(0);
      expect(existsSync(join(rig.home, ".claude-office/app/server.mjs"))).toBe(true);
    } finally {
      rig.cleanup();
    }
  });

  it("아직 없는 여러 단계 경로(--prefix <임시>/a/b/c)에 설치가 성공한다", () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      const prefix = join(rig.home, "a/b/c");
      const r = runInstall(["--prefix", prefix, "--yes", "--no-path", "--no-open"], env(rig));
      expect(r.status, r.stderr).toBe(0);
      expect(existsSync(join(prefix, "app/server.mjs"))).toBe(true);
    } finally {
      rig.cleanup();
    }
  });

  it('HOME 끝에 "/"가 붙어도 런처의 홈 폴더 자체 거부가 동작한다', () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      // 런처를 "$HOME/bin/claude-office"에 직접 둬서(설치 없이) PREFIX가 $HOME 자체가 되게
      // 만든다 — 손상된 설치를 흉내 낸다.
      mkdirSync(join(rig.home, "bin"), { recursive: true });
      const launcher = join(rig.home, "bin/claude-office");
      writeFileSync(launcher, readFileSync(join(releaseAppDir, "claude-office.sh"), "utf8"));
      chmodSync(launcher, 0o755);

      const r = spawnSync(launcher, ["doctor"], { env: { ...env(rig), HOME: `${rig.home}/` }, encoding: "utf8" });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("홈 폴더 자체");
    } finally {
      rig.cleanup();
    }
  });

  // #78/B17(SPEC 3장): 서버를 켤 때 창을 닫으면 꺼진다는 안내를 한 줄 낸다.
  it(
    "claude-office로 서버를 켜면 \"이 창을 닫으면 대시보드가 꺼집니다.\"를 출력한다",
    async () => {
      requireBuildOk();
      const rig = makeRig();
      try {
        const prefix = join(rig.home, ".claude-office");
        expect(runInstall(["--prefix", prefix, "--yes", "--no-path", "--no-open"], env(rig)).status).toBe(0);
        const port = await getFreePort();
        const fakeClaudeHome = join(rig.home, "fake-claude-home");
        mkdirSync(fakeClaudeHome, { recursive: true });
        const child = spawn(join(prefix, "bin/claude-office"), ["--port", String(port), "--claude-home", fakeClaudeHome], {
          env: env(rig, { CLAUDE_OFFICE_NO_OPEN: "1" }),
        });
        try {
          let out = "";
          await new Promise<void>((resolvePromise, reject) => {
            const onData = (b: Buffer) => {
              out += b.toString();
              if (out.includes(`:${port}`)) resolvePromise();
            };
            child.stdout?.on("data", onData);
            child.stderr?.on("data", onData);
            child.on("exit", (code) => reject(new Error(`서버가 일찍 끝남(code ${code}): ${out}`)));
            setTimeout(() => reject(new Error("서버 시작 시간초과")), 10_000);
          });
          expect(out).toContain("이 창을 닫으면 대시보드가 꺼집니다.");
        } finally {
          await killAndWait(child);
        }
      } finally {
        rig.cleanup();
      }
    },
    20_000,
  );

  // #78/B17(SPEC 3장 3단계): PATH 등록을 거절하거나 --no-path면 끝에 전체 경로 실행법을 안내한다.
  it('PATH를 안 넣으면(--no-path) 끝에 "다음부터는 이렇게 켜세요: <prefix>/bin/claude-office"를 안내한다', () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      const prefix = join(rig.home, ".claude-office");
      const r = runInstall(["--prefix", prefix, "--yes", "--no-path", "--no-open"], env(rig));
      expect(r.status, r.stderr).toBe(0);
      const realPrefix = realpathSync(prefix);
      expect(r.stdout).toContain(`다음부터는 이렇게 켜세요: ${realPrefix}/bin/claude-office`);
    } finally {
      rig.cleanup();
    }
  });

  it("PATH 등록이 됐으면(이미 등록 포함) 전체 경로 안내를 하지 않는다", () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      const prefix = join(rig.home, ".claude-office");
      const r = runInstall(["--prefix", prefix, "--yes", "--no-open"], env(rig)); // --no-path 없음, --yes라 PATH 질문도 y
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).not.toContain("다음부터는 이렇게 켜세요");
    } finally {
      rig.cleanup();
    }
  });

  // #78/B17(SPEC 3장 "동의 필요"): uninstall은 플러그인을 지우기 전에 따로 묻는다. 입력이 없으면
  // (EOF) "아니오"로 처리해 플러그인을 남기고 지우는 명령을 안내한다.
  it("uninstall을 --yes 없이 EOF로 실행하면 플러그인을 지우지 않고 남겨 둔다는 안내를 한다", () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      const prefix = join(rig.home, ".claude-office");
      expect(runInstall(["--prefix", prefix, "--yes", "--no-path", "--no-open"], env(rig)).status).toBe(0);
      writeFileSync(rig.stubLog, "");

      const r = spawnSync(join(prefix, "bin/claude-office"), ["uninstall"], { env: env(rig), encoding: "utf8", input: "" });
      expect(r.status, r.stderr).toBe(0);

      const log = readFileSync(rig.stubLog, "utf8");
      expect(log).not.toContain("plugin uninstall");
      expect(r.stdout).toContain("플러그인은 남겨 두었습니다. 지우려면: claude plugin uninstall claude-office@claude-office --scope user");
      // #82(qa 발견): 플러그인을 거절해도 프로그램 파일은 이미 지워졌다 — "지움: 없음"이면 거짓말이다.
      // 이 설치는 --no-path였으니 PATH 설정까지 지웠다고 하면 그건 또 틀린 말이라 거기엔 없어야 한다.
      expect(r.stdout).toContain("지움: 프로그램 파일");
      expect(r.stdout).not.toContain("PATH 설정");
    } finally {
      rig.cleanup();
    }
  });

  // #82(qa 발견): 플러그인·logs 질문에 모두 "아니오"로 답해도 app/bin/plugin·VERSION·사용설명서·
  // PATH 줄은 질문과 무관하게 항상 지워진다. 전에는 요약이 "지움: 없음"이라 사실과 달랐다(두
  // 질문 모두 거절해도 프로그램은 실제로 제거됨). --no-path 없이 설치해서 PATH 설정도 같이 본다.
  it('uninstall에서 두 질문 모두 n으로 답해도 "지움: 프로그램 파일, PATH 설정"을 알린다(#82)', () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      const prefix = join(rig.home, ".claude-office");
      expect(runInstall(["--prefix", prefix, "--yes", "--no-open"], env(rig)).status).toBe(0);
      expect(existsSync(join(rig.home, ".zshrc"))).toBe(true); // PATH 줄이 실제로 들어갔는지 먼저 확인

      const r = spawnSync(join(prefix, "bin/claude-office"), ["uninstall"], { env: env(rig), encoding: "utf8", input: "n\nn\n" });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("지움: 프로그램 파일, PATH 설정");
      expect(r.stdout).toContain("남김: 플러그인, logs, diagnostics");
      // 요약 문구만 맞고 실제로는 안 지워지는 반대쪽 버그도 같이 막는다.
      expect(existsSync(join(prefix, "app"))).toBe(false);
      expect(existsSync(join(prefix, "VERSION"))).toBe(false);
      expect(readFileSync(join(rig.home, ".zshrc"), "utf8")).not.toContain("claude-office PATH");
    } finally {
      rig.cleanup();
    }
  });

  // #78/B17(SPEC 3장): uninstall이 끝나면 지운 것·남긴 것을 알린다.
  it("설치하면 설명서 두 개(사용설명서.html·manual-en.html)가 PREFIX에 들어가고, 제거하면 둘 다 지워진다(B247)", () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      const prefix = join(rig.home, ".claude-office");
      expect(runInstall(["--prefix", prefix, "--yes", "--no-path", "--no-open"], env(rig)).status).toBe(0);
      for (const f of ["사용설명서.html", "manual-en.html"]) expect(existsSync(join(prefix, f)), f).toBe(true);
      const r = spawnSync(join(prefix, "bin/claude-office"), ["uninstall", "--yes"], { env: env(rig), encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
      for (const f of ["사용설명서.html", "manual-en.html"]) expect(existsSync(join(prefix, f)), f).toBe(false);
    } finally {
      rig.cleanup();
    }
  });

  it('uninstall --yes는 끝에 "제거를 마쳤습니다."와 지움/남김 목록을 출력한다', () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      const prefix = join(rig.home, ".claude-office");
      expect(runInstall(["--prefix", prefix, "--yes", "--no-path", "--no-open"], env(rig)).status).toBe(0);

      const r = spawnSync(join(prefix, "bin/claude-office"), ["uninstall", "--yes"], { env: env(rig), encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("제거를 마쳤습니다.");
      expect(r.stdout).toMatch(/지움: 프로그램 파일.*플러그인/);
      expect(r.stdout).not.toContain("PATH 설정"); // 이 설치는 --no-path였다
      expect(r.stdout).toMatch(/지움: .*logs, diagnostics|남김: .*logs, diagnostics/);
    } finally {
      rig.cleanup();
    }
  });

  // FB-1(사용자 피드백, 2026-10-01): `!`로 돌리면 표준 입력이 터미널이 아니라 두 질문이 조용히
  // "아니오"가 되는데 안내가 없었다. spawnSync는 input을 안 주면 기본적으로 비어 있는 pipe라
  // [ -t 0 ]가 이미 거짓이다(직접 확인) — 그러니 별도 stdio 조작 없이 runInstall을 그대로 쓴다.
  it('입력을 못 받는 환경에서 --yes 없이 설치하면 "입력을 받을 수 없어..." 안내를 낸다(FB-1)', () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      const prefix = join(rig.home, ".claude-office");
      const r = runInstall(["--prefix", prefix, "--no-path", "--no-open"], env(rig));
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("입력을 받을 수 없어 '아니오'로 처리했습니다. 설치하려면 --yes를 붙여 다시 실행하세요.");
    } finally {
      rig.cleanup();
    }
  });

  // #115 Minor(리뷰어 지적): --no-path이고 claude도 없으면 질문을 하나도 안 하는데, 그래도
  // "입력을 받을 수 없어..." 안내가 나오면 거짓말이다(실제로는 아무것도 안 물어봤다). RED로
  // 먼저 확인했다 — ASKED 가드를 빼면 이 테스트가 실패한다.
  it('질문이 하나도 없으면(--no-path, claude 없음) 입력 못 받아도 안내가 안 나온다(#115 Minor)', () => {
    requireBuildOk();
    const rig = makeRig({ claude: false });
    try {
      const prefix = join(rig.home, ".claude-office");
      const r = runInstall(["--prefix", prefix, "--no-path", "--no-open"], env(rig));
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).not.toContain("입력을 받을 수 없어");
    } finally {
      rig.cleanup();
    }
  });

  it('--yes로 설치하면 입력 관련 안내가 안 나온다(FB-1)', () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      const prefix = join(rig.home, ".claude-office");
      const r = runInstall(["--prefix", prefix, "--yes", "--no-path", "--no-open"], env(rig));
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).not.toContain("입력을 받을 수 없어");
    } finally {
      rig.cleanup();
    }
  });

  it('입력을 못 받는 환경에서 --yes 없이 uninstall하면 "...제거하려면..." 안내를 낸다(FB-1)', () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      const prefix = join(rig.home, ".claude-office");
      expect(runInstall(["--prefix", prefix, "--yes", "--no-path", "--no-open"], env(rig)).status).toBe(0);

      const r = spawnSync(join(prefix, "bin/claude-office"), ["uninstall"], { env: env(rig), encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("입력을 받을 수 없어 '아니오'로 처리했습니다. 제거하려면 --yes를 붙여 다시 실행하세요.");
    } finally {
      rig.cleanup();
    }
  });

  it('--yes로 uninstall하면 입력 관련 안내가 안 나온다(FB-1)', () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      const prefix = join(rig.home, ".claude-office");
      expect(runInstall(["--prefix", prefix, "--yes", "--no-path", "--no-open"], env(rig)).status).toBe(0);

      const r = spawnSync(join(prefix, "bin/claude-office"), ["uninstall", "--yes"], { env: env(rig), encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).not.toContain("입력을 받을 수 없어");
    } finally {
      rig.cleanup();
    }
  });
});

// ───────── Phase 2 Task 11: 대시보드 토큰(설치·런처) ─────────
// 토큰 값은 단언의 인자로 넘기지 않는다(실패 메시지에 값이 찍히지 않게) — 포함 여부는 boolean으로만 본다.

/** 런처가 쓰는 명령만 링크한 폴더(open·xdg-open 없음). "브라우저 열기 명령이 없다" 시나리오용 */
function toolsWithoutOpen(): string {
  const dir = mkdtempSync(join(tmpdir(), "claude-office-installtest-tools-"));
  for (const t of ["dirname", "readlink", "sed", "sleep", "cat", "tr", "rm", "awk", "grep", "mkdir"]) {
    const src = ["/usr/bin", "/bin"].map((d) => join(d, t)).find((f) => existsSync(f));
    if (src) symlinkSync(src, join(dir, t));
  }
  return dir;
}

/** 서버 대신 쓰는 가짜 node: -v에는 v24를 답하고, 그 밖에는 몇 초 기다리다 끝난다(포트·토큰 파일을 쓰지 않는다) */
function fakeNode(rig: Rig) {
  writeFileSync(join(rig.stubBin, "node"), '#!/bin/sh\nif [ "$1" = "-v" ]; then echo v24.0.0; exit 0; fi\nsleep 4\n');
  chmodSync(join(rig.stubBin, "node"), 0o755);
}

/**
 * 가짜 open: 인자를 STUB_LOG에, 인자가 파일이면 그 내용을 STUB_LOG.content에 적는다.
 * 런처는 토큰 주소를 인자로 넘기지 않고 0600 HTML(토큰 주소로 넘기는 페이지)의 경로만 연다(B265)
 */
function fileOpener(rig: Rig) {
  writeFileSync(join(rig.stubBin, "open"), '#!/bin/sh\necho "open $@" >> "$STUB_LOG"\nfor a; do [ -f "$a" ] && cat "$a" >> "$STUB_LOG.content"; done\nexit 0\n');
  chmodSync(join(rig.stubBin, "open"), 0o755);
}
const opened = (rig: Rig) => (existsSync(`${rig.stubLog}.content`) ? readFileSync(`${rig.stubLog}.content`, "utf8") : "");

/** 런처를 켜고 끝날 때까지(가짜 node는 4초) 출력을 모은다 */
function runLauncher(prefix: string, e: NodeJS.ProcessEnv, args: string[] = ["--port", "5999"]) {
  return spawnSync(join(prefix, "bin/claude-office"), args, { env: e, encoding: "utf8", timeout: 15_000 });
}

describe("설치 테스트는 사용자 대시보드(4317)를 보지 않는다(Ruling B109)", () => {
  it("install.sh 끝의 doctor는 rig가 고른 빈 포트를 본다", () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      const prefix = join(rig.home, ".claude-office");
      const r = runInstall(["--prefix", prefix, "--yes", "--no-path", "--no-open"], env(rig));
      expect(r.status, r.stderr).toBe(0);
      const calls = existsSync(rig.wrapLog) ? readFileSync(rig.wrapLog, "utf8").trim().split("\n").filter(Boolean) : [];
      expect(calls.length).toBeGreaterThan(0);
      for (const c of calls) expect(c.startsWith(`port ${rig.doctorPort} `), c).toBe(true);
      expect(rig.doctorPort).not.toBe(4317);
      expect(r.stdout.includes("4317")).toBe(false);
      expect(r.stdout).toContain(`(${rig.doctorPort})`);
    } finally {
      rig.cleanup();
    }
  });
});

describe("Phase 2 토큰 — install.sh·런처(Task 11)", () => {
  it("install.sh: 토큰 파일을 64자 hex, 권한 600으로 만든다", () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      const prefix = join(rig.home, ".claude-office");
      const r = runInstall(["--prefix", prefix, "--yes", "--no-path", "--no-open"], env(rig));
      expect(r.status, r.stderr).toBe(0);
      const token = readFileSync(join(prefix, "token"), "utf8");
      expect(/^[0-9a-f]{64}$/.test(token)).toBe(true);
      expect(statSync(join(prefix, "token")).mode & 0o777).toBe(0o600);
      const steps = installLogLines(prefix).map((l) => l.split(" ").slice(1, 3).join(" "));
      expect(steps).toContain("token ok");
    } finally {
      rig.cleanup();
    }
  });

  it("install.sh: 다시 설치해도 토큰이 바뀌지 않는다(내용과 mtime)", () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      const prefix = join(rig.home, ".claude-office");
      expect(runInstall(["--prefix", prefix, "--yes", "--no-path", "--no-open"], env(rig)).status).toBe(0);
      const before = readFileSync(join(prefix, "token"), "utf8");
      const mtime = statSync(join(prefix, "token")).mtimeMs;
      expect(runInstall(["--prefix", prefix, "--yes", "--no-path", "--no-open"], env(rig)).status).toBe(0);
      expect(readFileSync(join(prefix, "token"), "utf8") === before).toBe(true);
      expect(statSync(join(prefix, "token")).mtimeMs).toBe(mtime);
      expect(installLogLines(prefix).some((l) => / token skip 이미 있음$/.test(l))).toBe(true);
    } finally {
      rig.cleanup();
    }
  });

  it("설치 로그와 설치 출력에 토큰 값이 없다", () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      const prefix = join(rig.home, ".claude-office");
      const r = runInstall(["--prefix", prefix, "--yes", "--no-path", "--no-open"], env(rig));
      const token = readFileSync(join(prefix, "token"), "utf8");
      const logs = readdirSync(join(prefix, "logs")).map((f) => readFileSync(join(prefix, "logs", f), "utf8")).join("");
      expect([r.stdout, r.stderr, logs].some((t) => t.includes(token))).toBe(false);
    } finally {
      rig.cleanup();
    }
  });

  it("런처: 토큰이 있으면 ?k=<토큰> 주소로 넘기는 HTML을 열고(인자에는 토큰 없음), 열리면 출력에 토큰 값이 없다", () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      const prefix = join(rig.home, ".claude-office");
      expect(runInstall(["--prefix", prefix, "--yes", "--no-path", "--no-open"], env(rig)).status).toBe(0);
      fileOpener(rig);
      fakeNode(rig);
      writeFileSync(rig.stubLog, "");
      const token = readFileSync(join(prefix, "token"), "utf8");
      const r = runLauncher(prefix, env(rig));
      const log = readFileSync(rig.stubLog, "utf8");
      expect(/^open \/.+\.html$/.test(log.trim())).toBe(true);
      expect(log.includes(token)).toBe(false);
      expect(opened(rig).includes(`http://127.0.0.1:5999/?k=${token}`)).toBe(true);
      expect((r.stdout + r.stderr).includes(token)).toBe(false);
      expect(r.stdout).not.toContain("브라우저를 열지 못했습니다");
    } finally {
      rig.cleanup();
    }
  }, 20_000);

  it("FB-10: `claude-office open [브라우저]`는 열쇠 주소를 (지정한) 브라우저로 열고 서버는 켜지 않으며 열쇠를 찍지 않는다", () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      const prefix = join(rig.home, ".claude-office");
      expect(runInstall(["--prefix", prefix, "--yes", "--no-path", "--no-open"], env(rig)).status).toBe(0);
      fileOpener(rig);
      fakeNode(rig);
      const token = readFileSync(join(prefix, "token"), "utf8").trim();
      writeFileSync(rig.stubLog, "");
      let r = runLauncher(prefix, env(rig), ["open"]);
      expect(r.status).toBe(0);
      expect(readFileSync(rig.stubLog, "utf8").trim()).toMatch(/^open \/.+\.html$/);
      expect(opened(rig).includes(`http://127.0.0.1:4317/?k=${token}`)).toBe(true);
      expect((r.stdout + r.stderr).includes(token)).toBe(false);
      expect(r.stdout + r.stderr).not.toContain("이 창을 닫으면"); // 서버를 켜지 않는다
      writeFileSync(rig.stubLog, "");
      rmSync(`${rig.stubLog}.content`, { force: true });
      r = runLauncher(prefix, env(rig), ["open", "Safari", "--port", "5999"]);
      expect(r.status).toBe(0);
      expect(readFileSync(rig.stubLog, "utf8").trim()).toMatch(/^open -a Safari \/.+\.html$/);
      expect(opened(rig).includes(`http://127.0.0.1:5999/?k=${token}`)).toBe(true);
    } finally {
      rig.cleanup();
    }
  }, 20_000);

  it("런처: 토큰이 없으면 예전 주소로 연다", () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      const prefix = join(rig.home, ".claude-office");
      expect(runInstall(["--prefix", prefix, "--yes", "--no-path", "--no-open"], env(rig)).status).toBe(0);
      rmSync(join(prefix, "token"));
      fileOpener(rig);
      fakeNode(rig);
      writeFileSync(rig.stubLog, "");
      runLauncher(prefix, env(rig));
      expect(readFileSync(rig.stubLog, "utf8").trim()).toMatch(/^open \/.+\.html$/);
      expect(opened(rig)).toContain('"http://127.0.0.1:5999/"');
      expect(opened(rig)).not.toContain("?k=");
    } finally {
      rig.cleanup();
    }
  }, 20_000);

  it.each([
    ["열기 명령이 실패하면(exit 1)", "fail"],
    ["열기 명령이 없으면", "missing"],
  ] as const)("%s 토큰 주소와 \"남에게 보내지 마세요\" 안내를 출력한다", (_label, mode) => {
    requireBuildOk();
    const rig = makeRig();
    const tools = toolsWithoutOpen();
    try {
      const prefix = join(rig.home, ".claude-office");
      expect(runInstall(["--prefix", prefix, "--yes", "--no-path", "--no-open"], env(rig)).status).toBe(0);
      if (mode === "fail") {
        writeFileSync(join(rig.stubBin, "open"), "#!/bin/sh\nexit 1\n");
        chmodSync(join(rig.stubBin, "open"), 0o755);
      }
      fakeNode(rig);
      const token = readFileSync(join(prefix, "token"), "utf8");
      // /usr/bin(진짜 open이 있는 곳)를 빼고, 런처가 쓰는 명령만 링크한 폴더를 쓴다
      const r = runLauncher(prefix, env(rig, { PATH: `${rig.stubBin}:${tools}` }));
      const lines = r.stdout.split("\n");
      const i = lines.findIndex((l) => l.startsWith("브라우저를 열지 못했습니다. 이 주소를 브라우저에 붙여 넣어 주세요: "));
      expect(i).toBeGreaterThanOrEqual(0);
      expect(lines[i].endsWith(`http://127.0.0.1:5999/?k=${token}`)).toBe(true);
      expect(lines[i + 1]).toBe("이 주소는 열쇠입니다. 남에게 보내지 마세요.");
      // 설치 로그에는 어느 경우에도 없다
      const logs = readdirSync(join(prefix, "logs")).map((f) => readFileSync(join(prefix, "logs", f), "utf8")).join("");
      expect(logs.includes(token)).toBe(false);
    } finally {
      rmSync(tools, { recursive: true, force: true });
      rig.cleanup();
    }
  }, 20_000);

  it(
    "실제 서버로 켜도 서버 로그 파일에 토큰 값이 없다",
    async () => {
      requireBuildOk();
      const rig = makeRig();
      try {
        const prefix = join(rig.home, ".claude-office");
        expect(runInstall(["--prefix", prefix, "--yes", "--no-path", "--no-open"], env(rig)).status).toBe(0);
        writeFileSync(join(rig.stubBin, "open"), "#!/bin/sh\nexit 1\n"); // 열기 실패 → 터미널 출력 경로
        chmodSync(join(rig.stubBin, "open"), 0o755);
        const token = readFileSync(join(prefix, "token"), "utf8");
        const port = await getFreePort();
        const fakeClaudeHome = join(rig.home, "fake-claude-home");
        mkdirSync(fakeClaudeHome, { recursive: true });
        const child = spawn(join(prefix, "bin/claude-office"), ["--port", String(port), "--claude-home", fakeClaudeHome], { env: env(rig) });
        let out = "";
        child.stdout?.on("data", (b: Buffer) => (out += b.toString()));
        try {
          const deadline = Date.now() + 10_000;
          while (!out.includes("남에게 보내지 마세요") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
          expect(out.includes("남에게 보내지 마세요")).toBe(true);
        } finally {
          await killAndWait(child);
        }
        const logs = readdirSync(join(prefix, "logs")).map((f) => readFileSync(join(prefix, "logs", f), "utf8")).join("");
        expect(logs).toContain('"msg":"start"');
        expect(logs.includes(token)).toBe(false);
      } finally {
        rig.cleanup();
      }
    },
    30_000,
  );

  it("uninstall은 token과 state.json도 지운다(로그를 남기기로 해도)", () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      const prefix = join(rig.home, ".claude-office");
      expect(runInstall(["--prefix", prefix, "--yes", "--no-path", "--no-open"], env(rig)).status).toBe(0);
      writeFileSync(join(prefix, "state.json"), '{"sessions":{}}');
      const r = spawnSync(join(prefix, "bin/claude-office"), ["uninstall"], { env: env(rig), encoding: "utf8", input: "n\nn\n" });
      expect(r.status, r.stderr).toBe(0);
      expect(existsSync(join(prefix, "token"))).toBe(false);
      expect(existsSync(join(prefix, "state.json"))).toBe(false);
      expect(existsSync(join(prefix, "logs"))).toBe(true); // 로그는 남겼다
      expect(r.stdout).toContain("지움: 프로그램 파일");
    } finally {
      rig.cleanup();
    }
  });

  it("uninstall --yes 뒤 token과 state.json이 없다", () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      const prefix = join(rig.home, ".claude-office");
      expect(runInstall(["--prefix", prefix, "--yes", "--no-path", "--no-open"], env(rig)).status).toBe(0);
      writeFileSync(join(prefix, "state.json"), '{"sessions":{}}');
      expect(spawnSync(join(prefix, "bin/claude-office"), ["uninstall", "--yes"], { env: env(rig), encoding: "utf8" }).status).toBe(0);
      expect(existsSync(join(prefix, "token"))).toBe(false);
      expect(existsSync(join(prefix, "state.json"))).toBe(false);
    } finally {
      rig.cleanup();
    }
  });
});

describe("Phase 3 정책 파일 — 설치·재설치·제거", () => {
  it("설치는 policy.json을 만들지 않는다", () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      const prefix = join(rig.home, ".claude-office");
      expect(runInstall(["--prefix", prefix, "--yes", "--no-path", "--no-open"], env(rig)).status).toBe(0);
      expect(existsSync(join(prefix, "policy.json"))).toBe(false);
      expect(existsSync(join(prefix, "policy.json.broken"))).toBe(false);
    } finally {
      rig.cleanup();
    }
  });

  it("다시 설치해도 policy.json과 policy.json.broken의 내용이 그대로다", () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      const prefix = join(rig.home, ".claude-office");
      expect(runInstall(["--prefix", prefix, "--yes", "--no-path", "--no-open"], env(rig)).status).toBe(0);
      const policy = '{"version":1,"targets":{"agent:fake":{"bash":"deny"}}}';
      const broken = "{broken";
      writeFileSync(join(prefix, "policy.json"), policy);
      writeFileSync(join(prefix, "policy.json.broken"), broken);
      expect(runInstall(["--prefix", prefix, "--yes", "--no-path", "--no-open"], env(rig)).status).toBe(0);
      expect(readFileSync(join(prefix, "policy.json"), "utf8")).toBe(policy);
      expect(readFileSync(join(prefix, "policy.json.broken"), "utf8")).toBe(broken);
    } finally {
      rig.cleanup();
    }
  });

  it("제거하면 policy.json과 policy.json.broken이 지워지고 요약 문구는 그대로다", () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      const prefix = join(rig.home, ".claude-office");
      expect(runInstall(["--prefix", prefix, "--yes", "--no-path", "--no-open"], env(rig)).status).toBe(0);
      writeFileSync(join(prefix, "policy.json"), "{}");
      writeFileSync(join(prefix, "policy.json.broken"), "{broken");
      const r = spawnSync(join(prefix, "bin/claude-office"), ["uninstall"], { env: env(rig), encoding: "utf8", input: "n\nn\n" });
      expect(r.status, r.stderr).toBe(0);
      expect(existsSync(join(prefix, "policy.json"))).toBe(false);
      expect(existsSync(join(prefix, "policy.json.broken"))).toBe(false);
      expect(existsSync(join(prefix, "logs"))).toBe(true); // 로그는 남겼다
      const summary = r.stdout.split("\n").filter((l) => /^(지움|남김): /.test(l));
      expect(summary).toEqual(["지움: 프로그램 파일", "남김: 플러그인, logs, diagnostics"]);
    } finally {
      rig.cleanup();
    }
  });
});

// ───────── B65: 파이프로 답했는데 "아니오로 처리" 안내가 나오던 버그 ─────────
// 안내는 읽기가 EOF로 실패해서 아니오가 됐을 때만 나와야 한다(실제로 y나 n을 읽었으면 안 나온다)
describe("FB-1 안내는 입력이 끊겨(EOF) 아니오가 됐을 때만(Ruling B65)", () => {
  const INSTALL_HINT = "입력을 받을 수 없어 '아니오'로 처리했습니다. 설치하려면 --yes를 붙여 다시 실행하세요.";
  const UNINSTALL_HINT = "입력을 받을 수 없어 '아니오'로 처리했습니다. 제거하려면 --yes를 붙여 다시 실행하세요.";

  it.each([
    ["파이프로 y를 답하면 안내 없음", "y\ny\n", false],
    ["파이프로 n을 답하면(실제로 아니오) 안내 없음", "n\nn\n", false],
    ["입력이 비어 EOF면 안내 있음", "", true],
    ["첫 질문만 답하고 끊기면 안내 있음", "y\n", true],
    ["줄바꿈 없는 y도 답으로 본다", "y\ny", false],
  ] as const)("install: %s", (_label, input, hinted) => {
    requireBuildOk();
    const rig = makeRig(); // stub claude 있음 → PATH·플러그인 두 질문
    try {
      const prefix = join(rig.home, ".claude-office");
      const r = spawnSync("sh", [join(releaseAppDir, "install.sh"), "--prefix", prefix, "--no-open"], { env: env(rig), encoding: "utf8", input });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.includes(INSTALL_HINT)).toBe(hinted);
      if (input.startsWith("y")) expect(readFileSync(join(rig.home, ".zshrc"), "utf8")).toContain("# claude-office PATH");
    } finally {
      rig.cleanup();
    }
  });

  it.each([
    ["파이프로 y를 답하면 안내 없음", "y\ny\n", false],
    ["파이프로 n을 답하면(실제로 아니오) 안내 없음", "n\nn\n", false],
    ["입력이 비어 EOF면 안내 있음", "", true],
  ] as const)("uninstall: %s", (_label, input, hinted) => {
    requireBuildOk();
    const rig = makeRig();
    try {
      const prefix = join(rig.home, ".claude-office");
      expect(runInstall(["--prefix", prefix, "--yes", "--no-path", "--no-open"], env(rig)).status).toBe(0);
      const r = spawnSync(join(prefix, "bin/claude-office"), ["uninstall"], { env: env(rig), encoding: "utf8", input });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.includes(UNINSTALL_HINT)).toBe(hinted);
    } finally {
      rig.cleanup();
    }
  });
});

// ───────── Phase 6a §2: hooks.json 자리 표시자 치환, --port ─────────
describe("Phase 6a 설치: hook 자리 표시자를 절대 경로로", () => {
  const hooksOf = (prefix: string) => join(prefix, "plugin/plugins/claude-office/hooks/hooks.json");
  type H = { type: string; command: string; args: string[] };
  const allOf = (f: string) => Object.values((JSON.parse(readFileSync(f, "utf8")) as { hooks: Record<string, Array<{ hooks: H[] }>> }).hooks).flatMap((g) => g.flatMap((x) => x.hooks));

  it("$PREFIX/plugin 사본의 13개 hook: command = 실행 가능한 node 절대 경로, args[1] = $PREFIX/hook.key(0600), 자리 표시자 없음. 저장소 원본은 그대로", () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      const prefix = join(rig.home, ".claude-office");
      const r = runInstall(["--prefix", prefix, "--yes", "--no-path", "--no-open"], env(rig, { CLAUDE_CONFIG_DIR: join(rig.home, "cc") }));
      expect(r.status, r.stderr).toBe(0);
      const real = realpathSync(prefix);
      const hooks = allOf(hooksOf(prefix));
      expect(hooks).toHaveLength(13);
      for (const h of hooks) {
        expect(h.type).toBe("command");
        expect(h.command.startsWith("/")).toBe(true);
        expect(h.command).toBe(process.execPath); // rig의 PATH node는 래퍼 스크립트(shim과 같음) → 지금 node의 실제 경로(B305)
        expect(statSync(h.command).mode & 0o111).not.toBe(0);
        expect(h.args).toEqual(["${CLAUDE_PLUGIN_ROOT}/hooks/relay.cjs", `${real}/hook.key`]);
      }
      expect(readFileSync(hooksOf(prefix), "utf8")).not.toMatch(/__NODE__|__KEYFILE__/);
      expect(readFileSync(join(prefix, "hook.key"), "utf8")).toMatch(/^[0-9a-f]{64}$/);
      expect(statSync(join(prefix, "hook.key")).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(ROOT, "plugins/claude-office/hooks/hooks.json"), "utf8")).toContain("__NODE__");
      expect(installLogLines(prefix).map((l) => l.split(" ").slice(1, 3).join(" "))).toEqual(expect.arrayContaining(["hookkey ok", "hooks ok"]));
    } finally {
      rig.cleanup();
    }
  });

  it.skipIf(process.platform === "win32")("PATH의 node가 지금 node로 가는 링크면 그 링크 경로를 그대로 적는다(업그레이드 뒤에도 살아남게, review M2·B305)", () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      // 래퍼 대신 진짜 node로 가는 링크(brew의 /opt/homebrew/bin/node와 같은 모양). 래퍼가 없으니 doctor 포트는 --port로 직접 준다(B279)
      rmSync(join(rig.stubBin, "node"));
      symlinkSync(process.execPath, join(rig.stubBin, "node"));
      const prefix = join(rig.home, ".claude-office");
      const r = runInstall(["--prefix", prefix, "--yes", "--no-path", "--no-open", "--port", String(rig.doctorPort)], env(rig, { CLAUDE_CONFIG_DIR: join(rig.home, "cc") }));
      expect(r.status, r.stderr).toBe(0);
      expect(new Set(allOf(hooksOf(prefix)).map((h) => h.command))).toEqual(new Set([join(rig.stubBin, "node")]));
    } finally {
      rig.cleanup();
    }
  });

  it("치환은 claude plugin marketplace add보다 먼저 끝난다(Claude Code가 그 사본을 캐시로 복사)", () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      const prefix = join(rig.home, ".claude-office");
      // marketplace add가 불리는 순간 사본에 자리 표시자가 남아 있는지 적는 가짜 claude
      writeFileSync(join(rig.stubBin, "claude"), `#!/bin/sh\nif [ "$2" = marketplace ]; then grep -c __NODE__ "$4/plugins/claude-office/hooks/hooks.json" >> "$STUB_LOG"; fi\necho "$@" >> "$STUB_LOG"\nexit 0\n`);
      chmodSync(join(rig.stubBin, "claude"), 0o755);
      expect(runInstall(["--prefix", prefix, "--yes", "--no-path", "--no-open"], env(rig, { CLAUDE_CONFIG_DIR: join(rig.home, "cc") })).status).toBe(0);
      expect(readFileSync(rig.stubLog, "utf8").split("\n")[0]).toBe("0");
    } finally {
      rig.cleanup();
    }
  });

  it("치환하지 못하면(hooks.json이 깨짐) 설치를 실패로 끝내고 플러그인을 등록하지 않는다", () => {
    requireBuildOk();
    const rig = makeRig();
    const pkg = mkdtempSync(join(tmpdir(), "claude-office-installtest-pkg-"));
    try {
      const copy = join(pkg, basename(releaseAppDir));
      execFileSync("cp", ["-R", releaseAppDir, copy]);
      writeFileSync(join(copy, "plugin/plugins/claude-office/hooks/hooks.json"), "{ broken");
      const prefix = join(rig.home, ".claude-office");
      const r = spawnSync("sh", [join(copy, "install.sh"), "--prefix", prefix, "--yes", "--no-path", "--no-open"], { env: env(rig, { CLAUDE_CONFIG_DIR: join(rig.home, "cc") }), encoding: "utf8" });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(HOOKS_FAIL);
      expect(readFileSync(rig.stubLog, "utf8")).not.toContain("plugin marketplace add");
      expect(installLogLines(prefix).some((l) => / hooks fail /.test(l))).toBe(true);
    } finally {
      rig.cleanup();
      rmSync(pkg, { recursive: true, force: true });
    }
  });

  it("--port <n>은 끝의 doctor에 넘기고, 숫자가 아니면 시작 전에 끝낸다", () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      const prefix = join(rig.home, ".claude-office");
      const r = runInstall(["--prefix", prefix, "--yes", "--no-path", "--no-open", "--port", String(rig.doctorPort)], env(rig, { CLAUDE_CONFIG_DIR: join(rig.home, "cc") }));
      expect(r.status, r.stderr).toBe(0);
      // node 래퍼는 --port가 이미 있으면 붙이지 않고 적지도 않는다 — 설치 스크립트가 직접 넘겼다는 뜻
      expect(existsSync(rig.wrapLog) ? readFileSync(rig.wrapLog, "utf8") : "").toBe("");
      expect(r.stdout).toContain(`(${rig.doctorPort})`);
      for (const bad of ["abc", "0", "70000", ""]) {
        const b = runInstall(["--prefix", prefix, "--yes", "--port", bad], env(rig));
        expect(b.status, bad).toBe(2);
        expect(b.stderr, bad).toContain(PORT_BAD);
      }
      expect(runInstall(["--prefix", prefix, "--yes", "--port"], env(rig)).status).toBe(2);
    } finally {
      rig.cleanup();
    }
  });
});

// ───────── Phase 6a §6·§7: claude-office url, 정리 서브셸 nohup ─────────
describe("Phase 6a 런처: url·nohup", () => {
  it("url은 열쇠 주소를 stdout 한 줄로만 낸다(브라우저·서버 없음), --port를 따르고, 열쇠 파일이 없으면 exit 1", () => {
    requireBuildOk();
    const rig = makeRig();
    try {
      const prefix = join(rig.home, ".claude-office");
      expect(runInstall(["--prefix", prefix, "--yes", "--no-path", "--no-open"], env(rig)).status).toBe(0);
      fileOpener(rig);
      fakeNode(rig);
      writeFileSync(rig.stubLog, "");
      const token = readFileSync(join(prefix, "token"), "utf8").trim();
      let r = runLauncher(prefix, env(rig), ["url"]);
      expect(r.status).toBe(0);
      expect(r.stdout === `http://127.0.0.1:4317/?k=${token}\n`).toBe(true); // 값은 단언 인자로 넘기지 않는다
      expect(r.stderr).toBe("이 주소는 열쇠입니다. 남에게 보내지 마세요.\n"); // stderr라 $(claude-office url)에 섞이지 않는다
      r = runLauncher(prefix, env(rig), ["url", "--port", "4321"]);
      expect(r.stdout === `http://127.0.0.1:4321/?k=${token}\n`).toBe(true);
      expect(runLauncher(prefix, env(rig), ["url", "--port=14317"]).stdout.startsWith("http://127.0.0.1:14317/?k=")).toBe(true);
      expect(readFileSync(rig.stubLog, "utf8")).toBe(""); // open·claude 아무것도 부르지 않았다
      const bad = runLauncher(prefix, env(rig), ["url", "--port", "x"]);
      expect([bad.status, bad.stderr.trim()]).toEqual([2, "--port에는 1~65535 숫자가 필요합니다. 예: --port 4321"]);
      rmSync(join(prefix, "token"));
      r = runLauncher(prefix, env(rig), ["url"]);
      expect([r.status, r.stdout, r.stderr.trim()]).toEqual([1, "", URL_NO_TOKEN]);
    } finally {
      rig.cleanup();
    }
  }, 20_000);

  it("30초 뒤 열기 파일 지우기는 nohup으로 터미널에서 떼어 낸다(창을 닫아도 0600 HTML이 남지 않게, setsid는 macOS에 없음)", () => {
    const code = readFileSync(join(ROOT, "packaging/claude-office.sh"), "utf8").split("\n").filter((l) => !l.trim().startsWith("#"));
    const clean = code.filter((l) => l.includes("sleep 30"));
    expect(clean).toHaveLength(1);
    expect(clean[0]).toMatch(/^\s*nohup sh -c 'sleep 30; rm -rf "\$1"' sh "\$d" >\/dev\/null 2>&1 <\/dev\/null &$/);
  });
});
