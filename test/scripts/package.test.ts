import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
      const copy = mkdtempSync(join(tmpdir(), "claude-office-pkgtest-copy-"));
      const appDir = join(copy, "app");
      const { cpSync } = await import("node:fs");
      cpSync(join(RELEASE_DIR, "app"), appDir, { recursive: true });

      const port = await getFreePort();
      const nodeBinDir = dirname(process.execPath);
      const child = spawn(process.execPath, [join(appDir, "server.mjs"), "--port", String(port), "--claude-home", home, "--log-dir", join(copy, "logs")], {
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
        rmSync(copy, { recursive: true, force: true });
      }
    },
    30_000,
  );

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
