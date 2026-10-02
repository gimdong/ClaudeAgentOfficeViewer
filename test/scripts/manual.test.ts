import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

const html = readFileSync(join(__dirname, "../../docs/manual/index.html"), "utf8");
const { version } = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8")) as { version: string };

/** 인라인 그림 하나의 <text> 내용을 줄마다 모은다 */
function figureText(id: string): string {
  const start = html.indexOf(`<figure class="fig" data-fig="${id}">`);
  const fig = html.slice(start, html.indexOf("</figure>", start));
  return [...fig.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1].replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&")).join("\n");
}

describe("사용설명서(docs/manual/index.html)", () => {
  it("외부 요청이 없다(스크립트·스타일·그림·글꼴 모두 안에)", () => {
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=["']?https?:/i);
    expect(html).not.toMatch(/url\(\s*["']?https?:/i);
    expect(html).not.toMatch(/<(img|iframe|image|source|video|audio)[^>]+(src|href)=["']?https?:/i);
    expect(html).not.toMatch(/@import/i);
  });

  it("스펙 10장의 9개 절이 순서대로 있다", () => {
    const h2 = [...html.matchAll(/<h2 id="s(\d)">([^<]+)<\/h2>/g)].map((m) => m[2]);
    expect(h2).toEqual([
      "1. 이 프로그램이 하는 일",
      "2. 준비물",
      "3. 설치",
      "4. 켜기와 끄기",
      "5. 화면 보는 법",
      "6. 문제가 생겼을 때",
      "7. 지우기",
      "8. 부록 A: 회사 관리자에게 전달할 설정",
      "9. 부록 B: 베타에서 알려진 제한",
    ]);
  });

  it("OS 탭 3개(mac·Linux·Windows)가 설치 절에 있다", () => {
    const install = html.slice(html.indexOf('id="s3"'), html.indexOf('id="s4"'));
    expect([...install.matchAll(/class="os-panel" data-os="(\w+)"/g)].map((m) => m[1])).toEqual(["mac", "linux", "win"]);
    expect(html).toContain('["mac", "linux", "win"]');
  });

  it("명령 상자마다 복사 버튼이 있고 navigator.clipboard를 쓴다", () => {
    const cmds = html.match(/<div class="cmd">/g) ?? [];
    const buttons = html.match(/<button class="copy"/g) ?? [];
    expect(cmds.length).toBeGreaterThan(5);
    expect(buttons.length).toBe(cmds.length);
    expect(html).toContain("navigator.clipboard.writeText");
  });

  it("단계마다 '이렇게 보이면 성공' 상자가 있다(준비물·설치·켜기·진단·지우기)", () => {
    expect((html.match(/class="box ok-box"/g) ?? []).length).toBeGreaterThanOrEqual(6);
  });

  it("알려진 제한과 B9 안내를 빠뜨리지 않는다", () => {
    for (const s of ["확인되지 않은 개발자", "데이터 없음", "검증하지 못했습니다", "allowManagedHooksOnly", "allowedHttpHookUrls", "enabledPlugins"]) expect(html).toContain(s);
    expect(html).toContain("doctor가 모두 정상인데도 말풍선이 안 보이면, 회사 정책 때문일 수 있습니다");
    // Windows 실행 정책·내려받은 파일 차단(T8 리뷰, Ruling B16): 두 명령 모두 복사 상자로
    expect(html).toContain(`<code>Get-ChildItem -Recurse $HOME\\Downloads\\claude-office-${version} | Unblock-File</code></pre><button class="copy"`);
    expect(html).toContain("<code>powershell -ExecutionPolicy Bypass -File install.ps1</code></pre><button class=\"copy\"");
    expect(html).toContain("코드 서명이 없습니다.");
    expect(html).toContain("Windows에서는 실행 정책에 막힐 수 있습니다");
    // Ruling B12
    expect(html).toContain("PLAN 바(요금제 한도)는 베타에서 지원하지 않습니다(회사 좌석은 대부분 해당 데이터가 오지 않음)");
    // 옛 statusline fix 문구가 본문에도 그림에도 없다
    expect(html).not.toContain("요금제 한도 설정을 따라");
  });

  it("doctor·CLI 문구가 실제 코드와 같다", () => {
    const doctor = readFileSync(join(__dirname, "../../server/diag/doctor.ts"), "utf8");
    const index = readFileSync(join(__dirname, "../../server/index.ts"), "utf8");
    for (const s of ["받은 이벤트 0건", "파일 없음(회사가 다른 방식으로 정책을 배포했을 수 있음)", "그래도 안 되면 회사 관리자에게 사용설명서 부록 A를 전달해 주세요.", "Claude Code를 한 번 실행한 뒤 다시 확인해 주세요."]) {
      expect(doctor).toContain(s);
      expect(html).toContain(s);
    }
    expect(index).toContain("번이 이미 사용 중입니다. --port 로 다른 포트를 지정하세요.");
    expect(index).toContain("진단 파일을 만들었습니다: ");
    expect(index).toContain("이 파일을 담당자에게 보내 주세요. 대화 내용, 이름, 비밀값은 들어 있지 않습니다.");
    expect(html).toContain("이 파일을 담당자에게 보내 주세요. 대화 내용, 이름, 비밀값은 들어 있지 않습니다.");
  });

  it("designer 그림(베타 11개 + Phase 2 10개)이 인라인으로 들어가 있고 자리 표시가 남지 않았다", () => {
    const ids = [...html.matchAll(/<figure class="fig" data-fig="([\w-]+)">\s*(?:<!--[\s\S]*?-->\s*)?<svg /g)].map((m) => m[1]).sort();
    expect(ids).toEqual(
      [
        "fig-budget-alarm", "fig-budget-bar", "fig-budget-settings", "fig-decision-report", "fig-decision-result", "fig-diag-chip-panel", "fig-diag-file",
        "fig-err-401", "fig-err-already-answered", "fig-err-managed", "fig-err-no-browser", "fig-err-nobubble", "fig-err-node", "fig-err-offline", "fig-err-port",
        "fig-first-screen", "fig-install-ok", "fig-overview", "fig-plan-report", "fig-question-answer", "fig-screen-guide",
      ],
    );
    expect(html).not.toMatch(/<!-- FIG2?\(fig-/);
    expect(html).not.toContain('class="fig-slot"');
    const dup = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]).filter((id, i, all) => all.indexOf(id) !== i);
    expect(dup).toEqual([]);
  });

  it("그림이 designer 원본 SVG와 같다(같은 이름이면 Phase 2판이 우선)", () => {
    const pick = new Map<string, string>();
    for (const d of ["beta", "phase2"]) {
      const dir = join(__dirname, `../../docs/design/${d}/manual-figures`);
      for (const f of readdirSync(dir).filter((n) => n.endsWith(".svg"))) pick.set(f, join(dir, f));
    }
    for (const [f, path] of pick) expect(html, f).toContain(readFileSync(path, "utf8").trim());
    // 1장 그림은 Phase 2판(대시보드에서 누른 답 화살표)이다
    expect(figureText("fig-overview")).toContain("대시보드에서 누른 답");
  });

  it("설치 직후 노란 줄: 본문과 그림(fig-install-ok)이 같은 두 줄(포트, 실시간 이벤트)", () => {
    const fig = figureText("fig-install-ok");
    const warnLines = (t: string) => t.split("\n").filter((l) => l.startsWith("⚠️")).map((l) => l.trim());
    const expected = ["⚠️ 포트: 서버가 꺼져 있습니다(4317)", "⚠️ 실시간 이벤트: 서버가 꺼져 있어 확인하지 못했습니다"];
    expect(warnLines(fig)).toEqual(expected);
    expect(fig).toContain("노란 줄(포트, 실시간 이벤트)");
    const install = html.slice(html.indexOf('id="s3"'), html.indexOf('id="s4"')).replace(/<svg[\s\S]*?<\/svg>/g, "");
    expect(install).toContain("노란 줄 두 개");
    expect(warnLines(install.replace(/<[^>]+>/g, "\n"))).toEqual(expected);
  });

  it("그림 속 doctor 행 문구가 doctor 코드와 같다(fig-diag-chip-panel)", () => {
    const doctor = readFileSync(join(__dirname, "../../server/diag/doctor.ts"), "utf8");
    // 그림은 긴 문장을 여러 줄로 나누므로 공백을 지우고 비교한다
    const fig = figureText("fig-diag-chip-panel").replace(/\s+/g, "");
    // 코드는 "있음: ${problems.join(", ")}"처럼 조립하므로 조각으로 확인한다
    for (const s of ["`있음: ${problems.join(\", \")}`", '"관리자 hook만 허용"', "사용설명서 부록 A를 회사 관리자에게 전달해 설정을 부탁해 주세요.", "있음(로컬 주소 예외 없음)", "환경변수 NO_PROXY에 127.0.0.1,localhost 를 넣어 주세요(회사 IT 담당자에게 문의).", "최근 10분 ${v.last10min}건"]) {
      expect(doctor, s).toContain(s);
    }
    for (const s of ["있음: 관리자 hook만 허용", "사용설명서 부록 A를 회사 관리자에게 전달해 설정을 부탁해 주세요.", "있음(로컬 주소 예외 없음)", "환경변수 NO_PROXY에 127.0.0.1,localhost 를 넣어 주세요(회사 IT 담당자에게 문의).", "최근 10분 5건"]) {
      expect(fig, s).toContain(s.replace(/\s+/g, ""));
    }
    for (const title of ["회사 관리자 설정", "프록시", "포트", "실시간 이벤트", "Node.js"]) expect(doctor).toContain(`"${title}"`);
  });

  it("진단 패널 문구가 화면 코드와 같다", () => {
    const web = ["web/diag/DiagnosticsPanel.tsx", "web/diag/format.ts", "web/diag/DiagnosticsChip.tsx"]
      .map((f) => readFileSync(join(__dirname, "../..", f), "utf8"))
      .join("\n");
    const prose = html.replace(/<svg[\s\S]*?<\/svg>/g, "");
    for (const s of ["진단 파일 만들기", "만드는 중…", "진단 파일을 만들었습니다", "받기", "모두 정상입니다", "최근 1시간 오류 없음", "점검 결과", "hook 수신", "최근 오류", "다시 확인", "닫기", "진단 파일을 만들지 못했습니다. 잠시 뒤 다시 눌러 주세요. 계속 안 되면 터미널에서 "]) {
      expect(web, s).toContain(s);
      expect(prose, s).toContain(s);
    }
    // 코드에서 조립하는 문구
    expect(web).toContain("`확인할 항목이 ${w}개 있습니다`");
    expect(prose).toContain("확인할 항목이 2개 있습니다");
    expect(web).toContain("`문제 ${f}개를 찾았습니다`");
    expect(prose).toContain("문제 1개를 찾았습니다");
    expect(web).toContain("`최근 10분 ${h.last10min}건, ${");
    expect(prose).toContain("최근 10분 5건, 마지막 수신 2분 전, 거부 0건");
    expect(html).not.toContain("TODO(T10)");
  });

  it("설치·런처 문구가 스크립트와 같고 TODO가 남지 않았다", () => {
    const read = (f: string) => readFileSync(join(__dirname, "../..", f), "utf8");
    const install = read("packaging/install.sh");
    const launcher = read("packaging/claude-office.sh");
    const ps1 = read("packaging/install.ps1");
    const pairs: Array<[string, string]> = [
      [install, "에 claude-office 명령 경로를 추가할까요?"],
      [install, "Claude Code 플러그인(claude-office)을 설치할까요? 도구 사용 기록을 이 PC의 뷰어로 보내고, 대시보드에서 답한 허용·거부를 Claude Code에 돌려줍니다."],
      [read("packaging/install.ps1"), "Claude Code 플러그인(claude-office)을 설치할까요? 도구 사용 기록을 이 PC의 뷰어로 보내고, 대시보드에서 답한 허용·거부를 Claude Code에 돌려줍니다."], // Windows 설치 질문도 같은 문구(B63)
      [install, "설치 완료. 새 터미널에서 claude-office 를 실행하세요."],
      [install, "이미 다른 파일이 있는 폴더입니다. 빈 폴더나 새 폴더 이름을 지정해 주세요."],
      [install, "사용설명서 6장(문제가 생겼을 때)"],
      [ps1, "사용자 PATH에 claude-office 명령 경로를 추가할까요?"],
      [launcher, "로그와 진단 파일도 지울까요?"],
      // Ruling B17
      [install, "다음부터는 이렇게 켜세요: "],
      [launcher, "이 창을 닫으면 대시보드가 꺼집니다."],
      [launcher, "Claude Code에서 claude-office 플러그인도 지울까요?"],
      [launcher, "플러그인은 남겨 두었습니다. 지우려면: claude plugin uninstall claude-office@claude-office --scope user"],
      [launcher, "제거를 마쳤습니다."],
      [launcher, "지움: "],
      [launcher, "남김: "],
      // B19: 요약에 프로그램 파일·PATH 설정이 항상 들어간다
      [launcher, "프로그램 파일"],
      [launcher, "PATH 설정"],
    ];
    for (const [src, text] of pairs) {
      expect(src, text).toContain(text);
      if (text !== "사용설명서 6장(문제가 생겼을 때)") expect(html, text).toContain(text);
    }
    // install.sh가 가리키는 6장이 "문제가 생겼을 때"다
    expect(html).toContain('<h2 id="s6">6. 문제가 생겼을 때</h2>');
    expect(html).not.toMatch(/TODO\(/);
    expect(html).toContain("지움: 프로그램 파일, PATH 설정, 플러그인, logs, diagnostics");
    expect(html).toContain("지움: 프로그램 파일, PATH 설정\n남김: 플러그인, logs, diagnostics");
    expect(html).not.toContain("지움: 없음");
  });

  it("Node 24 미만 안내는 doctor 표가 아니라 런처·설치 스크립트가 먼저 내는 문구다", () => {
    const read = (f: string) => readFileSync(join(__dirname, "../..", f), "utf8");
    for (const f of ["packaging/claude-office.sh", "packaging/install.sh"]) expect(read(f), f).toContain("Node.js 24 이상이 필요합니다(지금 $(node -v)).");
    expect(read("packaging/install.sh")).toContain('echo "자세한 기록: $LOGFILE"');
    expect(read("packaging/install.sh")).toContain('LOGFILE="$PREFIX/logs/install-');
    const symptom = html.slice(html.indexOf("<h4>⑤"), html.indexOf("</div>", html.indexOf("<h4>⑤")));
    const prose = symptom.replace(/<svg[\s\S]*?<\/svg>/g, "");
    expect(prose).toContain("Node.js 24 이상이 필요합니다(지금 v20.11.0).");
    expect(prose).toContain("자세한 기록: /Users/&lt;사용자 이름&gt;/.claude-office/logs/install-"); // install.sh는 절대 경로로 찍는다
    expect(prose).not.toContain("❌ Node.js");
  });

  it("본문 예시 경로는 <사용자 이름>을 쓴다(그림은 designer 원본 그대로)", () => {
    const prose = html.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<!--[\s\S]*?-->/g, "");
    expect(prose).not.toContain("fakeuser");
    expect(prose).toContain("/Users/&lt;사용자 이름&gt;/.claude");
  });

  it("3장 설치 직후 doctor 상자의 줄이 doctor.ts의 title·detail·fix 문자열과 같다", () => {
    const doctor = readFileSync(join(__dirname, "../../server/diag/doctor.ts"), "utf8");
    // doctor.ts의 문자열·템플릿 리터럴을 정규식으로(${…}는 아무 값)
    const literals = [...doctor.matchAll(/"((?:[^"\\]|\\.)*)"|`([^`]*)`/g)].map((m) => m[1] ?? m[2]);
    const patterns = literals.map((l) => new RegExp(`^${l.split(/\$\{[^}]*\}/).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".+")}$`));
    const known = (t: string) => patterns.some((re) => re.test(t));
    const install = html.slice(html.indexOf('id="s3"'), html.indexOf('id="s4"')).replace(/<svg[\s\S]*?<\/svg>/g, "");
    const box = install.slice(install.indexOf('<div class="box ok-box">\n  <pre class="out">✅ Node.js'));
    const pre = box.slice(box.indexOf("<pre"), box.indexOf("</pre>")).replace(/<[^>]+>/g, "");
    const lines = pre.split("\n").filter((l) => /^(✅|⚠️|❌) |^ {2}→ /.test(l));
    expect(lines.length).toBe(14); // Phase 2: 대시보드 열쇠, 결정 대기 시간
    for (const l of lines) {
      const fix = /^ {2}→ (.*)$/.exec(l);
      if (fix) {
        expect(known(fix[1]), l).toBe(true);
        continue;
      }
      const m = /^(?:✅|⚠️|❌) ([^:]+): (.*)$/.exec(l)!;
      expect(m, l).not.toBeNull();
      expect(known(m[1]), `title ${l}`).toBe(true);
      expect(known(m[2]), `detail ${l}`).toBe(true);
    }
  });

  it("탭은 tablist/tab/tabpanel로 연결되고 ←/→로 옮겨 가며, 복사 결과는 숨긴 status 하나로 알린다", async () => {
    const { JSDOM } = await import("jsdom");
    const dom = new JSDOM(html, {
      runScripts: "dangerously",
      beforeParse(w: import("jsdom").DOMWindow) {
        Object.defineProperty(w.navigator, "userAgent", { get: () => "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)" });
        Object.defineProperty(w.navigator, "clipboard", { value: { writeText: () => Promise.resolve() } });
      },
    });
    const d = dom.window.document;
    const list = d.querySelectorAll('[role="tablist"]')[1]; // 3장 설치
    const tabs = [...list.querySelectorAll('[role="tab"]')] as HTMLElement[];
    expect(tabs.map((t) => t.dataset.os)).toEqual(["mac", "linux", "win"]);
    for (const t of tabs) {
      const panel = d.getElementById(t.getAttribute("aria-controls")!)!;
      expect(panel.getAttribute("role")).toBe("tabpanel");
      expect(panel.getAttribute("aria-labelledby")).toBe(t.id);
    }
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    tabs[0].focus();
    tabs[0].dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(d.activeElement).toBe(tabs[1]);
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
    expect(tabs.map((t) => t.tabIndex)).toEqual([-1, 0, -1]);
    expect((d.getElementById(tabs[1].getAttribute("aria-controls")!) as HTMLElement).hidden).toBe(false);
    tabs[1].dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    tabs[0].dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(d.activeElement).toBe(tabs[2]); // 처음에서 ←는 끝으로

    const status = d.getElementById("copy-status")!;
    expect(status.getAttribute("role")).toBe("status");
    expect(status.textContent).toBe("");
    const button = d.querySelector(".copy") as HTMLElement;
    const seen: string[] = [];
    for (let i = 0; i < 2; i++) {
      button.click();
      await new Promise((r) => setTimeout(r, 0));
      seen.push(status.textContent!);
      expect(d.getElementById("copy-status")).toBe(status); // 같은 노드
    }
    expect(seen.map((x) => x.replace(/\u00A0$/, ""))).toEqual(["복사했습니다", "복사했습니다"]);
    expect(seen[0].endsWith("\u00A0")).toBe(!seen[1].endsWith("\u00A0"));
    expect(button.textContent).toBe("복사됨");
  });

  it("6장 ③④⑤의 출력 상자가 실제 문구 조각과 같다(B20)", () => {
    const read = (f: string) => readFileSync(join(__dirname, "../..", f), "utf8");
    const doctor = read("server/diag/doctor.ts");
    const index = read("server/index.ts");
    const launcher = read("packaging/claude-office.sh");
    const box = (h: string) => {
      const at = html.indexOf(`<h4>${h}`);
      const sec = html.slice(at, html.indexOf('<div class="symptom">', at + 1) > 0 ? html.indexOf('<div class="symptom">', at + 1) : html.indexOf("</h2>", at)).replace(/<svg[\s\S]*?<\/svg>/g, "");
      return [...sec.matchAll(/<pre class="out">([\s\S]*?)<\/pre>/g)].map((m) => m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">")).join("\n");
    };
    // ③ 관리자 설정: 코드는 "있음: ${problems.join(", ")}" + "관리자 hook만 허용"
    expect(doctor).toContain('`있음: ${problems.join(", ")}`');
    expect(doctor).toContain('problems.push("관리자 hook만 허용")');
    expect(doctor).toContain('item("managed", "fail", title, `있음: ${problems.join(", ")}`, "사용설명서 부록 A를 회사 관리자에게 전달해 설정을 부탁해 주세요.")');
    expect(box("③")).toBe("❌ 회사 관리자 설정: 있음: 관리자 hook만 허용\n  → 사용설명서 부록 A를 회사 관리자에게 전달해 설정을 부탁해 주세요.");
    // ④ 포트: 템플릿에 4317을 넣은 결과, 서버의 포트 충돌 문구
    const other = /item\("port", "fail", "포트", `([^`]*)`/.exec(doctor)![1].replace("${d.port}", "4317");
    expect(box("④")).toContain(`❌ 포트: ${other}`);
    // FB-2: 이전 버전(v1) 판정 줄과 fix, hooks 문구
    const v1 = /item\("port", "warn", "포트", `(이전 버전\(v1\)[^`]*)`, "([^"]*)"\)/.exec(doctor)!;
    expect(box("④")).toContain(`⚠️ 포트: ${v1[1].replace("${d.port}", "4317")}\n  → ${v1[2]}`);
    expect(doctor).toContain('"확인하지 못했습니다(이전 버전 서버)"');
    expect(html).toContain("<code>확인하지 못했습니다(이전 버전 서버)</code>");
    const inUse = /`(포트 \$\{port\}번이 이미 사용 중입니다\.[^`]*)`/.exec(index)![1].replace("${port}", "4317"); // B64: portInUseOutcome
    expect(box("④")).toContain(inUse);
    // ⑤ Node: 런처 문구에 v20.11.0을 넣은 결과
    const node = /Node\.js 24 이상이 필요합니다\(지금 \$\(node -v\)\)\./.exec(launcher)![0].replace("$(node -v)", "v20.11.0");
    expect(box("⑤").split("\n")[0]).toBe(node);
    expect(box("⑤")).toContain("자세한 기록: /Users/<사용자 이름>/.claude-office/logs/install-");
  });

  it("로그 정리 안내가 실제 정리 대상과 같다(실행 로그만 7일, 설치 기록은 남음)", () => {
    const log = readFileSync(join(__dirname, "../../server/log.ts"), "utf8");
    // 로거의 정리는 office-YYYY-MM-DD.log만 지운다(install-*.log는 대상이 아님)
    expect(log).toContain("const FILE = /^office-(\\d{4}-\\d{2}-\\d{2})\\.log$/;");
    expect(log).toContain("retainDays ?? 7");
    expect(html).toContain("실행 로그는 7일이 지나면 저절로 지워집니다(설치 기록은 남습니다).");
    expect(html).not.toContain("로그는 7일이 지나면 저절로 지워집니다.</li>");
  });

  it("부록 A에 베타 미검증 안내와 OS별 플러그인 폴더가 있다(B20)", () => {
    const a = html.slice(html.indexOf('id="s8"'), html.indexOf('id="s9"'));
    expect(a).toContain("이 설정은 베타에서 검증하지 못했습니다. 관리자는 IT 시험 PC에서 먼저 확인해 주세요.");
    expect(a).toContain("<code>~/.claude-office/plugin</code>");
    expect(a).toContain("<code>%USERPROFILE%\\.claude-office\\plugin</code>");
  });

  it("설명서의 버전 표기가 package.json version과 같다", () => {
    const found = [...html.matchAll(/\d+\.\d+\.\d+-(?:beta\.\d+|dev)/g)].map((m) => m[0]);
    expect(found.length).toBeGreaterThan(5); // 파일 이름·폴더 이름·상단 표기
    expect(new Set(found)).toEqual(new Set([version]));
    expect(html).toContain(`개발 버전 ${version}`);
    expect(html).toContain(`claude-office-${version}.tar.gz`);
    expect(html).toContain(`claude-office-${version}.zip`);
  });

  it("입력을 받을 수 없을 때의 안내가 스크립트와 같다(FB-1: sh 설치 --yes, Windows 설치 -Yes, 제거 --yes)", () => {
    const read = (f: string) => readFileSync(join(__dirname, "../..", f), "utf8");
    const sh = "입력을 받을 수 없어 '아니오'로 처리했습니다. 설치하려면 --yes를 붙여 다시 실행하세요.";
    const ps1 = "설치하려면 -Yes를 붙여 다시 실행하세요.";
    const un = "제거하려면 --yes를 붙여 다시 실행하세요.";
    expect(read("packaging/install.sh")).toContain(sh);
    expect(read("packaging/install.ps1")).toContain(`입력을 받을 수 없어 '아니오'로 처리했습니다. ${ps1}`);
    expect(read("packaging/claude-office.sh")).toContain(`입력을 받을 수 없어 '아니오'로 처리했습니다. ${un}`);
    expect(read("packaging/claude-office.ps1")).toContain(`입력을 받을 수 없어 '아니오'로 처리했습니다. ${un}`);
    const prose = html.replace(/<svg[\s\S]*?<\/svg>/g, "");
    expect(prose).toContain(`<pre class="out">${sh}</pre>`);
    expect(prose).toContain(`<li>Windows 설치: <code>입력을 받을 수 없어 '아니오'로 처리했습니다. ${ps1}</code></li>`);
    expect(prose).toContain(`<code>입력을 받을 수 없어 '아니오'로 처리했습니다. ${un}</code></li>`);
    // B26: "모두 예" 명령이 무엇에 동의하는지 밝힌다
    expect(prose).toContain("이 명령은 PATH 추가와 Claude Code 플러그인 설치에 모두 동의합니다.");
    // 해결 명령(복사 상자)
    for (const cmd of ["sh install.sh --yes", "powershell -ExecutionPolicy Bypass -File .\\install.ps1 -Yes", "claude-office uninstall --yes"]) {
      expect(prose, cmd).toContain(`<code>${cmd}</code></pre><button class="copy"`);
    }
    // Windows 설치에는 --yes가 아니라 -Yes
    expect(prose).not.toMatch(/install\.ps1[^<]*--yes/);
    expect(read("packaging/install.ps1")).toMatch(/\[switch\]\$Yes/);
  });

  it("PowerShell ISE가 아니라 PowerShell 창에서 실행하라는 안내가 3장과 6장에 있다(B67)", () => {
    // 설명서의 ISE 문장이 기대는 코드 사실(B68): 두 ps1의 Confirm-Step은 ConsoleHost일 때만 콘솔에서 직접 읽고,
    // 그 밖의 호스트(ISE 등)는 Read-Host로 묻는다. 글자 그대로가 아니라 분기 구조만 본다
    for (const f of ["packaging/install.ps1", "packaging/claude-office.ps1"]) {
      const src = readFileSync(join(__dirname, "../..", f), "utf8");
      const start = src.indexOf("function Confirm-Step");
      const fn = src.slice(start, src.indexOf("\n}\n", start));
      const m = /\n  if \(\$Host\.Name -eq 'ConsoleHost'\) \{([\s\S]*?)\n  \} else \{([\s\S]*?)\n  \}/.exec(fn);
      expect(m, `${f}: ConsoleHost 분기`).not.toBeNull();
      const [, consoleSide, otherSide] = m!;
      expect(consoleSide, f).toContain("[Console]::In.ReadLine()");
      expect(consoleSide, f).not.toContain("Read-Host");
      expect(otherSide, f).toMatch(/Read-Host /);
      expect(otherSide, f).not.toContain("ReadLine");
    }
    const prose = html.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<!--[\s\S]*?-->/g, "");
    const line = "<strong>PowerShell ISE</strong>가 아니라 PowerShell 창(또는 Windows Terminal)에서 실행해 주세요.";
    const win = prose.slice(prose.indexOf('data-os="win"'), prose.indexOf('<h3>설치 중 질문</h3>'));
    expect(win).toContain(line);
    const s6 = prose.slice(prose.indexOf('<h2 id="s6">'), prose.indexOf('<h2 id="s7">'));
    const sec = s6.slice(s6.indexOf('<h3 id="ise">'), s6.indexOf("<h3", s6.indexOf('<h3 id="ise">') + 1));
    expect(sec).toContain("질문이 안 뜨고 설치가 안 돼요(Windows)");
    expect(sec).toContain("질문에 답하지 못한 채 설치(또는 제거)가 끝났거나 멈췄다면");
    expect(sec).toContain("PowerShell ISE");
    expect(sec).toContain("<code>powershell -ExecutionPolicy Bypass -File .\\install.ps1 -Yes</code>");
    expect(sec).toContain("<code>claude-office uninstall --yes</code>");
    // 안내 문구가 ISE에서 나오는지는 확인 전(#176)이므로, 안내가 나온다고 단정하지 않는다
    expect(sec).not.toContain("입력을 받을 수 없어");
    expect(sec).toContain("Windows 화면은 베타에서 확인 전입니다");
  });

  describe("Phase 2 결정 보고서·예산·401 문구가 코드와 같다", () => {
    const read = (f: string) => readFileSync(join(__dirname, "../..", f), "utf8");
    const prose = html.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<!--[\s\S]*?-->/g, "");
    // 코드 파일에 있는 문자열이 설명서에도 그대로 있는지(파일, 문구 목록)
    const same = (file: string, texts: string[]) => {
      const src = read(file);
      for (const t of texts) {
        expect(src, `${file}: ${t}`).toContain(t);
        expect(prose, `manual: ${t}`).toContain(t);
      }
    };

    it("보고서 결과와 409 문구(web/report/text.ts)", () => {
      same("web/report/text.ts", [
        "이 명령을 실행해도 될까요?",
        "질문에 답해 주세요",
        "예산에 도달했습니다. 계속할까요?",
        "대시보드에서 허용함",
        '"터미널에서 이미 답함"',
        '"시간이 지나 터미널로 넘어감"',
        '"이미 터미널에서 답했습니다"',
        '"다른 창에서 이미 답했습니다"',
      ].map((t) => t.replace(/^"|"$/g, "")));
    });

    it("보고서 화면 문구(DecisionReport, QuestionForm)", () => {
      same("web/report/DecisionReport.tsx", [
        "거부 이유 (선택, Claude에게 전달됩니다)",
        "남음 · 지나면 터미널에서 묻습니다",
        "계속을 누르면 이 도구 실행도 함께 허용됩니다",
        "예산만큼 더 쓰면 다시 묻습니다",
        "터미널에서 답해 주세요",
        "터미널(리드 세션)에서 답해 주세요",
      ]);
      same("web/report/QuestionForm.tsx", ["기타 (직접 입력)", "이 답 보내기"]);
    });

    it("서버가 Claude에게 보내는 문구(protocol.ts)와 9:50", () => {
      const protocol = read("server/decisions/protocol.ts");
      for (const name of ["DENY_DEFAULT", "BUDGET_STOP"]) {
        const v = new RegExp(`export const ${name} = "([^"]+)"`).exec(protocol)![1];
        expect(prose, name).toContain(v);
      }
      // budgetReason 템플릿에 500,000을 넣은 결과
      const tpl = /return `(예산\(\$\{budgetTokens\.toLocaleString\("en-US"\)\}토큰\)[^`]*)`/.exec(protocol)![1];
      expect(prose).toContain(tpl.replace('${budgetTokens.toLocaleString("en-US")}', (500_000).toLocaleString("en-US")));
      // 화면은 590초(9:50)부터 센다
      expect(protocol).toContain("export const HOLD_MS = 590_000;");
      expect(prose).toContain("9:50 남음 · 지나면 터미널에서 묻습니다");
    });

    it("예산 설정 창과 알림(web/budget)", () => {
      same("web/budget/BudgetDialog.tsx", ["비워 두면 예산 없음. 1,000 ~ 1,000,000,000", "앞으로 새로 생기는 층에 적용됩니다. 지금 있는 층은 바뀌지 않습니다."]);
      same("web/budget/useBudgetAlarm.ts", ["예산에 도달했습니다"]);
    });

    it("401 화면(web/App.tsx)", () => {
      const app = read("web/App.tsx").replace(/<\/?code>/g, "");
      expect(app).toContain("터미널에서 claude-office로 열어 주세요");
      expect(prose).toContain("터미널에서 claude-office로 열어 주세요");
    });

    it("doctor 새 두 줄(server/diag/doctor.ts)", () => {
      same("server/diag/doctor.ts", ["대시보드 열쇠", "결정 대기 시간", "claude-office를 다시 켜면 만들어집니다", "대시보드에서 답하려면 플러그인을 업데이트해 주세요"]);
      expect(prose).toContain("⚠️ 결정 대기 시간: 5초 — 대시보드에서 답하려면 플러그인을 업데이트해 주세요");
    });

    it("런처 출력이 스크립트·서버와 같다(B45 브라우저 열기 실패 두 줄, B42 이미 켜져 있음)", () => {
      const lines = ["브라우저를 열지 못했습니다. 이 주소를 브라우저에 붙여 넣어 주세요: ", "이 주소는 열쇠입니다. 남에게 보내지 마세요."];
      for (const f of ["packaging/claude-office.sh", "packaging/claude-office.ps1"]) for (const l of lines) expect(read(f), `${f}: ${l}`).toContain(l);
      expect(prose).toContain(`${lines[0]}http://127.0.0.1:4317/?k=…\n${lines[1]}`);
      // B64: 설치본의 문구(새 버전이 이미 켜져 있음)와 이전 버전이 켜져 있을 때의 문구
      const onNew = "이미 켜져 있습니다. 브라우저에서 대시보드를 다시 열었습니다. 이 창은 닫아도 대시보드가 꺼지지 않습니다.";
      const onOld = "이전 버전 대시보드가 켜져 있습니다. 그 대시보드를 켠 터미널 창에서 Ctrl+C를 누르거나 그 창을 닫은 뒤, claude-office를 다시 실행해 주세요.";
      for (const t of [onNew, onOld]) expect(read("server/index.ts"), t).toContain(`"${t}"`);
      expect(prose).toContain(`이 창을 닫으면 대시보드가 꺼집니다.\n${onNew}`);
      expect(prose).toContain(`이 창을 닫으면 대시보드가 꺼집니다.\n${onOld}`);
      // 7장: 제거가 token·state.json도 지운다
      expect(read("packaging/claude-office.sh")).toMatch(/rm -rf [^\n]*"\$PREFIX\/token" "\$PREFIX\/state\.json"/);
      expect(prose).toContain("접속 열쇠 파일(<code>token</code>)과 층별 예산 설정(<code>state.json</code>)");
    });

    it("Phase 2로 사실이 바뀐 옛 문장이 남아 있지 않다(B41)", () => {
      for (const old of ["설정을 읽기만 합니다", "<strong>보기만</strong> 하고 Claude의 동작을 바꾸지 않습니다", "hook에 어떤 결정도 돌려주지 않습니다", "읽기 전용 대시보드", "Claude Code 창으로 가서 답해 주세요", "브라우저 주소 창에 <code>http://127.0.0.1:4317</code>을 입력합니다", "대시보드가 이미 다른 창에서 켜져 있을 가능성이 가장 큽니다", "대시보드가 보이면 그대로 쓰면 됩니다", "</code>대로 하던 일을"]) {
        expect(prose, old).not.toContain(old);
      }
    });

    it("검토 fix round 1(B69): ④ 포트 안내, 예산 두 문장(B35), 부록 A의 ask와 CLI 열쇠", () => {
      // ④ "포트 … 사용 중"은 이 대시보드(phase2)·베타가 아닐 때만 나온다(server/index.ts portInUseOutcome)
      const idx = read("server/index.ts");
      expect(idx).toMatch(/if \(kind === "phase2"\)[\s\S]*if \(kind === "beta"\)[\s\S]*포트 \$\{port\}번이 이미 사용 중입니다/);
      expect(read("server/diag/doctor.ts")).toContain(': "v1";');
      const s4 = prose.slice(prose.indexOf("④ 켤 때"), prose.indexOf("</div>", prose.indexOf("④ 켤 때")));
      expect(s4).toContain("이 안내는 <strong>다른 프로그램이나 예전 뷰어(v1)</strong>가 4317을 쓰고 있을 때만 나옵니다.");
      // B35
      const budget = prose.slice(prose.indexOf('<h3 id="budget">'), prose.indexOf("<h3>위쪽 막대의 숫자</h3>"));
      expect(budget).toContain("Claude Code 창에서 허용해도 '계속'과 같습니다(예산만큼 더 쓰면 다시 묻습니다).");
      expect(budget).toContain("중단하면 그 도구만 막히고, Claude가 다음 도구를 쓰려 하면 다시 묻습니다.");
      expect(budget).toContain("<strong>계속</strong>을 누르면 하던 일을 이어 갑니다. 보고서에 적힌 대로(<code>계속을 누르면 이 도구 실행도 함께 허용됩니다</code>)");
      // 부록 A
      const a = prose.slice(prose.indexOf('<h2 id="s8">'), prose.indexOf('<h2 id="s9">'));
      expect(read("server/decisions/protocol.ts")).toContain('hookEventName: "PreToolUse", permissionDecision: "ask"');
      expect(a).toContain("<code>PreToolUse</code> hook에 <code>\"ask\"</code>(확인 요청)를 돌려줘");
      expect(a).toContain("<code>PermissionRequest</code> 외에 결정을 돌려주는 hook은 이것 하나입니다.");
      expect(idx).toMatch(/Authorization: `Bearer \$\{token\}`/);
      expect(a).toContain("<code>Authorization</code> 헤더로 보냅니다");
      // #182 보충: doctor의 "ours"에는 인증 없는 베타 서버도 들어간다. 4317을 먼저 차지한 프로그램은 흉내 낼 수 있다
      expect(a).toContain("이 프로그램(이전 버전 포함)의 서버로 확인된 경우에만 보냅니다.");
      expect(a).not.toContain("이 대시보드로 확인된 서버에만");
      expect(a).toContain("같은 PC에서 4317을 먼저 차지한 프로그램은 그 확인 표시를 흉내 낼 수 있습니다.");
    });

    it("본문의 숫자가 코드와 같다(B69: 200자, 3초, 1년, 50%·20%, 600초·5초)", () => {
      const num = (src: string, re: RegExp) => Number(re.exec(src)?.[1]?.replace(/_/g, ""));
      const reasonMax = num(read("server/decisions/protocol.ts"), /export const REASON_MAX = (\d+);/);
      expect(num(read("web/report/DecisionReport.tsx"), /const REASON_MAX = (\d+);/)).toBe(reasonMax);
      expect(prose).toContain(`짧게(${reasonMax}자까지)`);
      const advance = num(read("web/report/DecisionReport.tsx"), /export const ADVANCE_MS = ([\d_]+);/);
      expect(prose).toContain(`${advance / 1000}초 뒤 다음 결정으로 넘어가거나`);
      const maxAge = num(read("server/app.ts"), /Max-Age=(\d+)/);
      expect(maxAge).toBe(365 * 24 * 3600);
      expect(prose).toContain("이 브라우저에 1년 동안 기억됩니다");
      const bar = read("web/hud/HeartBar.tsx");
      const ok = num(bar, /remaining >= (\d+)\) return "ok"/), warn = num(bar, /remaining >= (\d+)\) return "warn"/);
      expect(prose).toContain(`${ok}% 이상 초록, ${warn}% 이상 노랑, 그 아래는 분홍입니다.`);
      const hooks = JSON.parse(read("plugins/claude-office/hooks/hooks.json")).hooks as Record<string, Array<{ hooks: Array<{ timeout: number }> }>>;
      const timeouts = Object.entries(hooks).map(([ev, list]) => [ev, list[0].hooks[0].timeout] as const);
      const pr = timeouts.find(([ev]) => ev === "PermissionRequest")![1];
      const others = new Set(timeouts.filter(([ev]) => ev !== "PermissionRequest").map(([, t]) => t));
      expect(others.size).toBe(1);
      expect(prose).toContain(`최대 ${pr}초(${pr / 60}분) 동안 응답을 기다렸다가`);
      expect(prose).toContain(`다른 hook의 timeout은 ${[...others][0]}초입니다.`);
    });

    it("터미널에서 먼저 답해도 대시보드 요청이 잠깐 남고, 그때 누른 답은 적용되지 않는다(B70·B71, #190)", () => {
      const text = read("web/report/text.ts");
      for (const t of ['allow: "대시보드에서 허용함"', 'deny: "대시보드에서 거부함"']) expect(text).toContain(t);
      const report = prose.slice(prose.indexOf('<h3 id="report">'), prose.indexOf('<h3 id="budget">'));
      expect(report).toContain("<li>Claude Code 창에서 먼저 답해도 대시보드에 그 요청이 잠깐 남아 있을 수 있습니다. 창에서 허용했다면 보통 그 작업이 끝날 때까지 남고, 드물게 더 오래 남습니다. 그 사이 대시보드에서 누른 답은 <code>대시보드에서 허용함</code>·<code>대시보드에서 거부함</code>으로 보여도 <strong>적용되지 않습니다</strong>. Claude Code 창의 답이 이미 적용되었습니다.</li>");
      const s6 = prose.slice(prose.indexOf('<h3 id="already-answered">'), prose.indexOf('<h3 id="no-key">'));
      expect(s6).toContain("<p>Claude Code 창에서 허용한 경우에는 그 작업이 끝날 때까지(드물게 더 오래) 대시보드에 요청이 남아 있을 수 있습니다. 그 사이에 대시보드에서 누르면 이 안내 대신 <code>대시보드에서 허용함</code>·<code>대시보드에서 거부함</code>이 보일 수 있지만, 이때도 대시보드의 답은 <strong>적용되지 않습니다</strong>. 실제로 적용된 답은 Claude Code 창의 답입니다.</p>");
      const b = prose.slice(prose.indexOf('<h2 id="s9">'));
      expect(b).toContain("Claude Code 창에서 먼저 답해도 대시보드에 요청이 잠깐 남을 수 있고, 그때 대시보드에서 누른 답은 화면에 어떻게 보이든 적용되지 않습니다.");
    });

    it("예산 보고서는 저절로 열리지 않는다: 다음 도구 때 권한 창과 손들기, 누르면 열림(#191)", () => {
      const budget = prose.slice(prose.indexOf('<h3 id="budget">'), prose.indexOf("<h3>위쪽 막대의 숫자</h3>"));
      expect(budget).toContain("소리는 없습니다. 그 뒤 Claude가 <strong>다음 도구를 쓰려 할 때</strong> Claude Code 창에 <code>예산(500,000토큰)에 도달했습니다. 대시보드나 이 창에서 계속할지 정해 주세요</code> 같은 권한 창이 뜨고, 대시보드에서는 그 층의 캐릭터가 손을 듭니다. 손 든 캐릭터(또는 위쪽 막대의 <strong>결정 대기 N</strong>)를 누르면 <code>예산에 도달했습니다. 계속할까요?</code> 보고서가 열립니다. 먼저 답한 쪽이 적용됩니다.</li>");
      expect(budget).not.toContain("같은 권한 창이 뜨고, 대시보드에는 <code>예산에 도달했습니다");
    });

    it("열쇠 값 모양(64자 hex)이 없다", () => {
      expect(html).not.toMatch(/[0-9a-f]{64}/i);
    });
  });

  it("비밀값 모양과 실제 사용자 경로가 없다", () => {
    expect(html).not.toMatch(/sk-ant-/);
    expect(html).not.toMatch(/\b[0-9a-f]{40}\b/i);
    expect(html).not.toContain(homedir());
    const name = userInfo().username;
    if (name !== "fakeuser") expect(html).not.toMatch(new RegExp(`[\\\\/]${name}[\\\\/]`));
  });
});
