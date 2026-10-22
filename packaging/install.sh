#!/bin/sh
# claude-office 설치 스크립트. 패키지 폴더 안에서 실행한다($(dirname "$0") 기준).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
PREFIX="$HOME/.claude-office"; YES=0; NOPATH=0; NOOPEN=0; PORT=""; SL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix)
      if [ $# -lt 2 ]; then echo "--prefix에는 설치 폴더 경로가 필요합니다. 예: --prefix /opt/claude-office" >&2; exit 2; fi
      PREFIX=$2; shift 2 ;;
    --yes) YES=1; shift ;;
    --no-path) NOPATH=1; shift ;;
    --no-open) NOOPEN=1; shift ;;
    # statusline 연결을 묻지 않고 켠다(스펙 12장 j, B325 — --yes만으로는 켜지 않는다)
    --statusline) SL=1; shift ;;
    # 끝의 doctor가 볼 포트(Phase 6a §5). 시험 설치가 사용자 대시보드(4317)에 묻지 않게 한다(B279)
    --port)
      case "${2:-}" in
        [1-9]|[1-9][0-9]|[1-9][0-9][0-9]|[1-9][0-9][0-9][0-9]|[1-9][0-9][0-9][0-9][0-9]) [ "$2" -le 65535 ] && { PORT=$2; shift 2; continue; } ;;
      esac
      echo "--port에는 1~65535 숫자가 필요합니다. 예: --port 4321" >&2; exit 2 ;;
    *) echo "알 수 없는 옵션: $1" >&2; exit 2 ;;
  esac
done

# 빈 값은 절대/상대 변환 전에 먼저 걸러낸다 — 변환하면 빈 문자열이 "$(pwd)/"가 되어 거부를
# 피해갈 수 있다.
case "$PREFIX" in
  "") echo "설치 폴더로 빈 값은 쓸 수 없습니다." >&2; exit 2 ;;
esac
case "$PREFIX" in
  /*) : ;;
  *) PREFIX="$(pwd)/$PREFIX" ;; # 상대 경로는 지금 디렉터리 기준 절대 경로로(cwd가 나중에 바뀌면 꼬인다)
esac

# "$PREFIX" = "$HOME"처럼 글자 그대로 비교하면 --prefix "$HOME/"나 "//"나 "$HOME/."가 거부를
# 피해간다(리뷰어 실측 — Important, B15). cd+pwd -P로 심볼릭 링크·"."·".."·중복/끝 슬래시를 전부
# 같은 결과로 정규화한 뒤 비교한다. 처음 설치할 땐 PREFIX 자체가 아직 없는 게 보통이라(기본값
# ~/.claude-office도 처음엔 없음), 존재하는 가장 가까운 조상까지 올라가 그걸 정규화하고 없는
# 나머지 이름을 뒤에 붙인다 — 그 "없는 나머지" 안에 "."·".."가 있으면 뜻이 애매해지므로 거부한다.
normalize_path() {
  p=$1
  if existing=$(cd "$p" 2>/dev/null && pwd -P); then
    printf '%s\n' "$existing"
    return 0
  fi
  rest=""
  cur=$p
  i=0
  while [ "$i" -lt 64 ]; do
    name=$(basename "$cur")
    case "$name" in
      "." | "..")
        echo "설치 폴더 경로에 \".\"나 \"..\"가 있으면 안 됩니다." >&2
        exit 2
        ;;
    esac
    rest="$name${rest:+/$rest}"
    parent=$(dirname "$cur")
    if existing=$(cd "$parent" 2>/dev/null && pwd -P); then
      printf '%s/%s\n' "$existing" "$rest"
      return 0
    fi
    cur=$parent
    i=$((i + 1))
  done
  printf '%s\n' "$p" # 여기까지 왔으면(사실상 안 옴 — "/"는 항상 있다) 원래 값을 그대로 쓴다
}
PREFIX=$(normalize_path "$PREFIX")
NORM_HOME=$(normalize_path "$HOME")
# POSIX는 선행 "//"를 구현 정의로 남겨 둬서, 이 환경의 pwd -P는 "//"를 "/"로 뭉개지 않고 그대로
# 돌려준다(직접 확인) — 슬래시만 있는 결과는 전부 "/"로 본다.
case "$PREFIX" in
  /*[!/]*) : ;;
  *) PREFIX="/" ;;
esac
if [ "$PREFIX" = "/" ]; then
  echo "설치 폴더로 \"/\"는 쓸 수 없습니다." >&2
  exit 2
fi
if [ "$PREFIX" = "$NORM_HOME" ]; then
  echo "설치 폴더로 홈 폴더 자체는 쓸 수 없습니다. 예: --prefix \"\$HOME/.claude-office\"" >&2
  exit 2
fi

# 대상 폴더가 이미 있고 비어 있지 않은데 우리가 설치한 흔적(VERSION)이 없으면 남의 폴더일 수
# 있다 — 재설치(VERSION 있음)는 그대로 두고, 그 밖의 경우만 거부한다(B15).
if [ -d "$PREFIX" ] && [ -n "$(ls -A "$PREFIX" 2>/dev/null)" ] && [ ! -f "$PREFIX/VERSION" ]; then
  echo "이미 다른 파일이 있는 폴더입니다. 빈 폴더나 새 폴더 이름을 지정해 주세요." >&2
  exit 2
fi

# FB-1 안내(B65): 실제로 물었는데 읽기가 EOF로 끊겨(읽은 글자 없음) "아니오"가 됐을 때만 EOF_NO=1로 세운다.
# 파이프로 y·n을 답했으면 읽기에 성공했으므로 안내하지 않는다(전에는 "물어봤는지"만 봐서 파이프 답에도 안내가 나왔다).
# 마지막 줄에 줄바꿈 없이 "y"만 온 경우는 read가 실패해도 글자를 읽었으므로 답으로 본다.
EOF_NO=0
ask() { [ "$YES" = 1 ] && return 0; printf '%s [y/N] ' "$1"; read -r a || { [ -n "${a:-}" ] || EOF_NO=1; }; [ "$a" = y ] || [ "$a" = Y ]; }

# FB-1(사용자 피드백, 2026-10-01): 표준 입력이 터미널이 아니면(예: `!`로 돌리거나 파이프로 실행)
# read가 바로 EOF를 받아 모든 질문이 조용히 "아니오"가 된다 — 스펙대로지만 안내가 없어서, 사용자가
# 두 질문 다 거절된 걸 보고서야 --yes가 필요하다는 걸 알았다. --yes가 없는데 입력을 못 받는
# 환경이면 끝에 안내를 한 줄 낸다(ps1과 글자까지 같은 문구).
if [ -t 0 ]; then STDIN_TTY=1; else STDIN_TTY=0; fi

# 설치 로그(SPEC 4장): 단계마다 한 줄 "<ISO 오프셋 시각> <단계> ok|fail|skip <쉬운 말 메시지>". 비밀값·
# 환경변수 값(USER, whoami, 호스트 이름 등)은 안 쓴다 — 경로는 되지만, 반드시 줄 끝에 큰따옴표로 감싸
# 쓴다(Ruling B10 보강 — 리뷰어 실측: 진단 파일의 경로 가림이 공백을 포함해 다음 "/"·따옴표·줄 끝까지를
# 경로로 보기 때문에, 경로 뒤에 설명을 쓰면 그 설명까지 함께 가려진다. 설명은 항상 경로보다 앞에 쓴다).
# 줄의 시각은 로컬 시각 + 오프셋(%z, 예: +0900)이다 — 파일 이름(아래 LOGFILE)도 로컬 시각이라
# 둘을 맞췄다(UTC "Z"로 쓰면 파일 이름과 줄 시각이 서로 다른 기준이 되어 혼란을 준다).
# Node 검사가 실패할 수도 있으니 logs 폴더는 그보다 먼저 만든다.
mkdir -p "$PREFIX/logs"
LOGFILE="$PREFIX/logs/install-$(date +%Y%m%d-%H%M%S).log"
log() { printf '%s %s %s %s\n' "$(date +%Y-%m-%dT%H:%M:%S%z)" "$1" "$2" "$3" >> "$LOGFILE"; }
fail() {
  log "$1" fail "$2"
  echo "$2" >&2
  echo "자세한 기록: $LOGFILE" >&2
  exit 1
}

# 1. Node 확인
command -v node >/dev/null 2>&1 || fail node "Node.js 24 이상이 필요합니다. https://nodejs.org 에서 LTS를 설치해 주세요."
major=$(node -v | sed 's/^v\([0-9]*\).*/\1/')
if [ "$major" -ge 24 ]; then
  log node ok "Node $(node -v) 확인"
else
  fail node "Node.js 24 이상이 필요합니다(지금 $(node -v))."
fi

# 2. 복사 — app·plugin만 교체, logs·diagnostics 유지
mkdir -p "$PREFIX/bin" "$PREFIX/diagnostics"
rm -rf "$PREFIX/app" "$PREFIX/plugin"
cp -R "$HERE/app" "$PREFIX/app"
cp -R "$HERE/plugin" "$PREFIX/plugin"
cp "$HERE/VERSION" "$PREFIX/VERSION"
[ -f "$HERE/사용설명서.html" ] && cp "$HERE/사용설명서.html" "$PREFIX/사용설명서.html"
[ -f "$HERE/manual-en.html" ] && cp "$HERE/manual-en.html" "$PREFIX/manual-en.html"
cp "$HERE/claude-office.sh" "$PREFIX/bin/claude-office"; chmod 755 "$PREFIX/bin/claude-office"
log copy ok "앱 파일 복사 완료 \"$PREFIX/app\""

# 2-1. 대시보드 토큰(Phase 2 스펙 7.1): 없으면 무작위 32바이트(hex)를 0600으로 만들고, 있으면 그대로 둔다.
# 값은 화면·설치 로그 어디에도 쓰지 않는다(로그에는 ok/skip만). 서버도 없으면 만들지만(B33) 설치 때 미리 둔다
if [ -s "$PREFIX/token" ]; then
  log token skip "이미 있음"
else
  ( umask 077; node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' > "$PREFIX/token" ) || fail token "대시보드 토큰 파일을 만들지 못했습니다."
  chmod 600 "$PREFIX/token"
  log token ok "토큰 파일 준비"
fi

# 2-2. hook relay 열쇠(Phase 6a §4): 토큰과 같은 방식. 서버도 없으면 만든다
if [ -s "$PREFIX/hook.key" ]; then
  log hookkey skip "이미 있음"
else
  ( umask 077; node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' > "$PREFIX/hook.key" ) || fail hookkey "hook 열쇠 파일을 만들지 못했습니다."
  chmod 600 "$PREFIX/hook.key"
  log hookkey ok "hook 열쇠 파일 준비"
fi

# 2-3. hooks.json 자리 표시자(Phase 6a §2): 플러그인 등록(4단계)보다 먼저 $PREFIX/plugin 사본에서 바꾼다 —
# Claude Code가 등록할 때 이 사본을 캐시로 복사해 실행한다. node로 JSON을 읽어 command·args의 자리만 바꾸고(글자 치환 아님),
# 자리 표시자가 하나라도 남거나 실패하면 설치를 멈춘다(남은 __NODE__는 모든 hook을 조용히 실패시킨다). 바꾸기는 fill-hooks.cjs(ps1과 같이 씀)
node "$HERE/fill-hooks.cjs" "$PREFIX/plugin/plugins/claude-office/hooks/hooks.json" "$PREFIX/hook.key" "$(command -v node)" \
  || fail hooks "플러그인 hook 설정(node·열쇠 경로)을 쓰지 못해 설치를 멈춥니다 — 사용설명서 6장(문제가 생겼을 때)을 봐 주세요."
log hooks ok "hook 설정에 node·열쇠 경로 기록"

# 3. PATH
PATH_ADDED=0 # SPEC 3장: PATH에 안 들어갔으면 끝에서 전체 경로 실행법을 안내해야 한다
if [ "$NOPATH" = 0 ]; then
  # macOS(Darwin)에서는 Terminal.app이 로그인 셸을 띄우고, 로그인 bash는 .bashrc가 아니라
  # .bash_profile을 읽는다 — .bashrc에 추가하면 새 터미널에서 적용이 안 된 것처럼 보인다.
  case "${SHELL:-}" in
    */zsh) RC="$HOME/.zshrc" ;;
    */bash)
      if [ "$(uname)" = "Darwin" ]; then RC="$HOME/.bash_profile"
      else RC="$HOME/.bashrc"; [ -f "$RC" ] || RC="$HOME/.profile"
      fi
      ;;
    *) RC="$HOME/.bashrc"; [ -f "$RC" ] || RC="$HOME/.profile" ;;
  esac
  if grep -q '^# claude-office PATH$' "$RC" 2>/dev/null; then
    log path skip "이미 등록됨 \"$RC\""
    PATH_ADDED=1
  elif ask "${RC}에 claude-office 명령 경로를 추가할까요?"; then
    printf '\n# claude-office PATH\nexport PATH="%s/bin:$PATH"\n' "$PREFIX" >> "$RC"
    log path ok "PATH 추가 \"$RC\""
    PATH_ADDED=1
  else
    log path skip "사용자가 거절함"
  fi
else
  log path skip "--no-path"
fi

# 4. 플러그인
if command -v claude >/dev/null 2>&1; then
  if ask "Claude Code 플러그인(claude-office)을 설치할까요? 도구 사용 기록을 이 PC의 뷰어로 보내고, 대시보드에서 답한 허용·거부를 Claude Code에 돌려줍니다."; then
    plugin_ok=1
    claude plugin marketplace add "$PREFIX/plugin" || { echo "마켓플레이스 등록 실패 — 사용설명서 6장(문제가 생겼을 때)을 봐 주세요." >&2; plugin_ok=0; }
    claude plugin install claude-office@claude-office --scope user || { echo "플러그인 설치 실패 — 사용설명서 6장(문제가 생겼을 때)을 봐 주세요." >&2; plugin_ok=0; }
    # 이미 설치돼 있으면 install은 등록(버전·경로)을 그대로 둔다 — update가 새 버전으로 다시 적는다(FB-4).
    # 실패해도 설치는 계속한다(옛 Claude Code 등). 등록이 옛 버전에 남으면 doctor의 "결정 대기 시간"이 알려 준다
    claude plugin update claude-office@claude-office --scope user || true
    if [ "$plugin_ok" = 1 ]; then log plugin ok "플러그인 설치 완료"; else log plugin fail "플러그인 설치 중 오류(설치는 계속함)"; fi
  else
    log plugin skip "사용자가 거절함"
  fi
else
  log plugin skip "claude 명령 없음"
  echo "claude 명령을 찾지 못해 플러그인 설치를 건너뜁니다. 나중에:"
  echo "  claude plugin marketplace add \"$PREFIX/plugin\""
  echo "  claude plugin install claude-office@claude-office --scope user"
  echo "  claude plugin update claude-office@claude-office --scope user"
fi

# 4-1. statusline 연결(스펙 12장 j, B325): PLAN 바의 값을 받는다. Claude Code 설정의 statusLine을 바꾸므로
# ask()(--yes면 무조건 y)를 쓰지 않는다 — --statusline이거나, 터미널에서 직접 y라고 답했을 때만 켠다.
# 이미 켜져 있으면 새 설치본 경로로 다시 맞춘다. 제거할 때 같은 설정 폴더를 되돌리도록 그 경로를 남긴다(B328)
SL_JS="$PREFIX/app/statusline-setup.mjs"
sl_on() {
  ( umask 077; printf '%s\n' "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" > "$PREFIX/statusline-config" )
  if node "$SL_JS" install --installed; then log statusline ok "statusline 연결 켬"; else log statusline fail "statusline 연결 실패(설치는 계속함)"; fi
}
if [ ! -f "$SL_JS" ]; then
  log statusline skip "도우미 없음"
elif [ "$(node "$SL_JS" status 2>/dev/null || true)" = on ] || [ "$SL" = 1 ]; then
  sl_on
elif [ "$STDIN_TTY" = 1 ] && [ "$YES" = 0 ]; then
  SL_FILE=${CLAUDE_CONFIG_DIR:-"~/.claude"}/settings.json
  printf '%s [y/N] ' "Claude Code 상태줄(statusline)에 연결할까요? PLAN 바(남은 사용량 %)를 채우려면 필요합니다. Claude Code 설정($SL_FILE)의 statusLine을 바꾸고, 원래 설정은 백업하며, 쓰던 상태줄은 그대로 보입니다."
  read -r a || a=""
  if [ "$a" = y ] || [ "$a" = Y ]; then sl_on; else log statusline skip "사용자가 거절함"; fi
else
  echo "statusline 연결은 묻지 않고 건너뛰었습니다. 켜려면 설치 스크립트를 --statusline을 붙여 다시 실행하세요."
  log statusline skip "묻지 않음(--yes 또는 터미널 아님)"
fi

# 5. doctor
if "$PREFIX/bin/claude-office" doctor ${PORT:+--port "$PORT"}; then
  log doctor ok "환경 점검 통과"
else
  log doctor fail "환경 점검에서 문제 발견(설치는 계속함)"
fi

# 6. 사용설명서, 완료
if [ "$NOOPEN" = 0 ] && [ -f "$PREFIX/사용설명서.html" ]; then
  (open "$PREFIX/사용설명서.html" 2>/dev/null || xdg-open "$PREFIX/사용설명서.html" 2>/dev/null) || true
fi
log done ok "설치 완료"
echo "설치 완료. 새 터미널에서 claude-office 를 실행하세요."
if [ "$PATH_ADDED" = 0 ]; then
  # SPEC 3장 3단계: PATH에 안 들어갔으면(거절했거나 --no-path) 전체 경로 실행법을 안내한다
  # (ps1과 글자까지 같은 문구 — B17).
  echo "다음부터는 이렇게 켜세요: $PREFIX/bin/claude-office"
fi
if [ "$STDIN_TTY" = 0 ] && [ "$YES" = 0 ] && [ "$EOF_NO" = 1 ]; then
  # FB-1: ps1과 글자까지 같은 문구. 입력이 끊겨 아니오가 됐을 때만(B65).
  echo "입력을 받을 수 없어 '아니오'로 처리했습니다. 설치하려면 --yes를 붙여 다시 실행하세요."
fi
