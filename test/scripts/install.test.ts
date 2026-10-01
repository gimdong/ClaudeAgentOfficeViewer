import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
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
const NODE_ONLY_DIR = mkdtempSync(join(tmpdir(), "claude-office-installtest-node-only-"));
symlinkSync(process.execPath, join(NODE_ONLY_DIR, "node"));

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
  const re = /^\S+ (node|copy|path|plugin|doctor|done) (ok|fail|skip)( .*)?$/;
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
      // install.sh가 이제 pwd -P로 정규화해서(T7 fix round 2) macOS의 /var -> /private/var 같은
      // 심볼릭 링크를 실제 물리 경로로 바꿔 쓴다 — mkdtemp가 돌려준 그대로가 아니라 realpath와 비교한다.
      const realPrefix = realpathSync(prefix);
      expect(log[0]).toBe(`plugin marketplace add ${realPrefix}/plugin`);
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
        writeFileSync(join(rig.stubBin, "open"), '#!/bin/sh\necho "open $@" >> "$STUB_LOG"\n');
        chmodSync(join(rig.stubBin, "open"), 0o755);

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
          await new Promise((r) => setTimeout(r, 1500)); // 런처의 "(sleep 1; open ...) &" 기다림
          const log = readFileSync(rig.stubLog, "utf8");
          expect(log).toContain(`open http://127.0.0.1:${port}/`);
        } finally {
          child.kill();
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
});
