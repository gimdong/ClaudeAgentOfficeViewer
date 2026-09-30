import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// CLAUDE_CONFIG_DIR=""(unset이 아니라 빈 문자열)를 ??로 처리하면 대체되지 않아 claudeDir이
// ""가 되고, 그 아래 모든 경로(join("", ...))가 cwd 기준 상대경로가 되어버린다 — 의도치 않게
// 엉뚱한 곳의 settings.json을 건드릴 위험이 있다. ||를 쓰면 빈 문자열도 안전하게 기본값으로
// 대체된다.
const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const settingsPath = join(claudeDir, "settings.json");
const officeDir = join(claudeDir, "claude-office");
const backupPath = join(officeDir, "settings.backup.json");
const origPath = join(officeDir, "original-statusline.sh");
const tapPath = fileURLToPath(new URL("./statusline-tap.sh", import.meta.url));

async function readSettings() {
  try {
    return JSON.parse(await readFile(settingsPath, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw e;
  }
}

// ~/.claude/settings.json은 Claude Code가 수시로 읽고 쓰는 핵심 설정 파일이다. writeFile은
// truncate 후 쓰기라서 중간에 끊기면(Ctrl-C, 디스크 가득 참) 잘린 JSON이 남아 Claude Code
// 자체가 설정을 잃을 수 있다. 같은 폴더 안의 임시 파일에 먼저 쓰고 rename으로 바꿔치기하면
// (POSIX에서 원자적) 그런 중간 상태가 절대 보이지 않는다.
async function writeJson(path, data) {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n");
  await rename(tmp, path);
}

async function install() {
  const settings = await readSettings();
  if (settings.statusLine?.command?.includes("statusline-tap.sh")) {
    console.log("이미 설치되어 있습니다.");
    return;
  }
  await mkdir(officeDir, { recursive: true });
  if (!existsSync(backupPath)) await writeJson(backupPath, settings);
  const original = settings.statusLine?.type === "command" ? settings.statusLine.command : "";
  if (original === "") {
    console.warn("기존 statusline 명령이 없어 설치 후 상태줄이 비어 보일 수 있습니다. 되돌리기: npm run remove:statusline");
  }
  await writeFile(origPath, `#!/bin/sh\n${original}\n`);
  await chmod(origPath, 0o755);
  settings.statusLine = { ...(settings.statusLine ?? {}), type: "command", command: `sh '${tapPath}'` };
  await writeJson(settingsPath, settings);
  console.log(`statusline tap을 설치했습니다. 백업: ${backupPath}`);
}

async function remove() {
  if (!existsSync(backupPath)) {
    console.error(`백업(${backupPath})이 없어 되돌릴 수 없습니다.`);
    process.exit(1);
  }
  const backup = JSON.parse(await readFile(backupPath, "utf8"));
  const settings = await readSettings();
  if (backup.statusLine) settings.statusLine = backup.statusLine;
  else delete settings.statusLine;
  await writeJson(settingsPath, settings);
  // 백업을 지우지 않고 타임스탬프를 붙여 남긴다. 그냥 지우면 다음에 install할 때는 문제없지만,
  // 지우지 않고 그대로 두면(옛 구현) install()의 "!existsSync(backupPath)"가 계속 false가 되어
  // remove 이후 사용자가 statusLine을 바꿔도 다음 install/remove가 이 옛 백업으로 되돌려버린다.
  // 원래 이름의 백업 파일은 이제 없어야 다음 install이 "현재" 값을 새로 백업한다.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await rename(backupPath, join(officeDir, `settings.backup.${stamp}.json`));
  console.log("statusline 설정을 원래대로 되돌렸습니다.");
}

// 테스트용으로 STATUSLINE_PLATFORM을 두되 기본은 실제 process.platform이다(Task 3).
if ((process.env.STATUSLINE_PLATFORM || process.platform) === "win32") {
  console.log("PLAN 바(statusline 연동)는 Windows에서는 아직 지원하지 않습니다.");
  process.exit(0);
}

const cmd = process.argv[2];
if (cmd === "install") await install();
else if (cmd === "remove") await remove();
else {
  console.error("사용법: node scripts/statusline-setup.mjs install|remove");
  process.exit(1);
}
