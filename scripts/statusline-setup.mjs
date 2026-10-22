import { chmod, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// CLAUDE_CONFIG_DIR=""(unset이 아니라 빈 문자열)를 ??로 처리하면 대체되지 않아 claudeDir이
// ""가 되고, 그 아래 모든 경로(join("", ...))가 cwd 기준 상대경로가 되어버린다 — 의도치 않게
// 엉뚱한 곳의 settings.json을 건드릴 위험이 있다. ||를 쓰면 빈 문자열도 안전하게 기본값으로
// 대체된다.
const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const settingsLink = join(claudeDir, "settings.json");
const officeDir = join(claudeDir, "claude-office");
const backupPath = join(officeDir, "settings.backup.json");
const origPath = join(officeDir, "original-statusline.sh");
const tapPath = fileURLToPath(new URL("./statusline-tap.sh", import.meta.url));
// 설치본(install.sh가 부름)이면 설치본에 있는 명령만 안내한다(qa #627 D)
const installed = process.argv.includes("--installed");

// settings.json이 심볼릭 링크(dotfiles 관리)면 링크를 일반 파일로 바꾸지 않게 대상 파일에 쓴다(B328 Minor-11)
const settingsPath = existsSync(settingsLink) ? await realpath(settingsLink) : settingsLink;

async function readSettings() {
  try {
    return JSON.parse(await readFile(settingsPath, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw e;
  }
}

// sh '<경로>' — 경로의 작은따옴표는 '\''로(B326 ③)
const tapCommand = () => `sh '${tapPath.replaceAll("'", "'\\''")}'`;
// 이 설치본의 tap인지는 명령 전체로 본다 — 다른 PREFIX 설치본을 제거해도 이 연결을 되돌리지 않게(B333 m3)
const isOurs = (s) => s.statusLine?.command === tapCommand();
// 어느 설치본이든 우리 tap(다른 경로 포함): install은 이것을 "원래 명령"으로 백업하지 않고 경로만 바꾼다
const isAnyTap = (s) => typeof s.statusLine?.command === "string" && s.statusLine.command.includes("statusline-tap.sh");

// ~/.claude/settings.json은 Claude Code가 수시로 읽고 쓰는 핵심 설정 파일이다. writeFile은
// truncate 후 쓰기라서 중간에 끊기면(Ctrl-C, 디스크 가득 참) 잘린 JSON이 남아 Claude Code
// 자체가 설정을 잃을 수 있다. 같은 폴더 안의 임시 파일에 먼저 쓰고 rename으로 바꿔치기하면
// (POSIX에서 원자적) 그런 중간 상태가 절대 보이지 않는다.
// 설정에는 비밀값이 있을 수 있어 권한을 넓히지 않는다: 원래 파일의 mode를 그대로, 없으면 0600(B328 Important-9)
async function writeJson(path, data, mode) {
  const keep = mode ?? (await stat(path).then((s) => s.mode & 0o777, () => 0o600));
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", { mode: keep }); // umask는 좁히기만 한다
  await rename(tmp, path);
}

async function install() {
  const settings = await readSettings();
  if (isOurs(settings)) {
    console.log("이미 연결되어 있습니다.");
    return;
  }
  await mkdir(officeDir, { recursive: true, mode: 0o700 });
  if (!isAnyTap(settings)) {
    // 지금 값이 우리 tap이 아니면 그것이 되돌릴 값이다 — 남은 옛 백업이 있어도 새로 만든다(B328 Minor-10)
    await writeJson(backupPath, settings, 0o600);
    const original = settings.statusLine?.type === "command" ? settings.statusLine.command : "";
    if (original === "") {
      console.warn(`기존 statusline 명령이 없어 설치 후 상태줄이 비어 보일 수 있습니다. 되돌리기: ${installed ? "claude-office uninstall" : "npm run remove:statusline"}`);
    }
    await writeFile(origPath, `#!/bin/sh\n${original}\n`, { mode: 0o700 });
    await chmod(origPath, 0o700);
  }
  settings.statusLine = { ...(settings.statusLine ?? {}), type: "command", command: tapCommand() };
  await writeJson(settingsPath, settings);
  console.log(`statusline 연결을 켰습니다. 원래 설정 백업: ${backupPath}`);
}

async function remove() {
  const settings = await readSettings();
  const hadBackup = existsSync(backupPath);
  if (!isOurs(settings)) {
    // 설치 뒤 사용자가 바꾼 statusline은 그대로 둔다(B326 ①)
    if (hadBackup) console.log("다른 statusline으로 바뀌어 있어 그대로 둡니다.");
  } else {
    let line;
    if (hadBackup) line = JSON.parse(await readFile(backupPath, "utf8")).statusLine;
    else {
      // 백업이 없으면 original-statusline.sh의 명령으로, 그것도 비었으면 키를 지운다 — 없는 tap을 가리킨 채 두지 않는다(B326 ②)
      const cmd = existsSync(origPath) ? (await readFile(origPath, "utf8")).split("\n").slice(1).join("\n").trim() : "";
      line = cmd ? { type: "command", command: cmd } : undefined;
    }
    if (line) settings.statusLine = line;
    else delete settings.statusLine;
    await writeJson(settingsPath, settings);
    console.log("statusline 설정을 원래대로 되돌렸습니다.");
  }
  if (!hadBackup) return;
  // 백업을 지우지 않고 타임스탬프를 붙여 남긴다. 원래 이름의 백업 파일은 이제 없어야 다음 install이
  // "현재" 값을 새로 백업하고, status가 "other"(우리가 연결했던 흔적)로 보지 않는다.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await rename(backupPath, join(officeDir, `settings.backup.${stamp}.json`));
}

/** on: 우리 tap이 연결됨, other: 연결했었는데(백업 있음) 다른 statusline으로 바뀜, off: 그 밖 */
async function status() {
  const settings = await readSettings();
  console.log(isOurs(settings) ? "on" : existsSync(backupPath) ? "other" : "off");
}

// 테스트용으로 STATUSLINE_PLATFORM을 두되 기본은 실제 process.platform이다(Task 3).
if ((process.env.STATUSLINE_PLATFORM || process.platform) === "win32") {
  console.log("PLAN 바(statusline 연결)는 Windows에서 지원하지 않습니다.");
  process.exit(0);
}

const cmd = process.argv[2];
if (cmd === "install") await install();
else if (cmd === "remove") await remove();
else if (cmd === "status") await status();
else {
  console.error("사용법: node scripts/statusline-setup.mjs install|remove|status");
  process.exit(1);
}
