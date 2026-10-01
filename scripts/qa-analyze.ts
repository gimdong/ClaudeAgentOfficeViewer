// 고객 진단 파일을 읽어 QA 분석용 Markdown을 출력한다(저장소 전용, 패키지에 넣지 않는다).
// 사용: npm run qa:analyze -- beta-feedback/claude-office-diag-….json
// 진단 파일은 이미 가려져 있다. 여기서는 그 문자열을 그대로 옮기기만 하고 새 정보를 더하지 않는다.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DiagBundle } from "../server/diag/bundle";
import type { DoctorItem } from "../server/diag/doctor";

interface LogLine { t?: string; level?: string; src?: string; msg?: string; data?: { suppressed?: unknown } }
interface Group { src: string; msg: string; count: number; first: string; last: string }

const cell = (s: unknown) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const INSTALL_LINE = /^(\S+) (\S+) (ok|fail|skip) ?(.*)$/; // Ruling B10: <ISO시각> <단계> ok|fail|skip <메시지>
const MARK: Record<string, string> = { fail: "❌", warn: "⚠️" };

/** 한 level의 로그 줄을 src+msg로 묶는다. warn은 로거가 10분 억제한 건수(data.suppressed)를 더해 센다 */
function groupsOf(b: DiagBundle, level: "error" | "warn"): Group[] {
  const groups = new Map<string, Group>();
  for (const { lines } of b.logs) {
    for (const raw of lines) {
      let l: LogLine;
      try {
        l = JSON.parse(raw);
      } catch {
        continue; // 설치 로그(평문)와 깨진 줄
      }
      if (l?.level !== level) continue;
      const key = `${l.src}\u0000${l.msg}`;
      const t = l.t ?? "";
      const n = 1 + (typeof l.data?.suppressed === "number" ? l.data.suppressed : 0);
      const g = groups.get(key);
      if (g) {
        g.count += n;
        if (t < g.first) g.first = t;
        if (t > g.last) g.last = t;
      } else groups.set(key, { src: String(l.src), msg: String(l.msg), count: n, first: t, last: t });
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

  const table = (gs: Group[]) => [
    "| src | msg | 횟수 | 처음 | 마지막 |",
    "|---|---|---|---|---|",
    ...gs.map((g) => `| ${cell(g.src)} | ${cell(g.msg)} | ${g.count} | ${g.first} | ${g.last} |`),
    "",
  ];
  const groups = groupsOf(b, "error");
  out.push("## 오류 묶음", "");
  if (!groups.length) out.push("error 없음", "");
  else out.push(...table(groups));

  // 수집 실패는 모두 warn이라 error 표가 비어도 원인은 여기 있을 수 있다
  const warns = groupsOf(b, "warn");
  out.push("## 경고 묶음", "");
  if (!warns.length) out.push("warn 없음", "");
  else out.push(...(warns.length > 10 ? [`상위 10개(전체 ${warns.length}개). 횟수는 10분 억제분(suppressed)을 더한 값`, ""] : ["횟수는 10분 억제분(suppressed)을 더한 값", ""]), ...table(warns.slice(0, 10)));

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

  // Phase 2 결정 통계. 이전 버전 진단 파일에는 이 필드가 없다
  const dec = (b as Partial<DiagBundle>).decisions;
  out.push("## 결정", "");
  if (!dec) out.push("결정 통계 없음(이전 버전 진단 파일)", "");
  else {
    const total = Object.values(dec.byKind).reduce((a, n) => a + n, 0);
    const rows = (o: Record<string, number>) => Object.entries(o).map(([k, n]) => `| ${cell(k)} | ${n} |`);
    out.push(`- 합계 ${total}건`, "", "| 종류 | 건수 |", "|---|---|", ...rows(dec.byKind), "", "| 결과 | 건수 |", "|---|---|", ...rows(dec.byState), "");
  }

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
  const topWarn = warns[0];
  const evidence = [
    top
      ? `오류 묶음 1위 "${top.src} ${top.msg}" ${top.count}회(${top.first} ~ ${top.last})`
      : topWarn
        ? `error 없음, 경고 묶음 1위 "${topWarn.src} ${topWarn.msg}" ${topWarn.count}회(${topWarn.first} ~ ${topWarn.last})`
        : "error·warn 없음",
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
  // 필드가 빠졌거나 다른 형식이면 스택 대신 한 줄로 알린다
  let md: string;
  try {
    if (b.format !== 1) throw new Error("format");
    md = analyze(b);
  } catch {
    console.error(`진단 파일 형식이 다릅니다(format ${String((b as { format?: unknown }).format)})`);
    return 2;
  }
  process.stdout.write(md);
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
