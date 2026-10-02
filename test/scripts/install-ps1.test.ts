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
  it("PATH는 레지스트리(HKCU:\\Environment)를 원래 종류로 다루고, Machine은 건드리지 않는다", () => {
    for (const f of [INSTALL_PS1, LAUNCHER_PS1]) {
      const text = readFileSync(f, "utf8");
      expect(text, f).toContain('Get-Item "HKCU:\\Environment"');
      expect(text, f).toContain("DoNotExpandEnvironmentNames");
      expect(text, f).toContain('Set-ItemProperty -Path "HKCU:\\Environment" -Name "Path"');
      // #77: 값의 종류(REG_SZ/REG_EXPAND_SZ)를 유지해서 쓴다 — 리터럴 "-Type ExpandString"이
      // 아니라 GetValueKind로 구한 $kind를 그대로 넘긴다(값이 없던 경우에만 ExpandString 기본값).
      expect(text, f).toContain("-Type $kind");
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

  // #77 Important: 값이 실제로 안 바뀌면(설치에서 이미 등록된 경우, 제거에서 우리 항목이 PATH에
  // 없던 경우) PATH를 다시 쓰지 않는다. 쓸 때는 원래 종류(GetValueKind)를 유지하고, 값이 아예
  // 없던 경우에만 ExpandString으로 만든다.
  it("PATH는 변경이 없으면 다시 쓰지 않고, 쓸 때는 원래 레지스트리 종류(GetValueKind)를 유지한다(#77)", () => {
    for (const f of [INSTALL_PS1, LAUNCHER_PS1]) {
      const text = readFileSync(f, "utf8");
      expect(text, f).toContain("GetValueKind");
      expect(text, f).toMatch(/if\s*\(\$NewValue\s+-eq\s+\$OldValue\)\s*\{\s*return\s*\}/);
      expect(text, f).toContain("[Microsoft.Win32.RegistryValueKind]::ExpandString");
    }
  });

  // #77 Important: claude plugin 호출 두 줄은 각각 따로 오류를 처리해야 한다 — 하나가 실패해도
  // 나머지(두 번째 호출, PATH 정리, 파일 삭제)는 계속돼야 한다. 하나의 try로 둘 다 묶으면 첫
  // 호출이 던질 때 두 번째 호출이 아예 시도되지 않는다.
  it("uninstall의 claude plugin 호출 두 줄은 각각 따로 try로 감싼다(#77)", () => {
    const text = readFileSync(LAUNCHER_PS1, "utf8");
    const uninstallLine = text.split("\n").find((l) => l.includes("plugin uninstall claude-office@claude-office"));
    const removeLine = text.split("\n").find((l) => l.includes("plugin marketplace remove claude-office"));
    expect(uninstallLine, text).toMatch(/^\s*try\s*\{.*\}\s*catch/);
    expect(removeLine, text).toMatch(/^\s*try\s*\{.*\}\s*catch/);
  });

  // #77 Minor: 확인 질문으로 멈출 수 있는 모든 변경 cmdlet에 -Confirm:$false를 둔다.
  it("Remove-Item·Set-ItemProperty·New-Item은 모두 -Confirm:$false를 쓴다(#77)", () => {
    for (const f of [INSTALL_PS1, LAUNCHER_PS1]) {
      const text = readFileSync(f, "utf8");
      const lines = text.split("\n").filter((l) => !l.trim().startsWith("#"));
      for (const line of lines) {
        if (/\b(Remove-Item|Set-ItemProperty|New-Item)\b/.test(line)) {
          expect(line, `${f}: ${line}`).toContain("-Confirm:$false");
        }
      }
    }
  });

  // #78/B17(SPEC 3장): sh와 ps1의 문구는 글자까지 같아야 한다(경로 표기만 OS에 맞게 다름).
  it("SPEC 3장 안내 문구가 install.sh/claude-office.sh와 글자까지 같다(B17)", () => {
    const installSh = readFileSync(join(ROOT, "packaging/install.sh"), "utf8");
    const launcherSh = readFileSync(join(ROOT, "packaging/claude-office.sh"), "utf8");
    const installPs1 = readFileSync(INSTALL_PS1, "utf8");
    const launcherPs1 = readFileSync(LAUNCHER_PS1, "utf8");

    const serverMsg = "이 창을 닫으면 대시보드가 꺼집니다.";
    expect(launcherSh).toContain(serverMsg);
    expect(launcherPs1).toContain(serverMsg);

    const pathHint = "다음부터는 이렇게 켜세요: ";
    expect(installSh).toContain(pathHint);
    expect(installPs1).toContain(pathHint);

    const consentQ = "Claude Code에서 claude-office 플러그인도 지울까요?";
    expect(launcherSh).toContain(consentQ);
    expect(launcherPs1).toContain(consentQ);

    const keptMsg = "플러그인은 남겨 두었습니다. 지우려면: claude plugin uninstall claude-office@claude-office --scope user";
    expect(launcherSh).toContain(keptMsg);
    expect(launcherPs1).toContain(keptMsg);

    const doneMsg = "제거를 마쳤습니다.";
    expect(launcherSh).toContain(doneMsg);
    expect(launcherPs1).toContain(doneMsg);
    expect(launcherSh).toContain("지움:");
    expect(launcherPs1).toContain("지움:");
    expect(launcherSh).toContain("남김:");
    expect(launcherPs1).toContain("남김:");

    // #82(qa 발견, B19): 두 질문(플러그인·logs)과 무관하게 항상 지워지는 것들은 "지움"에 항상
    // 들어가야 한다 — "프로그램 파일"은 무조건, "PATH 설정"은 실제로 지워졌을 때만.
    const programFiles = "프로그램 파일";
    const pathSetting = "PATH 설정";
    expect(launcherSh).toContain(programFiles);
    expect(launcherPs1).toContain(programFiles);
    expect(launcherSh).toContain(pathSetting);
    expect(launcherPs1).toContain(pathSetting);
    // "지움"은 "프로그램 파일"로 시작해서 무조건 들어간다(두 질문에 다 아니오여도 빠지면 안 된다).
    expect(launcherSh).toMatch(/removed="프로그램 파일"/);
    expect(launcherPs1).toMatch(/\$removed\.Add\("프로그램 파일"\)/);

    // FB-1(사용자 피드백): 입력을 못 받는 환경(비TTY)에서 --yes 없이 돌리면 끝에 안내한다.
    // uninstall은 sh/ps1 글자까지 같다 — claude-office.ps1의 런처가 "--yes"를 원시 문자열로
    // 직접 보기 때문이다(install.ps1의 [switch]$Yes와 다름). install은 플래그 표기만 다르다
    // (#115 Important, 리뷰어 지적): install.ps1은 [switch]$Yes라서 "--yes"를 쓰면 매개변수로
    // 안 먹히고 첫 위치 매개변수($Prefix)로 들어가 엉뚱한 폴더에 설치하려 든다 — 그래서
    // install.ps1만 "-Yes"로 안내해야 한다.
    const blockedPrefix = "입력을 받을 수 없어 '아니오'로 처리했습니다. ";
    const installHintSh = `${blockedPrefix}설치하려면 --yes를 붙여 다시 실행하세요.`;
    const installHintPs1 = `${blockedPrefix}설치하려면 -Yes를 붙여 다시 실행하세요.`;
    const uninstallHint = `${blockedPrefix}제거하려면 --yes를 붙여 다시 실행하세요.`;
    expect(installSh).toContain(installHintSh);
    expect(installPs1).toContain(installHintPs1);
    expect(installPs1).not.toContain(installHintSh); // "--yes"로 잘못 안내하면 안 된다
    expect(launcherSh).toContain(uninstallHint);
    expect(launcherPs1).toContain(uninstallHint);
  });

  // FB-1: 입력 차단 감지 자체가 sh는 [ -t 0 ], ps1은 [Console]::IsInputRedirected를 쓰는지 확인한다.
  it("FB-1: 입력 차단 감지는 sh가 [ -t 0 ], ps1이 [Console]::IsInputRedirected를 쓴다", () => {
    const installSh = readFileSync(join(ROOT, "packaging/install.sh"), "utf8");
    const launcherSh = readFileSync(join(ROOT, "packaging/claude-office.sh"), "utf8");
    const installPs1 = readFileSync(INSTALL_PS1, "utf8");
    const launcherPs1 = readFileSync(LAUNCHER_PS1, "utf8");
    for (const f of [installSh, launcherSh]) expect(f).toMatch(/if \[ -t 0 \]; then STDIN_TTY=1/);
    for (const f of [installPs1, launcherPs1]) expect(f).toContain("[Console]::IsInputRedirected");
  });

  // #115 Minor → B65: FB-1 안내는 실제로 물었는데 읽기가 EOF로 끊겨 아니오가 됐을 때만 세운다(파이프로 y·n을 답하면 안 나온다).
  // 안내 조건에 EOF 표시(EOF_NO / $EofNo)가 들어가는지, 그 표시가 읽기 실패에서만 세워지는지 확인한다(sh·ps1 같은 구조).
  it("B65: FB-1 안내는 읽기가 EOF로 끊겨 아니오가 됐을 때만(EOF_NO/$EofNo) 나온다", () => {
    const installSh = readFileSync(join(ROOT, "packaging/install.sh"), "utf8");
    const launcherSh = readFileSync(join(ROOT, "packaging/claude-office.sh"), "utf8");
    const installPs1 = readFileSync(INSTALL_PS1, "utf8");
    const launcherPs1 = readFileSync(LAUNCHER_PS1, "utf8");

    expect(installSh).toMatch(/STDIN_TTY"\s*=\s*0\s*\]\s*&&\s*\[\s*"\$YES"\s*=\s*0\s*\]\s*&&\s*\[\s*"\$EOF_NO"\s*=\s*1\s*\]/);
    expect(launcherSh).toMatch(/STDIN_TTY"\s*=\s*0\s*\]\s*&&\s*\[\s*"\$UYES"\s*=\s*0\s*\]\s*&&\s*\[\s*"\$EOF_NO"\s*=\s*1\s*\]/);
    expect(installPs1).toMatch(/\$InputBlocked\s+-and\s+-not\s+\$Yes\s+-and\s+\$EofNo/);
    expect(launcherPs1).toMatch(/\$UninstallInputBlocked\s+-and\s+-not\s+\$UYes\s+-and\s+\$EofNo/);

    // 읽기가 실패하고 읽은 글자도 없을 때만 세운다(마지막 줄에 줄바꿈 없이 "y"만 온 경우는 답으로 본다)
    for (const f of [installSh, launcherSh]) expect(f).toContain('read -r a || { [ -n "${a:-}" ] || EOF_NO=1; }');
    for (const f of [installPs1, launcherPs1]) {
      expect(f).toContain("[Console]::In.ReadLine()");
      expect(f).toMatch(/if \(\$null -eq \$a\) \{ \$script:EofNo = \$true; return \$false \}/);
    }
    // 예전 "물었으면 안내" 표시는 남지 않는다
    for (const f of [installSh, launcherSh]) expect(f).not.toMatch(/\bASKED=1/);
    for (const f of [installPs1, launcherPs1]) expect(f).not.toMatch(/\$script:(Uninstall)?Asked\s*=/);
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

  // ───────── Phase 2 Task 11: 대시보드 토큰 ─────────
  it("install.ps1(정적): RandomNumberGenerator로 32바이트를 만들고, 이미 있으면 건너뛰며, 출력·로그 줄에 토큰 변수를 넣지 않는다", () => {
    const text = readFileSync(INSTALL_PS1, "utf8");
    expect(text).toContain("[System.Security.Cryptography.RandomNumberGenerator]");
    expect(text).toMatch(/New-Object byte\[\] 32/);
    // 비어 있는 토큰 파일은 다시 만든다(sh의 -s와 같게, Ruling B64)
    expect(text).toMatch(/if \(\(Test-Path -LiteralPath \$tokenFile\) -and \(Get-Item -LiteralPath \$tokenFile\)\.Length -gt 0\)/);
    expect(text).toContain('Write-InstallLog "token" "skip" "이미 있음"');
    expect(text).toContain('Write-InstallLog "token" "ok" "토큰 파일 준비"');
    // BOM 없는 ASCII로 쓴다
    expect(text).toMatch(/WriteAllText\(\$tokenFile, \$hex, \[System\.Text\.Encoding\]::ASCII\)/);
    const code = text.split("\n").filter((l) => !l.trim().startsWith("#"));
    for (const l of code.filter((l) => /Write-Host|Write-InstallLog|Write-Output|Add-Content/.test(l))) {
      expect(l, l).not.toMatch(/\$hex|\$token\b|\$bytes/);
    }
  });

  it("claude-office.ps1(정적): 토큰이 있으면 ?k= 주소로 열고, 실패할 때만 안내를 콘솔에 쓴다", () => {
    const text = readFileSync(LAUNCHER_PS1, "utf8");
    expect(text).toContain('Join-Path $Prefix "token"');
    expect(text).toMatch(/\?k=/);
    expect(text).toContain("Start-Sleep -Seconds 1");
    expect(text).toMatch(/Start-Process \$url -ErrorAction Stop/);
    // 백그라운드 job은 콘솔에 쓰지 못하므로 같은 프로세스의 runspace에서 연다
    expect(text).toContain("[powershell]::Create()");
    expect(text.split("\n").filter((l) => !l.trim().startsWith("#")).some((l) => l.includes("Start-Job"))).toBe(false);
    expect(text).toContain('[Console]::WriteLine("브라우저를 열지 못했습니다. 이 주소를 브라우저에 붙여 넣어 주세요: $url")');
    expect(text).toContain('[Console]::WriteLine("이 주소는 열쇠입니다. 남에게 보내지 마세요.")');
  });

  it("uninstall(ps1)은 token과 state.json도 지운다", () => {
    const text = readFileSync(LAUNCHER_PS1, "utf8");
    expect(text).toContain('Remove-Item -Force -Confirm:$false -ErrorAction SilentlyContinue -LiteralPath (Join-Path $Prefix "token")');
    expect(text).toContain('Remove-Item -Force -Confirm:$false -ErrorAction SilentlyContinue -LiteralPath (Join-Path $Prefix "state.json")');
  });

  it("Phase 2 문구가 sh·ps1에서 글자까지 같다(설치 질문, 토큰 로그, 열기 실패 안내)", () => {
    const installSh = readFileSync(join(ROOT, "packaging/install.sh"), "utf8");
    const launcherSh = readFileSync(join(ROOT, "packaging/claude-office.sh"), "utf8");
    const installPs1 = readFileSync(INSTALL_PS1, "utf8");
    const launcherPs1 = readFileSync(LAUNCHER_PS1, "utf8");
    const q = "Claude Code 플러그인(claude-office)을 설치할까요? 도구 사용 기록을 이 PC의 뷰어로 보내고, 대시보드에서 답한 허용·거부를 Claude Code에 돌려줍니다.";
    expect(installSh).toContain(q);
    expect(installPs1).toContain(q);
    expect(q).toContain("돌려줍니다");
    expect(installSh).not.toContain("도구 사용 기록을 이 PC의 뷰어로 보냅니다.");
    for (const m of ["토큰 파일 준비", "이미 있음"]) {
      expect(installSh).toContain(`log token ${m === "이미 있음" ? "skip" : "ok"} "${m}"`);
      expect(installPs1).toContain(`Write-InstallLog "token" "${m === "이미 있음" ? "skip" : "ok"}" "${m}"`);
    }
    for (const m of ["브라우저를 열지 못했습니다. 이 주소를 브라우저에 붙여 넣어 주세요: ", "이 주소는 열쇠입니다. 남에게 보내지 마세요."]) {
      expect(launcherSh).toContain(m);
      expect(launcherPs1).toContain(m);
    }
  });
});
