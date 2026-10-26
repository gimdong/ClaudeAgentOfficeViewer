// office 테마 자산을 만든다(Phase 7 Task 2): 장면 시트·토큰(make-scene), 캐릭터 층 시트·오라(make-sheet), 바깥 시트·엑스트라(make-exterior).
// 사용: node scripts/theme-assets/build-office.mjs [출력 폴더 = web/themes/office]. Node 표준만 쓰고 같은 입력이면 같은 바이트다(빌드 검사가 대조).
// 생성기 원본은 디자이너 브랜치(office 9303253, motion 662e356, themes f816e19)에서 옮겼다. theme.json·LICENSE.md는 손으로 쓴 파일이라 만들지 않는다
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] ?? join(here, "../../web/themes/office"));
mkdirSync(out, { recursive: true });
const run = (script, ...args) => execFileSync(process.execPath, [join(here, script), ...args], { stdio: ["ignore", "ignore", "inherit"] });
run("make-scene.mjs", out);
run("make-sheet.mjs", out);
// 바깥 엑스트라는 방금 만든 캐릭터 층 시트를 쓴다(git 브랜치에서 읽지 않게 --layers를 늘 준다)
run("make-exterior.mjs", "--layers", join(out, "layers"), "--out", out);
