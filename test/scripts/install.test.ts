import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
const NODE_DIR = dirname(process.execPath);

let buildError: Error | undefined;
let releaseAppDir: string; // .tar.gz를 풀어 만든 실제 배포물 폴더(app/plugin/install.sh/claude-office.sh가 이 안에 있음) — T6 규칙대로 release/app을 직접 쓰지 않는다.

beforeAll(() => {
  try {
    execFileSync("npm", ["run", "package:beta"], { cwd: ROOT, stdio: "pipe", timeout: 110_000 });
    const extracted = mkdtempSync(join(tmpdir(), "claude-office-installtest-pkg-"));
    execFileSync("tar", ["-xzf", join(ROOT, "release", `claude-office-${VERSION}.tar.gz`), "-C", extracted]);
    releaseAppDir = join(extracted, `claude-office-${VERSION}`);
  } catch (e) {
    buildError = e as Error;
  }
}, 120_000);

function requireBuildOk() {
  if (buildError) throw new Error(`package:beta 실패: ${buildError.message}`);
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

interface Rig {
  home: string;
  stubBin: string;
  stubLog: string;
  cleanup: () => void;
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
  return { home, stubBin, stubLog, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function env(rig: Rig, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // LANG을 한국어 UTF-8로 고정한다 — 이 앱 사용자 다수가 이 로케일을 쓰고, 옛 bash(macOS 기본 /bin/sh는
  // bash 3.2)가 이 로케일에서 "$VAR가나다" 같은 표현을 변수 이름 경계를 잘못 잡아 파싱하는 문제가
  // 실제로 있었다(install.sh의 "$RC에" → "${RC}에"로 고친 회귀). 이 로케일로 고정해야 그 버그가
  // 재발하면 테스트가 다시 잡아낸다.
  return { HOME: rig.home, PATH: `${rig.stubBin}:${NODE_DIR}:/usr/bin:/bin`, STUB_LOG: rig.stubLog, SHELL: "/bin/zsh", LANG: "ko_KR.UTF-8", ...extra };
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
  const re = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z (node|copy|path|plugin|doctor|done) (ok|fail|skip)( .*)?$/;
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
      expect(log[0]).toBe(`plugin marketplace add ${prefix}/plugin`);
      expect(log[1]).toBe("plugin install claude-office@claude-office --scope user");
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
      const rc1 = readFileSync(join(rig.home, ".zshrc"), "utf8");
      expect(rc1.split("\n").filter((l) => l === "# claude-office PATH")).toHaveLength(1);
      expect(rc1).toContain(`export PATH="${prefix}/bin:$PATH"`);
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
          child.kill();
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
});
