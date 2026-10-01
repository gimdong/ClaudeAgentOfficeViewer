# 베타 미검증: Windows 실제 설치 확인 전입니다(스펙 12장).
# claude-office 명령(Windows). install.ps1이 <prefix>\bin\claude-office.ps1로 복사해 둔다.
# claude-office.cmd가 이 파일을 부른다(powershell -NoProfile -ExecutionPolicy Bypass -File ...).
[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$RestArgs
)
if ($null -eq $RestArgs) { $RestArgs = @() }
$ErrorActionPreference = "Stop"

# $PSCommandPath가 심볼릭 링크·정션일 수 있다(T7의 claude-office.sh와 같은 문제 — Ruling B13).
# Get-Item의 Target 속성으로 끝까지 따라간다(여러 단계일 수 있어 재귀). 링크가 아니면
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
$ScriptPath = Resolve-RealPath $PSCommandPath
$Prefix = Split-Path -Parent (Split-Path -Parent $ScriptPath)

# 비었거나 드라이브 루트(C:\ 등)이거나 %USERPROFILE% 자체면(위 링크 버그나 손상된 설치) 아래
# Remove-Item들이 엉뚱한 곳을 지울 수 있다 — uninstall뿐 아니라 모든 하위 명령 실행 전에
# 검증한다(Ruling B13). 설치가 실제로 돼 있는지는 app\server.mjs·VERSION 존재로 판단하고,
# 지우기 전에 반드시 다시 확인한다.
if ([string]::IsNullOrWhiteSpace($Prefix) -or ($Prefix -match '^[A-Za-z]:\\?$')) {
  Write-Error "설치 폴더 경로가 올바르지 않습니다(`"$Prefix`"). 다시 설치해 주세요."
  exit 1
}
# install.ps1과 같은 방식(있으면 Resolve-Path, 없으면 GetFullPath, 끝 "\"와 대소문자 무시)으로
# %USERPROFILE%과 비교한다 — Ruling B15.
function Normalize-InstallPath([string]$Path) {
  if (Test-Path -LiteralPath $Path) {
    return (Resolve-Path -LiteralPath $Path).Path.TrimEnd('\')
  }
  return ([System.IO.Path]::GetFullPath($Path)).TrimEnd('\')
}
if ((Normalize-InstallPath $Prefix) -ieq (Normalize-InstallPath $env:USERPROFILE)) {
  Write-Error "설치 폴더 경로가 올바르지 않습니다(사용자 폴더 자체). 다시 설치해 주세요."
  exit 1
}
if (-not (Test-Path (Join-Path $Prefix "app\server.mjs")) -or -not (Test-Path (Join-Path $Prefix "VERSION"))) {
  Write-Error "설치 폴더를 찾지 못했습니다(`"$Prefix`") — 다시 설치해 주세요."
  exit 1
}

# 모든 하위 명령에서 항상 설정한다 — 그래야 서버 로거가 <prefix>\logs로 쓴다(Ruling B10).
$env:CLAUDE_OFFICE_PREFIX = $Prefix

# 아주 옛 Node는 번들(server.mjs)의 최신 문법 자체에서 죽어 서버 안의 자체 Node 검사까지 가지
# 못한다 — 여기서도 먼저 확인한다(Ruling B10, install.ps1·claude-office.sh와 같음).
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Error "Node.js 24 이상이 필요합니다. https://nodejs.org 에서 LTS를 설치해 주세요."
  exit 1
}
$nodeVersion = (& node -v)
$major = [int]($nodeVersion -replace '^v(\d+).*', '$1')
if ($major -lt 24) {
  Write-Error "Node.js 24 이상이 필요합니다(지금 $nodeVersion)."
  exit 1
}

function Confirm-Step([string]$Message) {
  $a = Read-Host "$Message [y/N]"
  return ($a -eq "y" -or $a -eq "Y")
}

$cmd = if ($RestArgs.Count -gt 0) { $RestArgs[0] } else { "" }
switch ($cmd) {
  { $_ -in @("doctor", "diag") } {
    & node (Join-Path $Prefix "app\server.mjs") @RestArgs
    exit $LASTEXITCODE
  }
  "--version" {
    Get-Content (Join-Path $Prefix "VERSION")
  }
  "uninstall" {
    $rest = if ($RestArgs.Count -gt 1) { $RestArgs[1..($RestArgs.Count - 1)] } else { @() }
    $UYes = $rest -contains "--yes"

    $claude = Get-Command claude -ErrorAction SilentlyContinue
    if ($claude) {
      & claude plugin uninstall claude-office@claude-office --scope user 2>$null
      & claude plugin marketplace remove claude-office 2>$null
    }

    # 사용자 PATH에서 claude-office의 bin 경로 항목만 지운다(설치 때 "User" 범위에만 추가했다).
    # 기존 값을 통째로 덮어쓰지 않고 우리 항목만 걸러낸다. 대소문자와 끝의 "\" 차이는 같은
    # 항목으로 본다(Windows 경로는 대소문자를 구분하지 않고, 끝에 "\"가 붙고 안 붙고는 사람마다
    # 다를 수 있다 — Ruling B13).
    $binDir = Join-Path $Prefix "bin"
    $normalize = { param($p) $p.TrimEnd('\').ToLowerInvariant() }
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath) {
      $parts = ($userPath -split ";") | Where-Object { $_ -ne "" -and (& $normalize $_) -ne (& $normalize $binDir) }
      [Environment]::SetEnvironmentVariable("Path", ($parts -join ";"), "User")
    }

    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $Prefix "app")
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $Prefix "plugin")
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $Prefix "bin")
    Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $Prefix "VERSION")
    Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $Prefix "사용설명서.html")

    $removeLogs = if ($UYes) { $true } else { Confirm-Step "로그와 진단 파일도 지울까요?" }
    if ($removeLogs) {
      Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $Prefix "logs")
      Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $Prefix "diagnostics")
      Remove-Item -Force -ErrorAction SilentlyContinue $Prefix
    }
  }
  default {
    $port = 4317
    for ($i = 0; $i -lt $RestArgs.Count; $i++) {
      if ($RestArgs[$i] -eq "--port" -and ($i + 1) -lt $RestArgs.Count) { $port = $RestArgs[$i + 1] }
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
