#!/bin/sh
# claude-office 명령. install.sh가 <prefix>/bin/claude-office로 복사해 둔다.
set -eu

# $0이 심볼릭 링크일 수 있다(예: 사용자가 ln -s ~/.claude-office/bin/claude-office
# /usr/local/bin/claude-office로 PATH에 또 등록한 경우) — 그걸 안 풀면 PREFIX가
# "$(dirname /usr/local/bin/claude-office)/.." = /usr/local이 되어, uninstall이 설치
# 폴더가 아니라 /usr/local 전체를 지우려 든다(리뷰어 실측 — Critical). macOS 기본 sh/readlink엔
# -f가 없어 반복문으로 링크 체인을 끝까지 푼다.
resolve_self() {
  p=$1
  case "$p" in
    /*) : ;;
    *) p=$(pwd)/$p ;;
  esac
  i=0
  while [ -L "$p" ] && [ "$i" -lt 32 ]; do
    link=$(readlink "$p")
    case "$link" in
      /*) p=$link ;;
      *) p=$(dirname "$p")/$link ;;
    esac
    i=$((i + 1))
  done
  echo "$p"
}
SELF=$(resolve_self "$0")
# pwd -P로 중간 경로의 심볼릭 링크까지 전부 물리 경로로 푼다(resolve_self는 $0 자체만 풀었다).
PREFIX=$(cd "$(dirname "$SELF")/.." && pwd -P)

# PREFIX나 $HOME을 글자 그대로 비교하면 $HOME 끝에 "/"가 붙은 경우 등을 놓친다(T7 fix round 2,
# install.sh와 같은 이유 — Ruling B15). $HOME도 pwd -P로 같은 방식으로 정규화해서 비교한다.
NORM_HOME=$(cd "$HOME" 2>/dev/null && pwd -P) || NORM_HOME=$HOME
case "$PREFIX" in
  /*[!/]*) : ;;
  *) PREFIX="/" ;; # 선행 "//"를 그대로 돌려주는 환경 대응(install.sh와 같음)
esac

# PREFIX가 비었거나 "/"이거나 $HOME 자체면(위 심볼릭 링크 버그나 손상된 설치) 아래 rm -rf들이
# 엉뚱한 곳을 지울 수 있다 — uninstall뿐 아니라 서버·doctor·diag 실행 전에도 항상 검증한다
# (리뷰어 Critical). 설치가 실제로 돼 있는지는 app/server.mjs·VERSION 존재로 판단한다.
case "$PREFIX" in
  "" | "/") echo "설치 폴더 경로가 올바르지 않습니다(\"$PREFIX\"). 다시 설치해 주세요." >&2; exit 1 ;;
esac
if [ "$PREFIX" = "$NORM_HOME" ]; then
  echo "설치 폴더 경로가 올바르지 않습니다(홈 폴더 자체). 다시 설치해 주세요." >&2
  exit 1
fi
if [ ! -f "$PREFIX/app/server.mjs" ] || [ ! -f "$PREFIX/VERSION" ]; then
  echo "설치 폴더를 찾지 못했습니다(\"$PREFIX\") — 다시 설치해 주세요." >&2
  exit 1
fi

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

    # rc 파일들에서 표지 줄("# claude-office PATH")과 그 바로 다음 줄(export), 그리고 표지
    # 바로 앞의 빈 줄(install.sh가 매번 넣는 구분용 빈 줄 — 안 지우면 재설치·제거를 반복할 때마다
    # 빈 줄이 계속 쌓인다)만 지운다. 표지가 없으면 파일을 아예 건드리지 않는다(mtime 보존).
    # mv로 바꿔치기하면 rc가 심볼릭 링크(dotfiles 관리 도구가 흔히 씀)일 때 링크 자체가 평범한
    # 파일로 바뀌고 권한(예: 600)도 새 파일 기본값으로 바뀐다 — 그래서 mv 대신 cat으로 같은
    # inode에 내용만 다시 써 넣는다(리뷰어 Important).
    # macOS(Darwin)에서 로그인 셸이 bash면 터미널이 .bashrc가 아니라 .bash_profile을 읽으므로
    # 그것도 대상에 넣는다(설치 때도 같은 파일을 쓴다 — 아래 install.sh 참고).
    for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
      [ -f "$rc" ] || continue
      if grep -q '^# claude-office PATH$' "$rc"; then
        tmp="$rc.tmp-$$"
        awk '
          { lines[NR] = $0 }
          END {
            for (i = 1; i <= NR; i++) {
              if (lines[i] == "# claude-office PATH") {
                del[i] = 1
                del[i + 1] = 1
                if (i > 1 && lines[i - 1] == "") del[i - 1] = 1
              }
            }
            for (i = 1; i <= NR; i++) if (!(i in del)) print lines[i]
          }
        ' "$rc" > "$tmp" && cat "$tmp" > "$rc"
        rm -f "$tmp"
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
      case "$a" in
        --port=*) port=${a#--port=} ;;
      esac
      [ "$prev" = "--port" ] && port="$a"
      prev="$a"
    done
    if [ -z "${CLAUDE_OFFICE_NO_OPEN:-}" ]; then
      (sleep 1; open "http://127.0.0.1:$port/" 2>/dev/null || xdg-open "http://127.0.0.1:$port/" 2>/dev/null) &
    fi
    exec node "$PREFIX/app/server.mjs" "$@"
    ;;
esac
