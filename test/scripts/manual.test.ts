import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

const html = readFileSync(join(__dirname, "../../docs/manual/index.html"), "utf8");

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

  it("비밀값 모양과 실제 사용자 경로가 없다", () => {
    expect(html).not.toMatch(/sk-ant-/);
    expect(html).not.toMatch(/\b[0-9a-f]{40}\b/i);
    expect(html).not.toContain(homedir());
    const name = userInfo().username;
    if (name !== "fakeuser") expect(html).not.toMatch(new RegExp(`[\\\\/]${name}[\\\\/]`));
  });
});
