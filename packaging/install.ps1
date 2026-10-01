# 베타 미검증: Windows 실제 설치 확인 전입니다(스펙 12장).
# claude-office 설치 스크립트(Windows). 패키지 폴더 안에서 실행한다($PSScriptRoot 기준).
[CmdletBinding()]
param(
  [string]$Prefix = (Join-Path $env:USERPROFILE ".claude-office"),
  [switch]$Yes,
  [switch]$NoPath,
  [switch]$NoOpen
)
$ErrorActionPreference = "Stop"
$Here = $PSScriptRoot

# 빈 값·드라이브 루트(C:\ 등)·%USERPROFILE% 자체는 거부한다 — uninstall이 이 안을 통째로
# 지우므로(Ruling B13, T7의 install.sh --prefix 검증과 같음).
if ([string]::IsNullOrWhiteSpace($Prefix) -or ($Prefix -match '^[A-Za-z]:\\?$')) {
  Write-Host "설치 폴더 경로가 올바르지 않습니다(`"$Prefix`")."
  exit 2
}

# -Prefix를 글자 그대로 %USERPROFILE%과 비교하면 "%USERPROFILE%\"(끝 \)나 대소문자가 다른 드라이브
# 글자(Windows 경로는 대소문자를 구분 안 함) 같은 표기가 거부를 피해간다(T7 fix round 2와 같은
# 이유 — Ruling B15). 있는 경로는 Resolve-Path(링크·정션까지 실제 경로로), 아직 없는 경로(기본값
# %USERPROFILE%\.claude-office도 처음엔 없다)는 GetFullPath로 정규화한다. 둘 다 끝의 "\"를 떼고
# 대소문자를 무시해 비교한다.
function Normalize-InstallPath([string]$Path) {
  if (Test-Path -LiteralPath $Path) {
    return (Resolve-Path -LiteralPath $Path).Path.TrimEnd('\')
  }
  return ([System.IO.Path]::GetFullPath($Path)).TrimEnd('\')
}
$NormPrefix = Normalize-InstallPath $Prefix
$NormUserProfile = Normalize-InstallPath $env:USERPROFILE
if ($NormPrefix -match '^[A-Za-z]:$') {
  Write-Host "설치 폴더 경로가 올바르지 않습니다(`"$Prefix`")."
  exit 2
}
if ($NormPrefix -ieq $NormUserProfile) {
  Write-Host "설치 폴더로 사용자 폴더 자체는 쓸 수 없습니다. 예: -Prefix `"$env:USERPROFILE\.claude-office`""
  exit 2
}
$Prefix = $NormPrefix

# 대상 폴더가 이미 있고 비어 있지 않은데 우리가 설치한 흔적(VERSION)이 없으면 남의 폴더일 수
# 있다 — 재설치(VERSION 있음)는 그대로 두고, 그 밖의 경우만 거부한다(B15, install.sh와 같은 문구).
if ((Test-Path $Prefix) -and ((Get-ChildItem -Force $Prefix | Measure-Object).Count -gt 0) -and -not (Test-Path (Join-Path $Prefix "VERSION"))) {
  Write-Host "이미 다른 파일이 있는 폴더입니다. 빈 폴더나 새 폴더 이름을 지정해 주세요."
  exit 2
}

function Confirm-Step([string]$Message) {
  if ($Yes) { return $true }
  $a = Read-Host "$Message [y/N]"
  return ($a -eq "y" -or $a -eq "Y")
}

# 설치 로그(SPEC 4장, install.sh와 같은 형식): 단계마다 한 줄
# "<시각+오프셋> <단계> ok|fail|skip <설명> "<경로>"". 비밀값·USER·호스트 이름·환경변수 값은 안
# 쓴다 — 경로는 되지만, 반드시 줄 끝에 큰따옴표로 감싸고 설명은 그 앞에 쓴다(Ruling B10 보강 —
# 경로 뒤에 설명을 쓰면 진단 파일의 경로 가림이 그 설명까지 함께 삼킨다). Node 검사가 실패할 수도
# 있으니 logs 폴더는 그보다 먼저 만든다.
New-Item -ItemType Directory -Force -Path (Join-Path $Prefix "logs") | Out-Null
$LogFile = Join-Path $Prefix "logs\install-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
function Write-InstallLog([string]$Step, [string]$Status, [string]$Message) {
  $ts = Get-Date -Format "yyyy-MM-ddTHH:mm:sszzz"
  Add-Content -Path $LogFile -Value "$ts $Step $Status $Message"
}
function Fail-Install([string]$Step, [string]$Message) {
  Write-InstallLog $Step "fail" $Message
  Write-Host $Message
  Write-Host "자세한 기록: $LogFile"
  exit 1
}

# 1. Node 확인
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Fail-Install "node" "Node.js 24 이상이 필요합니다. https://nodejs.org 에서 LTS를 설치해 주세요."
}
$nodeVersion = (& node -v)
$major = [int]($nodeVersion -replace '^v(\d+).*', '$1')
if ($major -ge 24) {
  Write-InstallLog "node" "ok" "Node $nodeVersion 확인"
} else {
  Fail-Install "node" "Node.js 24 이상이 필요합니다(지금 $nodeVersion)."
}

# 2. 복사 — app·plugin만 교체, logs·diagnostics 유지
New-Item -ItemType Directory -Force -Path (Join-Path $Prefix "bin") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Prefix "diagnostics") | Out-Null
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $Prefix "app")
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $Prefix "plugin")
Copy-Item -Recurse -Force (Join-Path $Here "app") (Join-Path $Prefix "app")
Copy-Item -Recurse -Force (Join-Path $Here "plugin") (Join-Path $Prefix "plugin")
Copy-Item -Force (Join-Path $Here "VERSION") (Join-Path $Prefix "VERSION")
if (Test-Path (Join-Path $Here "사용설명서.html")) {
  Copy-Item -Force (Join-Path $Here "사용설명서.html") (Join-Path $Prefix "사용설명서.html")
}
Copy-Item -Force (Join-Path $Here "claude-office.ps1") (Join-Path $Prefix "bin\claude-office.ps1")
Copy-Item -Force (Join-Path $Here "claude-office.cmd") (Join-Path $Prefix "bin\claude-office.cmd")
Write-InstallLog "copy" "ok" "앱 파일 복사 완료 `"$Prefix\app`""

# 3. PATH(사용자 범위("User")만 — Machine 범위는 관리자 권한이 필요하고 다른 사용자에게도 영향을
# 주므로 건드리지 않는다. 이미 있으면 추가하지 않는다)
if (-not $NoPath) {
  $binDir = Join-Path $Prefix "bin"
  # 대소문자와 끝의 "\" 차이는 같은 항목으로 본다(Ruling B13).
  $normalize = { param($p) $p.TrimEnd('\').ToLowerInvariant() }
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $already = $userPath -and (($userPath -split ";") | Where-Object { (& $normalize $_) -eq (& $normalize $binDir) })
  if ($already) {
    Write-InstallLog "path" "skip" "이미 등록됨 `"$binDir`""
  } elseif (Confirm-Step "사용자 PATH에 claude-office 명령 경로를 추가할까요?") {
    $newPath = if ([string]::IsNullOrEmpty($userPath)) { $binDir } else { "$userPath;$binDir" }
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    Write-InstallLog "path" "ok" "PATH 추가 `"$binDir`""
  } else {
    Write-InstallLog "path" "skip" "사용자가 거절함"
  }
} else {
  Write-InstallLog "path" "skip" "-NoPath"
}

# 4. 플러그인
$claude = Get-Command claude -ErrorAction SilentlyContinue
if ($claude) {
  if (Confirm-Step "Claude Code 플러그인(claude-office)을 설치할까요? 도구 사용 기록을 이 PC의 뷰어로 보냅니다.") {
    $pluginOk = $true
    & claude plugin marketplace add (Join-Path $Prefix "plugin")
    if ($LASTEXITCODE -ne 0) { Write-Host "마켓플레이스 등록 실패 — 사용설명서 6장(문제가 생겼을 때)을 봐 주세요."; $pluginOk = $false }
    & claude plugin install claude-office@claude-office --scope user
    if ($LASTEXITCODE -ne 0) { Write-Host "플러그인 설치 실패 — 사용설명서 6장(문제가 생겼을 때)을 봐 주세요."; $pluginOk = $false }
    if ($pluginOk) {
      Write-InstallLog "plugin" "ok" "플러그인 설치 완료"
    } else {
      Write-InstallLog "plugin" "fail" "플러그인 설치 중 오류(설치는 계속함)"
    }
  } else {
    Write-InstallLog "plugin" "skip" "사용자가 거절함"
  }
} else {
  Write-InstallLog "plugin" "skip" "claude 명령 없음"
  Write-Host "claude 명령을 찾지 못해 플러그인 설치를 건너뜁니다. 나중에:"
  Write-Host "  claude plugin marketplace add `"$(Join-Path $Prefix 'plugin')`""
  Write-Host "  claude plugin install claude-office@claude-office --scope user"
}

# 5. doctor
& (Join-Path $Prefix "bin\claude-office.cmd") doctor
if ($LASTEXITCODE -eq 0) {
  Write-InstallLog "doctor" "ok" "환경 점검 통과"
} else {
  Write-InstallLog "doctor" "fail" "환경 점검에서 문제 발견(설치는 계속함)"
}

# 6. 사용설명서, 완료
if (-not $NoOpen -and (Test-Path (Join-Path $Prefix "사용설명서.html"))) {
  try { Start-Process (Join-Path $Prefix "사용설명서.html") } catch {}
}
Write-InstallLog "done" "ok" "설치 완료"
Write-Host "설치 완료. 새 터미널에서 claude-office 를 실행하세요."
