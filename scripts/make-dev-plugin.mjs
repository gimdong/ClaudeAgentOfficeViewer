#!/usr/bin/env node
// 개발용 플러그인 복사본을 만든다. hooks.json의 자리 표시자를 이 컴퓨터의 node·열쇠 파일로 바꾸고, relay가 보낼 포트를 덧붙인다(Phase 6a §2).
// 사용자 대시보드(4317)와 섞이지 않게, 개발 서버(예: 4318)로 보내는 복사본을 실험 세션에 --plugin-dir로 로드한다.
// 열쇠는 개발 서버가 만드는 .logs/hook.key가 기본(--key로 바꿈)
import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { port: { type: "string" }, out: { type: "string" }, key: { type: "string" } } });
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535 || !values.out) {
  console.error("사용법: node scripts/make-dev-plugin.mjs --port <1-65535> --out <폴더> [--key <hook.key>]");
  process.exit(1);
}

const src = fileURLToPath(new URL("../plugins/claude-office", import.meta.url));
const key = values.key ?? fileURLToPath(new URL("../.logs/hook.key", import.meta.url));
await cp(src, values.out, { recursive: true });
const hooksPath = join(values.out, "hooks", "hooks.json");
const f = JSON.parse(await readFile(hooksPath, "utf8"));
for (const groups of Object.values(f.hooks))
  for (const g of groups)
    for (const h of g.hooks) {
      h.command = process.execPath;
      h.args = [...h.args.map((a) => (a === "__KEYFILE__" ? key : a)), String(port)];
    }
await writeFile(hooksPath, JSON.stringify(f, null, 2) + "\n");
console.log(`개발용 플러그인: ${values.out} (포트 ${port})`);
