/**
 * HUD 층 바로가기 → 장면 엘리베이터(Phase 7b Task 8, SPEC §2b). HUD는 건물 밖(App의 형제)이라 context 대신 건물 하나가 듣는 통로.
 * 돌려주는 값 = 상자가 그 층에 닿아 문이 2프레임 열릴 때까지 ms(그 뒤 스크롤). 듣는 건물이 없거나 움직임 줄이기면 0
 */
let listener: ((floor: number) => number) | null = null;

export function listenHudMove(f: (floor: number) => number): () => void {
  listener = f;
  return () => {
    if (listener === f) listener = null;
  };
}

export const requestHudMove = (floor: number): number => listener?.(floor) ?? 0;
