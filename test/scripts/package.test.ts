import { beforeAll, describe, expect, inject, it } from "vitest";
import { execFileSync, spawnSync, spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pkgChain, resolveDepPath } from "../../scripts/package-beta.mjs";

// resolveDepPath는 package:beta 전체를 실행하지 않아도 되는 순수 함수라 작은 단위 테스트로 직접
// 확인한다(Task 6 fix round 1 — 스코프 패키지(@scope/pkg) 대응). package-beta.mjs는 이 두 함수를
// import할 때 빌드 파이프라인이 같이 실행되지 않도록 main()을 실행 가드 뒤에 둔다.
describe("resolveDepPath / pkgChain (스코프 패키지, Task 6 fix round 1)", () => {
  it("pkgChain은 스코프 패키지(@scope/pkg)를 세그먼트 하나로 다룬다", () => {
    expect(pkgChain("node_modules/express")).toEqual(["express"]);
    expect(pkgChain("node_modules/@scope/pkg-a")).toEqual(["@scope/pkg-a"]);
    expect(pkgChain("node_modules/body-parser/node_modules/@scope/pkg-b")).toEqual(["body-parser", "@scope/pkg-b"]);
  });

  it("가까운 node_modules부터 위로 올라가며 스코프 의존성을 찾는다(중첩 오버라이드 우선)", () => {
    const pkgs = {
      "node_modules/express": {},
      "node_modules/@scope/pkg-a": {},
      "node_modules/express/node_modules/@scope/pkg-a": {}, // express 전용 오버라이드
    };
    expect(resolveDepPath(pkgs, "node_modules/express", "@scope/pkg-a")).toBe("node_modules/express/node_modules/@scope/pkg-a");
    expect(resolveDepPath(pkgs, "node_modules/other", "@scope/pkg-a")).toBe("node_modules/@scope/pkg-a");
  });

  it("루트에서는 'node_modules/node_modules/...'를 만들지 않는다(회귀 방지)", () => {
    const pkgs = { "node_modules/accepts": {} };
    expect(resolveDepPath(pkgs, "node_modules/express", "accepts")).toBe("node_modules/accepts");
  });

  it("못 찾으면 undefined(호출부가 오류로 처리)", () => {
    expect(resolveDepPath({}, "node_modules/express", "@scope/missing")).toBeUndefined();
  });
});

// T6 fix round 3: main() 안의 process.exit(1) 경로(버전 불일치 등)가 withLock의 try/finally를
// 건너뛰어 락 폴더가 남지 않는지 확인한다. 저장소 파일은 안 바꾸고, 임시 폴더에 스크립트 복사본과
// 최소한의 package.json/plugin.json/marketplace.json만 만들어 그 경로에서 돌린다(느린 전체 빌드가
// 전혀 필요 없다 — 버전 비교에서 바로 exit(1)로 끝난다).
describe("package-beta.mjs의 락이 process.exit(1) 경로에서도 안 남는다(T6 fix round 3)", () => {
  it("버전 불일치로 종료해도 .package-beta.lock이 남지 않는다", () => {
    const tmp = mkdtempSync(join(tmpdir(), "claude-office-pkgbeta-lock-"));
    try {
      mkdirSync(join(tmp, "scripts"), { recursive: true });
      mkdirSync(join(tmp, "plugins/claude-office/.claude-plugin"), { recursive: true });
      mkdirSync(join(tmp, ".claude-plugin"), { recursive: true });
      copyFileSync(fileURLToPath(new URL("../../scripts/package-beta.mjs", import.meta.url)), join(tmp, "scripts/package-beta.mjs"));
      writeFileSync(join(tmp, "package.json"), JSON.stringify({ version: "9.9.9" }));
      writeFileSync(join(tmp, "plugins/claude-office/.claude-plugin/plugin.json"), JSON.stringify({ version: "0.0.1" })); // 일부러 다르게
      writeFileSync(join(tmp, ".claude-plugin/marketplace.json"), JSON.stringify({ plugins: [{ name: "claude-office", version: "0.0.1" }] }));

      const r = spawnSync(process.execPath, [join(tmp, "scripts/package-beta.mjs")], { encoding: "utf8" });
      expect(r.status, r.stdout + r.stderr).toBe(1);
      expect(r.stderr).toContain("버전 불일치");
      expect(existsSync(join(tmp, "release/.package-beta.lock"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// index.ts의 CLI 파서는 포트 0(OS가 알아서 고르는 포트)을 "잘못된 포트"로 거부하므로, 직접 빈 포트
// 하나를 골라 그 번호로 --port를 준다(팀 규칙: 4317·4318 금지, 테스트는 빈 포트).
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

// B14(director #113): child.kill() 직후 바로 rmSync를 부르면, 서버가 종료 로그를 아직 쓰는
// 중이라(서버는 종료할 때 exit 로그를 쓴다) 그 로그 파일이 들어있는 폴더를 지우다 ENOTEMPTY로
// 간헐 실패할 수 있다(리뷰어 실측). kill 신호를 보낸 뒤 "exit" 이벤트까지 기다리고 나서 정리한다.
// 정해진 시간 안에 안 끝나면 SIGKILL로 강제 종료한다(자식이 신호를 무시하는 경우 대비).
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

// 느린 빌드(npm run package:beta)는 vitest globalSetup(test/setup/package-once.ts)에서 전체
// 실행에 한 번만 돈다(director #79 — 테스트 파일마다 beforeAll에서 따로 돌리면 release/ 폴더·
// tar.gz·zip을 서로 지우고 다시 써서 간헐적으로 깨진다, B14). 여기서는 그 결과물만 읽는다.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const VERSION = pkg.version as string;
const RELEASE_DIR = join(ROOT, "release", `claude-office-${VERSION}`);
const TAR = join(ROOT, "release", `claude-office-${VERSION}.tar.gz`);
const ZIP = join(ROOT, "release", `claude-office-${VERSION}.zip`);

let buildError: Error | undefined;

beforeAll(() => {
  // #87(리뷰어 지적): release/에 결과물이 "있기만" 한 걸로는 안 된다 — 파일 경로 없이 -t만으로
  // 걸러서 globalSetup이 빌드를 건너뛴 경우, release/에 예전 버전 결과물이 남아 있으면 그걸로
  // 조용히 통과해 버린다. globalSetup이 실제로 빌드를 끝냈을 때만 provide한 타임스탬프가
  // 있는지로 "이번 실행에서" 빌드됐는지를 확인한다.
  if (inject("packageBuiltAt") == null) {
    buildError = new Error(
      "이번 실행에서 package:beta가 빌드되지 않았습니다 — CLAUDE_OFFICE_FORCE_PACKAGE_BUILD=1로 다시 실행해 주세요.",
    );
  }
});

function requireBuildOk() {
  if (buildError) throw new Error(buildError.message);
}

describe("npm run package:beta", () => {
  it("버전 네 곳이 package.json version과 같다", () => {
    requireBuildOk();
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+-(?:beta\.\d+|dev)$/); // VERSION은 package.json에서 읽는다. 나머지 세 곳이 같은지 본다
    const pluginJson = JSON.parse(readFileSync(join(ROOT, "plugins/claude-office/.claude-plugin/plugin.json"), "utf8"));
    expect(pluginJson.version).toBe(VERSION);
    const marketplace = JSON.parse(readFileSync(join(ROOT, ".claude-plugin/marketplace.json"), "utf8"));
    expect(marketplace.plugins.find((p: { name: string }) => p.name === "claude-office").version).toBe(VERSION);
    expect(readFileSync(join(RELEASE_DIR, "VERSION"), "utf8").trim()).toBe(VERSION);
  });

  it("폴더 구조: 필수 파일이 모두 있다", () => {
    requireBuildOk();
    const required = [
      "app/server.mjs",
      "app/web/index.html",
      "app/node_modules/express/package.json",
      "app/package.json",
      "plugin/.claude-plugin/marketplace.json",
      "plugin/plugins/claude-office/hooks/hooks.json",
      "LICENSE",
      "THIRD_PARTY_NOTICES.md",
      "VERSION",
    ];
    for (const rel of required) expect(existsSync(join(RELEASE_DIR, rel)), rel).toBe(true);
  });

  it("패키지 속 플러그인의 PermissionRequest hook timeout은 600, 나머지는 5(Phase 2)", () => {
    requireBuildOk();
    const f = JSON.parse(readFileSync(join(RELEASE_DIR, "plugin/plugins/claude-office/hooks/hooks.json"), "utf8")) as { hooks: Record<string, Array<{ hooks: Array<{ timeout: number }> }>> };
    for (const [event, groups] of Object.entries(f.hooks)) {
      const timeouts = groups.flatMap((g) => g.hooks.map((h) => h.timeout));
      expect(timeouts, event).toEqual([event === "PermissionRequest" ? 600 : 5]);
    }
  });

  it("app/node_modules에 개발 의존성이 없다", () => {
    requireBuildOk();
    for (const dev of ["vite", "vitest", "tsx", "typescript", "react"]) {
      expect(existsSync(join(RELEASE_DIR, "app/node_modules", dev)), dev).toBe(false);
    }
  });

  it(
    "패키지만으로 서버가 켜진다",
    async () => {
      requireBuildOk();
      const home = mkdtempSync(join(tmpdir(), "claude-office-pkgtest-home-"));
      // release/app을 그대로 복사하지 않고 실제 배포물인 .tar.gz를 풀어서 실행한다(Task 6 fix
      // round 1 Minor 2) — tar 담는 과정 자체의 문제(예: 권한, 심볼릭 링크)도 같이 잡아낸다.
      const extracted = mkdtempSync(join(tmpdir(), "claude-office-pkgtest-extracted-"));
      execFileSync("tar", ["-xzf", TAR, "-C", extracted]);
      const appDir = join(extracted, `claude-office-${VERSION}`, "app");

      const port = await getFreePort();
      const nodeBinDir = dirname(process.execPath);
      const child = spawn(process.execPath, [join(appDir, "server.mjs"), "--port", String(port), "--claude-home", home, "--log-dir", join(extracted, "logs")], {
        env: { PATH: nodeBinDir, HOME: home },
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

        const rootRes = await fetch(`http://127.0.0.1:${port}/`);
        expect(rootRes.status).toBe(200);
        expect(rootRes.headers.get("content-type") ?? "").toContain("text/html");

        // Phase 2(Ruling B51): /api는 토큰이 있어야 한다. PREFIX 없이 켜면 토큰은 풀어 놓은 폴더의 .logs/token에 생긴다
        const noAuth = await fetch(`http://127.0.0.1:${port}/api/snapshot`);
        expect(noAuth.status).toBe(401);
        expect(((await noAuth.json()) as { app?: unknown }).app).toBe("claude-office");
        const token = readFileSync(join(appDir, "..", ".logs", "token"), "utf8").trim();
        expect(/^[0-9a-f]{64}$/.test(token)).toBe(true); // 값은 출력하지 않는다
        const snapRes = await fetch(`http://127.0.0.1:${port}/api/snapshot`, { headers: { Authorization: `Bearer ${token}` } });
        expect(snapRes.status).toBe(200);
        expect(snapRes.headers.get("content-type") ?? "").toContain("application/json");
      } finally {
        await killAndWait(child);
        rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        rmSync(extracted, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    },
    30_000,
  );

  it("tar.gz와 zip 모두 20MB 이하다(메일 첨부 한도, Task 6 fix round 1)", () => {
    requireBuildOk();
    const CAP = 20 * 1024 * 1024;
    expect(statSync(TAR).size).toBeLessThanOrEqual(CAP);
    if (existsSync(ZIP)) expect(statSync(ZIP).size).toBeLessThanOrEqual(CAP);
  });

  it.skipIf(!existsSync(join(ROOT, "packaging/install.ps1")))("zip 안의 .ps1·.cmd는 CRLF, .sh는 LF", () => {
    requireBuildOk();
    const unzipped = mkdtempSync(join(tmpdir(), "claude-office-pkgtest-unzip-"));
    try {
      execFileSync("unzip", ["-o", "-q", ZIP, "-d", unzipped]);
      const base = join(unzipped, `claude-office-${VERSION}`);
      const check = (rel: string, wantCRLF: boolean) => {
        const buf = readFileSync(join(base, rel));
        const hasCRLF = buf.includes(Buffer.from("\r\n"));
        expect(hasCRLF, rel).toBe(wantCRLF);
      };
      if (existsSync(join(base, "install.ps1"))) check("install.ps1", true);
      if (existsSync(join(base, "install.sh"))) check("install.sh", false);
    } finally {
      rmSync(unzipped, { recursive: true, force: true });
    }
  });

  // Task 8 fix round 1(#76) Critical: Windows PowerShell 5.1은 BOM 없는 .ps1을 시스템 코드페이지로
  // 읽어 한글이 깨질 수 있다 — CRLF 변환(toCRLF)이 BOM을 보존하는지 패키지 결과물로 직접 확인한다.
  it.skipIf(!existsSync(join(ROOT, "packaging/install.ps1")))("zip 안의 .ps1 두 개는 UTF-8 BOM을 유지한다", () => {
    requireBuildOk();
    const unzipped = mkdtempSync(join(tmpdir(), "claude-office-pkgtest-unzip-bom-"));
    try {
      execFileSync("unzip", ["-o", "-q", ZIP, "-d", unzipped]);
      const base = join(unzipped, `claude-office-${VERSION}`);
      for (const rel of ["install.ps1", "claude-office.ps1"]) {
        const buf = readFileSync(join(base, rel));
        expect([...buf.subarray(0, 3)], rel).toEqual([0xef, 0xbb, 0xbf]);
      }
    } finally {
      rmSync(unzipped, { recursive: true, force: true });
    }
  });

  // FB-3(사용자 피드백, 2026-10-01): macOS 기본 `zip -qr`은 파일 이름에 UTF-8 플래그(EFS,
  // bit 11 = 0x800)를 안 켜서, 한국어 Windows의 탐색기·PowerShell 5.1 Expand-Archive가
  // "사용설명서.html"을 시스템 코드페이지로 잘못 해석해 이름이 깨질 수 있었다(실측: flag_bits가
  // 전부 0x0). package-beta.mjs를 python3 -m zipfile로 바꿔 비-ASCII 이름에 이 플래그가 자동으로
  //켜지는지 zip 결과물로 직접 확인한다.
  it.skipIf(!existsSync(join(ROOT, "packaging/install.ps1")))("zip 안 사용설명서.html 항목의 flag_bits에 UTF-8 플래그(0x800)가 있다(FB-3)", () => {
    requireBuildOk();
    const script = [
      "import zipfile, sys",
      "z = zipfile.ZipFile(sys.argv[1])",
      'print(next(i.flag_bits for i in z.infolist() if i.filename.endswith("사용설명서.html")))',
    ].join("\n");
    const out = execFileSync("python3", ["-c", script, ZIP], { encoding: "utf8" });
    expect(Number(out.trim()) & 0x800, `flag_bits=${out.trim()}`).toBe(0x800);
  });

  // #77: 저장소 원본뿐 아니라 tar.gz 안의 .ps1도 BOM이 있어야 한다(team-lead Ruling B16 — BOM이
  // 가장 먼저). tar.gz는 CRLF 변환을 안 거치지만(.sh용 LF 그대로 보존), 그래도 원본 그대로 BOM이
  // 보존되는지 직접 확인한다.
  it.skipIf(!existsSync(join(ROOT, "packaging/install.ps1")))("tar.gz 안의 .ps1 두 개도 UTF-8 BOM을 유지한다", () => {
    requireBuildOk();
    const extracted = mkdtempSync(join(tmpdir(), "claude-office-pkgtest-tar-bom-"));
    try {
      execFileSync("tar", ["-xzf", TAR, "-C", extracted]);
      const base = join(extracted, `claude-office-${VERSION}`);
      for (const rel of ["install.ps1", "claude-office.ps1"]) {
        const buf = readFileSync(join(base, rel));
        expect([...buf.subarray(0, 3)], rel).toEqual([0xef, 0xbb, 0xbf]);
      }
    } finally {
      rmSync(extracted, { recursive: true, force: true });
    }
  });

  it("tar.gz 안에 .map·.test.·.env 파일이 없다", () => {
    requireBuildOk();
    const out = execFileSync("tar", ["-tzf", TAR]).toString();
    const names = out.split("\n").filter(Boolean);
    for (const n of names) {
      expect(n.endsWith(".map"), n).toBe(false);
      expect(n.includes(".test."), n).toBe(false);
      expect(n.endsWith(".env"), n).toBe(false);
    }
  });
});
