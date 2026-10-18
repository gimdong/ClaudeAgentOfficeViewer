# 설명서 그림 생성기

사용설명서(`docs/manual/index.html`)에 들어가는 SVG 그림을 만드는 스크립트입니다. node 표준 모듈만 쓰고, 외부 글꼴·이미지 없이 인라인 SVG를 씁니다. 그림 속 이름은 가짜(`fake-shop`, `reviewer`, `fakeuser` 등)만 씁니다.

| 스크립트 | 만드는 그림 | 출력 폴더 |
|---|---|---|
| `phase3.mjs` | `fig-policy-panel`·`-list`·`-lock`·`-report`·`-unreadable` | `docs/design/phase3/manual-figures/` |
| `phase4a.mjs` | `fig-floor-switch`·`-terminate`·`-hidden` | `docs/design/phase4a/manual-figures/` |

두 파일의 앞부분(그리기 함수)은 같은 사본입니다. 한쪽을 고치면 다른 쪽도 맞춰 주세요.

## 실행

```bash
npm run figures   # 두 출력 폴더에 다시 씀
```

커밋된 그림과 같은지 비교만 하려면(저장소 폴더는 건드리지 않음):

```bash
d=$(mktemp -d) && node scripts/figures/phase3.mjs "$d/phase3" && node scripts/figures/phase4a.mjs "$d/phase4a" \
  && diff -r "$d/phase3" docs/design/phase3/manual-figures && diff -r "$d/phase4a" docs/design/phase4a/manual-figures && echo "같음"
```

그림 문구는 화면 코드의 문구 상수(`web/floors/useFloors.ts`의 `FLOOR_TEXT`, `web/policy/text.ts` 등)와 디자인 명세 문구표의 글자 그대로여야 합니다. 화면 문구가 바뀌면 생성기의 글자도 바꾼 뒤 다시 만듭니다.

## 설명서에 다시 넣기

설명서는 그림을 원본 SVG와 **글자까지 같게** 품고 있고, `test/scripts/manual.test.ts`("그림이 designer 원본 SVG와 같다")가 둘을 대조합니다. 그림을 다시 만들었으면 `docs/manual/index.html`에서 `<figure class="fig" data-fig="그림 이름">` 바로 안의 `<svg …>…</svg>` 한 덩어리를 새 SVG 파일 내용 전체로 바꿉니다(앞뒤 공백 없이, 다른 데는 손대지 않음). 그다음 `npx vitest run test/scripts/manual.test.ts`로 대조가 통과하는지 봅니다(설명서는 qa 담당).

생성기를 고치지 않았는데 `npm run figures` 뒤 `git diff docs/design`에 차이가 생기면 생성기와 커밋된 그림이 어긋난 것입니다. 그림을 커밋하기 전에 원인을 확인해 주세요.

## 없는 생성기

`docs/design/beta/manual-figures/`와 `docs/design/phase2/manual-figures/`의 그림을 만든 생성기는 남아 있지 않습니다(그때의 작업 임시 폴더와 함께 사라짐). 이 그림들을 고칠 때는 SVG를 직접 고치거나, 위 스크립트의 그리기 함수로 새로 그립니다.
