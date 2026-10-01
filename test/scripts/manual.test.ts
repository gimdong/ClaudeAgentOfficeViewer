import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

const html = readFileSync(join(__dirname, "../../docs/manual/index.html"), "utf8");

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
    expect(html).toContain("<code>Get-ChildItem -Recurse $HOME\\Downloads\\claude-office-2.0.0-beta.1 | Unblock-File</code></pre><button class=\"copy\"");
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

  it("designer 그림 11개가 인라인으로 들어가 있고 자리 표시가 남지 않았다", () => {
    const ids = [...html.matchAll(/<figure class="fig" data-fig="([\w-]+)">\s*(?:<!--[\s\S]*?-->\s*)?<svg /g)].map((m) => m[1]).sort();
    expect(ids).toEqual(["fig-diag-chip-panel", "fig-diag-file", "fig-err-managed", "fig-err-nobubble", "fig-err-node", "fig-err-offline", "fig-err-port", "fig-first-screen", "fig-install-ok", "fig-overview", "fig-screen-guide"]);
    expect(html).not.toMatch(/<!-- FIG\(fig-/);
    expect(html).not.toContain('class="fig-slot"');
    const dup = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]).filter((id, i, all) => all.indexOf(id) !== i);
    expect(dup).toEqual([]);
  });

  it("그림 11개가 designer 원본 SVG와 같다", () => {
    const dir = join(__dirname, "../../docs/design/beta/manual-figures");
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".svg"))) expect(html, f).toContain(readFileSync(join(dir, f), "utf8").trim());
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
      [install, "Claude Code 플러그인(claude-office)을 설치할까요? 도구 사용 기록을 이 PC의 뷰어로 보냅니다."],
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
    expect(lines.length).toBe(12);
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
    const inUse = /console\.error\(`(포트 \$\{opts\.port\}번이 이미 사용 중입니다\.[^`]*)`\)/.exec(index)![1].replace("${opts.port}", "4317");
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

  it("비밀값 모양과 실제 사용자 경로가 없다", () => {
    expect(html).not.toMatch(/sk-ant-/);
    expect(html).not.toMatch(/\b[0-9a-f]{40}\b/i);
    expect(html).not.toContain(homedir());
    const name = userInfo().username;
    if (name !== "fakeuser") expect(html).not.toMatch(new RegExp(`[\\\\/]${name}[\\\\/]`));
  });
});
