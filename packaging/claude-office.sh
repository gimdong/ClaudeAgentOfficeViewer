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

# FB-1 안내(B65): 실제로 물었는데 읽기가 EOF로 끊겨(읽은 글자 없음) "아니오"가 됐을 때만 EOF_NO=1로 세운다.
# 파이프로 y·n을 답했으면 읽기에 성공했으므로 안내하지 않는다(전에는 "물어봤는지"만 봐서 파이프 답에도 안내가 나왔다).
# 마지막 줄에 줄바꿈 없이 "y"만 온 경우는 read가 실패해도 글자를 읽었으므로 답으로 본다.
EOF_NO=0
ask() { printf '%s [y/N] ' "$1"; read -r a || { [ -n "${a:-}" ] || EOF_NO=1; }; [ "$a" = y ] || [ "$a" = Y ]; }

# 토큰 주소를 브라우저 열기 명령의 인자에 싣지 않는다(B265 — 프로세스 인자는 같은 컴퓨터의 다른 계정도 ps로 본다).
# 0700 임시 폴더에 0600 HTML(토큰 주소로 넘기는 페이지)을 쓰고 그 경로만 연다. 30초 뒤 지운다(Ruling B267).
# Linux는 홈 아래(snap·flatpak 브라우저는 /tmp와 홈의 숨김 폴더를 못 읽는다), macOS는 사용자 전용 TMPDIR.
# 사용: open_url <주소> [브라우저 이름]. 실패하면 1(부르는 쪽이 붙여 넣을 주소를 안내한다). `||`와 함께 불러 set -e를 끈다
open_url() {
  if [ "$(uname 2>/dev/null)" = Linux ]; then base=$HOME/claude-office-open; else base=${TMPDIR:-/tmp}/claude-office; fi
  d=$(umask 077 && mktemp -d "$base.XXXXXX" 2>/dev/null) || return 1
  f="$d/open.html"
  if ! (umask 077 && printf '<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=%s"><script>location.replace("%s")</script><title>Claude Agent Office</title>\n' "$1" "$1" > "$f"); then
    rm -rf "$d"
    return 1
  fi
  if [ -n "${2:-}" ]; then open -a "$2" "$f" 2>/dev/null; else open "$f" 2>/dev/null || xdg-open "$f" 2>/dev/null; fi
  rc=$?
  # 터미널을 닫으면 오는 SIGHUP에 같이 끝나지 않게 nohup으로 떼어 낸다(Phase 6a §7, setsid는 macOS에 없다)
  nohup sh -c 'sleep 30; rm -rf "$1"' sh "$d" >/dev/null 2>&1 </dev/null &
  return $rc
}

cmd="${1:-}"
case "$cmd" in
  doctor|diag)
    exec node "$PREFIX/app/server.mjs" "$@"
    ;;
  --version)
    cat "$PREFIX/VERSION"
    ;;
  url)
    # 원격 보기(Phase 6a §6): 열쇠 주소를 stdout 한 줄로만 낸다. 브라우저는 열지 않고 서버도 켜지 않는다.
    # 토큰은 파일에서 읽어 printf(셸 내장)로만 쓴다 — 어떤 프로세스 인자에도 싣지 않는다(B265). `claude-office url [--port N]`
    shift
    port=4317
    prev=""
    for a in "$@"; do
      case "$a" in
        --port=*) port=${a#--port=} ;;
      esac
      [ "$prev" = "--port" ] && port="$a"
      prev="$a"
    done
    case "$port" in
      [1-9]|[1-9][0-9]|[1-9][0-9][0-9]|[1-9][0-9][0-9][0-9]|[1-9][0-9][0-9][0-9][0-9]) [ "$port" -le 65535 ] || { echo "--port에는 1~65535 숫자가 필요합니다. 예: --port 4321" >&2; exit 2; } ;;
      *) echo "--port에는 1~65535 숫자가 필요합니다. 예: --port 4321" >&2; exit 2 ;;
    esac
    if [ ! -s "$PREFIX/token" ]; then
      echo "대시보드 열쇠 파일이 없습니다 — claude-office를 한 번 켜면 만들어집니다." >&2
      exit 1
    fi
    printf 'http://127.0.0.1:%s/?k=%s\n' "$port" "$(tr -d ' \n\r' < "$PREFIX/token")"
    echo "이 주소는 열쇠입니다. 남에게 보내지 마세요." >&2 # stderr — $(claude-office url)로 받아도 주소 한 줄만 남는다
    ;;
  open)
    # FB-10: 이미 켜진 대시보드를 다른 브라우저로 열 길. `claude-office open [브라우저 이름] [--port N]`.
    # 열쇠 주소를 기본 브라우저(이름을 주면 그 브라우저)로 열고 서버는 켜지 않는다. 열쇠는 찍지 않는다(Ruling B45 유지)
    shift
    app=""
    port=4317
    prev=""
    for a in "$@"; do
      case "$a" in
        --port=*) port=${a#--port=} ;;
        --port) : ;;
        *) [ "$prev" = "--port" ] && port="$a" || app="$a" ;;
      esac
      prev="$a"
    done
    url="http://127.0.0.1:$port/"
    if [ -s "$PREFIX/token" ]; then url="${url}?k=$(tr -d ' \n\r' < "$PREFIX/token")"; fi
    open_url "$url" "$app" && exit 0
    echo "브라우저를 열지 못했습니다. 이 주소를 브라우저에 붙여 넣어 주세요: $url"
    echo "이 주소는 열쇠입니다. 남에게 보내지 마세요."
    exit 1
    ;;
  uninstall)
    shift
    UYES=0
    for a in "$@"; do [ "$a" = "--yes" ] && UYES=1; done
    # FB-1(B65): 안내는 ask()가 EOF로 아니오가 됐을 때(EOF_NO=1)만 — install.sh와 같은 규칙
    ask_u() { [ "$UYES" = 1 ] && return 0; ask "$1"; }
    # FB-1(사용자 피드백): install.sh와 같은 이유로, 표준 입력이 터미널이 아니면 두 질문 다
    # 조용히 "아니오"가 된다 — --yes 없이 그런 환경이면 끝에 안내한다(설치 쪽과 글자만 다름).
    if [ -t 0 ]; then STDIN_TTY=1; else STDIN_TTY=0; fi

    # SPEC 3장 "동의 필요": 플러그인 제거 전에 따로 묻는다. --yes면 묻지 않고, EOF 등으로 입력을
    # 못 받으면 ask()가 그대로 "아니오"가 된다(read 실패 시 $a가 비어 y/Y와 안 같음) — 플러그인은
    # 남겨 두고 지우는 법만 안내한다.
    plugin_removed=0
    plugin_kept=0
    if command -v claude >/dev/null 2>&1; then
      if ask_u "Claude Code에서 claude-office 플러그인도 지울까요?"; then
        # claude 호출 하나가 실패해도(stderr 한 줄 등) 나머지(PATH 정리·파일 삭제)는 계속되고
        # 두 번째 claude 호출도 각각 따로 시도한다(리뷰어 Important — 한쪽만 실패해도 전체가
        # 멈추면 안 된다).
        claude plugin uninstall claude-office@claude-office --scope user || true
        claude plugin marketplace remove claude-office || true
        plugin_removed=1
      else
        echo "플러그인은 남겨 두었습니다. 지우려면: claude plugin uninstall claude-office@claude-office --scope user"
        plugin_kept=1
      fi
    fi

    # rc 파일들에서 표지 줄("# claude-office PATH")과 그 바로 다음 줄(export), 그리고 표지
    # 바로 앞의 빈 줄(install.sh가 매번 넣는 구분용 빈 줄 — 안 지우면 재설치·제거를 반복할 때마다
    # 빈 줄이 계속 쌓인다)만 지운다. 표지가 없으면 파일을 아예 건드리지 않는다(mtime 보존).
    # mv로 바꿔치기하면 rc가 심볼릭 링크(dotfiles 관리 도구가 흔히 씀)일 때 링크 자체가 평범한
    # 파일로 바뀌고 권한(예: 600)도 새 파일 기본값으로 바뀐다 — 그래서 mv 대신 cat으로 같은
    # inode에 내용만 다시 써 넣는다(리뷰어 Important).
    # macOS(Darwin)에서 로그인 셸이 bash면 터미널이 .bashrc가 아니라 .bash_profile을 읽으므로
    # 그것도 대상에 넣는다(설치 때도 같은 파일을 쓴다 — 아래 install.sh 참고).
    # #82(qa 발견): PATH 줄 삭제는 두 질문(플러그인·logs)과 무관하게 항상 시도된다 — 실제로
    # 지워졌으면(표지가 있어서 걸러낸 rc가 하나라도 있었으면) 아래 요약의 "지움"에도 넣는다.
    path_removed=0
    for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
      [ -f "$rc" ] || continue
      if grep -q '^# claude-office PATH$' "$rc"; then
        path_removed=1
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

    # token(대시보드 열쇠)·hook.key(hook relay 열쇠), state.json(층 예산), policy.json(권한 정책)과 그 .broken도 프로그램 파일로 함께 지운다(요약 문구는 그대로)
    rm -rf "$PREFIX/app" "$PREFIX/plugin" "$PREFIX/bin" "$PREFIX/VERSION" "$PREFIX/사용설명서.html" "$PREFIX/manual-en.html" "$PREFIX/token" "$PREFIX/state.json" "$PREFIX/policy.json" "$PREFIX/policy.json.broken" "$PREFIX/hook.key"
    logs_removed=0
    if ask_u "로그와 진단 파일도 지울까요?"; then
      rm -rf "$PREFIX/logs" "$PREFIX/diagnostics"
      rmdir "$PREFIX" 2>/dev/null || true
      logs_removed=1
    fi

    # SPEC 3장: 제거가 끝나면 무엇을 지웠고 무엇을 남겼는지 알린다(ps1과 글자까지 같은 문구 — B17).
    # #82(qa 발견): app/bin/plugin·VERSION·사용설명서 삭제는 두 질문과 무관하게 항상 일어나므로
    # "지움"에 항상 "프로그램 파일"을 넣는다 — 전에는 두 질문에 모두 아니오로 답하면 "지움: 없음"
    # 이라고 나왔지만 실제로는 이 파일들이 지워져 요약이 사실과 달랐다.
    removed="프로그램 파일"
    kept=""
    [ "$path_removed" = 1 ] && removed="$removed, PATH 설정"
    [ "$plugin_removed" = 1 ] && removed="$removed, 플러그인"
    [ "$plugin_kept" = 1 ] && kept="${kept:+$kept, }플러그인"
    if [ "$logs_removed" = 1 ]; then
      removed="$removed, logs, diagnostics"
    else
      kept="${kept:+$kept, }logs, diagnostics"
    fi
    echo "제거를 마쳤습니다."
    echo "지움: $removed"
    echo "남김: ${kept:-없음}"
    if [ "$STDIN_TTY" = 0 ] && [ "$UYES" = 0 ] && [ "$EOF_NO" = 1 ]; then
      # FB-1: ps1과 글자까지 같은 문구(설치 쪽은 "설치하려면", 여기는 "제거하려면").
      # 입력이 끊겨 아니오가 됐을 때(EOF_NO=1)만 세운다(B65).
      echo "입력을 받을 수 없어 '아니오'로 처리했습니다. 제거하려면 --yes를 붙여 다시 실행하세요."
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
      # 토큰 주소(/?k=…)로 연다 — 서버가 쿠키로 바꾸고 /로 돌려보낸다(Phase 2 스펙 7.1). 서버가 방금 토큰을
      # 만들었을 수 있어 1초 뒤에 읽는다(B33). 토큰 주소는 평소에는 출력하지 않고, 브라우저 열기 명령이
      # 없거나 실패했을 때만 붙여 넣을 수 있게 터미널에 쓴다(Ruling B45, ps1과 같은 문구). 로그에는 쓰지 않는다
      (
        sleep 1
        url="http://127.0.0.1:$port/"
        if [ -s "$PREFIX/token" ]; then url="${url}?k=$(tr -d ' \n\r' < "$PREFIX/token")"; fi
        open_url "$url" || {
          echo "브라우저를 열지 못했습니다. 이 주소를 브라우저에 붙여 넣어 주세요: $url"
          echo "이 주소는 열쇠입니다. 남에게 보내지 마세요."
        }
      ) &
    fi
    # SPEC 3장 명령 표: ps1과 글자까지 같은 안내(B17).
    echo "이 창을 닫으면 대시보드가 꺼집니다."
    exec node "$PREFIX/app/server.mjs" "$@"
    ;;
esac
