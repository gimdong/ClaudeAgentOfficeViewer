# 베타 미검증: Windows 실제 설치 확인 전입니다(스펙 12장).
# claude-office 설치 스크립트(Windows). 패키지 폴더 안에서 실행한다($PSScriptRoot 기준).
# UTF-8 BOM으로 저장한다 — Windows PowerShell 5.1(.cmd가 부르는 그것)은 BOM 없는 .ps1을 시스템
# 코드페이지(한국어 Windows는 CP949)로 읽어, 이 안의 한글·큰따옴표가 깨지고 파싱이 실패할 수 있다
# (리뷰어 Critical).
[CmdletBinding()]
param(
  [string]$Prefix = (Join-Path $env:USERPROFILE ".claude-office"),
  [switch]$Yes,
  [switch]$NoPath,
  [switch]$NoOpen
)
$ErrorActionPreference = "Stop"
$Here = $PSScriptRoot

function Write-Fail([string]$Message) {
  # Write-Error는 호출부의 $ErrorActionPreference에 따라 동작이 달라지고(여기선 "Stop"이라 예외가
  # 되어 스택 추적까지 찍힌다) 종료 코드도 직접 안 정해 준다 — 표준 오류에 한 줄만 쓰고 바로 exit 1.
  [Console]::Error.WriteLine($Message)
  exit 1
}

# 빈 값·드라이브 루트(C:\ 등)·%USERPROFILE% 자체는 거부한다 — uninstall이 이 안을 통째로
# 지우므로(Ruling B13, T7의 install.sh --prefix 검증과 같음).
if ([string]::IsNullOrWhiteSpace($Prefix) -or ($Prefix -match '^[A-Za-z]:\\?$')) {
  Write-Fail "설치 폴더 경로가 올바르지 않습니다(`"$Prefix`")."
}

# 심볼릭 링크·정션을 실제 경로로 바꾼다 — Get-Item의 Target을 재귀적으로 따라간다. Resolve-Path는
# 경로 문법(".", "..", 상대경로)만 정규화할 뿐 링크를 실제 대상으로 바꿔 주지 않는다(이전 주석의
# 착오 — 리뷰어 Minor). 없는 경로(기본값 %USERPROFILE%\.claude-office도 처음엔 없다)는
# GetFullPath로 정규화만 한다.
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
# -Prefix를 글자 그대로 %USERPROFILE%과 비교하면 "%USERPROFILE%\"(끝 \)나 대소문자가 다른 드라이브
# 글자(Windows 경로는 대소문자를 구분 안 함) 같은 표기가 거부를 피해간다(T7 fix round 2와 같은
# 이유 — Ruling B15). 둘 다 Resolve-RealPath로 정규화한 뒤 끝의 "\"를 떼고 대소문자를 무시해 비교한다.
function Normalize-InstallPath([string]$Path) {
  return (Resolve-RealPath $Path).TrimEnd('\')
}
$NormPrefix = Normalize-InstallPath $Prefix
$NormUserProfile = Normalize-InstallPath $env:USERPROFILE
if ($NormPrefix -match '^[A-Za-z]:$') {
  Write-Fail "설치 폴더 경로가 올바르지 않습니다(`"$Prefix`")."
}
if ($NormPrefix -ieq $NormUserProfile) {
  Write-Fail "설치 폴더로 사용자 폴더 자체는 쓸 수 없습니다. 예: -Prefix `"$env:USERPROFILE\.claude-office`""
}
$Prefix = $NormPrefix

# 대상 폴더가 이미 있고 비어 있지 않은데 우리가 설치한 흔적(VERSION)이 없으면 남의 폴더일 수
# 있다 — 재설치(VERSION 있음)는 그대로 두고, 그 밖의 경우만 거부한다(B15, install.sh와 같은 문구).
if ((Test-Path -LiteralPath $Prefix) -and ((Get-ChildItem -Force -LiteralPath $Prefix | Measure-Object).Count -gt 0) -and -not (Test-Path -LiteralPath (Join-Path $Prefix "VERSION"))) {
  Write-Fail "이미 다른 파일이 있는 폴더입니다. 빈 폴더나 새 폴더 이름을 지정해 주세요."
}

# FB-1 fix round 1(#115) Minor: -NoPath이고 claude도 없으면(또는 PATH가 이미 등록돼 있으면)
# 질문을 하나도 안 하는데, 그런 경우에도 안내가 나오면 거짓말이다 — 실제로 물어본 적이 있을
# 때만(그리고 그게 입력 차단 때문에 아니오가 됐을 때만) 세운다. Confirm-Step이 $Yes로 건너뛰지
# 않고 실제로 물을 때만 $Asked를 세운다. 함수 안에서 바깥 변수를 바꾸려면 $script: 범위가 필요하다.
$Asked = $false
function Confirm-Step([string]$Message) {
  if ($Yes) { return $true }
  $script:Asked = $true
  $a = Read-Host "$Message [y/N]"
  return ($a -eq "y" -or $a -eq "Y")
}

# FB-1(사용자 피드백, 2026-10-01): 표준 입력이 리다이렉트돼 있으면(터미널이 아니면) Read-Host가
# 바로 빈 값을 받아 모든 질문이 조용히 "아니오"가 된다 — sh와 같은 이유로 안내가 없으면 왜
# 전부 거절됐는지 알기 어렵다. -Yes가 없는데 입력을 못 받는 환경이면 끝에 안내를 한 줄 낸다
# (install.sh와 글자까지 같은 문구).
$InputBlocked = [Console]::IsInputRedirected

# 설치 로그(SPEC 4장, install.sh와 같은 형식): 단계마다 한 줄
# "<시각+오프셋> <단계> ok|fail|skip <설명> "<경로>"". 비밀값·USER·호스트 이름·환경변수 값은 안
# 쓴다 — 경로는 되지만, 반드시 줄 끝에 큰따옴표로 감싸고 설명은 그 앞에 쓴다(Ruling B10 보강 —
# 경로 뒤에 설명을 쓰면 진단 파일의 경로 가림이 그 설명까지 함께 삼킨다). 시각의 오프셋 자리수가
# sh 쪽과 글자 그대로 같을 필요는 없다(qa:analyze가 그대로 받아들인다). Node 검사가 실패할 수도
# 있으니 logs 폴더는 그보다 먼저 만든다.
New-Item -ItemType Directory -Force -Confirm:$false -Path (Join-Path $Prefix "logs") | Out-Null
$LogFile = Join-Path $Prefix "logs\install-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
function Write-InstallLog([string]$Step, [string]$Status, [string]$Message) {
  $ts = Get-Date -Format "yyyy-MM-ddTHH:mm:sszzz"
  Add-Content -LiteralPath $LogFile -Value "$ts $Step $Status $Message" -Encoding UTF8
}
function Fail-Install([string]$Step, [string]$Message) {
  Write-InstallLog $Step "fail" $Message
  [Console]::Error.WriteLine($Message)
  [Console]::Error.WriteLine("자세한 기록: $LogFile")
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
New-Item -ItemType Directory -Force -Confirm:$false -Path (Join-Path $Prefix "bin") | Out-Null
New-Item -ItemType Directory -Force -Confirm:$false -Path (Join-Path $Prefix "diagnostics") | Out-Null
Remove-Item -Recurse -Force -Confirm:$false -ErrorAction SilentlyContinue -LiteralPath (Join-Path $Prefix "app")
Remove-Item -Recurse -Force -Confirm:$false -ErrorAction SilentlyContinue -LiteralPath (Join-Path $Prefix "plugin")
Copy-Item -Recurse -Force (Join-Path $Here "app") (Join-Path $Prefix "app")
Copy-Item -Recurse -Force (Join-Path $Here "plugin") (Join-Path $Prefix "plugin")
Copy-Item -Force (Join-Path $Here "VERSION") (Join-Path $Prefix "VERSION")
if (Test-Path -LiteralPath (Join-Path $Here "사용설명서.html")) {
  Copy-Item -Force (Join-Path $Here "사용설명서.html") (Join-Path $Prefix "사용설명서.html")
}
Copy-Item -Force (Join-Path $Here "claude-office.ps1") (Join-Path $Prefix "bin\claude-office.ps1")
Copy-Item -Force (Join-Path $Here "claude-office.cmd") (Join-Path $Prefix "bin\claude-office.cmd")
Write-InstallLog "copy" "ok" "앱 파일 복사 완료 `"$Prefix\app`""

# 2-1. 대시보드 토큰(Phase 2 스펙 7.1): 없으면 무작위 32바이트(hex)를 BOM 없는 ASCII로 만들고, 있으면 그대로 둔다
# (install.sh와 같은 로그 문구). 값은 화면·설치 로그 어디에도 쓰지 않는다. 사용자 프로필 아래라 권한은 상속된다
$tokenFile = Join-Path $Prefix "token"
# 비어 있는 파일은 없는 것과 같이 다시 만든다(install.sh의 [ -s ]와 같게, Ruling B64)
if ((Test-Path -LiteralPath $tokenFile) -and (Get-Item -LiteralPath $tokenFile).Length -gt 0) {
  Write-InstallLog "token" "skip" "이미 있음"
} else {
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($bytes)
  $rng.Dispose()
  $hex = -join ($bytes | ForEach-Object { $_.ToString("x2") })
  [System.IO.File]::WriteAllText($tokenFile, $hex, [System.Text.Encoding]::ASCII)
  Write-InstallLog "token" "ok" "토큰 파일 준비"
}

# PATH 레지스트리 값을 직접 읽고 쓴다 — [Environment]::GetEnvironmentVariable("Path","User")는
# %VAR% 참조를 펼친 값을 돌려주고, SetEnvironmentVariable은 항상 REG_SZ로 쓴다. 사용자 PATH가
# 원래 REG_EXPAND_SZ였다면(흔하다) 그 형식이 깨져 버린다(리뷰어 Important). 레지스트리에서 펼치지
# 않은 원본 문자열을 읽는다.
function Get-UserPath() {
  return (Get-Item "HKCU:\Environment").GetValue("Path", "", "DoNotExpandEnvironmentNames")
}
function Get-UserPathKind() {
  try {
    return (Get-Item "HKCU:\Environment").GetValueKind("Path")
  } catch {
    return $null # 값 자체가 없던 경우
  }
}
function Set-UserPathIfChanged([string]$NewValue, [string]$OldValue) {
  # 값이 실제로 안 바뀌면 쓰지 않는다 — 이미 등록돼 있던 경우가 그렇다(리뷰어 지시).
  if ($NewValue -eq $OldValue) { return }
  # 원래 종류(REG_SZ/REG_EXPAND_SZ)를 그대로 유지해서 쓴다 — 값이 아예 없던 경우에만 새로
  # ExpandString으로 만든다.
  $kind = Get-UserPathKind
  if (-not $kind) { $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString }
  Set-ItemProperty -Path "HKCU:\Environment" -Name "Path" -Value $NewValue -Type $kind -Confirm:$false
  # 탐색기 등 이미 열려 있는 프로그램에 환경 변수가 바뀌었다고 알린다 — 더미 사용자 변수를 만들었다
  # 지우는 것만으로 브로드캐스트가 일어난다(새 레지스트리 값을 직접 거는 공개 API가 없다).
  $dummy = "CLAUDE_OFFICE_REFRESH_$([Guid]::NewGuid().ToString('N'))"
  [Environment]::SetEnvironmentVariable($dummy, "1", "User")
  [Environment]::SetEnvironmentVariable($dummy, $null, "User")
}

# 3. PATH(사용자 범위("User")만 — Machine 범위는 관리자 권한이 필요하고 다른 사용자에게도 영향을
# 주므로 건드리지 않는다. 이미 있으면 추가하지 않는다)
$pathAdded = $false # SPEC 3장: PATH에 안 들어갔으면 끝에서 전체 경로 실행법을 안내해야 한다
if (-not $NoPath) {
  $binDir = Join-Path $Prefix "bin"
  # 대소문자와 끝의 "\" 차이는 같은 항목으로 본다(Ruling B13).
  $normalize = { param($p) $p.TrimEnd('\').ToLowerInvariant() }
  $userPath = Get-UserPath
  $already = $userPath -and (($userPath -split ";") | Where-Object { (& $normalize $_) -eq (& $normalize $binDir) })
  if ($already) {
    Write-InstallLog "path" "skip" "이미 등록됨 `"$binDir`""
    $pathAdded = $true
  } elseif (Confirm-Step "사용자 PATH에 claude-office 명령 경로를 추가할까요?") {
    $newPath = if ([string]::IsNullOrEmpty($userPath)) { $binDir } else { "$userPath;$binDir" }
    Set-UserPathIfChanged $newPath $userPath
    Write-InstallLog "path" "ok" "PATH 추가 `"$binDir`""
    $pathAdded = $true
  } else {
    Write-InstallLog "path" "skip" "사용자가 거절함"
  }
} else {
  Write-InstallLog "path" "skip" "-NoPath"
}

# 4. 플러그인
$claude = Get-Command claude -ErrorAction SilentlyContinue
if ($claude) {
  if (Confirm-Step "Claude Code 플러그인(claude-office)을 설치할까요? 도구 사용 기록을 이 PC의 뷰어로 보내고, 대시보드에서 답한 허용·거부를 Claude Code에 돌려줍니다.") {
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
if (-not $NoOpen -and (Test-Path -LiteralPath (Join-Path $Prefix "사용설명서.html"))) {
  try { Start-Process (Join-Path $Prefix "사용설명서.html") } catch {}
}
Write-InstallLog "done" "ok" "설치 완료"
Write-Host "설치 완료. 새 터미널에서 claude-office 를 실행하세요."
if (-not $pathAdded) {
  # SPEC 3장 3단계: PATH에 안 들어갔으면(거절했거나 -NoPath) 전체 경로 실행법을 안내한다
  # (sh와 글자까지 같은 문구 — B17, Windows는 .cmd까지 적는다).
  Write-Host "다음부터는 이렇게 켜세요: $Prefix\bin\claude-office.cmd"
}
if ($InputBlocked -and -not $Yes -and $Asked) {
  # FB-1 fix round 1(#115) Important(리뷰어 지적): install.ps1은 [switch]$Yes라서 "--yes"는
  # 매개변수로 안 먹히고 첫 위치 매개변수($Prefix)로 들어가 엉뚱한 폴더에 설치하려 든다 —
  # 여기만 "-Yes"로 안내한다(sh·claude-office.ps1의 uninstall은 원시 문자열 "--yes"를 직접 보므로
  # 그대로 "--yes"). ASKED=1(실제로 물어본 적 있음)일 때만 세운다(#115 Minor).
  Write-Host "입력을 받을 수 없어 '아니오'로 처리했습니다. 설치하려면 -Yes를 붙여 다시 실행하세요."
}
