import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
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

const writeJson = (path, data) => writeFile(path, JSON.stringify(data, null, 2) + "\n");

async function install() {
  const settings = await readSettings();
  if (settings.statusLine?.command?.includes("statusline-tap.sh")) {
    console.log("이미 설치되어 있습니다.");
    return;
  }
  await mkdir(officeDir, { recursive: true });
  if (!existsSync(backupPath)) await writeJson(backupPath, settings);
  const original = settings.statusLine?.type === "command" ? settings.statusLine.command : "";
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
  console.log("statusline 설정을 원래대로 되돌렸습니다.");
}

const cmd = process.argv[2];
if (cmd === "install") await install();
else if (cmd === "remove") await remove();
else {
  console.error("사용법: node scripts/statusline-setup.mjs install|remove");
  process.exit(1);
}
