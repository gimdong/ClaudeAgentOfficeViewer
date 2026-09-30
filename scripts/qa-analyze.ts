// 고객 진단 파일을 읽어 QA 분석용 Markdown을 출력한다(저장소 전용, 패키지에 넣지 않는다).
// 사용: npm run qa:analyze -- beta-feedback/claude-office-diag-….json
// 진단 파일은 이미 가려져 있다. 여기서는 그 문자열을 그대로 옮기기만 하고 새 정보를 더하지 않는다.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DiagBundle } from "../server/diag/bundle";
import type { DoctorItem } from "../server/diag/doctor";

interface LogLine { t?: string; level?: string; src?: string; msg?: string }
interface ErrorGroup { src: string; msg: string; count: number; first: string; last: string }

const cell = (s: unknown) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const INSTALL_LINE = /^(\S+) (\S+) (ok|fail|skip) ?(.*)$/; // Ruling B10: <ISO시각> <단계> ok|fail|skip <메시지>
const MARK: Record<string, string> = { fail: "❌", warn: "⚠️" };

function errorGroups(b: DiagBundle): ErrorGroup[] {
  const groups = new Map<string, ErrorGroup>();
  for (const { lines } of b.logs) {
    for (const raw of lines) {
      let l: LogLine;
      try {
        l = JSON.parse(raw);
      } catch {
        continue; // 설치 로그(평문)와 깨진 줄
      }
      if (l?.level !== "error") continue;
      const key = `${l.src}\u0000${l.msg}`;
      const t = l.t ?? "";
      const g = groups.get(key);
      if (g) {
        g.count++;
        if (t < g.first) g.first = t;
        if (t > g.last) g.last = t;
      } else groups.set(key, { src: String(l.src), msg: String(l.msg), count: 1, first: t, last: t });
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.first.localeCompare(b.first));
}

function installFailures(b: DiagBundle): Array<{ file: string; t: string; step: string; msg: string }> {
  return b.logs
    .filter((l) => l.file.startsWith("install-"))
    .flatMap(({ file, lines }) =>
      lines.flatMap((raw) => {
        const m = INSTALL_LINE.exec(raw);
        return m && m[3] === "fail" ? [{ file, t: m[1], step: m[2], msg: m[4] }] : [];
      }),
    );
}

const problems = (b: DiagBundle): DoctorItem[] =>
  [...b.doctor.filter((i) => i.status === "fail"), ...b.doctor.filter((i) => i.status === "warn")];

export function analyze(b: DiagBundle): string {
  const v = b.versions;
  const out: string[] = [];
  const env = `앱 ${v.app}, Node ${v.node}, ${v.platform}/${v.arch}, Claude Code ${v.claude ?? "알 수 없음"}`;

  out.push("# 진단 파일 분석", "", `- 만든 시각: ${b.createdAt}`, ...(b.truncated ? ["- ⚠️ 크기 상한으로 오래된 로그 일부가 빠졌습니다"] : []), "");

  out.push("## 환경", "", `- 앱: ${v.app}`, `- Node: ${v.node}`, `- OS: ${v.platform} / ${v.arch}`, `- Claude Code: ${v.claude ?? "알 수 없음"}`);
  const s = b.snapshot;
  out.push(`- 화면: 세션 ${s.sessions}개, 팀원 ${s.members}명, 팀 ${s.teams}개, 결정 대기 ${s.decisions}건, 스냅샷 오류 ${s.error ? "있음" : "없음"}`, "");

  const probs = problems(b);
  out.push("## 점검(fail·warn)", "");
  if (!probs.length) out.push("fail·warn 없음", "");
  else out.push(...probs.map((i) => `- ${MARK[i.status]} **${i.title}** (${i.id}): ${i.detail}${i.fix ? `\n  - 고치는 법: ${i.fix}` : ""}`), "");

  const groups = errorGroups(b);
  out.push("## 오류 묶음", "");
  if (!groups.length) out.push("error 없음", "");
  else {
    out.push("| src | msg | 횟수 | 처음 | 마지막 |", "|---|---|---|---|---|");
    out.push(...groups.map((g) => `| ${cell(g.src)} | ${cell(g.msg)} | ${g.count} | ${g.first} | ${g.last} |`), "");
  }

  const installs = installFailures(b);
  out.push("## 설치 실패", "");
  if (!installs.length) out.push("설치 로그에 fail 없음", "");
  else out.push(...installs.map((f) => `- ${f.t} \`${cell(f.step)}\`: ${f.msg} (${f.file})`), "");

  const h = b.hooks;
  const rejected = Object.values(h.rejected).reduce((a, n) => a + n, 0);
  out.push("## hook 통계", "", `- 수신 합계 ${h.total}건, 최근 10분 ${h.last10min}건, 마지막 수신 ${h.lastAt ?? "없음"}`);
  out.push(`- 거부 ${rejected}건 (${Object.entries(h.rejected).map(([k, n]) => `${k}: ${n}`).join(", ")})`, "");
  const events = Object.entries(h.byEvent).sort((a, b) => b[1] - a[1]);
  if (events.length) out.push("| 이벤트 | 건수 |", "|---|---|", ...events.map(([k, n]) => `| ${cell(k)} | ${n} |`), "");

  // 초안: 사람이 다듬어 director에게 보낸다. 형식은 팀 규칙 [QA 인폼] 증상 / 재현 조건 / 근거 / 추정 원인 / 제안
  const firstFail = b.doctor.find((i) => i.status === "fail");
  const top = groups[0];
  const symptom = firstFail
    ? `doctor fail ${b.doctor.filter((i) => i.status === "fail").length}개(${b.doctor.filter((i) => i.status === "fail").map((i) => i.title).join(", ")})`
    : top
      ? `error 로그 "${top.src} ${top.msg}" ${top.count}회`
      : installs.length
        ? `설치 단계 실패 ${installs.length}건(${installs.map((f) => f.step).join(", ")})`
        : probs.length
          ? `doctor warn ${probs.length}개(${probs.map((i) => i.title).join(", ")})`
          : "특이 사항 없음";
  const evidence = [
    top ? `오류 묶음 1위 "${top.src} ${top.msg}" ${top.count}회(${top.first} ~ ${top.last})` : "error 없음",
    installs.length ? `설치 실패 ${installs.map((f) => f.step).join(", ")}` : null,
    `hook 수신 ${h.total}건, 거부 ${rejected}건`,
  ].filter(Boolean).join("; ");
  const cause = firstFail ? `${firstFail.title}: ${firstFail.detail}` : (probs[0] ? `${probs[0].title}: ${probs[0].detail}` : "확인 필요");
  const fix = firstFail?.fix || probs[0]?.fix || "추가 정보 요청(재현 순서, 화면 캡처)";
  out.push("## [QA 인폼] 초안", "", `- 증상: ${symptom}`, `- 재현 조건: ${env}`, `- 근거: ${evidence}`, `- 추정 원인: ${cause}`, `- 제안: ${fix}`, "");
  return out.join("\n");
}

function main(argv: string[]): number {
  const file = argv[0];
  if (!file) {
    console.error("사용: npm run qa:analyze -- <진단 파일.json>");
    return 2;
  }
  let b: DiagBundle;
  try {
    b = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`진단 파일을 읽지 못했습니다: ${(e as Error).message}`);
    return 2;
  }
  if (b?.kind !== "claude-office-diag") {
    console.error("진단 파일이 아닙니다(kind가 claude-office-diag가 아님).");
    return 2;
  }
  process.stdout.write(analyze(b));
  return 0;
}

const isMain = (() => {
  try {
    return !!process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isMain) process.exitCode = main(process.argv.slice(2));
