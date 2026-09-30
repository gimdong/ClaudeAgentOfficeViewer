#!/usr/bin/env node
// 베타 릴리스 패키징: 웹·서버를 빌드하고 release/claude-office-<version>/ 폴더와
// .tar.gz(mac/Linux)·.zip(Windows)을 만든다. 자세한 내용은 task-6-brief.md 참고.
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const r = (...p) => join(root, ...p);
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

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
// Node의 node_modules 해석 순서(가까운 node_modules부터 위로)와 같은 방식으로 각 의존성이 실제로
// 설치된 경로(중첩 node_modules 포함, 버전 충돌로 hoist 안 된 경우 대응)를 찾는다.
function resolveDepPath(pkgs, fromPath, depName) {
  const segs = fromPath.split("/");
  for (let end = segs.length; end >= 0; end -= 2) {
    const prefix = segs.slice(0, end).join("/");
    const candidate = prefix ? `${prefix}/node_modules/${depName}` : `node_modules/${depName}`;
    if (pkgs[candidate]) return candidate;
  }
  return undefined;
}

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
      if (resolved) queue.push(resolved);
      else console.warn(`[package-beta] 경고: ${p}가 필요로 하는 ${dep}를 lockfile에서 못 찾음`);
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

const zipStage = r("release", `.zip-stage-${v}`);
rmSync(zipStage, { recursive: true, force: true });
cpSync(releaseDir, join(zipStage, `claude-office-${v}`), { recursive: true });
toCRLF(zipStage);
const zipPath = r("release", `claude-office-${v}.zip`);
rmSync(zipPath, { force: true });
try {
  execFileSync("zip", ["-qr", zipPath, `claude-office-${v}`], { cwd: zipStage });
} catch (e) {
  console.error(`[package-beta] zip 명령이 필요합니다(macOS·Linux 기본 제공): ${e.message}`);
  process.exit(1);
} finally {
  rmSync(zipStage, { recursive: true, force: true });
}

console.log(`[package-beta] 완료: ${releaseDir}, ${tarPath}, ${zipPath}`);
