import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("영어 문서 (Phase 5 §4·§5)", () => {
  it("README 두 개가 첫 줄에서 서로를 가리킨다", () => {
    expect(read("README.md").split("\n")[0]).toBe("[한국어](README.ko.md)");
    expect(read("README.ko.md").split("\n")[0]).toBe("[English](README.md)");
  });

  it("영어 README에 스펙 §4의 절이 모두 있다", () => {
    const md = read("README.md");
    for (const h of ["## Install", "## Start", "## Security model", "## Experimental features", "## License"]) expect(md, h).toContain(h);
    expect(md).toContain("claude-office open");
    // 보안 모델은 스펙 §2와 같게: Linux만 같은 계정 검사, macOS·Windows는 검사하지 않음
    expect(md).toMatch(/On Linux, the server accepts a connection only if it comes from a process of the same user account/);
    expect(md).toMatch(/On macOS and Windows this check is \*\*not\*\* done/);
  });

  it("en.html은 영어 문서이고 세 장(설치·시작·문제 해결)이 있으며 그림을 넣지 않는다", () => {
    const html = read("docs/manual/en.html");
    expect(html).toMatch(/<html lang="en">/);
    for (const [id, title] of [["install", "1. Install"], ["start", "2. Start and stop"], ["trouble", "3. Troubleshooting"]]) {
      expect(html, id).toContain(`<h2 id="${id}">${title}</h2>`);
    }
    expect(html).not.toContain("<svg");
    expect(html).not.toMatch(/src="https?:|href="https?:\/\/(?!nodejs\.org|github\.com\/gimdong\/)/);
  });

  it("한국어 설명서 첫 부분에 영어판 링크가 있다", () => {
    const ko = read("docs/manual/index.html");
    const link = ko.indexOf('href="en.html"');
    expect(link).toBeGreaterThan(-1);
    expect(link).toBeLessThan(ko.indexOf('<nav class="toc"'));
  });

  it("릴리스 노트는 영어 문단이 먼저이고 Source code 경고가 영어·한국어 모두 있다", () => {
    const yml = read(".github/workflows/release.yml");
    const en = yml.indexOf("Do not use it to install.");
    const ko = yml.indexOf("설치에는 쓰지 마세요.");
    expect(en).toBeGreaterThan(-1);
    expect(ko).toBeGreaterThan(en);
  });

  it("문서 예시에 실제 홈 경로·이메일이 없다(B242)", () => {
    for (const p of ["README.md", "README.ko.md", "docs/manual/en.html", "docs/admin.md"].filter((f) => existsSync(join(root, f)))) {
      const t = read(p);
      expect(/\/Users\/(?!<user name>|&lt;user name&gt;|fakeuser)[A-Za-z]/.test(t), p).toBe(false);
      expect(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(t), p).toBe(false);
    }
  });
});
