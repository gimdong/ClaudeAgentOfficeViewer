#!/usr/bin/env node
// 베타 릴리스 패키징: 웹·서버를 빌드하고 release/claude-office-<version>/ 폴더와
// .tar.gz(mac/Linux)·.zip(Windows)을 만든다. 자세한 내용은 task-6-brief.md 참고.
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  const versions = { "package.json": v, "plugin.json": pluginJson.version, "marketplace.json": marketplaceEntry?.version };
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
  function copyIfExists(srcRel, destRel, mode) {
    const src = r(srcRel);
    if (!existsSync(src)) {
      console.warn(`[package-beta] 없음, 건너뜀: ${srcRel}`);
      return;
    }
    const dest = join(releaseDir, destRel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest);
    if (mode !== undefined) chmodSync(dest, mode);
  }
  copyIfExists("packaging/install.sh", "install.sh", 0o755);
  copyIfExists("packaging/install.ps1", "install.ps1");
  copyIfExists("packaging/claude-office.sh", "claude-office.sh", 0o755);
  copyIfExists("packaging/claude-office.cmd", "claude-office.cmd");
  copyIfExists("packaging/claude-office.ps1", "claude-office.ps1");
  copyIfExists("docs/manual/index.html", "사용설명서.html");
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
      execFileSync("zip", ["-qr", zipPath, `claude-office-${v}`], { cwd: zipStage });
      return zipPath;
    } catch (e) {
      console.error(`[package-beta] zip 명령이 필요합니다(macOS·Linux 기본 제공): ${e.message}`);
      process.exitCode = 1;
      return undefined;
    } finally {
      rmSync(zipStage, { recursive: true, force: true });
    }
  }

  const zipPath = buildZip();
  console.log(`[package-beta] 완료: ${releaseDir}, ${tarPath}${zipPath ? `, ${zipPath}` : " (zip 실패, 위 오류 참고)"}`);
}

// 이 파일을 `node scripts/package-beta.mjs`로 직접 실행할 때만 파이프라인을 돌린다 — 다른 모듈이
// pkgChain/resolveDepPath만 가져다 쓰려고 import할 때 빌드 전체가 부작용으로 실행되면 안 된다.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
