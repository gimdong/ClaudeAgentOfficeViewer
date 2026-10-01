import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// package.test.ts와 install.test.ts가 각자 beforeAll에서 npm run package:beta를 돌리면 둘이
// 동시에 release/ 폴더·tar.gz·zip을 지우고 다시 써서 간헐적으로 깨진다(원인 모르는 간헐 실패
// 금지 — B14, director #79). 여기서 전체 테스트 실행에 딱 한 번만 빌드하고, 두 테스트 파일은
// 그 결과물을 읽기만 한다(tar.gz를 읽는 동안 빌드가 다시 돌지 않으므로 레이스 자체가 없어진다).
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

// 패키지 결과물이 필요 없는 실행(예: `npx vitest run test/server`)까지 매번 느린 빌드를 하지는
// 않는다. vitest globalSetup에는 "이번에 어떤 테스트가 걸렸는지"를 깔끔하게 물어볼 공식 API가
// 없어서, CLI에 넘긴 파일 필터(process.argv)를 직접 본다 — 필터가 하나도 없으면(=전체 실행)
// 항상 빌드하고, 있으면 그중 하나라도 scripts/install/package를 가리킬 때만 빌드한다. 이 추정이
// 틀리는 드문 경우(예: 파일 경로 없이 -t만으로 거르는 경우)에 대비해 CLAUDE_OFFICE_SKIP_PACKAGE_BUILD로
// 직접 켜고 끌 수 있게 둔다.
function needsBuild(): boolean {
  if (process.env.CLAUDE_OFFICE_SKIP_PACKAGE_BUILD === "1") return false;
  if (process.env.CLAUDE_OFFICE_FORCE_PACKAGE_BUILD === "1") return true;
  const filters = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  if (filters.length === 0) return true;
  return filters.some((f) => /scripts|install|package/i.test(f));
}

export default function setup() {
  if (!needsBuild()) return;
  // 실패하면 그대로 던진다 — vitest가 전체 실행을 바로 실패 처리한다(director 지시).
  execFileSync("npm", ["run", "package:beta"], { cwd: ROOT, stdio: "pipe", timeout: 110_000 });
}
