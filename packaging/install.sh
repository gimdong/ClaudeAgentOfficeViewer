#!/bin/sh
# claude-office 설치 스크립트. 패키지 폴더 안에서 실행한다($(dirname "$0") 기준).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
PREFIX="$HOME/.claude-office"; YES=0; NOPATH=0; NOOPEN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX=$2; shift 2 ;;
    --yes) YES=1; shift ;;
    --no-path) NOPATH=1; shift ;;
    --no-open) NOOPEN=1; shift ;;
    *) echo "알 수 없는 옵션: $1" >&2; exit 2 ;;
  esac
done
ask() { [ "$YES" = 1 ] && return 0; printf '%s [y/N] ' "$1"; read -r a; [ "$a" = y ] || [ "$a" = Y ]; }

# 설치 로그(SPEC 4장): 단계마다 한 줄 "<ISO시각> <단계> ok|fail|skip <쉬운 말 메시지>". 비밀값·환경변수
# 값은 쓰지 않는다(경로는 됨). Node 검사가 실패할 수도 있으니 logs 폴더는 그보다 먼저 만든다.
mkdir -p "$PREFIX/logs"
LOGFILE="$PREFIX/logs/install-$(date +%Y%m%d-%H%M%S).log"
log() { printf '%s %s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "$3" >> "$LOGFILE"; }
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
cp "$HERE/claude-office.sh" "$PREFIX/bin/claude-office"; chmod 755 "$PREFIX/bin/claude-office"
log copy ok "앱 파일 복사 완료"

# 3. PATH
if [ "$NOPATH" = 0 ]; then
  case "${SHELL:-}" in */zsh) RC="$HOME/.zshrc" ;; *) RC="$HOME/.bashrc"; [ -f "$RC" ] || RC="$HOME/.profile" ;; esac
  if grep -q '^# claude-office PATH$' "$RC" 2>/dev/null; then
    log path skip "이미 ${RC}에 등록됨"
  elif ask "${RC}에 claude-office 명령 경로를 추가할까요?"; then
    printf '\n# claude-office PATH\nexport PATH="%s/bin:$PATH"\n' "$PREFIX" >> "$RC"
    log path ok "${RC}에 PATH 추가"
  else
    log path skip "사용자가 거절함"
  fi
else
  log path skip "--no-path"
fi

# 4. 플러그인
if command -v claude >/dev/null 2>&1; then
  if ask "Claude Code 플러그인(claude-office)을 설치할까요? 도구 사용 기록을 이 PC의 뷰어로 보냅니다."; then
    plugin_ok=1
    claude plugin marketplace add "$PREFIX/plugin" || { echo "마켓플레이스 등록 실패 — 사용설명서 5장을 봐 주세요." >&2; plugin_ok=0; }
    claude plugin install claude-office@claude-office --scope user || { echo "플러그인 설치 실패 — 사용설명서 5장을 봐 주세요." >&2; plugin_ok=0; }
    if [ "$plugin_ok" = 1 ]; then log plugin ok "플러그인 설치 완료"; else log plugin fail "플러그인 설치 중 오류(설치는 계속함)"; fi
  else
    log plugin skip "사용자가 거절함"
  fi
else
  log plugin skip "claude 명령 없음"
  echo "claude 명령을 찾지 못해 플러그인 설치를 건너뜁니다. 나중에:"
  echo "  claude plugin marketplace add \"$PREFIX/plugin\""
  echo "  claude plugin install claude-office@claude-office --scope user"
fi

# 5. doctor
if "$PREFIX/bin/claude-office" doctor; then
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
