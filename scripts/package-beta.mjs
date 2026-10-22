#!/usr/bin/env node
// 베타 릴리스 패키징: 웹·서버를 빌드하고 release/claude-office-<version>/ 폴더와
// .tar.gz(mac/Linux)·.zip(Windows)을 만든다. 자세한 내용은 task-6-brief.md 참고.
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const r = (...p) => join(root, ...p);
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

/**
 * lockfile 키(예: "node_modules/body-parser/node_modules/content-type")를 "node_modules/"
 * 경계마다 잘라 패키지 이름 목록으로 바꾼다. "/"마다 자르면 스코프 패키지(@scope/pkg)가 세그먼트
 * 2개라 경계가 어긋나므로, "node_modules/"라는 고정 구분자로만 자른다 — 그러면 "@scope/pkg"도
 * 원자 값 하나로 남는다. (다른 파일에서 단위 테스트로 직접 불러 쓸 수 있게 독립 함수로 뺐다 —
 * 아래 main()과 달리 부작용이 없다.)
 */
export function pkgChain(fromPath) {
  return fromPath
    .split("node_modules/")
    .filter(Boolean)
    .map((s) => s.replace(/\/$/, ""));
}

// Node의 node_modules 해석 순서(가까운 node_modules부터 위로)와 같은 방식으로, pkgChain으로 얻은
// 계층을 따라 depName이 실제로 설치된 lockfile 키를 찾는다. 없으면 undefined(호출부가 오류로 처리).
export function resolveDepPath(pkgs, fromPath, depName) {
  const chain = pkgChain(fromPath);
  for (let i = chain.length; i >= 0; i--) {
    // 루트(i===0)에서는 앞에 붙일 게 없으니 "node_modules/<dep>" 그대로 — prefix에 또 "node_modules"를
    // 끼워 넣으면 "node_modules/node_modules/<dep>"라는 존재하지 않는 경로가 된다.
    const prefix = chain
      .slice(0, i)
      .map((name) => `node_modules/${name}`)
      .join("/");
    const candidate = prefix ? `${prefix}/node_modules/${depName}` : `node_modules/${depName}`;
    if (pkgs[candidate]) return candidate;
  }
  return undefined;
}

function main() {
  const pkg = readJson(r("package.json"));
  const v = pkg.version;
  if (!v) {
    console.error("[package-beta] package.json에 version이 없습니다");
    process.exit(1);
  }

  // 1. 버전 네 곳 중 (VERSION 파일 제외) 세 곳이 일치하는지 먼저 확인한다 — VERSION은 v로 새로 쓰므로 항상 맞는다.
  const pluginJson = readJson(r("plugins/claude-office/.claude-plugin/plugin.json"));
  const marketplace = readJson(r(".claude-plugin/marketplace.json"));
  const marketplaceEntry = marketplace.plugins?.find((p) => p.name === "claude-office");
  // relay가 hook 요청 평문에 싣는 플러그인 버전(Phase 6a §2 — hooks.json 헤더를 대신함)도 같아야 한다
  const relayPath = r("plugins/claude-office/hooks/relay.cjs");
  const relayVersion = existsSync(relayPath) ? /const PLUGIN_VERSION = "([^"]+)";/.exec(readFileSync(relayPath, "utf8"))?.[1] : undefined;
  const versions = { "package.json": v, "plugin.json": pluginJson.version, "marketplace.json": marketplaceEntry?.version, "relay.cjs": relayVersion };
  const mismatched = Object.entries(versions).filter(([, val]) => val !== v);
  if (mismatched.length > 0) {
    console.error(`[package-beta] 버전 불일치: ${JSON.stringify(versions)}`);
    process.exit(1);
  }
  console.log(`[package-beta] version ${v}`);

  // 2. 빌드
  execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
  execFileSync("npx", ["vite", "build", "-c", "vite.server.config.ts"], { cwd: root, stdio: "inherit" });

  // 3. release 폴더를 비우고 다시 만든다
  const releaseDir = r("release", `claude-office-${v}`);
  rmSync(releaseDir, { recursive: true, force: true });
  mkdirSync(join(releaseDir, "app"), { recursive: true });
  cpSync(r("dist/server/server.mjs"), join(releaseDir, "app/server.mjs"));
  cpSync(r("dist/web"), join(releaseDir, "app/web"), { recursive: true });
  // statusline 연결 도우미(스펙 12장 j): install.sh·uninstall이 설치본 경로(app/)로 부르고, tap은 그 경로로 statusLine에 들어간다
  for (const f of ["statusline-setup.mjs", "statusline-tap.sh"]) cpSync(r("scripts", f), join(releaseDir, "app", f));

  // 4. 운영 의존성만 복사한다(Ruling B4는 `npm ls express --all --parseable`을 제안했지만, 이 npm
  // 버전(11.6.0)에서는 그 명령이 express 자신만 돌려주고 하위 의존 트리를 안 보여준다(직접 확인).
  // 대신 package-lock.json(변경 없음, 네트워크 불필요)의 packages 맵을 express부터 BFS로 훑어
  // pkgChain/resolveDepPath(위)로 각 의존성이 실제로 설치된 경로(중첩 node_modules·스코프 패키지
  // 포함, 버전 충돌로 hoist 안 된 경우 대응)를 찾는다.
  function collectRuntimeDepPaths() {
    const lock = readJson(r("package-lock.json"));
    const pkgs = lock.packages ?? {};
    const rootKey = "node_modules/express";
    if (!pkgs[rootKey]) throw new Error("package-lock.json에 node_modules/express가 없습니다");
    const visited = new Set();
    const queue = [rootKey];
    while (queue.length > 0) {
      const p = queue.shift();
      if (visited.has(p)) continue;
      visited.add(p);
      const entry = pkgs[p];
      if (!entry) continue;
      const deps = { ...(entry.dependencies ?? {}), ...(entry.optionalDependencies ?? {}) };
      for (const dep of Object.keys(deps)) {
        const resolved = resolveDepPath(pkgs, p, dep);
        if (!resolved) {
          console.error(`[package-beta] ${p}가 필요로 하는 ${dep}를 package-lock.json에서 못 찾았습니다. 패키지가 깨질 수 있어 중단합니다.`);
          process.exit(1);
        }
        queue.push(resolved);
      }
    }
    return [...visited];
  }

  for (const relPath of collectRuntimeDepPaths()) {
    cpSync(r(relPath), join(releaseDir, "app", relPath), { recursive: true });
  }

  // 일부 npm 패키지(예: path-to-regexp, content-type)가 자기 dist/에 소스맵을 그대로 실어 배포한다.
  // 서버 실행에는 필요 없고 tar.gz/zip에 .map이 있으면 안 된다는 요구사항과 어긋나므로 지운다.
  function pruneMaps(dir) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) pruneMaps(p);
      else if (name.endsWith(".map")) rmSync(p);
    }
  }
  pruneMaps(join(releaseDir, "app/node_modules"));

  // 5. app/package.json
  writeFileSync(
    join(releaseDir, "app/package.json"),
    JSON.stringify(
      { name: "claude-office-app", version: v, private: true, type: "module", engines: { node: ">=24" }, dependencies: { express: pkg.dependencies.express } },
      null,
      2,
    ) + "\n",
  );

  // 6. plugin/
  mkdirSync(join(releaseDir, "plugin/.claude-plugin"), { recursive: true });
  cpSync(r(".claude-plugin/marketplace.json"), join(releaseDir, "plugin/.claude-plugin/marketplace.json"));
  cpSync(r("plugins/claude-office"), join(releaseDir, "plugin/plugins/claude-office"), { recursive: true });

  // 7. 있으면 복사(Task 7·8·12가 나중에 채운다), 없으면 경고만
  function copyIfExists(srcRel, destRel, mode, transform) {
    const src = r(srcRel);
    if (!existsSync(src)) {
      console.warn(`[package-beta] 없음, 건너뜀: ${srcRel}`);
      return;
    }
    const dest = join(releaseDir, destRel);
    mkdirSync(dirname(dest), { recursive: true });
    if (transform) writeFileSync(dest, transform(readFileSync(src, "utf8")));
    else cpSync(src, dest);
    if (mode !== undefined) chmodSync(dest, mode);
  }
  copyIfExists("packaging/install.sh", "install.sh", 0o755);
  copyIfExists("packaging/install.ps1", "install.ps1");
  copyIfExists("packaging/fill-hooks.cjs", "fill-hooks.cjs"); // hooks.json 자리 표시자를 바꾸는 설치 도우미(Phase 6a §2)
  copyIfExists("packaging/claude-office.sh", "claude-office.sh", 0o755);
  copyIfExists("packaging/claude-office.cmd", "claude-office.cmd");
  copyIfExists("packaging/claude-office.ps1", "claude-office.ps1");
  // 설명서 두 개. 압축 안 이름이 저장소와 달라 서로를 가리키는 링크를 압축 이름으로 바꿔 쓴다(B245·B247). 저장소 파일은 그대로
  copyIfExists("docs/manual/index.html", "사용설명서.html", undefined, (t) => t.replaceAll('href="en.html"', 'href="manual-en.html"'));
  copyIfExists("docs/manual/en.html", "manual-en.html", undefined, (t) => t.replaceAll('href="index.html"', 'href="사용설명서.html"'));
  copyIfExists("LICENSE", "LICENSE");
  copyIfExists("THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md");
  writeFileSync(join(releaseDir, "VERSION"), v + "\n");

  // 8. tar.gz(줄바꿈 그대로 — .sh는 LF)
  const tarPath = r("release", `claude-office-${v}.tar.gz`);
  execFileSync("tar", ["-czf", tarPath, "-C", r("release"), `claude-office-${v}`]);

  // 9. zip(Windows용 — .ps1·.cmd만 CRLF로 바꾼 임시 복사본에서 압축한다. .tar.gz 쪽 원본은 안 건드린다)
  function toCRLF(dir) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        toCRLF(p);
      } else if (/\.(ps1|cmd)$/i.test(name)) {
        const text = readFileSync(p, "utf8").replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
        writeFileSync(p, text);
      }
    }
  }

  // process.exit()는 finally를 건너뛰어 .zip-stage-*가 그대로 남는다(리뷰 지적) — 실패해도
  // exitCode만 정하고 함수를 return해서, try/finally가 정상적인 JS 제어 흐름으로 정리하게 한다.
  function buildZip() {
    const zipStage = r("release", `.zip-stage-${v}`);
    rmSync(zipStage, { recursive: true, force: true });
    cpSync(releaseDir, join(zipStage, `claude-office-${v}`), { recursive: true });
    toCRLF(zipStage);
    const zipPath = r("release", `claude-office-${v}.zip`);
    rmSync(zipPath, { force: true });
    try {
      // FB-3(사용자 피드백, 2026-10-01): macOS 기본 `zip -qr`은 파일 이름에 UTF-8 플래그(EFS,
      // bit 11 = 0x800)를 켜지 않는다 — 실측으로 모든 항목의 flag_bits가 0x0이었다. 플래그가
      // 없으면 한국어 Windows의 탐색기나 PowerShell 5.1의 Expand-Archive가 "사용설명서.html"
      // 같은 비-ASCII 이름을 시스템 코드페이지(CP949)로 잘못 해석해 이름이 깨질 수 있다(사용자의
      // 실제 Windows 설치에서는 안 깨졌지만, beta.2에서 예방 차원으로 고친다). 파이썬 zipfile
      // 모듈은 비-ASCII 이름에 이 플래그를 자동으로 켠다(직접 확인). python3는 macOS 기본
      // 제공이라 새 의존성이 아니다.
      execFileSync("python3", ["-m", "zipfile", "-c", zipPath, `claude-office-${v}`], { cwd: zipStage });
      return zipPath;
    } catch (e) {
      // 전에는 여기서 exitCode만 1로 두고 tar.gz만으로 "완료"를 출력했다 — zip 없이도 조용히
      // 성공한 것처럼 보였다. FB-3: python3가 없으면 원인을 알리고 크게 실패시킨다(그대로 던져서
      // 전체 스크립트를 비정상 종료시킨다 — withLock의 "exit" 핸들러가 락은 정리한다).
      console.error(`[package-beta] zip 생성 실패 — python3가 필요합니다(macOS·Linux 기본 제공): ${e.message}`);
      throw e;
    } finally {
      rmSync(zipStage, { recursive: true, force: true });
    }
  }

  const zipPath = buildZip();
  console.log(`[package-beta] 완료: ${releaseDir}, ${tarPath}${zipPath ? `, ${zipPath}` : " (zip 실패, 위 오류 참고)"}`);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 여러 테스트 파일(test/scripts/package.test.ts, test/scripts/install.test.ts)이 각자
 * beforeAll에서 `npm run package:beta`를 부르는데, vitest는 테스트 파일을 별도 프로세스로 병렬
 * 실행한다 — 그대로 두면 같은 release/ 폴더를 향해 두 build가 동시에 rm -rf/쓰기를 해 깨진 산출물이
 * 생길 수 있다(Task 7에서 실제로 재현·확인). mkdir은 POSIX에서 원자적이라 이 락으로 직렬화한다.
 * 락을 기다렸다 얻은 두 번째 실행도 다시 한 번 전체를 빌드한다(몇 초 낭비되지만 항상 최신 상태를
 * 보장하는 쪽이 "이미 최신이면 건너뛰기" 같은 캐시 로직보다 단순하고 안전하다).
 *
 * main() 안에는 process.exit(1)을 직접 부르는 곳이 세 군데 있다(version 없음, 버전 불일치, 의존성
 * 해석 실패) — try/finally로 감싸면 process.exit()가 finally를 건너뛰어 락이 남는다(T6 재리뷰
 * 지적). 대신 락을 얻은 직후 "exit" 이벤트에 정리를 건다 — 이 이벤트는 process.exit() 호출이든
 * 이벤트 루프가 자연히 다 돌아 끝나는 정상 종료든 모든 경로에서 반드시 한 번 불린다. SIGINT·SIGTERM은
 * 기본 동작이 바로 죽는 것이라 "exit" 이벤트가 안 거쳐질 수 있어, 둘 다 process.exit()로 바꿔서
 * 같은 정리 경로를 타게 한다(server/index.ts의 종료 처리와 같은 방식).
 */
function withLock(fn) {
  mkdirSync(r("release"), { recursive: true }); // release/ 자체는 여러 프로세스가 같이 만들어도 안전(멱등)하다
  const lockDir = r("release", ".package-beta.lock");
  // execFileSync(npm run build 등)의 timeout(110초)보다 먼저 이 오류가 나와야 "그 쪽이 멈췄다"는
  // 진짜 원인이 "너무 오래 걸림"이라는 틀린 안내에 가려지지 않는다.
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      // recursive를 안 쓴다 — recursive: true는 이미 있어도 조용히 성공해 락 구실을 못 한다.
      // mkdir 자체는 POSIX에서 원자적이라, 두 프로세스가 동시에 시도해도 정확히 하나만 성공한다.
      mkdirSync(lockDir);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (Date.now() > deadline) {
        throw new Error(
          `[package-beta] 락을 얻지 못했습니다(다른 package:beta 실행이 너무 오래 걸림). ` +
            `다른 실행이 없는데도 이 오류가 나면 ${lockDir} 폴더를 지우고 다시 실행해 주세요.`,
        );
      }
      sleepSync(300);
    }
  }
  process.on("exit", () => rmSync(lockDir, { recursive: true, force: true }));
  process.on("SIGINT", () => process.exit(130));
  process.on("SIGTERM", () => process.exit(143));
  return fn();
}

// 이 파일을 `node scripts/package-beta.mjs`로 직접 실행할 때만 파이프라인을 돌린다 — 다른 모듈이
// pkgChain/resolveDepPath만 가져다 쓰려고 import할 때 빌드 전체가 부작용으로 실행되면 안 된다.
// server/index.ts의 isMainModule과 같은 이유로 realpath로 풀어서 비교한다 — 심볼릭 링크가 낀 경로
// (macOS /tmp·/var 아래 체크아웃 등)에서는 import.meta.url(실제 경로)과 process.argv[1](호출한
// 그대로의 링크 경로)이 문자열로는 달라서, 단순 비교면 이 가드가 항상 false가 되어 아무 일도 안
// 하고 조용히 끝나 버린다(T6 재리뷰 지적 — Important).
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}
if (isMainModule()) withLock(main);
