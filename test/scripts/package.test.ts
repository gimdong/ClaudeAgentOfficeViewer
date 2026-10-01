import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync, spawn } from "node:child_process";
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

// 느린 테스트: npm run package:beta를 한 번 돌려서 웹 빌드·서버 번들·release/ 폴더·tar.gz·zip을
// 전부 만든 뒤 그 결과물만 검사한다(director 지시: package:beta는 beforeAll에서 한 번만 실행).
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const VERSION = pkg.version as string;
const RELEASE_DIR = join(ROOT, "release", `claude-office-${VERSION}`);
const TAR = join(ROOT, "release", `claude-office-${VERSION}.tar.gz`);
const ZIP = join(ROOT, "release", `claude-office-${VERSION}.zip`);

let buildError: Error | undefined;

beforeAll(() => {
  try {
    execFileSync("npm", ["run", "package:beta"], { cwd: ROOT, stdio: "pipe", timeout: 110_000 });
  } catch (e) {
    buildError = e as Error;
  }
}, 120_000);

function requireBuildOk() {
  if (buildError) throw new Error(`package:beta 실패: ${buildError.message}`);
}

describe("npm run package:beta", () => {
  it("버전 네 곳이 2.0.0-beta.1", () => {
    requireBuildOk();
    expect(VERSION).toBe("2.0.0-beta.1");
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

        const snapRes = await fetch(`http://127.0.0.1:${port}/api/snapshot`);
        expect(snapRes.status).toBe(200);
        expect(snapRes.headers.get("content-type") ?? "").toContain("application/json");
      } finally {
        child.kill();
        rmSync(home, { recursive: true, force: true });
        rmSync(extracted, { recursive: true, force: true });
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
