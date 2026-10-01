import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

// package.test.ts와 install.test.ts가 각자 beforeAll에서 npm run package:beta를 돌리면 둘이
// 동시에 release/ 폴더·tar.gz·zip을 지우고 다시 써서 간헐적으로 깨진다(원인 모르는 간헐 실패
// 금지 — B14, director #79). 여기서 전체 테스트 실행에 딱 한 번만 빌드하고, 두 테스트 파일은
// 그 결과물을 읽기만 한다(tar.gz를 읽는 동안 빌드가 다시 돌지 않으므로 레이스 자체가 없어진다).
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

declare module "vitest" {
  export interface ProvidedContext {
    // 빌드가 "이번 실행"에서 실제로 끝난 시각(ms). provide가 전혀 안 됐으면(inject가 undefined를
    // 반환하면) 이번 실행에서 빌드가 안 된 것 — release/에 예전 결과물이 남아 있어도 안 된다.
    packageBuiltAt: number;
  }
}

// 패키지 결과물이 필요 없는 실행(예: `npx vitest run test/server`)까지 매번 느린 빌드를 하지는
// 않는다. vitest globalSetup에는 "이번에 어떤 테스트가 걸렸는지"를 깔끔하게 물어볼 공식 API가
// 없어서, CLI에 넘긴 파일 필터(process.argv)를 직접 본다 — 필터가 하나도 없으면(=전체 실행)
// 항상 빌드하고, 있으면 그중 하나라도 scripts/install/package를 가리킬 때만 빌드한다.
//
// vitest CLI 서브커맨드("run" 등)는 파일 필터가 아니므로 셈에서 뺀다 — 이걸 안 뺐더니 "npm
// test"(= "vitest run", 필터 없이 전체 실행)의 argv가 ["run"]이 되어 filters.length가 0이
// 아니게 되고, "run"은 scripts/install/package 중 어느 것과도 안 겹쳐 전체 실행인데도 빌드를
// 건너뛰어 버렸다(리뷰어 실측 — #87, 직접 재현: 고치기 전 `npm test`가 package.test를 "이번
// 실행에서 빌드 안 됨"으로 실패시켰다).
//
// 이 휴리스틱이 그래도 틀리는 경우(예: 파일 경로 없이 -t만으로 거르는 경우)에 대비해
// CLAUDE_OFFICE_SKIP_PACKAGE_BUILD로 직접 켜고 끌 수 있게 둔다. 틀려서 빌드를 건너뛰어도, 아래
// provide를 안 하므로 package.test/install.test의 beforeAll이 "이번 실행에서 빌드 안 됨"을
// 감지해 실패로 알려준다(이게 #87의 핵심 — 예전엔 release/에 결과물이 있기만 하면 옛 빌드로
// 조용히 통과했다).
const VITEST_SUBCOMMANDS = new Set(["run", "watch", "dev", "related", "bench", "list", "init"]);

function needsBuild(): boolean {
  if (process.env.CLAUDE_OFFICE_SKIP_PACKAGE_BUILD === "1") return false;
  if (process.env.CLAUDE_OFFICE_FORCE_PACKAGE_BUILD === "1") return true;
  const filters = process.argv.slice(2).filter((a) => !a.startsWith("-") && !VITEST_SUBCOMMANDS.has(a));
  if (filters.length === 0) return true;
  return filters.some((f) => /scripts|install|package/i.test(f));
}

export default function setup(project: TestProject) {
  if (!needsBuild()) return;
  // 실패하면 그대로 던진다 — vitest가 전체 실행을 바로 실패 처리한다(director 지시).
  execFileSync("npm", ["run", "package:beta"], { cwd: ROOT, stdio: "pipe", timeout: 110_000 });
  project.provide("packageBuiltAt", Date.now());
}
