"use strict";
// 설치 스크립트(install.sh·install.ps1)가 플러그인 등록 전에 부른다(Phase 6a §2): node fill-hooks.cjs <hooks.json> <hook.key> [node 경로]
// $PREFIX/plugin 사본의 hooks.json을 JSON으로 읽어 command의 __NODE__를 node 경로로, args의 __KEYFILE__을 열쇠 파일 경로로 바꾼다.
// node 경로는 설치 스크립트가 PATH에서 찾은 글자 그대로(링크를 풀지 않는다 — process.execPath는 Homebrew Cellar 버전 폴더처럼
// 업그레이드 뒤 사라지는 실제 경로라서, review M2·B304). 절대 경로·일반 파일·실행 가능이 아니면 process.execPath
// (글자 치환이 아니라 JSON 값 — 경로에 따옴표·역슬래시가 있어도 안전). 자리 표시자가 남거나 무엇이든 실패하면 exit 1
const fs = require("node:fs");
const path = require("node:path");
const [file, key, given] = process.argv.slice(2);
function usable(p) {
  try {
    if (!p || !path.isAbsolute(p) || !fs.statSync(p).isFile()) return false; // statSync는 링크를 따라간다
    if (process.platform !== "win32") fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
const node = usable(given) ? given : process.execPath;
try {
  if (!file || !key) throw new Error("args");
  const f = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const groups of Object.values(f.hooks))
    for (const g of groups)
      for (const h of g.hooks) {
        if (h.command === "__NODE__") h.command = node;
        h.args = (h.args || []).map((a) => (a === "__KEYFILE__" ? key : a));
      }
  const out = JSON.stringify(f, null, 2) + "\n";
  if (/__NODE__|__KEYFILE__/.test(out)) throw new Error("left");
  fs.writeFileSync(file, out);
} catch {
  process.exit(1);
}
