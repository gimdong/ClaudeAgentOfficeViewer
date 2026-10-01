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

  // #76 Important: [Environment]::Get/SetEnvironmentVariable("Path","User")는 %VAR% 참조를
  // 펼친 값을 돌려주고 쓸 때도 항상 REG_SZ로 써서, 원래 REG_EXPAND_SZ였던 사용자 PATH의 형식을
  // 깨 버린다. 레지스트리(HKCU:\Environment)를 직접 Get-Item/Set-ItemProperty로 다뤄야 한다.
  it("PATH는 레지스트리(HKCU:\\Environment)를 ExpandString으로 다루고, Machine은 건드리지 않는다", () => {
    for (const f of [INSTALL_PS1, LAUNCHER_PS1]) {
      const text = readFileSync(f, "utf8");
      expect(text, f).toContain('Get-Item "HKCU:\\Environment"');
      expect(text, f).toContain("DoNotExpandEnvironmentNames");
      expect(text, f).toContain('Set-ItemProperty -Path "HKCU:\\Environment" -Name "Path"');
      expect(text, f).toContain("-Type ExpandString");
      expect(text, f).not.toContain('"Machine"');
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
    // 주석 줄(한글 설명에 "Remove-Item"이라는 글자가 그대로 들어갈 수 있다)은 빼고 실제 코드 줄만 본다.
    const lines = text.split("\n").filter((l) => !l.trim().startsWith("#") && l.includes("Remove-Item"));
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

  // #59(Ruling B13): T7의 uninstall 안전장치를 install.ps1/claude-office.ps1에도 처음부터 넣는다.
  it("claude-office.ps1은 $PSCommandPath의 심볼릭 링크·정션을 실제 경로로 풀고 나서 $Prefix를 정한다", () => {
    const text = readFileSync(LAUNCHER_PS1, "utf8");
    expect(text).toContain("Resolve-RealPath");
    expect(text).toContain(".Target");
    const resolveIdx = text.indexOf("function Resolve-RealPath");
    const prefixIdx = text.indexOf("$Prefix = Split-Path");
    expect(resolveIdx).toBeGreaterThan(-1);
    expect(prefixIdx).toBeGreaterThan(resolveIdx); // $Prefix 계산이 풀기 함수 정의보다 뒤에 와야 쓸 수 있다
  });

  it("claude-office.ps1은 지우기(Remove-Item) 전에 app\\server.mjs·VERSION이 있는지 확인한다", () => {
    const text = readFileSync(LAUNCHER_PS1, "utf8");
    const checkIdx = text.indexOf('Test-Path -LiteralPath (Join-Path $Prefix "app\\server.mjs")');
    // 주석 줄은 빼고 실제 코드에서 처음 나오는 Remove-Item 위치를 본다(한글 설명에 "Remove-Item"
    // 글자가 그대로 들어갈 수 있어 text.indexOf만 쓰면 주석에 걸릴 수 있다).
    const codeLines = text.split("\n");
    let firstRemoveOffset = -1;
    let offset = 0;
    for (const line of codeLines) {
      if (!line.trim().startsWith("#") && line.includes("Remove-Item") && firstRemoveOffset === -1) firstRemoveOffset = offset;
      offset += line.length + 1;
    }
    expect(checkIdx).toBeGreaterThan(-1);
    expect(text).toContain('Test-Path -LiteralPath (Join-Path $Prefix "VERSION")');
    expect(firstRemoveOffset).toBeGreaterThan(checkIdx); // 확인이 모든 Remove-Item보다 앞서야 한다
  });

  it("빈 값·드라이브 루트(C:\\)·%USERPROFILE% 자체를 -Prefix와 삭제 대상에서 거부한다", () => {
    for (const f of [INSTALL_PS1, LAUNCHER_PS1]) {
      const text = readFileSync(f, "utf8");
      expect(text, f).toMatch(/\^\[A-Za-z\]:\\\\\?\$/); // 드라이브 루트 패턴(C:\ 또는 C:)
      expect(text, f).toContain("USERPROFILE");
      expect(text, f).toMatch(/IsNullOrWhiteSpace|IsNullOrEmpty/);
    }
  });

  it("PATH 비교는 대소문자와 끝의 \"\\\" 차이를 같은 항목으로 본다", () => {
    for (const f of [INSTALL_PS1, LAUNCHER_PS1]) {
      const text = readFileSync(f, "utf8");
      expect(text, f).toContain("ToLowerInvariant");
      expect(text, f).toContain("TrimEnd('\\')");
    }
  });

  // T7 fix round 2 / #69·#73(Ruling B15): -Prefix·%USERPROFILE%을 글자 그대로 비교하면 끝에 "\"가
  // 붙거나 대소문자가 다른 표기가 거부를 피해간다. #76 Minor 4(reviewer 정정): Resolve-Path는 경로
  // 문법만 정규화할 뿐 심볼릭 링크·정션을 실제 대상으로 바꿔 주지 않는다 — Get-Item의 .Target을
  // 재귀적으로 따라가는 Resolve-RealPath로 풀어야 한다. 없는 경로는 GetFullPath로 정규화한다.
  it("Normalize-InstallPath는 Resolve-RealPath(.Target)로 링크를 풀고, 없는 경로는 GetFullPath를 쓴다(B15)", () => {
    for (const f of [INSTALL_PS1, LAUNCHER_PS1]) {
      const text = readFileSync(f, "utf8");
      expect(text, f).toContain("function Normalize-InstallPath");
      expect(text, f).toContain("function Resolve-RealPath");
      expect(text, f).toContain(".Target");
      expect(text, f).toContain("[System.IO.Path]::GetFullPath");
      // Normalize-InstallPath가 실제로 Resolve-RealPath를 거쳐서 정규화하는지 확인한다.
      const fnStart = text.indexOf("function Normalize-InstallPath");
      const fnBody = text.slice(fnStart, fnStart + 200);
      expect(fnBody, f).toContain("Resolve-RealPath");
      // Resolve-RealPath 자체는 링크면(.Target 있으면) 재귀하고, 없으면 GetFullPath로 떨어진다.
      const resolveStart = text.indexOf("function Resolve-RealPath");
      const resolveBody = text.slice(resolveStart, resolveStart + 500);
      const targetIdx = resolveBody.indexOf(".Target");
      const getFullPathIdx = resolveBody.indexOf("GetFullPath");
      expect(getFullPathIdx, resolveBody).toBeGreaterThan(targetIdx); // GetFullPath는 링크가 아닐 때의 마지막 수단
    }
  });

  it("install.ps1은 Normalize-InstallPath로 $Prefix와 %USERPROFILE%을 비교한 뒤에야 쓴다", () => {
    const text = readFileSync(INSTALL_PS1, "utf8");
    expect(text).toContain("$NormPrefix = Normalize-InstallPath $Prefix");
    expect(text).toContain("$NormUserProfile = Normalize-InstallPath $env:USERPROFILE");
    expect(text).toContain("$NormPrefix -ieq $NormUserProfile");
  });

  it("이미 다른 파일이 있는 폴더(VERSION 없음)에는 설치를 거부한다(B15)", () => {
    const text = readFileSync(INSTALL_PS1, "utf8");
    expect(text).toContain("이미 다른 파일이 있는 폴더입니다. 빈 폴더나 새 폴더 이름을 지정해 주세요.");
    expect(text).toMatch(/Get-ChildItem.*\$Prefix/);
    expect(text).toContain('Test-Path -LiteralPath (Join-Path $Prefix "VERSION")');
  });

  // #76 Critical: Windows PowerShell 5.1(.cmd가 부르는 그것)은 BOM 없는 .ps1을 시스템 코드페이지
  // (한국어는 CP949)로 읽어, 안의 한글·큰따옴표가 깨지고 파싱이 실패할 수 있다.
  it("install.ps1·claude-office.ps1은 UTF-8 BOM(EF BB BF)으로 시작한다", () => {
    for (const f of [INSTALL_PS1, LAUNCHER_PS1]) {
      const buf = readFileSync(f);
      expect([...buf.subarray(0, 3)], f).toEqual([0xef, 0xbb, 0xbf]);
    }
  });

  it("claude-office.cmd의 첫 줄은 @echo off다", () => {
    const text = readFileSync(LAUNCHER_CMD, "utf8");
    expect(text.split(/\r?\n/)[0]).toBe("@echo off");
  });

  // #76 Important: claude plugin 호출이 stderr에 한 줄이라도 쓰면 $ErrorActionPreference = "Stop"과
  // 겹쳐 uninstall이 거기서 멈출 수 있다 — try/catch로 감싸거나 그 구간만 EAP를 Continue로 둔다.
  it("uninstall의 claude plugin 호출은 try/catch로 감싸거나 그 구간만 EAP를 Continue로 둔다", () => {
    const text = readFileSync(LAUNCHER_PS1, "utf8");
    const uninstallIdx = text.indexOf('"uninstall"');
    const claudeCallIdx = text.indexOf("plugin uninstall claude-office@claude-office");
    expect(uninstallIdx).toBeGreaterThan(-1);
    expect(claudeCallIdx).toBeGreaterThan(uninstallIdx);
    const nearby = text.slice(Math.max(0, claudeCallIdx - 300), claudeCallIdx);
    expect(nearby).toMatch(/try\s*\{|\$ErrorActionPreference\s*=\s*"Continue"/);
  });

  it("uninstall 끝의 $Prefix 삭제는 비어 있을 때만 시도한다(확인 질문으로 멈추지 않게)", () => {
    const text = readFileSync(LAUNCHER_PS1, "utf8");
    const lastRemovePrefixIdx = text.lastIndexOf("-LiteralPath $Prefix");
    expect(lastRemovePrefixIdx).toBeGreaterThan(-1);
    const before = text.slice(Math.max(0, lastRemovePrefixIdx - 200), lastRemovePrefixIdx);
    expect(before).toMatch(/Get-ChildItem.*Count.*-eq 0|Count\)\s*-eq\s*0/s);
  });

  it("런처가 --port=5000 형식도 알아본다(Minor)", () => {
    const text = readFileSync(LAUNCHER_PS1, "utf8");
    expect(text).toMatch(/--port=\*/);
  });

  it("오류 출력은 Write-Error 대신 [Console]::Error.WriteLine과 exit 1을 쓴다", () => {
    for (const f of [INSTALL_PS1, LAUNCHER_PS1]) {
      const text = readFileSync(f, "utf8");
      // 코드 줄만 본다 — 주석에는 "왜 Write-Error를 안 쓰는지" 설명하느라 그 글자가 그대로 들어간다.
      const codeLines = text.split("\n").filter((l) => !l.trim().startsWith("#"));
      expect(codeLines.some((l) => l.includes("Write-Error")), f).toBe(false);
      expect(text, f).toContain("[Console]::Error.WriteLine");
    }
  });

  it("경로를 다루는 Test-Path·Get-Item·Remove-Item은 -LiteralPath를 쓴다([ ] 같은 와일드카드 문자 대응)", () => {
    for (const f of [INSTALL_PS1, LAUNCHER_PS1]) {
      const text = readFileSync(f, "utf8");
      const lines = text.split("\n").filter((l) => !l.trim().startsWith("#"));
      for (const line of lines) {
        if (/\bTest-Path\s*\(/.test(line) || /\bRemove-Item\s/.test(line)) {
          expect(line, line).toContain("-LiteralPath");
        }
      }
    }
  });

  it("설치 로그는 Add-Content -Encoding UTF8로 쓴다(Minor)", () => {
    const text = readFileSync(INSTALL_PS1, "utf8");
    expect(text).toMatch(/Add-Content[^\n]*-Encoding UTF8/);
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
