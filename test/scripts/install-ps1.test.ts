import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// 이 Mac에는 PowerShell이 없어 정적 검사만 한다(brief 지시). pwsh가 있으면 문법 검사도 추가한다.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const INSTALL_PS1 = join(ROOT, "packaging/install.ps1");
const LAUNCHER_PS1 = join(ROOT, "packaging/claude-office.ps1");
const LAUNCHER_CMD = join(ROOT, "packaging/claude-office.cmd");

const hasPwsh = spawnSync("pwsh", ["-v"], { stdio: "ignore" }).status === 0;

describe("packaging/install.ps1, claude-office.ps1/.cmd (Task 8, 베타 미검증)", () => {
  it("세 파일이 모두 있다", () => {
    expect(existsSync(INSTALL_PS1)).toBe(true);
    expect(existsSync(LAUNCHER_PS1)).toBe(true);
    expect(existsSync(LAUNCHER_CMD)).toBe(true);
  });

  it("베타 미검증 안내 주석이 있다", () => {
    for (const f of [INSTALL_PS1, LAUNCHER_PS1, LAUNCHER_CMD]) {
      expect(readFileSync(f, "utf8"), f).toContain("베타 미검증: Windows 실제 설치 확인 전입니다(스펙 12장)");
    }
  });

  it("install.ps1에 -Prefix, -Yes, -NoPath, -NoOpen 파라미터가 선언돼 있다", () => {
    const text = readFileSync(INSTALL_PS1, "utf8");
    expect(text).toMatch(/\[string\]\$Prefix/);
    expect(text).toMatch(/\[switch\]\$Yes/);
    expect(text).toMatch(/\[switch\]\$NoPath/);
    expect(text).toMatch(/\[switch\]\$NoOpen/);
  });

  it("PATH는 User 범위만 쓰고 Machine 범위는 건드리지 않는다", () => {
    for (const f of [INSTALL_PS1, LAUNCHER_PS1]) {
      const text = readFileSync(f, "utf8");
      // 괄호가 중첩(예: "-join \";\"")될 수 있어 정규식으로 호출 전체를 자르지 않고, 그 호출이
      // 포함된 줄 단위로 "User"/"Machine" 여부를 본다.
      const pathLines = text.split("\n").filter((l) => l.includes("[Environment]::") && l.includes("EnvironmentVariable") && l.includes('"Path"'));
      expect(pathLines.length, text).toBeGreaterThan(0);
      for (const line of pathLines) {
        expect(line, line).toContain('"User"');
        expect(line, line).not.toContain('"Machine"');
      }
      expect(text).not.toContain('"Machine"');
    }
  });

  it("플러그인 명령 문자열이 install.sh/claude-office.sh와 같다", () => {
    const installSh = readFileSync(join(ROOT, "packaging/install.sh"), "utf8");
    const launcherSh = readFileSync(join(ROOT, "packaging/claude-office.sh"), "utf8");
    const installPs1 = readFileSync(INSTALL_PS1, "utf8");
    const launcherPs1 = readFileSync(LAUNCHER_PS1, "utf8");

    for (const cmd of ["plugin marketplace add", "plugin install claude-office@claude-office --scope user"]) {
      expect(installSh, cmd).toContain(cmd);
      expect(installPs1, cmd).toContain(cmd);
    }
    for (const cmd of ["plugin uninstall claude-office@claude-office --scope user", "plugin marketplace remove claude-office"]) {
      expect(launcherSh, cmd).toContain(cmd);
      expect(launcherPs1, cmd).toContain(cmd);
    }
  });

  it("Node 24 검사 문구가 있다", () => {
    for (const f of [INSTALL_PS1, LAUNCHER_PS1]) {
      const text = readFileSync(f, "utf8");
      expect(text, f).toContain("Node.js 24 이상이 필요합니다");
    }
  });

  it("Remove-Item의 대상이 모두 $Prefix 아래다", () => {
    const text = readFileSync(LAUNCHER_PS1, "utf8");
    const lines = text.split("\n").filter((l) => l.includes("Remove-Item"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      // "(Join-Path $Prefix ...)" 또는 변수 자체가 $Prefix(uninstall 끝의 prefix 폴더 삭제)여야 한다.
      expect(line, line).toMatch(/\(Join-Path \$Prefix |Remove-Item[^\n]*\$Prefix\b/);
    }
  });

  it("사용설명서 안내는 6장(문제가 생겼을 때)을 가리킨다", () => {
    const text = readFileSync(INSTALL_PS1, "utf8");
    expect(text).toContain("사용설명서 6장(문제가 생겼을 때)");
    expect(text).not.toContain("사용설명서 5장");
  });

  it("claude-office.cmd는 claude-office.ps1을 ExecutionPolicy Bypass로 부른다", () => {
    const text = readFileSync(LAUNCHER_CMD, "utf8");
    expect(text).toContain("powershell");
    expect(text).toContain("-ExecutionPolicy Bypass");
    expect(text).toContain("claude-office.ps1");
  });

  it("statusline을 다루지 않는다(B12, 베타 미지원)", () => {
    for (const f of [INSTALL_PS1, LAUNCHER_PS1, LAUNCHER_CMD]) {
      expect(readFileSync(f, "utf8").toLowerCase(), f).not.toContain("statusline");
    }
  });

  it.skipIf(!hasPwsh)("pwsh ParseFile 문법 검사를 통과한다", () => {
    for (const f of [INSTALL_PS1, LAUNCHER_PS1]) {
      const script = `
        $errors = $null
        [System.Management.Automation.Language.Parser]::ParseFile('${f}', [ref]$null, [ref]$errors) | Out-Null
        if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_ }; exit 1 }
        exit 0
      `;
      const r = spawnSync("pwsh", ["-NoProfile", "-Command", script], { encoding: "utf8" });
      expect(r.status, `${f}: ${r.stderr}`).toBe(0);
    }
  });
});
