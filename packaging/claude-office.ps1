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
$Prefix = Split-Path -Parent $PSScriptRoot
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
    $binDir = Join-Path $Prefix "bin"
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath) {
      $parts = ($userPath -split ";") | Where-Object { $_ -ne "" -and $_ -ne $binDir }
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
