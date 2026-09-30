# v2.0.0-beta.1 베타 배포 — 설계 스펙

- 날짜: 2026-10-01
- 기준: main `fbac0a5`(v2 Phase 1 완료본)
- 브랜치: `feat/beta-release`

## 1. 목적

- Phase 1 버전을 **오늘 엔터프라이즈 환경의 베타 고객**에게 배포한다.
- 문제가 생기면 **고객이 진단 파일 하나를 만들어 보내고**, QA가 그 파일로 원인을 분석해 우리가 고칠 수 있게 한다.

### 사용자 결정 (2026-10-01)

| 항목 | 결정 |
|---|---|
| 설치 방식 | 설치 스크립트 하나 |
| 운영체제 | mac, Linux(Ubuntu), Windows(PowerShell). 개발과 검증은 이 순서를 따른다 |
| 로그 전달 | 고객이 진단 파일 하나를 사용자에게 전달한다. 사용자가 저장소에 넣으면 QA가 분석한다. 자동 전송은 하지 않는다 |
| 코드 전달 | 베타 패키지 파일을 전달한다. 저장소는 비공개로 유지한다 |
| 팀 | QA 팀원(`qa`)을 추가한다. 로그와 진단 기능 개발, 사용설명서 작성을 맡는다. reviewer가 검토하고 director가 최종 확인한다 |

### 고객 가정
- 개발자가 아니고, Claude Code를 처음 쓴다.
- 터미널에 명령 한 줄을 붙여 넣는 정도는 안내를 받으면 할 수 있다.
- 회사 PC라서 관리자 정책(managed settings), 사내 프록시, npm 차단이 있을 수 있다.

## 2. 배포 패키지

- `npm run package:beta`가 `release/` 폴더에 다음 두 파일을 만든다.
  - `claude-office-2.0.0-beta.1.tar.gz`: mac, Linux용
  - `claude-office-2.0.0-beta.1.zip`: Windows용
- 두 파일의 내용은 같다. 차이는 압축 형식과 줄바꿈뿐이다.

| 경로(패키지 안) | 내용 |
|---|---|
| `app/server.mjs` | `vite build --ssr`로 묶은 서버. **tsx 없이 `node`로 실행한다** (QA 발견 2) |
| `app/web/` | 빌드된 화면(`dist/web`). Galmuri 폰트를 포함한다 |
| `app/node_modules/` | 운영용 의존성만 넣는다(`express`와 그 하위 의존성). 모두 순수 JS라 운영체제와 관계없이 동작한다. **그래서 고객 PC에서 npm이나 인터넷이 필요 없다** |
| `app/package.json` | 버전과 `engines.node >=24` |
| `plugin/` | 로컬 마켓플레이스(`.claude-plugin/marketplace.json`)와 `claude-office` 플러그인 |
| `install.sh`, `install.ps1` | 설치 스크립트 |
| `사용설명서.html` | 오프라인에서 여는 단일 HTML 파일(10장) |
| `LICENSE`, `THIRD_PARTY_NOTICES.md` | 라이선스 |
| `VERSION` | `2.0.0-beta.1` |

- 버전: `package.json`, `plugin.json`, `marketplace.json`을 모두 `2.0.0-beta.1`로 맞춘다.
- git 태그 `v2.0.0-beta.1`은 로컬에만 만든다. push는 사용자 승인 후에 한다.
- 코드 서명은 하지 않는다. 그래서 mac에서 "확인되지 않은 개발자" 경고가 나올 수 있고, 대처법은 사용설명서에 적는다.

## 3. 설치 스크립트

설치 위치는 `~/.claude-office/`이다. Windows에서는 `%USERPROFILE%\.claude-office\`이다.

```
~/.claude-office/
  app/          # 패키지의 app/, plugin/, 사용설명서.html을 복사한 곳 (재설치하면 교체)
  bin/claude-office(.cmd)   # 실행 명령
  logs/         # 실행 로그와 설치 로그 (재설치해도 유지)
  diagnostics/  # 진단 파일 (재설치해도 유지)
```

### 설치 순서
각 단계는 설치 로그(`logs/install-<시각>.log`)에 기록한다. 실패하면 **쉬운 말로 된 안내와 로그 파일 위치**를 보여 주고 멈춘다.

1. **Node 확인.** `node`가 없거나 24보다 낮으면 설치 방법을 운영체제별로 안내하고 멈춘다.
   - mac: nodejs.org 설치 파일
   - Linux: NodeSource 또는 nvm
   - Windows: nodejs.org 설치 파일
2. **파일 복사.** 이전 버전이 있으면 `app/`만 교체하고 `logs/`, `diagnostics/`는 유지한다.
3. **실행 명령 만들기.** `bin/claude-office`를 만든다.
   - PATH에 추가할지 고객에게 **묻는다(y/n)**.
   - mac·Linux: 셸 설정 파일(`~/.zshrc` 또는 `~/.bashrc`)에 표식 주석과 함께 한 줄을 넣는다.
   - Windows: 사용자 범위 PATH에 넣는다(`[Environment]::SetEnvironmentVariable`).
   - 거절하면 전체 경로로 실행하는 방법을 안내한다.
4. **플러그인 설치.** Claude Code 설정을 바꾸므로 **고객 동의(y/n)를 받는다**.
   - `claude plugin marketplace add <app/plugin 경로>`
   - `claude plugin install claude-office@claude-office`
   - `claude` 명령이 없으면 건너뛰고, Claude Code를 설치한 뒤 다시 실행하라고 안내한다.
5. **doctor 실행.** 결과를 보여 준다.
6. **사용설명서 열기.** 마지막 안내("대시보드 켜기: `claude-office`")를 출력한다.

- 테스트를 위해 `--prefix <폴더>`(기본 `~/.claude-office`), `--yes`(모든 질문에 y), `--no-path`(3단계 PATH 등록을 건너뜀) 옵션을 둔다.
- **테스트 안전 규칙:** 셸 설정 파일과 PATH는 `$HOME` 기준으로 고친다. 그래서 테스트는 항상 `HOME=<임시 폴더>`와 `--no-path`를 함께 쓴다. 이 Mac 사용자의 `~/.zshrc`와 `~/.claude`는 절대 고치지 않는다.

### `claude-office` 명령

| 명령 | 동작 |
|---|---|
| `claude-office` | 서버를 포그라운드로 켜고 브라우저로 대시보드를 연다. "이 창을 닫으면 대시보드가 꺼집니다"를 안내한다 |
| `claude-office doctor` | 환경 점검(7장) |
| `claude-office diag` | 진단 파일을 만들고 경로를 출력한다(8장) |
| `claude-office uninstall` | 플러그인을 제거(동의 필요)하고, PATH 줄을 지우고, `app/`와 `bin/`을 지운다. `logs/`와 `diagnostics/`는 지울지 따로 묻는다 |

## 4. 실행 로그와 에러 로그

- 서버 로거는 `server/log.ts` 하나로 둔다. 기존의 모든 `console.*` 호출은 이 로거를 거친다. 콘솔 출력도 그대로 유지한다.
- 파일 위치는 `~/.claude-office/logs/office-YYYY-MM-DD.log`이다. `--log-dir`로 바꿀 수 있고, 개발 중(`npm run dev`)에는 저장소의 `.logs/`를 쓴다. 테스트는 항상 임시 `--log-dir`를 쓴다.
- `.gitignore`에 `.logs/`, `release/`, `beta-feedback/`를 추가한다.
- 형식은 한 줄에 JSON 하나(JSON Lines)다: `{"t":"ISO 시각","level":"info|warn|error","src":"hub|hooks|sessions|…","msg":"…","data":{…}}`
- **보관 규칙**
  - 7일이 지난 파일은 시작할 때 지운다.
  - 파일 하나가 5MB에 닿으면 `"log cap reached"` 한 줄을 남기고 그날은 더 쓰지 않는다.
- **가림:** `msg`와 `data`의 문자열 값은 모두 Phase 1의 `redact()`를 거친다. 홈 디렉터리 경로는 `~`로 바꾼다(사용자 이름 보호).
- **같은 경고 반복 억제:** 같은 `src`와 `msg`의 warn은 10분에 한 번만 기록하고, 억제한 건수를 다음 기록에 붙인다.
- **기록하는 것**
  - 시작 정보: 버전, OS/arch, Node 버전, 포트, 데이터 폴더가 있는지, 빌드 결과물이 있는지
  - 수집 실패
  - hook 수신 통계(5장)
  - 서버 오류
  - 종료
- **기록하지 않는 것:** 요청 본문, 대화 내용, 프롬프트, 설정 값, 환경변수 값

## 5. 서버 견고성 수정 (QA 발견 반영)

1. **Node 버전 검사.** 시작할 때 Node가 24보다 낮으면 쉬운 말로 된 안내를 출력하고 로그를 남긴 뒤 종료 코드 1로 끝난다.
2. **빌드 결과물이 없을 때.** 로그에 error를 남긴다. `/`는 404 대신 "화면 파일이 없습니다 — 다시 설치해 주세요"라는 짧은 HTML을 돌려준다.
3. **첫 스냅샷 실패.** `/api/snapshot`과 `/api/stream`이 500이나 예외를 내지 않게 한다.
   - 빈 층 목록에 `error`(쉬운 말로 된 원인)를 담은 스냅샷을 돌려준다.
   - 원인 예: "Claude 데이터 폴더를 읽을 수 없습니다"
   - 다음 주기에 다시 시도한다.
4. **hook 수신 통계.** `EventStore`와 별도로 다음 값을 유지한다.
   - 이벤트 종류별 건수, 마지막 수신 시각, 거부된 요청 건수와 이유(403/415/413/400)
   - 값은 메모리에만 두고, 1분마다 요약 한 줄을 로그에 남긴다(변화가 있을 때만).
5. **조용히 넘기던 수집 실패.** 빈 `catch`를 로그 warn으로 바꾼다(반복 억제 적용).
   - 대상: sessions, projects, teams, limits, config 수집기
   - 동작은 그대로 계속한다.
6. **포트와 hook 주소 불일치.** 플러그인 hook 주소는 4317로 고정되어 있다. 서버를 다른 포트로 켜면 시작할 때 warn을 남기고, doctor가 ⚠️로 보여 준다.

## 6. Windows와 Linux 호환

- **`ps` 호출 (`server/collectors/sessions.ts`):** Windows에서는 `ps`를 쓰지 않고 `process.kill(pid, 0)`으로 살아 있는지만 확인한다.
  - `// ponytail:` 주석을 단다. 이 방식은 PID 재사용을 막지 못한다. 필요해지면 PowerShell의 `Get-Process` StartTime으로 바꾼다.
  - Linux(procps의 `ps -o lstart=`)는 지금 코드를 그대로 쓴다.
- **statusline 설치:** statusline tap이 `.sh`라서 Windows에서는 동작하지 않는다.
  - `setup:statusline`은 Windows에서 "베타에서는 지원하지 않습니다"라고 안내하고 끝난다.
  - 그래서 Windows에서는 PLAN 바가 "데이터 없음"으로 보인다. 사용설명서에 이 점을 적는다.
- **경로:** 경로는 모두 `path.join`과 `os.homedir()`로 만든다. 코드 리뷰에서 하드코딩된 `/`와 `~`를 찾는다.

## 7. doctor (환경 점검)

- `claude-office doctor`(CLI)와 `GET /api/diagnostics`(화면)는 **같은 모듈**(`server/diag/doctor.ts`)을 쓴다.
- 각 항목의 결과는 `{id, status: ok|warn|fail, title, detail, fix}`이다. `detail`에는 값이 아니라 **있음/없음과 숫자만** 넣는다.

| id | 점검 | fail/warn 예 | fix(쉬운 말) |
|---|---|---|---|
| node | Node 24 이상 | fail: 20.11 | Node 24 설치 안내 |
| app | `app/web`과 `server.mjs`가 있는지 | fail | 다시 설치 |
| port | 4317을 누가 쓰는지 | warn: 다른 프로그램이 사용 중 | 그 프로그램을 끄거나 다른 포트 사용(hook 불일치 경고 포함) |
| claude_home | 데이터 폴더가 있고 읽을 수 있는지(`CLAUDE_CONFIG_DIR` 반영) | fail | Claude Code를 한 번 실행 |
| claude_cli | `claude --version`이 동작하는지 | warn | Claude Code 설치 |
| plugin | 사용자 설정의 `enabledPlugins`에 `claude-office@claude-office`가 있는지 | fail | 설치 스크립트 4단계를 다시 실행 |
| managed | 관리자 설정 파일의 `allowManagedHooksOnly`, `allowedHttpHookUrls`, `enabledPlugins` | fail: 훅 차단 | 부록 A를 관리자에게 전달 |
| proxy | `HTTP(S)_PROXY`가 있을 때 `NO_PROXY`에 127.0.0.1/localhost가 있는지 | warn | NO_PROXY 설정 안내 |
| hooks | 서버가 켜져 있을 때 최근 10분 hook 수신 건수 | warn: 0건 | "Claude Code 세션에서 아무 작업이나 해 보세요". 그래도 0건이면 plugin/managed 항목을 확인 |
| statusline | `limits.json`이 있는지 | warn(정보) | PLAN 바는 선택 기능 |

- **관리자 설정 파일 위치**
  - mac: `/Library/Application Support/ClaudeCode/managed-settings.json`
  - Linux: `/etc/claude-code/managed-settings.json`
  - Windows: `C:\Program Files\ClaudeCode\managed-settings.json`
  - 이 파일들과 사용자 `settings.json`에서는 **위에 적은 키만** 읽고, 다른 값은 결과에 넣지 않는다.
- **자격 증명 파일은 읽지 않는다.** 대상: `.credentials.json`, `*.key`, 키체인
- CLI 출력은 ✅/⚠️/❌와 한 줄 설명이다. `--json`을 주면 JSON으로 낸다.

## 8. 진단 패널과 진단 파일

### 화면
- HUD에 "진단" 칩을 둔다. 최근 1시간에 error가 있으면 빨간 점을 표시한다.
- 칩을 누르면 패널이 열린다. 패널에는 doctor 결과 목록, 최근 오류 수, hook 수신 요약, **"진단 파일 만들기" 버튼**이 있다.
- 디자인은 designer가 Phase 1 스타일(네온, Galmuri)로 정한다.

### 진단 파일
- 버튼과 `POST /api/diagnostics/bundle`, `claude-office diag`가 같은 모듈을 쓴다.
- 파일 위치는 `~/.claude-office/diagnostics/claude-office-diag-<시각>.json`이다. **JSON 파일 하나**라서 zip 라이브러리가 필요 없다.
- 화면에서 만들면 파일 경로를 보여 주고, 같은 파일을 브라우저로도 내려받게 한다.
- 전체 크기는 5MB 이내로 자르고, 오래된 로그부터 버린다.

| 들어가는 것 | 들어가지 않는 것 |
|---|---|
| 버전, OS/arch, Node, Claude Code 버전 | 대화 내용, 프롬프트, 도구 입력 원문 |
| doctor 결과(7장) | 설정 파일 원문, 환경변수 값 |
| hook 수신 통계 | 토큰, 자격 증명 |
| 최근 7일 실행 로그와 설치 로그(이미 가려진 것) | 홈 디렉터리 실제 경로(`~`로 치환) |
| 현재 스냅샷 요약(층 수, 팀원 수, 오류 필드. 이름은 빼고 개수만) | 세션 이름, 팀원 이름, 폴더 이름 |

- **보안**
  - `POST /api/diagnostics/bundle`은 Phase 1 이후 처음 생기는 화면용 쓰기 API다. hook과 같은 규칙으로 Host 검사, Origin 검사, `Content-Type: application/json` 강제를 적용한다.
  - 파일은 `diagnostics/` 폴더 안에만 쓰고, 요청이 경로를 정할 수 없게 한다.
  - 파일을 쓰기 직전에 전체 내용을 `redact()`로 한 번 더 가린다.

## 9. QA 분석 도구

- `npm run qa:analyze -- <진단 파일>`(저장소 전용이고 패키지에는 넣지 않는다)이 Markdown을 출력한다.
  1. 환경 요약
  2. fail/warn인 doctor 항목
  3. 오류 묶음(`src`와 `msg`가 같은 것끼리 묶고, 건수와 처음·마지막 시각)
  4. hook 수신 통계
  5. `[QA 인폼]` 초안(증상 / 재현 조건 / 근거 / 추정 원인 / 제안)
- 고객이 보낸 진단 파일은 `beta-feedback/` 폴더(`.gitignore` 대상)에 넣는다. 진단 파일은 고객 데이터라 **커밋하지 않는다.** 이 규칙은 qa와 reviewer 체크리스트에 넣는다.

## 10. 사용설명서

- 대상은 개발자가 아니고 Claude Code를 처음 쓰는 고객이다.
- **쓰는 원칙**
  - 쉬운 말로 쓴다. 전문 용어를 쓰면 처음 나올 때 괄호로 풀어 쓴다.
  - 한 단계에는 행동 하나만 넣는다.
  - 명령은 복사 버튼이 있는 상자로 보여 준다.
  - 각 단계에 "이렇게 보이면 성공"을 적는다.
- 파일은 `docs/manual/index.html` 하나다. CSS를 안에 넣고 외부 요청을 하지 않는다. 운영체제별 내용은 탭으로 나눈다. 패키지에는 `사용설명서.html`로 넣는다.
- **목차**
  1. 이 프로그램이 하는 일(그림 한 장)
  2. 준비물: Claude Code, Node 24
  3. 설치(mac / Linux / Windows)
  4. 켜기와 끄기
  5. 화면 보는 법: 층, 캐릭터, 말풍선, 손들기, 진단 칩
  6. 문제가 생겼을 때: 진단 파일을 만들어 보내는 법과 자주 묻는 증상 5개
  7. 지우기
  8. 부록 A: 회사 관리자에게 전달할 설정(`enabledPlugins`, `allowedHttpHookUrls`, `allowManagedHooksOnly` 예시)
  9. 부록 B: 베타에서 알려진 제한(Windows와 Linux 미검증, Windows PLAN 바 없음, 서명 경고)
- 이 Mac에서는 화면 캡처가 불가능하다. 그래서 그림은 designer가 그린 도트 일러스트와 간단한 도식으로 대신한다. 실제 스크린샷은 사용자가 나중에 넣을 수 있게 자리만 표시한다.
- **검토 흐름**
  1. qa가 쓴다.
  2. reviewer가 실제 동작과 대조한다. 명령, 경로, 화면 이름이 맞는지와 쉬운 말인지를 본다.
  3. director가 최종 확인한다.
  4. 비공개 artifact로 발행해 사용자에게 링크를 전달한다.

## 11. 역할

| 팀원 | 맡는 일 |
|---|---|
| qa | 4장 로거, 5장 견고성 수정, 7장 doctor, 8장 진단 모듈과 API, 9장 분석 도구, 10장 사용설명서. 베타가 시작된 뒤에는 진단 파일을 분석해 `[QA 인폼]`을 보낸다 |
| developer | 2장 패키지, 3장 설치 스크립트와 `claude-office` 명령, 6장 호환 수정, 8장 진단 패널 UI 구현 |
| designer | 진단 칩과 패널 디자인, 사용설명서 일러스트와 도식 |
| reviewer | Task별 리뷰, 최종 리뷰, 사용설명서 검토, Doc |
| director | 계획 작성, 배정, 검증, 최종 확인, `[최종 보고]` |

## 12. 완료 기준

1. **mac에서 끝에서 끝까지 확인**
   - 패키지를 만들어 임시 폴더에 푼다.
   - `HOME=<임시> CLAUDE_CONFIG_DIR=<임시>/.claude install.sh --prefix <임시>/.claude-office --yes --no-path`로 설치한다. 실제 홈의 설정 파일은 바뀌지 않아야 한다.
   - PATH 등록은 `HOME=<임시>`에서 따로 한 번 실행해, 임시 `.zshrc`에 표식 줄이 들어가고 uninstall 때 빠지는지 확인한다.
   - `claude-office`가 **tsx와 npm 없이** 켜지고, `/`가 200을 돌려준다.
   - `doctor` 결과가 나온다.
   - 실험 세션(패키지의 `plugin/`을 `--plugin-dir`로 로드)에서 hook이 들어와 수신 통계가 0보다 크다.
   - uninstall이 깨끗하게 지운다.
2. **로그**
   - 파일이 생긴다.
   - 가짜 비밀값이 가려진다.
   - 7일 정리, 5MB 상한, 반복 억제가 테스트로 확인된다.
3. **견고성:** 존재하지 않는 데이터 폴더로 켜도 `/api/snapshot`이 200이고 `error` 필드를 담는다. 빌드 결과물이 없으면 안내 HTML을 돌려준다.
4. **진단 파일**
   - 버튼과 CLI로 만들어진다.
   - 가짜 비밀값, 홈 경로, 이름이 들어 있지 않다(테스트로 확인).
   - `qa:analyze`가 요약과 `[QA 인폼]` 초안을 낸다.
5. **Linux와 Windows**
   - `bash -n install.sh`가 통과한다.
   - Windows 분기(`ps` 대체, statusline 안내)의 단위 테스트가 통과한다.
   - `install.ps1`은 이 Mac에서 실행할 수 없으므로 리뷰로만 확인하고, "미검증"으로 표시한다.
6. **사용설명서:** qa가 쓰고, reviewer가 검토하고, director가 확인한다.
7. **전체 확인**
   - `npm test`, `typecheck`, `build`, `package:beta`가 모두 통과한다.
   - 사용자의 `~/.claude/settings.json` 체크섬이 기준값 `84b304dd…`과 같다.
   - 4317은 건드리지 않는다.

## 13. 범위에서 뺀 것과 위험

- **뺀 것**
  - 로그 자동 전송
  - 코드 서명
  - 자동 시작(로그인 시 실행)
  - Phase 2 이후 기능(결정에 답하기, 예산, 권한, 층 관리)
  - Windows PLAN 바
- **위험**
  - **Linux와 Windows는 실제로 실행해 보지 못한다.** 이 Mac에는 Docker와 VM이 없다. 고객 첫 설치가 사실상 첫 검증이 된다. 진단 파일이 이 위험을 줄이는 수단이다.
  - **관리자 정책.** `allowManagedHooksOnly`가 켜진 회사에서는 관리자가 플러그인을 강제로 켜 주기 전까지 말풍선과 손들기가 동작하지 않는다. 이때 화면은 v1 수준으로 동작한다. doctor와 부록 A로 안내한다.
  - **플러그인 설치 명령의 형태.** `claude plugin marketplace add`와 `install`의 옵션(scope 등)은 계획 단계에서 `--help`로 다시 확인한다.
  - **비밀값 가림의 한계.** 흔한 형식만 가린다(Phase 1과 같은 한계). 진단 파일에는 대화 내용 자체를 넣지 않는 것으로 위험을 줄인다.
