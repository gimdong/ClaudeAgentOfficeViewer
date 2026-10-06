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

# FB-1 안내(B65, install.ps1과 같은 규칙): 입력이 끊겨(ReadLine이 $null) "아니오"가 됐을 때만 $EofNo를 세운다
$EofNo = $false
function Confirm-Step([string]$Message) {
  # 입력을 못 받으면(EOF 등) "아니오"로 처리한다 — 대화형이 아닌 실행에서 멈추지 않는다(리뷰어 지시).
  # Ruling B68: 콘솔 호스트에서만 표준 입력을 직접 읽어 EOF를 구분한다. 그 밖의 호스트(ISE·VS Code 확장 등)는 Read-Host
  if ($Host.Name -eq 'ConsoleHost') {
    Write-Host -NoNewline "$Message [y/N] "
    try {
      $a = [Console]::In.ReadLine()
    } catch {
      $a = $null
    }
    if ($null -eq $a) { $script:EofNo = $true; return $false }
  } else {
    try {
      $a = Read-Host "$Message [y/N]"
    } catch {
      return $false
    }
  }
  return ($a -eq "y" -or $a -eq "Y")
}

# PATH 레지스트리 값을 직접 읽고 쓴다(install.ps1과 같은 이유 — [Environment]의 Get/Set은
# REG_EXPAND_SZ를 REG_SZ로 깨 버린다. 리뷰어 Important). uninstall의 우리 항목이 PATH에 이미
# 없을 때처럼 값이 실제로 안 바뀌면 Set-ItemProperty 자체를 안 부른다(Set-UserPathIfChanged가 처리).
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
  if ($NewValue -eq $OldValue) { return }
  # 원래 종류(REG_SZ/REG_EXPAND_SZ)를 그대로 유지해서 쓴다 — 값이 아예 없던 경우에만 새로
  # ExpandString으로 만든다(리뷰어 지시 — 흔한 REG_EXPAND_SZ를 REG_SZ로 바꿔 버리면 안 된다).
  $kind = Get-UserPathKind
  if (-not $kind) { $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString }
  Set-ItemProperty -Path "HKCU:\Environment" -Name "Path" -Value $NewValue -Type $kind -Confirm:$false
  # 탐색기 등 이미 열려 있는 프로그램에 환경 변수가 바뀌었다고 알린다 — 더미 사용자 변수를 만들었다
  # 지우는 것만으로 브로드캐스트가 일어난다(새 레지스트리 값을 직접 거는 공개 API가 없다).
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
    # FB-1(B65): 안내는 Confirm-Step이 입력이 끊겨 아니오가 됐을 때($EofNo)만 — install.ps1과 같은 규칙
    $ask_u = { param($m) if ($UYes) { $true } else { Confirm-Step $m } }
    # FB-1(사용자 피드백): install.ps1과 같은 이유로, 입력이 리다이렉트돼 있으면 두 질문 다
    # 조용히 "아니오"가 된다 — --yes 없이 그런 환경이면 끝에 안내한다(설치 쪽과 글자만 다름).
    $UninstallInputBlocked = [Console]::IsInputRedirected

    # SPEC 3장 "동의 필요": 플러그인 제거 전에 따로 묻는다. --yes면 묻지 않고, EOF 등으로 입력을
    # 못 받으면(Confirm-Step 자체가 처리) "아니오"로 — 플러그인은 남겨 두고 지우는 법만 안내한다.
    $pluginRemoved = $false
    $pluginKept = $false
    if (Get-Command claude -ErrorAction SilentlyContinue) {
      if (& $ask_u "Claude Code에서 claude-office 플러그인도 지울까요?") {
        # claude plugin 호출이 stderr에 한 줄이라도 쓰면(흔하다 — 경고성 메시지), 상위 스코프의
        # $ErrorActionPreference = "Stop"과 겹쳐 거기서 uninstall 전체가 멈출 수 있다(리뷰어
        # Important). 두 호출을 각각 따로 try/catch로 감싸, 하나가 실패해도 나머지(PATH 정리·
        # 파일 삭제)는 계속되고 두 번째 claude 호출도 시도된다. 이 구간만 EAP도 Continue로 낮춘다.
        $prevEAP = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        try { & claude plugin uninstall claude-office@claude-office --scope user 2>$null } catch {}
        try { & claude plugin marketplace remove claude-office 2>$null } catch {}
        $ErrorActionPreference = $prevEAP
        $pluginRemoved = $true
      } else {
        Write-Host "플러그인은 남겨 두었습니다. 지우려면: claude plugin uninstall claude-office@claude-office --scope user"
        $pluginKept = $true
      }
    }

    # 사용자 PATH에서 claude-office의 bin 경로 항목만 지운다(설치 때 "User" 범위에만 추가했다).
    # 기존 값을 통째로 덮어쓰지 않고 우리 항목만 걸러낸다. 대소문자와 끝의 "\" 차이는 같은
    # 항목으로 본다(Ruling B13). 우리 항목이 애초에 없으면(필터링 전후 값이 같으면)
    # Set-UserPathIfChanged가 아예 쓰지 않는다(리뷰어 지시).
    # #82(qa 발견): PATH 정리는 두 질문(플러그인·logs)과 무관하게 항상 시도된다 — 값이 실제로
    # 바뀌었으면(우리 항목이 있어서 걸러졌으면) 아래 요약의 "지움"에도 넣는다.
    $pathRemoved = $false
    $binDir = Join-Path $Prefix "bin"
    $normalize = { param($p) $p.TrimEnd('\').ToLowerInvariant() }
    $userPath = Get-UserPath
    if ($userPath) {
      $parts = ($userPath -split ";") | Where-Object { $_ -ne "" -and (& $normalize $_) -ne (& $normalize $binDir) }
      $newUserPath = $parts -join ";"
      if ($newUserPath -ne $userPath) { $pathRemoved = $true }
      Set-UserPathIfChanged $newUserPath $userPath
    }

    Remove-Item -Recurse -Force -Confirm:$false -ErrorAction SilentlyContinue -LiteralPath (Join-Path $Prefix "app")
    Remove-Item -Recurse -Force -Confirm:$false -ErrorAction SilentlyContinue -LiteralPath (Join-Path $Prefix "plugin")
    Remove-Item -Recurse -Force -Confirm:$false -ErrorAction SilentlyContinue -LiteralPath (Join-Path $Prefix "bin")
    Remove-Item -Force -Confirm:$false -ErrorAction SilentlyContinue -LiteralPath (Join-Path $Prefix "VERSION")
    Remove-Item -Force -Confirm:$false -ErrorAction SilentlyContinue -LiteralPath (Join-Path $Prefix "사용설명서.html")
    # token(대시보드 열쇠), state.json(층 예산), policy.json(권한 정책)과 그 .broken도 프로그램 파일로 함께 지운다(sh와 같음, 요약 문구는 그대로)
    Remove-Item -Force -Confirm:$false -ErrorAction SilentlyContinue -LiteralPath (Join-Path $Prefix "token")
    Remove-Item -Force -Confirm:$false -ErrorAction SilentlyContinue -LiteralPath (Join-Path $Prefix "state.json")
    Remove-Item -Force -Confirm:$false -ErrorAction SilentlyContinue -LiteralPath (Join-Path $Prefix "policy.json")
    Remove-Item -Force -Confirm:$false -ErrorAction SilentlyContinue -LiteralPath (Join-Path $Prefix "policy.json.broken")

    $removeLogs = & $ask_u "로그와 진단 파일도 지울까요?"
    if ($removeLogs) {
      Remove-Item -Recurse -Force -Confirm:$false -ErrorAction SilentlyContinue -LiteralPath (Join-Path $Prefix "logs")
      Remove-Item -Recurse -Force -Confirm:$false -ErrorAction SilentlyContinue -LiteralPath (Join-Path $Prefix "diagnostics")
    }
    # $Prefix 자체는 비어 있을 때만 지운다 — 비어 있지 않은데 Remove-Item을 부르면(-Recurse 없이)
    # 확인 질문으로 멈출 수 있다(리뷰어 Minor). 지우기 전에 직접 세어 본다.
    if ((Get-ChildItem -Force -LiteralPath $Prefix -ErrorAction SilentlyContinue | Measure-Object).Count -eq 0) {
      Remove-Item -Force -Confirm:$false -ErrorAction SilentlyContinue -LiteralPath $Prefix
    }

    # SPEC 3장: 제거가 끝나면 무엇을 지웠고 무엇을 남겼는지 알린다(sh와 글자까지 같은 문구 — B17).
    # #82(qa 발견): app/bin/plugin·VERSION·사용설명서 삭제는 두 질문과 무관하게 항상 일어나므로
    # "지움"에 항상 "프로그램 파일"을 넣는다 — 전에는 두 질문에 모두 아니오로 답하면 "지움: 없음"
    # 이라고 나왔지만 실제로는 이 파일들이 지워져 요약이 사실과 달랐다.
    $removed = New-Object System.Collections.Generic.List[string]
    $removed.Add("프로그램 파일")
    $kept = New-Object System.Collections.Generic.List[string]
    if ($pathRemoved) { $removed.Add("PATH 설정") }
    if ($pluginRemoved) { $removed.Add("플러그인") }
    if ($pluginKept) { $kept.Add("플러그인") }
    if ($removeLogs) { $removed.Add("logs"); $removed.Add("diagnostics") } else { $kept.Add("logs"); $kept.Add("diagnostics") }
    Write-Host "제거를 마쳤습니다."
    Write-Host "지움: $($removed -join ', ')"
    Write-Host "남김: $(if ($kept.Count -gt 0) { $kept -join ', ' } else { '없음' })"
    if ($UninstallInputBlocked -and -not $UYes -and $EofNo) {
      # FB-1: sh와 글자까지 같은 문구(설치 쪽은 "설치하려면", 여기는 "제거하려면"). uninstall은
      # 런처가 "--yes" 원시 문자열을 직접 보므로(install.ps1의 [switch]$Yes와 달리) 여기는
      # "--yes" 그대로 쓴다(#115 Important). 입력이 끊겨 아니오가 됐을 때($EofNo)만 세운다(B65).
      Write-Host "입력을 받을 수 없어 '아니오'로 처리했습니다. 제거하려면 --yes를 붙여 다시 실행하세요."
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
      # 토큰 주소(/?k=…)로 연다(Phase 2 스펙 7.1). 서버가 방금 토큰을 만들었을 수 있어 1초 뒤에 읽는다(B33).
      # 백그라운드 job(Start-Job)은 콘솔에 쓰지 못하므로 같은 프로세스의 runspace에서 열고, 열기에 실패했을 때만
      # 붙여 넣을 주소를 콘솔에 쓴다(Ruling B45, sh와 같은 문구). 로그에는 쓰지 않는다
      $opener = [powershell]::Create().AddScript({
        param($p, $tokenFile)
        Start-Sleep -Seconds 1
        $url = "http://127.0.0.1:$p/"
        if (Test-Path -LiteralPath $tokenFile) {
          $t = ([System.IO.File]::ReadAllText($tokenFile)).Trim()
          if ($t) { $url = "$url" + "?k=$t" }
        }
        try { Start-Process $url -ErrorAction Stop } catch {
          [Console]::WriteLine("브라우저를 열지 못했습니다. 이 주소를 브라우저에 붙여 넣어 주세요: $url")
          [Console]::WriteLine("이 주소는 열쇠입니다. 남에게 보내지 마세요.")
        }
      }).AddArgument($port).AddArgument((Join-Path $Prefix "token"))
      $null = $opener.BeginInvoke()
    }
    # SPEC 3장 명령 표: sh와 글자까지 같은 안내(B17).
    Write-Host "이 창을 닫으면 대시보드가 꺼집니다."
    & node (Join-Path $Prefix "app\server.mjs") @RestArgs
    exit $LASTEXITCODE
  }
}
