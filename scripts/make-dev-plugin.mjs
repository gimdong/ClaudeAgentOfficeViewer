#!/usr/bin/env node
// 개발용 플러그인 복사본을 만든다. hooks.json의 URL 포트만 바꾼다.
// 사용자는 4317에서 v1 뷰어를 보고 있으므로, 개발 서버(4318)로 보내는 복사본을 실험 세션에 --plugin-dir로 로드한다.
import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { port: { type: "string" }, out: { type: "string" } } });
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535 || !values.out) {
  console.error("사용법: node scripts/make-dev-plugin.mjs --port <1-65535> --out <폴더>");
  process.exit(1);
}

const src = fileURLToPath(new URL("../plugins/claude-office", import.meta.url));
await cp(src, values.out, { recursive: true });
const hooksPath = join(values.out, "hooks", "hooks.json");
const text = await readFile(hooksPath, "utf8");
await writeFile(hooksPath, text.replaceAll("http://127.0.0.1:4317/", `http://127.0.0.1:${port}/`));
console.log(`개발용 플러그인: ${values.out} (포트 ${port})`);
