export interface PlaceInput {
  deskLeft: number;
  deskTop: number;
  w: number;
  h: number;
  viewportW: number;
  hudBottom: number;
}

export interface Placement {
  left: number;
  top: number;
  below: boolean;
  tailX: number;
}

/** 디자인 7.4: 캐릭터 중심 = 책상 왼쪽 + 36px, 머리 위 = 책상 위쪽 + 28px */
export function placeBubble(i: PlaceInput): Placement {
  const cx = i.deskLeft + 36;
  const left = Math.min(Math.max(8, cx - i.w / 2), i.viewportW - i.w - 8);
  let top = i.deskTop + 28 - i.h - 10;
  const below = top < i.hudBottom + 4;
  if (below) top = i.deskTop + 86;
  const tailX = Math.min(Math.max(12, cx - left), i.w - 12);
  return { left, top, below, tailX };
}
