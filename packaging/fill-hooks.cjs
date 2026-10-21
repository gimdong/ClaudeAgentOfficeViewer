"use strict";
// 설치 스크립트(install.sh·install.ps1)가 플러그인 등록 전에 부른다(Phase 6a §2): node fill-hooks.cjs <hooks.json> <hook.key>
// $PREFIX/plugin 사본의 hooks.json을 JSON으로 읽어 command의 __NODE__를 이 node의 절대 경로로, args의 __KEYFILE__을 열쇠 파일 경로로 바꾼다
// (글자 치환이 아니라 JSON 값 — 경로에 따옴표·역슬래시가 있어도 안전). 자리 표시자가 남거나 무엇이든 실패하면 exit 1
const fs = require("node:fs");
const [file, key] = process.argv.slice(2);
try {
  if (!file || !key) throw new Error("args");
  const f = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const groups of Object.values(f.hooks))
    for (const g of groups)
      for (const h of g.hooks) {
        if (h.command === "__NODE__") h.command = process.execPath;
        h.args = (h.args || []).map((a) => (a === "__KEYFILE__" ? key : a));
      }
  const out = JSON.stringify(f, null, 2) + "\n";
  if (/__NODE__|__KEYFILE__/.test(out)) throw new Error("left");
  fs.writeFileSync(file, out);
} catch {
  process.exit(1);
}
