#!/bin/sh
# claude-office 명령. install.sh가 <prefix>/bin/claude-office로 복사해 둔다.
set -eu
PREFIX=$(cd "$(dirname "$0")/.." && pwd)
# 모든 하위 명령에서 항상 export한다 — 그래야 서버 로거가 <prefix>/logs로 쓴다(Ruling B10).
export CLAUDE_OFFICE_PREFIX="$PREFIX"

# 아주 옛 Node는 번들(server.mjs)의 최신 문법 자체에서 죽어 서버 안의 자체 Node 검사까지 가지
# 못한다(예: 최상위 await, 옵셔널 체이닝보다 새 문법) — 그러니 여기서도 먼저 확인한다(Ruling B10).
command -v node >/dev/null 2>&1 || { echo "Node.js 24 이상이 필요합니다. https://nodejs.org 에서 LTS를 설치해 주세요." >&2; exit 1; }
major=$(node -v | sed 's/^v\([0-9]*\).*/\1/')
[ "$major" -ge 24 ] || { echo "Node.js 24 이상이 필요합니다(지금 $(node -v))." >&2; exit 1; }

ask() { printf '%s [y/N] ' "$1"; read -r a; [ "$a" = y ] || [ "$a" = Y ]; }

cmd="${1:-}"
case "$cmd" in
  doctor|diag)
    exec node "$PREFIX/app/server.mjs" "$@"
    ;;
  --version)
    cat "$PREFIX/VERSION"
    ;;
  uninstall)
    shift
    UYES=0
    for a in "$@"; do [ "$a" = "--yes" ] && UYES=1; done
    ask_u() { [ "$UYES" = 1 ] && return 0; ask "$1"; }

    if command -v claude >/dev/null 2>&1; then
      claude plugin uninstall claude-office@claude-office --scope user || true
      claude plugin marketplace remove claude-office || true
    fi

    # rc 파일들에서 표지 줄("# claude-office PATH")과 그 바로 다음 줄(export)만 지운다.
    # 표지가 없으면 파일을 아예 건드리지 않는다(mtime 보존).
    for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
      [ -f "$rc" ] || continue
      if grep -q '^# claude-office PATH$' "$rc"; then
        tmp="$rc.tmp-$$"
        awk '
          $0 == "# claude-office PATH" { skip = 1; next }
          skip > 0 { skip--; next }
          { print }
        ' "$rc" > "$tmp"
        mv "$tmp" "$rc"
      fi
    done

    rm -rf "$PREFIX/app" "$PREFIX/plugin" "$PREFIX/bin" "$PREFIX/VERSION" "$PREFIX/사용설명서.html"
    if ask_u "로그와 진단 파일도 지울까요?"; then
      rm -rf "$PREFIX/logs" "$PREFIX/diagnostics"
      rmdir "$PREFIX" 2>/dev/null || true
    fi
    ;;
  *)
    port=4317
    prev=""
    for a in "$@"; do
      [ "$prev" = "--port" ] && port="$a"
      prev="$a"
    done
    if [ -z "${CLAUDE_OFFICE_NO_OPEN:-}" ]; then
      (sleep 1; open "http://127.0.0.1:$port/" 2>/dev/null || xdg-open "http://127.0.0.1:$port/" 2>/dev/null) &
    fi
    exec node "$PREFIX/app/server.mjs" "$@"
    ;;
esac
