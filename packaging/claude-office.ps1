# 베타 미검증: Windows 실제 설치 확인 전입니다(스펙 12장).
# claude-office 명령(Windows). install.ps1이 <prefix>\bin\claude-office.ps1로 복사해 둔다.
# claude-office.cmd가 이 파일을 부른다(powershell -NoProfile -ExecutionPolicy Bypass -File ...).
# UTF-8 BOM으로 저장한다 — Windows PowerShell 5.1이 BOM 없이는 시스템 코드페이지로 읽어 한글·
# 큰따옴표가 깨질 수 있다(리뷰어 Critical).
[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$RestArgs
)
if ($null -eq $RestArgs) { $RestArgs = @() }
$ErrorActionPreference = "Stop"

function Write-Fail([string]$Message) {
  [Console]::Error.WriteLine($Message)
  exit 1
}

# $PSCommandPath가 심볼릭 링크·정션일 수 있다(T7의 claude-office.sh와 같은 문제 — Ruling B13).
# Get-Item의 Target 속성으로 끝까지 따라간다(여러 단계일 수 있어 재귀). Resolve-Path는 경로 문법만
# 정규화할 뿐 링크를 실제 대상으로 바꿔 주지 않으므로 쓰지 않는다(리뷰어 Minor). 링크가 아니면
# [IO.Path]::GetFullPath로 그냥 정규화만 한다.
function Resolve-RealPath([string]$Path) {
  $item = Get-Item -LiteralPath $Path -ErrorAction SilentlyContinue
  if ($item -and $item.Target) {
    $target = $item.Target
    if ($target -is [array]) { $target = $target[0] }
    if (-not [System.IO.Path]::IsPathRooted($target)) {
      $target = Join-Path (Split-Path -Parent $item.FullName) $target
    }
    return Resolve-RealPath $target
  }
  return [System.IO.Path]::GetFullPath($Path)
}
function Normalize-InstallPath([string]$Path) {
  return (Resolve-RealPath $Path).TrimEnd('\')
}
$ScriptPath = Resolve-RealPath $PSCommandPath
$Prefix = Split-Path -Parent (Split-Path -Parent $ScriptPath)

# 비었거나 드라이브 루트(C:\ 등)이거나 %USERPROFILE% 자체면(위 링크 버그나 손상된 설치) 아래
# Remove-Item들이 엉뚱한 곳을 지울 수 있다 — uninstall뿐 아니라 모든 하위 명령 실행 전에
# 검증한다(Ruling B13). %USERPROFILE%과는 둘 다 Normalize-InstallPath로 정규화한 뒤 비교한다
# (T7 fix round 2와 같은 이유 — Ruling B15). 설치가 실제로 돼 있는지는 app\server.mjs·VERSION
# 존재로 판단하고, 지우기 전에 반드시 다시 확인한다.
if ([string]::IsNullOrWhiteSpace($Prefix) -or ($Prefix -match '^[A-Za-z]:\\?$')) {
  Write-Fail "설치 폴더 경로가 올바르지 않습니다(`"$Prefix`"). 다시 설치해 주세요."
}
if ((Normalize-InstallPath $Prefix) -ieq (Normalize-InstallPath $env:USERPROFILE)) {
  Write-Fail "설치 폴더 경로가 올바르지 않습니다(사용자 폴더 자체). 다시 설치해 주세요."
}
if (-not (Test-Path -LiteralPath (Join-Path $Prefix "app\server.mjs")) -or -not (Test-Path -LiteralPath (Join-Path $Prefix "VERSION"))) {
  Write-Fail "설치 폴더를 찾지 못했습니다(`"$Prefix`") — 다시 설치해 주세요."
}

# 모든 하위 명령에서 항상 설정한다 — 그래야 서버 로거가 <prefix>\logs로 쓴다(Ruling B10).
$env:CLAUDE_OFFICE_PREFIX = $Prefix

# 아주 옛 Node는 번들(server.mjs)의 최신 문법 자체에서 죽어 서버 안의 자체 Node 검사까지 가지
# 못한다 — 여기서도 먼저 확인한다(Ruling B10, install.ps1·claude-office.sh와 같음).
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Fail "Node.js 24 이상이 필요합니다. https://nodejs.org 에서 LTS를 설치해 주세요."
}
$nodeVersion = (& node -v)
$major = [int]($nodeVersion -replace '^v(\d+).*', '$1')
if ($major -lt 24) {
  Write-Fail "Node.js 24 이상이 필요합니다(지금 $nodeVersion)."
}

function Confirm-Step([string]$Message) {
  $a = Read-Host "$Message [y/N]"
  return ($a -eq "y" -or $a -eq "Y")
}

# PATH 레지스트리 값을 직접 읽고 쓴다(install.ps1과 같은 이유 — [Environment]의 Get/Set은
# REG_EXPAND_SZ를 REG_SZ로 깨 버린다. 리뷰어 Important). uninstall은 우리 항목이 PATH에 없어도
# 이 경로를 그대로 타지만, 값이 실제로 안 바뀌면 쓰지 않는다(Set-UserPathIfChanged가 처리).
function Get-UserPath() {
  return (Get-Item "HKCU:\Environment").GetValue("Path", "", "DoNotExpandEnvironmentNames")
}
function Set-UserPathIfChanged([string]$NewValue, [string]$OldValue) {
  if ($NewValue -eq $OldValue) { return }
  Set-ItemProperty -Path "HKCU:\Environment" -Name "Path" -Value $NewValue -Type ExpandString
  $dummy = "CLAUDE_OFFICE_REFRESH_$([Guid]::NewGuid().ToString('N'))"
  [Environment]::SetEnvironmentVariable($dummy, "1", "User")
  [Environment]::SetEnvironmentVariable($dummy, $null, "User")
}

$cmd = if ($RestArgs.Count -gt 0) { $RestArgs[0] } else { "" }
switch ($cmd) {
  { $_ -in @("doctor", "diag") } {
    & node (Join-Path $Prefix "app\server.mjs") @RestArgs
    exit $LASTEXITCODE
  }
  "--version" {
    Get-Content -LiteralPath (Join-Path $Prefix "VERSION")
  }
  "uninstall" {
    $rest = if ($RestArgs.Count -gt 1) { $RestArgs[1..($RestArgs.Count - 1)] } else { @() }
    $UYes = $rest -contains "--yes"
    $ask_u = { param($m) if ($UYes) { $true } else { Confirm-Step $m } }

    # claude plugin 호출이 stderr에 한 줄이라도 쓰면(흔하다 — 경고성 메시지), 상위 스코프의
    # $ErrorActionPreference = "Stop"과 겹쳐 거기서 uninstall 전체가 멈출 수 있다(리뷰어
    # Important). 이 구간만 EAP를 Continue로 낮추고 try/catch로도 한 번 더 감싼다.
    if (Get-Command claude -ErrorAction SilentlyContinue) {
      $prevEAP = $ErrorActionPreference
      $ErrorActionPreference = "Continue"
      try {
        & claude plugin uninstall claude-office@claude-office --scope user 2>$null
        & claude plugin marketplace remove claude-office 2>$null
      } catch {
        # 플러그인 제거 실패는 치명적이지 않다 — 설치 폴더 정리는 계속한다
      } finally {
        $ErrorActionPreference = $prevEAP
      }
    }

    # 사용자 PATH에서 claude-office의 bin 경로 항목만 지운다(설치 때 "User" 범위에만 추가했다).
    # 기존 값을 통째로 덮어쓰지 않고 우리 항목만 걸러낸다. 대소문자와 끝의 "\" 차이는 같은
    # 항목으로 본다(Ruling B13).
    $binDir = Join-Path $Prefix "bin"
    $normalize = { param($p) $p.TrimEnd('\').ToLowerInvariant() }
    $userPath = Get-UserPath
    if ($userPath) {
      $parts = ($userPath -split ";") | Where-Object { $_ -ne "" -and (& $normalize $_) -ne (& $normalize $binDir) }
      Set-UserPathIfChanged ($parts -join ";") $userPath
    }

    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue -LiteralPath (Join-Path $Prefix "app")
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue -LiteralPath (Join-Path $Prefix "plugin")
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue -LiteralPath (Join-Path $Prefix "bin")
    Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath (Join-Path $Prefix "VERSION")
    Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath (Join-Path $Prefix "사용설명서.html")

    $removeLogs = & $ask_u "로그와 진단 파일도 지울까요?"
    if ($removeLogs) {
      Remove-Item -Recurse -Force -ErrorAction SilentlyContinue -LiteralPath (Join-Path $Prefix "logs")
      Remove-Item -Recurse -Force -ErrorAction SilentlyContinue -LiteralPath (Join-Path $Prefix "diagnostics")
    }
    # $Prefix 자체는 비어 있을 때만 지운다 — 비어 있지 않은데 Remove-Item을 부르면(-Recurse 없이)
    # 확인 질문으로 멈출 수 있다(리뷰어 Minor). 지우기 전에 직접 세어 본다.
    if ((Get-ChildItem -Force -LiteralPath $Prefix -ErrorAction SilentlyContinue | Measure-Object).Count -eq 0) {
      Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $Prefix
    }
  }
  default {
    $port = 4317
    $prev = ""
    foreach ($a in $RestArgs) {
      if ($a -like "--port=*") { $port = $a.Substring(7) }
      if ($prev -eq "--port") { $port = $a }
      $prev = $a
    }
    if (-not $env:CLAUDE_OFFICE_NO_OPEN) {
      Start-Job -ScriptBlock {
        param($p)
        Start-Sleep -Seconds 1
        try { Start-Process "http://127.0.0.1:$p/" } catch {}
      } -ArgumentList $port | Out-Null
    }
    & node (Join-Path $Prefix "app\server.mjs") @RestArgs
    exit $LASTEXITCODE
  }
}
