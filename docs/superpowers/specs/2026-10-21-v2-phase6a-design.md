# v2 Phase 6a — hook 근본 수정(command relay)과 원격 보기 1단계

근거: `docs/superpowers/spikes/2026-10-21-phase6a-spike.md`(지연·실패 경로·보안 검토·문서 근거). 사용자 결정(2026-10-21): 13개 hook 전부 전환, 방식은 서버 증명 + 암호화(spike 권고 (나) AES-256-GCM 1 RTT), 실제 세션 실측은 구현 끝에 사용자가 설치본으로 확인, 옛 http 입구는 beta.14 한 버전만 함께 받음.

## 1. 목표
- Phase 5에서 받아들인 Critical-1 hook 쪽을 닫는다: 대시보드가 꺼진 동안 다른 계정이 4317을 차지해도 hook 내용(프롬프트·도구 입력·결과)을 볼 수 없고, 답(허용·입력 변경)을 만들 수 없다.
- 같은 이유로 macOS·Windows에서 다른 계정이 보내는 가짜 hook도 받지 않는다(서버는 열쇠로 암호화된 요청만 받는다).
- 대시보드가 꺼졌거나 무엇이든 실패하면 지금처럼 Claude Code가 평소 권한 흐름(터미널)으로 간다.
- 원격 보기 1단계: SSH 터널 안내 + `claude-office url`.

하지 않는 것: "엄격 모드"(`onFailure: "block"`), Tailscale, 팀리더 기능(6b).

## 2. hook 설정 (`plugins/claude-office/hooks/hooks.json`)
- 13개 이벤트 모두 `{"type":"command","command":"__NODE__","args":["${CLAUDE_PLUGIN_ROOT}/hooks/relay.cjs","__KEYFILE__"],"timeout":<이벤트별>}`.
  - `__NODE__`: 설치 스크립트가 `process.execPath`(Windows는 `node.exe` 절대 경로)로 바꿔 적는다. 맨 `node`를 쓰지 않는다(PATH 탐색 금지).
  - `__KEYFILE__`: 설치 스크립트가 `<PREFIX>/hook.key` 절대 경로로 바꿔 적는다.
  - 저장소의 hooks.json은 자리 표시자를 가진 원본이고, 압축(`package:beta`)에도 원본이 들어간다. 설치 스크립트가 `$PREFIX/plugin` 사본에서 바꾸되, **`claude plugin marketplace add`·`install`·`update`보다 먼저** 바꾼다(Claude Code가 그 사본을 플러그인 캐시로 복사해 실행하므로). 바꾸지 못하면 설치를 실패로 끝낸다. 설치 뒤 doctor가 실제로 쓰이는 캐시 사본(`~/.claude/plugins/cache/…/hooks/hooks.json`, 읽기만)에 자리 표시자가 남았는지 검사한다.
  - 이미 떠 있는 Claude Code 세션은 새 hook을 `/reload-plugins` 하거나 다시 열 때까지 옛 http hook을 쓴다(legacy 칩이 그 세션이 남아 있는 동안 뜬다).
- `onFailure`는 쓰지 않는다(기본값 continue).
- `timeout`: PermissionRequest 600, 그 밖 10(초).
- 정적 헤더 `X-Claude-Office-Plugin`은 relay가 요청 평문 안의 `plugin` 필드로 대신 보낸다(버전 칩 유지).

## 3. relay (`plugins/claude-office/hooks/relay.cjs`, CommonJS, node 내장만)
1. stdin을 끝까지 읽는다(상한 700KB, 넘으면 끝 — base64 암호문이 서버 상한 1MB 안에 들도록).
2. 열쇠 파일을 연 뒤 `fstat`: 일반 파일, 소유자 = 자기 uid(Windows는 생략), 그룹·다른 사용자 권한 없음(`mode & 0o077 === 0`, 0400·0600 모두 통과, Windows 생략). 아니면 끝.
3. 열쇠(32바이트 hex)에서 HKDF로 요청용 키·응답용 키를 따로 만든다.
4. 요청 평문 `{v:1, id:<16바이트 랜덤 hex>, ts:<ms>, plugin:<버전>, event:<입력 JSON>}`을 AES-256-GCM(12바이트 IV)으로 암호화해 `POST 127.0.0.1:4317/hooks/v2`(`node:net`로 직접 HTTP/1.1) 한 번에 보낸다. 본문: `{kid, iv, ct, tag}` (kid = 열쇠의 SHA-256 앞 8바이트 hex). **소켓은 응답을 다 받은 뒤에만 닫는다**(`write`만 쓰고 `end`/half-close 금지 — 쓰기 쪽을 닫으면 서버가 곧바로 연결 끊김으로 보고 PermissionRequest를 닫는다, security 실측).
5. 응답 `{iv, ct, tag}`를 응답용 키로 풀고, 평문 `{id:<같은 id>, out:<hook 출력 JSON 또는 null>}`을 확인한다. id가 다르거나 풀리지 않으면 끝.
6. `out`이 객체이고, 최상위 키가 허용 목록(`hookSpecificOutput`, `decision`, `reason`, `systemMessage`, `suppressOutput`) 안이며, `out.hookSpecificOutput?.hookEventName`이 받은 이벤트 이름과 같거나 없을 때만 `JSON.stringify(out)`을 stdout에 쓰고, 쓰기가 끝난 뒤 exit 0.
7. **출력 안전 규칙:** 모든 오류·예외·신호·타임아웃에서 stdout 없이 exit 0. exit 2·exit 1을 쓰지 않는다. UserPromptSubmit·SessionStart·Stop·SubagentStop·TeammateIdle에는 `out`이 있어도 쓰지 않는다(문맥 주입·멈춤 방지).
8. **자체 대기 한도:** 연결부터 응답까지 이벤트 timeout보다 5초 짧게(PermissionRequest 595초, 그 밖 5초). 넘으면 끝.
9. 연결 실패(대시보드 꺼짐)는 곧바로 끝. 로그를 남기지 않는다. 복호화·형식 실패만 `<PREFIX>/logs/relay.log`(0600)에 이유 한 단어 + 시각을 남긴다(본문·열쇠 없음, 1MB 넘으면 앞을 지움).

## 4. 서버
- 처음 켤 때 `<PREFIX>/hook.key`가 없으면 32바이트 랜덤으로 0600(폴더 0700) 생성, 있으면 소유자·권한 검사: 소유자가 자기이고 그룹·다른 사용자 권한이 있으면 0600으로 좁힌다(`auth.ts`의 토큰 처리와 같은 방식). 소유자가 다를 때만 doctor 실패 + `/hooks/v2` 닫음.
- `POST /hooks/v2`: Host 검사 → 같은 계정 검사(Linux) → Origin 거부 → JSON 본문(상한 1MB) → kid 일치 → GCM 복호화 → `v===1`, `now-30초 ≤ ts ≤ now+5초`, id를 본 적 없음(본 id는 `max(ts, 받은 시각)+30초`까지 기억 — 미래 ts로 창을 비껴가지 못하게; 최대 10,000개, 넘치면 창이 지난 것만 지우고 창 안의 id만으로 가득 차면 새 요청을 401 — 창 안 id를 버려 재전송을 다시 열지 않는다) → 기존 `/hooks/event` 처리기와 같은 함수로 처리 → 결과를 응답 키로 암호화해 200. 실패는 모두 401 빈 본문.
- PermissionRequest 대기 중 연결이 끊기면(relay 종료) 지금과 같이 `res.on('close') && !res.writableEnded`로 닫는다.
- **옛 `/hooks/event`(http):** beta.14에서만 지금처럼 받는다. 받으면 그 세션을 legacy로 기억하고(세션이 끝나거나 그 세션에서 10분 동안 옛 입구 이벤트가 없으면 잊음), legacy 세션이 하나라도 있으면 스냅샷 `plugin`에 `legacy: true`를 표시하고, HUD 칩 문구를 "옛 플러그인(http hook)이 남아 있습니다 — 같은 압축 파일로 다시 설치하세요"로 바꾼다. beta.15에서 없앤다(스펙 남은 일).
- 통계: `hooks.v2`(받은 수), `rejected["401-v2"]`.

## 5. doctor
- node 절대 경로: 설치된 hooks.json의 `command`가 존재하고 실행 가능한지. 아니면 ❌ "hook을 실행할 node가 없습니다(nvm 등으로 바뀜) — 다시 설치하세요".
- 열쇠 파일 권한·소유자.
- relay.log의 최근 실패 수.
- 포트 4317 "이 프로그램"인데 진단 API가 401이면 "열쇠가 다른 대시보드(다른 설치본)"로 표시(지금 "서버가 꺼져 있어" 모순 고침).
- `claude-office doctor --port <n>`: 설치 스크립트 끝의 doctor에도 넘길 수 있게 `install.sh --port`·`install.ps1 -Port`.

## 6. 원격 보기 1단계
- `claude-office url`: 열쇠 주소(`http://127.0.0.1:<port>/?k=<토큰>`)를 stdout 한 줄로. 브라우저는 열지 않는다. 토큰을 명령 인자로 넘기지 않는다.
- 설명서 영·한 "원격에서 보기(SSH 터널)": `ssh -L 4317:127.0.0.1:4317 <host>` → 원격에서 `claude-office url` → 그 주소를 로컬 브라우저에.

## 7. 함께 고칠 작은 것
- 런처 30초 정리 서브셸을 `nohup`으로 떼어 내기(sh). 안전 검사에 막히면 기록만.
- README·설명서·admin의 hook 위험 문단을 "beta.14부터 고침(옛 버전 사용자는 …)"으로 바꾼다. "다음 버전에 고침" 같은 약속 문장은 여전히 금지.

## 8. 테스트
- relay 단위: 정상 왕복, 가짜 서버(평문 0바이트·무출력), 응답 변조·재사용·id 불일치, 요청 재전송(서버 401), 열쇠 파일 권한·소유자 틀림, 대기 한도, 모든 예외에서 exit 0·빈 stdout, 문맥 주입 이벤트는 출력 안 함, hookEventName 불일치 무출력.
- 서버: `/hooks/v2` 형식 검사·재전송 창 상한·ts 범위, 옛 `/hooks/event`의 legacy 표시, 칩 문구.
- 설치: hooks.json 자리 표시자가 절대 경로로 바뀜, 13개 모두 command·args·onFailure 없음, 바꾸지 못하면 실패.
- `test/security/`: spike 시험 후보 12개 + 13번(onFailure·exec form·절대 경로).
- 지연 회귀: relay 왕복 중앙값이 100ms를 넘지 않는지(느슨한 기준, CI 변동 감안 200ms에서 실패).

## 9. 구현 끝 사용자 설치본 확인 (설명서 부록)
spike 보고서의 8항목: 정책 deny가 막는지 / 대시보드 허용·거부(updatedInput 포함) 반영 / 터미널 먼저 답하면 손들기 닫힘 / 대시보드 끈 채 터미널이 평소처럼 묻는지 / 다른 hook과 병합 / relay cwd·env / UserPromptSubmit·SessionStart 문맥 주입 없음 / `--debug`의 cancelled. 결과에 따라 relay의 대기 한도나 출력 규칙을 고친다.

## 10. 위험
- 지연: 도구 1회 약 65ms 늘어남(spike 실측). 체감 문제가 보고되면 결정이 필요 없는 이벤트를 줄이는 것을 다음에 검토.
- 실제 세션 미실측 항목은 9장 확인으로 닫는다.
- 옛 입구가 열려 있는 beta.14 동안은 옛 위험이 남는다 — 칩으로 재설치를 재촉하고 beta.15에서 닫는다.
- 남는 위험(받아들임): 암호문 길이로 명령 길이 짐작, kid로 요청끼리 연결.
