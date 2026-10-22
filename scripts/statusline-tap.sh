#!/bin/sh
# Claude Code statusline 입력(JSON)을 claude-office/limits.json에 복사하고, 원래 statusline 명령을 그대로 실행한다.
# limits.json은 이 사용자만 읽게(B328 Important-10)
umask 077
dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/claude-office"
mkdir -p "$dir"
input=$(cat)
tmp="$dir/limits.json.$$"
printf '%s' "$input" > "$tmp" && mv "$tmp" "$dir/limits.json"
orig="$dir/original-statusline.sh"
if [ -x "$orig" ]; then
  printf '%s' "$input" | "$orig"
fi
