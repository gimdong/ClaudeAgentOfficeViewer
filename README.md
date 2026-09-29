# Claude Agent Office Viewer

Claude Code의 토큰 사용량·잔여량, 실행 중인 세션, agent team 팀원 상태를 네온 도트 사무실로 보여주는 로컬 대시보드입니다.
`~/.claude`를 읽기만 하며, 서버는 `127.0.0.1`에서만 열립니다.

## 실행

```bash
npm install
npm run build
npm start            # http://127.0.0.1:4317
```

개발 모드: `npm run dev` (Vite + API 서버 동시 실행)

옵션: `npm start -- --port 5000 --claude-home /path/to/.claude --config ./my.config.json`

## 예산과 컨텍스트 창 설정 (선택)

`claude-office.config.example.json`을 `claude-office.config.json`으로 복사해 값을 바꿉니다.
- `budget.fiveHour`, `budget.weekly`: HUD의 5H·WEEK 잔여량 기준(토큰 수). 없으면 `-- 설정 필요`.
- `contextWindows`: 모델 이름 접두어별 컨텍스트 창 크기. 없으면 200k로 추정.

## 요금제 한도 표시 (선택)

`npm run setup:statusline`을 실행하면 statusline 입력을 `~/.claude/claude-office/limits.json`에 복사하도록 설정합니다(기존 상태줄 모양은 유지, 설정은 백업).
되돌리기: `npm run remove:statusline`. Claude Code가 한도 정보를 넘겨주지 않는 버전에서는 PLAN 바가 `-- 데이터 없음`으로 표시됩니다.

## 알아두면 좋은 점

- **1M 컨텍스트 창을 쓰는 경우:** `claude-office.config.json`의 `contextWindows`에 실제 쓰는 모델의 창 크기를 설정하는 것을 권장합니다. 설정이 없으면 사용량이 200k를 넘을 때만 1M으로 추정하므로, 150k~200k 구간에서는 아직 200k 창으로 간주되어 경고색이 보일 수 있습니다. `contextWindows`의 키는 모델 ID의 접두어이며, `"[1m]"` 같은 접미사 없이 적습니다(예: `"claude-opus-5-5"`).
- **예시 설정의 1M 값:** `claude-office.config.example.json`의 `contextWindows` 값(1,000,000)은 1M 창을 실제로 쓰는 사용자를 기준으로 한 예시입니다. 200k 창으로 쓰고 있다면 이 값을 그대로 복사하지 말고 실제 창 크기(예: 200000)로 바꿔야 합니다 — 그렇지 않으면 CTX 사용률이 실제보다 낮게 표시됩니다.
- **"불 꺼진" 사무실(종료된 세션 표시):** Claude Code는 세션을 정상적으로 종료하면 `sessions/<pid>.json` 파일을 스스로 지웁니다. 따라서 화면에 반투명하게 계속 남아 있는 "불 꺼진" 사무실은 대부분 비정상 종료(강제 종료, 크래시 등)된 세션이며, 정상적으로 닫은 세션은 애초에 목록에서 사라집니다.

## 테스트

`npm test`, 타입 검사 `npm run typecheck`
